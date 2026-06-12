from fastapi import APIRouter, Depends, HTTPException
from pymysql import Connection
from app.database import get_db, parse_json_field, build_insert_sql, build_update_sql
from app.schemas import BoreholeCreate, BoreholeUpdate

router = APIRouter(prefix="/api/boreholes", redirect_slashes=False, tags=["钻孔配置"])

BOREHOLE_FIELDS = ["borehole_id", "name", "x", "y", "z", "depth", "stratigraphy", "description"]
BOREHOLE_UPDATE_FIELDS = ["name", "x", "y", "z", "depth", "stratigraphy", "description"]


@router.get("")
@router.get("/")
def list_boreholes(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM borehole_config ORDER BY id")
        rows = cursor.fetchall()
    for r in rows:
        r["stratigraphy"] = parse_json_field(r, "stratigraphy")
    return {"code": 0, "data": rows}


@router.get("/{borehole_id}")
def get_borehole(borehole_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM borehole_config WHERE borehole_id = %s", (borehole_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="钻孔未找到")
    row["stratigraphy"] = parse_json_field(row, "stratigraphy")
    return {"code": 0, "data": row}


@router.post("/")
def create_borehole(body: BoreholeCreate, db: Connection = Depends(get_db)):
    sql, safe_fields = build_insert_sql("borehole_config", BOREHOLE_FIELDS, BOREHOLE_FIELDS)
    values = [getattr(body, f) for f in safe_fields]

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "钻孔创建成功"}


@router.put("/{borehole_id}")
def update_borehole(borehole_id: str, body: BoreholeUpdate, db: Connection = Depends(get_db)):
    sql, values = build_update_sql("borehole_config", body.model_dump(exclude_none=True), BOREHOLE_UPDATE_FIELDS, "borehole_id")
    if sql is None:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    values.append(borehole_id)

    with db.cursor() as cursor:
        cursor.execute(sql, values)
        db.commit()
    return {"code": 0, "message": "钻孔更新成功"}


@router.delete("/{borehole_id}")
def delete_borehole(borehole_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM borehole_config WHERE borehole_id = %s", (borehole_id,))
        db.commit()
    return {"code": 0, "message": "钻孔删除成功"}