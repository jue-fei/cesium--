"""
清理数据库中所有未使用的数据
运行: python clean_db.py
- 删除孤儿记录（外键关联的爆破事件已不存在）
- 报告清理结果
"""
import os, sys
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

BLASTING_CHILD_TABLES = [
    "blasting_holes", "blasting_frames", "blasting_particles",
    "blasting_vibration", "blasting_monitor_points", "blasting_stress",
    "blasting_rock_params", "blasting_kco_params",
]

ALL_TABLES = [
    "blasting_events", "blasting_holes", "blasting_frames",
    "blasting_particles", "blasting_vibration", "blasting_monitor_points",
    "blasting_stress", "blasting_rock_params", "blasting_render_config",
    "blasting_kco_params",
    "model_config", "truck_info", "truck_routes",
    "borehole_config", "orebodies", "mineral_types",
    "mining_pit_specs", "geology_stats",
]


def main():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()
    total_deleted = 0

    print("=" * 55)
    print("  数据库清理工具")
    print("=" * 55)

    # ── 1. 当前状态 ──
    print("\n[1/4] 当前数据库状态:")
    for t in ALL_TABLES:
        try:
            cursor.execute(f"SELECT COUNT(*) AS cnt FROM `{t}`")
            r = cursor.fetchone()
            print(f"  {t:30s} {r['cnt']:>6} 行")
        except:
            print(f"  {t:30s} (不存在)")

    # ── 2. 现有事件 ──
    print("\n[2/4] 现有爆破事件:")
    cursor.execute("SELECT event_id, name, status FROM blasting_events")
    events = cursor.fetchall()
    valid_ids = {e["event_id"] for e in events}
    for e in events:
        print(f"  {e['event_id']} | {e['status']:10s} | {e['name']}")
    if not events:
        print("  (无事件)")

    # ── 3. 清理爆破子表孤儿 ──
    print("\n[3/4] 清理爆破子表孤儿数据:")
    for table in BLASTING_CHILD_TABLES:
        try:
            cursor.execute(f"""
                DELETE FROM `{table}`
                WHERE event_id NOT IN (SELECT e.event_id FROM blasting_events e)
            """)
            n = cursor.rowcount
            if n > 0:
                print(f"  {table}: 删除 {n} 行")
                total_deleted += n
        except Exception as e:
            print(f"  {table}: 跳过 ({e})")
    conn.commit()

    if total_deleted == 0:
        print("  无孤儿数据")

    # ── 4. 最终状态 ──
    print(f"\n[4/4] 清理完成，共删除 {total_deleted} 行")
    for t in ALL_TABLES:
        try:
            cursor.execute(f"SELECT COUNT(*) AS cnt FROM `{t}`")
            r = cursor.fetchone()
            print(f"  {t:30s} {r['cnt']:>6} 行")
        except:
            pass

    cursor.close()
    conn.close()
    print("\n[DONE]")


if __name__ == "__main__":
    main()
