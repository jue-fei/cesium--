"""
清理数据库中未使用的数据（V2 宽表设计）
运行: python clean_db.py
- 报告爆破相关表当前状态（blasting_events / 岩体参数参考 / schema_version）
- V2 为单宽表设计，无子表，无孤儿数据清理逻辑
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

# V2 宽表设计无子表，孤儿清理列表为空
BLASTING_CHILD_TABLES = []

# V2 实际存在的表
ALL_TABLES = ["blasting_events", "岩体参数参考", "schema_version"]


def main():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()

    print("=" * 55)
    print("  数据库清理工具（V2 宽表设计）")
    print("=" * 55)

    # ── 1. 当前状态 ──
    print("\n[1/3] 当前数据库状态:")
    for t in ALL_TABLES:
        try:
            cursor.execute(f"SELECT COUNT(*) AS cnt FROM `{t}`")
            r = cursor.fetchone()
            print(f"  {t:30s} {r['cnt']:>6} 行")
        except Exception:
            print(f"  {t:30s} (不存在)")

    # ── 2. 现有事件（V2 中文列名）──
    print("\n[2/3] 现有爆破事件:")
    try:
        cursor.execute("SELECT event_id, `名称`, `状态` FROM blasting_events")
        events = cursor.fetchall()
        for e in events:
            print(f"  {e['event_id']} | {(e['状态'] or ''):10s} | {e['名称']}")
        if not events:
            print("  (无事件)")
    except Exception as e:
        print(f"  (查询失败: {e})")

    # ── 3. 清理爆破子表孤儿（V2 无子表，跳过）──
    print("\n[3/3] 清理爆破子表孤儿数据:")
    if not BLASTING_CHILD_TABLES:
        print("  V2 宽表设计无子表，无需清理孤儿数据")
    else:
        total_deleted = 0
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

    cursor.close()
    conn.close()
    print("\n[DONE]")


if __name__ == "__main__":
    main()
