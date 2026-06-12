"""Pydantic 请求/响应 Schema 定义"""
from pydantic import BaseModel, Field
from typing import Optional, Any


# ---- 通用响应 ----

class ApiResponse(BaseModel):
    code: int = 0
    data: Optional[Any] = None
    message: Optional[str] = None


# ---- 钻孔 ----

class BoreholeCreate(BaseModel):
    borehole_id: str = Field(..., description="钻孔编号")
    name: str = Field(..., description="钻孔名称")
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    depth: Optional[float] = None
    stratigraphy: Optional[Any] = None
    description: Optional[str] = None


class BoreholeUpdate(BaseModel):
    name: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    depth: Optional[float] = None
    stratigraphy: Optional[Any] = None
    description: Optional[str] = None


# ---- 矿体 ----

class OrebodyCreate(BaseModel):
    orebody_id: str = Field(..., description="矿体编号")
    name: str = Field(..., description="矿体名称")
    ore_type: Optional[str] = None
    grade: Optional[float] = None
    reserves: Optional[float] = None
    thickness: Optional[float] = None
    density: Optional[float] = None
    volume: Optional[float] = None
    metal_content: Optional[float] = None
    mining_method: Optional[str] = None
    depth_top: Optional[float] = None
    depth_bottom: Optional[float] = None
    dip_angle: Optional[float] = None
    strike: Optional[float] = None
    status: Optional[str] = None
    geological_zone: Optional[str] = None
    confidence_level: Optional[str] = None
    bounding_box: Optional[Any] = None
    description: Optional[str] = None


class OrebodyUpdate(BaseModel):
    name: Optional[str] = None
    ore_type: Optional[str] = None
    grade: Optional[float] = None
    reserves: Optional[float] = None
    thickness: Optional[float] = None
    density: Optional[float] = None
    volume: Optional[float] = None
    metal_content: Optional[float] = None
    mining_method: Optional[str] = None
    depth_top: Optional[float] = None
    depth_bottom: Optional[float] = None
    dip_angle: Optional[float] = None
    strike: Optional[float] = None
    status: Optional[str] = None
    geological_zone: Optional[str] = None
    confidence_level: Optional[str] = None
    bounding_box: Optional[Any] = None
    description: Optional[str] = None


# ---- 矿卡 ----

class TruckCreate(BaseModel):
    truck_id: str = Field(..., description="矿卡编号")
    name: str = Field(..., description="矿卡名称")
    driver: Optional[str] = None
    driver_info: Optional[Any] = None
    vehicle_info: Optional[Any] = None
    mineral_type: Optional[Any] = None
    phase: Optional[str] = None
    status: Optional[str] = None


class TruckUpdate(BaseModel):
    name: Optional[str] = None
    driver: Optional[str] = None
    driver_info: Optional[Any] = None
    vehicle_info: Optional[Any] = None
    mineral_type: Optional[Any] = None
    phase: Optional[str] = None
    status: Optional[str] = None


# ---- 模型配置 ----

class ModelCreate(BaseModel):
    model_id: str = Field(..., description="模型编号")
    name: str = Field(..., description="模型名称")
    path: Optional[str] = None
    sort_order: Optional[int] = None
    features: Optional[Any] = None
    description: Optional[str] = None
    global_properties: Optional[Any] = None
    scenetree: Optional[Any] = None
    tileset: Optional[Any] = None


class ModelUpdate(BaseModel):
    name: Optional[str] = None
    path: Optional[str] = None
    sort_order: Optional[int] = None
    features: Optional[Any] = None
    description: Optional[str] = None
    global_properties: Optional[Any] = None
    scenetree: Optional[Any] = None
    tileset: Optional[Any] = None


class ModelSave(BaseModel):
    path: str = Field(..., description="配置文件路径")
    data: Optional[dict] = None
    model_id: Optional[str] = ""
    name: Optional[str] = ""


# ---- 矿卡路线 ----

class TruckRouteCreate(BaseModel):
    name: str = Field(..., min_length=1, description="路线名称")
    points: list = Field(..., min_length=2, description="路线点数组")
    is_default: Optional[int] = 0


class TruckRouteUpdate(BaseModel):
    name: Optional[str] = None
    points: Optional[list] = None
    is_default: Optional[int] = None