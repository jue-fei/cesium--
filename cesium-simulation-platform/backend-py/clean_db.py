"""
数据库清理脚本 — 只保留矿卡信息 + 模型地质信息
运行: python clean_db.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

conn = pymysql.connect(
    host=os.getenv("DB_HOST", "localhost"),
    port=int(os.getenv("DB_PORT", 3306)),
    user=os.getenv("DB_USER", "root"),
    password=os.getenv("DB_PASSWORD", ""),
    database=os.getenv("DB_NAME", "cesium_platform"),
    charset="utf8mb4",
    cursorclass=DictCursor,
)
cursor = conn.cursor()

# 保留的表
KEEP = {
    "truck_info", "transport_units", "mineral_types", "mining_pit_specs",
    "model_config", "orebodies", "borehole_config", "geology_stats",
}

# 获取所有表
cursor.execute("SHOW TABLES")
all_tables = {row[f"Tables_in_{os.getenv('DB_NAME', 'cesium_platform')}"] for row in cursor.fetchall()}

to_drop = all_tables - KEEP

cursor.execute("SET FOREIGN_KEY_CHECKS = 0")

print(f"当前 {len(all_tables)} 张表")
print(f"保留 {len(KEEP)} 张: {', '.join(sorted(KEEP))}")
print(f"删除 {len(to_drop)} 张: {', '.join(sorted(to_drop))}")

for tbl in sorted(to_drop):
    cursor.execute(f"DROP TABLE IF EXISTS `{tbl}`")
    print(f"  DROP {tbl}")

cursor.execute("SET FOREIGN_KEY_CHECKS = 1")

conn.commit()

# 验证
cursor.execute("SHOW TABLES")
remaining = [row[f"Tables_in_{os.getenv('DB_NAME', 'cesium_platform')}"] for row in cursor.fetchall()]
print(f"\n清理完成，剩余 {len(remaining)} 张表: {', '.join(sorted(remaining))}")

cursor.close()
conn.close()
