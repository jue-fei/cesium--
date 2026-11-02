"""REST / 数据库 / WebSocket 适配器（方案 WP1 T1.2 / T1.3 / T1.5）

安全边界：
- REST 只做 GET，不携带任何明文凭据（凭据以 auth_ref 引用，暂不解析）；
- DB 只允许平台库内「字母/数字/下划线」命名的视图或表，且强制加 LIMIT，杜绝拼接注入；
- WS 本轮采用「推送接收」模式（外部系统 POST /push），不主动外连任意地址，
  避免平台被当成内网探测器；主动订阅内部流见 capabilities 说明。
"""
import logging
import re
import time
from typing import Any, Dict, List

import httpx
import pymysql

from app.database import DB_CONFIG
from app.services.ingest import pipeline, store
from app.services.ingest.base import DataSourceAdapter, IngestResult

logger = logging.getLogger(__name__)

# 表名/视图名白名单：只允许常规标识符，杜绝 SQL 注入
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

# 常见列表容器字段，兼容不同后端返回结构
_LIST_KEYS = ("data", "rows", "items", "list", "records", "result")


def extract_rows(payload: Any) -> List[Any]:
    """从任意 JSON 响应中提取行数组（dict 包一层时按常见键下钻）。"""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            value = payload.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                nested = extract_rows(value)
                if nested:
                    return nested
    return []


class RestAdapter(DataSourceAdapter):
    """REST 拉取：GET endpoint，按 schema.mapping 规范化。"""

    kind = "rest"

    def test(self) -> Dict[str, Any]:
        if not self.endpoint:
            return {"ok": False, "message": "endpoint 为空", "latencyMs": 0}
        started = time.perf_counter()
        try:
            resp = httpx.get(self.endpoint, timeout=5.0)
            latency = round((time.perf_counter() - started) * 1000, 1)
            ok = resp.status_code < 400
            return {
                "ok": ok,
                "message": f"HTTP {resp.status_code}",
                "latencyMs": latency,
                "detail": {"contentType": resp.headers.get("content-type", "")},
            }
        except Exception as exc:  # noqa: BLE001 - 连通性检测需返回原因而非抛出
            latency = round((time.perf_counter() - started) * 1000, 1)
            return {"ok": False, "message": str(exc), "latencyMs": latency}

    def pull(self, limit: int = 100) -> IngestResult:
        if not self.endpoint:
            return IngestResult(ok=False, message="endpoint 为空")
        started = time.perf_counter()
        try:
            resp = httpx.get(self.endpoint, timeout=10.0)
            resp.raise_for_status()
            rows = extract_rows(resp.json())
        except Exception as exc:  # noqa: BLE001
            store.mark_status(self.code, "error")
            return IngestResult(ok=False, message=f"拉取失败：{exc}")

        rows = rows[: max(1, int(limit))]
        result = pipeline.run_ingest(self.source, f"rest:{self.endpoint}", rows)
        result.message = f"{result.message}（{round((time.perf_counter() - started) * 1000, 1)}ms）"
        return result


class DbAdapter(DataSourceAdapter):
    """数据库抽取：只读 SELECT 平台库内的视图/表，强制 LIMIT。"""

    kind = "db"

    def _connect(self):
        return pymysql.connect(**DB_CONFIG)

    def test(self) -> Dict[str, Any]:
        name = self.endpoint.strip()
        if not _IDENTIFIER.match(name):
            return {"ok": False, "message": f"非法表/视图名 {name!r}", "latencyMs": 0}
        started = time.perf_counter()
        try:
            conn = self._connect()
            try:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT 1 FROM `{name}` LIMIT 1")
                    cur.fetchall()
            finally:
                conn.close()
            latency = round((time.perf_counter() - started) * 1000, 1)
            return {"ok": True, "message": f"视图 {name} 可读", "latencyMs": latency}
        except Exception as exc:  # noqa: BLE001
            latency = round((time.perf_counter() - started) * 1000, 1)
            return {"ok": False, "message": str(exc), "latencyMs": latency}

    def pull(self, limit: int = 100) -> IngestResult:
        name = self.endpoint.strip()
        if not _IDENTIFIER.match(name):
            return IngestResult(ok=False, message=f"非法表/视图名 {name!r}")
        try:
            conn = self._connect()
            try:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT * FROM `{name}` LIMIT %s", (max(1, int(limit)),))
                    rows = cur.fetchall()
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001
            store.mark_status(self.code, "error")
            return IngestResult(ok=False, message=f"抽取失败：{exc}")

        return pipeline.run_ingest(self.source, f"db:{name}", list(rows))


class WsAdapter(DataSourceAdapter):
    """WebSocket 数据源：本轮以「推送接收」实现（外部系统 POST 到 /push）。

    真正的长连接订阅需要外部端地址与鉴权，纳入 M2（T1.3 增强）。
    """

    kind = "ws"

    def test(self) -> Dict[str, Any]:
        target = self.endpoint.strip()
        if not target:
            return {"ok": False, "message": "endpoint 为空", "latencyMs": 0}
        if not (target.startswith("ws://") or target.startswith("wss://") or target.startswith("/")):
            return {
                "ok": False,
                "message": "endpoint 需为 ws://、wss:// 或 /ws/ 路径",
                "latencyMs": 0,
            }
        return {
            "ok": True,
            "message": "WebSocket 源已登记（推送接收模式）",
            "latencyMs": 0,
            "detail": {"mode": "push", "target": target},
        }

    def push(self, rows: List[Any], label: str = "ws:push") -> IngestResult:
        """接收一条/一批推送数据并走统一质检。"""
        if not isinstance(rows, list):
            rows = [rows]
        return pipeline.run_ingest(self.source, label, rows)


# 供路由按 kind 分派的注册表
ADAPTER_REGISTRY = {
    "rest": RestAdapter,
    "db": DbAdapter,
    "ws": WsAdapter,
}
