"""
爆破模拟数据库初始化脚本 — 关系型版（4 业务表 + 1 字典表）

表结构：
  - blasting_events        事件主表（每事件 1 行）
  - blasting_design        设计表（与事件 1:1）
  - blasting_design_holes  炮孔表（与事件 1:N，每孔 1 行）
  - blasting_result        效果表（与事件 1:1）
  - rock_params            岩体参数字典表（由 schema 预填，本脚本不填充）

运行: python seed_blasting.py
"""
import os
import sys
import math
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

SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "sql", "blasting_schema.sql")

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

# ─── 事件基本信息（与 blasting_events 1:1）─────────────────
# (event_id, name, center_lon, center_lat, center_height, charge_kg, explosive_type,
#  detonation_method, blast_time, rock_type, weather, temperature, wind_speed,
#  wind_direction, status, description)
events_meta = [
    ("BLAST-2026-001", "露天台阶爆破-北区", 116.3915, 39.9015, 0, 320, "emulsion", "electronic",
     datetime(2026, 7, 15, 10, 30), "granite", "clear", 25, 3, 45, "planned", "北区台阶爆破，6孔延时"),
    ("BLAST-2026-002", "井下巷道掘进爆破", 116.3915, 39.9015, 0, 180, "emulsion", "nonel",
     datetime(2026, 7, 16, 14, 0), "limestone", "cloudy", 18, 5, 90, "planned", "巷道掘进，楔形掏槽"),
    ("BLAST-2026-003", "矿体崩落爆破-主矿体", 116.3915, 39.9015, 0, 850, "anfo", "electronic",
     datetime(2026, 7, 18, 9, 0), "ore_iron", "clear", 28, 2, 180, "planned", "大规模崩落爆破"),
    ("BLAST-2026-004", "边坡控制爆破", 116.3915, 39.9015, 0, 95, "emulsion", "electric",
     datetime(2026, 7, 20, 11, 0), "sandstone", "clear", 22, 4, 270, "planned", "预裂爆破控制边坡"),
    ("BLAST-2026-005", "隧道光面爆破", 116.3915, 39.9015, 0, 65, "emulsion", "nonel",
     datetime(2026, 7, 22, 15, 30), "marble", "rain", 15, 8, 60, "planned", "光面爆破减少超欠挖"),
]

# ─── 效果参数数据 ─────────────────────────────────────────
event_rock = {
    "BLAST-2026-001": "granite",
    "BLAST-2026-002": "limestone",
    "BLAST-2026-003": "ore_iron",
    "BLAST-2026-004": "sandstone",
    "BLAST-2026-005": "marble",
}

# 原 kco_params 数据（仅 3 个事件有）
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

# 原 blast_effect 数据（5 个事件）
blast_effect = {
    "BLAST-2026-001": {
        "crater_depth": 2.2, "crater_radius": 3.5,
        "overbreak": 0.18, "underbreak": 0.05, "half_hole_ratio": 0.45,
        "max_throw": 18.5, "avg_throw": 12.0, "throw_concentration": 0.65,
        "max_vibration": 4.2, "max_air_overpressure": 118, "min_safety_distance": 200,
        "frag_x50": 0.32, "frag_xmax": 2.1,
        "desc": "露天台阶爆破-大断面效果良好",
    },
    "BLAST-2026-002": {
        "crater_depth": 1.8, "crater_radius": 2.2,
        "overbreak": 0.12, "underbreak": 0.08, "half_hole_ratio": 0.55,
        "max_throw": 10.5, "avg_throw": 7.0, "throw_concentration": 0.72,
        "max_vibration": 3.5, "max_air_overpressure": 112, "min_safety_distance": 150,
        "frag_x50": 0.26, "frag_xmax": 1.6,
        "desc": "井下巷道掘进-楔形掏槽效果良好",
    },
    "BLAST-2026-003": {
        "crater_depth": 2.8, "crater_radius": 4.0,
        "overbreak": 0.22, "underbreak": 0.03, "half_hole_ratio": 0.40,
        "max_throw": 22.0, "avg_throw": 15.0, "throw_concentration": 0.58,
        "max_vibration": 6.5, "max_air_overpressure": 125, "min_safety_distance": 250,
        "frag_x50": 0.38, "frag_xmax": 2.6,
        "desc": "大断面隧道-双螺旋掏槽大块率偏高",
    },
    "BLAST-2026-004": {
        "crater_depth": 1.5, "crater_radius": 1.8,
        "overbreak": 0.08, "underbreak": 0.02, "half_hole_ratio": 0.85,
        "max_throw": 8.0, "avg_throw": 5.5, "throw_concentration": 0.80,
        "max_vibration": 2.8, "max_air_overpressure": 108, "min_safety_distance": 100,
        "frag_x50": 0.20, "frag_xmax": 1.0,
        "desc": "边坡预裂爆破-半孔率高轮廓平整",
    },
    "BLAST-2026-005": {
        "crater_depth": 2.0, "crater_radius": 2.5,
        "overbreak": 0.10, "underbreak": 0.06, "half_hole_ratio": 0.72,
        "max_throw": 12.5, "avg_throw": 8.5, "throw_concentration": 0.68,
        "max_vibration": 3.8, "max_air_overpressure": 115, "min_safety_distance": 180,
        "frag_x50": 0.25, "frag_xmax": 1.8,
        "desc": "隧道光面爆破-半孔率较高效果良好",
    },
}

# ─── 新增设计字段默认值（旧扁平表无对应列）──────────────────
DEFAULT_TUNNEL_LENGTH = 80       # 已开挖隧道长度(m)
DEFAULT_FACE_THICKNESS = 2       # 掌子面厚度(m)
DEFAULT_FACE_OFFSET = 3          # 掌子面距爆心前方距离(m)
DEFAULT_HOLE_DEPTH = 2.5         # 钻孔深度(m)
DEFAULT_HOLE_DIAMETER = 0.04     # 钻孔直径(m)
DEFAULT_UTILIZATION = 0.85       # 炮孔利用率
DEFAULT_ADVANCE_LENGTH = round(DEFAULT_HOLE_DEPTH * DEFAULT_UTILIZATION, 3)  # 2.125


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
    """
    生成炮孔列表（保留原 seed_design_holes 的生成逻辑）。
    返回 hole dict 列表，每个 dict 含: x, y, type, is_empty, delay_ms, charge_kg,
    charge_length, inclination, azimuth, diameter, detonator_series。
    """
    sec = cfg["section"]
    W, Hw, R, totalH = sec["W"], sec["Hw"], sec["R"], sec["totalH"]
    cy0 = totalH * 0.5
    depth = cfg["hole_depth"]
    diameter = cfg["diameter"]
    cut_r = cfg["cut_r"]

    hole_list = []
    series = 1

    # 1) 中心空孔（不装药）
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

    # 3) 辅助孔（环形布置，剔除超出断面的孔）
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

    # 5) 周边孔-拱部半圆（仅 R > 0）
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

    # 7) 楔形掏槽：掏槽装药孔改为 60° 倾斜
    if cfg["cut_pattern"] == "wedge":
        for h in hole_list:
            if h["type"] == "cut" and not h["is_empty"]:
                h["inclination"] = 60
                h["azimuth"] = 90 if h["x"] > 0 else (-90 if h["x"] < 0 else 0)

    return hole_list


# ─── 4 个独立 seed 函数 ────────────────────────────────────

def seed_events(cursor):
    """向 blasting_events 表 INSERT 5 个事件"""
    cols = [
        "event_id", "name", "center_lon", "center_lat", "center_height", "charge_kg",
        "explosive_type", "detonation_method", "blast_time", "rock_type",
        "weather", "temperature", "wind_speed", "wind_direction", "status", "description",
    ]
    placeholders = ",".join(["%s"] * len(cols))
    col_list = ",".join(f"`{c}`" for c in cols)
    update_clause = ",".join(f"`{c}`=VALUES(`{c}`)" for c in cols if c != "event_id")
    sql = (
        f"INSERT INTO `blasting_events` ({col_list}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )

    for meta in events_meta:
        cursor.execute(sql, meta)
        print(f"  [blasting_events] {meta[0]} ({meta[1]})")
    print(f"[OK] blasting_events: {len(events_meta)} 行")


def seed_design(cursor):
    """向 blasting_design 表 INSERT 5 个设计（与事件 1:1）"""
    cols = [
        "event_id",
        # 隧道断面
        "tunnel_shape", "tunnel_width", "tunnel_wall_height", "tunnel_arch_radius",
        "tunnel_total_height", "tunnel_length", "face_thickness", "face_offset",
        # 掏槽与起爆
        "cut_pattern", "cut_angle", "cut_hole_count", "empty_hole_count",
        "initiation_network", "delay_interval_ms",
        # 装药参数
        "charge_density_cut", "charge_density_aux", "charge_density_perim", "stemming_length",
        # 钻孔参数
        "hole_depth", "hole_diameter", "utilization", "advance_length",
        # 预期效果
        "expected_x50", "expected_xmax", "expected_throw_distance", "expected_overbreak",
        # 安全
        "min_safety_distance", "max_vibration_velocity",
    ]
    placeholders = ",".join(["%s"] * len(cols))
    col_list = ",".join(f"`{c}`" for c in cols)
    update_clause = ",".join(f"`{c}`=VALUES(`{c}`)" for c in cols if c != "event_id")
    sql = (
        f"INSERT INTO `blasting_design` ({col_list}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )

    for event_id, cfg in event_configs.items():
        sec = cfg["section"]
        cut_angle = 60 if cfg["cut_pattern"] == "wedge" else 0
        row = (
            event_id,
            # 隧道断面（来自 cfg.section）
            sec["shape"], sec["W"], sec["Hw"], sec["R"], sec["totalH"],
            DEFAULT_TUNNEL_LENGTH, DEFAULT_FACE_THICKNESS, DEFAULT_FACE_OFFSET,
            # 掏槽与起爆
            cfg["cut_pattern"], cut_angle, 4, 1,
            "nonel", cfg["delay_step_ms"],
            # 装药参数
            cfg["charge_density_cut"], cfg["charge_density_aux"],
            cfg["charge_density_perim"], 0.6,
            # 钻孔参数（新增字段使用默认值）
            DEFAULT_HOLE_DEPTH, DEFAULT_HOLE_DIAMETER, DEFAULT_UTILIZATION,
            DEFAULT_ADVANCE_LENGTH,
            # 预期效果（沿用旧脚本固定值）
            0.30, 2.0, 15, 0.15,
            # 安全（沿用旧脚本固定值）
            200, 5,
        )
        cursor.execute(sql, row)
        print(f"  [blasting_design] {event_id}")
    print(f"[OK] blasting_design: {len(event_configs)} 行")


def seed_design_holes(cursor):
    """向 blasting_design_holes 表批量 INSERT 炮孔（每孔一行，复用 generate_holes）"""
    cols = [
        "event_id", "hole_index", "pos_x", "pos_y", "pos_z", "hole_type",
        "diameter", "depth", "inclination_angle", "inclination_azimuth",
        "charge_kg", "charge_length", "explosive_type", "detonator_series",
        "delay_ms", "is_empty_hole",
    ]
    placeholders = ",".join(["%s"] * len(cols))
    col_list = ",".join(f"`{c}`" for c in cols)
    sql = f"INSERT INTO `blasting_design_holes` ({col_list}) VALUES ({placeholders})"

    total_holes = 0
    for event_id, cfg in event_configs.items():
        # 幂等：先删除该事件已有炮孔（重跑安全）
        cursor.execute(
            "DELETE FROM `blasting_design_holes` WHERE event_id = %s",
            (event_id,),
        )

        hole_list = generate_holes(cfg)
        rows = []
        for idx, h in enumerate(hole_list, 1):
            rows.append((
                event_id,
                idx,
                round(h["x"], 3),
                round(h["y"], 3),
                0,  # pos_z：断面内 Z 坐标，一般为 0
                h["type"],
                h["diameter"],
                cfg["hole_depth"],
                h["inclination"],
                h["azimuth"],
                h["charge_kg"],
                h["charge_length"],
                cfg["explosive_type"],
                h["detonator_series"],
                h["delay_ms"],
                1 if h["is_empty"] else 0,
            ))
        cursor.executemany(sql, rows)
        total_holes += len(rows)
        print(f"  [blasting_design_holes] {event_id} — 炮孔数: {len(rows)}")
    print(f"[OK] blasting_design_holes: {total_holes} 行 (共 {len(event_configs)} 事件)")


def seed_result(cursor):
    """向 blasting_result 表 INSERT 5 个效果（与事件 1:1）"""
    cols = [
        "event_id",
        # 模拟控制
        "random_seed", "simulation_duration_s", "time_step_s",
        # 漏斗
        "crater_depth", "crater_radius", "crater_center_offset_y",
        # 超挖
        "overbreak_max", "overbreak_min", "half_barrel_ratio",
        # 碎块
        "fragment_count", "fragment_x50", "fragment_x80", "fragment_xmax",
        "fragment_b", "fragment_n",
        # 抛掷
        "throw_distance_max", "throw_distance_avg", "spread_angle",
        # 振动
        "vibration_peak", "vibration_velocity_max", "stress_peak_mpa",
        # 安全
        "min_safety_factor",
        # 视觉强度
        "smoke_intensity", "dust_intensity", "fire_intensity",
        "spark_intensity", "shockwave_speed_factor",
    ]
    placeholders = ",".join(["%s"] * len(cols))
    col_list = ",".join(f"`{c}`" for c in cols)
    update_clause = ",".join(f"`{c}`=VALUES(`{c}`)" for c in cols if c != "event_id")
    sql = (
        f"INSERT INTO `blasting_result` ({col_list}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )

    for event_id in event_configs:
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

        vibration_peak = round(be["max_vibration"] * 1.414, 2)  # 矢量峰值 ≈ 分量最大值 × √2 (Kine, cm/s)
        vibration_velocity_max = be["max_vibration"]            # 最大质点振动速度分量 (cm/s)
        stress_peak_mpa = round(be["max_vibration"] * 10, 1)    # 峰值应力 (MPa)
        min_safety_factor = round(be["min_safety_distance"] / 100, 2)  # 无量纲安全系数（距离归一化）
        spread_angle = 45.0  # 抛掷扩散角(°)，默认 45°

        row = (
            event_id,
            # 模拟控制（沿用旧脚本固定值）
            42, 8, 0.05,
            # 漏斗
            be["crater_depth"], be["crater_radius"], crater_offset_y,
            # 超挖
            be["overbreak"], be["underbreak"], be["half_hole_ratio"],
            # 碎块
            frag_count, frag_x50, frag_x80, frag_xmax, frag_b, frag_n,
            # 抛掷
            be["max_throw"], be["avg_throw"], spread_angle,
            # 振动
            vibration_peak, vibration_velocity_max, stress_peak_mpa,
            # 安全
            min_safety_factor,
            # 视觉强度
            smoke, dust, fire, spark, shockwave,
        )
        cursor.execute(sql, row)
        print(f"  [blasting_result] {event_id}")
    print(f"[OK] blasting_result: {len(event_configs)} 行")


def main():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()

    print("=" * 60)
    print("爆破模拟数据库初始化（关系型版：4 业务表 + 1 字典表）")
    print("=" * 60)

    try:
        print("\n[0/4] 执行 Schema（DROP旧表 + CREATE 5张新表 + 预填 rock_params）...")
        with open(SCHEMA_FILE, "r", encoding="utf-8") as f:
            sql_text = f.read()
        for statement in sql_text.split(";"):
            stmt = statement.strip()
            if stmt:
                cursor.execute(stmt)
        print("[OK] Schema 执行完成")

        print("\n[1/4] 填充 blasting_events（事件主表）...")
        seed_events(cursor)

        print("\n[2/4] 填充 blasting_design（设计表）...")
        seed_design(cursor)

        print("\n[3/4] 填充 blasting_design_holes（炮孔表，每孔一行）...")
        seed_design_holes(cursor)

        print("\n[4/4] 填充 blasting_result（效果表）...")
        seed_result(cursor)

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
    print("  - blasting_events:        5 行")
    print("  - blasting_design:        5 行")
    print("  - blasting_design_holes:  ~1765 行（5 事件 × ~353 孔）")
    print("  - blasting_result:        5 行")
    print("  - rock_params:            8 行（schema 预填）")
    print("=" * 60)


if __name__ == "__main__":
    main()
