from fastapi import APIRouter, Depends, HTTPException
from pymysql import Connection
from app.database import get_db, parse_json_field, build_insert_sql, build_update_sql
from app.schemas import OrebodyCreate, OrebodyUpdate

router = APIRouter(prefix="/api/orebodies", redirect_slashes=False, tags=["矿体信息"])

OREBODY_FIELDS = [
    "orebody_id", "name", "ore_type", "grade", "reserves", "thickness",
    "density", "volume", "metal_content", "mining_method",
    "depth_top", "depth_bottom", "dip_angle", "strike",
    "status", "geological_zone", "confidence_level",
    "bounding_box", "description"
]
OREBODY_UPDATE_FIELDS = [f for f in OREBODY_FIELDS if f != "orebody_id"]


@router.get("")
@router.get("/")
def list_orebodies(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM orebodies ORDER BY id")
        rows = cursor.fetchall()
    for r in rows:
        r["bounding_box"] = parse_json_field(r, "bounding_box")
    return {"code": 0, "data": rows}


@router.get("/{orebody_id}")
def get_orebody(orebody_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM orebodies WHERE orebody_id = %s", (orebody_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="矿体未找到")
    row["bounding_box"] = parse_json_field(row, "bounding_box")
    return {"code": 0, "data": row}


@router.post("/")
def create_orebody(body: OrebodyCreate, db: Connection = Depends(get_db)):
    sql, safe_fields = build_insert_sql("orebodies", OREBODY_FIELDS, OREBODY_FIELDS)
    values = [getattr(body, f) for f in safe_fields]

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "矿体创建成功"}


@router.put("/{orebody_id}")
def update_orebody(orebody_id: str, body: OrebodyUpdate, db: Connection = Depends(get_db)):
    sql, values = build_update_sql("orebodies", body.model_dump(exclude_none=True), OREBODY_UPDATE_FIELDS, "orebody_id")
    if sql is None:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    values.append(orebody_id)

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "矿体更新成功"}


@router.delete("/{orebody_id}")
def delete_orebody(orebody_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM orebodies WHERE orebody_id = %s", (orebody_id,))
        db.commit()
    return {"code": 0, "message": "矿体删除成功"}