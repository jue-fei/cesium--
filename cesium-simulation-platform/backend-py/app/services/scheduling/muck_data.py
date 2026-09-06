"""
采矿区任务数据提供器（现场调度·井下 LHD）

每个采矿区(装载点)的"需采矿工作量 + 各类信息"来源（由高到低）：
  1. 数据库 scheduling_muck_task 表 —— 后端可手动编辑（GET/PUT /api/scheduling/muck_tasks），非死代码；
  2. 跨板块反哺 —— 关联爆破事件 blast_event_id → 爆破板块 blasting_result 的块度分布
     （fragment_x50/x80/xmax/b/n + 直方图）覆盖到采矿区，source 标记为 'blasting'；
  3. 兜底 —— 场景配置 muckPoints 生成的默认值（seed 时写入本表，source=scenario）。

本模块同时被：
  - 仿真器 simulator.py 调用（构造 MuckPileState）；
  - 路由 scheduling.py 调用（手动编辑接口 /api/scheduling/muck_tasks）。
"""
import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from app.database import DB_CONFIG
    import pymysql
    from pymysql.cursors import DictCursor

    _DB_AVAILABLE = True
except Exception:  # 数据库依赖缺失时退化为纯配置兜底
    DB_CONFIG = None
    pymysql = None
    DictCursor = None
    _DB_AVAILABLE = False

# 任务字典规范字段（DB 列 / 仿真器消费统一口径）
TASK_KEYS = [
    "task_id", "scenario", "zone", "gantry", "node", "muck_level", "required_work_t",
    "remaining_work_t", "grade_pct", "blast_event_id",
    "frag_x50_m", "frag_x80_m", "frag_xmax_m", "frag_b", "frag_n",
    "size_hist", "big_block_ratio", "recognize_rate",
    "shape", "spread_r_m", "height_m_m", "blast_cycle", "source", "enabled", "remark",
]

# 默认块度直方图（自行编造的工程经验值，可入库后手动改）
_DEFAULT_HIST = [
    {"range": "0-10cm", "pct": 38.0},
    {"range": "10-30cm", "pct": 34.0},
    {"range": "30-60cm", "pct": 18.0},
    {"range": "60-100cm", "pct": 7.0},
    {"range": ">100cm", "pct": 3.0},
]
_DEFAULT_HIST_COARSE = [
    {"range": "0-10cm", "pct": 30.0},
    {"range": "10-30cm", "pct": 30.0},
    {"range": "30-60cm", "pct": 22.0},
    {"range": "60-100cm", "pct": 12.0},
    {"range": ">100cm", "pct": 6.0},
]


def _db_conn():
    if not _DB_AVAILABLE:
        return None
    try:
        return pymysql.connect(**DB_CONFIG)
    except Exception as e:
        logger.warning("[muck_data] 数据库连接失败，回退配置: %s", e)
        return None


def _has_scenario_column(conn) -> bool:
    """scheduling_muck_task 表是否已含 scenario 列（旧表无此列时退化为按 id 过滤）。"""
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS n FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='scheduling_muck_task' "
                "AND COLUMN_NAME='scenario'"
            )
            row = cur.fetchone()
            return int((row or {}).get("n", 0) or 0) > 0
    except Exception:
        return False


def _row_to_task(row: dict) -> dict:
    """DB 行 → 规范任务 dict（size_hist_json 反序列化为 size_hist）。"""
    task = {k: row.get(k) for k in TASK_KEYS if k in row}
    if "size_hist_json" in row and row.get("size_hist_json"):
        try:
            task["size_hist"] = json.loads(row["size_hist_json"])
        except (json.JSONDecodeError, TypeError):
            task["size_hist"] = None
    else:
        task.setdefault("size_hist", None)
    return task


# =====================================================================
# 1) 默认任务（由场景配置 muckPoints 编造，可入库后手动改）
# =====================================================================
def default_tasks_from_scenario(cfg: dict) -> list:
    """把场景配置 muckPoints 展开为采矿区任务（含自行编造的块度/堆形信息）。"""
    muck_points = cfg.get("muckPoints", []) or []
    grade = cfg.get("gradePct", {}) or {}
    muck_level = cfg.get("muckLevel", {}) or {}
    sid = cfg.get("scenario", "")
    tasks = []
    for mp in muck_points:
        tid = mp["id"]
        coarse = tid in ("M7", "M8")  # 深部/底部采场块度更粗（工程经验）
        tasks.append({
            "task_id": tid,
            "scenario": sid,
            "zone": mp.get("zone", ""),
            "gantry": mp.get("gantry", ""),
            "node": tid,
            "muck_level": int(muck_level.get(tid, 0)),
            "required_work_t": float(mp.get("initialStockT", 320)),
            "remaining_work_t": float(mp.get("initialStockT", 320)),
            "grade_pct": float(grade.get(tid, 0.8)),
            "blast_event_id": "",
            "frag_x50_m": 0.32 if coarse else 0.20,
            "frag_x80_m": 0.48 if coarse else 0.30,
            "frag_xmax_m": 2.0 if coarse else 1.2,
            "frag_b": 2.0,
            "frag_n": 1.0 if coarse else 1.2,
            "size_hist": (_DEFAULT_HIST_COARSE if coarse else _DEFAULT_HIST),
            "big_block_ratio": 6.0 if coarse else 3.0,
            "recognize_rate": 0.92 if coarse else 0.95,
            "shape": mp.get("muckShape", "半锥体散堆"),
            "spread_r_m": float(mp.get("spreadR_m", 8.0)),
            "height_m_m": float(mp.get("heightM_m", 2.0)),
            "blast_cycle": mp.get("blastCycle", ""),
            "source": "scenario",
            "enabled": True,
            "remark": "场景配置兜底，可手动修改",
        })
    return tasks


# =====================================================================
# 2) 数据库读写
# =====================================================================
def load_tasks_from_db(scenario: Optional[str] = None) -> Optional[list]:
    """从 scheduling_muck_task 读取指定场景的启用任务；无记录/失败返回 None。

    scenario 为空时返回全量；非空且表含 scenario 列时按场景过滤。
    同 task_id 同时存在 scenario 专属与旧版(scenario='')记录时，优先取场景专属。
    """
    conn = _db_conn()
    if conn is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM scheduling_muck_task WHERE enabled=1 ORDER BY task_id"
            )
            rows = cur.fetchall()
            if not rows:
                return None
            tasks = [_row_to_task(r) for r in rows]
        if scenario and _has_scenario_column(conn):
            sid = scenario
            best = {}
            for t in tasks:
                tid = t.get("task_id")
                ts = t.get("scenario") or ""
                # 取优先级：场景专属 > 旧版空 scenario
                if ts == sid:
                    best[tid] = t
                elif ts == "" and tid not in best:
                    best[tid] = t
            return list(best.values())
        return tasks
    except Exception as e:
        logger.warning("[muck_data] 读取采矿区任务失败: %s", e)
        return None
    finally:
        conn.close()


def upsert_task(task_id: str, body: dict, scenario: str = "", has_scenario_col: bool = True) -> bool:
    """手动编辑采矿区任务（PUT）。仅更新白名单字段，size_hist_json 序列化。"""
    conn = _db_conn()
    if conn is None:
        return False
    allowed = {
        "zone", "gantry", "node", "muck_level", "required_work_t", "remaining_work_t",
        "grade_pct", "blast_event_id", "frag_x50_m", "frag_x80_m", "frag_xmax_m",
        "frag_b", "frag_n", "big_block_ratio", "recognize_rate",
        "shape", "spread_r_m", "height_m_m", "blast_cycle", "enabled", "remark",
    }
    if scenario and has_scenario_col:
        allowed.add("scenario")
    updates = {k: body[k] for k in body if k in allowed}
    if scenario and has_scenario_col and "scenario" not in updates:
        updates["scenario"] = scenario
    if "size_hist" in body:
        updates["size_hist_json"] = json.dumps(body["size_hist"], ensure_ascii=False)
    if not updates:
        return False
    cols = "`" + "`, `".join(updates.keys()) + "`"
    placeholders = ", ".join(["%s"] * len(updates))
    set_clause = ", ".join([f"`{k}`=VALUES(`{k}`)" for k in updates])
    sql = (
        f"INSERT INTO scheduling_muck_task (`task_id`, {cols}) VALUES (%s, {placeholders}) "
        f"ON DUPLICATE KEY UPDATE {set_clause}"
    )
    try:
        with conn.cursor() as cur:
            cur.execute(sql, [task_id] + list(updates.values()))
        conn.commit()
        return True
    except Exception as e:
        logger.warning("[muck_data] 写入采矿区任务 %s 失败: %s", task_id, e)
        return False
    finally:
        conn.close()


# =====================================================================
# 3) 跨板块反哺：爆破板块块度分布
# =====================================================================
def enrich_from_blasting(tasks: list) -> list:
    """按 blast_event_id 从爆破板块 blasting_result 反哺块度分布。

    可反哺字段：fragment_x50/x80/xmax/b/n + 直方图；命中后 source='blasting'。
    """
    if not tasks:
        return tasks
    event_ids = [t["blast_event_id"] for t in tasks if t.get("blast_event_id")]
    if not event_ids:
        return tasks
    conn = _db_conn()
    if conn is None:
        return tasks
    try:
        results = {}
        with conn.cursor() as cur:
            placeholders = ", ".join(["%s"] * len(event_ids))
            cur.execute(
                "SELECT event_id, fragment_x50, fragment_x80, fragment_xmax, "
                "fragment_b, fragment_n, fragment_count, fragment_histogram_json "
                f"FROM blasting_result WHERE event_id IN ({placeholders})",
                event_ids,
            )
            for row in cur.fetchall():
                results[row["event_id"]] = row
        out = []
        for t in tasks:
            row = results.get(t.get("blast_event_id"))
            if row:
                t = {**t, "source": "blasting", "remark": "块度分布由爆破板块反哺"}
                if row.get("fragment_x50") is not None:
                    t["frag_x50_m"] = float(row["fragment_x50"])
                if row.get("fragment_x80") is not None:
                    t["frag_x80_m"] = float(row["fragment_x80"])
                if row.get("fragment_xmax") is not None:
                    t["frag_xmax_m"] = float(row["fragment_xmax"])
                if row.get("fragment_b") is not None:
                    t["frag_b"] = float(row["fragment_b"])
                if row.get("fragment_n") is not None:
                    t["frag_n"] = float(row["fragment_n"])
                if row.get("fragment_histogram_json"):
                    try:
                        t["size_hist"] = json.loads(row["fragment_histogram_json"])
                    except (json.JSONDecodeError, TypeError):
                        pass
            out.append(t)
        return out
    except Exception as e:
        logger.warning("[muck_data] 爆破板块反哺失败: %s", e)
        return tasks
    finally:
        conn.close()


# =====================================================================
# 4) 对外统一入口
# =====================================================================
def load_muck_tasks(cfg: dict) -> list:
    """加载采矿区任务：数据库 → 跨板块反哺；无库时场景配置兜底 → 反哺。

    多场景（ashale / large 等）共用 scheduling_muck_task 表任务隔离：
      - 表含 scenario 列时严格按"本场景 scenario 字段"读取（缺失采场用场景配置兜底补齐）；
      - 旧表无 scenario 列时退化为按 muckPoints id 集合过滤（避免跨场景 M1~M4 串扰）。
    """
    sid = str(cfg.get("scenario", ""))
    ids = {str(mp.get("id")) for mp in (cfg.get("muckPoints") or [])}
    # upsert 是否需要携带 scenario 列：取决于表是否已升级（旧表不写该列）
    has_col = False
    conn = _db_conn()
    if conn is not None:
        has_col = _has_scenario_column(conn)
        conn.close()

    tasks = load_tasks_from_db(sid)
    if tasks is not None:
        # 旧表（无 scenario 列）也按 id 集合过滤，避免读取其它场景的装载点
        tasks = [t for t in tasks if t.get("task_id") in ids]

    def _upsert_all(ts):
        if _DB_AVAILABLE:
            for t in ts:
                upsert_task(t["task_id"], t, scenario=sid, has_scenario_col=has_col)

    if not tasks:
        tasks = default_tasks_from_scenario(cfg)
        tasks = enrich_from_blasting(tasks) if _DB_AVAILABLE else tasks
        # 尽力写入数据库（自动入库，之后即可手动编辑）
        _upsert_all(tasks)
        return tasks
    # 数据库有记录但缺失部分采场（如新场景 M5~M8 未入库）：场景配置兜底补齐
    have = {t["task_id"] for t in tasks}
    defaults = default_tasks_from_scenario(cfg)
    merged = list(tasks)
    for t in defaults:
        if t["task_id"] not in have:
            merged.append(t)
    _upsert_all(merged)
    merged = enrich_from_blasting(merged) if _DB_AVAILABLE else merged
    return merged


def list_tasks_for_api(cfg: dict) -> list:
    """供 GET /api/scheduling/muck_tasks 使用：返回可展示的任务列表。"""
    return load_muck_tasks(cfg)
