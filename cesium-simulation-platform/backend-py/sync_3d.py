"""
从 /3d 文件夹完全同步模型数据到 MySQL，确保数据库与文件内容一致
运行: python sync_3d.py
"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), r"..\cesium1\public\3d"))
MODELS = [
    ("MD001", "demo1", "demo1 配置", ["feature.json"]),
    ("MD002", "demo2", "demo2 配置", ["features.json"]),
    ("MD003", "demo3", "demo3 配置", ["feature.json"]),
    ("MD004", "demo4", "demo4 配置", ["feature.json"]),
]

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

for model_id, dir_name, model_name, feature_fnames in MODELS:
    d = os.path.join(BASE, dir_name)
    print(f"\n{'='*60}")
    print(f"{model_id} ({dir_name})")
    print(f"{'='*60}")

    # 读取 feature.json / features.json
    features = []
    global_props = {}
    for fname in feature_fnames:
        fp = os.path.join(d, fname)
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
            features = data.get("modelMappings", [])
            global_props = data.get("globalProperties", {})
            # 确保 feature_id
            for m in features:
                if "feature_id" not in m and "id" in m:
                    m["feature_id"] = m["id"]
                if "feature_id" not in m and "featureId" in m:
                    m["feature_id"] = m["featureId"]
            print(f"  feature.json: {len(features)} features, {len(global_props)} global keys")
            break

    # 读取 scenetree.json
    scenetree = None
    sp = os.path.join(d, "scenetree.json")
    if os.path.exists(sp):
        with open(sp, "r", encoding="utf-8") as f:
            scenetree = json.load(f)
        scenes = len(scenetree.get("scenes", [])) if isinstance(scenetree, dict) else 0
        print(f"  scenetree.json: {len(json.dumps(scenetree))} bytes, {scenes} scenes")

    # 读取 tileset.json
    tileset = None
    tp = os.path.join(d, "tileset.json")
    if os.path.exists(tp):
        with open(tp, "r", encoding="utf-8") as f:
            tileset = json.load(f)
        n_children = len(tileset.get("root", {}).get("children", []))
        print(f"  tileset.json: {len(json.dumps(tileset))} bytes, {n_children} root children")

    # 更新数据库
    tileset_path = f"/3d/{dir_name}/tileset.json"
    cursor.execute("""
        UPDATE model_config
        SET name=%s, path=%s, features=%s, global_properties=%s, scenetree=%s, tileset=%s
        WHERE model_id=%s
    """, (
        model_name, tileset_path,
        json.dumps(features, ensure_ascii=False),
        json.dumps(global_props, ensure_ascii=False),
        json.dumps(scenetree, ensure_ascii=False) if scenetree else None,
        json.dumps(tileset, ensure_ascii=False) if tileset else None,
        model_id
    ))
    print(f"  [OK] 数据库已更新")

conn.commit()

# 验证
print(f"\n{'='*60}")
print("验证数据库内容")
print(f"{'='*60}")
cursor.execute("SELECT model_id, name, path, JSON_LENGTH(features) as fc, JSON_LENGTH(global_properties) as gc, LENGTH(scenetree) as sl, LENGTH(tileset) as tl FROM model_config ORDER BY sort_order")
for r in cursor.fetchall():
    print(f"  {r['model_id']} | {r['name']:12s} | path={r['path']:30s} | features={r['fc']} | global={r['gc']} | scenetree={r['sl']}B | tileset={r['tl']}B")

cursor.close()
conn.close()
print(f"\n[DONE] 数据库已与 /3d 文件夹完全同步")
