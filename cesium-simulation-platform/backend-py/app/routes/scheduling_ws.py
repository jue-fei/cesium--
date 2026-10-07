"""
现场调度实时数据推送 WebSocket 端点

客户端连接后，服务端按固定节流周期（默认 5 分钟）持续推送当前调度状态快照，
并同步推进共享仿真器（与实际连续出矿节奏一致）。

3.2.4 多终端修复：推进循环对每个 (场景, 频道) **全局唯一**。
原实现每来一个连接就各起一个推进循环、共同推进同一共享仿真器——N 个终端在线时
仿真时间被 N 倍加速。现改为「单一推进循环采集一次快照 → 广播给该频道全部订阅者」，
且无订阅者时停止推进（不空转）。tick 时按需重新解析仿真器实例，故 /api/scheduling/reset
替换实例后推进自动跟随（不会继续推进被替换的旧实例）。

客户端->服务端文本帧：
    {"type": "ping", "t": ...}
    {"type": "set_interval", "seconds": 2.0}   # 调整本 (场景,频道) 节流（全订阅者共享）

服务端->客户端文本帧：
    {"type": "snapshot", "data": {...}}          # 完整调度状态快照（广播）
    {"type": "pong", "t": ...}
    {"type": "interval", "seconds": ...}
    {"type": "stale_error", "message": ...}
"""
import asyncio
import json
import logging
from collections import defaultdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.routes.scheduling import get_simulator
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_INTERVAL_S = 300.0  # 默认每 5 分钟推送一条信息
HEARTBEAT_TIMEOUT_S = 60.0
MIN_INTERVAL_S = 0.5
MAX_INTERVAL_S = 30.0

ChannelKey = tuple[str, str]  # (scenario, channel)


def _clamp_interval(value) -> float | None:
    """节流区间钳制到 [MIN, MAX]；非法/非正值返回 None（调用方保持原值）。"""
    try:
        secs = float(value)
    except (TypeError, ValueError):
        return None
    if secs <= 0:
        return None
    return min(MAX_INTERVAL_S, max(MIN_INTERVAL_S, secs))


def _channel_key(scenario: str, channel: str) -> ChannelKey:
    """(场景, 频道) 复合键：不同场景/频道的推进与广播彼此隔离。"""
    return (scenario or DEFAULT_SCENARIO, channel or "main")


class SchedulingStreamManager:
    """(场景, 频道) → 订阅连接池 + **单一**推进循环。

    推进循环唯一：无论该频道有多少订阅者，都只由一个 ticker 推进共享仿真器并广播，
    从根本上消除"多终端各自推进 → 仿真时间成倍加速"。
    """

    def __init__(self):
        self._subs: dict[ChannelKey, set[WebSocket]] = defaultdict(set)
        self._tasks: dict[ChannelKey, asyncio.Task] = {}
        self._intervals: dict[ChannelKey, float] = {}

    async def connect(self, ws: WebSocket, key: ChannelKey) -> None:
        await ws.accept()
        self._subs[key].add(ws)

    def disconnect(self, ws: WebSocket, key: ChannelKey) -> None:
        subs = self._subs.get(key)
        if subs:
            subs.discard(ws)
            if not subs:
                self._subs.pop(key, None)
                self.stop_ticker(key)  # 无订阅者 → 停止推进（不空转）

    def has_subscribers(self, key: ChannelKey) -> bool:
        return bool(self._subs.get(key))

    def subscriber_count(self, key: ChannelKey | None = None) -> int:
        if key is None:
            return sum(len(s) for s in self._subs.values())
        return len(self._subs.get(key, ()))

    def active_count(self) -> int:
        """全部频道订阅者总数（兼容旧调用名）。"""
        return self.subscriber_count()

    def ticker_running(self, key: ChannelKey) -> bool:
        task = self._tasks.get(key)
        return bool(task and not task.done())

    def interval_of(self, key: ChannelKey) -> float:
        return self._intervals.get(key, DEFAULT_INTERVAL_S)

    def set_interval(self, key: ChannelKey, seconds) -> float:
        secs = _clamp_interval(seconds)
        if secs is not None:
            self._intervals[key] = secs
        return self.interval_of(key)

    async def broadcast(self, key: ChannelKey, text: str) -> None:
        """向该频道全部订阅者广播文本帧，自动清理失效连接。"""
        subs = self._subs.get(key)
        if not subs:
            return
        dead: list[WebSocket] = []
        for ws in list(subs):
            try:
                await ws.send_text(text)
            except Exception:  # 连接已关闭或异常
                dead.append(ws)
        for ws in dead:
            subs.discard(ws)
        if not subs:
            self._subs.pop(key, None)
            self.stop_ticker(key)

    def ensure_ticker(self, key: ChannelKey, sim_provider) -> None:
        """确保该频道有且仅有一个推进循环（幂等）。"""
        if self.ticker_running(key):
            return
        self._tasks[key] = asyncio.create_task(self._ticker(key, sim_provider))

    def stop_ticker(self, key: ChannelKey) -> None:
        task = self._tasks.pop(key, None)
        if task and not task.done():
            task.cancel()

    async def tick_once(self, key: ChannelKey, sim) -> None:
        """推进一次共享仿真器并广播快照（单一来源，多订阅者共享同一帧）。"""
        interval = self.interval_of(key)
        # 注意 sim.dt 为 float：须整体取整（`int(interval) // sim.dt` 会得到 float，
        # range() 直接 TypeError ——原实现即踩此坑，推进循环每帧崩溃）
        for _ in range(max(1, int(interval // sim.dt))):
            sim.tick()
        text = json.dumps({"type": "snapshot", "data": sim.snapshot()}, ensure_ascii=False)
        await self.broadcast(key, text)

    async def _ticker(self, key: ChannelKey, sim_provider) -> None:
        try:
            while True:
                await asyncio.sleep(self.interval_of(key))
                # 按需重新解析仿真器实例：/api/scheduling/reset 替换实例后自动跟随
                await self.tick_once(key, sim_provider())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 —— 推进异常不致命，记录后结束本频道循环
            logger.exception("[SchedWS] 推进循环异常 key=%s", key)
        finally:
            self._tasks.pop(key, None)


mgr = SchedulingStreamManager()


@router.websocket("/ws/scheduling/stream")
async def scheduling_stream(ws: WebSocket, channel: str = "main", scenario: str = DEFAULT_SCENARIO):
    """调度状态实时推送流。

    多客户端共享同一 (场景, 频道) 的**单一推进循环 + 广播**：连接即推首帧，
    之后由该频道唯一 ticker 周期推进仿真并广播快照（多终端在线不再成倍加速）。
    """
    key = _channel_key(scenario, channel)
    await mgr.connect(ws, key)
    sim = get_simulator(key[0])
    # 连接即推一帧，前端立即有数据
    await ws.send_text(json.dumps({"type": "snapshot", "data": sim.snapshot()}, ensure_ascii=False))
    mgr.ensure_ticker(key, lambda: get_simulator(key[0]))
    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=HEARTBEAT_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.info("[SchedWS] heartbeat timeout key=%s, closing", key)
                await ws.close(code=1001, reason="heartbeat timeout")
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "stale_error", "message": "invalid JSON"}))
                continue
            ctype = msg.get("type")
            if ctype == "ping":
                await ws.send_text(json.dumps({"type": "pong", "t": msg.get("t")}))
            elif ctype == "set_interval":
                secs = mgr.set_interval(key, msg.get("seconds"))
                await ws.send_text(json.dumps({"type": "interval", "seconds": secs}))
            else:
                await ws.send_text(json.dumps({"type": "stale_error", "message": f"unknown type: {ctype}"}))
    except WebSocketDisconnect:
        logger.info("[SchedWS] client disconnected key=%s", key)
    except Exception:
        logger.exception("[SchedWS] unexpected error key=%s", key)
    finally:
        mgr.disconnect(ws, key)
