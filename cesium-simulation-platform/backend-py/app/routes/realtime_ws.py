"""全域实时推送（统一频道 /ws/realtime/{scope}）

帧协议（契约见 shared-consistency-baseline.json#realtimeWsCmps）：
  server→client JSON 帧：
    {type:'telemetry', seq, ts, source, scope, equipment:[...], fleet:{...}}
    {type:'pong', ts}
    {type:'error', message}
  client→server JSON 帧：
    {type:'ping'}                      → 回 pong（服务端 receive 超时 60s 兜底断连）
    {type:'set_interval', interval:S}  → 调整推送间隔（0.5~30s 钳制）

与 /ws/scheduling（快照+仿真推进）、/ws/blasting（爆破事件流）互补：
本频道只推工况遥测（设备状态 + 传感器曲线 + fleet 汇总），数据源由
TelemetryAdapter 适配（当前 SimTelemetryAdapter 模拟源，将来 MQTT 真实源
仅换适配器，协议与前端零改动）。不推进仿真、不携带地图位置（位置动画
仍由前端数据引擎驱动）。
"""
import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket

from app.services.realtime.telemetry import get_telemetry_adapter
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO
from app.routes.scheduling import get_simulator

logger = logging.getLogger(__name__)

router = APIRouter(tags=["全域实时推送"])

# 帧协议常量（单源：与 baseline#realtimeWsCmps、前端 realtimews 连接器一致）
SCOPES = ("equipment",)
DEFAULT_INTERVAL_S = 2.0
MIN_INTERVAL_S = 0.5
MAX_INTERVAL_S = 30.0
RECEIVE_TIMEOUT_S = 60.0


def _clamp_interval(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return DEFAULT_INTERVAL_S
    return min(MAX_INTERVAL_S, max(MIN_INTERVAL_S, f))


@router.websocket("/ws/realtime/{scope}")
async def realtime_stream(ws: WebSocket, scope: str, scenario: str = DEFAULT_SCENARIO):
    """统一遥测频道：scope=equipment（当前唯一）；每连接独立推送循环。"""
    if scope not in SCOPES:
        await ws.accept()
        await ws.send_json({"type": "error", "message": f"未知 scope: {scope}"})
        await ws.close(code=4404)
        return

    await ws.accept()
    adapter = get_telemetry_adapter()
    sim = get_simulator(scenario)
    seq = 0
    interval = DEFAULT_INTERVAL_S

    async def _push_frame():
        nonlocal seq
        seq += 1
        frame = adapter.get_frame(scope, sim)
        await ws.send_json({"type": "telemetry", "seq": seq, "ts": time.time(), **frame})

    try:
        # 连接即推首帧（前端连接后立即可渲染，无需等一个间隔）
        await _push_frame()
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=RECEIVE_TIMEOUT_S)
            except asyncio.TimeoutError:
                # 心跳兜底：超时未收到任何客户端消息（含 ping）→ 断连释放
                await ws.close(code=1001)
                return
            import json

            try:
                msg = json.loads(raw)
            except ValueError:
                await ws.send_json({"type": "error", "message": "非法 JSON 消息"})
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_json({"type": "pong", "ts": time.time()})
            elif mtype == "set_interval":
                interval = _clamp_interval(msg.get("interval"))
            # 未知消息类型忽略（向前兼容）

            # 每处理一条客户端消息后让出一次推送机会（间隔驱动见下）
            await _push_frame()
            await asyncio.sleep(interval)
    except Exception as e:  # noqa: BLE001 —— 断连/取消统一走 finally 清理
        logger.debug("[Realtime] 连接结束 scope=%s: %s", scope, e)
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
