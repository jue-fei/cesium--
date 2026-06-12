from fastapi import APIRouter, Depends
from pymysql import Connection
from app.database import get_db

router = APIRouter(prefix="/api/geology", redirect_slashes=False, tags=["地质分析"])


@router.get("/stats")
def get_geology_stats(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT stat_key, stat_value FROM geology_stats")
        rows = cursor.fetchall()
    stats = {}
    for row in rows:
        stats[row["stat_key"]] = row["stat_value"]
    return {"code": 0, "data": stats}



