"""孪生事件持久化（WP2 T2.2）

设计取舍：
- 只有"外部上报 + 规则命中"两类事件落库，高频 tick 类事件仅进内存环形缓冲，
  避免 twin_event_log 被调度仿真噪声淹没。
- 数据库不可用时不阻断主链路：首次失败记 WARNING，之后静默降级（每 60s 允许重试一次）。
- 表结构见 `sql/twin_event.sql`；这里惰性 `CREATE TABLE IF NOT EXISTS` 兜底，
  便于开发环境不手动跑迁移也能工作。
"""
import json
import logging
import os
import time

import pymysql

from app.database import DB_CONFIG

logger = logging.getLogger(__name__)

# 关闭持久化：设置 TWIN_EVENT_PERSIST=0
_ENABLED = os.getenv("TWIN_EVENT_PERSIST", "1").strip().lower() not in {"0", "false", "off"}

# 单类型事件落库最小间隔（秒），防止同一规则高频触发写爆表
_THROTTLE_SECONDS = 1.0

_table_ready = False
_last_error_at = 0.0
_last_write: dict[str, float] = {}

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS `twin_event_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `seq` BIGINT NOT NULL COMMENT '总线序号（进程内单调递增）',
  `type` VARCHAR(128) NOT NULL COMMENT '事件类型',
  `proc` VARCHAR(32) NOT NULL COMMENT '工序',
  `ts` DOUBLE NOT NULL COMMENT '事件时间（epoch 秒）',
  `source` VARCHAR(32) NOT NULL DEFAULT 'api',
  `payload` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_seq` (`seq`),
  KEY `idx_type_ts` (`type`, `ts`),
  KEY `idx_proc_ts` (`proc`, `ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='孪生融合事件流水';
"""


def _connect():
    return pymysql.connect(**DB_CONFIG)


def ensure_table() -> bool:
    """确保事件表存在（幂等）。失败返回 False，不抛异常。"""
    global _table_ready
    if _table_ready:
        return True
    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                cur.execute(_CREATE_SQL)
            conn.commit()
        finally:
            conn.close()
        _table_ready = True
        return True
    except Exception as exc:  # noqa: BLE001 - 数据库不可用属预期降级路径
        _log_once(f"事件表初始化失败（持久化降级）：{exc}")
        return False


def _log_once(message: str) -> None:
    """同类错误 60 秒内只记一次，避免刷屏。"""
    global _last_error_at
    now = time.time()
    if now - _last_error_at >= 60:
        _last_error_at = now
        logger.warning(message)


def persist_event(event: dict) -> bool:
    """写入单条事件。返回是否成功；任何异常都被吞掉并降级。"""
    if not _ENABLED:
        return False

    event_type = str(event.get("type") or "")
    now = time.time()
    last = _last_write.get(event_type, 0.0)
    if now - last < _THROTTLE_SECONDS:
        return False
    _last_write[event_type] = now

    if not ensure_table():
        return False

    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO twin_event_log (seq, type, proc, ts, source, payload) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (
                        int(event.get("seq") or 0),
                        event_type,
                        str(event.get("proc") or ""),
                        float(event.get("ts") or now),
                        str(event.get("source") or "api")[:32],
                        json.dumps(event.get("payload") or {}, ensure_ascii=False),
                    ),
                )
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception as exc:  # noqa: BLE001 - 写失败不得影响事件分发
        _log_once(f"事件落库失败（持久化降级）：{exc}")
        return False
