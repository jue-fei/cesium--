"""
现场调度（地下巷道铲运机 LHD）HTTP 接口

提供场景/硬约束查询与状态快照获取，供调度中心面板消费。
主动实时数据请使用 /ws/scheduling/stream（见 scheduling_ws.py）。

场景化：巷道拓扑、装载点、设备库等"可替换内容"由 config/scenario_<名>.json 驱动。
    - GET /api/scheduling/config?scenario=<名>：下发完整场景配置（前端渲染据此自动适配）
    - GET /api/scheduling/state?scenario=<名> / /ws/scheduling/stream?scenario=<名>：对应场景实时流
    缺省场景名 = ashale。
"""
import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends
from app.security import require_token
from app.services.scheduling.simulator import SchedulingSimulator
from app.services.scheduling.scenario_config import (
    load_config,
    build_scenario,
    list_scenarios,
    DEFAULT_SCENARIO,
)
from app.services.scheduling.muck_data import list_tasks_for_api, upsert_task
from app.services.scheduling.geometry import segments_in_zone
from app.services.fusion.actions import broadcast_action

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scheduling", redirect_slashes=False, tags=["现场调度"])

# 进程级共享仿真器实例池（按场景名隔离，与 WebSocket 推送共享同一状态流）
_sims: dict[str, SchedulingSimulator] = {}


def get_simulator(scenario: Optional[str] = None) -> SchedulingSimulator:
    """按场景名取（或构建）共享仿真器实例。"""
    key = scenario or DEFAULT_SCENARIO
    if key not in _sims:
        _sims[key] = SchedulingSimulator(build_scenario(load_config(key)))
        _sims[key].tick()
        _sims[key].tick()
    return _sims[key]


@router.get("/config")
def scheduling_config(scenario: Optional[str] = None):
    """下发完整场景配置（巷道拓扑 + 分层 + 装载点 + 设备库 + 前端布局 + 指标要求）。

    配置来源：数据库 scheduling_scenario 表优先，磁盘 config/scenario_<名>.json 兜底。
    前端 MultiObjectiveLhdView / TunnelMap3D 据此自动构建布局与渲染，算法按快照候选自动适配。
    """
    key = scenario or DEFAULT_SCENARIO
    cfg = load_config(key)
    return {"code": 0, "data": cfg}


@router.get("/scenarios")
def scheduling_scenarios():
    """列出全部可用场景（数据库记录优先，无库时回退扫描 config 目录）。"""
    return {"code": 0, "data": {"scenarios": list_scenarios()}}


@router.get("/muck_tasks")
def scheduling_muck_tasks(scenario: Optional[str] = None):
    """列出采矿区任务（需采矿工作量 + 块度等）。数据来源：数据库 → 爆破板块反哺 → 场景兜底。"""
    cfg = load_config(scenario or DEFAULT_SCENARIO)
    tasks = list_tasks_for_api(cfg)
    return {"code": 0, "data": {"tasks": tasks}}


@router.put("/muck_tasks/{task_id}", dependencies=[Depends(require_token)])
def update_muck_task(task_id: str, body: dict = Body(..., description="采矿区任务字段（可改工作量/品位/块度/爆破事件等）")):
    """手动编辑采矿区任务（后端输入，非死代码）。命中爆破反哺字段后下次快照生效。"""
    ok = upsert_task(task_id, body)
    if not ok:
        return {"code": 1, "message": f"写入采矿区任务 {task_id} 失败（检查数据库连接与字段）"}
    return {"code": 0, "message": f"采矿区任务 {task_id} 已更新"}


@router.get("/state")
def scheduling_state(scenario: Optional[str] = None):
    """当前调度状态快照（四类影响因素 + 装备 + 调度方案）"""
    sim = get_simulator(scenario)
    return {"code": 0, "data": sim.snapshot()}


@router.get("/scenario")
def scheduling_scenario(scenario: Optional[str] = None):
    """静态场景与硬约束基准（巷道网络、装备库、指标要求），不随时间变化"""
    sim = get_simulator(scenario)
    snap = sim.snapshot()
    cfg = load_config(scenario or DEFAULT_SCENARIO)
    indicator = cfg.get("indicatorSpecs", {})
    return {
        "code": 0,
        "data": {
            "scenario": snap["schema"]["scenario"],
            "engine": snap["schema"]["engine"],
            "hardConstraints": snap["factors"]["hardConstraints"],
            "indicatorSpecs": {
                "posErrorWorkM": indicator.get("posErrorWorkM", 0.30),
                "posErrorTravelM": indicator.get("posErrorTravelM", 0.80),
                "blockRecognitionRatePct": indicator.get("blockRecognitionRatePct", 90),
                "blockThresholdCm": indicator.get("blockThresholdCm", 10),
                "hazardZoneBiasM": indicator.get("hazardZoneBiasM", 5.0),
                "opexReductionTargetPct": indicator.get("opexReductionTargetPct", 10.0),
            },
        },
    }


@router.post("/tick")
def scheduling_tick(scenario: Optional[str] = None, n: int = 1):
    """推进 n 帧仿真并返回最新快照（便于测试/联调）。"""
    sim = get_simulator(scenario)
    for _ in range(max(1, min(n, 120))):
        sim.tick()
    return {"code": 0, "data": sim.snapshot()}


@router.post("/reset")
def scheduling_reset(scenario: Optional[str] = None):
    """重置仿真器状态。"""
    key = scenario or DEFAULT_SCENARIO
    _sims[key] = SchedulingSimulator(build_scenario(load_config(key)))
    _sims[key].tick()
    return {"code": 0, "data": _sims[key].snapshot()}


@router.post("/apply_assignment")
def scheduling_apply_assignment(
    assignments: list[dict] = Body(..., description="NSGA-III 选解：[{equipId, target, path}]"),
    scenario: Optional[str] = None,
):
    """提交前端 NSGA-III 多目标优化的选解，写入仿真器待派单队列。
    下次 _dispatch 时按该选解执行（重验通过性后），未提交的设备走贪心兜底。
    """
    sim = get_simulator(scenario)
    applied, rejected = [], []
    for a in assignments or []:
        eq_id = a.get("equipId") or a.get("id")
        target = a.get("target")
        path = a.get("path") or []
        if not eq_id or not target or not path:
            rejected.append({"equipId": eq_id, "reason": "字段缺失"})
            continue
        if not any(eq.id == eq_id for eq in sim.equip):
            rejected.append({"equipId": eq_id, "reason": "设备不存在"})
            continue
        pending = {
            "target": target, "path": list(path), "source": "nsga3", "_t": sim.t,
        }
        # 透传前端选解携带的完整路线信息（nodes/levels/代价），供返程执行与核算
        for k in ("nodes", "levels", "hops", "energyTotal", "timeMin", "hazard", "congestionSeq"):
            if a.get(k) is not None:
                pending[k] = a.get(k)
        sim.pending_assignments[eq_id] = pending
        applied.append({"equipId": eq_id, "target": target, "pathCount": len(path)})
    return {"code": 0, "data": {"applied": applied, "rejected": rejected}}


@router.post("/blastpile")
def scheduling_blastpile(
    pile: dict = Body(..., description="爆破板块爆堆信息（BlastPileInfo 契约）"),
    scenario: Optional[str] = None,
):
    """注入爆破板块产生的爆堆状态，覆盖该装载点的模拟兜底数据（多工序数据联动）。"""
    sim = get_simulator(scenario)
    ok = sim.inject_blast_pile(pile)
    if not ok:
        return {"code": 1, "message": f"未找到装载点 {pile.get('pileId') or pile.get('id')}"}
    return {"code": 0, "message": "爆堆信息已注入", "data": {"pileId": pile.get("pileId") or pile.get("id")}}


# ─── 爆破事件 ↔ 采场绑定（R4 注入目标的前置）───────────────
# 背景：爆破事件表只有爆心经纬高与爆破时间，没有采场外键；
# 采场侧的 blast_event_id 字段长期为空。若不维护绑定，R4 无法知道爆堆落到哪个采场。
@router.post("/bind_blast", dependencies=[Depends(require_token)])
def bind_blast(
    body: dict = Body(..., description="{eventId, taskId}"),
    scenario: Optional[str] = None,
):
    """把爆破事件绑定到采场任务（写 scheduling_muck_task.blast_event_id）。"""
    from app.services.scheduling.muck_data import task_exists

    event_id = str(body.get("eventId") or "").strip()
    task_id = str(body.get("taskId") or "").strip()
    if not event_id or not task_id:
        return {"code": 1, "message": "eventId/taskId 必填"}
    if not task_exists(task_id):
        return {"code": 1, "message": f"采场任务 {task_id} 不存在（先同步场景任务再绑定）"}

    ok = upsert_task(task_id, {"blast_event_id": event_id}, scenario=scenario or "")
    if not ok:
        return {"code": 1, "message": "绑定写入失败（检查数据库）"}

    broadcast_action(
        "haulage:refresh",
        {"scenario": scenario or DEFAULT_SCENARIO, "reason": "blast_binding"},
    )
    return {"code": 0, "data": {"eventId": event_id, "taskId": task_id}}


# ─── 外部封锁（方案 T2.5b / R3）────────────────────────────
# 与仿真内部自动封锁（岩爆/炮烟）分开记账：外部封锁在到期或显式解除前
# 不会被自动解除逻辑清除，见 SchedulingSimulator.set_external_block。
@router.put("/segments/{segment_id}/block", dependencies=[Depends(require_token)])
def set_segment_block(
    segment_id: str,
    body: Optional[dict] = Body(default=None, description="封锁信息 {source, reason, expireAt}"),
    scenario: Optional[str] = None,
):
    """封锁指定巷道段：expireAt 为 epoch 秒，到期后由仿真 tick 自动解除。"""
    info = body or {}
    sim = get_simulator(scenario)
    ok = sim.set_external_block(
        segment_id,
        source=info.get("source") or "api",
        reason=info.get("reason") or "外部封锁",
        expire_at=info.get("expireAt"),
    )
    if not ok:
        return {"code": 1, "message": f"未找到巷道段 {segment_id}"}

    broadcast_action(
        "haulage:segments-blocked",
        {
            "segIds": [segment_id],
            "scenario": scenario or DEFAULT_SCENARIO,
            "reason": info.get("reason") or "外部封锁",
        },
    )
    return {"code": 0, "data": {"segId": segment_id, "blocks": sim.external_block_list()}}


@router.delete("/segments/{segment_id}/block", dependencies=[Depends(require_token)])
def clear_segment_block(segment_id: str, scenario: Optional[str] = None):
    """解除指定巷道段的外部封锁（内部岩爆/炮烟风险仍在时保持封锁）。"""
    sim = get_simulator(scenario)
    ok = sim.clear_external_block(segment_id)
    if not ok:
        return {"code": 1, "message": f"巷道段 {segment_id} 无外部封锁记录"}

    broadcast_action(
        "haulage:segments-blocked",
        {"segIds": [segment_id], "scenario": scenario or DEFAULT_SCENARIO, "reason": "released"},
    )
    return {"code": 0, "data": {"segId": segment_id, "blocks": sim.external_block_list()}}


@router.get("/segments/blocks")
def list_segment_blocks(scenario: Optional[str] = None):
    """当前外部封锁台账（测评举证：谁在何时以何原因封锁了哪段）。"""
    sim = get_simulator(scenario)
    return {"code": 0, "data": {"blocks": sim.external_block_list()}}


@router.post("/blocks/from-zone", dependencies=[Depends(require_token)])
def block_from_zone(
    body: dict = Body(..., description="危险区 {zone:{polygon,elevationRange,reason,expireAt}}"),
    scenario: Optional[str] = None,
):
    """按危险区多边形批量封锁相交巷道段（R3 的 HTTP 等价入口，便于联调与人工处置）。"""
    zone = (body or {}).get("zone") or (body or {})
    polygon = zone.get("polygon") or []
    if len(polygon) < 3:
        return {"code": 1, "message": "zone.polygon 至少需要 3 个点"}

    sim = get_simulator(scenario)
    hits = segments_in_zone(sim.segment_geo, polygon, zone.get("elevationRange"))
    reason = zone.get("reason") or "爆破危险区"
    if not hits:
        return {"code": 0, "data": {"segIds": [], "message": "危险区未与任何巷道段相交"}}

    for seg_id in hits:
        sim.set_external_block(
            seg_id,
            source=zone.get("source") or "blasting",
            reason=reason,
            expire_at=zone.get("expireAt"),
        )

    broadcast_action(
        "haulage:segments-blocked",
        {"segIds": hits, "scenario": scenario or DEFAULT_SCENARIO, "reason": reason},
    )
    return {"code": 0, "data": {"segIds": hits, "blocks": sim.external_block_list()}}