"""爆破模拟路由 — 从 MySQL 提供完整爆破数据集"""
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from pymysql import Connection
from app.database import get_db, parse_json_field
from app.schemas import BlastingEventCreate, BlastingEventUpdate, BlastingHoleCreate

router = APIRouter(prefix="/api/blasting", redirect_slashes=False, tags=["爆破模拟"])

EVENT_FIELDS = [
    "event_id", "name", "center_lon", "center_lat", "center_height", "charge_kg",
    "explosive_type", "detonation_method", "blast_time", "rock_type",
    "weather", "temperature", "wind_speed", "wind_direction", "status", "description"
]

HOLE_FIELDS = [
    "event_id", "hole_id", "row", "column", "collar_lon", "collar_lat", "collar_height",
    "toe_lon", "toe_lat", "toe_height", "diameter", "depth", "charge_kg", "delay_ms",
    "hole_type", "burden", "spacing", "subdrill", "stemming"
]


# ─── 爆破事件 ──────────────────────────────────────────

@router.get("/events")
@router.get("/events/")
def list_events(status: str = None, db: Connection = Depends(get_db)):
    """列出所有爆破事件"""
    with db.cursor() as cursor:
        sql = "SELECT * FROM blasting_events"
        params = []
        if status:
            sql += " WHERE status = %s"
            params.append(status)
        sql += " ORDER BY blast_time DESC"
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}


@router.get("/events/{event_id}")
def get_event(event_id: str, db: Connection = Depends(get_db)):
    """获取单个事件详情（含炮孔）"""
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM blasting_events WHERE event_id = %s", (event_id,))
        event = cursor.fetchone()
        if not event:
            raise HTTPException(status_code=404, detail="爆破事件未找到")

        cursor.execute("SELECT * FROM blasting_holes WHERE event_id = %s ORDER BY row, `column`", (event_id,))
        holes = cursor.fetchall()

    event["holes"] = holes
    return {"code": 0, "data": event}


@router.post("/events/")
def create_event(body: BlastingEventCreate, db: Connection = Depends(get_db)):
    cols = ", ".join(EVENT_FIELDS)
    placeholders = ", ".join(["%s"] * len(EVENT_FIELDS))
    values = [getattr(body, f) for f in EVENT_FIELDS]
    with db.cursor() as cursor:
        cursor.execute(f"INSERT INTO blasting_events ({cols}) VALUES ({placeholders})", values)
        db.commit()
    return {"code": 0, "message": "爆破事件创建成功"}


@router.put("/events/{event_id}")
def update_event(event_id: str, body: BlastingEventUpdate, db: Connection = Depends(get_db)):
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="无有效更新字段")
    safe = {k: v for k, v in updates.items() if k in EVENT_FIELDS}
    set_clause = ", ".join([f"{k}=%s" for k in safe.keys()])
    values = list(safe.values()) + [event_id]
    with db.cursor() as cursor:
        cursor.execute(f"UPDATE blasting_events SET {set_clause} WHERE event_id=%s", values)
        db.commit()
    return {"code": 0, "message": "爆破事件更新成功"}


@router.delete("/events/{event_id}")
def delete_event(event_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM blasting_events WHERE event_id = %s", (event_id,))
        db.commit()
    return {"code": 0, "message": "爆破事件删除成功"}


# ─── 完整数据集（前端可视化用） ────────────────────────

@router.get("/events/{event_id}/dataset")
def get_event_dataset(
    event_id: str,
    frame_start: int = Query(0, ge=0),
    frame_end: int = Query(None, ge=0),
    db: Connection = Depends(get_db)
):
    """获取完整爆破模拟数据集（事件+炮孔+帧+粒子+振动+应力）"""
    with db.cursor() as cursor:
        # 事件
        cursor.execute("SELECT * FROM blasting_events WHERE event_id = %s", (event_id,))
        event = cursor.fetchone()
        if not event:
            raise HTTPException(status_code=404, detail="爆破事件未找到")

        # 炮孔
        cursor.execute("SELECT * FROM blasting_holes WHERE event_id = %s ORDER BY row, `column`", (event_id,))
        holes = cursor.fetchall()

        # 帧范围
        cursor.execute("SELECT MAX(frame_index) FROM blasting_frames WHERE event_id = %s", (event_id,))
        max_frame_row = cursor.fetchone()
        max_frame = max_frame_row.get("MAX(frame_index)", 0) or 0
        end = frame_end if frame_end is not None else max_frame

        # 帧统计
        cursor.execute(
            "SELECT * FROM blasting_frames WHERE event_id = %s AND frame_index >= %s AND frame_index <= %s ORDER BY frame_index",
            (event_id, frame_start, end)
        )
        frames = cursor.fetchall()

        # 粒子数据
        cursor.execute(
            "SELECT * FROM blasting_particles WHERE event_id = %s AND frame_index >= %s AND frame_index <= %s ORDER BY frame_index, particle_type",
            (event_id, frame_start, end)
        )
        particles = cursor.fetchall()

        # 振动场
        cursor.execute(
            "SELECT * FROM blasting_vibration WHERE event_id = %s AND frame_index >= %s AND frame_index <= %s ORDER BY frame_index",
            (event_id, frame_start, end)
        )
        vibration_rows = cursor.fetchall()

        # 监测点
        cursor.execute("SELECT * FROM blasting_monitor_points WHERE event_id = %s", (event_id,))
        monitor_points = cursor.fetchall()

        # 应力数据
        cursor.execute(
            "SELECT * FROM blasting_stress WHERE event_id = %s AND frame_index >= %s AND frame_index <= %s ORDER BY frame_index, point_id",
            (event_id, frame_start, end)
        )
        stress_rows = cursor.fetchall()

    # 组装数据集
    # 按帧分组粒子
    frame_map = {}
    for f in frames:
        fi = f["frame_index"]
        frame_map[fi] = {
            "t": f["time_sec"],
            "waveRadius": f["wave_radius"],
            "fragments": [],
            "stats": {
                "aliveCount": f["alive_count"],
                "landedCount": f["landed_count"],
                "maxDistance": f["max_distance"],
                "maxSpeed": f["max_speed"],
                "totalEnergy": f["total_energy"]
            },
            "vibrationField": None,
            "stresses": []
        }

    # 填充粒子
    for p in particles:
        fi = p["frame_index"]
        if fi not in frame_map:
            continue
        frame_map[fi]["fragments"].append({
            "id": p["particle_id"],
            "type": p["particle_type"],
            "size": p["size"],
            "position": {"lon": event["center_lon"] + p["pos_x"] / 111320, "lat": event["center_lat"] + p["pos_y"] / 110540, "height": max(0, event["center_height"] + p["pos_z"])},
            "velocity": {"vx": p["vel_x"], "vy": p["vel_y"], "vz": p["vel_z"]},
            "speed": p["speed"],
            "landed": bool(p["landed"]),
            "age": p["age"]
        })

    # 填充振动场
    for v in vibration_rows:
        fi = v["frame_index"]
        if fi not in frame_map:
            continue
        field_data = parse_json_field(v, "field_data")
        frame_map[fi]["vibrationField"] = {
            "resolution": v["grid_resolution"],
            "data": field_data,
            "maxIntensity": v["max_intensity"],
            "time": v["frame_index"] * 0.05
        }

    # 填充应力
    for s in stress_rows:
        fi = s["frame_index"]
        if fi not in frame_map:
            continue
        point = next((mp for mp in monitor_points if mp["point_id"] == s["point_id"]), None)
        frame_map[fi]["stresses"].append({
            "pointId": s["point_id"],
            "pointLabel": point["label"] if point else s["point_id"],
            "zoneType": point["zone_type"] if point else "",
            "time": s["time_sec"],
            "intensity": s["intensity"],
            "vibrationVelocity": s["vibration_velocity"],
            "sigma1": s["sigma1"],
            "sigma2": s["sigma2"],
            "sigma3": s["sigma3"],
            "mises": s["mises"],
            "safetyFactor": s["safety_factor"],
            "safetyLevel": s["safety_level"],
            "maxTensile": s["max_tensile"]
        })

    # 组装最终数据集
    dataset = {
        "meta": {
            "coordinateSystem": "WGS84",
            "timeUnit": "s",
            "lengthUnit": "m",
            "source": "mysql"
        },
        "event": {
            "id": event["event_id"],
            "name": event["name"],
            "center": {
                "lon": event["center_lon"],
                "lat": event["center_lat"],
                "height": event["center_height"]
            },
            "chargeKg": event["charge_kg"],
            "explosiveType": event["explosive_type"],
            "rockType": event["rock_type"],
            "blastTime": event["blast_time"].isoformat() if event["blast_time"] else None
        },
        "design": {
            "holes": [{
                "id": h["hole_id"],
                "row": h["row"],
                "column": h["column"],
                "collar": {"lon": h["collar_lon"], "lat": h["collar_lat"], "height": h["collar_height"]},
                "toe": {"lon": h["toe_lon"], "lat": h["toe_lat"], "height": h["toe_height"]},
                "diameter": h["diameter"],
                "depth": h["depth"],
                "chargeKg": h["charge_kg"],
                "delayMs": h["delay_ms"],
                "holeType": h["hole_type"],
                "burden": h["burden"],
                "spacing": h["spacing"]
            } for h in holes],
            "rockBlocks": []
        },
        "monitorPoints": [{
            "id": mp["point_id"],
            "label": mp["label"],
            "zoneType": mp["zone_type"],
            "x": mp["pos_x"],
            "y": mp["pos_y"],
            "z": mp["pos_z"]
        } for mp in monitor_points],
        "frames": [frame_map[k] for k in sorted(frame_map.keys())],
        "summary": {
            "frameCount": len(frame_map),
            "fragmentCount": len(set(p["particle_id"] for p in particles)),
            "durationSec": frames[-1]["time_sec"] if frames else 0,
            "maxWaveRadius": max((f["wave_radius"] for f in frames), default=0),
            "holeCount": len(holes),
            "particleCount": max((f["alive_count"] for f in frames), default=0),
            "peakVibration": max((f["vibration_max"] for f in frames), default=0),
            "peakStress": max((f["stress_max"] for f in frames), default=0),
            "minSafetyFactor": min((f["min_safety_factor"] for f in frames), default=99)
        }
    }

    return {"code": 0, "data": dataset}


# ─── 岩体参数库 ────────────────────────────────────────

@router.get("/rock-params")
@router.get("/rock-params/")
def list_rock_params(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM blasting_rock_params ORDER BY rock_type")
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}


@router.get("/rock-params/{rock_type}")
def get_rock_params(rock_type: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM blasting_rock_params WHERE rock_type = %s", (rock_type,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="岩体参数未找到")
    return {"code": 0, "data": row}


# ─── 渲染配置 ──────────────────────────────────────────

@router.get("/render-configs")
@router.get("/render-configs/")
def list_render_configs(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM blasting_render_config ORDER BY config_name")
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}


@router.get("/render-configs/{config_name}")
def get_render_config(config_name: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT * FROM blasting_render_config WHERE config_name = %s", (config_name,))
        row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="渲染配置未找到")
    return {"code": 0, "data": row}


# ─── 炮孔管理 ──────────────────────────────────────────

@router.post("/holes/")
def create_hole(body: BlastingHoleCreate, db: Connection = Depends(get_db)):
    cols = ", ".join(HOLE_FIELDS)
    placeholders = ", ".join(["%s"] * len(HOLE_FIELDS))
    values = [getattr(body, f) for f in HOLE_FIELDS]
    with db.cursor() as cursor:
        cursor.execute(f"INSERT INTO blasting_holes ({cols}) VALUES ({placeholders})", values)
        db.commit()
    return {"code": 0, "message": "炮孔创建成功"}


@router.delete("/holes/{event_id}/{hole_id}")
def delete_hole(event_id: str, hole_id: str, db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM blasting_holes WHERE event_id = %s AND hole_id = %s", (event_id, hole_id))
        db.commit()
    return {"code": 0, "message": "炮孔删除成功"}


# ─── 帧数据查询 ────────────────────────────────────────

@router.get("/events/{event_id}/frames")
def get_frames(event_id: str, db: Connection = Depends(get_db)):
    """获取帧统计列表"""
    with db.cursor() as cursor:
        cursor.execute(
            "SELECT * FROM blasting_frames WHERE event_id = %s ORDER BY frame_index",
            (event_id,)
        )
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}


@router.get("/events/{event_id}/particles")
def get_particles(
    event_id: str,
    frame_index: int = Query(0, ge=0),
    particle_type: str = None,
    db: Connection = Depends(get_db)
):
    """获取指定帧的粒子数据"""
    with db.cursor() as cursor:
        sql = "SELECT * FROM blasting_particles WHERE event_id = %s AND frame_index = %s"
        params = [event_id, frame_index]
        if particle_type:
            sql += " AND particle_type = %s"
            params.append(particle_type)
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}


@router.get("/events/{event_id}/stress")
def get_stress(
    event_id: str,
    point_id: str = None,
    db: Connection = Depends(get_db)
):
    """获取应力时程数据"""
    with db.cursor() as cursor:
        sql = "SELECT * FROM blasting_stress WHERE event_id = %s"
        params = [event_id]
        if point_id:
            sql += " AND point_id = %s"
            params.append(point_id)
        sql += " ORDER BY frame_index, point_id"
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    return {"code": 0, "data": rows}
