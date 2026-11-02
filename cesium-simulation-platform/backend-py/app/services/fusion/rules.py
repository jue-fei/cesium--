"""规则引擎（方案 WP2 T2.4，P0-2「规则只在后端求值」）

规则文件：`config/twin_rules.json`，结构如下::

    {
      "version": 1,
      "rules": [
        {
          "id": "R4",
          "name": "爆堆→装载点",
          "enabled": true,
          "when": {"type": "blasting:event:completed"},
          "then": {"action": "scheduling.inject_blastpile", "params": {}},
          "throttleMs": 0
        }
      ]
    }

匹配规则：
- `when.type` 精确匹配；也支持 ``blasting:*`` 前缀通配；
- `fusion:action`` 类型永远不参与匹配，避免"动作 → 规则 → 动作"的递归；
- 命中后按 ``throttleMs`` 节流，节流期内的重复事件计入 ``throttled`` 但不执行。
"""
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.services.fusion.actions import run_action

logger = logging.getLogger(__name__)

# backend-py/config/twin_rules.json
DEFAULT_RULES_PATH = Path(__file__).resolve().parents[3] / "config" / "twin_rules.json"

# 热加载检查间隔（秒）：避免每个事件都 stat 一次
_RELOAD_CHECK_SECONDS = 2.0


class RuleEngine:
    """规则加载 + 求值 + 统计。线程安全（FastAPI 线程池并发调用）。"""

    def __init__(self, path: Optional[Path] = None):
        self.path = Path(path) if path else DEFAULT_RULES_PATH
        self._lock = threading.Lock()
        self._rules: List[Dict[str, Any]] = []
        self._mtime = 0.0
        self._checked_at = 0.0
        self._last_fired: Dict[str, float] = {}
        self._stats: Dict[str, Dict[str, int]] = {}
        self._load(force=True)

    # ---------- 加载 ----------
    def _load(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._checked_at < _RELOAD_CHECK_SECONDS:
            return
        self._checked_at = now

        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            if force:
                logger.warning("规则文件不存在：%s（规则引擎空转）", self.path)
            self._rules = []
            return

        if not force and mtime == self._mtime:
            return

        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            rules = data.get("rules") or []
            if not isinstance(rules, list):
                raise ValueError("rules 必须是数组")
            self._rules = [r for r in rules if isinstance(r, dict) and r.get("id")]
            self._mtime = mtime
            logger.info(
                "规则已加载：%d 条（启用 %d 条）",
                len(self._rules),
                sum(1 for r in self._rules if r.get("enabled", True)),
            )
        except Exception as exc:  # noqa: BLE001 - 配置错误不得拖垮服务
            logger.warning("规则文件解析失败，沿用上一版：%s", exc)

    # ---------- 匹配 ----------
    @staticmethod
    def _type_matches(pattern: str, event_type: str) -> bool:
        if pattern == event_type:
            return True
        if pattern.endswith("*"):
            return event_type.startswith(pattern[:-1])
        return False

    def handle(self, event: Dict[str, Any]) -> List[Dict[str, Any]]:
        """对单条事件求值，返回命中结果列表（无命中返回空列表）。"""
        event_type = str(event.get("type") or "")
        if not event_type or event_type.startswith("fusion:"):
            return []

        self._load()

        results: List[Dict[str, Any]] = []
        now = time.time()

        with self._lock:
            rules = list(self._rules)

        for rule in rules:
            if not rule.get("enabled", True):
                continue
            when = rule.get("when") or {}
            pattern = str(when.get("type") or "")
            if not pattern or not self._type_matches(pattern, event_type):
                continue

            rule_id = str(rule.get("id"))
            throttle = float(rule.get("throttleMs") or 0) / 1000.0
            last = self._last_fired.get(rule_id, 0.0)
            stat = self._stats.setdefault(rule_id, {"fired": 0, "throttled": 0, "failed": 0})

            if throttle > 0 and now - last < throttle:
                stat["throttled"] += 1
                continue

            self._last_fired[rule_id] = now
            then = rule.get("then") or {}
            action_name = str(then.get("action") or "twin.noop")
            params = then.get("params") or {}

            started = time.perf_counter()
            result = run_action(action_name, event, params)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)

            stat["fired"] += 1
            if result.get("status") == "failed":
                stat["failed"] += 1

            results.append(
                {
                    "ruleId": rule_id,
                    "name": rule.get("name") or "",
                    "action": action_name,
                    "status": result.get("status"),
                    "message": result.get("message"),
                    "elapsedMs": elapsed_ms,
                    "eventSeq": event.get("seq"),
                }
            )
            logger.info(
                "规则命中 %s → %s（%s, %.2fms）", rule_id, action_name, result.get("status"), elapsed_ms
            )

        return results

    # ---------- 查询 ----------
    def describe(self) -> Dict[str, Any]:
        self._load(force=True)
        return {
            "path": str(self.path),
            "rules": [
                {
                    "id": r.get("id"),
                    "name": r.get("name"),
                    "enabled": r.get("enabled", True),
                    "when": r.get("when") or {},
                    "then": r.get("then") or {},
                    "throttleMs": r.get("throttleMs", 0),
                    "stats": self._stats.get(str(r.get("id")), {"fired": 0, "throttled": 0, "failed": 0}),
                }
                for r in self._rules
            ],
        }


# 进程级单例
engine = RuleEngine()
