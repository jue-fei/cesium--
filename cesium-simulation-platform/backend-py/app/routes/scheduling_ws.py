"""
现场调度实时数据推送 WebSocket 端点

客户端连接后，服务端按固定节流周期（默认 5 分钟）持续推送当前调度状态快照，
并同步推进共享仿真器（与实际连续出矿节奏一致）。

客户端->服务端文本帧：
    {"type": "ping", "t": ...}
    {"type": "set_interval", "seconds": 2.0}   # 调整推送节流

服务端->客户端文本帧：
    {"type": "snapshot", "data": {...}}          # 完整调度状态快照
    {"type": "pong", "t": ...}
    {"type": "stale_error", "message": ...}
"""
import asyncio
import json
import logging
from collections import defaultdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.routes.scheduling import get_simulator

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_INTERVAL_S = 300.0  # 默认每 5 分钟推送一条信息
HEARTBEAT_TIMEOUT_S = 60.0


class SchedulingStreamManager:
    def __init__(self):
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        self._channels: set[str] = set()

    async def connect(self, ws: WebSocket, channel: str) -> None:
        await ws.accept()
        self._subs[channel].add(ws)
        self._channels.add(channel)

    def disconnect(self, ws: WebSocket, channel: str) -> None:
        subs = self._subs.get(channel)
        if subs:
            subs.discard(ws)
            if not subs:
                self._subs.pop(channel, None)

    def has_subscribers(self, channel: str) -> bool:
        return bool(self._subs.get(channel))

    def active_count(self) -> int:
        return sum(len(s) for s in self._subs.values())


mgr = SchedulingStreamManager()


@router.websocket("/ws/scheduling/stream")
async def scheduling_stream(ws: WebSocket, channel: str = "main", scenario: str = "ashale"):
    """调度状态实时推送流。
    channel 缺省为 main，多客户端共享同一仿真状态流；
    scenario 指定场景（config/scenario_<名>.json），缺省 ashale。
    """
    await mgr.connect(ws, channel)
    interval = DEFAULT_INTERVAL_S
    sim = get_simulator(scenario)
    # 连接即推一帧，前端立即有数据
    await ws.send_text(json.dumps({"type": "snapshot", "data": sim.snapshot()}, ensure_ascii=False))
    try:
        listener_task = asyncio.create_task(_tick_broadcast(ws, interval, sim))
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=HEARTBEAT_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.info("[SchedWS] heartbeat timeout channel=%s, closing", channel)
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
                secs = float(msg.get("seconds", DEFAULT_INTERVAL_S))
                if 0.5 <= secs <= 30:
                    interval = secs
                    listener_task.cancel()
                    time_based = interval
                    listener_task = asyncio.create_task(_tick_broadcast(ws, time_based))
                    await ws.send_text(json.dumps({"type": "interval", "seconds": interval}))
            else:
                await ws.send_text(json.dumps({"type": "stale_error", "message": f"unknown type: {ctype}"}))
    except WebSocketDisconnect:
        logger.info("[SchedWS] client disconnected channel=%s", channel)
    except Exception:
        logger.exception("[SchedWS] unexpected error channel=%s", channel)
    finally:
        listener_task.cancel()
        mgr.disconnect(ws, channel)


async def _tick_broadcast(ws: WebSocket, interval: float, sim):
    """定时推进仿真并推送快照。每帧代表 interval 秒的仿真时间。"""
    try:
        while True:
            await asyncio.sleep(interval)
            snapshot = _advance_and_push(sim, interval)
            await ws.send_text(json.dumps({"type": "snapshot", "data": snapshot}, ensure_ascii=False))
    except asyncio.CancelledError:
        raise


def _advance_and_push(sim, seconds):
    # 每个推送周期推进 seconds 秒仿真：连续多步，保证一整段的装备/爆堆/环境演进后发一帧
    for _ in range(max(1, int(seconds) // sim.dt)):
        sim.tick()
    return sim.snapshot()