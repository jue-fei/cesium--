"""数据源台账与接入批次存储（方案 WP1 T1.6）

三张表：
- data_source        数据源登记（4 类：rest/ws/file/db），是"集成方式 ≥4 种"的举证台账
- ingest_batch       每次导入批次（文件/接口/库抽取），支持回溯批次号
- ingest_reject_log  质检拒收明细（T1.7 数据质量规则）

数据库不可用时：读接口返回空列表，写接口返回明确错误，不抛异常拖垮服务。
表结构见 `sql/ingest_schema.sql`；这里惰性建表兜底开发环境。
"""
import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import pymysql

from app.database import DB_CONFIG

logger = logging.getLogger(__name__)

VALID_KINDS = ("rest", "ws", "file", "db")

_table_ready = False

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS `data_source` (
      `code` VARCHAR(64) NOT NULL COMMENT '数据源编码（业务唯一）',
      `name` VARCHAR(128) NOT NULL COMMENT '数据源名称',
      `kind` VARCHAR(16) NOT NULL COMMENT '类型：rest|ws|file|db',
      `endpoint` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '地址/视图名/说明',
      `auth_ref` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '凭据引用（不存明文）',
      `schema_json` JSON NULL COMMENT '字段映射与质量规则',
      `status` VARCHAR(16) NOT NULL DEFAULT 'idle' COMMENT 'idle|connected|error',
      `last_sync_at` DATETIME NULL,
      `owner` VARCHAR(64) NOT NULL DEFAULT '',
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (`code`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据源台账'
    """,
    """
    CREATE TABLE IF NOT EXISTS `ingest_batch` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      `source_code` VARCHAR(64) NOT NULL,
      `batch_no` VARCHAR(64) NOT NULL,
      `filename` VARCHAR(255) NOT NULL DEFAULT '',
      `rows_total` INT NOT NULL DEFAULT 0,
      `rows_accepted` INT NOT NULL DEFAULT 0,
      `rows_rejected` INT NOT NULL DEFAULT 0,
      `status` VARCHAR(16) NOT NULL DEFAULT 'ok',
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      UNIQUE KEY `uk_batch_no` (`batch_no`),
      KEY `idx_source_created` (`source_code`, `created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据接入批次'
    """,
    """
    CREATE TABLE IF NOT EXISTS `ingest_reject_log` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      `batch_no` VARCHAR(64) NOT NULL,
      `row_no` INT NOT NULL DEFAULT 0,
      `reason` VARCHAR(255) NOT NULL DEFAULT '',
      `payload` JSON NULL,
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_batch` (`batch_no`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='接入质检拒收明细'
    """,
]


def connect():
    """独立连接（台账操作低频，不复用请求级连接）。"""
    return pymysql.connect(**DB_CONFIG)


def ensure_tables() -> bool:
    """惰性建表，失败返回 False（调用方降级）。"""
    global _table_ready
    if _table_ready:
        return True
    try:
        conn = connect()
        try:
            with conn.cursor() as cur:
                for ddl in _DDL:
                    cur.execute(ddl)
            conn.commit()
        finally:
            conn.close()
        _table_ready = True
        return True
    except Exception as exc:  # noqa: BLE001 - 数据库不可用属预期降级路径
        logger.warning("数据源台账建表失败（降级为不可用）：%s", exc)
        return False


# ─── data_source ───────────────────────────────────────────
def list_sources() -> List[Dict[str, Any]]:
    if not ensure_tables():
        return []
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT code, name, kind, endpoint, auth_ref, schema_json, status, "
                "last_sync_at, owner, created_at, updated_at FROM data_source ORDER BY code"
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    for row in rows:
        row["schema"] = _json_or_empty(row.pop("schema_json", None))
        for key in ("last_sync_at", "created_at", "updated_at"):
            if isinstance(row.get(key), datetime):
                row[key] = row[key].isoformat(sep=" ", timespec="seconds")
    return rows


def get_source(code: str) -> Optional[Dict[str, Any]]:
    for row in list_sources():
        if row["code"] == code:
            return row
    return None


def upsert_source(
    code: str,
    name: str,
    kind: str,
    endpoint: str = "",
    auth_ref: str = "",
    schema: Optional[Dict[str, Any]] = None,
    owner: str = "",
) -> bool:
    if kind not in VALID_KINDS:
        raise ValueError(f"非法 kind {kind!r}，可选：{', '.join(VALID_KINDS)}")
    if not ensure_tables():
        return False
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO data_source (code, name, kind, endpoint, auth_ref, schema_json, owner) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON DUPLICATE KEY UPDATE name=VALUES(name), kind=VALUES(kind), "
                "endpoint=VALUES(endpoint), auth_ref=VALUES(auth_ref), "
                "schema_json=VALUES(schema_json), owner=VALUES(owner)",
                (
                    code,
                    name,
                    kind,
                    endpoint,
                    auth_ref,
                    json.dumps(schema or {}, ensure_ascii=False),
                    owner,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return True


def delete_source(code: str) -> bool:
    if not ensure_tables():
        return False
    conn = connect()
    try:
        with conn.cursor() as cur:
            affected = cur.execute("DELETE FROM data_source WHERE code=%s", (code,))
        conn.commit()
    finally:
        conn.close()
    return bool(affected)


def mark_status(code: str, status: str, touch_sync: bool = False) -> None:
    if not ensure_tables():
        return
    conn = connect()
    try:
        with conn.cursor() as cur:
            if touch_sync:
                cur.execute(
                    "UPDATE data_source SET status=%s, last_sync_at=NOW() WHERE code=%s",
                    (status, code),
                )
            else:
                cur.execute("UPDATE data_source SET status=%s WHERE code=%s", (status, code))
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("更新数据源状态失败：%s", exc)
    finally:
        conn.close()


# ─── ingest_batch / reject ─────────────────────────────────
def new_batch_no(source_code: str) -> str:
    """批次号：源编码 + 时间 + 4 位随机，便于回溯。"""
    return f"{source_code}-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:4]}"


def create_batch(
    source_code: str,
    filename: str,
    rows_total: int,
    rows_accepted: int,
    rows_rejected: int,
    batch_no: Optional[str] = None,
) -> str:
    batch_no = batch_no or new_batch_no(source_code)
    if not ensure_tables():
        return batch_no
    status = "ok" if rows_rejected == 0 else ("partial" if rows_accepted else "failed")
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO ingest_batch "
                "(source_code, batch_no, filename, rows_total, rows_accepted, rows_rejected, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (source_code, batch_no, filename, rows_total, rows_accepted, rows_rejected, status),
            )
        conn.commit()
    finally:
        conn.close()
    return batch_no


def log_reject(batch_no: str, row_no: int, reason: str, payload: Any) -> None:
    if not ensure_tables():
        return
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO ingest_reject_log (batch_no, row_no, reason, payload) "
                "VALUES (%s, %s, %s, %s)",
                (batch_no, row_no, reason[:255], json.dumps(payload, ensure_ascii=False)[:60000]),
            )
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("写入拒收明细失败：%s", exc)
    finally:
        conn.close()


def list_batches(source_code: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    if not ensure_tables():
        return []
    conn = connect()
    try:
        with conn.cursor() as cur:
            if source_code:
                cur.execute(
                    "SELECT * FROM ingest_batch WHERE source_code=%s ORDER BY id DESC LIMIT %s",
                    (source_code, int(limit)),
                )
            else:
                cur.execute("SELECT * FROM ingest_batch ORDER BY id DESC LIMIT %s", (int(limit),))
            rows = cur.fetchall()
    finally:
        conn.close()
    for row in rows:
        if isinstance(row.get("created_at"), datetime):
            row["created_at"] = row["created_at"].isoformat(sep=" ", timespec="seconds")
    return rows


def _json_or_empty(value: Any) -> Dict[str, Any]:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}
