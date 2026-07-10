"""Pydantic 请求/响应 Schema 定义"""
from pydantic import BaseModel, Field, ConfigDict, field_validator
from typing import Optional, Any, List


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


# ---- 爆破模块 ----


class RockParamsInput(BaseModel):
    """岩体参数子对象（对应请求体中的 rockParams 字段）

    单位约定（Task 9.2/9.4）：
    - API 输入：youngs_modulus 接收 GPa，compressive_strength 接收 MPa（贴近工程习惯）
    - field_validator 将输入归一化为 Pa（内部规范单位），与 blasting.py 中
      _api_to_json_obj 的 Pa→GPa/MPa 转换衔接，保证 DB 仍以 GPa/MPa 存储
    - DB 存储单位不变：ENV_ROCK_MAP 中 `弹性模量_GPa`(GPa)、`抗压强度_MPa`(MPa)
    """
    model_config = ConfigDict(populate_by_name=True)

    rock_type: Optional[str] = Field(None, alias="rockType", description="岩体类型")
    density: Optional[float] = Field(None, gt=0, description="密度(kg/m³)")
    youngs_modulus: Optional[float] = Field(None, alias="youngsModulus", gt=0, description="弹性模量(输入GPa, validator转Pa)")
    compressive_strength: Optional[float] = Field(None, alias="compressiveStrength", ge=0, description="抗压强度(输入MPa, validator转Pa)")
    tensile_strength: Optional[float] = Field(None, alias="tensileStrength", ge=0, description="抗拉强度(输入MPa, validator转Pa)")
    p_wave_speed: Optional[float] = Field(None, alias="pWaveSpeed", gt=0, description="P波速度(m/s)")
    s_wave_speed: Optional[float] = Field(None, alias="sWaveSpeed", gt=0, description="S波速度(m/s)")
    poissons_ratio: Optional[float] = Field(None, alias="poissonsRatio", ge=0, le=0.5, description="泊松比")
    friction_angle: Optional[float] = Field(None, alias="frictionAngle", ge=0, le=90, description="内摩擦角(°)")
    joint_spacing: Optional[float] = Field(None, alias="jointSpacing", ge=0, description="节理间距(m)")
    rqd: Optional[float] = Field(None, ge=0, le=100, description="RQD(%)")

    @field_validator('youngs_modulus', 'compressive_strength', 'tensile_strength', mode='before')
    @classmethod
    def _convert_units_to_pa(cls, v, info):
        """API 输入 GPa/MPa，归一化为 Pa（DB 仍存 GPa/MPa，转换在 blasting.py）"""
        if v is None or isinstance(v, bool) or not isinstance(v, (int, float)):
            return v
        if info.field_name == 'youngs_modulus':
            return v * 1e9  # GPa → Pa
        if info.field_name == 'compressive_strength':
            return v * 1e6  # MPa → Pa
        if info.field_name == 'tensile_strength':
            # Task 9：抗拉强度 DB 以 MPa 存储（花岗岩=8），需与抗压强度一致归一化为 Pa。
            # 值 < 1000 视为 MPa（工程输入，如 8），乘 1e6 转 Pa；
            # 已是 Pa（>= 1000，如 8e6）则保留，兼容两种输入。
            if v < 1000:
                return v * 1e6  # MPa → Pa
            return v
        return v


class BlastingEventCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(..., min_length=1, description="事件名称")
    center_lon: float = Field(..., alias="centerLon", ge=-180, le=180, description="中心经度")
    center_lat: float = Field(..., alias="centerLat", ge=-90, le=90, description="中心纬度")
    center_height: Optional[float] = Field(None, alias="centerHeight", description="中心高度(m)")
    charge_kg: float = Field(..., alias="chargeKg", gt=0, description="装药量(kg)")
    explosive_type: Optional[str] = Field(None, alias="explosiveType", description="炸药类型")
    detonation_method: Optional[str] = Field(None, alias="detonationMethod", description="起爆方式")
    blast_time: str = Field(..., alias="blastTime", description="爆破时间")
    rock_type: str = Field(..., alias="rockType", min_length=1, description="岩体类型")
    weather: Optional[str] = Field(None, description="天气")
    temperature: Optional[float] = Field(None, ge=-50, le=60, description="温度(℃)")
    wind_speed: Optional[float] = Field(None, alias="windSpeed", ge=0, description="风速(m/s)")
    wind_direction: Optional[float] = Field(None, alias="windDirection", ge=0, le=360, description="风向(°)")
    status: Optional[str] = Field("planned", description="状态")
    description: Optional[str] = Field(None, description="描述")
    rock_params: Optional[RockParamsInput] = Field(None, alias="rockParams", description="岩体参数")


class BlastingEventUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = Field(None, min_length=1, description="事件名称")
    center_lon: Optional[float] = Field(None, alias="centerLon", ge=-180, le=180, description="中心经度")
    center_lat: Optional[float] = Field(None, alias="centerLat", ge=-90, le=90, description="中心纬度")
    center_height: Optional[float] = Field(None, alias="centerHeight", description="中心高度(m)")
    charge_kg: Optional[float] = Field(None, alias="chargeKg", gt=0, description="装药量(kg)")
    explosive_type: Optional[str] = Field(None, alias="explosiveType", description="炸药类型")
    detonation_method: Optional[str] = Field(None, alias="detonationMethod", description="起爆方式")
    blast_time: Optional[str] = Field(None, alias="blastTime", description="爆破时间")
    rock_type: Optional[str] = Field(None, alias="rockType", description="岩体类型")
    weather: Optional[str] = Field(None, description="天气")
    temperature: Optional[float] = Field(None, ge=-50, le=60, description="温度(℃)")
    wind_speed: Optional[float] = Field(None, alias="windSpeed", ge=0, description="风速(m/s)")
    wind_direction: Optional[float] = Field(None, alias="windDirection", ge=0, le=360, description="风向(°)")
    status: Optional[str] = Field(None, description="状态")
    description: Optional[str] = Field(None, description="描述")
    rock_params: Optional[RockParamsInput] = Field(None, alias="rockParams", description="岩体参数")


class BlastingHoleInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    hole_index: Optional[int] = Field(None, alias="holeIndex", ge=0, description="炮孔序号")
    pos_x: float = Field(0, alias="posX", description="X坐标(m)")
    pos_y: float = Field(0, alias="posY", description="Y坐标(m)")
    pos_z: float = Field(0, alias="posZ", description="Z坐标(m)")
    hole_type: str = Field("auxiliary", alias="holeType", description="炮孔类型")
    diameter: Optional[float] = Field(None, ge=0, description="孔径(m)")
    depth: Optional[float] = Field(None, ge=0, description="孔深(m)")
    inclination_angle: Optional[float] = Field(None, alias="inclinationAngle", description="倾角(°)")
    inclination_azimuth: Optional[float] = Field(None, alias="inclinationAzimuth", description="方位角(°)")
    charge_kg: Optional[float] = Field(None, alias="chargeKg", ge=0, description="装药量(kg)")
    charge_length: Optional[float] = Field(None, alias="chargeLength", ge=0, description="药卷长度(m)")
    explosive_type: Optional[str] = Field(None, alias="explosiveType", description="炸药类型")
    detonator_series: Optional[int] = Field(None, alias="detonatorSeries", description="雷管段别")
    delay_ms: Optional[float] = Field(None, alias="delayMs", ge=0, description="延时(ms)")
    is_empty_hole: Optional[bool] = Field(None, alias="isEmptyHole", description="是否空孔")


class BlastingDesignSave(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tunnel_shape: Optional[str] = Field(None, alias="tunnelShape", description="隧道形状")
    tunnel_width: Optional[float] = Field(None, alias="tunnelWidth", gt=0, description="隧道宽度(m)")
    tunnel_wall_height: Optional[float] = Field(None, alias="tunnelWallHeight", gt=0, description="边墙高度(m)")
    tunnel_arch_radius: Optional[float] = Field(None, alias="tunnelArchRadius", gt=0, description="拱半径(m)")
    tunnel_total_height: Optional[float] = Field(None, alias="tunnelTotalHeight", gt=0, description="总高度(m)")
    tunnel_length: Optional[float] = Field(None, alias="tunnelLength", gt=0, description="隧道长度(m)")
    face_thickness: Optional[float] = Field(None, alias="faceThickness", ge=0, description="掌子面厚度(m)")
    face_offset: Optional[float] = Field(None, alias="faceOffset", description="掌子面偏移(m)")
    cut_pattern: Optional[str] = Field(None, alias="cutPattern", description="掏槽方式")
    cut_angle: Optional[float] = Field(None, alias="cutAngle", ge=0, le=90, description="掏槽角度(°)")
    cut_hole_count: Optional[int] = Field(None, alias="cutHoleCount", ge=0, description="掏槽孔数")
    empty_hole_count: Optional[int] = Field(None, alias="emptyHoleCount", ge=0, description="空孔数")
    initiation_network: Optional[str] = Field(None, alias="initiationNetwork", description="起爆网络")
    delay_interval_ms: Optional[float] = Field(None, alias="delayIntervalMs", ge=0, description="延时间隔(ms)")
    charge_density_cut: Optional[float] = Field(None, alias="chargeDensityCut", ge=0, le=10, description="掏槽孔装药密度(kg/m)")
    charge_density_aux: Optional[float] = Field(None, alias="chargeDensityAux", ge=0, le=10, description="辅助孔装药密度(kg/m)")
    charge_density_perim: Optional[float] = Field(None, alias="chargeDensityPerim", ge=0, le=10, description="周边孔装药密度(kg/m)")
    charge_density_floor: Optional[float] = Field(None, alias="chargeDensityFloor", ge=0, le=10, description="底板孔装药密度(kg/m)")
    stemming_length: Optional[float] = Field(None, alias="stemmingLength", ge=0, description="堵塞长度(m)")
    hole_depth: Optional[float] = Field(None, alias="holeDepth", gt=0, description="孔深(m)")
    hole_diameter: Optional[float] = Field(None, alias="holeDiameter", gt=0, description="孔径(m)")
    utilization: Optional[float] = Field(None, ge=0, le=1, description="炮孔利用率")
    advance_length: Optional[float] = Field(None, alias="advanceLength", ge=0, description="进尺(m)")
    expected_x50: Optional[float] = Field(None, alias="expectedX50", gt=0, description="预期X50块度(m)")
    expected_xmax: Optional[float] = Field(None, alias="expectedXmax", gt=0, description="预期最大块度(m)")
    expected_throw_distance: Optional[float] = Field(None, alias="expectedThrowDistance", ge=0, description="预期抛掷距离(m)")
    expected_overbreak: Optional[float] = Field(None, alias="expectedOverbreak", ge=0, description="预期超挖量(m)")
    min_safety_distance: Optional[float] = Field(None, alias="minSafetyDistance", ge=0, description="最小安全距离(m)")
    max_vibration_velocity: Optional[float] = Field(None, alias="maxVibrationVelocity", ge=0, description="最大振速(cm/s)")
    holes: List[BlastingHoleInput] = Field(default_factory=list, description="炮孔列表")


class BlastingResultSave(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    random_seed: Optional[int] = Field(None, alias="randomSeed", ge=0, description="随机种子")
    simulation_duration_s: Optional[float] = Field(None, alias="simulationDurationS", gt=0, description="模拟时长(s)")
    time_step_s: Optional[float] = Field(None, alias="timeStepS", gt=0, description="时间步长(s)")
    crater_depth: Optional[float] = Field(None, alias="craterDepth", ge=0, description="漏斗深度(m)")
    crater_radius: Optional[float] = Field(None, alias="craterRadius", ge=0, description="漏斗半径(m)")
    crater_center_offset_y: Optional[float] = Field(None, alias="craterCenterOffsetY", description="漏斗中心偏移Y(m)")
    overbreak_max: Optional[float] = Field(None, alias="overbreakMax", ge=0, description="最大超挖(m)")
    overbreak_min: Optional[float] = Field(None, alias="overbreakMin", ge=0, description="最小超挖(m)")
    half_barrel_ratio: Optional[float] = Field(None, alias="halfBarrelRatio", ge=0, le=1, description="半眼痕率")
    fragment_count: Optional[int] = Field(None, alias="fragmentCount", ge=0, description="碎块数量")
    fragment_x50: Optional[float] = Field(None, alias="fragmentX50", gt=0, description="X50块度(m)")
    fragment_x80: Optional[float] = Field(None, alias="fragmentX80", gt=0, description="X80块度(m)")
    fragment_xmax: Optional[float] = Field(None, alias="fragmentXmax", gt=0, description="最大块度(m)")
    fragment_b: Optional[float] = Field(None, alias="fragmentB", gt=0, description="Swebrec参数b")
    fragment_n: Optional[float] = Field(None, alias="fragmentN", gt=0, description="均匀性指数n")
    throw_distance_max: Optional[float] = Field(None, alias="throwDistanceMax", ge=0, description="最大抛掷距离(m)")
    throw_distance_avg: Optional[float] = Field(None, alias="throwDistanceAvg", ge=0, description="平均抛掷距离(m)")
    spread_angle: Optional[float] = Field(None, alias="spreadAngle", ge=0, le=360, description="扩散角(°)")
    vibration_peak: Optional[float] = Field(None, alias="vibrationPeak", ge=0, description="振动峰值(cm/s)")
    vibration_velocity_max: Optional[float] = Field(None, alias="vibrationVelocityMax", ge=0, description="最大振动速度(cm/s)")
    stress_peak_mpa: Optional[float] = Field(None, alias="stressPeakMpa", ge=0, description="峰值应力(MPa)")
    min_safety_factor: Optional[float] = Field(None, alias="minSafetyFactor", ge=0, description="最小安全系数")
    smoke_intensity: Optional[float] = Field(None, alias="smokeIntensity", ge=0, le=1, description="烟雾强度")
    dust_intensity: Optional[float] = Field(None, alias="dustIntensity", ge=0, le=1, description="粉尘强度")
    fire_intensity: Optional[float] = Field(None, alias="fireIntensity", ge=0, le=1, description="火焰强度")
    spark_intensity: Optional[float] = Field(None, alias="sparkIntensity", ge=0, le=1, description="火花强度")
    shockwave_speed_factor: Optional[float] = Field(None, alias="shockwaveSpeedFactor", gt=0, description="冲击波速度因子")


class BlastingCompareRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    event_ids: List[str] = Field(..., alias="eventIds", min_length=1, description="事件ID列表")


class KCOValidateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    Q: float = Field(..., gt=0, description="单孔装药量(kg)")
    A: float = Field(3.6, gt=0, le=22, description="岩石因子")
    RWS: float = Field(100, gt=0, description="相对重量威力(ANFO=100)")
    B: float = Field(1.5, gt=0, description="抵抗线(m)")
    S: float = Field(2.0, gt=0, description="孔距(m)")
    d: float = Field(0.04, gt=0, description="孔径(m)")
    H: float = Field(4.5, gt=0, description="台阶高度(m)")
    xmax: float = Field(2.0, gt=0, description="最大块度(m)")
    b: float = Field(2.0, gt=0, description="Swebrec弯曲参数")
    W_abs: float = Field(0.2, ge=0, description="钻孔偏差(m)")


class JWLRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    charge_kg: float = Field(..., alias="chargeKg", gt=0, description="装药量(kg)")
    explosive_type: str = Field("emulsion", alias="explosiveType", description="炸药类型")
    relative_volume: float = Field(1.0, alias="relativeVolume", gt=0, description="相对体积")


class VibrationRockInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    density: float = Field(2650, gt=0, description="密度(kg/m³)")
    p_wave_speed: float = Field(4500, alias="pWaveSpeed", gt=0, description="P波速度(m/s)")
    s_wave_speed: float = Field(2600, alias="sWaveSpeed", gt=0, description="S波速度(m/s)")
    youngs_modulus: float = Field(50e9, alias="youngsModulus", gt=0, description="杨氏模量(Pa)")
    poissons_ratio: float = Field(0.25, alias="poissonsRatio", ge=0, le=0.5, description="泊松比")


class VibrationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    charge_kg: float = Field(..., alias="chargeKg", gt=0, description="装药量(kg)")
    distance: float = Field(..., gt=0, description="距离(m)")
    rock: Optional[VibrationRockInput] = Field(None, description="岩体参数")


# ---- 阶段五：PPV 振动速度场 / 损伤区 / JWL 曲线 ----

class PPVFieldRequest(BaseModel):
    """二维 PPV 振动速度场计算请求"""
    model_config = ConfigDict(populate_by_name=True)

    charge_kg: float = Field(..., alias="chargeKg", gt=0, description="装药量(kg)")
    time: float = Field(..., ge=0, description="时刻(s)")
    x_min: float = Field(-50, alias="xMin", description="X方向最小值(m)")
    x_max: float = Field(50, alias="xMax", description="X方向最大值(m)")
    y_min: float = Field(-50, alias="yMin", description="Y方向最小值(m)")
    y_max: float = Field(50, alias="yMax", description="Y方向最大值(m)")
    nx: int = Field(100, ge=10, le=200, description="X方向网格数(上限200)")
    ny: int = Field(100, ge=10, le=200, description="Y方向网格数(上限200)")
    explosive_type: str = Field("emulsion", alias="explosiveType", description="炸药类型")
    p_wave_speed: Optional[float] = Field(None, alias="pWaveSpeed", gt=0, description="P波速度(m/s)")
    attenuation_p: Optional[float] = Field(None, alias="attenuationP", ge=0, description="P波衰减系数")
    rock_ucs: Optional[float] = Field(None, alias="rockUcs", gt=0, description="岩石单轴抗压强度(Pa)")
    site_K: Optional[float] = Field(None, alias="siteK", gt=0, description="萨道夫斯基场地常数K(50~400)")
    site_alpha: Optional[float] = Field(None, alias="siteAlpha", gt=0, description="萨道夫斯基衰减指数α(1.0~2.0)")


class PPVFieldResponse(BaseModel):
    """二维 PPV 振动速度场计算响应

    PPV 矩阵以 base64(float32) 编码返回，体积约 40KB（原 JSON 约 400KB）。
    前端解码：Float32Array.from(base64.decode(buf))
    """
    nx: int
    ny: int
    grid_x: List[float]
    grid_y: List[float]
    ppv_b64: str = Field(..., description="base64 编码的 float32 二进制数据")
    ppv_dtype: str = "float32"
    max_ppv: float
    mean_ppv: float


class DamageZoneRequest(BaseModel):
    """爆破损伤区半径计算请求"""
    model_config = ConfigDict(populate_by_name=True)

    charge_kg: float = Field(..., alias="chargeKg", gt=0, description="装药量(kg)")
    explosive_density: float = Field(1200, alias="explosiveDensity", gt=0, description="炸药密度(kg/m³)")
    VoD: float = Field(4500, gt=0, description="爆速(m/s)")
    rock_ucs: float = Field(120e6, alias="rockUcs", gt=0, description="岩石单轴抗压强度(Pa)")
    rock_tensile: float = Field(10e6, alias="rockTensile", gt=0, description="岩石抗拉强度(Pa)")


class DamageZoneResponse(BaseModel):
    """爆破损伤区半径计算响应"""
    charge_radius: float
    detonation_pressure: float
    crushed_radius: float
    fractured_radius: float
    elastic_zone_start: Optional[float] = Field(None, description="弹性区起始半径(m)，弹性区从此处延伸至无穷远，无外边界（None 表示弹性区无外边界，等于 fractured_radius）")


class JWLCurveRequest(BaseModel):
    """JWL 等熵膨胀曲线请求"""
    model_config = ConfigDict(populate_by_name=True)

    explosive_type: str = Field("emulsion", alias="explosiveType", description="炸药类型")


class JWLCurveResponse(BaseModel):
    """JWL 等熵膨胀曲线响应（P-V 关系）"""
    relative_volume: List[float]
    pressure_pa: List[float]


# ---- 萨道夫斯基常数实测反演 ----

class CalibrateMeasurement(BaseModel):
    """单组实测振速数据"""
    model_config = ConfigDict(populate_by_name=True)

    charge_kg: float = Field(..., gt=0, alias="chargeKg", description="装药量(kg)")
    distance: float = Field(..., gt=0, alias="distance", description="爆心距(m)")
    ppv: float = Field(..., gt=0, alias="ppv", description="实测峰值振速(cm/s)")


class CalibrateRequest(BaseModel):
    """萨道夫斯基常数反演请求（至少 3 组实测数据）"""
    model_config = ConfigDict(populate_by_name=True)

    measurements: List[CalibrateMeasurement] = Field(..., min_length=3, alias="measurements", description="实测数据(至少3组)")


class CalibrateResponse(BaseModel):
    """萨道夫斯基常数反演响应"""
    model_config = ConfigDict(populate_by_name=True)

    K: float = Field(..., alias="K", description="反演的萨道夫斯基 K 常数")
    alpha: float = Field(..., alias="alpha", description="反演的衰减指数 α")
    r_squared: float = Field(..., alias="rSquared", description="拟合决定系数 R²")