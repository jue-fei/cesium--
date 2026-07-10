"""
爆破模块数据迁移脚本：V1 扁平表 → V2 宽表（blasting_events 单表 + 5 JSON 列）

旧: blasting_event_001 ~ blasting_event_005 (每表单行, holes_json TEXT, 英文列名+英文枚举)
新: blasting_events (V2 宽表，标量中文列 + 5 JSON 聚合列)
    - 标量列: event_id/名称/爆心经度/爆心纬度/爆心高程/总装药量_kg/炸药类型/
              岩体类型/起爆方式/爆破时间/状态/备注
    - JSON 列: 炮孔设计/断面掘进/装药起爆/爆破效果/环境岩体

用法:
  python migrate_blasting.py --dry-run    # 仅校验不写入
  python migrate_blasting.py --execute    # 实际写入（事务，失败回滚）

字段映射要点:
  - 旧英文标量列 → 新中文标量列（event_id/名称/状态/爆破时间/总装药量_kg/岩体类型 等）
  - 旧英文枚举值 → 新中文枚举值（planned→已规划, emulsion→乳化炸药, granite→花岗岩 ...）
  - 旧 holes_json (JSON 数组, 英文 key) → 炮孔设计 JSON 列（中文 key）
  - 旧 design 字段 → 断面掘进 + 装药起爆 JSON 列
  - 旧 result 字段 → 爆破效果 JSON 列（throw_spread_angle → 抛掷扩散角_度）
  - 旧 rock_* + weather/wind → 环境岩体 JSON 列（缺失字段从岩体参数参考表补齐）
  - 旧表缺失的 tunnel_length/face_thickness/face_offset/hole_depth/hole_diameter/
    utilization/advance_length 用默认值填充

枚举映射与 JSON 组装方式与 app/routes/blasting.py、seed_blasting.py 保持一致。
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

# V2 仅一张主表
NEW_TABLES = ["blasting_events"]

# 旧表缺失的新设计字段，使用默认值填充
DESIGN_DEFAULTS = {
    "tunnel_length": 80.0,
    "face_thickness": 2.0,
    "face_offset": 3.0,
    "hole_depth": 2.5,
    "hole_diameter": 0.04,
    "utilization": 0.85,
    # advance_length 由 hole_depth * utilization 计算
}

# ============================================================
# 枚举映射（API 英文值 → DB 中文值，与 app/routes/blasting.py 保持一致）
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
INIT_API2DB = {
    "electric": "电雷管", "nonel": "导爆管", "electronic": "电子雷管",
    "detonating_cord": "导爆索",
}
CUT_API2DB = {
    "four_section": "四段掏槽", "single_spiral": "单螺旋",
    "double_spiral": "双螺旋", "wedge": "楔形", "burn": "直眼",
}
HOLETYPE_API2DB = {
    "cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔",
    "floor": "底板孔", "empty": "空孔",
}
WEATHER_API2DB = {"clear": "晴", "cloudy": "多云", "rain": "雨"}

# ─── V2 标量列（中文列名）───────────────────────────────────
SCALAR_COLS = [
    "event_id", "名称", "爆心经度", "爆心纬度", "爆心高程", "总装药量_kg",
    "炸药类型", "岩体类型", "起爆方式", "爆破时间", "状态", "备注",
]

# 5 JSON 列
JSON_COLS = ["炮孔设计", "断面掘进", "装药起爆", "爆破效果", "环境岩体"]


def _conv(value, mapping):
    """枚举值转换，未知值原样返回"""
    if value is None:
        return None
    return mapping.get(value, value)


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


def _build_scalar_data(old):
    """从 V1 旧行构建 V2 标量列数据（含枚举中文化）"""
    return {
        "event_id": old.get("event_id"),
        "名称": old.get("name"),
        "爆心经度": old.get("center_lon"),
        "爆心纬度": old.get("center_lat"),
        "爆心高程": old.get("center_height"),
        "总装药量_kg": old.get("charge_kg"),
        "炸药类型": _conv(old.get("explosive_type"), EXPLOSIVE_API2DB),
        "岩体类型": _conv(old.get("rock_type"), ROCK_API2DB),
        "起爆方式": _conv(old.get("detonation_method"), INIT_API2DB),
        "爆破时间": old.get("blast_time"),
        "状态": _conv(old.get("status"), STATUS_API2DB),
        "备注": old.get("description"),
    }


def _build_tunnel_json(old):
    """断面掘进 JSON（中文 key，参考 seed_blasting.py 与 blasting.py TUNNEL_JSON_MAP）"""
    hole_depth = old.get("hole_depth", DESIGN_DEFAULTS["hole_depth"])
    hole_diameter = old.get("hole_diameter", DESIGN_DEFAULTS["hole_diameter"])
    utilization = old.get("utilization", DESIGN_DEFAULTS["utilization"])
    advance_length = old.get("advance_length")
    if advance_length is None:
        advance_length = round(hole_depth * utilization, 4)
    return {
        "断面形状": _conv(old.get("tunnel_shape"), SHAPE_API2DB),
        "断面宽度_m": old.get("tunnel_width"),
        "直墙高度_m": old.get("tunnel_wall_height"),
        "拱部半径_m": old.get("tunnel_arch_radius"),
        "断面总高度_m": old.get("tunnel_total_height"),
        "已开挖长度_m": old.get("tunnel_length", DESIGN_DEFAULTS["tunnel_length"]),
        "掌子面厚度_m": old.get("face_thickness", DESIGN_DEFAULTS["face_thickness"]),
        "掌子面距爆心_m": old.get("face_offset", DESIGN_DEFAULTS["face_offset"]),
        "钻孔深度_m": hole_depth,
        "钻孔直径_m": hole_diameter,
        "炮孔利用率": utilization,
        "单循环进尺_m": advance_length,
    }


def _build_charge_json(old):
    """装药起爆 JSON（中文 key，参考 CHARGE_JSON_MAP）"""
    return {
        "掏槽模式": _conv(old.get("cut_pattern"), CUT_API2DB),
        "楔形掏槽角_度": old.get("cut_angle"),
        "装药掏槽孔数": old.get("cut_hole_count"),
        "空孔数": old.get("empty_hole_count"),
        "起爆网络": _conv(old.get("initiation_network"), INIT_API2DB),
        "段间延时间隔_ms": old.get("delay_interval_ms"),
        "掏槽线装药密度_kgm": old.get("charge_density_cut"),
        "辅助线装药密度_kgm": old.get("charge_density_aux"),
        "周边线装药密度_kgm": old.get("charge_density_perim"),
        "堵塞长度_m": old.get("stemming_length"),
    }


def _build_holes_json(old, event_explosive_cn):
    """炮孔设计 JSON（数组，中文 key，参考 HOLES_JSON_MAP）"""
    holes = parse_holes_json(old.get("holes_json"))
    hole_depth = old.get("hole_depth", DESIGN_DEFAULTS["hole_depth"])
    hole_diameter = old.get("hole_diameter", DESIGN_DEFAULTS["hole_diameter"])
    result = []
    for idx, h in enumerate(holes):
        if not isinstance(h, dict):
            continue
        result.append({
            "序号": idx + 1,
            "X坐标_m": h.get("pos_x", 0),
            "Y坐标_m": h.get("pos_y", 0),
            "孔类型": _conv(h.get("hole_type", "auxiliary"), HOLETYPE_API2DB),
            "孔径_m": h.get("diameter", hole_diameter),
            "孔深_m": h.get("depth", hole_depth),
            "倾角_度": h.get("inclination_angle", 0),
            "方位角_度": h.get("inclination_azimuth", 0),
            "装药量_kg": h.get("charge_kg", 0),
            "装药长度_m": h.get("charge_length", 0),
            "炸药类型": _conv(h.get("explosive_type"), EXPLOSIVE_API2DB) or event_explosive_cn,
            "雷管段别": h.get("detonator_series", 1),
            "延期时间_ms": h.get("delay_ms", 0),
            "是否空孔": h.get("is_empty_hole", 0),
        })
    return result


def _build_result_json(old):
    """爆破效果 JSON（中文 key，参考 RESULT_JSON_MAP）

    注意：旧 throw_spread_angle → 新 抛掷扩散角_度
    """
    return {
        "模拟随机种子": old.get("random_seed"),
        "模拟总时长_s": old.get("simulation_duration_s"),
        "时间步长_s": old.get("time_step_s"),
        "碎片总数": old.get("fragment_count"),
        "中位块度_x50_m": old.get("fragment_x50"),
        "80通过块度_x80_m": old.get("fragment_x80"),
        "最大块度_xmax_m": old.get("fragment_xmax"),
        "Swebrec弯曲参数_b": old.get("fragment_b"),
        "Cunningham均匀指数_n": old.get("fragment_n"),
        "漏斗深度_m": old.get("crater_depth"),
        "漏斗半径_m": old.get("crater_radius"),
        "漏斗中心偏移_m": old.get("crater_center_offset_y"),
        "最大抛掷距离_m": old.get("throw_distance_max"),
        "平均抛掷距离_m": old.get("throw_distance_avg"),
        "抛掷扩散角_度": old.get("throw_spread_angle", 45),
        "最大超挖_m": old.get("overbreak_max"),
        "最小超挖_m": old.get("overbreak_min"),
        "半孔率": old.get("half_barrel_ratio"),
        "峰值振动_Kine": old.get("vibration_peak"),
        "最大质点振速_cms": old.get("vibration_velocity_max"),
        "峰值应力_MPa": old.get("stress_peak_mpa"),
        "最小安全系数": old.get("min_safety_factor"),
        "烟雾强度": old.get("smoke_intensity"),
        "粉尘强度": old.get("dust_intensity"),
        "火球强度": old.get("fire_intensity"),
        "火花强度": old.get("spark_intensity"),
        "冲击波速度系数": old.get("shockwave_speed_factor"),
    }


def _build_env_json(old, cursor):
    """环境岩体 JSON（中文 key，参考 ENV_ROCK_MAP + ENV_EVENT_MAP）

    组合 weather/wind + 岩体参数（V1 事件值优先，缺失字段从岩体参数参考表补齐）
    """
    env = {
        "天气": _conv(old.get("weather"), WEATHER_API2DB),
        "温度_摄氏度": old.get("temperature"),
        "风速_ms": old.get("wind_speed"),
        "风向_度": old.get("wind_direction"),
    }

    rock_cn = _conv(old.get("rock_type"), ROCK_API2DB)
    if rock_cn:
        env["岩体类型"] = rock_cn
        # 从岩体参数参考表补齐缺失字段（抗拉强度/泊松比/内摩擦角等 V1 没有）
        ref = {}
        try:
            cursor.execute(
                "SELECT * FROM `岩体参数参考` WHERE `岩体类型` = %s",
                (rock_cn,),
            )
            ref_row = cursor.fetchone()
            if ref_row:
                for col in ref_row:
                    if col not in ("岩体类型", "更新时间"):
                        ref[col] = ref_row[col]
        except Exception:
            pass  # 参考表不存在时忽略，仅用 V1 值

        # V1 事件级岩体参数（优先于参考表）
        v1_rock = {
            "密度_kgm3": old.get("rock_density"),
            "弹性模量_GPa": old.get("rock_youngs_modulus"),
            "抗压强度_MPa": old.get("rock_compressive_strength"),
            "P波波速_ms": old.get("rock_p_wave_speed"),
            "S波波速_ms": old.get("rock_s_wave_speed"),
        }
        ref.update({k: v for k, v in v1_rock.items() if v is not None})
        env.update(ref)

    return env


def migrate_event(cursor, table_name, dry_run=False):
    """
    读取一张旧扁平表（单行），组装为 V2 blasting_events 宽表行并写入。
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

    # ─── 组装 V2 标量列 ───
    scalar_data = _build_scalar_data(old)
    event_explosive_cn = scalar_data.get("炸药类型")

    # ─── 组装 5 JSON 列 ───
    holes_json = json.dumps(_build_holes_json(old, event_explosive_cn), ensure_ascii=False)
    tunnel_json = json.dumps(_build_tunnel_json(old), ensure_ascii=False)
    charge_json = json.dumps(_build_charge_json(old), ensure_ascii=False)
    result_json = json.dumps(_build_result_json(old), ensure_ascii=False)
    env_json = json.dumps(_build_env_json(old, cursor), ensure_ascii=False)

    if dry_run:
        print(f"    [DRY-RUN] 将写入 blasting_events(1) + 5 JSON 列, 炮孔 {len(holes)} 个")
        return event_id, len(holes)

    # ─── 实际写入（事务内，由调用方提交/回滚）───
    # 清理已有同 event_id 数据
    cursor.execute("DELETE FROM `blasting_events` WHERE event_id=%s", (event_id,))

    all_cols = SCALAR_COLS + JSON_COLS
    col_list = ", ".join(f"`{c}`" for c in all_cols)
    placeholders = ", ".join(["%s"] * len(all_cols))
    update_clause = ", ".join(
        f"`{c}`=VALUES(`{c}`)" for c in all_cols if c != "event_id"
    )
    sql = (
        f"INSERT INTO `blasting_events` ({col_list}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )
    row = [scalar_data[c] for c in SCALAR_COLS] + [
        holes_json, tunnel_json, charge_json, result_json, env_json,
    ]
    cursor.execute(sql, row)

    return event_id, len(holes)


def migrate_all(cursor, dry_run=False):
    """遍历 5 张旧表，依次调用 migrate_event"""
    print("\n" + "=" * 60)
    print("迁移 V1 扁平表 → V2 blasting_events 宽表（标量列 + 5 JSON 列）")
    print("=" * 60)
    total_holes = 0
    migrated_events = []
    skipped = []
    for tbl in OLD_TABLES:
        # 向后兼容：V1 表不存在则跳过并提示
        cursor.execute("SHOW TABLES LIKE %s", (tbl,))
        if cursor.fetchone() is None:
            print(f"  [{tbl}] V1 旧表不存在，跳过")
            skipped.append(tbl)
            continue
        event_id, n_holes = migrate_event(cursor, tbl, dry_run=dry_run)
        if event_id:
            migrated_events.append(event_id)
            total_holes += n_holes
    print(f"\n[OK] 共迁移 {len(migrated_events)} 个事件, 炮孔总数 {total_holes}")
    if skipped:
        print(f"     跳过（V1 表不存在）: {skipped}")
    print(f"     事件 ID: {migrated_events}")
    return migrated_events, total_holes


def verify_migration(cursor, expected_events=None, expected_holes=None):
    """校验：行数 + JSON 列可解析"""
    print("\n" + "=" * 60)
    print("校验迁移结果")
    print("=" * 60)
    ok = True

    # 1) 行数统计
    print("\n[1/2] blasting_events 行数:")
    cursor.execute("SELECT COUNT(*) AS c FROM `blasting_events`")
    n_events = cursor.fetchone()["c"]
    print(f"  blasting_events  {n_events:>6} 行")
    if expected_events is not None:
        flag = "OK" if expected_events == n_events else "FAIL"
        if flag == "FAIL":
            ok = False
        print(f"  期望={expected_events:>5}  实际={n_events:>5}  [{flag}]")

    # 2) 各事件炮孔数 + JSON 列可解析性
    print("\n[2/2] 各事件炮孔数与 JSON 列校验:")
    cursor.execute(
        "SELECT event_id, `名称`, `状态`, `炮孔设计`, `断面掘进`, `装药起爆`, "
        "`爆破效果`, `环境岩体` FROM `blasting_events` ORDER BY event_id"
    )
    total_holes = 0
    for r in cursor.fetchall():
        holes = parse_holes_json(r.get("炮孔设计"))
        total_holes += len(holes)
        bad_json = []
        for col in ("断面掘进", "装药起爆", "爆破效果", "环境岩体"):
            raw = r.get(col)
            if raw is None:
                continue
            try:
                if isinstance(raw, str):
                    json.loads(raw)
            except Exception:
                bad_json.append(col)
        flag = "OK" if not bad_json else "FAIL"
        if bad_json:
            ok = False
        print(f"  {r['event_id']:20s} {(r['名称'] or ''):20s} 炮孔 {len(holes):>4}  JSON:[{flag}]"
              + (f" 损坏列={bad_json}" if bad_json else ""))

    if expected_holes is not None:
        flag = "OK" if expected_holes == total_holes else "FAIL"
        if flag == "FAIL":
            ok = False
        print(f"\n  炮孔总数 期望={expected_holes:>5}  实际={total_holes:>5}  [{flag}]")

    print("\n" + ("[OK] 校验通过" if ok else "[FAIL] 校验未通过"))
    return ok


def _check_tables_exist(cursor):
    """预检：V2 主表必须存在；V1 旧表可选（缺失将跳过）"""
    print("\n[预检] 检查表是否存在:")
    all_ok = True
    # V2 主表必须存在
    for tbl in NEW_TABLES:
        cursor.execute("SHOW TABLES LIKE %s", (tbl,))
        exists = cursor.fetchone() is not None
        flag = "OK" if exists else "MISSING"
        if not exists:
            all_ok = False
        print(f"  {tbl:25s} {flag}")
    # V1 旧表（可选，缺失则跳过）
    v1_present = 0
    for tbl in OLD_TABLES:
        cursor.execute("SHOW TABLES LIKE %s", (tbl,))
        exists = cursor.fetchone() is not None
        if exists:
            v1_present += 1
        print(f"  {tbl:25s} {'OK' if exists else '缺失(将跳过)'}")
    if v1_present == 0:
        print("\n[INFO] 无任何 V1 旧表存在，迁移无数据可处理")
    return all_ok


def _get_schema_version(cursor):
    """获取当前 schema 版本，无表返回 0"""
    try:
        cursor.execute("SELECT MAX(version) FROM schema_version")
        row = cursor.fetchone()
        if row and "MAX(version)" in row:
            return row["MAX(version)"] or 0
        # 兼容非 DictCursor：取第一列
        return (row[0] if row else 0) or 0
    except Exception:
        return 0


def _set_schema_version(cursor, version, description=""):
    """写入/更新 schema 版本记录"""
    cursor.execute(
        "INSERT INTO schema_version (version, description) VALUES (%s, %s) "
        "ON DUPLICATE KEY UPDATE applied_at = CURRENT_TIMESTAMP, description = %s",
        (version, description, description),
    )


def main():
    parser = argparse.ArgumentParser(
        description="爆破模块数据迁移：V1 扁平表 → V2 blasting_events 宽表"
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
        # 版本检查：若 schema 已是 V2，跳过迁移
        current_version = _get_schema_version(cursor)
        if current_version >= 2:
            print(f"\n[migrate] schema 已是版本 {current_version}，跳过迁移")
            return

        # 预检
        if not _check_tables_exist(cursor):
            print("\n[FAIL] 预检失败：V2 主表 blasting_events 不存在，请先应用 V2 schema")
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
                # 记录 schema 版本（与迁移数据在同一事务中提交）
                _set_schema_version(cursor, 2, "V2 宽表设计：blasting_events 单表 5 JSON 列")
                conn.commit()
                print("\n[OK] 事务已提交")
                print("[migrate] 迁移完成，schema 版本 → 2")
            except Exception as e:
                conn.rollback()
                print(f"\n[FAIL] 迁移失败，已回滚: {e}")
                raise
            # 校验
            verify_ok = verify_migration(
                cursor,
                expected_events=len(migrated_events),
                expected_holes=total_holes,
            )
            if not verify_ok:
                print("\n[WARN] 校验未通过，请检查数据")
                sys.exit(1)
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()
