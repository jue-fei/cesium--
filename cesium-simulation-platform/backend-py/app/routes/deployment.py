"""拖拽式设备部署与出矿工序顺序（3.2）HTTP 接口

GET /api/deployment?scenario=<名>：读取当前部署与工序顺序
    （真源 config/deployments/<名>.json；文件缺失返回空部署）。
PUT /api/deployment：保存部署/工序顺序并立即应用到运行中的仿真器——
    空闲设备即刻迁移到新待命点（影响空载去程与贪心派单），作业中设备
    在下次仿真重置时按文件生效；工序顺序即刻作为贪心派单偏置生效。

契约：{code: 0, data: {deployments, processOrder, applied, skipped}}；
非法设备/节点/水平返回 {code: 1, message}（不改文件、不改仿真器）。
"""
import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends

from app.routes.scheduling import get_simulator
from app.security import require_token
from app.services.audit import append as audit_append
from app.services.scheduling.deployment_store import (
    apply_deployment,
    load_deployment,
    save_deployment,
    validate_deployment,
)
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/deployment", redirect_slashes=False, tags=["设备部署"])


@router.get("")
def get_deployment(scenario: Optional[str] = None):
    """读取当前部署与出矿工序顺序（真源文件内容）。"""
    key = scenario or DEFAULT_SCENARIO
    return {"code": 0, "data": load_deployment(key)}


@router.put("", dependencies=[Depends(require_token)])
def put_deployment(
    body: dict = Body(
        ...,
        description=(
            "{scenario?, deployments?:{equipId:{node,level}}, processOrder?:[muckId]}"
            "——两项均可选，至少传一项；deployments 为增量合并，processOrder 为整体替换"
        ),
    ),
):
    """保存部署与工序顺序：先校验 → 落盘 → 应用到运行中的仿真器。"""
    key = body.get("scenario") or DEFAULT_SCENARIO
    sim = get_simulator(key)
    current = load_deployment(key)

    # 增量合并：本次未提交的设备保持既有部署；processOrder 整体替换
    deployments = {**current["deployments"], **(body.get("deployments") or {})}
    process_order = body.get("processOrder")
    process_order = list(process_order) if process_order is not None else current["processOrder"]

    errors = validate_deployment(sim, deployments, process_order)
    if errors:
        return {"code": 1, "message": "；".join(errors)}

    save_deployment(key, deployments, process_order)
    # 即刻生效：空闲设备迁移待命点；作业中设备仅记录（下次重建按文件生效）
    applied, skipped = apply_deployment(sim, deployments, only_idle=True)
    sim.process_order = process_order
    logger.info(
        "[deployment] 场景 %s 已保存：部署 %d 台（即刻生效 %d），工序 %d 级",
        key, len(deployments), len(applied), len(process_order),
    )
    # 3.3 操作审计：记录部署变更（增量合并后的全量落点 + 即刻/延迟生效拆分）
    audit_append(
        "deployment.save",
        f"保存设备部署：{len(deployments)} 台落位，即刻生效 {len(applied)} 台",
        scenario=key,
        detail={
            "deployments": deployments,
            "processOrder": process_order,
            "applied": applied,
            "skipped": skipped,
        },
    )
    return {
        "code": 0,
        "data": {"deployments": deployments, "processOrder": process_order,
                 "applied": applied, "skipped": skipped},
    }
