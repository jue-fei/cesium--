"""
爆破模拟数据库初始化脚本 — V2 宽表设计

表结构（V2）：
  - blasting_events    事件主表（宽表，每事件 1 行，5 JSON 聚合列）
  - 岩体参数参考        岩体参数字典表（由 schema 预填，本脚本不填充）

运行: python seed_blasting.py
"""
import os
import sys
import math
import json
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "cesium_platform"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}

SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "sql", "blasting_schema_v2.sql")

# ============================================================
# 枚举映射（API 英文值 → DB 中文值）
# ============================================================

STATUS_API2DB = {"planned": "已规划", "executed": "已执行", "aborted": "已取消"}
EXPLOSIVE_API2DB = {"emulsion": "乳化炸药", "anfo": "铵油炸药", "dynamite": "硝化甘油"}
ROCK_API2DB = {
    "granite": "花岗岩", "limestone": "石灰岩", "sandstone": "砂岩",
    "marble": "大理石", "basalt": "玄武岩", "schist": "片岩",
    "andesite": "安山岩", "diorite": "闪长岩", "shale": "页岩",
    "quartzite": "石英岩", "ore_iron": "铁矿",
}
SHAPE_API2DB = {"horseshoe": "马蹄形", "circular": "圆形", "rectangular": "矩形"}
INIT_API2DB = {"electric": "电雷管", "nonel": "导爆管", "electronic": "电子雷管"}
CUT_API2DB = {
    "four_section": "四段掏槽", "single_spiral": "单螺旋",
    "double_spiral": "双螺旋", "wedge": "楔形", "burn": "直眼",
}
HOLETYPE_API2DB = {
    "cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔",
    "floor": "底板孔", "empty": "空孔",
}
WEATHER_API2DB = {"clear": "晴", "cloudy": "多云", "rain": "雨"}


# ─── 5 个事件设计配置（保留不变）──────────────────────────────
event_configs = {
    "BLAST-2026-001": {
        "section": {"W": 18, "Hw": 6, "R": 9, "totalH": 15, "shape": "horseshoe"},
        "cut_pattern": "four_section",
        "cut_r": 1.0,
        "aux_rings": [{"r": 2.6, "n": 8}, {"r": 4.2, "n": 12}],
        "perim_spacing": 1.2,
        "hole_depth": 2.5,
        "diameter": 0.04,
        "charge_density_cut": 1.2,
        "charge_density_aux": 1.0,
        "charge_density_perim": 0.5,
        "delay_step_ms": 100,
        "explosive_type": "emulsion",
        "desc": "露天台阶爆破-四眼菱形掏槽",
    },
    "BLAST-2026-002": {
        "section": {"W": 10, "Hw": 4, "R": 5, "totalH": 9, "shape": "horseshoe"},
        "cut_pattern": "wedge",
        "cut_r": 0.8,
        "aux_rings": [{"r": 1.8, "n": 6}, {"r": 3.0, "n": 10}],
        "perim_spacing": 0.8,
        "hole_depth": 2.0,
        "diameter": 0.04,
        "charge_density_cut": 1.5,
        "charge_density_aux": 1.0,
        "charge_density_perim": 0.4,
        "delay_step_ms": 50,
        "explosive_type": "emulsion",
        "desc": "井下巷道掘进-楔形掏槽",
    },
    "BLAST-2026-003": {
        "section": {"W": 20, "Hw": 7, "R": 10, "totalH": 17, "shape": "horseshoe"},
        "cut_pattern": "double_spiral",
        "cut_r": 1.2,
        "aux_rings": [{"r": 3.0, "n": 10}, {"r": 5.0, "n": 16}, {"r": 7.0, "n": 20}],
        "perim_spacing": 1.0,
        "hole_depth": 3.0,
        "diameter": 0.045,
        "charge_density_cut": 1.5,
        "charge_density_aux": 1.2,
        "charge_density_perim": 0.6,
        "delay_step_ms": 80,
        "explosive_type": "anfo",
        "desc": "大断面隧道-双螺旋掏槽",
    },
    "BLAST-2026-004": {
        "section": {"W": 14, "Hw": 5, "R": 0, "totalH": 12, "shape": "rectangular"},
        "cut_pattern": "burn",
        "cut_r": 0.6,
        "aux_rings": [{"r": 2.0, "n": 6}, {"r": 3.5, "n": 10}],
        "perim_spacing": 0.5,
        "hole_depth": 2.0,
        "diameter": 0.035,
        "charge_density_cut": 1.0,
        "charge_density_aux": 0.8,
        "charge_density_perim": 0.3,
        "delay_step_ms": 25,
        "explosive_type": "dynamite",
        "desc": "边坡预裂爆破-直眼桶形掏槽",
    },
    "BLAST-2026-005": {
        "section": {"W": 12, "Hw": 5, "R": 6, "totalH": 11, "shape": "horseshoe"},
        "cut_pattern": "single_spiral",
        "cut_r": 0.8,
        "aux_rings": [{"r": 2.2, "n": 8}, {"r": 3.8, "n": 12}],
        "perim_spacing": 0.6,
        "hole_depth": 2.5,
        "diameter": 0.04,
        "charge_density_cut": 1.2,
        "charge_density_aux": 0.8,
        "charge_density_perim": 0.4,
        "delay_step_ms": 100,
        "explosive_type": "emulsion",
        "desc": "隧道光面爆破-单螺旋掏槽",
    },
}

# ─── 事件基本信息（V2 中文列名格式）────────────────────────────
# 每个元组对应 V2 blasting_events 的标量列
# (event_id, 名称, 爆心经度, 爆心纬度, 爆心高程, 总装药量_kg, 炸药类型,
#  岩体类型, 起爆方式, 爆破时间, 状态, 备注)
events_meta = [
    ("BLAST-2026-001", "露天台阶爆破-北区", 116.3915, 39.9015, 0, 320,
     "乳化炸药", "花岗岩", "电子雷管",
     datetime(2026, 7, 15, 10, 30), "已规划", "北区台阶爆破，6孔延时"),
    ("BLAST-2026-002", "井下巷道掘进爆破", 116.3915, 39.9015, 0, 180,
     "乳化炸药", "石灰岩", "导爆管",
     datetime(2026, 7, 16, 14, 1), "已规划", "巷道掘进，楔形掏槽"),
    ("BLAST-2026-003", "矿体崩落爆破-主矿体", 116.3915, 39.9015, 0, 850,
     "铵油炸药", "铁矿", "电子雷管",
     datetime(2026, 7, 18, 9, 0), "已规划", "大规模崩落爆破"),
    ("BLAST-2026-004", "边坡控制爆破", 116.3915, 39.9015, 0, 95,
     "乳化炸药", "砂岩", "电雷管",
     datetime(2026, 7, 20, 11, 0), "已规划", "预裂爆破控制边坡"),
    ("BLAST-2026-005", "隧道光面爆破", 116.3915, 39.9015, 0, 65,
     "乳化炸药", "大理石", "导爆管",
     datetime(2026, 7, 22, 15, 30), "已规划", "光面爆破减少超欠挖"),
]

# ─── 环境信息（weather/wind，存入环境岩体 JSON）────────────────
env_meta = {
    "BLAST-2026-001": {"天气": "晴", "温度_摄氏度": 25, "风速_ms": 3, "风向_度": 45},
    "BLAST-2026-002": {"天气": "多云", "温度_摄氏度": 18, "风速_ms": 5, "风向_度": 90},
    "BLAST-2026-003": {"天气": "晴", "温度_摄氏度": 28, "风速_ms": 2, "风向_度": 180},
    "BLAST-2026-004": {"天气": "晴", "温度_摄氏度": 22, "风速_ms": 4, "风向_度": 270},
    "BLAST-2026-005": {"天气": "雨", "温度_摄氏度": 15, "风速_ms": 8, "风向_度": 60},
}

# ─── 效果参数数据（存入爆破效果 JSON）────────────────────────
kco_params = {
    "BLAST-2026-001": {
        "x50": 0.30, "xmax": 2.0, "b": 2.0, "n": 1.2, "fragment_count": 200,
        "crater_center_offset_y": 0.38,
        "smoke": 0.3, "dust": 0.2, "fire": 0.8, "spark": 0.6, "shockwave": 5.0,
    },
    "BLAST-2026-002": {
        "x50": 0.25, "xmax": 1.5, "b": 2.2, "n": 1.0, "fragment_count": 150,
        "crater_center_offset_y": 0.40,
        "smoke": 0.25, "dust": 0.15, "fire": 0.7, "spark": 0.5, "shockwave": 4.5,
    },
    "BLAST-2026-003": {
        "x50": 0.35, "xmax": 2.5, "b": 1.8, "n": 1.4, "fragment_count": 250,
        "crater_center_offset_y": 0.35,
        "smoke": 0.35, "dust": 0.25, "fire": 0.9, "spark": 0.7, "shockwave": 5.5,
    },
}

blast_effect = {
    "BLAST-2026-001": {
        "crater_depth": 2.2, "crater_radius": 3.5,
        "overbreak": 0.18, "underbreak": 0.05, "half_hole_ratio": 0.45,
        "max_throw": 18.5, "avg_throw": 12.0, "throw_concentration": 0.65,
        "max_vibration": 4.2, "max_air_overpressure": 118, "min_safety_distance": 200,
        "frag_x50": 0.32, "frag_xmax": 2.1,
    },
    "BLAST-2026-002": {
        "crater_depth": 1.8, "crater_radius": 2.2,
        "overbreak": 0.12, "underbreak": 0.08, "half_hole_ratio": 0.55,
        "max_throw": 10.5, "avg_throw": 7.0, "throw_concentration": 0.72,
        "max_vibration": 3.5, "max_air_overpressure": 112, "min_safety_distance": 150,
        "frag_x50": 0.26, "frag_xmax": 1.6,
    },
    "BLAST-2026-003": {
        "crater_depth": 2.8, "crater_radius": 4.0,
        "overbreak": 0.22, "underbreak": 0.03, "half_hole_ratio": 0.40,
        "max_throw": 22.0, "avg_throw": 15.0, "throw_concentration": 0.58,
        "max_vibration": 6.5, "max_air_overpressure": 125, "min_safety_distance": 250,
        "frag_x50": 0.38, "frag_xmax": 2.6,
    },
    "BLAST-2026-004": {
        "crater_depth": 1.5, "crater_radius": 1.8,
        "overbreak": 0.08, "underbreak": 0.02, "half_hole_ratio": 0.85,
        "max_throw": 8.0, "avg_throw": 5.5, "throw_concentration": 0.80,
        "max_vibration": 2.8, "max_air_overpressure": 108, "min_safety_distance": 100,
        "frag_x50": 0.20, "frag_xmax": 1.0,
    },
    "BLAST-2026-005": {
        "crater_depth": 2.0, "crater_radius": 2.5,
        "overbreak": 0.10, "underbreak": 0.06, "half_hole_ratio": 0.72,
        "max_throw": 12.5, "avg_throw": 8.5, "throw_concentration": 0.68,
        "max_vibration": 3.8, "max_air_overpressure": 115, "min_safety_distance": 180,
        "frag_x50": 0.25, "frag_xmax": 1.8,
    },
}

# ─── 新增设计字段默认值 ──────────────────────────────────────
DEFAULT_TUNNEL_LENGTH = 80
DEFAULT_FACE_THICKNESS = 2
DEFAULT_FACE_OFFSET = 3
DEFAULT_HOLE_DEPTH = 2.5
DEFAULT_HOLE_DIAMETER = 0.04
DEFAULT_UTILIZATION = 0.85
DEFAULT_ADVANCE_LENGTH = round(DEFAULT_HOLE_DEPTH * DEFAULT_UTILIZATION, 3)


def _is_inside_section(x, y, W, Hw, R):
    """判断点 (x, y) 是否在马蹄形断面内"""
    half_w = W / 2
    if y <= Hw:
        return abs(x) <= half_w * 0.95
    dx = x
    dy = y - Hw
    return (dx * dx + dy * dy) <= R * R * 0.95


def _frange(start, stop, step):
    """浮点 range 生成器"""
    while start < stop:
        yield round(start, 4)
        start += step


def generate_holes(cfg):
    """生成炮孔列表（保留原 seed_design_holes 的生成逻辑）"""
    sec = cfg["section"]
    W, Hw, R, totalH = sec["W"], sec["Hw"], sec["R"], sec["totalH"]
    cy0 = totalH * 0.5
    depth = cfg["hole_depth"]
    diameter = cfg["diameter"]
    cut_r = cfg["cut_r"]

    hole_list = []
    series = 1

    # 1) 中心空孔
    hole_list.append({
        "x": 0, "y": cy0, "type": "cut", "is_empty": True,
        "delay_ms": 0, "charge_kg": 0, "charge_length": 0,
        "inclination": 0, "azimuth": 0, "diameter": diameter * 1.6,
        "detonator_series": 1
    })

    # 2) 4 孔菱形装药掏槽孔
    for i, (x, y) in enumerate([
        (cut_r, cy0), (-cut_r, cy0), (0, cy0 + cut_r), (0, cy0 - cut_r)
    ], 1):
        series = i + 1
        chg_len = depth * 0.8
        chg_kg = chg_len * cfg["charge_density_cut"]
        hole_list.append({
            "x": x, "y": y, "type": "cut", "is_empty": False,
            "delay_ms": series * cfg["delay_step_ms"],
            "charge_kg": round(chg_kg, 2),
            "charge_length": round(chg_len, 2),
            "inclination": 0, "azimuth": 0, "diameter": diameter,
            "detonator_series": series
        })

    # 3) 辅助孔
    series = 6
    for ring in cfg["aux_rings"]:
        n = ring["n"]
        r = ring["r"]
        for i in range(n):
            a = (i / n) * math.pi * 2
            x = math.cos(a) * r
            y = cy0 + math.sin(a) * r
            if _is_inside_section(x, y, W, Hw, R):
                chg_len = depth * 0.7
                chg_kg = chg_len * cfg["charge_density_aux"]
                hole_list.append({
                    "x": x, "y": y, "type": "auxiliary", "is_empty": False,
                    "delay_ms": series * cfg["delay_step_ms"],
                    "charge_kg": round(chg_kg, 2),
                    "charge_length": round(chg_len, 2),
                    "inclination": 0, "azimuth": 0, "diameter": diameter,
                    "detonator_series": series
                })
                series = (series % 20) + 1

    # 4) 周边孔-直墙
    perim_sp = cfg["perim_spacing"]
    for y in [y for y in _frange(1.0, Hw - 0.3, perim_sp)]:
        for x_pos in [-(W / 2 - 0.35), (W / 2 - 0.35)]:
            chg_len = depth * 0.6
            chg_kg = chg_len * cfg["charge_density_perim"]
            hole_list.append({
                "x": x_pos, "y": y, "type": "perimeter", "is_empty": False,
                "delay_ms": series * cfg["delay_step_ms"],
                "charge_kg": round(chg_kg, 2),
                "charge_length": round(chg_len, 2),
                "inclination": 3, "azimuth": 90 if x_pos > 0 else -90,
                "diameter": diameter,
                "detonator_series": series
            })
            series = (series % 20) + 1

    # 5) 周边孔-拱部半圆
    if R > 0:
        arch_n = max(8, int(math.pi * R / perim_sp))
        for i in range(1, arch_n):
            a = math.pi - (i / arch_n) * math.pi
            x = math.cos(a) * R
            y = Hw + math.sin(a) * R
            chg_len = depth * 0.6
            chg_kg = chg_len * cfg["charge_density_perim"]
            azimuth = math.degrees(math.atan2(x, y - Hw)) if abs(y - Hw) > 0.01 else 0
            hole_list.append({
                "x": x, "y": y, "type": "perimeter", "is_empty": False,
                "delay_ms": series * cfg["delay_step_ms"],
                "charge_kg": round(chg_kg, 2),
                "charge_length": round(chg_len, 2),
                "inclination": 3, "azimuth": round(azimuth, 1),
                "diameter": diameter,
                "detonator_series": series
            })
            series = (series % 20) + 1

    # 6) 底板两角
    for x_pos in [-(W / 2 - 0.4), (W / 2 - 0.4)]:
        chg_len = depth * 0.7
        chg_kg = chg_len * cfg["charge_density_aux"]
        hole_list.append({
            "x": x_pos, "y": 0.5, "type": "perimeter", "is_empty": False,
            "delay_ms": series * cfg["delay_step_ms"],
            "charge_kg": round(chg_kg, 2),
            "charge_length": round(chg_len, 2),
            "inclination": 5, "azimuth": 90 if x_pos > 0 else -90,
            "diameter": diameter,
            "detonator_series": series
        })
        series = (series % 20) + 1

    # 7) 楔形掏槽
    if cfg["cut_pattern"] == "wedge":
        for h in hole_list:
            if h["type"] == "cut" and not h["is_empty"]:
                h["inclination"] = 60
                h["azimuth"] = 90 if h["x"] > 0 else (-90 if h["x"] < 0 else 0)

    return hole_list


def _hole_to_v2(h, idx, cfg):
    """将 generate_holes 输出的单个炮孔转为 V2 炮孔设计 JSON 格式（中文 key）"""
    return {
        "序号": idx + 1,
        "X坐标_m": round(h["x"], 3),
        "Y坐标_m": round(h["y"], 3),
        "孔类型": HOLETYPE_API2DB.get(h["type"], h["type"]),
        "孔径_m": h["diameter"],
        "孔深_m": cfg["hole_depth"],
        "倾角_度": h["inclination"],
        "方位角_度": h["azimuth"],
        "装药量_kg": h["charge_kg"],
        "装药长度_m": h["charge_length"],
        "炸药类型": EXPLOSIVE_API2DB.get(cfg["explosive_type"], cfg["explosive_type"]),
        "雷管段别": h["detonator_series"],
        "延期时间_ms": h["delay_ms"],
        "是否空孔": h["is_empty"],
    }


def _build_tunnel_json(cfg):
    """从事件配置构建断面掘进 JSON 对象"""
    sec = cfg["section"]
    return {
        "断面形状": SHAPE_API2DB.get(sec["shape"], sec["shape"]),
        "断面宽度_m": sec["W"],
        "直墙高度_m": sec["Hw"],
        "拱部半径_m": sec["R"],
        "断面总高度_m": sec["totalH"],
        "已开挖长度_m": DEFAULT_TUNNEL_LENGTH,
        "掌子面厚度_m": DEFAULT_FACE_THICKNESS,
        "掌子面距爆心_m": DEFAULT_FACE_OFFSET,
        "钻孔深度_m": cfg["hole_depth"],
        "钻孔直径_m": cfg["diameter"],
        "炮孔利用率": DEFAULT_UTILIZATION,
        "单循环进尺_m": round(cfg["hole_depth"] * DEFAULT_UTILIZATION, 3),
    }


def _build_charge_json(cfg):
    """从事件配置构建装药起爆 JSON 对象"""
    cut_angle = 60 if cfg["cut_pattern"] == "wedge" else 0
    init_cn = INIT_API2DB.get("nonel", "导爆管")
    return {
        "掏槽模式": CUT_API2DB.get(cfg["cut_pattern"], cfg["cut_pattern"]),
        "楔形掏槽角_度": cut_angle,
        "装药掏槽孔数": 4,
        "空孔数": 1,
        "起爆网络": init_cn,
        "段间延时间隔_ms": cfg["delay_step_ms"],
        "掏槽线装药密度_kgm": cfg["charge_density_cut"],
        "辅助线装药密度_kgm": cfg["charge_density_aux"],
        "周边线装药密度_kgm": cfg["charge_density_perim"],
        "底板线装药密度_kgm": 0.8,
        "堵塞长度_m": 0.6,
    }


def _build_result_json(event_id):
    """从效果数据构建爆破效果 JSON 对象"""
    be = blast_effect[event_id]
    kco = kco_params.get(event_id, {})

    frag_x50 = kco.get("x50", be["frag_x50"])
    frag_xmax = kco.get("xmax", be["frag_xmax"])
    frag_b = kco.get("b", 2.0)
    frag_n = kco.get("n", 1.2)
    frag_count = kco.get("fragment_count", 100 if event_id == "BLAST-2026-004" else 80)
    crater_offset_y = kco.get("crater_center_offset_y", 0.38)
    smoke = kco.get("smoke", 0.3)
    dust = kco.get("dust", 0.2)
    fire = kco.get("fire", 0.8)
    spark = kco.get("spark", 0.6)
    shockwave = kco.get("shockwave", 5.0)
    frag_x80 = round(frag_x50 * 1.5, 3)

    vibration_peak = round(be["max_vibration"] * 1.414, 2)
    vibration_velocity_max = be["max_vibration"]
    stress_peak_mpa = round(be["max_vibration"] * 10, 1)
    min_safety_factor = round(be["min_safety_distance"] / 100, 2)

    return {
        "模拟随机种子": 42,
        "模拟总时长_s": 8.0,
        "时间步长_s": 0.05,
        "碎片总数": frag_count,
        "中位块度_x50_m": frag_x50,
        "80通过块度_x80_m": frag_x80,
        "最大块度_xmax_m": frag_xmax,
        "Swebrec弯曲参数_b": frag_b,
        "Cunningham均匀指数_n": frag_n,
        "漏斗深度_m": be["crater_depth"],
        "漏斗半径_m": be["crater_radius"],
        "漏斗中心偏移_m": crater_offset_y,
        "最大抛掷距离_m": be["max_throw"],
        "平均抛掷距离_m": be["avg_throw"],
        "抛掷扩散角_度": 45.0,
        "最大超挖_m": be["overbreak"],
        "最小超挖_m": be["underbreak"],
        "半孔率": be["half_hole_ratio"],
        "峰值振动_Kine": vibration_peak,
        "最大质点振速_cms": vibration_velocity_max,
        "峰值应力_MPa": stress_peak_mpa,
        "最小安全系数": min_safety_factor,
        "烟雾强度": smoke,
        "粉尘强度": dust,
        "火球强度": fire,
        "火花强度": spark,
        "冲击波速度系数": shockwave,
    }


def _build_env_json(event_id, cursor):
    """构建环境岩体 JSON 对象（weather/wind + 岩体参数从参考表）"""
    env = dict(env_meta.get(event_id, {}))

    # 从事件元数据获取岩体类型（中文）
    for meta in events_meta:
        if meta[0] == event_id:
            rock_cn = meta[7]  # 岩体类型列（中文）
            break
    else:
        rock_cn = None

    if rock_cn:
        env["岩体类型"] = rock_cn
        cursor.execute(
            "SELECT * FROM `岩体参数参考` WHERE `岩体类型` = %s",
            (rock_cn,),
        )
        ref_row = cursor.fetchone()
        if ref_row:
            for col in ref_row:
                if col not in ("岩体类型", "更新时间"):
                    env[col] = ref_row[col]

    return env


def seed_events(cursor):
    """向 blasting_events 宽表 INSERT 5 个事件（标量列 + JSON 列）"""
    scalar_cols = [
        "event_id", "名称", "爆心经度", "爆心纬度", "爆心高程", "总装药量_kg",
        "炸药类型", "岩体类型", "起爆方式", "爆破时间", "状态", "备注",
    ]
    # 加上 5 个 JSON 列
    json_cols = ["炮孔设计", "断面掘进", "装药起爆", "爆破效果", "环境岩体"]
    all_cols = scalar_cols + json_cols

    col_list = ",".join(f"`{c}`" for c in all_cols)
    placeholders = ",".join(["%s"] * len(all_cols))
    update_clause = ",".join(
        f"`{c}`=VALUES(`{c}`)" for c in all_cols if c != "event_id"
    )
    sql = (
        f"INSERT INTO `blasting_events` ({col_list}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )

    for idx, meta in enumerate(events_meta):
        event_id = meta[0]
        cfg = event_configs[event_id]

        # 构建标量值（与 events_meta 元组顺序一致）
        scalar_vals = list(meta)

        # 构建 JSON 列值
        holes = generate_holes(cfg)
        holes_json = json.dumps(
            [_hole_to_v2(h, i, cfg) for i, h in enumerate(holes)],
            ensure_ascii=False,
        )
        tunnel_json = json.dumps(_build_tunnel_json(cfg), ensure_ascii=False)
        charge_json = json.dumps(_build_charge_json(cfg), ensure_ascii=False)
        result_json = json.dumps(_build_result_json(event_id), ensure_ascii=False)
        env_json = json.dumps(_build_env_json(event_id, cursor), ensure_ascii=False)

        row = scalar_vals + [holes_json, tunnel_json, charge_json, result_json, env_json]
        cursor.execute(sql, row)
        print(f"  [blasting_events] {event_id} ({meta[1]}) — 炮孔数: {len(holes)}")

    print(f"[OK] blasting_events: {len(events_meta)} 行")


def main():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()

    print("=" * 60)
    print("爆破模拟数据库初始化（V2 宽表设计）")
    print("=" * 60)

    try:
        # Schema 已通过 run_v2_schema.py 执行，这里跳过
        # 仅检查表是否存在
        cursor.execute("SELECT COUNT(*) AS cnt FROM `blasting_events`")
        exists = cursor.fetchone()["cnt"]
        if exists > 0:
            print(f"[SKIP] blasting_events 已有 {exists} 行数据，跳过填充")
            return

        print("\n[1/1] 填充 blasting_events（宽表：标量列 + 5 JSON 聚合列）...")
        seed_events(cursor)

        conn.commit()
        print("\n[OK] 事务提交完成")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()

    print("\n" + "=" * 60)
    print("数据库初始化完成！")
    print("  - blasting_events:  5 行（宽表，含 5 JSON 聚合列）")
    print("  - 岩体参数参考:      10 行（schema 预填）")
    print("=" * 60)


if __name__ == "__main__":
    main()
