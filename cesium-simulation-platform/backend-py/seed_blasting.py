"""
爆破模拟数据库初始化脚本 — 填充真实爆破参数与模拟数据
运行: python seed_blasting.py
"""
import os
import sys
import json
import math
import random
from datetime import datetime, timedelta

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


def execute_schema(cursor):
    """执行建表 SQL"""
    with open(SCHEMA_FILE, "r", encoding="utf-8") as f:
        sql = f.read()
    for statement in sql.split(";"):
        stmt = statement.strip()
        if stmt:
            cursor.execute(stmt)
    print("[OK] Schema 执行完成")


def seed_rock_params(cursor):
    """填充岩体力学参数库"""
    rocks = [
        ("granite", 2650, 50e9, 0.25, 120e6, 12e6, 25e6, 5500, 3200, 0.010, 0.015, 0.005, 0.45, 0.35, 0.25, 45, 8e6, "花岗岩"),
        ("limestone", 2400, 35e9, 0.28, 80e6, 8e6, 15e6, 4500, 2600, 0.012, 0.018, 0.006, 0.55, 0.45, 0.35, 38, 5e6, "石灰岩"),
        ("sandstone", 2200, 20e9, 0.30, 60e6, 6e6, 12e6, 3500, 2000, 0.015, 0.022, 0.008, 0.65, 0.50, 0.35, 32, 3e6, "砂岩"),
        ("marble", 2700, 45e9, 0.26, 90e6, 9e6, 18e6, 4800, 2800, 0.011, 0.016, 0.006, 0.70, 0.65, 0.60, 40, 6e6, "大理岩"),
        ("basalt", 2900, 60e9, 0.22, 150e6, 15e6, 30e6, 6000, 3500, 0.009, 0.013, 0.004, 0.25, 0.20, 0.15, 50, 12e6, "玄武岩"),
        ("schist", 2800, 25e9, 0.28, 70e6, 7e6, 14e6, 4000, 2300, 0.014, 0.020, 0.007, 0.40, 0.30, 0.20, 30, 4e6, "片岩"),
        ("ore_iron", 3800, 80e9, 0.24, 130e6, 13e6, 28e6, 5200, 3000, 0.010, 0.014, 0.005, 0.35, 0.25, 0.15, 42, 9e6, "铁矿石"),
        ("ore_copper", 3000, 55e9, 0.26, 100e6, 10e6, 20e6, 4900, 2850, 0.011, 0.016, 0.006, 0.50, 0.35, 0.20, 38, 7e6, "铜矿石"),
    ]
    for r in rocks:
        cursor.execute(
            """INSERT INTO blasting_rock_params
            (rock_type, density, youngs_modulus, poissons_ratio, compressive_strength,
             tensile_strength, shear_strength, p_wave_speed, s_wave_speed,
             attenuation_p, attenuation_s, attenuation_rayleigh,
             color_r, color_g, color_b, friction_angle, cohesion, description)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE density=VALUES(density)""",
            r
        )
    print(f"[OK] 岩体参数: {len(rocks)} 种")


def seed_render_configs(cursor):
    """填充渲染配置"""
    configs = [
        ("realistic_default", "point", 5000, 6, 5, 3, 4, 8, 10,
         1.0, 0.78, 0.20, 0.80, 0.86, 0.63, 0.31, 0.90,
         0.71, 0.67, 0.63, 0.40, 1.0, 0.40, 0.05, 0.85,
         0.20, 0.20, 0.20, 0.50,
         3, 0.26, 2.0, 0.22, 1.0, 0.85, 0.20, 0.45,
         48, 200, 0.6, 1.5, 15, 8.0, 2.0, 8.0, 5.0,
         0.15, 2.0, 200, 9.8, 0.04, 0.35, 0.6, 0.05, 120, 1, 1, 1, 1, 1, 1, 1,
         "真实爆破默认配置"),
        ("high_performance", "point", 3000, 5, 4, 2, 3, 6, 8,
         1.0, 0.75, 0.18, 0.70, 0.82, 0.60, 0.28, 0.85,
         0.68, 0.64, 0.60, 0.35, 1.0, 0.38, 0.05, 0.80,
         0.22, 0.22, 0.22, 0.45,
         2, 0.22, 1.5, 0.18, 1.0, 0.80, 0.18, 0.40,
         32, 150, 0.5, 1.2, 12, 6.0, 1.5, 6.0, 5.0,
         0.20, 1.5, 150, 9.8, 0.05, 0.30, 0.6, 0.06, 100, 1, 1, 1, 0, 1, 1, 1,
         "高性能模式（减少粒子）"),
        ("ultra_realistic", "particle", 8000, 8, 6, 4, 5, 10, 12,
         1.0, 0.80, 0.22, 0.85, 0.88, 0.65, 0.32, 0.92,
         0.73, 0.69, 0.65, 0.45, 1.0, 0.42, 0.06, 0.90,
         0.18, 0.18, 0.18, 0.55,
         4, 0.30, 2.5, 0.25, 1.0, 0.88, 0.22, 0.50,
         64, 250, 0.7, 2.0, 20, 10.0, 2.5, 10.0, 5.0,
         0.10, 2.5, 300, 9.8, 0.035, 0.38, 0.65, 0.04, 150, 1, 1, 1, 1, 1, 1, 1,
         "超真实模式（最大粒子数）"),
    ]
    for c in configs:
        cursor.execute(
            """INSERT INTO blasting_render_config
            (config_name, fragment_render_mode, max_particles,
             particle_size_shock, particle_size_fragment, particle_size_dust, particle_size_spall,
             particle_size_fire, particle_size_smoke,
             color_shock_r, color_shock_g, color_shock_b, color_shock_a,
             color_fragment_r, color_fragment_g, color_fragment_b, color_fragment_a,
             color_dust_r, color_dust_g, color_dust_b, color_dust_a,
             color_fire_r, color_fire_g, color_fire_b, color_fire_a,
             color_smoke_r, color_smoke_g, color_smoke_b, color_smoke_a,
             wave_rings, wave_ring_opacity, trail_width, trail_glow_power,
             trail_color_r, trail_color_g, trail_color_b, trail_color_a,
             heatmap_resolution, heatmap_max_radius, heatmap_opacity,
             fireball_duration, fireball_max_radius, smoke_duration, smoke_rise_speed, dust_duration,
             shockwave_speed, fragment_min_size, fragment_max_size, fragment_count_base,
             gravity, air_drag, restitution, friction, time_step, frame_count,
             enable_collision, enable_heatmap, enable_monitor_points, enable_smoke, enable_fireball, enable_dust, enable_trails,
             description)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE config_name=VALUES(config_name)""",
            c
        )
    print(f"[OK] 渲染配置: {len(configs)} 套")


def seed_events(cursor):
    """填充爆破事件"""
    events = [
        ("BLAST-2026-001", "露天台阶爆破-北区", 116.3915, 39.9015, 0, 320, "emulsion", "electronic",
         datetime(2026, 7, 15, 10, 30), "granite", "clear", 25, 3, 45, "planned", "北区台阶爆破，6孔延时"),
        ("BLAST-2026-002", "井下巷道掘进爆破", 116.3920, 39.9020, -50, 180, "emulsion", "nonel",
         datetime(2026, 7, 16, 14, 0), "limestone", "cloudy", 18, 5, 90, "planned", "巷道掘进，楔形掏槽"),
        ("BLAST-2026-003", "矿体崩落爆破-主矿体", 116.3905, 39.9005, -80, 850, "anfo", "electronic",
         datetime(2026, 7, 18, 9, 0), "ore_iron", "clear", 28, 2, 180, "planned", "大规模崩落爆破"),
        ("BLAST-2026-004", "边坡控制爆破", 116.3925, 39.9025, 30, 95, "emulsion", "electric",
         datetime(2026, 7, 20, 11, 0), "sandstone", "clear", 22, 4, 270, "planned", "预裂爆破控制边坡"),
        ("BLAST-2026-005", "隧道光面爆破", 116.3930, 39.9030, -120, 65, "emulsion", "nonel",
         datetime(2026, 7, 22, 15, 30), "marble", "rain", 15, 8, 60, "planned", "光面爆破减少超欠挖"),
    ]
    for e in events:
        cursor.execute(
            """INSERT INTO blasting_events
            (event_id, name, center_lon, center_lat, center_height, charge_kg,
             explosive_type, detonation_method, blast_time, rock_type,
             weather, temperature, wind_speed, wind_direction, status, description)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE name=VALUES(name)""",
            e
        )
    print(f"[OK] 爆破事件: {len(events)} 个")


def seed_holes(cursor):
    """填充炮孔设计"""
    event_holes = {
        "BLAST-2026-001": {"rows": 2, "cols": 3, "charge": 45, "delay_step": 25, "burden": 2.0, "spacing": 2.5},
        "BLAST-2026-002": {"rows": 1, "cols": 4, "charge": 35, "delay_step": 50, "burden": 1.5, "spacing": 1.8},
        "BLAST-2026-003": {"rows": 3, "cols": 4, "charge": 70, "delay_step": 42, "burden": 3.0, "spacing": 3.5},
        "BLAST-2026-004": {"rows": 1, "cols": 5, "charge": 19, "delay_step": 15, "burden": 1.2, "spacing": 1.0},
        "BLAST-2026-005": {"rows": 1, "cols": 3, "charge": 22, "delay_step": 100, "burden": 0.8, "spacing": 0.6},
    }
    event_centers = {
        "BLAST-2026-001": (116.3915, 39.9015, 0),
        "BLAST-2026-002": (116.3920, 39.9020, -50),
        "BLAST-2026-003": (116.3905, 39.9005, -80),
        "BLAST-2026-004": (116.3925, 39.9025, 30),
        "BLAST-2026-005": (116.3930, 39.9030, -120),
    }

    total = 0
    for event_id, cfg in event_holes.items():
        clon, clat, ch = event_centers[event_id]
        for row in range(1, cfg["rows"] + 1):
            for col in range(1, cfg["cols"] + 1):
                hole_id = f"H{row}-{col}"
                collar_lon = clon + (col - cfg["cols"] / 2 - 0.5) * 0.00002
                collar_lat = clat + (row - cfg["rows"] / 2 - 0.5) * 0.000015
                toe_lon = collar_lon + 0.000005
                toe_lat = collar_lat + 0.000006
                toe_h = ch - 8
                delay = (row - 1) * cfg["cols"] * cfg["delay_step"] + (col - 1) * cfg["delay_step"]
                hole_type = "production"
                if row == 1 and col == 1:
                    hole_type = "cut"
                elif col == cfg["cols"]:
                    hole_type = "perimeter"

                cursor.execute(
                    """INSERT INTO blasting_holes
                    (event_id, hole_id, row, `column`, collar_lon, collar_lat, collar_height,
                     toe_lon, toe_lat, toe_height, diameter, depth, charge_kg, delay_ms,
                     hole_type, burden, spacing, subdrill, stemming)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (event_id, hole_id, row, col, collar_lon, collar_lat, ch,
                     toe_lon, toe_lat, toe_h, 0.09, 10, cfg["charge"], delay,
                     hole_type, cfg["burden"], cfg["spacing"], 0.5, 1.0)
                )
                total += 1
    print(f"[OK] 炮孔设计: {total} 个")


def seed_simulation_data(cursor):
    """为每个事件生成完整模拟数据（帧/粒子/振动/应力）"""
    events = {
        "BLAST-2026-001": {"charge": 320, "frames": 120, "dt": 0.05, "fragments": 200, "rock": "granite"},
        "BLAST-2026-002": {"charge": 180, "frames": 100, "dt": 0.05, "fragments": 150, "rock": "limestone"},
        "BLAST-2026-003": {"charge": 850, "frames": 150, "dt": 0.05, "fragments": 350, "rock": "ore_iron"},
        "BLAST-2026-004": {"charge": 95, "frames": 80, "dt": 0.05, "fragments": 100, "rock": "sandstone"},
        "BLAST-2026-005": {"charge": 65, "frames": 90, "dt": 0.05, "fragments": 80, "rock": "marble"},
    }

    rng = random.Random(20260309)
    total_frames = 0
    total_particles = 0
    total_stress = 0

    for event_id, cfg in events.items():
        charge = cfg["charge"]
        frames = cfg["frames"]
        dt = cfg["dt"]
        frag_count = cfg["fragments"]

        # ── 生成粒子轨迹 ──
        particles = []
        # 冲击波粒子
        sw_count = min(50, max(10, charge // 10))
        for i in range(sw_count):
            theta = rng.random() * math.pi * 2
            phi = rng.random() * math.pi
            speed = 80 + rng.random() * 120
            particles.append({
                "id": f"SW{i+1:03d}", "type": "shock_wave",
                "vx": math.cos(theta) * math.sin(phi) * speed,
                "vy": math.sin(theta) * math.sin(phi) * speed,
                "vz": math.cos(phi) * speed,
                "size": 0.3 + rng.random() * 0.5,
                "density": 0.5, "life": 2.0
            })
        # 岩体碎片
        for i in range(frag_count):
            base_angle = (math.pi * 2 * i) / frag_count
            azimuth = base_angle + (rng.random() - 0.5) * 0.8
            elevation = math.pi * (0.15 + rng.random() * 0.35)
            speed = 15 + rng.random() * 45 + math.sqrt(charge) * 0.8
            particles.append({
                "id": f"RF{i+1:04d}", "type": "rock_fragment",
                "vx": math.cos(azimuth) * math.cos(elevation) * speed,
                "vy": math.sin(azimuth) * math.cos(elevation) * speed,
                "vz": math.sin(elevation) * speed,
                "size": 0.15 + rng.random() * 1.8,
                "density": 2500 + rng.random() * 500, "life": 999
            })
        # 粉尘粒子
        for i in range(min(300, frag_count * 3 // 2)):
            theta = rng.random() * math.pi * 2
            speed = 2 + rng.random() * 8
            particles.append({
                "id": f"DU{i+1:03d}", "type": "dust",
                "vx": math.cos(theta) * speed,
                "vy": math.sin(theta) * speed,
                "vz": 1 + rng.random() * 3,
                "size": 0.05 + rng.random() * 0.2,
                "density": 100, "life": 8.0
            })
        # 火焰粒子
        for i in range(min(40, charge // 8)):
            theta = rng.random() * math.pi * 2
            speed = 5 + rng.random() * 15
            particles.append({
                "id": f"FI{i+1:03d}", "type": "fire",
                "vx": math.cos(theta) * speed,
                "vy": math.sin(theta) * speed,
                "vz": 8 + rng.random() * 20,
                "size": 0.5 + rng.random() * 1.5,
                "density": 50, "life": 1.5
            })
        # 烟雾粒子
        for i in range(min(60, charge // 5)):
            theta = rng.random() * math.pi * 2
            speed = 1 + rng.random() * 4
            particles.append({
                "id": f"SM{i+1:03d}", "type": "smoke",
                "vx": math.cos(theta) * speed,
                "vy": math.sin(theta) * speed,
                "vz": 2 + rng.random() * 5,
                "size": 1.0 + rng.random() * 3.0,
                "density": 30, "life": 8.0
            })

        gravity = 9.8
        air_drag = 0.04
        restitution = 0.35
        friction = 0.6

        # ── 生成帧数据 ──
        for fi in range(frames):
            t = fi * dt
            alive_count = 0
            landed_count = 0
            max_dist = 0
            max_speed = 0
            total_energy = 0

            frame_particles = []
            for p in particles:
                if t > p["life"]:
                    continue
                # 物理积分
                drag = math.exp(-air_drag * dt)
                p["vx"] *= drag
                p["vy"] *= drag
                p["vz"] = p["vz"] * drag - gravity * dt
                p["x"] = p.get("x", 0) + p["vx"] * dt
                p["y"] = p.get("y", 0) + p["vy"] * dt
                p["z"] = p.get("z", 0) + p["vz"] * dt

                if p["z"] <= 0:
                    p["z"] = 0
                    if p["vz"] < 0:
                        p["vz"] = -p["vz"] * restitution
                        p["vx"] *= (1 - friction * 0.5)
                        p["vy"] *= (1 - friction * 0.5)
                        if abs(p["vz"]) < 0.5:
                            p["vz"] = 0
                            p["landed"] = True

                speed = math.sqrt(p["vx"]**2 + p["vy"]**2 + p["vz"]**2)
                dist = math.sqrt(p["x"]**2 + p["y"]**2)
                alive_count += 1
                if p.get("landed"):
                    landed_count += 1
                max_dist = max(max_dist, dist)
                max_speed = max(max_speed, speed)
                mass = p["density"] * p["size"]**3
                total_energy += 0.5 * mass * speed**2

                frame_particles.append((
                    event_id, p["id"], p["type"], fi,
                    round(p["x"], 3), round(p["y"], 3), round(p["z"], 3),
                    round(p["vx"], 2), round(p["vy"], 2), round(p["vz"], 2),
                    round(p["size"], 3), round(speed, 2), round(t, 3),
                    1 if p.get("landed") else 0, round(total_energy, 2)
                ))

            wave_radius = 5.0 * math.pow(max(0.01, t), 0.4) * math.pow(charge, 1/3)

            # 写入帧统计
            cursor.execute(
                """INSERT INTO blasting_frames
                (event_id, frame_index, time_sec, wave_radius, alive_count, landed_count,
                 max_distance, max_speed, total_energy, vibration_max, stress_max, min_safety_factor)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (event_id, fi, round(t, 3), round(wave_radius, 2),
                 alive_count, landed_count, round(max_dist, 2), round(max_speed, 2),
                 round(total_energy, 2),
                 round(min(1.0, charge * 0.01 * math.exp(-t * 0.5)), 4),
                 round(charge * 0.1 * math.exp(-t * 0.3), 2),
                 round(max(0.5, 5.0 - t * 0.5), 3))
            )

            # 批量写入粒子（每帧）
            if frame_particles:
                cursor.executemany(
                    """INSERT INTO blasting_particles
                    (event_id, particle_id, particle_type, frame_index,
                     pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, size, speed, age, landed, energy)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    frame_particles
                )
                total_particles += len(frame_particles)

            total_frames += 1

        # ── 生成振动场数据（每5帧采样一次以减少数据量）──
        for fi in range(0, frames, 5):
            t = fi * dt
            res = 48
            max_radius = 200
            field_data = []
            for j in range(res):
                for i in range(res):
                    x = (i / (res - 1) - 0.5) * 2 * max_radius
                    y = (j / (res - 1) - 0.5) * 2 * max_radius
                    dist = math.sqrt(x**2 + y**2)
                    if dist < 0.1 or t < dist / 4500:
                        field_data.append(0.0)
                    else:
                        decay = math.exp(-0.012 * dist) / (1 + dist * 0.01)
                        envelope = math.exp(-((t - dist / 2600) / 0.25)**2)
                        intensity = charge * 0.5 * decay * envelope / 500
                        field_data.append(round(min(1.0, intensity), 4))

            cursor.execute(
                """INSERT INTO blasting_vibration
                (event_id, frame_index, grid_resolution, max_radius, max_intensity, field_data)
                VALUES (%s,%s,%s,%s,%s,%s)""",
                (event_id, fi, res, max_radius,
                 round(max(field_data), 4), json.dumps(field_data))
            )

        # ── 生成监测点与应力数据 ──
        distances = [5, 15, 30, 60, 100, 150]
        angles = [0, math.pi / 3, 2 * math.pi / 3, math.pi, 4 * math.pi / 3, 5 * math.pi / 3]
        monitor_points = []

        for i in range(3):
            a = angles[i]
            monitor_points.append(("NEAR-" + str(i + 1), f"近区点{i+1}", "near_field",
                                   math.cos(a) * distances[0], math.sin(a) * distances[0], 0))
        for i in range(3):
            a = angles[i + 3]
            monitor_points.append(("FREE-" + str(i + 1), f"自由面点{i+1}", "free_face",
                                   math.cos(a) * distances[1], math.sin(a) * distances[1], 0))
        for di in range(2, len(distances)):
            for ai in range(3):
                a = angles[ai * 2]
                d = distances[di]
                zt = "mid_field" if di < 4 else "far_field"
                monitor_points.append((f"MID-{di}-{ai+1}", f"{d}m点{ai+1}", zt,
                                       math.cos(a) * d, math.sin(a) * d, 0))

        for mp in monitor_points:
            cursor.execute(
                """INSERT INTO blasting_monitor_points
                (event_id, point_id, label, zone_type, pos_x, pos_y, pos_z)
                VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (event_id, mp[0], mp[1], mp[2], mp[3], mp[4], mp[5])
            )

        # 应力时程
        for fi in range(frames):
            t = fi * dt
            for mp in monitor_points:
                dist = math.sqrt(mp[3]**2 + mp[4]**2)
                if dist < 0.1 or t < dist / 4500:
                    intensity = 0
                else:
                    decay = math.exp(-0.012 * dist) / (1 + dist * 0.01)
                    envelope = math.exp(-((t - dist / 2600) / 0.25)**2)
                    intensity = charge * 0.5 * decay * envelope / 500
                intensity = min(1.0, intensity)
                v_max = intensity * 0.8
                sigma_p = 2650 * 5500 * v_max
                sigma_s = 2650 * 3200 * v_max * 0.7
                sigma1 = (sigma_p + sigma_s * 0.3) / 1e6
                sigma2 = ((sigma_p - sigma_s) * 0.3) / 1e6
                sigma3 = (-sigma_s * 0.5) / 1e6
                mises = math.sqrt(0.5 * ((sigma1 - sigma2)**2 + (sigma2 - sigma3)**2 + (sigma3 - sigma1)**2))
                sf = 80e6 / max(1, mises * 1e6) if mises > 0 else 99
                level = "safe" if sf > 3 else ("watch" if sf > 1.5 else ("warning" if sf > 1.0 else "danger"))

                cursor.execute(
                    """INSERT INTO blasting_stress
                    (event_id, point_id, frame_index, time_sec, intensity, vibration_velocity,
                     sigma1, sigma2, sigma3, mises, safety_factor, safety_level, max_tensile)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (event_id, mp[0], fi, round(t, 3), round(intensity, 4), round(v_max, 4),
                     round(sigma1, 3), round(sigma2, 3), round(sigma3, 3), round(mises, 3),
                     round(sf, 3), level, round(max(0, -sigma3), 3))
                )
                total_stress += 1

    print(f"[OK] 模拟数据: {total_frames} 帧, {total_particles} 粒子记录, {total_stress} 应力记录")


def main():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()

    print("=" * 60)
    print("爆破模拟数据库初始化")
    print("=" * 60)

    print("\n[1/4] 执行 Schema...")
    execute_schema(cursor)

    print("\n[2/4] 填充岩体参数...")
    seed_rock_params(cursor)

    print("\n[3/4] 填充渲染配置...")
    seed_render_configs(cursor)

    print("\n[4/4] 填充事件与模拟数据...")
    seed_events(cursor)
    seed_holes(cursor)
    seed_simulation_data(cursor)

    conn.commit()
    cursor.close()
    conn.close()

    print("\n" + "=" * 60)
    print("数据库初始化完成！")
    print("=" * 60)


if __name__ == "__main__":
    main()
