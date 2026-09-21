"""设备健康管理 HTTP 接口

GET /api/equipment/health：全 fleet 健康帧（健康分/分级/告警明细/fleet 汇总），
数据源 TelemetryAdapter（2.2 遥测），健康分同时写入时序层（2.1，趋势查询走
GET /api/timeseries?metric=equipment.health&tags=equipId=E1）。
阈值契约：shared-consistency-baseline.json#equipmentHealthCmps。
"""
from typing import Optional

from fastapi import APIRouter

from app.routes.scheduling import get_simulator
from app.services.equipment.health import build_health_frame
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO

router = APIRouter(prefix="/api/equipment", redirect_slashes=False, tags=["设备健康"])


@router.get("/health")
def equipment_health(scenario: Optional[str] = None):
    """全 fleet 设备健康帧（前端 EquipmentHealthPanel 每 5s 轮询）。"""
    sim = get_simulator(scenario)
    return {"code": 0, "data": build_health_frame(sim)}
