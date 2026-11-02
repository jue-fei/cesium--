"""KPI 字典与时序服务（方案 WP5 T5.2 / T5.7，同时支撑 R5）

职责：
- 定义 12 项核心 KPI（含单位、工序、聚合方式、是否累计量、来源）；
- 从调度快照自动提取可得的 7 项（不造数：拿不到的指标标为 manual，等接入后开启）；
- 提供分桶聚合查询：累计量取差分，瞬时量按 avg/max/sum；
- 数据库不可用时降级：写只记日志，查返回空，不阻断调度主链路。
"""
import json
import logging
import time
from typing import Any, Dict, Iterable, List, Optional

import pymysql

from app.database import DB_CONFIG

logger = logging.getLogger(__name__)

# 12 项 KPI 字典（对齐方案 T5.2 的 12 个核心指标）
# source: auto:scheduling = 自动从调度快照提取；manual = 待接入（爆破/应力/人工）
KPI_DEFS: List[Dict[str, Any]] = [
    {
        "code": "equip_utilization",
        "name": "设备利用率",
        "unit": "%",
        "proc": "haulage",
        "agg": "avg",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "equip_busy",
        "name": "在役设备数",
        "unit": "台",
        "proc": "haulage",
        "agg": "avg",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "stock_total_t",
        "name": "矿岩存量",
        "unit": "t",
        "proc": "haulage",
        "agg": "avg",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "grade_avg",
        "name": "平均品位",
        "unit": "%",
        "proc": "geology",
        "agg": "avg",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "active_muck_points",
        "name": "在采装载点",
        "unit": "个",
        "proc": "haulage",
        "agg": "avg",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "blocked_segments",
        "name": "封锁巷道段数",
        "unit": "段",
        "proc": "safety",
        "agg": "avg",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "hazard_index",
        "name": "危险指数",
        "unit": "-",
        "proc": "safety",
        "agg": "max",
        "isCumulative": False,
        "source": "auto:scheduling",
    },
    {
        "code": "reserve_t",
        "name": "保有储量",
        "unit": "t",
        "proc": "geology",
        "agg": "avg",
        "isCumulative": False,
        "source": "manual",
    },
    {
        "code": "powder_factor",
        "name": "炸药单耗",
        "unit": "kg/t",
        "proc": "blasting",
        "agg": "avg",
        "isCumulative": False,
        "source": "manual",
    },
    {
        "code": "frag_d50",
        "name": "块度 D50",
        "unit": "cm",
        "proc": "blasting",
        "agg": "avg",
        "isCumulative": False,
        "source": "manual",
    },
    {
        "code": "ppv_max",
        "name": "最大振速 PPV",
        "unit": "cm/s",
        "proc": "blasting",
        "agg": "max",
        "isCumulative": False,
        "source": "manual",
    },
    {
        "code": "shift_output_t",
        "name": "台班产量",
        "unit": "t",
        "proc": "haulage",
        "agg": "sum",
        "isCumulative": True,
        "source": "manual",
    },
]

DEF_BY_CODE = {d["code"]: d for d in KPI_DEFS}

_AUTO_CODES = [d["code"] for d in KPI_DEFS if str(d["source"]).startswith("auto:")]

_table_ready = False

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS `twin_kpi_def` (
      `code` VARCHAR(64) NOT NULL,
      `name` VARCHAR(64) NOT NULL,
      `unit` VARCHAR(16) NOT NULL DEFAULT '',
      `proc` VARCHAR(16) NOT NULL DEFAULT '',
      `agg` VARCHAR(8) NOT NULL DEFAULT 'avg',
      `is_cumulative` TINYINT NOT NULL DEFAULT 0,
      `source` VARCHAR(32) NOT NULL DEFAULT 'auto:scheduling',
      `enabled` TINYINT NOT NULL DEFAULT 1,
      PRIMARY KEY (`code`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='KPI 字典'
    """,
    """
    CREATE TABLE IF NOT EXISTS `twin_kpi_series` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      `code` VARCHAR(64) NOT NULL,
      `ts` DOUBLE NOT NULL,
      `value` DOUBLE NOT NULL,
      `tags` JSON NULL,
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`),
      KEY `idx_code_ts` (`code`, `ts`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='KPI 时序'
    """,
]


def _connect():
    return pymysql.connect(**DB_CONFIG)


def ensure_tables() -> bool:
    """建表 + 字典种子（幂等）。失败返回 False。"""
    global _table_ready
    if _table_ready:
        return True
    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                for ddl in _DDL:
                    cur.execute(ddl)
                cur.executemany(
                    "INSERT IGNORE INTO twin_kpi_def "
                    "(code, name, unit, proc, agg, is_cumulative, source) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    [
                        (
                            d["code"],
                            d["name"],
                            d["unit"],
                            d["proc"],
                            d["agg"],
                            1 if d["isCumulative"] else 0,
                            d["source"],
                        )
                        for d in KPI_DEFS
                    ],
                )
            conn.commit()
        finally:
            conn.close()
        _table_ready = True
        return True
    except Exception as exc:  # noqa: BLE001 - DB 不可用属预期降级
        logger.warning("KPI 表初始化失败（降级为不落库）：%s", exc)
        return False


# ─── 自动提取（从调度快照）────────────────────────────────
def extract_from_snapshot(snapshot: Dict[str, Any]) -> Dict[str, float]:
    """从调度快照提取可自动获得的 7 项 KPI；缺失字段跳过，不造数。"""
    factors = (snapshot or {}).get("factors") or {}
    out: Dict[str, float] = {}

    equip = (factors.get("equipment") or {}).get("items") or []
    total = len(equip)
    busy = sum(1 for e in equip if str(e.get("state") or "") not in ("idle", ""))
    if total:
        out["equip_utilization"] = round(busy / total * 100, 2)
    out["equip_busy"] = float(busy)

    points = (factors.get("muckPile") or {}).get("points") or []
    stock = 0.0
    grades = []
    active = 0
    for p in points:
        try:
            value = float(p.get("stock_t") or 0.0)
        except (TypeError, ValueError):
            value = 0.0
        stock += value
        if value > 0:
            active += 1
        grade = p.get("gradePct")
        if grade is not None:
            try:
                grades.append(float(grade))
            except (TypeError, ValueError):
                pass
    out["stock_total_t"] = round(stock, 2)
    out["active_muck_points"] = float(active)
    if grades:
        out["grade_avg"] = round(sum(grades) / len(grades), 3)

    segs = (factors.get("dynamicEnvironment") or {}).get("segments") or []
    blocked = sum(1 for s in segs if s.get("blocked"))
    out["blocked_segments"] = float(blocked)
    if segs:
        out["hazard_index"] = round(
            max(float(s.get("rockburst") or 0.0) for s in segs) * 100, 2
        )
    return out


# ─── 写入与查询 ────────────────────────────────────────────
def record(values: Dict[str, float], ts: Optional[float] = None, tags: Optional[dict] = None) -> int:
    """批量写入 KPI 点，返回成功写入条数。"""
    if not values:
        return 0
    if not ensure_tables():
        return 0
    stamp = float(ts if ts is not None else time.time())
    rows = []
    for code, value in values.items():
        if code not in DEF_BY_CODE:
            continue
        try:
            rows.append((code, stamp, float(value), json.dumps(tags or {}, ensure_ascii=False)))
        except (TypeError, ValueError):
            continue
    if not rows:
        return 0
    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO twin_kpi_series (code, ts, value, tags) VALUES (%s, %s, %s, %s)",
                    rows,
                )
            conn.commit()
        finally:
            conn.close()
        return len(rows)
    except Exception as exc:  # noqa: BLE001
        logger.warning("KPI 写入失败（降级）：%s", exc)
        return 0


def list_defs() -> List[Dict[str, Any]]:
    """KPI 字典（含字典表未落库时的内存定义）。"""
    ensure_tables()
    return [dict(d) for d in KPI_DEFS]


def _aggregate(points: List[tuple], step: int, agg: str, cumulative: bool) -> List[Dict[str, float]]:
    """按 step 秒分桶：累计量取桶内差分，瞬时量按 agg 聚合。"""
    if not points:
        return []
    buckets: Dict[int, List[float]] = {}
    for ts, value in points:
        key = int(ts // step) * step
        buckets.setdefault(key, []).append(value)

    series: List[Dict[str, float]] = []
    for key in sorted(buckets):
        vals = buckets[key]
        if cumulative:
            lo, hi = vals[0], vals[-1]
            series.append({"ts": float(key), "value": round(hi - lo, 3) if hi >= lo else round(hi, 3)})
            continue
        if agg == "max":
            value = max(vals)
        elif agg == "sum":
            value = sum(vals)
        else:
            value = sum(vals) / len(vals)
        series.append({"ts": float(key), "value": round(value, 3)})
    return series


def query(
    codes: Optional[Iterable[str]] = None,
    minutes: int = 60,
    step: int = 60,
) -> Dict[str, Any]:
    """查询最近 minutes 分钟的 KPI 序列，按 step 秒分桶。"""
    selected = [c for c in (codes or _AUTO_CODES) if c in DEF_BY_CODE] or list(_AUTO_CODES)
    step = max(5, int(step))
    since = time.time() - max(1, int(minutes)) * 60

    if not ensure_tables():
        return {"series": [], "step": step, "since": since, "degraded": True}

    placeholders = ",".join(["%s"] * len(selected))
    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT code, ts, value FROM twin_kpi_series "
                    f"WHERE code IN ({placeholders}) AND ts >= %s ORDER BY ts ASC",
                    (*selected, since),
                )
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("KPI 查询失败（降级）：%s", exc)
        return {"series": [], "step": step, "since": since, "degraded": True}

    grouped: Dict[str, List[tuple]] = {c: [] for c in selected}
    for row in rows:
        grouped.setdefault(row["code"], []).append((float(row["ts"]), float(row["value"])))

    series = []
    for code in selected:
        definition = DEF_BY_CODE[code]
        series.append(
            {
                "code": code,
                "name": definition["name"],
                "unit": definition["unit"],
                "points": _aggregate(
                    grouped.get(code) or [],
                    step,
                    definition["agg"],
                    bool(definition["isCumulative"]),
                ),
            }
        )
    return {"series": series, "step": step, "since": since, "degraded": False}


def latest(codes: Optional[Iterable[str]] = None) -> Dict[str, Any]:
    """每项 KPI 的最新值（驾驶舱 KPI 卡片用）。"""
    selected = [c for c in (codes or _AUTO_CODES) if c in DEF_BY_CODE] or list(_AUTO_CODES)
    if not ensure_tables():
        return {"items": [], "degraded": True}

    items = []
    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                for code in selected:
                    cur.execute(
                        "SELECT ts, value FROM twin_kpi_series WHERE code=%s ORDER BY ts DESC LIMIT 1",
                        (code,),
                    )
                    row = cur.fetchone()
                    definition = DEF_BY_CODE[code]
                    items.append(
                        {
                            "code": code,
                            "name": definition["name"],
                            "unit": definition["unit"],
                            "proc": definition["proc"],
                            "value": round(float(row["value"]), 3) if row else None,
                            "ts": float(row["ts"]) if row else None,
                        }
                    )
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("KPI 最新值查询失败（降级）：%s", exc)
        return {"items": [], "degraded": True}
    return {"items": items, "degraded": False}
