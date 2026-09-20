"""
ts_store.py —— 时序化工况数据统一存储层（历史 + 实时统一写入点）

设计口径：
  - 全平台工况指标（设备/传感器/爆破事件指标/预警事件）统一走
    record_metric(metric, value, tags) 写入，查询走 query_timeseries；
    各模块不再自行散点存 JSON 字段。
  - 存储后端由 config/timeseries.json 选择：'memory'（进程内，默认，
    零依赖、测试友好）或 'mysql'（ts_points 表，DB 优先纪律）。
    MySQL 不可达时自动降级 memory 并告警一次，接口行为完全一致。
  - 时间戳统一 Unix 秒（真实时钟）；查询/降采样/保留策略见 retention.py
    （契约 shared-consistency-baseline.json#timeseriesCmps）。
  - 写入路径热：内存存储 O(1)；MySQL 批量缓冲刷写（每 200 点或查询前）。
"""
import json
import logging
import time
from pathlib import Path
from threading import Lock

from app.services.timeseries.retention import (
    BUCKET_SECONDS,
    MAX_POINTS_PER_QUERY,
    RETENTION_SECONDS,
    clip_by_retention,
    downsample,
    normalize_downsample,
)

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "timeseries.json"

# 内存存储每序列点数上限（防无界增长；超出丢最旧）
_MEMORY_SERIES_CAP = 4000

_store = None
_store_tried = False


def load_ts_config():
    """读取存储配置（文件缺失/非法回退 memory）。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if isinstance(cfg, dict):
            return {
                "backend": "mysql" if cfg.get("backend") == "mysql" else "memory",
                "flushBatchSize": max(1, int(cfg.get("flushBatchSize", 200))),
            }
    except (OSError, ValueError):
        pass
    return {"backend": "memory", "flushBatchSize": 200}


# =====================================================================
# 内存存储（默认后端）
# =====================================================================

class MemoryTsStore:
    """进程内时序存储：key=(metric, tags) 序列，点列表时间升序。

    保留策略：raw 窗口裁剪 + 序列点数上限双保险。
    """

    def __init__(self):
        self._series = {}  # (metric, tags_tuple) -> [(ts, value)]
        self._lock = Lock()

    @staticmethod
    def _key(metric, tags):
        return (metric, tuple(sorted((tags or {}).items())))

    def write(self, metric, ts, value, tags=None):
        try:
            v = float(value)
        except (TypeError, ValueError):
            return False
        with self._lock:
            pts = self._series.setdefault(self._key(metric, tags), [])
            pts.append((float(ts), v))
            # 时间升序写入；偶发乱序仅排序本序列（写多读少，代价可忽略）
            if len(pts) > 1 and pts[-1][0] < pts[-2][0]:
                pts.sort(key=lambda p: p[0])
            # raw 保留窗口裁剪 + 点数上限
            now = time.time()
            trimmed = clip_by_retention(pts, now, RETENTION_SECONDS["raw"])
            if len(trimmed) > _MEMORY_SERIES_CAP:
                trimmed = trimmed[-_MEMORY_SERIES_CAP:]
            self._series[self._key(metric, tags)] = trimmed
        return True

    def query(self, metric, start=None, end=None, tags=None, downsample_name="raw"):
        name = normalize_downsample(downsample_name)
        bucket_s = BUCKET_SECONDS[name]
        with self._lock:
            if metric is not None:
                keys = [k for k in self._series if k[0] == metric]
            else:
                keys = list(self._series)
            merged = []
            for key in keys:
                if tags:
                    series_tags = dict(key[1])
                    if not all(series_tags.get(tk) == tv for tk, tv in tags.items()):
                        continue
                for ts, v in self._series[key]:
                    if start is not None and ts < start:
                        continue
                    if end is not None and ts > end:
                        continue
                    merged.append((ts, v))
        merged.sort(key=lambda p: p[0])
        return downsample(merged, bucket_s)

    def metrics(self):
        now = time.time()
        agg = {}
        with self._lock:
            for (metric, tags), pts in self._series.items():
                a = agg.setdefault(metric, {"series": 0, "points": 0, "firstTs": None, "lastTs": None})
                a["series"] += 1
                a["points"] += len(pts)
                if pts:
                    a["firstTs"] = min(a["firstTs"] or pts[0][0], pts[0][0])
                    a["lastTs"] = max(a["lastTs"] or pts[-1][0], pts[-1][0])
        out = []
        for metric, a in agg.items():
            out.append({
                "metric": metric,
                "seriesCount": a["series"],
                "pointCount": a["points"],
                "firstTs": a["firstTs"],
                "lastTs": a["lastTs"],
                "ageS": round(now - a["lastTs"], 1) if a["lastTs"] else None,
            })
        out.sort(key=lambda m: m["metric"])
        return out


# =====================================================================
# MySQL 存储（可选后端，批量缓冲刷写）
# =====================================================================

class MysqlTsStore:
    """MySQL 时序存储：ts_points 表（metric, series_key, ts, value, tags JSON）。

    写入走缓冲批量刷写（flushBatchSize）；查询前强制 flush，保证读己之写。
    表结构懒创建；连接失败抛出由工厂降级 memory。
    """

    DDL = """
    CREATE TABLE IF NOT EXISTS ts_points (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        metric VARCHAR(96) NOT NULL,
        series_key VARCHAR(255) NOT NULL DEFAULT '',
        ts DOUBLE NOT NULL,
        value DOUBLE NOT NULL,
        tags JSON NULL,
        INDEX idx_metric_ts (metric, ts),
        INDEX idx_series (series_key, ts)
    )
    """

    def __init__(self, flush_batch_size=200):
        self._buffer = []
        self._batch = max(1, int(flush_batch_size))
        self._conn = None
        self._table_ready = False

    def _connection(self):
        from app.database import DB_CONFIG
        from pymysql import connect
        if self._conn is None or self._conn.open is False:
            cfg = dict(DB_CONFIG)
            cfg["autocommit"] = True
            self._conn = connect(**cfg)
        return self._conn

    def _ensure_table(self):
        if not self._table_ready:
            with self._connection().cursor() as cur:
                cur.execute(self.DDL)
            self._table_ready = True

    @staticmethod
    def _key(metric, tags):
        return metric + "|" + ",".join(f"{k}={tags[k]}" for k in sorted(tags or {}))

    def write(self, metric, ts, value, tags=None):
        try:
            v = float(value)
        except (TypeError, ValueError):
            return False
        self._buffer.append((metric, self._key(metric, tags), float(ts), v, json.dumps(tags or {}, ensure_ascii=False)))
        if len(self._buffer) >= self._batch:
            self.flush()
        return True

    def flush(self):
        if not self._buffer:
            return
        rows, self._buffer = self._buffer, []
        conn = self._connection()
        self._ensure_table()
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO ts_points (metric, series_key, ts, value, tags) VALUES (%s, %s, %s, %s, %s)",
                rows,
            )

    def query(self, metric, start=None, end=None, tags=None, downsample_name="raw"):
        self.flush()
        name = normalize_downsample(downsample_name)
        sql = "SELECT ts, value, series_key, tags FROM ts_points WHERE metric=%s"
        args = [metric]
        if start is not None:
            sql += " AND ts>=%s"
            args.append(start)
        if end is not None:
            sql += " AND ts<=%s"
            args.append(end)
        sql += " ORDER BY ts ASC"
        with self._connection().cursor() as cur:
            cur.execute(sql, args)
            rows = cur.fetchall()
        points = []
        for r in rows:
            if tags:
                row_tags = r.get("tags")
                if isinstance(row_tags, str):
                    try:
                        row_tags = json.loads(row_tags)
                    except ValueError:
                        row_tags = {}
                if not isinstance(row_tags, dict) or not all(row_tags.get(k) == v for k, v in tags.items()):
                    continue
            points.append((float(r["ts"]), float(r["value"])))
        return downsample(points, BUCKET_SECONDS[name])

    def metrics(self):
        self.flush()
        with self._connection().cursor() as cur:
            cur.execute(
                "SELECT metric, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts,"
                " COUNT(DISTINCT series_key) AS series FROM ts_points GROUP BY metric"
            )
            rows = cur.fetchall()
        return [
            {
                "metric": r["metric"],
                "seriesCount": int(r["series"]),
                "pointCount": int(r["n"]),
                "firstTs": float(r["first_ts"]),
                "lastTs": float(r["last_ts"]),
                "ageS": round(time.time() - float(r["last_ts"]), 1),
            }
            for r in rows
        ]


# =====================================================================
# 工厂与统一入口
# =====================================================================

def get_ts_store():
    """取全局时序存储（按配置选择后端；MySQL 不可达自动降级 memory）。"""
    global _store, _store_tried
    if _store_tried:
        return _store
    _store_tried = True
    cfg = load_ts_config()
    if cfg["backend"] == "mysql":
        try:
            store = MysqlTsStore(cfg["flushBatchSize"])
            store._connection().ping(reconnect=True)  # 探活，失败走降级
            _store = store
            logger.info("[TS] 时序存储后端 = mysql")
            return _store
        except Exception as e:  # noqa: BLE001 —— DB 不可达必须降级而非 500
            logger.warning("[TS] MySQL 时序存储不可达，降级 memory：%s", e)
    _store = MemoryTsStore()
    logger.info("[TS] 时序存储后端 = memory")
    return _store


def reset_ts_store():
    """测试钩子：清空全局存储选择。"""
    global _store, _store_tried
    _store = None
    _store_tried = False


def record_metric(metric, value, tags=None, ts=None):
    """统一写入点：全平台工况指标都走这里（热路径安全，失败不抛）。"""
    try:
        return get_ts_store().write(metric, time.time() if ts is None else ts, value, tags)
    except Exception:  # noqa: BLE001 —— 监控数据写入失败不允许打断业务
        return False


def query_timeseries(metric, start=None, end=None, tags=None, downsample_name="raw"):
    """统一查询入口；返回 {points, downsample, maxPoints}。"""
    points = get_ts_store().query(metric, start, end, tags, downsample_name)
    return {
        "metric": metric,
        "downsample": normalize_downsample(downsample_name),
        "maxPoints": MAX_POINTS_PER_QUERY,
        "points": [{"t": round(t, 3), "v": round(v, 4)} for t, v in points],
    }
