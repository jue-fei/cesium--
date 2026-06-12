from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pymysql import Connection
from app.database import get_db, build_insert_sql, build_update_sql
from app.schemas import ModelCreate, ModelUpdate, ModelSave
import json

router = APIRouter(prefix="/api/models", redirect_slashes=False, tags=["模型配置"])

MODEL_FIELDS = ["model_id", "name", "path", "sort_order", "features", "description", "global_properties", "scenetree", "tileset"]
MODEL_UPDATE_FIELDS = ["name", "path", "sort_order", "features", "description", "global_properties", "scenetree", "tileset"]
JSON_FIELDS = ["features", "global_properties", "scenetree", "tileset"]
LIST_HIDDEN_FIELDS = ["tileset"]


def _normalize_features_value(value):
    """兼容历史错误数据：features 可能被保存成完整 payload 对象。"""
    if isinstance(value, dict):
        if isinstance(value.get("modelMappings"), list):
            return value["modelMappings"]
        if isinstance(value.get("features"), list):
            return value["features"]
        return []
    return value if isinstance(value, list) else []


def _normalize_config_payload(data):
    payload = data if isinstance(data, dict) else {}
    features = payload.get("modelMappings", data)
    global_properties = payload.get("globalProperties", {})
    scenetree = payload.get("scenetree", {})
    return {
        "features": _normalize_features_value(features),
        "global_properties": global_properties if isinstance(global_properties, dict) else {},
        "scenetree": scenetree if isinstance(scenetree, (dict, list)) else {},
    }


def _parse_json(row, skip_fields=None):
    skip = set(skip_fields or [])
    for field in JSON_FIELDS:
        if field in skip:
            continue
        if row.get(field) and isinstance(row[field], str):
            try:
                row[field] = json.loads(row[field])
            except json.JSONDecodeError:
                row[field] = [] if field == "features" else {}
    row["features"] = _normalize_features_value(row.get("features"))
    return row


def _parse_row_for_list(row):
    """列表接口：跳过 tileset 解析（避免解析数MB的大JSON），仅解析轻量字段"""
    r = _parse_json(row, skip_fields=["tileset"])
    for f in LIST_HIDDEN_FIELDS:
        r.pop(f, None)
    return r


# ===== 列表 / 详情 =====

@router.get("")
@router.get("/")
def list_models(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM model_config ORDER BY sort_order, id")
        rows = cursor.fetchall()
    return {"code": 0, "data": [_parse_row_for_list(r) for r in rows]}


@router.get("/{model_id}")
def get_model(model_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM model_config WHERE model_id = %s", (model_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="模型未找到")
    return {"code": 0, "data": _parse_json(row)}


# ===== CRUD =====

@router.post("/")
def create_model(body: ModelCreate, db: Connection = Depends(get_db)):
    sql, safe_fields = build_insert_sql("model_config", MODEL_FIELDS, MODEL_FIELDS)
    values = []
    for f in safe_fields:
        v = getattr(body, f)
        if f in JSON_FIELDS and v is not None and isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False)
        values.append(v)

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "模型创建成功", "model_id": model_id}


@router.put("/{model_id}")
def update_model(model_id: str, body: ModelUpdate, db: Connection = Depends(get_db)):
    body_dict = body.model_dump(exclude_none=True)
    # JSON 字段序列化
    for k in JSON_FIELDS:
        if k in body_dict and isinstance(body_dict[k], (list, dict)):
            body_dict[k] = json.dumps(body_dict[k], ensure_ascii=False)

    sql, values = build_update_sql("model_config", body_dict, MODEL_UPDATE_FIELDS, "model_id")
    if sql is None:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    values.append(model_id)

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "模型更新成功"}


@router.delete("/{model_id}")
def delete_model(model_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM model_config WHERE model_id = %s", (model_id,))
        db.commit()
    return {"code": 0, "message": "模型删除成功"}


# ===== 特征 / 场景树 / 瓦片集 =====

@router.get("/{model_id}/features")
def get_model_features(model_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT features, global_properties, scenetree FROM model_config WHERE model_id = %s", (model_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="模型未找到")

    data = {}
    for k in ["features", "global_properties", "scenetree"]:
        v = row.get(k)
        if isinstance(v, str):
            try: v = json.loads(v)
            except json.JSONDecodeError: v = [] if k == "features" else {}
        data[k] = v or ([] if k == "features" else {})

    legacy_payload = row.get("features")
    if isinstance(legacy_payload, str):
        try:
            legacy_payload = json.loads(legacy_payload)
        except json.JSONDecodeError:
            legacy_payload = None
    if isinstance(legacy_payload, dict):
        if not data["global_properties"]:
            data["global_properties"] = legacy_payload.get("globalProperties", {}) or {}
        if not data["scenetree"]:
            data["scenetree"] = legacy_payload.get("scenetree", {}) or {}

    data["features"] = _normalize_features_value(data["features"])
    return {"code": 0, "data": {
        "modelMappings": data["features"],
        "globalProperties": data["global_properties"],
        "scenetree": data["scenetree"]
    }}


@router.get("/{model_id}/scenetree")
def get_model_scenetree(model_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT scenetree FROM model_config WHERE model_id = %s", (model_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="模型未找到")
    data = row["scenetree"]
    if isinstance(data, str):
        data = json.loads(data)
    return JSONResponse(content=data or {})


def _rewrite_content_uris(tileset, model_path):
    """将 tileset 中的相对 content.uri 改写为绝对静态文件路径"""
    base_dir = model_path.rsplit("/", 1)[0] if "/" in model_path else "/3d"

    def rewrite_node(node):
        if isinstance(node, dict):
            if "content" in node and isinstance(node["content"], dict) and "uri" in node["content"]:
                uri = node["content"]["uri"]
                if not uri.startswith("/") and not uri.startswith("http"):
                    node["content"]["uri"] = f"{base_dir}/{uri}"
            for val in node.values():
                if isinstance(val, (dict, list)):
                    rewrite_node(val)
        elif isinstance(node, list):
            for item in node:
                rewrite_node(item)

    if "root" in tileset:
        rewrite_node(tileset["root"])
    return tileset


@router.get("/by-path/tileset")
def get_model_tileset_by_path(path: str, db: Connection = Depends(get_db)):
    """通过路径查询 tileset — Cesium 前端加载入口"""
    with db.cursor() as cursor:
        cursor.execute("SELECT tileset, path FROM model_config WHERE path = %s", (path,))
        row = cursor.fetchone()
    if not row or not row["tileset"]:
        raise HTTPException(status_code=404, detail="模型瓦片集未找到")
    data = row["tileset"]
    if isinstance(data, str):
        data = json.loads(data)
    data = _rewrite_content_uris(data, row.get("path", ""))
    return JSONResponse(content=data)


@router.get("/{model_id}/tileset")
def get_model_tileset(model_id: str, db: Connection = Depends(get_db)):
    """Cesium 3D Tiles 加载端点 — 从数据库返回 tileset，content.uri 指向静态文件"""
    with db.cursor() as cursor:
        cursor.execute("SELECT tileset, path FROM model_config WHERE model_id = %s", (model_id,))
        row = cursor.fetchone()
    if not row or not row["tileset"]:
        raise HTTPException(status_code=404, detail="模型瓦片集未找到")
    data = row["tileset"]
    if isinstance(data, str):
        data = json.loads(data)
    data = _rewrite_content_uris(data, row.get("path", ""))
    return JSONResponse(content=data)


# ===== 保存（兼容旧接口，内部走标准 PUT 逻辑） =====

@router.post("/save")
def save_model_config(body: ModelSave, db: Connection = Depends(get_db)):
    config_path = body.path
    data = body.data
    if not config_path:
        raise HTTPException(status_code=400, detail="path 为必填项")

    model_id = body.model_id or ""
    name = body.name or ""
    normalized = _normalize_config_payload(data)

    with db.cursor() as cursor:
        cursor.execute("SELECT id FROM model_config WHERE path = %s", (config_path,))
        existing = cursor.fetchone()
        if existing:
            update_body = {
                "features": json.dumps(normalized["features"], ensure_ascii=False),
                "global_properties": json.dumps(normalized["global_properties"], ensure_ascii=False),
                "scenetree": json.dumps(normalized["scenetree"], ensure_ascii=False),
            }
            sql, values = build_update_sql("model_config", update_body, ["features", "global_properties", "scenetree"], "path")
            if sql:
                values.append(config_path)
                cursor.execute(sql, values)
        else:
            insert_fields = ["model_id", "name", "path", "features", "global_properties", "scenetree"]
            sql, safe_fields = build_insert_sql("model_config", insert_fields, insert_fields)
            insert_values = [
                model_id,
                name,
                config_path,
                json.dumps(normalized["features"], ensure_ascii=False),
                json.dumps(normalized["global_properties"], ensure_ascii=False),
                json.dumps(normalized["scenetree"], ensure_ascii=False),
            ]
            cursor.execute(sql, insert_values)
        db.commit()
    return {"code": 0, "message": "保存成功"}