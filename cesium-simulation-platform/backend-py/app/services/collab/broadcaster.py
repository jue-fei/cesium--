"""
collab/broadcaster.py —— 协作事件广播（3.2.2）

按**场景**分频道的进程内广播器：写操作成功落审计后（audit_log.append），把该操作
以协作事件投递给 /ws/collab?scenario=<名> 的全部订阅终端，实现"多端操作实时可见"。

跨线程投递：写路由跑在 FastAPI threadpool，WS 广播协程跑在事件循环 → 用
`asyncio.run_coroutine_threadsafe` 把广播投递到主循环（主循环引用在首个订阅者
连接时捕获）。无订阅者 / 无主循环 / 投递异常一律**静默丢弃，绝不阻断业务**。

帧协议（契约 shared-consistency-baseline.json#collabCmps）：
  server→client：{type:'collab_event', data:{id,ts,actor,clientId,action,scenario,summary,ok}}
                 {type:'hello', clientId}
  client→server：{type:'ping'} → 回 {type:'pong'}
"""
import asyncio
import json
import logging
from collections import defaultdict

logger = logging.getLogger(__name__)

# 协作事件载荷键（与审计记录取交集；契约 collabCmps.eventKeys 据此锁定）
EVENT_FIELDS = ("id", "ts", "actor", "clientId", "action", "scenario", "summary", "ok")


class CollabBroadcaster:
    """场景 → 订阅连接池；同步 publish 入口给业务线程调用。"""

    def __init__(self):
        self._subs: dict[str, set] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, ws, scenario: str) -> None:
        await ws.accept()
        self._subs[scenario].add(ws)
        # 捕获运行中的主事件循环，供业务线程跨线程投递
        self._loop = asyncio.get_running_loop()

    def disconnect(self, ws, scenario: str) -> None:
        subs = self._subs.get(scenario)
        if subs:
            subs.discard(ws)
            if not subs:
                self._subs.pop(scenario, None)

    def subscriber_count(self, scenario: str | None = None) -> int:
        if scenario is None:
            return sum(len(s) for s in self._subs.values())
        return len(self._subs.get(scenario, ()))

    def publish(self, scenario: str | None, record: dict, event_type: str = "collab_event") -> None:
        """同步入口（业务线程调用）：投递协作事件；无订阅/无循环则静默返回。"""
        if not scenario or not self._subs.get(scenario):
            return
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        payload = {"type": event_type, "data": {k: record.get(k) for k in EVENT_FIELDS}}
        text = json.dumps(payload, ensure_ascii=False)
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast(scenario, text), loop)
        except Exception:  # noqa: BLE001 —— 投递失败不得阻断业务
            logger.warning("[collab] 协作事件投递失败 scenario=%s", scenario)

    async def _broadcast(self, scenario: str, text: str) -> None:
        subs = self._subs.get(scenario)
        if not subs:
            return
        dead = []
        for ws in list(subs):
            try:
                await ws.send_text(text)
            except Exception:  # 连接已关闭/异常
                dead.append(ws)
        for ws in dead:
            subs.discard(ws)
        if not subs:
            self._subs.pop(scenario, None)


# 全局单例（应用级共享，与 /ws/collab 端点、audit_log 消费方共用）
mgr = CollabBroadcaster()


def publish(scenario: str | None, record: dict) -> None:
    """模块级便捷入口（audit_log 调用，可被测试 monkeypatch）。"""
    mgr.publish(scenario, record)
