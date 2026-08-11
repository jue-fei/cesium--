"""
爆破模块数据迁移脚本：5 张扁平表 → 4 张关系型表 + 1 张字典表

旧: blasting_event_001 ~ blasting_event_005 (每表单行, holes_json TEXT)
新: blasting_events / blasting_design / blasting_design_holes / blasting_result / rock_params

用法:
  python migrate_blasting.py --dry-run    # 仅校验不写入
  python migrate_blasting.py --execute    # 实际写入（事务，失败回滚）

字段映射要点:
  - 旧 throw_spread_angle        → 新 blasting_result.spread_angle
  - 旧 rock_density/youngs_modulus/... → 提取到 rock_params 字典表（按 rock_type 去重）
  - 旧 holes_json (JSON 数组)     → 逐孔 INSERT 到 blasting_design_holes
  - 旧表缺失的 tunnel_length/face_thickness/face_offset/hole_depth/hole_diameter/
    utilization/advance_length 用新表 schema 默认值填充
"""
import os
import sys
import json
import argparse
from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "cesium_platform"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}

OLD_TABLES = [
    "blasting_event_001",
    "blasting_event_002",
    "blasting_event_003",
    "blasting_event_004",
    "blasting_event_005",
]

NEW_TABLES = [
    "blasting_events",
    "blasting_design",
    "blasting_design_holes",
    "blasting_result",
    "rock_params",
]

# 旧表缺失的新设计字段，使用新表 schema 默认值填充
DESIGN_DEFAULTS = {
    "tunnel_length": 80.0,
    "face_thickness": 2.0,
    "face_offset": 3.0,
    "hole_depth": 2.5,
    "hole_diameter": 0.04,
    "utilization": 0.85,
    # advance_length 由 hole_depth * utilization 计算
}

# ─── 字段映射定义 ───────────────────────────────────────────
EVENT_FIELDS = [
    "event_id", "name", "center_lon", "center_lat", "center_height", "charge_kg",
    "explosive_type", "detonation_method", "blast_time", "rock_type",
    "weather", "temperature", "wind_speed", "wind_direction", "status", "description",
]

DESIGN_FIELDS_FROM_OLD = [
    "tunnel_shape", "tunnel_width", "tunnel_wall_height", "tunnel_arch_radius",
    "tunnel_total_height", "cut_pattern", "cut_angle", "cut_hole_count", "empty_hole_count",
    "initiation_network", "delay_interval_ms",
    "charge_density_cut", "charge_density_aux", "charge_density_perim", "stemming_length",
    "expected_x50", "expected_xmax", "expected_throw_distance", "expected_overbreak",
    "min_safety_distance", "max_vibration_velocity",
]

RESULT_FIELDS_FROM_OLD = [
    "random_seed", "simulation_duration_s", "time_step_s",
    "crater_depth", "crater_radius", "crater_center_offset_y",
    "overbreak_max", "overbreak_min", "half_barrel_ratio",
    "fragment_count", "fragment_x50", "fragment_x80", "fragment_xmax", "fragment_b", "fragment_n",
    "throw_distance_max", "throw_distance_avg",
    # 注意: throw_spread_angle → spread_angle 单独映射
    "vibration_peak", "vibration_velocity_max", "stress_peak_mpa", "min_safety_factor",
    "smoke_intensity", "dust_intensity", "fire_intensity", "spark_intensity", "shockwave_speed_factor",
]

HOLE_COLUMNS = [
    "event_id", "hole_index", "pos_x", "pos_y", "pos_z", "hole_type", "diameter", "depth",
    "inclination_angle", "inclination_azimuth", "charge_kg", "charge_length",
    "explosive_type", "detonator_series", "delay_ms", "is_empty_hole",
]


def get_conn():
    return pymysql.connect(**DB_CONFIG)


def _validate_table_name(name):
    """校验旧表名格式，防止注入（仅允许 blasting_event_XXX）"""
    if not (name.startswith("blasting_event_") and len(name) == 19 and name[-3:].isdigit()):
        raise ValueError(f"非法旧表名: {name}")


def parse_holes_json(raw):
    """解析 holes_json 字段，返回 list[dict]"""
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        return json.loads(s)
    return []


def _build_insert(table, data):
    """构造 INSERT SQL 与参数列表"""
    cols = list(data.keys())
    col_list = ", ".join(f"`{c}`" for c in cols)
    placeholders = ", ".join(["%s"] * len(cols))
    sql = f"INSERT INTO `{table}` ({col_list}) VALUES ({placeholders})"
    return sql, [data[c] for c in cols]


def migrate_event(cursor, table_name, dry_run=False):
    """
    读取一张旧扁平表（单行），拆分写入到 4 张新表 + rock_params。
    返回 (event_id, holes_count)，无数据时返回 (None, 0)。
    """
    _validate_table_name(table_name)

    cursor.execute(f"SELECT * FROM `{table_name}`")
    rows = cursor.fetchall()
    if not rows:
        print(f"  [{table_name}] 旧表无数据，跳过")
        return None, 0

    old = rows[0]
    event_id = old["event_id"]
    print(f"  [{table_name}] 读取事件 {event_id} ({old.get('name', '')})")

    # 解析炮孔 JSON
    holes = parse_holes_json(old.get("holes_json"))
    if not isinstance(holes, list):
        holes = []
    print(f"    炮孔数: {len(holes)}")

    # ─── 组装 blasting_events ───
    event_data = {f: old.get(f) for f in EVENT_FIELDS}

    # ─── 组装 blasting_design ───
    design_data = {"event_id": event_id}
    design_data.update({f: old.get(f) for f in DESIGN_FIELDS_FROM_OLD})
    design_data.update(DESIGN_DEFAULTS)
    # advance_length = hole_depth * utilization
    design_data["advance_length"] = round(
        design_data["hole_depth"] * design_data["utilization"], 4
    )

    # ─── 组装 blasting_design_holes ───
    hole_rows = []
    for idx, h in enumerate(holes):
        if not isinstance(h, dict):
            continue
        hole_rows.append({
            "event_id": event_id,
            "hole_index": idx,
            "pos_x": h.get("pos_x", 0),
            "pos_y": h.get("pos_y", 0),
            "pos_z": h.get("pos_z", 0),
            "hole_type": h.get("hole_type", "auxiliary"),
            "diameter": h.get("diameter", design_data["hole_diameter"]),
            "depth": h.get("depth", design_data["hole_depth"]),
            "inclination_angle": h.get("inclination_angle", 0),
            "inclination_azimuth": h.get("inclination_azimuth", 0),
            "charge_kg": h.get("charge_kg", 0),
            "charge_length": h.get("charge_length", 0),
            "explosive_type": h.get("explosive_type", event_data["explosive_type"]),
            "detonator_series": h.get("detonator_series", 1),
            "delay_ms": h.get("delay_ms", 0),
            "is_empty_hole": h.get("is_empty_hole", 0),
        })

    # ─── 组装 blasting_result ───
    result_data = {"event_id": event_id}
    result_data.update({f: old.get(f) for f in RESULT_FIELDS_FROM_OLD})
    # 旧 throw_spread_angle → 新 spread_angle
    result_data["spread_angle"] = old.get("throw_spread_angle", 45)

    # ─── 组装 rock_params ───
    rock_type = old.get("rock_type")
    rock_data = {
        "rock_type": rock_type,
        "density": old.get("rock_density"),
        "youngs_modulus": old.get("rock_youngs_modulus"),
        "compressive_strength": old.get("rock_compressive_strength"),
        "p_wave_speed": old.get("rock_p_wave_speed"),
        "s_wave_speed": old.get("rock_s_wave_speed"),
    }

    if dry_run:
        print(f"    [DRY-RUN] 将写入: events(1) + design(1) + holes({len(hole_rows)}) "
              f"+ result(1) + rock_params(1, rock_type={rock_type}, 去重)")
        return event_id, len(hole_rows)

    # ─── 实际写入（事务内，由调用方提交/回滚）───
    # 0) 清理已有同 event_id 数据（ON DELETE CASCADE 自动清理 design/holes/result）
    cursor.execute("DELETE FROM `blasting_events` WHERE event_id=%s", (event_id,))

    # 1) rock_params 去重写入（ON DUPLICATE KEY UPDATE，相同 rock_type 只生效一次）
    cols = list(rock_data.keys())
    col_list = ", ".join(f"`{c}`" for c in cols)
    placeholders = ", ".join(["%s"] * len(cols))
    update_clause = ", ".join(f"`{c}`=VALUES(`{c}`)" for c in cols if c != "rock_type")
    sql = (
        f"INSERT INTO `rock_params` ({col_list}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )
    cursor.execute(sql, [rock_data[c] for c in cols])

    # 2) blasting_events（父表，必须先于子表）
    sql, params = _build_insert("blasting_events", event_data)
    cursor.execute(sql, params)

    # 3) blasting_design（FK → events）
    sql, params = _build_insert("blasting_design", design_data)
    cursor.execute(sql, params)

    # 4) blasting_design_holes（FK → events，批量插入）
    if hole_rows:
        col_list = ", ".join(f"`{c}`" for c in HOLE_COLUMNS)
        placeholders = ", ".join(["%s"] * len(HOLE_COLUMNS))
        sql = f"INSERT INTO `blasting_design_holes` ({col_list}) VALUES ({placeholders})"
        batch = [[row[c] for c in HOLE_COLUMNS] for row in hole_rows]
        cursor.executemany(sql, batch)

    # 5) blasting_result（FK → events）
    sql, params = _build_insert("blasting_result", result_data)
    cursor.execute(sql, params)

    return event_id, len(hole_rows)


def migrate_all(cursor, dry_run=False):
    """遍历 5 张旧表，依次调用 migrate_event"""
    print("\n" + "=" * 60)
    print("迁移 5 张扁平表 → 4 张关系型表 + 1 张字典表")
    print("=" * 60)
    total_holes = 0
    migrated_events = []
    for tbl in OLD_TABLES:
        event_id, n_holes = migrate_event(cursor, tbl, dry_run=dry_run)
        if event_id:
            migrated_events.append(event_id)
            total_holes += n_holes
    print(f"\n[OK] 共迁移 {len(migrated_events)} 个事件, 炮孔总数 {total_holes}")
    print(f"     事件 ID: {migrated_events}")
    return migrated_events, total_holes


def verify_migration(cursor, expected_holes=None):
    """校验：行数匹配 + 外键完整"""
    print("\n" + "=" * 60)
    print("校验迁移结果")
    print("=" * 60)
    ok = True

    # 1) 行数统计
    print("\n[1/3] 各新表行数:")
    counts = {}
    for tbl in NEW_TABLES:
        cursor.execute(f"SELECT COUNT(*) AS c FROM `{tbl}`")
        counts[tbl] = cursor.fetchone()["c"]
        print(f"  {tbl:25s} {counts[tbl]:>6} 行")

    # 2) 期望值校验
    print("\n[2/3] 期望值校验:")
    checks = [
        ("blasting_events", 5),
        ("blasting_design", 5),
        ("blasting_result", 5),
    ]
    if expected_holes is not None:
        checks.append(("blasting_design_holes", expected_holes))
    for name, exp in checks:
        got = counts[name]
        flag = "OK" if exp == got else "FAIL"
        if flag == "FAIL":
            ok = False
        print(f"  {name:25s} 期望={exp:>5}  实际={got:>5}  [{flag}]")

    # 3) 外键完整性（子表 event_id 必须存在于 blasting_events）
    print("\n[3/3] 外键完整性:")
    for child in ["blasting_design", "blasting_design_holes", "blasting_result"]:
        cursor.execute(f"""
            SELECT COUNT(*) AS c FROM `{child}` c
            LEFT JOIN `blasting_events` e ON c.event_id = e.event_id
            WHERE e.event_id IS NULL
        """)
        orphans = cursor.fetchone()["c"]
        flag = "OK" if orphans == 0 else "FAIL"
        if flag == "FAIL":
            ok = False
        print(f"  {child:25s} 孤儿行: {orphans}  [{flag}]")

    # 附加：各事件炮孔数明细
    print("\n[附加] 各事件炮孔数:")
    cursor.execute("""
        SELECT event_id, COUNT(*) AS n
        FROM blasting_design_holes
        GROUP BY event_id
        ORDER BY event_id
    """)
    for r in cursor.fetchall():
        print(f"  {r['event_id']:20s} {r['n']:>5} 孔")

    print("\n" + ("[OK] 校验通过" if ok else "[FAIL] 校验未通过"))
    return ok


def _check_tables_exist(cursor):
    """预检：确认旧表与新表均存在"""
    print("\n[预检] 检查表是否存在:")
    all_ok = True
    for tbl in OLD_TABLES + NEW_TABLES:
        cursor.execute("SHOW TABLES LIKE %s", (tbl,))
        exists = cursor.fetchone() is not None
        flag = "OK" if exists else "MISSING"
        if not exists:
            all_ok = False
        print(f"  {tbl:25s} {flag}")
    return all_ok


def main():
    parser = argparse.ArgumentParser(
        description="爆破模块数据迁移：5 张扁平表 → 4 张关系型表 + 字典表"
    )
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="仅校验不写入")
    g.add_argument("--execute", action="store_true", help="实际写入（事务，失败回滚）")
    args = parser.parse_args()

    print("=" * 60)
    print("爆破模块数据迁移脚本")
    print(f"模式: {'DRY-RUN (仅校验)' if args.dry_run else 'EXECUTE (实际写入)'}")
    print("=" * 60)

    conn = get_conn()
    # 关闭 autocommit，使用显式事务
    conn.autocommit(False)
    cursor = conn.cursor()

    try:
        # 预检
        if not _check_tables_exist(cursor):
            print("\n[FAIL] 预检失败：部分表不存在，请先应用新 schema")
            sys.exit(1)

        if args.dry_run:
            # 仅校验：解析旧表数据，不写入
            migrated_events, total_holes = migrate_all(cursor, dry_run=True)
            print("\n[DRY-RUN] 未执行任何写入操作")
            print(f"[DRY-RUN] 预计迁移 {len(migrated_events)} 个事件, {total_holes} 个炮孔")
        else:
            # 实际写入：使用事务，失败回滚
            try:
                migrated_events, total_holes = migrate_all(cursor, dry_run=False)
                conn.commit()
                print("\n[OK] 事务已提交")
            except Exception as e:
                conn.rollback()
                print(f"\n[FAIL] 迁移失败，已回滚: {e}")
                raise
            # 校验
            verify_ok = verify_migration(cursor, expected_holes=total_holes)
            if not verify_ok:
                print("\n[WARN] 校验未通过，请检查数据")
                sys.exit(1)
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()
