from fastapi import APIRouter, Depends
from pymysql import Connection
from app.database import get_db
import json

router = APIRouter(prefix="/api/monitoring", redirect_slashes=False, tags=["矿卡辅助"])


@router.get("/minerals")
def list_mineral_types(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM mineral_types ORDER BY sort_order")
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}


@router.get("/mining-pits")
def list_mining_pits(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM mining_pit_specs")
        rows = cursor.fetchall()
    for r in rows:
        for field in ["cartesian", "lon_lat"]:
            if r.get(field) and isinstance(r[field], str):
                try:
                    r[field] = json.loads(r[field])
                except json.JSONDecodeError:
                    pass
    return {"code": 0, "data": rows}
