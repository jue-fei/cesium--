"""
将 /3d 文件夹中的配置数据迁移到 MySQL
- models.json → model_config 路径
- feature.json/features.json → model_config.features + global_properties
- scenetree.json → model_config.scenetree
- tileset.json 和 .glb 文件保留在原位（Cesium 静态加载需要）
运行: python migrate_3d.py
"""
import os, sys, json, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

BASE_3D = os.path.abspath(os.path.join(os.path.dirname(__file__), r"..\cesium1\public\3d"))

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

# 1. 添加 scenetree 列
try:
    cursor.execute("ALTER TABLE model_config ADD COLUMN scenetree JSON DEFAULT NULL COMMENT '场景树结构'")
    print("[OK] 添加 scenetree 列")
except Exception:
    print("[OK] scenetree 列已存在")

# 2. 读取 models.json
models_path = os.path.join(BASE_3D, "models.json")
if os.path.exists(models_path):
    with open(models_path, "r", encoding="utf-8") as f:
        models_list = json.load(f)
    print(f"\n[OK] 读取 models.json: {len(models_list)} 个模型")
else:
    print("\n[WARN] models.json 不存在")

# 3. 读取每个模型目录的配置并写入数据库
model_dirs = sorted(glob.glob(os.path.join(BASE_3D, "demo*")))
print(f"发现 {len(model_dirs)} 个模型目录\n")

for i, dir_path in enumerate(model_dirs):
    dir_name = os.path.basename(dir_path)
    model_id = f"MD00{i+1}"

    # 读取 feature.json 或 features.json
    feature_data = None
    for fname in ["feature.json", "features.json"]:
        fp = os.path.join(dir_path, fname)
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8") as f:
                feature_data = json.load(f)
            break

    # 读取 scenetree.json
    scenetree_data = None
    st_path = os.path.join(dir_path, "scenetree.json")
    if os.path.exists(st_path):
        with open(st_path, "r", encoding="utf-8") as f:
            scenetree_data = json.load(f)

    model_mappings = feature_data.get("modelMappings", []) if feature_data else []
    global_props = feature_data.get("globalProperties", {}) if feature_data else {}

    # 确保 feature_id 字段
    for m in model_mappings:
        if "feature_id" not in m and "id" in m:
            m["feature_id"] = m["id"]

    # 路径映射：旧路径 → 新 tileset.json 路径（Cesium 加载用）
    tileset_path = f"/3d/{dir_name}/tileset.json"

    # 找到 models.json 中对应的名称
    model_name = f"{dir_name} 配置"
    for m in models_list:
        if dir_name in m["path"]:
            model_name = m["name"]
            break

    cursor.execute("""
        UPDATE model_config
        SET name = %s, path = %s, features = %s, global_properties = %s, scenetree = %s
        WHERE model_id = %s
    """, (
        model_name,
        tileset_path,
        json.dumps(model_mappings, ensure_ascii=False),
        json.dumps(global_props, ensure_ascii=False),
        json.dumps(scenetree_data, ensure_ascii=False) if scenetree_data else None,
        model_id
    ))

    sc = len(scenetree_data.get("scenes", [])) if scenetree_data and "scenes" in scenetree_data else 0
    print(f"  {model_id} | {model_name:12s} | path={tileset_path:30s} | features={len(model_mappings)} | scenetree={sc} scenes | global={len(global_props)} keys")

conn.commit()
cursor.close()
conn.close()

print("\n[DONE] /3d 配置数据已全部导入 MySQL")
print("  - 模型路径已更新为 /3d/demoX/tileset.json")
print("  - features + global_properties + scenetree 已入库")
print("  - tileset.json 和 .glb 文件保留在 /3d/ 中供 Cesium 加载")
