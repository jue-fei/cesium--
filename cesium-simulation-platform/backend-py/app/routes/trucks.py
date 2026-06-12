from fastapi import APIRouter, Depends, HTTPException
from pymysql import Connection
from app.database import get_db, build_insert_sql, build_update_sql
from app.schemas import TruckCreate, TruckUpdate
import json

router = APIRouter(prefix="/api/trucks", redirect_slashes=False, tags=["矿卡信息"])

TRUCK_FIELDS = ["truck_id", "name", "driver", "driver_info", "vehicle_info", "mineral_type", "phase", "status"]
TRUCK_UPDATE_FIELDS = ["name", "driver", "driver_info", "vehicle_info", "mineral_type", "phase", "status"]
TRUCK_JSON_FIELDS = ["driver_info", "vehicle_info", "mineral_type"]


def _parse_json_fields(row):
    """将 JSON 字符串字段解析为 Python 对象"""
    for key in TRUCK_JSON_FIELDS:
        if row.get(key) and isinstance(row[key], str):
            try:
                row[key] = json.loads(row[key])
            except json.JSONDecodeError:
                row[key] = {}
    return row


@router.get("")
@router.get("/")
def list_trucks(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM truck_info ORDER BY id")
        rows = cursor.fetchall()
    return {"code": 0, "data": [_parse_json_fields(r) for r in rows]}


@router.get("/{truck_id}")
def get_truck(truck_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM truck_info WHERE truck_id = %s", (truck_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="矿卡未找到")
    return {"code": 0, "data": _parse_json_fields(row)}


@router.post("/")
def create_truck(body: TruckCreate, db: Connection = Depends(get_db)):
    sql, safe_fields = build_insert_sql("truck_info", TRUCK_FIELDS, TRUCK_FIELDS)
    values = []
    for f in safe_fields:
        v = getattr(body, f)
        if f in TRUCK_JSON_FIELDS and v is not None:
            v = json.dumps(v) if isinstance(v, dict) else v
        values.append(v)

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "矿卡创建成功"}


@router.put("/{truck_id}")
def update_truck(truck_id: str, body: TruckUpdate, db: Connection = Depends(get_db)):
    body_dict = body.model_dump(exclude_none=True)
    sql, values = build_update_sql("truck_info", body_dict, TRUCK_UPDATE_FIELDS, "truck_id")
    if sql is None:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    # JSON 字段序列化
    for key in TRUCK_JSON_FIELDS:
        if key in body_dict and isinstance(body_dict[key], dict):
            field_idx = [k for k in body_dict.keys() if k in TRUCK_UPDATE_FIELDS].index(key)
            if field_idx < len(values):
                values[field_idx] = json.dumps(body_dict[key])

    values.append(truck_id)

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "矿卡更新成功"}


@router.delete("/{truck_id}")
def delete_truck(truck_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM truck_info WHERE truck_id = %s", (truck_id,))
        db.commit()
    return {"code": 0, "message": "矿卡删除成功"}