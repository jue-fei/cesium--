"""
矿卡路线表迁移脚本 — 仅创建 truck_routes 表，不影响其他表
运行: python migrate_truck_routes.py
"""
import os, sys, json
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

# 检查表是否已存在
cursor.execute("SHOW TABLES LIKE 'truck_routes'")
if cursor.fetchone():
    print("[SKIP] truck_routes 表已存在，跳过建表")
else:
    cursor.execute("""
    CREATE TABLE truck_routes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      points JSON NOT NULL,
      is_default TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB COMMENT='矿卡路线'
    """)
    conn.commit()
    print("[OK] truck_routes 表创建完成")

# 导入默认路线
cursor.execute("SELECT COUNT(*) AS cnt FROM truck_routes WHERE is_default = 1")
row = cursor.fetchone()
if row["cnt"] > 0:
    print("[SKIP] 默认路线已存在，跳过导入")
else:
    route_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cesium1", "public", "default-route.json")
    try:
        with open(route_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        points = data.get("points", [])
        name = data.get("name", "默认矿卡路线")
        cursor.execute(
            "INSERT INTO truck_routes (name, points, is_default) VALUES (%s, %s, 1)",
            (name, json.dumps(points, ensure_ascii=False))
        )
        conn.commit()
        print(f"[OK] 默认路线已导入：{name}（{len(points)} 个点）")
    except FileNotFoundError:
        print(f"[WARN] 未找到 default-route.json，跳过导入")
    except Exception as e:
        print(f"[WARN] 默认路线导入失败: {e}")

cursor.close()
conn.close()
print("[OK] truck_routes 迁移完成")
