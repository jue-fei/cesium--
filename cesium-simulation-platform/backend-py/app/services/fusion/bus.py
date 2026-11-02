"""进程内孪生事件总线（WP2 T2.2）

职责边界：
- 后端是唯一事件权威（方案 P0-2）：`seq` 只在这里分配，前端不可指定。
- 环形缓冲最近 `BUFFER_CAPACITY` 条事件，供 WebSocket 断线重放。
- 订阅者用 asyncio.Queue 承接；publish 可能发生在 FastAPI 线程池线程，
  必须经 `loop.call_soon_threadsafe` 投递，不能直接 `queue.put_nowait`。
- 持久化是旁路：失败只降级告警，绝不影响分发（见 store.py）。
"""
import asyncio
import logging
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional

from app.services.fusion import store
from app.services.fusion.contracts import build_event

logger = logging.getLogger(__name__)

# 断线重放窗口：1000 条 ≈ 演示场景下数分钟的完整联动轨迹
BUFFER_CAPACITY = 1000

# 单订阅者积压上限；超限丢最旧，保证慢消费者不拖垮总线
SUB_QUEUE_SIZE = 500


class _Subscriber:
    """一个 WebSocket 订阅者。loop 用于跨线程安全投递。"""

    __slots__ = ("queue", "loop")

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=SUB_QUEUE_SIZE)
        self.loop = loop

    def push(self, data: Dict[str, Any]) -> bool:
        """跨线程投递；返回是否成功入队。"""
        def _put() -> None:
            try:
                self.queue.put_nowait(data)
            except asyncio.QueueFull:
                # 丢最旧一条再入队：宁可丢历史，不可阻塞发布方
                try:
                    self.queue.get_nowait()
                    self.queue.put_nowait(data)
                except Exception:  # noqa: BLE001 - 队列竞态可忽略
                    pass

        try:
            self.loop.call_soon_threadsafe(_put)
            return True
        except RuntimeError:
            # 事件循环已关闭（前端断开后仍在收尾）
            return False


class TwinEventBus:
    """线程安全的事件总线单例。"""

    def __init__(self, capacity: int = BUFFER_CAPACITY):
        self._buffer: Deque[Dict[str, Any]] = deque(maxlen=capacity)
        self._subscribers: List[_Subscriber] = []
        self._seq = 0
        self._lock = threading.Lock()
        self._published = 0
        self._persisted = 0

    # ---------- 发布 ----------
    def publish(
        self,
        event_type: str,
        proc: str,
        payload: Optional[Dict[str, Any]] = None,
        ts: Optional[float] = None,
        source: str = "api",
        persist: bool = True,
    ) -> Dict[str, Any]:
        """发布事件：分配 seq → 入缓冲 → 分发 → 旁路落库。"""
        with self._lock:
            self._seq += 1
            seq = self._seq

        event = build_event(
            event_type=event_type,
            proc=proc,
            payload=payload,
            ts=ts if ts is not None else time.time(),
            source=source,
            seq=seq,
        )

        self._buffer.append(event)
        self._published += 1
        self._dispatch(event)

        # 旁路落库：只记录有业务价值的事件，高频 tick 由调用方传 persist=False
        if persist and store.persist_event(event):
            self._persisted += 1

        return event

    def _dispatch(self, event: Dict[str, Any]) -> None:
        """向全部订阅者分发；死订阅者顺手清理。"""
        dead: List[_Subscriber] = []
        for sub in self._subscribers:
            if not sub.push(event):
                dead.append(sub)
        for sub in dead:
            self.unsubscribe(sub)

    # ---------- 订阅 ----------
    def subscribe(self, loop: asyncio.AbstractEventLoop) -> _Subscriber:
        sub = _Subscriber(loop)
        self._subscribers.append(sub)
        return sub

    def unsubscribe(self, sub: _Subscriber) -> None:
        try:
            self._subscribers.remove(sub)
        except ValueError:
            pass

    # ---------- 查询 ----------
    def history(self, since_seq: int = 0, limit: int = 200) -> List[Dict[str, Any]]:
        """取 `seq > since_seq` 的最近 limit 条（用于重放）。"""
        limit = max(1, min(int(limit or 200), BUFFER_CAPACITY))
        with self._lock:
            items = [e for e in self._buffer if int(e.get("seq") or 0) > since_seq]
        return items[-limit:]

    def last_seq(self) -> int:
        with self._lock:
            return self._seq

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "seq": self._seq,
                "published": self._published,
                "persisted": self._persisted,
                "bufferSize": len(self._buffer),
                "subscribers": len(self._subscribers),
                "capacity": self._buffer.maxlen,
            }


# 进程级单例：路由、规则引擎、调度动作共享同一个总线
bus = TwinEventBus()
