"""联动动作注册表（方案 WP2 T2.5 / T2.5b）

约定：
- 动作只做"改后端状态 + 广播动作指令"，不做任何 UI 决策；
- 返回值统一为 `{"status": ok|skipped|failed, "message": str, ...}`；
- 前端收到 `fusion:action` 后自行决定如何刷新视图。

新增动作时：
1. 在 `ACTIONS` 注册；
2. 在 `config/twin_rules.json` 的 `then.action` 中引用；
3. 补一条 `tests/test_twin_fusion.py` 用例。
"""
import logging
import time
from typing import Any, Callable, Dict, Optional

from app.services.fusion.bus import bus
from app.services.scheduling.geometry import segments_in_zone

logger = logging.getLogger(__name__)

ActionResult = Dict[str, Any]

# 采纳记录只保留最近 N 条（演示与复核用，后续由 WP6 落库替换）
_ADOPTION_LOG: list[Dict[str, Any]] = []
_ADOPTION_LIMIT = 50


def _ok(message: str, **extra: Any) -> ActionResult:
    return {"status": "ok", "message": message, **extra}


def _skipped(message: str, **extra: Any) -> ActionResult:
    return {"status": "skipped", "message": message, **extra}


def _failed(message: str, **extra: Any) -> ActionResult:
    return {"status": "failed", "message": message, **extra}


def broadcast_action(action: str, payload: Optional[Dict[str, Any]] = None) -> None:
    """向所有前端订阅者下发动作指令（不落库、不触发规则）。"""
    bus.publish(
        "fusion:action",
        "twin",
        {"action": action, "payload": payload or {}},
        source="rule",
        persist=False,
    )


def _inject_blastpile(event: Dict[str, Any], params: Dict[str, Any]) -> ActionResult:
    """R4：爆破事件完成 → 注入其**绑定的**采场装载点。

    注入目标必须可追溯（不造数）：
      1. payload.pile.pileId 显式指定（人工/调试）；
      2. 否则按 eventId 反查 scheduling_muck_task.blast_event_id；
      3. 两者都没有 → skipped，**绝不默认落到某个采场**。

    payload 约定：
        {"scenario": "ashale", "eventId": "BLAST-2026-004",
         "blastTime": "2026-07-24T08:30:00",
         "pile": {"gradePct": ..., "bigBlockRatio": ...}}
    """
    # 延迟导入：routes.scheduling 依赖 services，顶层导入会在启动期形成环
    from app.routes.scheduling import get_simulator
    from app.services.scheduling.muck_data import find_tasks_by_blast_event

    payload = event.get("payload") or {}
    pile = payload.get("pile") or payload.get("blastPile") or payload
    scenario = payload.get("scenario") or params.get("scenario")
    event_id = payload.get("eventId") or pile.get("eventId") or ""

    pile_id = pile.get("pileId") or pile.get("id")
    if not pile_id and event_id:
        bound = find_tasks_by_blast_event(str(event_id))
        if len(bound) == 1:
            pile_id = bound[0]
        elif len(bound) > 1:
            return _skipped(
                f"爆破事件 {event_id} 绑定了多个采场 {bound}，请在 pile.pileId 指定目标"
            )

    if not pile_id:
        return _skipped(
            f"爆破事件 {event_id or '未知'} 未绑定采场，跳过注入"
            "（先用 POST /api/scheduling/bind_blast 绑定 eventId→taskId）"
        )

    sim = get_simulator(scenario)
    influx = {**pile, "pileId": pile_id, "eventId": event_id}
    injected = sim.inject_blast_pile(influx)
    if not injected:
        return _failed(f"未找到装载点 {pile_id}")

    broadcast_action(
        "haulage:refresh",
        {"pileId": pile_id, "scenario": scenario, "reason": "blastpile_injected"},
    )
    return _ok(f"爆堆 {pile_id} 已注入调度", pileId=pile_id, eventId=event_id)


def _record_adoption(event: Dict[str, Any], params: Dict[str, Any]) -> ActionResult:
    """R6：多目标方案被采纳 → 记录并存证，通知前端进入复核视图。"""
    payload = event.get("payload") or {}
    run_id = payload.get("runId") or payload.get("id")
    if not run_id:
        return _skipped("payload 缺少 runId，跳过记录")

    record = {
        "runId": run_id,
        "solutionId": payload.get("solutionId"),
        "objectives": payload.get("objectives") or {},
        "adoptedAt": time.time(),
    }
    _ADOPTION_LOG.append(record)
    if len(_ADOPTION_LOG) > _ADOPTION_LIMIT:
        del _ADOPTION_LOG[: len(_ADOPTION_LOG) - _ADOPTION_LIMIT]

    broadcast_action("optimization:review", record)
    return _ok(f"方案 {run_id} 已记录并进入复核", runId=run_id)


def _block_from_zone(event: Dict[str, Any], params: Dict[str, Any]) -> ActionResult:
    """R3：爆破危险区 → 巷道封锁（T2.5b）。

    payload 约定（与 PUT /api/scheduling/blocks/from-zone 一致）：
        {"scenario": "ashale",
         "zone": {"polygon": [[x, z], ...], "elevationRange": [lo, hi],
                  "reason": "爆破振动超限", "source": "blasting",
                  "expireAt": <epoch 秒，可选>}}
    判定口径：巷道折线 XZ 投影 × 多边形，叠加标高区间，见 scheduling/geometry.py。
    """
    # 延迟导入：routes.scheduling 顶层导入了本模块的 broadcast_action
    from app.routes.scheduling import get_simulator

    payload = event.get("payload") or {}
    zone = payload.get("zone") or payload
    polygon = zone.get("polygon") or []
    if len(polygon) < 3:
        return _skipped("zone.polygon 至少需要 3 个点")

    scenario = payload.get("scenario") or params.get("scenario")
    sim = get_simulator(scenario)
    hits = segments_in_zone(sim.segment_geo, polygon, zone.get("elevationRange"))
    if not hits:
        return _skipped("危险区未与任何巷道段相交")

    reason = zone.get("reason") or "爆破危险区"
    source = zone.get("source") or "blasting"
    expire_at = zone.get("expireAt")
    for seg_id in hits:
        sim.set_external_block(seg_id, source=source, reason=reason, expire_at=expire_at)

    broadcast_action(
        "haulage:segments-blocked",
        {"segIds": hits, "scenario": scenario, "reason": reason},
    )
    return _ok(f"已封锁 {len(hits)} 段巷道", segIds=hits)


def _record_scheduling_kpi(event: Dict[str, Any], params: Dict[str, Any]) -> ActionResult:
    """R5：调度推进 → 采样 KPI 并落时序（方案 WP5 T5.7）。

    只提取快照里真实存在的字段（设备状态/存量/品位/封锁段/危险指数），
    拿不到的指标不造数（字典中标记为 manual，待对应工序接入）。
    """
    # 延迟导入：routes.scheduling 顶层导入了本模块的 broadcast_action
    from app.routes.scheduling import get_simulator
    from app.services.twin import kpi

    payload = event.get("payload") or {}
    scenario = payload.get("scenario") or params.get("scenario")
    sim = get_simulator(scenario)

    values = kpi.extract_from_snapshot(sim.snapshot())
    written = kpi.record(values, tags={"scenario": scenario or "ashale"})
    if written == 0:
        return _skipped("KPI 未写入（数据库不可用或无有效字段）")
    return _ok(f"已采样 {written} 项 KPI", count=written)


def _noop(event: Dict[str, Any], params: Dict[str, Any]) -> ActionResult:
    """占位动作：规则已定义但联动尚未接线（R1/R2/R3/R5 的阶段性状态）。"""
    return _skipped(f"动作 {params.get('action') or 'noop'} 尚未接线")


def list_adoptions() -> list[Dict[str, Any]]:
    """供 /api/twin/adoptions 查询（WP6 T6.2 的临时内存版）。"""
    return list(_ADOPTION_LOG)


ACTIONS: Dict[str, Callable[[Dict[str, Any], Dict[str, Any]], ActionResult]] = {
    "scheduling.inject_blastpile": _inject_blastpile,
    "scheduling.block_from_zone": _block_from_zone,
    "kpi.record_scheduling": _record_scheduling_kpi,
    "twin.record_adoption": _record_adoption,
    "twin.noop": _noop,
}


def run_action(name: str, event: Dict[str, Any], params: Optional[Dict[str, Any]] = None) -> ActionResult:
    """执行动作并吞掉异常：单条动作失败不得阻断事件流。"""
    handler = ACTIONS.get(name)
    if handler is None:
        return _failed(f"未知动作 {name}")
    try:
        return handler(event, params or {})
    except Exception as exc:  # noqa: BLE001 - 动作失败需降级为结果，不向外抛
        logger.warning("联动动作 %s 执行异常：%s", name, exc, exc_info=True)
        return _failed(f"动作执行异常：{exc}")
