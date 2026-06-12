import json
from fastapi import APIRouter, Depends, HTTPException
from pymysql import Connection
from app.database import get_db
from app.schemas import TruckRouteCreate, TruckRouteUpdate

router = APIRouter(prefix="/api/truck-routes", redirect_slashes=False, tags=["矿卡路线"])


def _parse_route(row):
    if row.get("points") and isinstance(row["points"], str):
        try:
            row["points"] = json.loads(row["points"])
        except json.JSONDecodeError:
            row["points"] = []
    return row


@router.get("")
@router.get("/")
def list_routes(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM truck_routes ORDER BY is_default DESC, updated_at DESC")
        rows = cursor.fetchall()
    return {"code": 0, "data": [_parse_route(r) for r in rows]}


@router.get("/default")
def get_default_route(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM truck_routes WHERE is_default = 1 LIMIT 1")
        row = cursor.fetchone()
    if not row:
        return {"code": 0, "data": None}
    return {"code": 0, "data": _parse_route(row)}


@router.get("/{route_id}")
def get_route(route_id: int, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM truck_routes WHERE id = %s", (route_id,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="路线未找到")
    return {"code": 0, "data": _parse_route(row)}


@router.post("")
@router.post("/")
def create_route(body: TruckRouteCreate, db: Connection = Depends(get_db)):
    name = body.name.strip()
    points = body.points
    if not name or not points or not isinstance(points, list):
        raise HTTPException(status_code=400, detail="name 和 points 为必填项（points 为数组）")

    is_default = int(body.is_default or 0)
    points_json = json.dumps(points, ensure_ascii=False)

    if is_default:
        with db.cursor() as cursor:
            cursor.execute("UPDATE truck_routes SET is_default = 0 WHERE is_default = 1")

    with db.cursor() as cursor:
        cursor.execute(
            "INSERT INTO truck_routes (name, points, is_default) VALUES (%s, %s, %s)",
            (name, points_json, is_default)
        )
        db.commit()
        route_id = cursor.lastrowid

    return {"code": 0, "message": "路线创建成功", "data": {"id": route_id}}


@router.put("/{route_id}")
def update_route(route_id: int, body: TruckRouteUpdate, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT id FROM truck_routes WHERE id = %s", (route_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="路线未找到")

    updates = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    if body.points is not None:
        updates["points"] = json.dumps(body.points, ensure_ascii=False)
    if body.is_default is not None:
        updates["is_default"] = int(body.is_default)

    if not updates:
        raise HTTPException(status_code=400, detail="无有效更新字段")

    if updates.get("is_default"):
        with db.cursor() as cursor:
            cursor.execute("UPDATE truck_routes SET is_default = 0 WHERE is_default = 1")

    set_clause = ",".join([f"{k}=%s" for k in updates.keys()])
    values = list(updates.values()) + [route_id]

    with db.cursor() as cursor:
        cursor.execute(f"UPDATE truck_routes SET {set_clause} WHERE id=%s", values)
        db.commit()

    return {"code": 0, "message": "路线更新成功"}


@router.put("/{route_id}/set-default")
def set_default_route(route_id: int, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT id FROM truck_routes WHERE id = %s", (route_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="路线未找到")
        cursor.execute("UPDATE truck_routes SET is_default = 0")
        cursor.execute("UPDATE truck_routes SET is_default = 1 WHERE id = %s", (route_id,))
        db.commit()
    return {"code": 0, "message": "已设为默认路线"}


@router.delete("/{route_id}")
def delete_route(route_id: int, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT id, is_default FROM truck_routes WHERE id = %s", (route_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="路线未找到")
        if row["is_default"]:
            raise HTTPException(status_code=400, detail="默认路线不可删除，请先设置其他路线为默认")
        cursor.execute("DELETE FROM truck_routes WHERE id = %s", (route_id,))
        db.commit()
    return {"code": 0, "message": "路线删除成功"}
