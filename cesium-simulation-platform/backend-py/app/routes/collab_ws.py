"""
协作事件实时推送 WebSocket 端点（3.2.2 · 跨终端协同）

/ws/collab?scenario=<场景名>&clientId=<终端id>：订阅该场景的协作事件。
任一终端完成写操作（落审计）后，后端把该操作广播给同场景的全部订阅终端，
实现"多端操作实时可见"。

帧协议（契约见 shared-consistency-baseline.json#collabCmps）：
  server→client：
    {type:'hello', clientId}                       连接即回，回显解析后的终端 id
    {type:'collab_event', data:{id,ts,actor,clientId,action,scenario,summary,ok}}
    {type:'pong', t} / {type:'error', message}
  client→server：
    {type:'ping', t}                               心跳（服务端 60s 无消息兜底断连）
    {type:'hello'}                                 重握手

与其他 WS 频道互补：/ws/scheduling（快照+仿真推进）、/ws/realtime（工况遥测）、
/ws/blasting（爆破事件流）；本频道只推"跨终端操作留痕"。
"""
import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.collab.broadcaster import mgr
from app.services.collab.identity import parse_identity
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO

logger = logging.getLogger(__name__)

router = APIRouter(tags=["跨终端协同"])

HEARTBEAT_TIMEOUT_S = 60.0


def _hello(client_id: str) -> str:
    return json.dumps({"type": "hello", "clientId": client_id}, ensure_ascii=False)


@router.websocket("/ws/collab")
async def collab_stream(
    ws: WebSocket,
    scenario: str = DEFAULT_SCENARIO,
    clientId: str = "",
):
    """协作事件订阅流：连接即握手，期间接收本场景写操作广播。"""
    ident = parse_identity(clientId)
    await mgr.connect(ws, scenario)
    logger.info("[CollabWS] client subscribed scenario=%s clientId=%s",
                scenario, ident["clientId"])
    try:
        await ws.send_text(_hello(ident["clientId"]))
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=HEARTBEAT_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.info("[CollabWS] heartbeat timeout scenario=%s, closing", scenario)
                await ws.close(code=1001, reason="heartbeat timeout")
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "message": "invalid JSON"}))
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_text(json.dumps({"type": "pong", "t": msg.get("t")}, ensure_ascii=False))
            elif mtype == "hello":
                await ws.send_text(_hello(ident["clientId"]))
            # 未知类型忽略（向前兼容）
    except WebSocketDisconnect:
        logger.info("[CollabWS] client disconnected scenario=%s", scenario)
    except Exception:  # noqa: BLE001 —— 断连/取消统一走 finally 清理
        logger.exception("[CollabWS] unexpected error scenario=%s", scenario)
    finally:
        mgr.disconnect(ws, scenario)
