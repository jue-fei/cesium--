"""Pydantic 请求/响应 Schema 定义"""
from pydantic import BaseModel, Field, ConfigDict, field_validator
from typing import Optional, Any


def _to_camel(name: str) -> str:
    """snake_case → camelCase（保留尾部数字，如 fragment_x50 → fragmentX50）"""
    parts = name.split('_')
    return parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])


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


# ---- 爆破事件（5表扁平结构：事件+设计+效果+炮孔JSON 同行存储）----

class BlastingEventUpdate(BaseModel):
    """爆破事件更新（接收 camelCase JSON，字段对应扁平表的 70 个业务字段 + holes 数组）"""
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)

    # 区块1：事件基本信息
    name: Optional[str] = None
    center_lon: Optional[float] = None
    center_lat: Optional[float] = None
    center_height: Optional[float] = None
    charge_kg: Optional[float] = None
    explosive_type: Optional[str] = None
    detonation_method: Optional[str] = None
    blast_time: Optional[str] = None
    rock_type: Optional[str] = None
    weather: Optional[str] = None
    temperature: Optional[float] = None
    wind_speed: Optional[float] = None
    wind_direction: Optional[float] = None
    status: Optional[str] = None
    description: Optional[str] = None
    # 区块2：设计参数
    tunnel_shape: Optional[str] = None
    tunnel_width: Optional[float] = None
    tunnel_wall_height: Optional[float] = None
    tunnel_arch_radius: Optional[float] = None
    tunnel_total_height: Optional[float] = None
    cut_pattern: Optional[str] = None
    cut_angle: Optional[float] = None
    cut_hole_count: Optional[int] = None
    empty_hole_count: Optional[int] = None
    initiation_network: Optional[str] = None
    delay_interval_ms: Optional[int] = None
    charge_density_cut: Optional[float] = None
    charge_density_aux: Optional[float] = None
    charge_density_perim: Optional[float] = None
    stemming_length: Optional[float] = None
    expected_x50: Optional[float] = None
    expected_xmax: Optional[float] = None
    expected_throw_distance: Optional[float] = None
    expected_overbreak: Optional[float] = None
    min_safety_distance: Optional[float] = None
    max_vibration_velocity: Optional[float] = None
    # 区块3：效果参数
    random_seed: Optional[int] = None
    simulation_duration_s: Optional[float] = None
    time_step_s: Optional[float] = None
    crater_depth: Optional[float] = None
    crater_radius: Optional[float] = None
    crater_center_offset_y: Optional[float] = None
    overbreak_max: Optional[float] = None
    overbreak_min: Optional[float] = None
    half_barrel_ratio: Optional[float] = None
    fragment_count: Optional[int] = None
    fragment_x50: Optional[float] = None
    fragment_x80: Optional[float] = None
    fragment_xmax: Optional[float] = None
    fragment_b: Optional[float] = None
    fragment_n: Optional[float] = None
    throw_distance_max: Optional[float] = None
    throw_distance_avg: Optional[float] = None
    throw_spread_angle: Optional[float] = None
    vibration_peak: Optional[float] = None
    vibration_velocity_max: Optional[float] = None
    stress_peak_mpa: Optional[float] = None
    min_safety_factor: Optional[float] = None
    smoke_intensity: Optional[float] = None
    dust_intensity: Optional[float] = None
    fire_intensity: Optional[float] = None
    spark_intensity: Optional[float] = None
    shockwave_speed_factor: Optional[float] = None
    rock_density: Optional[float] = None
    rock_youngs_modulus: Optional[float] = None
    rock_compressive_strength: Optional[float] = None
    rock_p_wave_speed: Optional[float] = None
    rock_s_wave_speed: Optional[float] = None
    # 区块4：炮孔数据（数组，存库时序列化为 holes_json）
    holes: Optional[list] = None


class BlastingCompareRequest(BaseModel):
    """历史对比 — 批量获取多事件完整数据"""
    event_ids: list[str] = Field(..., description="事件ID列表")


# ---- 爆破物理端点请求模型（替代 body: dict，启用自动校验与 OpenAPI）----

class KCOValidateRequest(BaseModel):
    """KCO 校验请求（/api/blasting/validate/kco）"""
    Q: float = Field(..., gt=0, description="单孔装药量 kg")
    A: float = Field(3.6, ge=0.8, le=22, description="岩石因子")
    RWS: float = Field(100, gt=0, description="相对重量威力（ANFO=100）")
    B: float = Field(1.5, gt=0, description="抵抗线 m")
    S: float = Field(2.0, gt=0, description="孔距 m")
    d: float = Field(0.04, gt=0, description="孔径 m")
    H: float = Field(4.5, gt=0, description="台阶高度 m")
    xmax: float = Field(2.0, gt=0, description="最大块度 m")
    b: float = Field(2.0, gt=0, description="Swebrec 弯曲参数")
    W_abs: float = Field(0.2, ge=0, description="钻孔偏差（标准差）m")

    @field_validator("B")
    @classmethod
    def B_gt_d(cls, v, info):
        """抵抗线必须大于孔径（爆破工程基本约束）"""
        d_val = info.data.get("d") if info.data else None
        if d_val is not None and v <= d_val:
            raise ValueError("抵抗线 B 必须大于孔径 d")
        return v


class JwlRequest(BaseModel):
    """JWL 爆压计算请求（/api/blasting/physics/jwl）"""
    chargeKg: float = Field(..., gt=0, description="装药量 kg")
    explosiveType: str = Field("emulsion", description="炸药类型",
                               pattern="^(emulsion|anfo|dynamite)$")
    relativeVolume: float = Field(..., gt=1.0, description="相对体积 V>1（膨胀后）")


class VibrationRequest(BaseModel):
    """萨道夫斯基振动预测请求（/api/blasting/physics/vibration）"""
    chargeKg: float = Field(..., gt=0, description="装药量 kg")
    distance: float = Field(..., gt=0, description="爆心距 m")
    density: float = Field(2650, gt=0, description="岩体密度 kg/m³")
    pWaveSpeed: float = Field(4500, gt=0, description="P 波波速 m/s")
    sWaveSpeed: float = Field(2600, gt=0, description="S 波波速 m/s")
    youngsModulus: float = Field(50e9, gt=0, description="杨氏模量 Pa")
    poissonsRatio: float = Field(0.25, ge=0, lt=0.5, description="泊松比")