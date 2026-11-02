"""孪生融合事件接口（方案 WP2 T2.0 / T2.2）

HTTP
    POST /api/twin/events        上报事件（写接口，需 x-api-token，未配置时放行）
    GET  /api/twin/events        历史事件（按 seq 增量拉取，供回放/补数）
    GET  /api/twin/rules         规则清单与命中统计
    GET  /api/twin/health        总线状态
    GET  /api/twin/adoptions     方案采纳记录（WP6 临时内存版）

WebSocket
    /ws/twin/events?since_seq=0  先重放缓冲，再推送实时事件

约定：`seq` 一律由后端总线分配，请求体中的 seq 会被忽略。
"""
import asyncio
import logging
import time
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Body, Depends, Query, WebSocket, WebSocketDisconnect

from app.security import require_token
from app.services.fusion.actions import list_adoptions
from app.services.fusion.bus import bus
from app.services.fusion.contracts import TwinEventIn, validate_payload_size, validate_proc
from app.services.fusion.rules import engine
from app.services.twin import kpi as kpi_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["孪生融合"])

# 进程启动时刻：用于时钟接口上报 uptime，便于排查“时钟倒退/重启”
_STARTED_AT = time.time()


# ─── HTTP ──────────────────────────────────────────────────
@router.post("/api/twin/events", dependencies=[Depends(require_token)])
def publish_event(body: TwinEventIn = Body(..., description="孪生事件")):
    """上报一条孪生事件：写入总线 → 规则求值 → 返回命中结果。

    前端在"数据就绪"或"工序完成"时调用；外部系统也可直接 POST。
    """
    try:
        validate_proc(body.proc)
        validate_payload_size(body.payload)
    except ValueError as exc:
        return {"code": 400, "message": str(exc)}

    event = bus.publish(
        event_type=body.type,
        proc=body.proc,
        payload=body.payload,
        ts=body.ts,
        source=body.source or "api",
    )
    results = engine.handle(event)
    return {"code": 0, "data": {"event": event, "matches": results}}


@router.get("/api/twin/events")
def list_events(
    since_seq: int = Query(0, ge=0, description="只返回 seq 大于该值的事件"),
    limit: int = Query(200, ge=1, le=1000),
):
    """按序号增量拉取事件（用于轮询模式或补数）。"""
    return {"code": 0, "data": {"events": bus.history(since_seq, limit), "lastSeq": bus.last_seq()}}


@router.get("/api/twin/rules")
def list_rules():
    """规则清单与命中统计（调试与测评举证用）。"""
    return {"code": 0, "data": engine.describe()}


@router.get("/api/twin/health")
def twin_health():
    """总线健康状况：序号、缓冲、订阅数、落库计数。"""
    return {"code": 0, "data": bus.stats()}


@router.get("/api/twin/clock")
def twin_clock():
    """服务端时钟基准（方案 T3.4）。

    前端用 (t0, t1) 往返采样估算偏斜：skew = serverTime - (t0 + t1) / 2，
    后续所有回放对准都以校正后的统一历元为真值。
    """
    now = time.time()
    return {
        "code": 0,
        "data": {
            "serverTime": now,
            "iso": datetime.now().isoformat(timespec="seconds"),
            "timezone": "UTC+8",
            "uptime": round(now - _STARTED_AT, 3),
            "lastSeq": bus.last_seq(),
        },
    }


@router.get("/api/twin/adoptions")
def adoption_list():
    """已采纳的多目标方案记录（内存版，重启清空；WP6 落库后替换）。"""
    return {"code": 0, "data": {"adoptions": list_adoptions()}}


# ─── KPI（方案 WP5 T5.2 / T5.7）─────────────────────────────
@router.get("/api/twin/kpi/defs")
def kpi_defs():
    """KPI 字典：12 项核心指标（单位/工序/聚合方式/来源）。"""
    return {"code": 0, "data": {"defs": kpi_service.list_defs()}}


@router.get("/api/twin/kpi")
def kpi_series(
    codes: str = Query("", description="逗号分隔的指标编码，缺省取自动采集项"),
    minutes: int = Query(60, ge=1, le=10080, description="回看时长（分钟）"),
    step: int = Query(60, ge=5, le=3600, description="分桶步长（秒）"),
):
    """KPI 时序：按 step 分桶聚合（累计量取差分，瞬时量按字典的 avg/max/sum）。"""
    selected = [c.strip() for c in codes.split(",") if c.strip()] or None
    return {"code": 0, "data": kpi_service.query(selected, minutes, step)}


@router.get("/api/twin/kpi/latest")
def kpi_latest(codes: str = Query("", description="逗号分隔的指标编码")):
    """每项 KPI 的最新值（驾驶舱卡片用）。"""
    selected = [c.strip() for c in codes.split(",") if c.strip()] or None
    return {"code": 0, "data": kpi_service.latest(selected)}


@router.post("/api/twin/kpi/record", dependencies=[Depends(require_token)])
def kpi_record(body: dict = Body(..., description="{values:{code:value}, ts?, tags?}")):
    """手工/外部写入 KPI（如爆破单耗、PPV 由外部系统计算后回传）。"""
    raw = body.get("values") if isinstance(body.get("values"), dict) else body
    values = {}
    for key, val in (raw or {}).items():
        if str(key) in ("ts", "tags"):
            continue
        try:
            values[str(key)] = float(val)
        except (TypeError, ValueError):
            continue
    if not values:
        return {"code": 1, "message": "没有可写入的数值"}

    written = kpi_service.record(
        values,
        ts=body.get("ts"),
        tags=body.get("tags") if isinstance(body.get("tags"), dict) else None,
    )
    return {"code": 0 if written else 1, "data": {"written": written}}


# ─── WebSocket ─────────────────────────────────────────────
@router.websocket("/ws/twin/events")
async def twin_events_ws(
    websocket: WebSocket,
    since_seq: int = Query(0, ge=0, description="从该序号之后开始重放"),
):
    """订阅孪生事件流：先重放历史，再实时推送。

    客户端职责：按 `seq` 去重（断线重连时可能收到重复边界），
    并对 `fusion:action` 执行本地动作。
    """
    await websocket.accept()
    sub = bus.subscribe(asyncio.get_running_loop())

    async def _send_loop() -> None:
        # 先重放，保证断线期间的事件不丢
        for event in bus.history(since_seq, limit=500):
            await websocket.send_json({"kind": "event", "event": event})
        await websocket.send_json({"kind": "ready", "lastSeq": bus.last_seq()})

        while True:
            event = await sub.queue.get()
            await websocket.send_json({"kind": "event", "event": event})

    async def _recv_loop() -> None:
        # 只处理心跳；其余消息暂不接收（事件上报走 HTTP，保持单一入口）
        while True:
            message = await websocket.receive_json()
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"kind": "pong", "t": message.get("t")})

    try:
        await asyncio.gather(_send_loop(), _recv_loop())
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 - 连接异常不对外抛，避免污染日志
        logger.info("孪生事件流断开：%s", exc)
    finally:
        bus.unsubscribe(sub)
