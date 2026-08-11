"""爆破模块路由 — 关系型 4 业务表 + 1 字典表设计

表结构：
  - blasting_events        事件主表（每事件 1 行，无上限）
  - blasting_design        设计表（与事件 1:1）
  - blasting_design_holes  炮孔表（与事件 1:N，每孔 1 行）
  - blasting_result        效果表（与事件 1:1）
  - rock_params            岩体参数字典表（独立于事件）

旧 5 扁平表设计（blasting_event_001~005 + _get_table_by_event_id）已废弃。
"""
import json
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pymysql import Connection

from app.database import get_db
from app.services.blasting.kco_validator import KCOInput, calculate_kco
from app.services.blasting.blast_physics import (
    BlastSource,
    RockMedium,
    jwl_pressure,
    sadosky_vibration,
)
from app.services.blasting.compare import compare_multiple_events
from app.schemas import KCOValidateRequest, JwlRequest, VibrationRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/blasting", redirect_slashes=False, tags=["爆破模拟"])

# ============================================================
# 显式字段映射表（DB snake_case → API camelCase）
# 不依赖 re.sub，逐字段显式声明
# ============================================================

EVENT_FIELDS = {
    "event_id": "eventId",
    "name": "name",
    "center_lon": "centerLon",
    "center_lat": "centerLat",
    "center_height": "centerHeight",
    "charge_kg": "chargeKg",
    "explosive_type": "explosiveType",
    "detonation_method": "detonationMethod",
    "blast_time": "blastTime",
    "rock_type": "rockType",
    "weather": "weather",
    "temperature": "temperature",
    "wind_speed": "windSpeed",
    "wind_direction": "windDirection",
    "status": "status",
    "description": "description",
}

DESIGN_FIELDS = {
    "event_id": "eventId",
    "tunnel_shape": "tunnelShape",
    "tunnel_width": "tunnelWidth",
    "tunnel_wall_height": "tunnelWallHeight",
    "tunnel_arch_radius": "tunnelArchRadius",
    "tunnel_total_height": "tunnelTotalHeight",
    "tunnel_length": "tunnelLength",
    "face_thickness": "faceThickness",
    "face_offset": "faceOffset",
    "cut_pattern": "cutPattern",
    "cut_angle": "cutAngle",
    "cut_hole_count": "cutHoleCount",
    "empty_hole_count": "emptyHoleCount",
    "initiation_network": "initiationNetwork",
    "delay_interval_ms": "delayIntervalMs",
    "charge_density_cut": "chargeDensityCut",
    "charge_density_aux": "chargeDensityAux",
    "charge_density_perim": "chargeDensityPerim",
    "stemming_length": "stemmingLength",
    "hole_depth": "holeDepth",
    "hole_diameter": "holeDiameter",
    "utilization": "utilization",
    "advance_length": "advanceLength",
    "expected_x50": "expectedX50",
    "expected_xmax": "expectedXmax",
    "expected_throw_distance": "expectedThrowDistance",
    "expected_overbreak": "expectedOverbreak",
    "min_safety_distance": "minSafetyDistance",
    "max_vibration_velocity": "maxVibrationVelocity",
}

HOLE_FIELDS = {
    "event_id": "eventId",
    "hole_index": "holeIndex",
    "pos_x": "posX",
    "pos_y": "posY",
    "pos_z": "posZ",
    "hole_type": "holeType",
    "diameter": "diameter",
    "depth": "depth",
    "inclination_angle": "inclinationAngle",
    "inclination_azimuth": "inclinationAzimuth",
    "charge_kg": "chargeKg",
    "charge_length": "chargeLength",
    "explosive_type": "explosiveType",
    "detonator_series": "detonatorSeries",
    "delay_ms": "delayMs",
    "is_empty_hole": "isEmptyHole",
}

RESULT_FIELDS = {
    "event_id": "eventId",
    "random_seed": "randomSeed",
    "simulation_duration_s": "simulationDurationS",
    "time_step_s": "timeStepS",
    "crater_depth": "craterDepth",
    "crater_radius": "craterRadius",
    "crater_center_offset_y": "craterCenterOffsetY",
    "overbreak_max": "overbreakMax",
    "overbreak_min": "overbreakMin",
    "half_barrel_ratio": "halfBarrelRatio",
    "fragment_count": "fragmentCount",
    "fragment_count_target": "fragmentCountTarget",
    "fragment_count_generated": "fragmentCountGenerated",
    "fragment_count_rendered": "fragmentCountRendered",
    "fragment_mass_target_kg": "fragmentMassTargetKg",
    "fragment_mass_generated_kg": "fragmentMassGeneratedKg",
    "fragment_volume_target": "fragmentVolumeTarget",
    "fragment_volume_generated": "fragmentVolumeGenerated",
    "fragment_histogram_json": "fragmentHistogramJson",
    "velocity_histogram_json": "velocityHistogramJson",
    "throw_distance_histogram_json": "throwDistanceHistogramJson",
    "render_scale_mode": "renderScaleMode",
    "render_scale_bias": "renderScaleBias",
    "fragment_x50": "fragmentX50",
    "fragment_x80": "fragmentX80",
    "fragment_xmax": "fragmentXmax",
    "fragment_b": "fragmentB",
    "fragment_n": "fragmentN",
    "throw_distance_max": "throwDistanceMax",
    "throw_distance_avg": "throwDistanceAvg",
    "spread_angle": "spreadAngle",
    "vibration_peak": "vibrationPeak",
    "vibration_velocity_max": "vibrationVelocityMax",
    "stress_peak_mpa": "stressPeakMpa",
    "min_safety_factor": "minSafetyFactor",
    "smoke_intensity": "smokeIntensity",
    "dust_intensity": "dustIntensity",
    "fire_intensity": "fireIntensity",
    "spark_intensity": "sparkIntensity",
    "shockwave_speed_factor": "shockwaveSpeedFactor",
}

RUNTIME_STATS_FIELDS = {
    "id": "id",
    "event_id": "eventId",
    "random_seed": "randomSeed",
    "algorithm_version": "algorithmVersion",
    "params_snapshot": "paramsSnapshot",
    "stats_snapshot": "statsSnapshot",
    "created_at": "createdAt",
}
RUNTIME_STATS_FIELDS_REV = {v: k for k, v in RUNTIME_STATS_FIELDS.items() if v != "id"}

ROCK_PARAMS_FIELDS = {
    "rock_type": "rockType",
    "density": "density",
    "youngs_modulus": "youngsModulus",
    "compressive_strength": "compressiveStrength",
    "p_wave_speed": "pWaveSpeed",
    "s_wave_speed": "sWaveSpeed",
}

# camelCase → snake_case 反向映射（解析请求体用）
EVENT_FIELDS_REV = {v: k for k, v in EVENT_FIELDS.items()}
DESIGN_FIELDS_REV = {v: k for k, v in DESIGN_FIELDS.items()}
HOLE_FIELDS_REV = {v: k for k, v in HOLE_FIELDS.items()}
RESULT_FIELDS_REV = {v: k for k, v in RESULT_FIELDS.items()}

# 对比矩阵 metric 名转换（compare 服务输出 snake_case，响应统一转 camelCase）
COMPARE_METRIC_CAMEL = {
    "fragment_x50": "fragmentX50",
    "throw_distance_max": "throwDistanceMax",
    "vibration_peak": "vibrationPeak",
}

LEGACY_STATUS_TO_API = {
    "已规划": "planned",
    "已执行": "executed",
    "已中止": "aborted",
}
API_STATUS_TO_LEGACY = {v: k for k, v in LEGACY_STATUS_TO_API.items()}

LEGACY_SHAPE_TO_API = {
    "马蹄形": "horseshoe",
    "圆形": "circular",
    "矩形": "rectangular",
}

LEGACY_CUT_PATTERN_TO_API = {
    "四段掏槽": "four_section",
    "单螺旋掏槽": "single_spiral",
    "双螺旋掏槽": "double_spiral",
    "楔形掏槽": "wedge",
    "直眼掏槽": "burn",
}

LEGACY_INITIATION_TO_API = {
    "电雷管": "electric",
    "导爆管": "nonel",
    "电子雷管": "electronic",
    "导爆索": "detonating_cord",
}

LEGACY_HOLE_TYPE_TO_API = {
    "掏槽孔": "cut",
    "辅助孔": "auxiliary",
    "周边孔": "perimeter",
    "空孔": "empty",
}

LEGACY_EXPLOSIVE_TO_API = {
    "乳化炸药": "emulsion",
    "铵油炸药": "anfo",
    "炸药": "dynamite",
}


# ============================================================
# 工具函数
# ============================================================

def _to_camel(row: dict, mapping: dict) -> dict:
    """将 DB 行（snake_case）转为 camelCase 字典，仅包含 mapping 中存在的字段"""
    if not row:
        return {}
    return {mapping[k]: row[k] for k in mapping if k in row}


def _from_camel(body: dict, rev_mapping: dict) -> dict:
    """将 camelCase 请求体转为 snake_case 字典，仅包含 rev_mapping 中存在的字段"""
    if not body:
        return {}
    return {rev_mapping[k]: v for k, v in body.items() if k in rev_mapping}


def _select_cols(mapping: dict) -> str:
    """根据映射表生成 SELECT 列名列表（snake_case）"""
    return ", ".join(mapping.keys())


def _json_load(value, default):
    """兼容 MySQL JSON/TEXT 字段：支持 dict/list/JSON 字符串/空值"""
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return default
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return default


def _table_columns(cursor, table_name: str) -> set[str]:
    """获取表字段集合；表不存在时返回空集合"""
    try:
        cursor.execute(f"SHOW COLUMNS FROM `{table_name}`")
    except Exception:
        return set()
    return {row["Field"] for row in cursor.fetchall()}


def _use_legacy_blasting_schema(cursor) -> bool:
    """当前 blasting_events 是否仍为旧中文列 + JSON 扁平表结构"""
    columns = _table_columns(cursor, "blasting_events")
    return "名称" in columns and "name" not in columns


def _legacy_to_api(value, mapping: dict, default=None):
    if value is None:
        return default
    return mapping.get(value, value)


def _legacy_rock_params_to_camel(rock_payload: dict) -> dict:
    if not rock_payload:
        return {}
    return {
        "rockType": rock_payload.get("岩体类型"),
        "density": rock_payload.get("密度_kgm3"),
        # 旧库以 GPa / MPa 存储，前端只消费数值，这里保持原始量级
        "youngsModulus": rock_payload.get("弹性模量_GPa"),
        "compressiveStrength": rock_payload.get("抗压强度_MPa"),
        "pWaveSpeed": rock_payload.get("P波波速_ms"),
        "sWaveSpeed": rock_payload.get("S波波速_ms"),
    }


def _legacy_holes_to_camel(value) -> list:
    holes = _json_load(value, [])
    if not isinstance(holes, list):
        return []
    out = []
    for idx, hole in enumerate(holes):
        if not isinstance(hole, dict):
            continue
        is_empty = bool(hole.get("是否空孔"))
        hole_type = "empty" if is_empty else _legacy_to_api(
            hole.get("孔类型"), LEGACY_HOLE_TYPE_TO_API, "auxiliary"
        )
        out.append({
            "eventId": None,
            "holeIndex": hole.get("序号", idx),
            "posX": hole.get("X坐标_m", 0),
            "posY": hole.get("Y坐标_m", 0),
            "posZ": hole.get("Z坐标_m", 0),
            "holeType": hole_type,
            "diameter": hole.get("孔径_m"),
            "depth": hole.get("孔深_m"),
            "inclinationAngle": hole.get("倾角_度", 0),
            "inclinationAzimuth": hole.get("方位角_度", 0),
            "chargeKg": hole.get("装药量_kg", 0),
            "chargeLength": hole.get("装药长度_m", 0),
            "explosiveType": _legacy_to_api(
                hole.get("炸药类型"), LEGACY_EXPLOSIVE_TO_API, hole.get("炸药类型")
            ),
            "detonatorSeries": hole.get("雷管段别"),
            "delayMs": hole.get("延期时间_ms", 0),
            "isEmptyHole": is_empty,
        })
    return out


def _legacy_event_to_camel(row: dict) -> dict:
    rock = _json_load(row.get("环境岩体"), {})
    event = {
        "eventId": row.get("event_id"),
        "name": row.get("名称"),
        "centerLon": row.get("爆心经度"),
        "centerLat": row.get("爆心纬度"),
        "centerHeight": row.get("爆心高程", 0),
        "chargeKg": row.get("总装药量_kg"),
        "explosiveType": _legacy_to_api(
            row.get("炸药类型"), LEGACY_EXPLOSIVE_TO_API, row.get("炸药类型")
        ),
        "detonationMethod": row.get("起爆方式"),
        "blastTime": row.get("爆破时间"),
        "rockType": row.get("岩体类型") or rock.get("岩体类型"),
        "weather": rock.get("天气"),
        "temperature": rock.get("温度_摄氏度"),
        "windSpeed": rock.get("风速_ms"),
        "windDirection": rock.get("风向_度"),
        "status": _legacy_to_api(row.get("状态"), LEGACY_STATUS_TO_API, row.get("状态")),
        "description": row.get("备注"),
    }
    event["rockParams"] = _legacy_rock_params_to_camel(rock)
    return event


def _legacy_design_to_camel(row: dict) -> dict:
    section = _json_load(row.get("断面掘进"), {})
    charge = _json_load(row.get("装药起爆"), {})
    return {
        "eventId": row.get("event_id"),
        "tunnelShape": _legacy_to_api(
            section.get("断面形状"), LEGACY_SHAPE_TO_API, "horseshoe"
        ),
        "tunnelWidth": section.get("断面宽度_m"),
        "tunnelWallHeight": section.get("直墙高度_m"),
        "tunnelArchRadius": section.get("拱部半径_m"),
        "tunnelTotalHeight": section.get("断面总高度_m"),
        "tunnelLength": section.get("已开挖长度_m"),
        "faceThickness": section.get("掌子面厚度_m"),
        "faceOffset": section.get("掌子面距爆心_m"),
        "cutPattern": _legacy_to_api(
            charge.get("掏槽模式"), LEGACY_CUT_PATTERN_TO_API, charge.get("掏槽模式")
        ),
        "cutAngle": charge.get("楔形掏槽角_度"),
        "cutHoleCount": charge.get("装药掏槽孔数"),
        "emptyHoleCount": charge.get("空孔数"),
        "initiationNetwork": _legacy_to_api(
            charge.get("起爆网络"), LEGACY_INITIATION_TO_API, charge.get("起爆网络")
        ),
        "delayIntervalMs": charge.get("段间延时间隔_ms"),
        "chargeDensityCut": charge.get("掏槽线装药密度_kgm"),
        "chargeDensityAux": charge.get("辅助线装药密度_kgm"),
        "chargeDensityPerim": charge.get("周边线装药密度_kgm"),
        "stemmingLength": charge.get("堵塞长度_m"),
        "holeDepth": section.get("钻孔深度_m"),
        "holeDiameter": section.get("钻孔直径_m"),
        "utilization": section.get("炮孔利用率"),
        "advanceLength": section.get("单循环进尺_m"),
        "minSafetyDistance": None,
        "maxVibrationVelocity": None,
    }


def _legacy_result_to_camel(row: dict) -> dict:
    effect = _json_load(row.get("爆破效果"), {})
    return {
        "eventId": row.get("event_id"),
        "randomSeed": effect.get("模拟随机种子"),
        "simulationDurationS": effect.get("模拟总时长_s"),
        "timeStepS": effect.get("时间步长_s"),
        "craterDepth": effect.get("漏斗深度_m"),
        "craterRadius": effect.get("漏斗半径_m"),
        "craterCenterOffsetY": effect.get("漏斗中心偏移_m"),
        "overbreakMax": effect.get("最大超挖_m"),
        "overbreakMin": effect.get("最小超挖_m"),
        "halfBarrelRatio": effect.get("半孔率"),
        "fragmentCount": effect.get("碎片总数"),
        "fragmentX50": effect.get("中位块度_x50_m"),
        "fragmentX80": effect.get("80通过块度_x80_m"),
        "fragmentXmax": effect.get("最大块度_xmax_m"),
        "fragmentB": effect.get("Swebrec弯曲参数_b"),
        "fragmentN": effect.get("Cunningham均匀指数_n"),
        "throwDistanceMax": effect.get("最大抛掷距离_m"),
        "throwDistanceAvg": effect.get("平均抛掷距离_m"),
        "spreadAngle": effect.get("抛掷扩散角_度"),
        "vibrationPeak": effect.get("峰值振动_Kine"),
        "vibrationVelocityMax": effect.get("最大质点振速_cms"),
        "stressPeakMpa": effect.get("峰值应力_MPa"),
        "minSafetyFactor": effect.get("最小安全系数"),
        "smokeIntensity": effect.get("烟雾强度"),
        "dustIntensity": effect.get("粉尘强度"),
        "fireIntensity": effect.get("火球强度"),
        "sparkIntensity": effect.get("火花强度"),
        "shockwaveSpeedFactor": effect.get("冲击波速度系数"),
    }


def _legacy_result_to_raw(row: dict) -> dict:
    camel = _legacy_result_to_camel(row)
    return {
        db_key: camel.get(api_key)
        for db_key, api_key in RESULT_FIELDS.items()
    }


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


def _get_holes(cursor, event_id: str) -> list:
    """查询事件炮孔列表（按 hole_index 升序）并转 camelCase"""
    cursor.execute(
        f"SELECT {_select_cols(HOLE_FIELDS)} "
        f"FROM blasting_design_holes WHERE event_id = %s ORDER BY hole_index",
        (event_id,),
    )
    return [_to_camel(r, HOLE_FIELDS) for r in cursor.fetchall()]


def _get_rock_params(cursor, rock_type: str) -> dict:
    """查询岩体参数字典（按 rock_type 主键）"""
    if not rock_type:
        return {}
    cursor.execute(
        f"SELECT {_select_cols(ROCK_PARAMS_FIELDS)} "
        f"FROM rock_params WHERE rock_type = %s",
        (rock_type,),
    )
    row = cursor.fetchone()
    return _to_camel(row, ROCK_PARAMS_FIELDS) if row else {}


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
    """列出所有爆破事件（单表查询 blasting_events，按 blast_time 倒序）"""
    with db.cursor() as cursor:
        if _use_legacy_blasting_schema(cursor):
            sql = "SELECT * FROM blasting_events"
            params = []
            if status:
                sql += " WHERE `状态` = %s"
                params.append(API_STATUS_TO_LEGACY.get(status, status))
            sql += " ORDER BY `爆破时间` DESC"
            cursor.execute(sql, params)
            rows = cursor.fetchall()
            return {"code": 0, "data": [_legacy_event_to_camel(r) for r in rows]}

        sql = f"SELECT {_select_cols(EVENT_FIELDS)} FROM blasting_events"
        params = []
        if status:
            sql += " WHERE status = %s"
            params.append(status)
        sql += " ORDER BY blast_time DESC"
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    events = [_to_camel(r, EVENT_FIELDS) for r in rows]
    return {"code": 0, "data": events}


@router.get("/events/{event_id}")
def get_event(event_id: str, db: Connection = Depends(get_db)):
    """获取事件详情：4 表关联 + rock_params，holes 单独查询，组装 {event, design, result}"""
    with db.cursor() as cursor:
        if _use_legacy_blasting_schema(cursor):
            cursor.execute("SELECT * FROM blasting_events WHERE event_id = %s", (event_id,))
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="爆破事件未找到")
            event = _legacy_event_to_camel(row)
            design = _legacy_design_to_camel(row)
            design["holes"] = _legacy_holes_to_camel(row.get("炮孔设计"))
            result = _legacy_result_to_camel(row)
            return {"code": 0, "data": {"event": event, "design": design, "result": result}}

        cursor.execute(
            f"SELECT {_select_cols(EVENT_FIELDS)} "
            f"FROM blasting_events WHERE event_id = %s",
            (event_id,),
        )
        event_row = cursor.fetchone()
        if not event_row:
            raise HTTPException(status_code=404, detail="爆破事件未找到")

        cursor.execute(
            f"SELECT {_select_cols(DESIGN_FIELDS)} "
            f"FROM blasting_design WHERE event_id = %s",
            (event_id,),
        )
        design_row = cursor.fetchone()

        cursor.execute(
            f"SELECT {_select_cols(RESULT_FIELDS)} "
            f"FROM blasting_result WHERE event_id = %s",
            (event_id,),
        )
        result_row = cursor.fetchone()

        holes = _get_holes(cursor, event_id)
        rock_params = _get_rock_params(cursor, event_row.get("rock_type"))

    event = _to_camel(event_row, EVENT_FIELDS)
    event["rockParams"] = rock_params
    design = _to_camel(design_row, DESIGN_FIELDS)
    design["holes"] = holes
    result = _to_camel(result_row, RESULT_FIELDS)
    return {"code": 0, "data": {"event": event, "design": design, "result": result}}


@router.post("/events")
@router.post("/events/")
def create_event(body: dict, db: Connection = Depends(get_db)):
    """创建事件：INSERT blasting_events + 级联创建 blasting_design/blasting_result 空行"""
    data = _from_camel(body, EVENT_FIELDS_REV)
    data.pop("event_id", None)  # event_id 始终由后端生成

    # 必填字段校验（NOT NULL 且无默认值的字段）
    required = ["name", "center_lon", "center_lat", "charge_kg", "blast_time", "rock_type"]
    missing = [f for f in required if f not in data or data[f] is None]
    if missing:
        raise HTTPException(status_code=400, detail=f"缺少必填字段: {missing}")

    data.setdefault("status", "planned")

    with db.cursor() as cursor:
        event_id = _generate_event_id(cursor)
        data["event_id"] = event_id

        cols = list(data.keys())
        placeholders = ", ".join(["%s"] * len(cols))
        col_sql = ", ".join(cols)
        try:
            cursor.execute(
                f"INSERT INTO blasting_events ({col_sql}) VALUES ({placeholders})",
                list(data.values()),
            )
            # 级联创建 design 空行（其余字段依赖 DB 默认值）
            cursor.execute(
                "INSERT INTO blasting_design (event_id) VALUES (%s)", (event_id,)
            )
            # 级联创建 result 空行
            cursor.execute(
                "INSERT INTO blasting_result (event_id) VALUES (%s)", (event_id,)
            )
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error("创建事件失败 event_id=%s: %s", event_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=f"创建事件失败: {e}")

    return {"code": 0, "msg": "爆破事件创建成功", "data": {"eventId": event_id}}


@router.put("/events/{event_id}")
def update_event(event_id: str, body: dict, db: Connection = Depends(get_db)):
    """更新事件基本信息（blasting_events 表，不允许修改 event_id）"""
    data = _from_camel(body, EVENT_FIELDS_REV)
    data.pop("event_id", None)
    if not data:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    set_clause = ", ".join([f"{k}=%s" for k in data.keys()])
    values = list(data.values()) + [event_id]
    with db.cursor() as cursor:
        if not _event_exists(cursor, event_id):
            raise HTTPException(status_code=404, detail="爆破事件未找到")
        cursor.execute(
            f"UPDATE blasting_events SET {set_clause} WHERE event_id=%s", values
        )
        db.commit()
    return {"code": 0, "msg": "爆破事件更新成功"}


@router.delete("/events/{event_id}")
def delete_event(event_id: str, db: Connection = Depends(get_db)):
    """删除事件：blasting_events 删除后，design/holes/result 通过 ON DELETE CASCADE 自动级联"""
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
    """获取爆破设计（design 表 + holes 列表）"""
    with db.cursor() as cursor:
        if _use_legacy_blasting_schema(cursor):
            cursor.execute("SELECT * FROM blasting_events WHERE event_id = %s", (event_id,))
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="爆破设计未找到")
            return {
                "code": 0,
                "data": {
                    "design": _legacy_design_to_camel(row),
                    "holes": _legacy_holes_to_camel(row.get("炮孔设计")),
                },
            }

        cursor.execute(
            f"SELECT {_select_cols(DESIGN_FIELDS)} "
            f"FROM blasting_design WHERE event_id = %s",
            (event_id,),
        )
        design_row = cursor.fetchone()
        if not design_row:
            raise HTTPException(status_code=404, detail="爆破设计未找到")
        holes = _get_holes(cursor, event_id)
    design = _to_camel(design_row, DESIGN_FIELDS)
    return {"code": 0, "data": {"design": design, "holes": holes}}


@router.post("/events/{event_id}/design")
def save_design(event_id: str, body: dict, db: Connection = Depends(get_db)):
    """保存爆破设计（事务：upsert blasting_design + 批量替换 blasting_design_holes）"""
    design_data = _from_camel(body, DESIGN_FIELDS_REV)
    design_data.pop("event_id", None)
    holes = body.get("holes") or []

    with db.cursor() as cursor:
        if not _event_exists(cursor, event_id):
            raise HTTPException(status_code=404, detail="爆破事件未找到")
        try:
            # 1) upsert blasting_design（uk_event_id 触发 ON DUPLICATE KEY UPDATE）
            if design_data:
                cols = list(design_data.keys())
                col_sql = ", ".join(["event_id"] + cols)
                placeholders = ", ".join(["%s"] * (len(cols) + 1))
                set_clause = ", ".join([f"{k}=%s" for k in cols])
                update_vals = list(design_data.values())
                cursor.execute(
                    f"INSERT INTO blasting_design ({col_sql}) VALUES ({placeholders}) "
                    f"ON DUPLICATE KEY UPDATE {set_clause}",
                    [event_id] + update_vals + update_vals,
                )

            # 2) 删除旧 holes
            cursor.execute(
                "DELETE FROM blasting_design_holes WHERE event_id=%s", (event_id,)
            )

            # 3) 批量插入新 holes
            for idx, h in enumerate(holes):
                if not isinstance(h, dict):
                    continue
                h_data = _from_camel(h, HOLE_FIELDS_REV)
                h_data["event_id"] = event_id
                h_data.setdefault("hole_index", idx)
                # NOT NULL 字段兜底默认值
                h_data.setdefault("pos_x", 0)
                h_data.setdefault("pos_y", 0)
                h_data.setdefault("pos_z", 0)
                h_data.setdefault("hole_type", "auxiliary")

                cols = list(h_data.keys())
                placeholders = ", ".join(["%s"] * len(cols))
                col_sql = ", ".join(cols)
                cursor.execute(
                    f"INSERT INTO blasting_design_holes ({col_sql}) VALUES ({placeholders})",
                    list(h_data.values()),
                )

            db.commit()
        except Exception as e:
            db.rollback()
            logger.error("保存设计失败 event_id=%s holes=%d: %s", event_id, len(holes), e, exc_info=True)
            raise HTTPException(status_code=500, detail=f"保存设计失败: {e}")

    return {"code": 0, "msg": "爆破设计保存成功"}


# ============================================================
# 效果（2 个）
# ============================================================

@router.get("/events/{event_id}/result")
def get_result(event_id: str, db: Connection = Depends(get_db)):
    """获取爆破效果（blasting_result 表）"""
    with db.cursor() as cursor:
        if _use_legacy_blasting_schema(cursor):
            cursor.execute("SELECT * FROM blasting_events WHERE event_id = %s", (event_id,))
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="爆破效果未找到")
            return {"code": 0, "data": _legacy_result_to_camel(row)}

        cursor.execute(
            f"SELECT {_select_cols(RESULT_FIELDS)} "
            f"FROM blasting_result WHERE event_id = %s",
            (event_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="爆破效果未找到")
    result = _to_camel(row, RESULT_FIELDS)
    # 向后兼容：fragment_count_generated 为 NULL 时回退取 fragment_count
    if result.get("fragmentCountGenerated") is None and result.get("fragmentCount") is not None:
        result["fragmentCountGenerated"] = result["fragmentCount"]
    return {"code": 0, "data": result}


@router.put("/events/{event_id}/result")
def update_result(event_id: str, body: dict, db: Connection = Depends(get_db)):
    """更新爆破效果（blasting_result 表，不允许修改 event_id）"""
    data = _from_camel(body, RESULT_FIELDS_REV)
    data.pop("event_id", None)
    if not data:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    set_clause = ", ".join([f"{k}=%s" for k in data.keys()])
    values = list(data.values()) + [event_id]
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM blasting_result WHERE event_id = %s", (event_id,)
        )
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="爆破效果未找到")
        cursor.execute(
            f"UPDATE blasting_result SET {set_clause} WHERE event_id=%s", values
        )
        db.commit()
    return {"code": 0, "msg": "爆破效果更新成功"}


@router.post("/events/{event_id}/runtime-stats")
def save_runtime_stats(event_id: str, body: dict, db: Connection = Depends(get_db)):
    """保存运行时统计快照（每次 replay 生成一行）"""
    data = _from_camel(body, RUNTIME_STATS_FIELDS_REV)
    data.pop("id", None)
    data["event_id"] = event_id

    # JSON 字段序列化
    for k in ("params_snapshot", "stats_snapshot"):
        if k in data and isinstance(data[k], (dict, list)):
            data[k] = json.dumps(data[k])

    with db.cursor() as cursor:
        if not _event_exists(cursor, event_id):
            raise HTTPException(status_code=404, detail="爆破事件未找到")
        cols = list(data.keys())
        placeholders = ", ".join(["%s"] * len(cols))
        col_sql = ", ".join(cols)
        try:
            cursor.execute(
                f"INSERT INTO blasting_runtime_stats ({col_sql}) VALUES ({placeholders})",
                list(data.values()),
            )
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error("保存运行时统计失败 event_id=%s: %s", event_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=f"保存运行时统计失败: {e}")
    return {"code": 0, "msg": "运行时统计已保存"}


@router.get("/events/{event_id}/runtime-stats")
def list_runtime_stats(event_id: str, db: Connection = Depends(get_db)):
    """查询事件历次运行时统计（按 created_at 倒序）"""
    with db.cursor() as cursor:
        cursor.execute(
            f"SELECT {_select_cols(RUNTIME_STATS_FIELDS)} "
            f"FROM blasting_runtime_stats WHERE event_id = %s ORDER BY created_at DESC",
            (event_id,),
        )
        rows = cursor.fetchall()
    # JSON 字段反序列化
    results = []
    for row in rows:
        item = _to_camel(row, RUNTIME_STATS_FIELDS)
        for k in ("paramsSnapshot", "statsSnapshot"):
            if item.get(k):
                item[k] = _json_load(item[k], None)
        results.append(item)
    return {"code": 0, "data": results}


# ============================================================
# 对比（1 个）
# ============================================================

@router.post("/results/compare")
def compare_results(body: dict, db: Connection = Depends(get_db)):
    """多事件效果对比：批量取 blasting_result，调用 compare.compare_multiple_events 生成对比矩阵"""
    event_ids = body.get("event_ids") or body.get("eventIds") or []
    if not event_ids:
        raise HTTPException(status_code=400, detail="event_ids 不能为空")

    raw_results = []
    camel_results = []
    with db.cursor() as cursor:
        if _use_legacy_blasting_schema(cursor):
            for eid in event_ids:
                cursor.execute("SELECT * FROM blasting_events WHERE event_id = %s", (eid,))
                row = cursor.fetchone()
                if row:
                    raw = _legacy_result_to_raw(row)
                    raw["event_id"] = row.get("event_id")
                    raw_results.append(raw)
                    camel_results.append(_legacy_result_to_camel(row))
            comparison = compare_multiple_events(raw_results)
            comparison_camel = {
                COMPARE_METRIC_CAMEL.get(m, m): [
                    {"eventId": it.get("event_id"), "value": it.get("value")}
                    for it in items
                ]
                for m, items in comparison.items()
            }
            return {"code": 0, "data": {"results": camel_results, "comparison": comparison_camel}}

        for eid in event_ids:
            cursor.execute(
                f"SELECT {_select_cols(RESULT_FIELDS)} "
                f"FROM blasting_result WHERE event_id = %s",
                (eid,),
            )
            row = cursor.fetchone()
            if row:
                raw_results.append(dict(row))
                camel_results.append(_to_camel(row, RESULT_FIELDS))

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
# 服务层接入（3 个新增）
# ============================================================

@router.post("/validate/kco")
def validate_kco(req: KCOValidateRequest):
    """KCO 碎块分布模型验证（调用 kco_validator.calculate_kco）

    请求体由 KCOValidateRequest Pydantic 模型自动校验：
    - Q 必填且 >0；A∈[0.8,22]；B>d；其他数值字段均 >0
    - 校验失败返回 422（FastAPI 默认），不再返回 500
    """
    inp = KCOInput(
        Q=req.Q, A=req.A, RWS=req.RWS, B=req.B, S=req.S, d=req.d,
        H=req.H, xmax=req.xmax, b=req.b, W_abs=req.W_abs,
    )
    out = calculate_kco(inp)
    return {"code": 0, "data": {
        "x50": out.x50,
        "n": out.n,
        "x80": out.x80,
        "uniformity": out.uniformity,
        "oversizeRatio": out.oversize_ratio,
    }}


@router.post("/physics/jwl")
def physics_jwl(req: JwlRequest):
    """JWL 状态方程计算爆生气压力（调用 blast_physics.jwl_pressure）

    装药量通过 chargeKg 参数传入，按炸药密度换算体积后缩放总能量。
    """
    pressure = jwl_pressure(
        req.relativeVolume, req.explosiveType, charge_kg=req.chargeKg
    )
    return {"code": 0, "data": {
        "pressure": pressure,
        "relativeVolume": req.relativeVolume,
        "explosiveType": req.explosiveType,
        "chargeKg": req.chargeKg,
    }}


@router.post("/physics/vibration")
def physics_vibration(req: VibrationRequest):
    """萨道夫斯基振动预测（调用 blast_physics.sadosky_vibration）"""
    rock = RockMedium(
        density=req.density,
        p_wave_speed=req.pWaveSpeed,
        s_wave_speed=req.sWaveSpeed,
        youngs_modulus=req.youngsModulus,
        poissons_ratio=req.poissonsRatio,
    )
    velocity = sadosky_vibration(req.chargeKg, req.distance, rock)
    return {"code": 0, "data": {
        "velocity": velocity,
        "chargeKg": req.chargeKg,
        "distance": req.distance,
    }}
