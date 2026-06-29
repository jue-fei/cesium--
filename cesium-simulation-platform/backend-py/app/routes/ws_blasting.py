"""
爆破模拟实时数据推送 WebSocket 端点

协议：
  客户端连接后发送订阅消息：{"action": "subscribe", "event_id": "BLAST-2026-001"}
  服务端按帧推送：
    {
      "type": "blasting_frame",
      "timestamp": 1234567890,
      "frameIndex": 0,
      "frame": { ...帧数据... }
    }
  控制消息：
    {"action": "play"} / {"action": "pause"} / {"action": "seek", "frameIndex": 10}

数据源优先级：
  1. 数据库 blasting_frames 表（若存在且有数据）
  2. 内置模拟数据生成器（基于物理模型的振动波传播）
"""
import asyncio
import json
import math
import time
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

FRAME_INTERVAL_MS = 50  # 20 FPS
TOTAL_FRAMES = 200  # 默认总帧数（10 秒模拟）


def _generate_simulated_frame(frame_index: int, total_frames: int) -> dict:
    """生成基于物理模型的模拟爆破帧数据

    模拟内容：
    - 振动波传播（径向扩散，随距离衰减）
    - 岩体位移（粒子飞溅轨迹）
    - 能量释放曲线（指数衰减）
    """
    t = frame_index * (FRAME_INTERVAL_MS / 1000.0)  # 当前时间（秒）
    progress = frame_index / max(1, total_frames - 1)

    # 振动波半径（m/s 传播，假设介质波速 800 m/s）
    wave_speed = 800.0
    wave_radius = wave_speed * t

    # 能量衰减（指数衰减）
    initial_energy = 1.0e8  # 100 MJ
    decay_rate = 0.15
    total_energy = initial_energy * math.exp(-decay_rate * t)

    # 粒子统计（基于物理模型）
    max_alive = 5000
    alive_count = int(max_alive * (1 - progress) * (1 + 0.3 * math.sin(t * 5)))
    landed_count = int(max_alive * progress * 0.9)

    # 最大位移和速度
    max_distance = 80.0 * (1 - math.exp(-t * 0.5))  # 渐近线
    max_speed = 45.0 * math.exp(-t * 0.3)  # 初期高速，逐渐衰减

    return {
        "t": t,
        "waveRadius": wave_radius,
        "stats": {
            "aliveCount": alive_count,
            "landedCount": landed_count,
            "maxDistance": max_distance,
            "maxSpeed": max_speed,
            "totalEnergy": total_energy
        }
    }


@router.websocket("/ws/blasting")
async def blasting_ws(websocket: WebSocket):
    """爆破模拟实时数据推送 WebSocket"""
    await websocket.accept()
    print("[WS] 客户端已连接")

    state = {
        "event_id": None,
        "playing": False,
        "frame_index": 0,
        "total_frames": TOTAL_FRAMES,
        "frame_interval": FRAME_INTERVAL_MS,
        "use_db": False,
    }
    frames_cache = []
    db_conn = None

    async def handle_message(data: dict):
        nonlocal db_conn
        action = data.get("action")

        if action == "subscribe":
            event_id = data.get("event_id")
            state["event_id"] = event_id

            # 尝试从数据库加载帧数据
            try:
                from app.database import get_db
                db_conn = next(get_db())
                with db_conn.cursor() as cursor:
                    cursor.execute(
                        "SELECT * FROM blasting_frames WHERE event_id = %s ORDER BY frame_index",
                        (event_id,)
                    )
                    frames_cache = cursor.fetchall()
                if frames_cache:
                    state["use_db"] = True
                    state["total_frames"] = len(frames_cache)
                    print(f"[WS] 从数据库加载 {len(frames_cache)} 帧（事件 {event_id}）")
                else:
                    state["use_db"] = False
                    state["total_frames"] = TOTAL_FRAMES
                    print(f"[WS] 数据库无帧数据，使用模拟数据（事件 {event_id}）")
            except Exception as e:
                state["use_db"] = False
                state["total_frames"] = TOTAL_FRAMES
                print(f"[WS] 数据库不可用，使用模拟数据: {e}")
                if db_conn:
                    try:
                        db_conn.close()
                    except Exception:
                        pass
                    db_conn = None

            state["frame_index"] = 0
            state["playing"] = True

            await websocket.send_json({
                "type": "status",
                "status": "streaming",
                "eventId": event_id,
                "totalFrames": state["total_frames"],
                "frameInterval": state["frame_interval"],
                "dataSource": "database" if state["use_db"] else "simulation"
            })

        elif action == "play":
            state["playing"] = True
            await websocket.send_json({"type": "status", "status": "streaming"})

        elif action == "pause":
            state["playing"] = False
            await websocket.send_json({"type": "status", "status": "paused"})

        elif action == "seek":
            idx = int(data.get("frameIndex", 0))
            state["frame_index"] = max(0, min(idx, state["total_frames"] - 1))

    try:
        while True:
            # 等待消息或帧间隔（取较短者）
            try:
                msg = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=state["frame_interval"] / 1000.0
                )
                try:
                    data = json.loads(msg)
                    await handle_message(data)
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                pass  # 超时无消息，继续推送帧

            # 推送帧
            if state["playing"] and state["frame_index"] < state["total_frames"]:
                if state["use_db"] and frames_cache:
                    db_frame = frames_cache[state["frame_index"]]
                    frame = {
                        "t": db_frame.get("time_sec", state["frame_index"] * 0.05),
                        "waveRadius": db_frame.get("wave_radius", 0),
                        "stats": {
                            "aliveCount": db_frame.get("alive_count", 0),
                            "landedCount": db_frame.get("landed_count", 0),
                            "maxDistance": db_frame.get("max_distance", 0),
                            "maxSpeed": db_frame.get("max_speed", 0),
                            "totalEnergy": db_frame.get("total_energy", 0)
                        }
                    }
                else:
                    frame = _generate_simulated_frame(
                        state["frame_index"], state["total_frames"]
                    )

                await websocket.send_json({
                    "type": "blasting_frame",
                    "timestamp": int(time.time() * 1000),
                    "frameIndex": state["frame_index"],
                    "frame": frame
                })
                state["frame_index"] += 1

                if state["frame_index"] >= state["total_frames"]:
                    state["playing"] = False
                    await websocket.send_json({"type": "complete", "status": "complete"})

    except WebSocketDisconnect:
        print("[WS] 客户端断开连接")
    except Exception as e:
        print(f"[WS] 错误: {e}")
    finally:
        if db_conn:
            try:
                db_conn.close()
            except Exception:
                pass
