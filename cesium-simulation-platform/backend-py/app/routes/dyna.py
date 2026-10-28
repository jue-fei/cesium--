"""LS-DYNA 子系统（dyna2web 容器）—— 平台内置模块，MySQL 为元信息权威数据源。

目录布局（随平台一起拷走，不依赖外部 工作区）：
  <platform>/dyna/config|reports|webapp(data_v3,incoming)|dyna2web.py

API（均以 /api/dyna 为前缀）：
- GET  /cases          算例列表（MySQL，结构与 cases.json 一致）
- DELETE /cases/{key}  删除算例（DB 行 + 容器/报告文件 + cases.json 条目）
- GET  /files          产物文件明细（dyna_case_files：大小/压缩前字节/压缩比/帧数/mtime）
- GET  /storage        存储根与文件存在性
- POST /sync           从 cases.json 同步入库（算例 + 产物文件明细）
- GET  /file/{name}    容器二进制（Mesh/Frames）HTTP Range 读取
- GET  /field_spec     字段注册表（工作区/config/field_spec.json）
- GET  /report?key=    转换报告 report.json
- GET  /incoming       待转换目录（incoming 下含 d3plot 的子目录）
- POST /convert        启动 dyna2web 转换子进程
- GET  /job?id=        转换任务状态/日志
- POST /cancel         取消任务
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import pymysql
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pymysql import Connection

from app.database import DB_CONFIG, get_db
from app.security import require_token

router = APIRouter(prefix="/api/dyna",
                   redirect_slashes=False, tags=["LS-DYNA 算例"])

# backend-py/app/routes/dyna.py → parents[3] = cesium-simulation-platform
PLATFORM_ROOT = Path(__file__).resolve().parents[3]
# dyna 子系统根（随平台一起拷走）：默认 <platform>/dyna，保持原工作区目录结构
DYNA_ROOT = Path(os.getenv("DYNA_ROOT") or (PLATFORM_ROOT / "dyna"))
STORAGE_ENV = "DYNA_DATA_DIR"
KEY_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_RANGE_CHUNK = 1 << 20
# 转换任务（进程内）：jid → {status, log, code, proc, key}
JOBS: dict = {}

# cases.json 条目里需要落成独立列、便于 SQL 查询的 JSON 字段
JSON_FIELD_COLUMNS = (
    ("times", "times_json"),
    ("parts", "parts_json"),
    ("part_types", "part_types_json"),
    ("fields", "fields_json"),
    ("low_confidence_fields", "low_confidence_fields_json"),
    ("surf_groups", "surf_groups_json"),
    ("particles", "particles_json"),
    ("scales", "scales_json"),
    ("detector", "detector_json"),
)

DDL = """
CREATE TABLE IF NOT EXISTS dyna_cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_key VARCHAR(64) NOT NULL COMMENT '算例键（容器文件名前缀）',
  label VARCHAR(255) NOT NULL DEFAULT '' COMMENT '显示名',
  type VARCHAR(32) NOT NULL DEFAULT 'fem' COMMENT 'fem / sph / mixed',
  schema_version INT NOT NULL DEFAULT 2,
  requires_frontend INT NOT NULL DEFAULT 2,
  data_prefix VARCHAR(64) NOT NULL DEFAULT '',
  mesh_file VARCHAR(255) NOT NULL DEFAULT '',
  frames_file VARCHAR(255) NOT NULL DEFAULT '',
  mesh_bytes BIGINT NOT NULL DEFAULT 0,
  frames_bytes BIGINT NOT NULL DEFAULT 0,
  nframes INT NOT NULL DEFAULT 0,
  times_json LONGTEXT COMMENT '每帧时间（秒）',
  parts_json LONGTEXT COMMENT '部件表（pid/role/mat/elems）',
  part_types_json LONGTEXT,
  fields_json LONGTEXT COMMENT '字段注册（id/location/unit/confidence）',
  low_confidence_fields_json LONGTEXT,
  surf_groups_json LONGTEXT,
  particles_json LONGTEXT COMMENT 'SPH/PBM 粒子组',
  scales_json LONGTEXT COMMENT '字段量纲换算',
  detector_json LONGTEXT,
  summary_json LONGTEXT COMMENT '原始 cases.json 条目（保证前端结构零改动）',
  report_path VARCHAR(512) DEFAULT '',
  source_dir VARCHAR(512) DEFAULT '' COMMENT 'd3plot 源目录',
  storage_root VARCHAR(512) NOT NULL DEFAULT '' COMMENT '容器存储根（迁移目录只需改这里）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dyna_case_key (case_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
"""

# 产物文件明细：一个算例一条/每类文件（mesh / frames / report）。
# 体积口径说明：frames 落盘已是「u2 量化 + 每帧独立 zstd」，因此 bytes 为压缩后实际占用，
# raw_bytes 取自转换报告 container.frames.raw_bytes（未压缩原始字节），ratio = raw_bytes / bytes。
FILES_DDL = """
CREATE TABLE IF NOT EXISTS dyna_case_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_key VARCHAR(64) NOT NULL COMMENT '算例键',
  role VARCHAR(24) NOT NULL COMMENT 'mesh / frames / report',
  file_name VARCHAR(255) NOT NULL DEFAULT '',
  rel_path VARCHAR(512) NOT NULL DEFAULT '' COMMENT '相对存储根（report 相对 dyna/reports）',
  bytes BIGINT NOT NULL DEFAULT 0 COMMENT '磁盘实际字节（frames 为压缩后）',
  raw_bytes BIGINT NOT NULL DEFAULT 0 COMMENT '未压缩原始字节（仅 frames，取自转换报告）',
  codec VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'none / zstd',
  ratio DECIMAL(6,3) NOT NULL DEFAULT 0 COMMENT 'raw_bytes / bytes',
  nframes INT NOT NULL DEFAULT 0,
  frame_bytes BIGINT NOT NULL DEFAULT 0 COMMENT '单帧解压后字节',
  mtime DATETIME NULL COMMENT '文件修改时间',
  exists_flag TINYINT NOT NULL DEFAULT 0 COMMENT '1=磁盘上存在',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dyna_case_role (case_key, role),
  KEY idx_dyna_case (case_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
"""


def data_dir() -> Path:
    """容器存储根：环境变量 DYNA_DATA_DIR 优先，否则默认 <platform>/dyna/webapp/data_v3。"""
    env = (os.getenv(STORAGE_ENV) or "").strip()
    return Path(env) if env else DYNA_ROOT / "webapp" / "data_v3"


def web_dir() -> Path:
    return DYNA_ROOT / "webapp"


def config_dir() -> Path:
    return DYNA_ROOT / "config"


def reports_dir() -> Path:
    return DYNA_ROOT / "reports"


def incoming_dir() -> Path:
    return web_dir() / "incoming"


def converter_path() -> Path:
    return DYNA_ROOT / "dyna2web.py"


def cases_json_path() -> Path:
    return data_dir() / "cases.json"


def ensure_table(conn: Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(DDL)
        cur.execute(FILES_DDL)
    conn.commit()


def _dump(value):
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


def _load(value):
    if isinstance(value, str) and value:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return value


def _file_size(root: Path, name: str) -> int:
    if not name:
        return 0
    try:
        p = root / name
        return int(p.stat().st_size) if p.is_file() else 0
    except OSError:
        return 0


def _stat(path: Path) -> dict:
    """磁盘实际大小 + 修改时间；不存在则返回 0/None（不抛异常）。"""
    try:
        st = path.stat()
        return {"bytes": int(st.st_size),
                "mtime": datetime.fromtimestamp(st.st_mtime)}
    except OSError:
        return {"bytes": 0, "mtime": None}


def _report_container_meta(key: str) -> tuple:
    """读转换报告里的容器元信息：(frames_meta, mesh_meta)。

    frames_meta 含 codec / bytes / raw_bytes / ratio / frame_bytes / nframes，
    是"为什么压缩后还这么大"的唯一权威口径（dyna2web 写报告时记录）。
    """
    fp = reports_dir() / f"{key}.report.json"
    if not fp.is_file():
        return {}, {}
    try:
        rep = json.loads(fp.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 报告损坏不应阻断入库
        return {}, {}
    container = rep.get("container") or {}
    return (container.get("frames") or {}), (container.get("mesh") or {})


def _upsert_files(conn: Connection, key: str, entry: dict, root: Path) -> int:
    """把算例的产物文件（mesh / frames / report）逐条写入 dyna_case_files。"""
    frames_meta, _mesh_meta = _report_container_meta(key)
    specs = (
        ("mesh", str(entry.get("mesh") or ""), root),
        ("frames", str(entry.get("frames") or ""), root),
        ("report", f"{key}.report.json", reports_dir()),
    )
    rows = []
    for role, name, base in specs:
        if not name:
            continue
        st = _stat(base / name)
        raw = 0
        codec = ""
        ratio = 0.0
        nframes = 0
        frame_bytes = 0
        if role == "frames":
            raw = int(frames_meta.get("raw_bytes") or 0)
            codec = str(frames_meta.get("codec") or "")
            nframes = int(frames_meta.get("nframes") or entry.get("nframes") or 0)
            frame_bytes = int(frames_meta.get("frame_bytes") or 0)
            # 报告缺 bytes 时用磁盘大小兜底；两者都有时以磁盘为准
            size = st["bytes"] or int(frames_meta.get("bytes") or 0)
            ratio = round(raw / size, 3) if raw and size else 0.0
        rows.append(
            {
                "case_key": key,
                "role": role,
                "file_name": name,
                "rel_path": str(base / name),
                "bytes": st["bytes"],
                "raw_bytes": raw,
                "codec": codec,
                "ratio": ratio,
                "nframes": nframes,
                "frame_bytes": frame_bytes,
                "mtime": st["mtime"],
                "exists_flag": 1 if st["bytes"] else 0,
            }
        )
    if not rows:
        return 0
    columns = list(rows[0].keys())
    placeholders = ", ".join(["%s"] * len(columns))
    updates = ", ".join(
        f"{c}=VALUES({c})" for c in columns if c not in ("case_key", "role"))
    sql = (
        f"INSERT INTO dyna_case_files ({', '.join(columns)}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {updates}"
    )
    with conn.cursor() as cur:
        cur.executemany(sql, [[r[c] for c in columns] for r in rows])
    conn.commit()
    return len(rows)


def _upsert_case(conn: Connection, key: str, entry: dict, root: Path) -> None:
    mesh_file = str(entry.get("mesh") or "")
    frames_file = str(entry.get("frames") or "")
    summary = dict(entry)
    summary["key"] = key
    values = {
        "case_key": key,
        "label": str(entry.get("label") or key),
        "type": str(entry.get("type") or "fem"),
        "schema_version": int(entry.get("schema_version") or 2),
        "requires_frontend": int(entry.get("requires_frontend") or 2),
        "data_prefix": str(entry.get("data_prefix") or ""),
        "mesh_file": mesh_file,
        "frames_file": frames_file,
        "mesh_bytes": _file_size(root, mesh_file),
        "frames_bytes": _file_size(root, frames_file),
        "nframes": int(entry.get("nframes") or 0),
        "summary_json": _dump(summary),
        "report_path": str(entry.get("report") or ""),
        "source_dir": str(entry.get("source_dir") or ""),
        "storage_root": str(root),
    }
    for src, column in JSON_FIELD_COLUMNS:
        values[column] = _dump(entry.get(src))

    columns = list(values.keys())
    placeholders = ", ".join(["%s"] * len(columns))
    updates = ", ".join(
        f"{c}=VALUES({c})" for c in columns if c not in ("case_key",))
    sql = (
        f"INSERT INTO dyna_cases ({', '.join(columns)}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {updates}"
    )
    with conn.cursor() as cur:
        cur.execute(sql, [values[c] for c in columns])
    conn.commit()


def sync_from_disk(conn: Connection, only_key: Optional[str] = None) -> dict:
    """把 cases.json 的条目同步进 MySQL（建表 + upsert）。"""
    ensure_table(conn)
    root = data_dir()
    path = cases_json_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"cases.json 不存在: {path}")
    try:
        cases = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - 解析失败原样上报
        raise HTTPException(
            status_code=500, detail=f"cases.json 解析失败: {exc}") from exc
    if not isinstance(cases, dict):
        raise HTTPException(status_code=500, detail="cases.json 结构异常（应为对象）")

    keys = [only_key] if only_key else sorted(cases.keys())
    synced = []
    file_rows = 0
    for key in keys:
        entry = cases.get(key)
        if not isinstance(entry, dict):
            continue
        _upsert_case(conn, key, entry, root)
        file_rows += _upsert_files(conn, key, entry, root)
        synced.append(key)
    return {
        "code": 0,
        "synced": synced,
        "count": len(synced),
        "fileRows": file_rows,
        "storageRoot": str(root),
        "casesJson": str(path),
    }


@router.get("/cases")
def list_cases(db: Connection = Depends(get_db)):
    """算例列表：结构对齐 cases.json，便于 webapp 直接替换数据源。"""
    ensure_table(db)
    with db.cursor() as cur:
        cur.execute(
            "SELECT case_key, label, type, nframes, mesh_file, frames_file, "
            "mesh_bytes, frames_bytes, summary_json, storage_root, updated_at "
            "FROM dyna_cases ORDER BY case_key"
        )
        rows = cur.fetchall() or []

    data, files = {}, {}
    for row in rows:
        key = row["case_key"]
        entry = _load(row.get("summary_json"))
        if not isinstance(entry, dict):
            entry = {
                "key": key,
                "label": row.get("label") or key,
                "type": row.get("type") or "fem",
                "nframes": int(row.get("nframes") or 0),
                "mesh": row.get("mesh_file") or "",
                "frames": row.get("frames_file") or "",
            }
        data[key] = entry
        files[key] = {
            "mesh": {"name": row.get("mesh_file") or "", "bytes": int(row.get("mesh_bytes") or 0)},
            "frames": {
                "name": row.get("frames_file") or "",
                "bytes": int(row.get("frames_bytes") or 0),
            },
        }

    return {
        "code": 0,
        "data": data,
        "files": files,
        "storage": {"root": str(data_dir())},
        "count": len(data),
    }


@router.get("/files")
def list_files(key: str = "", db: Connection = Depends(get_db)):
    """产物文件明细：每条 = 一个算例的一类文件（mesh / frames / report）。

    frames 行带压缩口径（raw_bytes / codec / ratio），用于回答"压缩后到底省了多少"；
    迁移目录后 exists_flag=0 即为缺文件。totals 汇总压缩前/后总量与整体压缩比。
    """
    ensure_table(db)
    where, params = "", []
    if key:
        if not KEY_RE.fullmatch(key):
            raise HTTPException(status_code=400, detail="key 非法")
        where, params = " WHERE case_key=%s", [key]
    with db.cursor() as cur:
        cur.execute(
            "SELECT case_key, role, file_name, rel_path, bytes, raw_bytes, codec, "
            "ratio, nframes, frame_bytes, mtime, exists_flag, updated_at "
            f"FROM dyna_case_files{where} ORDER BY case_key, FIELD(role,'mesh','frames','report')",
            params,
        )
        rows = cur.fetchall() or []

    data = []
    total_bytes = total_raw = 0
    missing = []
    for row in rows:
        size = int(row.get("bytes") or 0)
        raw = int(row.get("raw_bytes") or 0)
        total_bytes += size
        total_raw += raw
        if not int(row.get("exists_flag") or 0):
            missing.append(f"{row['case_key']}:{row['role']}")
        data.append(
            {
                "key": row["case_key"],
                "role": row["role"],
                "name": row.get("file_name") or "",
                "path": row.get("rel_path") or "",
                "bytes": size,
                "rawBytes": raw,
                "codec": row.get("codec") or "",
                "ratio": float(row.get("ratio") or 0),
                "nframes": int(row.get("nframes") or 0),
                "frameBytes": int(row.get("frame_bytes") or 0),
                "mtime": row["mtime"].isoformat(sep=" ") if row.get("mtime") else None,
                "exists": bool(int(row.get("exists_flag") or 0)),
            }
        )
    frames_bytes = sum(r["bytes"] for r in data if r["role"] == "frames")
    return {
        "code": 0,
        "count": len(data),
        "data": data,
        "totals": {
            "bytes": total_bytes,
            "rawBytes": total_raw,
            "ratio": round(total_raw / total_bytes, 3) if total_raw and total_bytes else 0,
            "framesBytes": frames_bytes,
            "missing": missing,
        },
        "storage": {"root": str(data_dir()), "reports": str(reports_dir())},
    }


@router.get("/storage")
def storage_info(db: Connection = Depends(get_db)):
    """容器存储核对：目录是否可达、每个算例的 mesh/frames 是否存在。"""
    ensure_table(db)
    root = data_dir()
    with db.cursor() as cur:
        cur.execute(
            "SELECT case_key, mesh_file, frames_file FROM dyna_cases ORDER BY case_key")
        rows = cur.fetchall() or []
    items = []
    for row in rows:
        mesh = row.get("mesh_file") or ""
        frames = row.get("frames_file") or ""
        items.append(
            {
                "key": row["case_key"],
                "mesh": mesh,
                "frames": frames,
                "meshExists": bool(mesh) and (root / mesh).is_file(),
                "framesExists": bool(frames) and (root / frames).is_file(),
            }
        )
    return {
        "code": 0,
        "data": {
            "root": str(root),
            "rootExists": root.is_dir(),
            "casesJson": str(cases_json_path()),
            "casesJsonExists": cases_json_path().is_file(),
            "items": items,
        },
    }


async def _json_body(request: Request) -> dict:
    """宽容解析请求体：不强制 application/json。

    webapp 为了避开 CORS 预检会用 text/plain 发 JSON（旧 start_server.py 手工解析，
    换成 FastAPI 后 `body: dict` 会直接 422 → 导入链路静默失败）。这里统一手工解析。
    """
    raw = await request.body()
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"请求体不是合法 JSON: {exc}") from exc
    return data if isinstance(data, dict) else {}


@router.post("/sync", dependencies=[Depends(require_token)])
async def sync_cases(request: Request, db: Connection = Depends(get_db)):
    """从 cases.json 同步入库；body 可传 {"key": "tnt_1"} 只同步单例。"""
    body = await _json_body(request)
    only = str(body.get("key") or "").strip()
    return sync_from_disk(db, only or None)


# ============================================================
# 删除算例：DB 行 + 容器/报告文件 + cases.json 条目（一次清干净）
# ============================================================
@router.delete("/cases/{key}", dependencies=[Depends(require_token)])
def delete_case(key: str, keep_files: bool = False, db: Connection = Depends(get_db)):
    """删除一个算例的全部内容。

    - MySQL：dyna_cases + dyna_case_files 对应行
    - 磁盘：cases.json 登记的 mesh/frames 与 reports/<key>.report.json
    - 清单：从 data_v3/cases.json 移除该条目（前端 /api/dyna/cases 不再返回）

    keep_files=true 只清元数据、保留文件（便于手工回收或迁移前先摘链）。
    文件删除严格限制在 data_dir()/reports_dir() 之内，且只删清单里出现过的文件名，
    不接受任意路径，避免误删。
    """
    if not KEY_RE.fullmatch(key or ""):
        raise HTTPException(status_code=400, detail="key 非法")
    ensure_table(db)
    root = data_dir().resolve()
    rep_root = reports_dir().resolve()
    path = cases_json_path()

    cases: dict = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            cases = loaded if isinstance(loaded, dict) else {}
        except Exception as exc:  # noqa: BLE001 - 清单坏了就不要动它
            raise HTTPException(
                status_code=500, detail=f"cases.json 解析失败，已中止删除: {exc}") from exc

    entry = cases.get(key) if isinstance(cases.get(key), dict) else None
    with db.cursor() as cur:
        cur.execute("SELECT case_key FROM dyna_cases WHERE case_key=%s", (key,))
        in_db = cur.fetchone() is not None
    if entry is None and not in_db:
        raise HTTPException(status_code=404, detail=f"算例不存在: {key}")

    removed, skipped = [], []
    if not keep_files:
        targets = []
        if entry:
            for name in (entry.get("mesh"), entry.get("frames")):
                if name:
                    targets.append((root, str(name)))
        targets.append((rep_root, f"{key}.report.json"))
        for base, name in targets:
            target = (base / name).resolve()
            try:
                target.relative_to(base)          # 越界（../）直接拒绝
            except ValueError:
                skipped.append(f"{name}（路径越界，已跳过）")
                continue
            if not target.is_file():
                continue
            try:
                target.unlink()
                removed.append(str(target))
            except OSError as exc:
                skipped.append(f"{name}（{exc}）")

    with db.cursor() as cur:
        cur.execute("DELETE FROM dyna_case_files WHERE case_key=%s", (key,))
        files_deleted = cur.rowcount or 0
        cur.execute("DELETE FROM dyna_cases WHERE case_key=%s", (key,))
        case_deleted = cur.rowcount or 0
    db.commit()

    if key in cases:
        cases.pop(key, None)
        tmp = path.parent / (path.name + ".tmp")
        tmp.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)

    return {
        "code": 0,
        "key": key,
        "filesRemoved": removed,
        "filesSkipped": skipped,
        "keepFiles": bool(keep_files),
        "db": {"cases": case_deleted, "files": files_deleted},
    }


# ============================================================
# 容器文件读取（HTTP Range 206）：几何/帧数据可达数 GB，必须按帧惰性读取
# ============================================================
@router.get("/file/{filename:path}")
def get_container_file(filename: str, request: Request):
    root = data_dir().resolve()
    target = (root / filename).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="非法路径")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"文件不存在: {filename}")

    size = target.stat().st_size
    media = "application/octet-stream"
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    rng = (request.headers.get("range") or "").strip()

    if not rng:
        def iter_all():
            with open(target, "rb") as fh:
                while True:
                    chunk = fh.read(MAX_RANGE_CHUNK)
                    if not chunk:
                        break
                    yield chunk

        headers["Content-Length"] = str(size)
        return StreamingResponse(iter_all(), media_type=media, headers=headers)

    m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng)
    if not m:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}",
                     "Content-Length": "0"},
        )
    start_raw, end_raw = m.group(1), m.group(2)
    if start_raw == "":
        if end_raw == "":
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}",
                         "Content-Length": "0"},
            )
        start = max(0, size - int(end_raw))
        end = size - 1
    else:
        start = int(start_raw)
        end = min(int(end_raw), size - 1) if end_raw else size - 1
    if start > end or start >= size:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}",
                     "Content-Length": "0"},
        )

    length = end - start + 1

    def iter_range():
        with open(target, "rb") as fh:
            fh.seek(start)
            remain = length
            while remain > 0:
                chunk = fh.read(min(MAX_RANGE_CHUNK, remain))
                if not chunk:
                    break
                remain -= len(chunk)
                yield chunk

    headers.update(
        {
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        }
    )
    return StreamingResponse(iter_range(), status_code=206, media_type=media, headers=headers)


# ============================================================
# 字段注册表 / 转换报告 / 待转换目录
# ============================================================
@router.get("/page_version")
def page_version():
    """返回前端页面的构建号（读 index.html 里的 <meta name="dyna-build">）。

    页面启动时会拿它和自己的 BUILD 比对：不一致说明浏览器用的是缓存里的旧页面，
    直接提示用户强制刷新 —— 改完前端却"看到的还是老样子"这个坑已经踩过两次。
    """
    fp = web_dir() / "index.html"
    build, mtime = "", 0
    try:
        head = fp.read_text(encoding="utf-8", errors="ignore")[:4000]
        m = re.search(r'name="dyna-build"\s+content="([^"]+)"', head)
        if m:
            build = m.group(1)
        mtime = int(fp.stat().st_mtime)
    except OSError:
        pass
    return {"code": 0, "build": build, "mtime": mtime}


@router.get("/field_spec")
def get_field_spec():
    fp = config_dir() / "field_spec.json"
    if not fp.is_file():
        raise HTTPException(
            status_code=404, detail=f"field_spec.json 不存在: {fp}")
    return Response(content=fp.read_bytes(), media_type="application/json; charset=utf-8")


@router.get("/report")
def get_report(key: str):
    if not KEY_RE.fullmatch(key or ""):
        raise HTTPException(status_code=400, detail="key 非法")
    fp = reports_dir() / f"{key}.report.json"
    if not fp.is_file():
        raise HTTPException(status_code=404, detail=f"报告不存在: {fp}")
    return Response(content=fp.read_bytes(), media_type="application/json; charset=utf-8")


@router.get("/incoming")
def list_incoming():
    root = incoming_dir()
    items = []
    if root.is_dir():
        for name in sorted(os.listdir(root)):
            full = (root / name).resolve()
            if not full.is_dir():
                continue
            has_d3plot = any(
                f == "d3plot" or (f.startswith("d3plot") and f[6:].isdigit())
                for f in os.listdir(full)
            )
            if has_d3plot:
                items.append(str(full))
    return items


# ============================================================
# 转换：dyna2web 子进程 + 任务状态（进程内）
# ============================================================
# 进度解析：dyna2web 的日志是唯一的进度来源（不改转换器），按阶段关键词 + 帧计数换算百分比。
#   0~40%   解析/装配（块表 → 单元类型 → 表面 → 字段 → mesh.bin → 量化系数）
#   40~97%  逐帧转换（"[key] 帧 48/102 ..."）
#   100%    "[key] 完成: ..."
FRAME_RE = re.compile(r"帧\s+(\d+)\s*/\s*(\d+)")
SIZE_RE = re.compile(r"压缩\s+([\d.]+)/([\d.]+)\s*MB")
STAGE_STEPS = (
    ("块表", "解析 d3plot 布局", 6),
    ("元素类型", "识别单元类型", 12),
    ("外表面", "装配表面网格", 20),
    ("字段:", "规划字段块", 28),
    ("mesh.bin", "写入 mesh.bin", 34),
    ("u2 归一化", "计算量化系数", 38),
)


def _update_progress(job: dict, line: str) -> None:
    """从一行日志里推进任务进度（只前进不后退）。"""
    cur = job.get("progress") or {}
    cur_pct = float(cur.get("pct") or 0)

    def put(stage: str, label: str, pct: float, **extra) -> None:
        if pct < cur_pct and stage != "done":      # 阶段乱序时不回退进度条
            return
        job["progress"] = {"stage": stage, "label": label,
                           "pct": round(min(100.0, pct), 1), **extra}

    if "完成:" in line:
        put("done", "转换完成", 100)
        return
    m = FRAME_RE.search(line)
    if m:
        done, total = int(m.group(1)), int(m.group(2))
        extra = {}
        sm = SIZE_RE.search(line)
        if sm:
            extra = {"writtenMB": float(sm.group(1)),
                     "frameMB": float(sm.group(2))}
        put("frames", f"逐帧转换 {done}/{total}",
            40 + 57 * done / max(1, total), done=done, total=total, **extra)
        return
    if cur.get("stage") in ("frames", "done"):
        return                                     # 帧阶段之后不再回退到前置阶段
    for kw, label, pct in STAGE_STEPS:
        if kw in line:
            put(kw.strip(":") or label, label, pct)
            return


def _append_log(jid: str, text: str) -> None:
    job = JOBS.get(jid)
    if not job:
        return
    log = (job.get("log") or "") + text
    if len(log) > 60000:
        log = log[-40000:]
    job["log"] = log
    for line in text.splitlines():
        if line.strip():
            _update_progress(job, line)


def _run_job(jid: str, cmd: list, key: str) -> None:
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    # 关键：子进程 stdout 是管道，Python 默认块缓冲 → 日志/进度要等进程结束才一次性吐出来。
    # 关掉缓冲后「帧 n/m」才能实时到达，进度条才有中间态。
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(DYNA_ROOT),
        env=env,
    )
    JOBS[jid]["proc"] = proc
    for line in proc.stdout:
        _append_log(jid, line)
    proc.wait()
    job = JOBS.get(jid)
    if not job:
        return
    job["t_end"] = time.time()                 # 冻结耗时，别让 /job 里的 elapsed 一直涨
    job["code"] = proc.returncode
    if job.get("status") != "cancelled":
        job["status"] = "ok" if proc.returncode == 0 else "fail"
    if job["status"] == "ok" and key:
        # dyna2web 在“中止”场景也可能返回 0，因此以“容器是否真的生成”为准
        container = data_dir() / f"{key}.frames.bin"
        if not container.is_file():
            _append_log(jid, f"\n[dyna] 未生成容器（{container.name} 缺失），跳过入库\n")
            return
        try:
            conn = pymysql.connect(**DB_CONFIG)
            try:
                result = sync_from_disk(conn, key)
                synced = result.get("synced") or []
                if synced:
                    _append_log(jid, f"\n[dyna] 算例 {key} 已同步入库\n")
                else:
                    _append_log(jid, f"\n[dyna] cases.json 中无 {key}，未入库\n")
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 - 入库失败不影响转换结果
            _append_log(jid, f"\n[dyna] 入库失败（可跑 migrate_dyna.py）: {exc}\n")


@router.post("/convert", dependencies=[Depends(require_token)])
async def start_convert(request: Request):
    body = await _json_body(request)
    path = str(body.get("path") or "").strip().strip('"')
    if not path or not os.path.isdir(path) or not os.path.exists(os.path.join(path, "d3plot")):
        raise HTTPException(
            status_code=400, detail=f"目录无效或缺少 d3plot 基文件: {path}")
    if not converter_path().is_file():
        raise HTTPException(
            status_code=500, detail=f"转换器缺失: {converter_path()}")

    raw_key = str(body.get("key") or "").strip(
    ) or os.path.basename(os.path.normpath(path))
    key = "".join(ch if (ch.isalnum() and ch.isascii())
                  or ch in "_-" else "_" for ch in raw_key)
    key = key[:64] or "case"
    label = str(body.get("label") or "").strip() or key
    raw_layers = body.get("layers") or []
    if not isinstance(raw_layers, list):
        raw_layers = []
    supported = ("stress", "velocity", "acceleration", "sph")
    mapped = [x for x in raw_layers if x in supported]
    dropped = [x for x in raw_layers if x not in supported]
    if "velocity" not in mapped:
        mapped.append("velocity")

    cmd = [
        sys.executable,
        str(converter_path()),
        path,
        "--key",
        key,
        "--label",
        label,
        "--stage",
        "all",
        "--compress",
        "zstd",
        "--verify",
        "--field-location",
        "element",
        "--extract",
        ",".join(mapped),
    ]
    k = str(body.get("k") or "").strip()
    if k and os.path.exists(k):
        cmd += ["--k", k]

    jid = uuid.uuid4().hex[:8]
    warn = ("⚠ 已忽略不支持的提取层: " + ", ".join(dropped) + "\n") if dropped else ""
    JOBS[jid] = {"status": "running", "log": warn, "key": key, "code": None,
                 "t0": time.time(),
                 "progress": {"stage": "start", "label": "启动转换进程", "pct": 0}}
    threading.Thread(target=_run_job, args=(
        jid, cmd, key), daemon=True).start()
    return {"job": jid, "key": key}


@router.get("/job")
def get_job(id: str):
    job = JOBS.get(id)
    if not job:
        return {"status": "unknown", "log": "未知任务"}
    progress = dict(job.get("progress") or {})
    status = job.get("status")
    if status == "ok":
        progress.update({"stage": "done", "label": "转换完成", "pct": 100.0})
    elif status == "fail":
        progress.update({"stage": "fail", "label": "转换失败"})
    elif status == "cancelled":
        progress.update({"stage": "cancelled", "label": "已取消"})
    if job.get("t0"):
        end = job.get("t_end") or time.time()
        progress["elapsed"] = round(end - job["t0"], 1)
    return {
        "status": status,
        "log": job.get("log") or "",
        "code": job.get("code"),
        "key": job.get("key"),
        "progress": progress,
    }


@router.post("/cancel", dependencies=[Depends(require_token)])
async def cancel_job(request: Request):
    body = await _json_body(request)
    jid = str(body.get("job") or "").strip()
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(status_code=404, detail="未知任务")
    if job.get("status") == "running":
        job["status"] = "cancelled"
        proc = job.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001 - 终止失败不抛给前端
                pass
    return {"job": jid, "status": job.get("status")}
