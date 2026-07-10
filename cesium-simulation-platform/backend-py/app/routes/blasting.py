"""爆破模块路由 — V2 宽表 + JSON 列设计

表结构（V2）：
  - blasting_events    事件主表（宽表，每事件 1 行，5 JSON 聚合列）
  - 岩体参数参考        岩体参数字典表（独立于事件）

V2 设计理念：
  - 标量列：用于 SQL 查询、筛选、排序、聚合（中文列名）
  - JSON 列：炮孔设计, 断面掘进, 装药起爆, 爆破效果, 环境岩体
  - 消灭 JOIN，前端一次请求拿到完整事件数据

API 契约不变：endpoints、请求/响应格式（camelCase）与 V1 完全一致。
"""
import base64
import json
from datetime import datetime
import logging

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pymysql import Connection
from pymysql import IntegrityError as MyIntegrityError, OperationalError as MyOperationalError

from app.database import get_db
from app.schemas import (
    BlastingEventCreate,
    BlastingEventUpdate,
    BlastingDesignSave,
    BlastingResultSave,
    BlastingCompareRequest,
    KCOValidateRequest,
    JWLRequest,
    VibrationRequest,
    PPVFieldRequest,
    PPVFieldResponse,
    DamageZoneRequest,
    DamageZoneResponse,
    JWLCurveRequest,
    JWLCurveResponse,
    CalibrateRequest,
    CalibrateResponse,
)
from app.services.blasting.kco_validator import KCOInput, calculate_kco
from app.services.blasting.blast_physics import (
    BlastSource,
    RockMedium,
    jwl_pressure,
    sadosky_vibration,
    wave_field_2d,
    damage_zone_radii,
    jwl_isentrope,
)
from app.services.blasting.compare import compare_multiple_events

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/blasting", redirect_slashes=False, tags=["爆破模拟"])

# ============================================================
# 枚举映射（API 英文值 ↔ DB 中文值）
# ============================================================

STATUS_API2DB = {"planned": "已规划", "executed": "已执行", "aborted": "已取消"}
STATUS_DB2API = {v: k for k, v in STATUS_API2DB.items()}

EXPLOSIVE_API2DB = {"emulsion": "乳化炸药", "anfo": "铵油炸药", "dynamite": "硝化甘油"}
EXPLOSIVE_DB2API = {v: k for k, v in EXPLOSIVE_API2DB.items()}

ROCK_API2DB = {
    "granite": "花岗岩", "limestone": "石灰岩", "sandstone": "砂岩",
    "marble": "大理石", "basalt": "玄武岩", "schist": "片岩",
    "andesite": "安山岩", "diorite": "闪长岩", "shale": "页岩",
    "quartzite": "石英岩", "ore_iron": "铁矿",
}
ROCK_DB2API = {v: k for k, v in ROCK_API2DB.items()}

SHAPE_API2DB = {"horseshoe": "马蹄形", "circular": "圆形", "rectangular": "矩形"}
SHAPE_DB2API = {v: k for k, v in SHAPE_API2DB.items()}

HOLETYPE_API2DB = {
    "cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔",
    "floor": "底板孔", "empty": "空孔",
}
HOLETYPE_DB2API = {v: k for k, v in HOLETYPE_API2DB.items()}

INIT_API2DB = {
    "electric": "电雷管", "nonel": "导爆管", "electronic": "电子雷管",
    "detonating_cord": "导爆索",
}
INIT_DB2API = {v: k for k, v in INIT_API2DB.items()}

CUT_API2DB = {
    "four_section": "四段掏槽", "single_spiral": "单螺旋",
    "double_spiral": "双螺旋", "wedge": "楔形", "burn": "直眼",
}
CUT_DB2API = {v: k for k, v in CUT_API2DB.items()}

WEATHER_API2DB = {"clear": "晴", "cloudy": "多云", "rain": "雨"}
WEATHER_DB2API = {v: k for k, v in WEATHER_API2DB.items()}

# ============================================================
# 字段映射表（V2 中文列名/JSON key ↔ API camelCase）
# ============================================================

# ── 标量列 ──────────────────────────────────────────────────
EVENT_SCALAR_MAP = {
    "event_id": "eventId",
    "名称": "name",
    "爆心经度": "centerLon",
    "爆心纬度": "centerLat",
    "爆心高程": "centerHeight",
    "总装药量_kg": "chargeKg",
    "炸药类型": "explosiveType",
    "岩体类型": "rockType",
    "起爆方式": "detonationMethod",
    "爆破时间": "blastTime",
    "状态": "status",
    "备注": "description",
}
EVENT_SCALAR_MAP_REV = {v: k for k, v in EVENT_SCALAR_MAP.items()}

# 标量列中需要枚举转换的字段: camelKey → (db2api, api2db)
SCALAR_ENUM_FIELDS = {
    "status": (STATUS_DB2API, STATUS_API2DB),
    "explosiveType": (EXPLOSIVE_DB2API, EXPLOSIVE_API2DB),
    "rockType": (ROCK_DB2API, ROCK_API2DB),
    "detonationMethod": (INIT_DB2API, INIT_API2DB),
}

# ── 断面掘进 JSON ──────────────────────────────────────────
TUNNEL_JSON_MAP = {
    "断面形状": "tunnelShape",
    "断面宽度_m": "tunnelWidth",
    "直墙高度_m": "tunnelWallHeight",
    "拱部半径_m": "tunnelArchRadius",
    "断面总高度_m": "tunnelTotalHeight",
    "已开挖长度_m": "tunnelLength",
    "掌子面厚度_m": "faceThickness",
    "掌子面距爆心_m": "faceOffset",
    "钻孔深度_m": "holeDepth",
    "钻孔直径_m": "holeDiameter",
    "炮孔利用率": "utilization",
    "单循环进尺_m": "advanceLength",
}
TUNNEL_JSON_MAP_REV = {v: k for k, v in TUNNEL_JSON_MAP.items()}

# ── 装药起爆 JSON ──────────────────────────────────────────
CHARGE_JSON_MAP = {
    "掏槽模式": "cutPattern",
    "楔形掏槽角_度": "cutAngle",
    "装药掏槽孔数": "cutHoleCount",
    "空孔数": "emptyHoleCount",
    "起爆网络": "initiationNetwork",
    "段间延时间隔_ms": "delayIntervalMs",
    "掏槽线装药密度_kgm": "chargeDensityCut",
    "辅助线装药密度_kgm": "chargeDensityAux",
    "周边线装药密度_kgm": "chargeDensityPerim",
    "底板线装药密度_kgm": "chargeDensityFloor",
    "堵塞长度_m": "stemmingLength",
}
CHARGE_JSON_MAP_REV = {v: k for k, v in CHARGE_JSON_MAP.items()}

# ── 炮孔设计 JSON（单孔） ──────────────────────────────────
HOLES_JSON_MAP = {
    "序号": "holeIndex",
    "X坐标_m": "posX",
    "Y坐标_m": "posY",
    "孔类型": "holeType",
    "孔径_m": "diameter",
    "孔深_m": "depth",
    "倾角_度": "inclinationAngle",
    "方位角_度": "inclinationAzimuth",
    "装药量_kg": "chargeKg",
    "装药长度_m": "chargeLength",
    "炸药类型": "explosiveType",
    "雷管段别": "detonatorSeries",
    "延期时间_ms": "delayMs",
    "是否空孔": "isEmptyHole",
}
HOLES_JSON_MAP_REV = {v: k for k, v in HOLES_JSON_MAP.items()}

# ── 爆破效果 JSON ──────────────────────────────────────────
RESULT_JSON_MAP = {
    "模拟随机种子": "randomSeed",
    "模拟总时长_s": "simulationDurationS",
    "时间步长_s": "timeStepS",
    "碎片总数": "fragmentCount",
    "中位块度_x50_m": "fragmentX50",
    "80通过块度_x80_m": "fragmentX80",
    "最大块度_xmax_m": "fragmentXmax",
    "Swebrec弯曲参数_b": "fragmentB",
    "Cunningham均匀指数_n": "fragmentN",
    "漏斗深度_m": "craterDepth",
    "漏斗半径_m": "craterRadius",
    "漏斗中心偏移_m": "craterCenterOffsetY",
    "最大抛掷距离_m": "throwDistanceMax",
    "平均抛掷距离_m": "throwDistanceAvg",
    "抛掷扩散角_度": "spreadAngle",
    "最大超挖_m": "overbreakMax",
    "最小超挖_m": "overbreakMin",
    "半孔率": "halfBarrelRatio",
    "峰值振动_Kine": "vibrationPeak",
    "最大质点振速_cms": "vibrationVelocityMax",
    "峰值应力_MPa": "stressPeakMpa",
    "最小安全系数": "minSafetyFactor",
    "烟雾强度": "smokeIntensity",
    "粉尘强度": "dustIntensity",
    "火球强度": "fireIntensity",
    "火花强度": "sparkIntensity",
    "冲击波速度系数": "shockwaveSpeedFactor",
}
RESULT_JSON_MAP_REV = {v: k for k, v in RESULT_JSON_MAP.items()}

# ── 环境岩体 JSON → rockParams 子对象 ──────────────────────
ENV_ROCK_MAP = {
    "岩体类型": "rockType",
    "密度_kgm3": "density",
    "弹性模量_GPa": "youngsModulus",
    "抗压强度_MPa": "compressiveStrength",
    "抗拉强度_MPa": "tensileStrength",
    "P波波速_ms": "pWaveSpeed",
    "S波波速_ms": "sWaveSpeed",
    "泊松比": "poissonsRatio",
    "内摩擦角_度": "frictionAngle",
    "节理间距_m": "jointSpacing",
    "RQD": "rqd",
}
ENV_ROCK_MAP_REV = {v: k for k, v in ENV_ROCK_MAP.items()}

# ── 环境岩体 JSON → event 级别字段（weather/wind） ─────────
ENV_EVENT_MAP = {
    "天气": "weather",
    "温度_摄氏度": "temperature",
    "风速_ms": "windSpeed",
    "风向_度": "windDirection",
}
ENV_EVENT_MAP_REV = {v: k for k, v in ENV_EVENT_MAP.items()}

# ── JSON 内枚举字段: camelKey → (db2api, api2db) ───────────
DESIGN_ENUM_FIELDS = {
    "tunnelShape": (SHAPE_DB2API, SHAPE_API2DB),
    "cutPattern": (CUT_DB2API, CUT_API2DB),
    "initiationNetwork": (INIT_DB2API, INIT_API2DB),
}
HOLES_ENUM_FIELDS = {
    "holeType": (HOLETYPE_DB2API, HOLETYPE_API2DB),
    "explosiveType": (EXPLOSIVE_DB2API, EXPLOSIVE_API2DB),
}
ENV_ENUM_FIELDS = {
    "weather": (WEATHER_DB2API, WEATHER_API2DB),
    "rockType": (ROCK_DB2API, ROCK_API2DB),
}

# ── 爆破效果 JSON → V1 snake_case（compare 服务使用）────────
RESULT_JSON_TO_SNAKE = {
    "模拟随机种子": "random_seed",
    "模拟总时长_s": "simulation_duration_s",
    "时间步长_s": "time_step_s",
    "碎片总数": "fragment_count",
    "中位块度_x50_m": "fragment_x50",
    "80通过块度_x80_m": "fragment_x80",
    "最大块度_xmax_m": "fragment_xmax",
    "Swebrec弯曲参数_b": "fragment_b",
    "Cunningham均匀指数_n": "fragment_n",
    "漏斗深度_m": "crater_depth",
    "漏斗半径_m": "crater_radius",
    "漏斗中心偏移_m": "crater_center_offset_y",
    "最大抛掷距离_m": "throw_distance_max",
    "平均抛掷距离_m": "throw_distance_avg",
    "抛掷扩散角_度": "spread_angle",
    "最大超挖_m": "overbreak_max",
    "最小超挖_m": "overbreak_min",
    "半孔率": "half_barrel_ratio",
    "峰值振动_Kine": "vibration_peak",
    "最大质点振速_cms": "vibration_velocity_max",
    "峰值应力_MPa": "stress_peak_mpa",
    "最小安全系数": "min_safety_factor",
    "烟雾强度": "smoke_intensity",
    "粉尘强度": "dust_intensity",
    "火球强度": "fire_intensity",
    "火花强度": "spark_intensity",
    "冲击波速度系数": "shockwave_speed_factor",
}

COMPARE_METRIC_CAMEL = {
    "fragment_x50": "fragmentX50",
    "throw_distance_max": "throwDistanceMax",
    "vibration_peak": "vibrationPeak",
}

# V1 设计字段在 V2 中无对应 → 返回 null 保持兼容
DESIGN_FIELDS_V1_ONLY = [
    "expectedX50", "expectedXmax", "expectedThrowDistance",
    "expectedOverbreak", "minSafetyDistance", "maxVibrationVelocity",
]


# ============================================================
# 工具函数
# ============================================================

def _conv(value, mapping):
    """枚举值转换，未知值原样返回"""
    if value is None:
        return None
    return mapping.get(value, value)


def _parse_json_col(raw):
    """安全解析 JSON 列，返回 dict/list 或空结构"""
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning(f"JSON 列解析失败，原始值长度={len(str(raw))}, 错误={e}")
        return None


def _json_obj_to_api(obj, mapping, enum_fields=None):
    """将 JSON 对象的中文 key 转为 camelCase，处理枚举和单位转换

    单位约定（Task 9.3）：
      DB 存 GPa/MPa → API 响应返回 Pa（与输入端 field_validator 归一化后的 Pa 一致）。
      GET 响应链路：DB(GPa/MPa) → 本函数(GPa→Pa / MPa→Pa) → API 响应(Pa)。
      此处 GPa→Pa、MPa→Pa 转换必须保留，否则 API 响应单位将与 POST/PUT 输入不一致。
    """
    if not obj:
        return {}
    result = {}
    for cn_key, camel_key in mapping.items():
        if cn_key not in obj:
            continue
        val = obj[cn_key]
        # 枚举转换
        if enum_fields and camel_key in enum_fields:
            db2api, _ = enum_fields[camel_key]
            val = _conv(val, db2api)
        # 单位转换：环境岩体中的弹性模量(GPa→Pa)和抗压强度(MPa→Pa)
        # DB 以 GPa/MPa 存储，API 响应统一返回 Pa
        if camel_key == "youngsModulus" and isinstance(val, (int, float)):
            val = val * 1e9
        elif camel_key == "compressiveStrength" and isinstance(val, (int, float)):
            val = val * 1e6
        elif camel_key == "tensileStrength" and isinstance(val, (int, float)):
            val = val * 1e6  # DB 以 MPa 存储 → API 响应返回 Pa（Task 9）
        result[camel_key] = val
    return result


def _api_to_json_obj(api_obj, rev_mapping, enum_fields=None):
    """将 camelCase API 对象转为中文 key JSON 对象，处理枚举和单位转换

    单位约定（Task 9.3）：
      API 输入经 schemas.RockParamsInput.field_validator 已归一化为 Pa，
      本函数负责 Pa→GPa / Pa→MPa，使 DB 仍以 GPa/MPa 存储（ENV_ROCK_MAP 列名带单位后缀）。
      POST/PUT 输入链路：API 输入(GPa/MPa) → field_validator(→Pa) → 本函数(→GPa/MPa) → DB(GPa/MPa)。
      此处 Pa→GPa、Pa→MPa 转换必须保留，否则 DB 存储单位将被破坏。
    """
    if not api_obj:
        return {}
    result = {}
    for camel_key, val in api_obj.items():
        cn_key = rev_mapping.get(camel_key)
        if cn_key is None:
            continue
        # 枚举转换
        if enum_fields and camel_key in enum_fields:
            _, api2db = enum_fields[camel_key]
            val = _conv(val, api2db)
        # 单位转换：Pa→GPa, Pa→MPa
        # 输入经 validator 已转为 Pa，此处转回 DB 存储单位 GPa/MPa
        if camel_key == "youngsModulus" and isinstance(val, (int, float)):
            val = val / 1e9
        elif camel_key == "compressiveStrength" and isinstance(val, (int, float)):
            val = val / 1e6
        elif camel_key == "tensileStrength" and isinstance(val, (int, float)):
            val = val / 1e6  # API 输入已归一化为 Pa → DB 以 MPa 存储（Task 9）
        result[cn_key] = val
    return result


def _build_event(row, env_json=None):
    """从 DB 行构建 event 响应对象（标量列 + 枚举转换 + 环境字段）"""
    event = {}
    for db_col, camel_key in EVENT_SCALAR_MAP.items():
        val = row.get(db_col)
        if camel_key in SCALAR_ENUM_FIELDS:
            db2api, _ = SCALAR_ENUM_FIELDS[camel_key]
            val = _conv(val, db2api)
        event[camel_key] = val

    # 从环境岩体 JSON 提取 weather/wind 字段
    env = _parse_json_col(env_json) or {}
    for cn_key, camel_key in ENV_EVENT_MAP.items():
        val = env.get(cn_key)
        if camel_key in ENV_ENUM_FIELDS:
            db2api, _ = ENV_ENUM_FIELDS[camel_key]
            val = _conv(val, db2api)
        event[camel_key] = val

    # 构建 rockParams 子对象
    rock_params = _json_obj_to_api(env, ENV_ROCK_MAP, ENV_ENUM_FIELDS)
    event["rockParams"] = rock_params
    return event


def _build_design(tunnel_json, charge_json, holes_json):
    """从 JSON 列构建 design + holes 响应"""
    tunnel = _parse_json_col(tunnel_json) or {}
    charge = _parse_json_col(charge_json) or {}
    holes_raw = _parse_json_col(holes_json) or []

    design = _json_obj_to_api(tunnel, TUNNEL_JSON_MAP, DESIGN_ENUM_FIELDS)
    design.update(_json_obj_to_api(charge, CHARGE_JSON_MAP, DESIGN_ENUM_FIELDS))

    # V1 设计中无 V2 对应的字段，返回 null 保持兼容
    for field in DESIGN_FIELDS_V1_ONLY:
        design[field] = None

    # Task 11：V1 兼容字段已废弃，标记 _deprecated 提示前端逐步迁移
    if any(k in design for k in DESIGN_FIELDS_V1_ONLY):
        design["_deprecated"] = True

    holes = []
    for h in holes_raw:
        hole = _json_obj_to_api(h, HOLES_JSON_MAP, HOLES_ENUM_FIELDS)
        # V1 有 posZ，V2 没有，补 0
        hole["posZ"] = 0
        holes.append(hole)

    return design, holes


def _build_result(result_json):
    """从爆破效果 JSON 列构建 result 响应"""
    result_raw = _parse_json_col(result_json) or {}
    return _json_obj_to_api(result_raw, RESULT_JSON_MAP)


def _build_env_json(body, cursor=None):
    """从请求体构建环境岩体 JSON 对象

    组合 weather/wind 字段 + 岩体参数（来自 body.rockParams 或参考表）
    """
    env = {}

    # 从 body 中提取 weather/wind 字段
    for camel_key, cn_key in ENV_EVENT_MAP_REV.items():
        if camel_key in body:
            val = body[camel_key]
            if camel_key in ENV_ENUM_FIELDS:
                _, api2db = ENV_ENUM_FIELDS[camel_key]
                val = _conv(val, api2db)
            env[cn_key] = val

    # 从 body 中提取 rockParams
    rock_body = body.get("rockParams") or {}
    if rock_body:
        rock_json = _api_to_json_obj(rock_body, ENV_ROCK_MAP_REV, ENV_ENUM_FIELDS)
        env.update(rock_json)
    elif cursor and body.get("rockType"):
        # 从岩体参数参考表查找默认值
        rock_cn = _conv(body["rockType"], ROCK_API2DB)
        cursor.execute(
            "SELECT * FROM `岩体参数参考` WHERE `岩体类型` = %s",
            (rock_cn,),
        )
        ref_row = cursor.fetchone()
        if ref_row:
            for col in ref_row:
                if col != "更新时间":
                    env[col] = ref_row[col]

    return env


def _generate_event_id(cursor) -> str:
    """生成新事件编号 BLAST-YYYY-NNN（同年度递增）"""
    year = datetime.now().year
    cursor.execute(
        "SELECT event_id FROM blasting_events "
        "WHERE event_id LIKE %s ORDER BY event_id DESC LIMIT 1",
        (f"BLAST-{year}-%",),
    )
    row = cursor.fetchone()
    if row:
        parts = row["event_id"].split("-")
        try:
            num = int(parts[-1]) + 1
        except (ValueError, IndexError):
            num = 1
        return f"BLAST-{year}-{num:03d}"
    return f"BLAST-{year}-001"


def _event_exists(cursor, event_id: str) -> bool:
    cursor.execute(
        "SELECT 1 FROM blasting_events WHERE event_id = %s", (event_id,)
    )
    return cursor.fetchone() is not None


# ============================================================
# 事件 CRUD（5 个）
# ============================================================

@router.get("/events")
@router.get("/events/")
def list_events(status: str = None, db: Connection = Depends(get_db)):
    """列出所有爆破事件（单表查询 blasting_events，按爆破时间倒序）"""
    status_cn = _conv(status, STATUS_API2DB) if status else None
    with db.cursor() as cursor:
        sql = "SELECT * FROM blasting_events"
        params = []
        if status_cn:
            sql += " WHERE `状态` = %s"
            params.append(status_cn)
        sql += " ORDER BY `爆破时间` DESC"
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    events = [_build_event(r, r.get("环境岩体")) for r in rows]
    return {"code": 0, "data": events}


@router.get("/events/{event_id}")
def get_event(event_id: str, db: Connection = Depends(get_db)):
    """获取事件详情：单表查询，解析 JSON 列组装 {event, design, result}"""
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT * FROM blasting_events WHERE event_id = %s",
            (event_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="爆破事件未找到")

    event = _build_event(row, row.get("环境岩体"))
    design, holes = _build_design(
        row.get("断面掘进"), row.get("装药起爆"), row.get("炮孔设计")
    )
    design["eventId"] = event_id
    design["holes"] = holes
    result = _build_result(row.get("爆破效果"))
    result["eventId"] = event_id
    return {"code": 0, "data": {"event": event, "design": design, "result": result}}


@router.post("/events")
@router.post("/events/")
def create_event(body: BlastingEventCreate, db: Connection = Depends(get_db)):
    """创建事件：INSERT blasting_events 宽表（标量列 + JSON 列）"""
    # 将 Pydantic 模型转为 dict（使用 camelCase 别名，与映射表一致）
    body_dict = body.model_dump(by_alias=True, exclude_none=True)

    # 提取标量字段
    scalar_data = {}
    for camel_key, val in body_dict.items():
        db_col = EVENT_SCALAR_MAP_REV.get(camel_key)
        if db_col is None:
            continue
        if camel_key == "eventId":
            continue  # event_id 由后端生成
        if camel_key in SCALAR_ENUM_FIELDS:
            _, api2db = SCALAR_ENUM_FIELDS[camel_key]
            val = _conv(val, api2db)
        scalar_data[db_col] = val

    # 默认值
    scalar_data.setdefault("状态", "已规划")

    with db.cursor() as cursor:
        event_id = _generate_event_id(cursor)

        # 构建环境岩体 JSON
        env_json = _build_env_json(body_dict, cursor)

        # 构建完整 INSERT 数据
        scalar_data["event_id"] = event_id
        scalar_data["炮孔设计"] = json.dumps([], ensure_ascii=False)
        scalar_data["断面掘进"] = json.dumps({}, ensure_ascii=False)
        scalar_data["装药起爆"] = json.dumps({}, ensure_ascii=False)
        scalar_data["爆破效果"] = json.dumps({}, ensure_ascii=False)
        scalar_data["环境岩体"] = json.dumps(env_json, ensure_ascii=False) if env_json else None

        cols = list(scalar_data.keys())
        placeholders = ", ".join(["%s"] * len(cols))
        col_sql = ", ".join([f"`{c}`" for c in cols])
        try:
            cursor.execute(
                f"INSERT INTO blasting_events ({col_sql}) VALUES ({placeholders})",
                list(scalar_data.values()),
            )
            db.commit()
        except MyIntegrityError:
            db.rollback()
            logger.exception("创建事件失败：数据库完整性冲突")
            raise HTTPException(status_code=409, detail="数据冲突，请检查唯一性约束")
        except MyOperationalError:
            db.rollback()
            logger.exception("创建事件失败：数据库操作失败")
            raise HTTPException(status_code=503, detail="数据库暂不可用")
        except Exception:
            db.rollback()
            logger.exception("创建事件失败：未预期的服务器错误")
            raise HTTPException(status_code=500, detail="服务器内部错误")

    return {"code": 0, "msg": "爆破事件创建成功", "data": {"eventId": event_id}}


@router.put("/events/{event_id}")
def update_event(event_id: str, body: BlastingEventUpdate, db: Connection = Depends(get_db)):
    """更新事件基本信息（标量列 + 环境岩体 JSON）"""
    # 将 Pydantic 模型转为 dict（使用 camelCase 别名，仅包含用户显式设置的字段）
    body_dict = body.model_dump(by_alias=True, exclude_unset=True)

    # 分离标量字段和环境字段
    scalar_updates = {}
    env_updates = {}

    for camel_key, val in body_dict.items():
        if camel_key in EVENT_SCALAR_MAP_REV:
            db_col = EVENT_SCALAR_MAP_REV[camel_key]
            if camel_key == "eventId":
                continue
            if camel_key in SCALAR_ENUM_FIELDS:
                _, api2db = SCALAR_ENUM_FIELDS[camel_key]
                val = _conv(val, api2db)
            scalar_updates[db_col] = val
        elif camel_key in ENV_EVENT_MAP_REV:
            cn_key = ENV_EVENT_MAP_REV[camel_key]
            if camel_key in ENV_ENUM_FIELDS:
                _, api2db = ENV_ENUM_FIELDS[camel_key]
                val = _conv(val, api2db)
            env_updates[cn_key] = val

    # rockParams 也需要更新环境岩体
    rock_body = body_dict.get("rockParams") or {}
    if rock_body:
        rock_json = _api_to_json_obj(rock_body, ENV_ROCK_MAP_REV, ENV_ENUM_FIELDS)
        env_updates.update(rock_json)

    # 若更新了岩体类型，同步更新环境岩体中的岩体参数
    if "rockType" in body_dict and "rockParams" not in body_dict:
        rock_cn = _conv(body.rock_type, ROCK_API2DB)
        # 标记需要从参考表更新
        env_updates["_need_rock_ref"] = rock_cn

    if not scalar_updates and not env_updates:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    with db.cursor() as cursor:
        if not _event_exists(cursor, event_id):
            raise HTTPException(status_code=404, detail="爆破事件未找到")

        try:
            # 更新标量列
            if scalar_updates:
                set_clause = ", ".join([f"`{k}`=%s" for k in scalar_updates.keys()])
                cursor.execute(
                    f"UPDATE blasting_events SET {set_clause} WHERE event_id=%s",
                    list(scalar_updates.values()) + [event_id],
                )

            # 更新环境岩体 JSON
            if env_updates:
                cursor.execute(
                    "SELECT `环境岩体` FROM blasting_events WHERE event_id = %s",
                    (event_id,),
                )
                row = cursor.fetchone()
                current_env = _parse_json_col(row.get("环境岩体")) or {}

                # 处理岩体参数参考表查询
                need_rock_ref = env_updates.pop("_need_rock_ref", None)
                if need_rock_ref:
                    cursor.execute(
                        "SELECT * FROM `岩体参数参考` WHERE `岩体类型` = %s",
                        (need_rock_ref,),
                    )
                    ref_row = cursor.fetchone()
                    if ref_row:
                        for col in ref_row:
                            if col != "更新时间":
                                current_env[col] = ref_row[col]

                current_env.update(env_updates)
                cursor.execute(
                    "UPDATE blasting_events SET `环境岩体`=%s WHERE event_id=%s",
                    (json.dumps(current_env, ensure_ascii=False), event_id),
                )

            db.commit()
        except MyIntegrityError:
            db.rollback()
            logger.exception("更新事件失败：数据库完整性冲突")
            raise HTTPException(status_code=409, detail="数据冲突，请检查唯一性约束")
        except MyOperationalError:
            db.rollback()
            logger.exception("更新事件失败：数据库操作失败")
            raise HTTPException(status_code=503, detail="数据库暂不可用")
        except Exception:
            db.rollback()
            logger.exception("更新事件失败：未预期的服务器错误")
            raise HTTPException(status_code=500, detail="服务器内部错误")

    return {"code": 0, "msg": "爆破事件更新成功"}


@router.delete("/events/{event_id}")
def delete_event(event_id: str, db: Connection = Depends(get_db)):
    """删除事件：单表删除（V2 无级联表）"""
    with db.cursor() as cursor:
        cursor.execute(
            "DELETE FROM blasting_events WHERE event_id=%s", (event_id,)
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="爆破事件未找到")
        db.commit()
    return {"code": 0, "msg": "爆破事件删除成功"}


# ============================================================
# 设计（2 个）
# ============================================================

@router.get("/events/{event_id}/design")
def get_design(event_id: str, db: Connection = Depends(get_db)):
    """获取爆破设计（断面掘进 + 装药起爆 + 炮孔设计 JSON 列）"""
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT `断面掘进`, `装药起爆`, `炮孔设计` FROM blasting_events WHERE event_id = %s",
            (event_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="爆破事件未找到")

    design, holes = _build_design(
        row.get("断面掘进"), row.get("装药起爆"), row.get("炮孔设计")
    )
    design["eventId"] = event_id
    return {"code": 0, "data": {"design": design, "holes": holes}}


@router.post("/events/{event_id}/design")
def save_design(event_id: str, body: BlastingDesignSave, db: Connection = Depends(get_db)):
    """保存爆破设计（更新断面掘进 + 装药起爆 + 炮孔设计 JSON 列）"""
    # 将 Pydantic 模型转为 dict（使用 camelCase 别名，与映射表一致）
    body_dict = body.model_dump(by_alias=True, exclude_none=True)
    body_dict.pop("holes", None)

    # 分离 tunnel / charge 字段
    tunnel_updates = {}
    charge_updates = {}

    for camel_key, val in body_dict.items():
        if camel_key in TUNNEL_JSON_MAP_REV:
            cn_key = TUNNEL_JSON_MAP_REV[camel_key]
            if camel_key in DESIGN_ENUM_FIELDS:
                _, api2db = DESIGN_ENUM_FIELDS[camel_key]
                val = _conv(val, api2db)
            tunnel_updates[cn_key] = val
        elif camel_key in CHARGE_JSON_MAP_REV:
            cn_key = CHARGE_JSON_MAP_REV[camel_key]
            if camel_key in DESIGN_ENUM_FIELDS:
                _, api2db = DESIGN_ENUM_FIELDS[camel_key]
                val = _conv(val, api2db)
            charge_updates[cn_key] = val

    with db.cursor() as cursor:
        if not _event_exists(cursor, event_id):
            raise HTTPException(status_code=404, detail="爆破事件未找到")
        try:
            # 读取当前 JSON 列
            cursor.execute(
                "SELECT `断面掘进`, `装药起爆` FROM blasting_events WHERE event_id = %s",
                (event_id,),
            )
            row = cursor.fetchone()
            current_tunnel = _parse_json_col(row.get("断面掘进")) or {}
            current_charge = _parse_json_col(row.get("装药起爆")) or {}

            # 合并更新
            current_tunnel.update(tunnel_updates)
            current_charge.update(charge_updates)

            # 转换 holes（Pydantic BlastingHoleInput 模型 → 中文 JSON）
            holes_json = []
            for idx, h in enumerate(body.holes):
                hole_dict = h.model_dump(by_alias=True, exclude_none=True)
                hole_obj = _api_to_json_obj(hole_dict, HOLES_JSON_MAP_REV, HOLES_ENUM_FIELDS)
                if "序号" not in hole_obj:
                    hole_obj["序号"] = idx + 1
                holes_json.append(hole_obj)

            cursor.execute(
                "UPDATE blasting_events SET `断面掘进`=%s, `装药起爆`=%s, `炮孔设计`=%s WHERE event_id=%s",
                (
                    json.dumps(current_tunnel, ensure_ascii=False),
                    json.dumps(current_charge, ensure_ascii=False),
                    json.dumps(holes_json, ensure_ascii=False),
                    event_id,
                ),
            )
            db.commit()
        except MyIntegrityError:
            db.rollback()
            logger.exception("保存设计失败：数据库完整性冲突")
            raise HTTPException(status_code=409, detail="数据冲突，请检查唯一性约束")
        except MyOperationalError:
            db.rollback()
            logger.exception("保存设计失败：数据库操作失败")
            raise HTTPException(status_code=503, detail="数据库暂不可用")
        except Exception:
            db.rollback()
            logger.exception("保存设计失败：未预期的服务器错误")
            raise HTTPException(status_code=500, detail="服务器内部错误")

    return {"code": 0, "msg": "爆破设计保存成功"}


# ============================================================
# 效果（2 个）
# ============================================================

@router.get("/events/{event_id}/result")
def get_result(event_id: str, db: Connection = Depends(get_db)):
    """获取爆破效果（爆破效果 JSON 列）"""
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT `爆破效果` FROM blasting_events WHERE event_id = %s",
            (event_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="爆破事件未找到")

    result = _build_result(row.get("爆破效果"))
    result["eventId"] = event_id
    return {"code": 0, "data": result}


@router.put("/events/{event_id}/result")
def update_result(event_id: str, body: BlastingResultSave, db: Connection = Depends(get_db)):
    """更新爆破效果（爆破效果 JSON 列）"""
    body_dict = body.model_dump(by_alias=True, exclude_unset=True)
    result_updates = _api_to_json_obj(body_dict, RESULT_JSON_MAP_REV)

    if not result_updates:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    with db.cursor() as cursor:
        if not _event_exists(cursor, event_id):
            raise HTTPException(status_code=404, detail="爆破事件未找到")
        try:
            # 读取当前爆破效果 JSON
            cursor.execute(
                "SELECT `爆破效果` FROM blasting_events WHERE event_id = %s",
                (event_id,),
            )
            row = cursor.fetchone()
            current_result = _parse_json_col(row.get("爆破效果")) or {}

            # 合并更新
            current_result.update(result_updates)

            cursor.execute(
                "UPDATE blasting_events SET `爆破效果`=%s WHERE event_id=%s",
                (json.dumps(current_result, ensure_ascii=False), event_id),
            )
            db.commit()
        except MyIntegrityError:
            db.rollback()
            logger.exception("更新效果失败：数据库完整性冲突")
            raise HTTPException(status_code=409, detail="数据冲突，请检查唯一性约束")
        except MyOperationalError:
            db.rollback()
            logger.exception("更新效果失败：数据库操作失败")
            raise HTTPException(status_code=503, detail="数据库暂不可用")
        except Exception:
            db.rollback()
            logger.exception("更新效果失败：未预期的服务器错误")
            raise HTTPException(status_code=500, detail="服务器内部错误")

    return {"code": 0, "msg": "爆破效果更新成功"}


# ============================================================
# 对比（1 个）
# ============================================================

@router.post("/results/compare")
def compare_results(body: BlastingCompareRequest, db: Connection = Depends(get_db)):
    """多事件效果对比：批量取爆破效果 JSON，转 snake_case 调用 compare 服务

    Task 10：原实现按 event_id 逐条 SELECT（N+1 查询），改为单条
    `WHERE event_id IN (...)` 参数化查询，显著降低 DB 往返次数。
    响应结构保持不变（results 数组按入参顺序，跳过不存在的事件）。
    """
    event_ids = body.event_ids

    # 单条 IN 查询（参数化占位符避免 SQL 注入）
    placeholders = ",".join(["%s"] * len(event_ids))
    sql = (
        f"SELECT event_id, `爆破效果` FROM blasting_events "
        f"WHERE event_id IN ({placeholders})"
    )
    with db.cursor() as cursor:
        cursor.execute(sql, event_ids)
        rows = cursor.fetchall()

    # 构建 event_id → row 映射，按入参顺序遍历以保持响应顺序一致
    row_map = {row["event_id"]: row for row in rows}

    raw_results = []
    camel_results = []
    for eid in event_ids:
        row = row_map.get(eid)
        if not row:
            continue
        result_json = _parse_json_col(row.get("爆破效果")) or {}
        # 转为 V1 snake_case 格式（compare 服务依赖）
        snake_result = {"event_id": eid}
        for cn_key, snake_key in RESULT_JSON_TO_SNAKE.items():
            if cn_key in result_json:
                snake_result[snake_key] = result_json[cn_key]
        raw_results.append(snake_result)
        camel_results.append(_build_result(row.get("爆破效果")))

    comparison = compare_multiple_events(raw_results)
    # 服务返回的 metric 名与 event_id 转 camelCase
    comparison_camel = {
        COMPARE_METRIC_CAMEL.get(m, m): [
            {"eventId": it.get("event_id"), "value": it.get("value")}
            for it in items
        ]
        for m, items in comparison.items()
    }
    return {"code": 0, "data": {"results": camel_results, "comparison": comparison_camel}}


# ============================================================
# 服务层接入（3 个）
# ============================================================

@router.post("/validate/kco")
def validate_kco(body: KCOValidateRequest):
    """KCO 碎块分布模型验证（调用 kco_validator.calculate_kco）"""
    try:
        inp = KCOInput(**body.model_dump())
        out = calculate_kco(inp)
    except (TypeError, ValueError) as e:
        logger.warning(f"KCO 参数验证失败: {e}")
        raise HTTPException(status_code=400, detail=f"参数错误: {e}")
    return {"code": 0, "data": {
        "x50": out.x50,
        "n": out.n,
        "x80": out.x80,
        "uniformity": out.uniformity,
        "oversizeRatio": out.oversize_ratio,
    }}


@router.post("/physics/jwl")
def physics_jwl(body: JWLRequest):
    """JWL 状态方程计算爆生气压力（调用 blast_physics.jwl_pressure）

    jwl_pressure 签名仅需 relative_volume 与 explosive_type，无需完整 BlastSource
    （Task 7.5：移除冗余的 BlastSource 构造，直接传 body.explosive_type）。
    """
    pressure = jwl_pressure(body.relative_volume, body.explosive_type)
    return {"code": 0, "data": {
        "pressure": pressure,
        "relativeVolume": body.relative_volume,
        "explosiveType": body.explosive_type,
    }}


@router.post("/physics/vibration")
def physics_vibration(body: VibrationRequest):
    """萨道斯基振动预测（调用 blast_physics.sadosky_vibration）"""
    if body.rock:
        rock = RockMedium(**body.rock.model_dump())
    else:
        rock = RockMedium()
    velocity = sadosky_vibration(body.charge_kg, body.distance, rock)
    return {"code": 0, "data": {
        "velocity": velocity,
        "chargeKg": body.charge_kg,
        "distance": body.distance,
    }}


# ============================================================
# 阶段五：PPV 振动速度场 / 损伤区 / JWL 曲线（科学计算 API）
# ============================================================

@router.post("/ppv-field", response_model=PPVFieldResponse)
def compute_ppv_field(req: PPVFieldRequest):
    """计算二维 PPV 振动速度场

    返回 PPV 矩阵（base64 编码的 float32 二进制）+ 网格坐标。

    数据压缩设计：
    - 默认分辨率 100×100（原 200×200 数据量 4 倍降低）
    - PPV 矩阵以 base64(float32) 返回，体积约 40KB（原 JSON 约 400KB）
    - 前端解码：Float32Array.from(base64.decode(buf))
    """
    # 限制最大分辨率，避免恶意请求导致后端 OOM
    nx = min(req.nx, 200)
    ny = min(req.ny, 200)
    grid_x = np.linspace(req.x_min, req.x_max, nx)
    grid_y = np.linspace(req.y_min, req.y_max, ny)
    source = BlastSource(
        charge_kg=req.charge_kg,
        explosive_type=req.explosive_type,
    )
    rock_kwargs = {}
    if req.p_wave_speed is not None:
        rock_kwargs["p_wave_speed"] = req.p_wave_speed
    if req.attenuation_p is not None:
        rock_kwargs["attenuation_p"] = req.attenuation_p
    if req.rock_ucs is not None:
        rock_kwargs["ucs"] = req.rock_ucs
    if req.site_K is not None:
        rock_kwargs["site_K"] = req.site_K
    if req.site_alpha is not None:
        rock_kwargs["site_alpha"] = req.site_alpha
    rock = RockMedium(**rock_kwargs)
    field = wave_field_2d(grid_x, grid_y, req.time, source, rock)
    # 编码：float32 → bytes → base64
    field_bytes = field.astype(np.float32).tobytes()
    field_b64 = base64.b64encode(field_bytes).decode("ascii")
    return PPVFieldResponse(
        nx=nx,
        ny=ny,
        grid_x=grid_x.tolist(),
        grid_y=grid_y.tolist(),
        ppv_b64=field_b64,
        ppv_dtype="float32",
        max_ppv=float(field.max()),
        mean_ppv=float(field.mean()),
    )


@router.post("/damage-zones", response_model=DamageZoneResponse)
def compute_damage_zones(req: DamageZoneRequest):
    """计算爆破损伤区半径（粉碎区 / 裂隙区 / 弹性区）

    基于 Holmberg-Persson 模型：
      r_crushed  = r_charge × (P_det / σ_cd)^(1/β)
      r_fractured = r_crushed × (σ_cd / σ_td)^(1/β)
    其中 β=2.5（柱面-球面过渡），σ_cd = 1.8×UCS, σ_td = 1.5×Tensile
    """
    r_charge = (3 * req.charge_kg / (4 * np.pi * req.explosive_density)) ** (1 / 3)
    p_det = req.explosive_density * (req.VoD ** 2) / 4
    zones = damage_zone_radii(
        charge_radius=float(r_charge),
        rock_ucs=req.rock_ucs,
        rock_tensile=req.rock_tensile,
        p_detonation=float(p_det),
    )
    # elastic_zone_start 字段说明（schemas.py 中 DamageZoneResponse 不可修改，在此标注）：
    # 弹性区起始半径(m)，弹性区从此处延伸至无穷远，无外边界
    # （elastic_zone_start = fractured_radius，Task 3.1 后 elastic_radius 返回 None，
    #   此处仍取 zones["elastic_radius"] 兼容旧服务层；若为 None 则由 Response 序列化为 null）
    return DamageZoneResponse(
        charge_radius=float(r_charge),
        detonation_pressure=float(p_det),
        crushed_radius=zones["crushed_radius"],
        fractured_radius=zones["fractured_radius"],
        elastic_zone_start=zones["elastic_radius"],
    )


@router.post("/jwl-curve", response_model=JWLCurveResponse)
def compute_jwl_curve(req: JWLCurveRequest):
    """计算 JWL 等熵膨胀曲线（P-V 关系）

    返回 100 个对数采样点（V: 0.1 ~ 100），用于设计评审可视化。
    """
    v_ratios = np.logspace(np.log10(0.1), np.log10(100), 100)
    pressures = jwl_isentrope(v_ratios, req.explosive_type)
    return JWLCurveResponse(
        relative_volume=v_ratios.tolist(),
        pressure_pa=pressures.tolist(),
    )


@router.post("/calibrate", response_model=CalibrateResponse, summary="萨道夫斯基常数实测反演")
def calibrate_sadosky(req: CalibrateRequest):
    """根据实测 (charge_kg, distance, ppv) 数据，最小二乘反演萨道夫斯基 K 与 α

    模型：PPV = K * (Q^(1/3)/R)^α
    线性化：log(PPV) = log(K) + α * log(Q^(1/3)/R)
    即 y = a + b*x，其中 a=log(K)，b=α，反演 K = exp(a)。
    返回 K、α 与拟合决定系数 R²。
    """
    if len(req.measurements) < 3:
        raise HTTPException(status_code=400, detail="至少需要 3 组实测数据")
    # 构造线性回归变量
    x = np.array([np.log(m.charge_kg ** (1 / 3) / m.distance) for m in req.measurements])
    y = np.array([np.log(m.ppv) for m in req.measurements])
    # 最小二乘：y = a + b*x，其中 a=log(K), b=alpha
    try:
        coeffs = np.polyfit(x, y, 1)
    except Exception:
        logger.exception("萨道夫斯基反演失败")
        raise HTTPException(status_code=500, detail="反演计算失败")
    b, a = coeffs  # polyfit 返回高次到低次
    K = float(np.exp(a))
    alpha = float(b)
    # R² 计算
    y_pred = a + b * x
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return CalibrateResponse(K=K, alpha=alpha, r_squared=r_squared)
