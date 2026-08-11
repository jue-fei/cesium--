"""
爆破模拟实时数据推送 WebSocket 端点

提供双向实时通道，支持：
- 多客户端订阅同一爆破事件（监控大屏 + 工程师端同步）
- 服务端推送模拟进度帧（progress）、分段起爆事件（blast_segment）、完成通知（completed）
- 客户端指令：start / stop / ping
- 心跳检测与断线清理

帧协议采用 JSON 文本帧（阶段一数据量小，无需 MessagePack；
阶段二推送 PPV 振动场大数组时再升级为二进制帧）。

理论依据：
- FastAPI WebSocket 官方生产指南
- 帧大小建议 ≤64KB，单帧推送间隔 50ms（3x 播放速率）
"""
import asyncio
import json
import logging
from datetime import datetime
from collections import defaultdict
from typing import Any, Optional

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.blasting.blast_physics import (
    build_ppv_grid, ppv_field_3d, pack_ppv_binary,
    stress_field_from_ppv, damage_zone_classify,
    pack_stress_binary, pack_damage_binary,
    make_fdtd_engine, RockMedium,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class BlastConnectionManager:
    """
    爆破模拟 WebSocket 连接管理器

    - _subs: event_id -> set[WebSocket] 订阅池
    - _streams: event_id -> StreamState 活跃推送任务状态
    - _tasks: event_id -> asyncio.Task 推送协程

    线程模型：单事件单推送任务，多客户端共享同一推送流。
    当首个客户端 start 时创建任务，stop 或全部断开时取消。
    """

    def __init__(self):
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        self._streams: dict[str, "StreamState"] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    async def connect(self, ws: WebSocket, event_id: str) -> None:
        await ws.accept()
        self._subs[event_id].add(ws)
        logger.info("[BlastingWS] client subscribed event=%s, total=%d", event_id, len(self._subs[event_id]))

    def disconnect(self, ws: WebSocket, event_id: str) -> None:
        self._subs[event_id].discard(ws)
        if not self._subs[event_id]:
            self._subs.pop(event_id, None)
            # 无订阅者时停止推送（sync 安排取消，不阻塞 disconnect 调用方）
            self.stop_stream(event_id)
        logger.info("[BlastingWS] client unsubscribed event=%s", event_id)

    async def broadcast(self, event_id: str, message: dict[str, Any]) -> None:
        """向指定事件的所有订阅者广播 JSON 帧，自动清理失效连接"""
        subs = self._subs.get(event_id)
        if not subs:
            return
        text = json.dumps(message, ensure_ascii=False)
        dead: list[WebSocket] = []
        for ws in list(subs):
            try:
                await ws.send_text(text)
            except Exception:  # 连接已关闭或异常
                dead.append(ws)
        for ws in dead:
            subs.discard(ws)
        # 新增：广播后若订阅池变空，pop 并停止推送任务，避免空集累积与空转
        if not subs:
            self._subs.pop(event_id, None)
            self.stop_stream(event_id)

    async def broadcast_bytes(self, event_id: str, data: bytes) -> None:
        """向指定事件的所有订阅者广播二进制帧（PPV 振动场等大数组），自动清理失效连接"""
        subs = self._subs.get(event_id)
        if not subs:
            return
        dead: list[WebSocket] = []
        for ws in list(subs):
            try:
                await ws.send_bytes(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            subs.discard(ws)
        if not subs:
            self._subs.pop(event_id, None)
            self.stop_stream(event_id)

    async def start_stream(self, event_id: str, duration: float, timestep: float,
                          holes: Optional[list[dict]] = None,
                          charge_kg: float = 100.0,
                          blast_center: tuple = (0.0, 0.0, 0.0),
                          tunnel_width: float = 18.0,
                          tunnel_height: float = 15.0,
                          explosive_type: str = "emulsion",
                          use_jwl: bool = True,
                          rock_params: Optional[dict] = None) -> None:
        """启动（或重启）指定事件的模拟推送循环

        async 修正：先 await 旧任务取消完成（含 stopped 广播），再创建新任务，
        确保客户端不会在新 blast_start 之后才收到旧 stopped（时序错乱）。

        :param charge_kg: 装药量(kg)，用于 PPV 场计算
        :param blast_center: 爆心坐标 (x, y, z)
        :param tunnel_width: 隧道宽度(m)，用于 PPV 采样网格范围
        :param tunnel_height: 隧道高度(m)
        :param explosive_type: 炸药类型 'emulsion'|'anfo'|'dynamite'（JWL 模式用）
        :param use_jwl: True=JWL+FDTD 精确模式；False=萨道夫斯基近似 fallback
        :param rock_params: 岩体参数 {density, p_wave_speed, s_wave_speed, ...}（可选）
        """
        # 取消已有任务并 await 其清理完成（含 stopped 广播）
        await self.stop_stream_async(event_id)

        # 预计算分段起爆事件（按 delayMs 排序）
        blast_events: list[tuple[float, dict]] = []
        if holes:
            for h in holes:
                dm = float(h.get("delayMs", 0) or 0)
                if dm >= 0:
                    blast_events.append((dm / 1000.0, {
                        "type": "blast_segment",
                        "t": round(dm / 1000.0, 4),
                        "holeId": h.get("id"),
                        "series": h.get("detonatorSeries"),
                        "chargeKg": float(h.get("chargeKg", 0) or 0),
                    }))
            blast_events.sort(key=lambda x: x[0])

        # 预构建 PPV 采样网格（一次性，循环内仅更新时间 t）
        grid_xyz, grid_shape, bounds_min, bounds_max = build_ppv_grid(
            tunnel_width=tunnel_width, tunnel_height=tunnel_height
        )

        # 问题 8：JWL+FDTD 精确模式 — 创建有状态 FDTD 引擎，_stream_loop 每帧增量推进
        fdtd_engine = None
        n_substeps = 0
        if use_jwl and charge_kg > 0:
            rock = RockMedium()
            if isinstance(rock_params, dict):
                # 允许客户端覆盖默认岩体参数（密度/波速/泊松比等）
                rock = RockMedium(
                    density=float(rock_params.get("density", rock.density)),
                    p_wave_speed=float(rock_params.get("pWaveSpeed", rock.p_wave_speed)),
                    s_wave_speed=float(rock_params.get("sWaveSpeed", rock.s_wave_speed)),
                    youngs_modulus=float(rock_params.get("youngsModulus", rock.youngs_modulus)),
                    poissons_ratio=float(rock_params.get("poissonsRatio", rock.poissons_ratio)),
                    attenuation_p=float(rock_params.get("attenuationP", rock.attenuation_p)),
                    attenuation_s=float(rock_params.get("attenuationS", rock.attenuation_s)),
                )
            try:
                fdtd_engine = make_fdtd_engine(
                    grid_xyz, grid_shape, bounds_min, bounds_max,
                    charge_kg, explosive_type, rock
                )
                # 每推送帧的 FDTD 子步数 = timestep / dt（CFL 稳定步长）
                n_substeps = max(1, int(round(timestep / fdtd_engine.dt)))
                logger.info("[BlastingWS] FDTD 引擎已创建 event=%s explosive=%s R0=%.3fm P0=%.2ePa "
                            "dt=%.6fs n_substeps=%d/grid=%s",
                            event_id, explosive_type, fdtd_engine.source.cavity_radius,
                            fdtd_engine.source.peak_pressure, fdtd_engine.dt, n_substeps, grid_shape)
            except Exception as e:
                # FDTD 创建失败时降级为萨道夫斯基，保证推送不中断
                logger.exception("[BlastingWS] FDTD 引擎创建失败，降级萨道夫斯基: %s", e)
                fdtd_engine = None
                use_jwl = False

        state = StreamState(
            duration=duration,
            timestep=timestep,
            total_frames=max(1, int(round(duration / timestep))),
            blast_events=blast_events,
            charge_kg=charge_kg,
            blast_center=np.array(blast_center, dtype=np.float32),
            grid_xyz=grid_xyz,
            grid_shape=grid_shape,
            bounds_min=bounds_min,
            bounds_max=bounds_max,
            use_jwl=use_jwl,
            explosive_type=explosive_type,
            fdtd_engine=fdtd_engine,
            n_substeps=n_substeps,
        )
        self._streams[event_id] = state
        self._tasks[event_id] = asyncio.create_task(
            self._stream_loop(event_id, state)
        )
        logger.info("[BlastingWS] stream started event=%s duration=%.2fs frames=%d PPV_grid=%s mode=%s",
                    event_id, duration, state.total_frames, grid_shape,
                    "JWL+FDTD" if use_jwl else "Sadosky-fallback")

    def stop_stream(self, event_id: str) -> None:
        """停止指定事件的推送循环（同步版，用于 disconnect 等非 async 上下文）

        仅调用 task.cancel()，不 await 完成。适用于 disconnect 场景
        （后续不会有立即的 start_stream，时序错乱风险低）。
        """
        self._streams.pop(event_id, None)
        task = self._tasks.pop(event_id, None)
        if task and not task.done():
            task.cancel()

    async def stop_stream_async(self, event_id: str) -> None:
        """停止推送循环（异步版，await 被取消任务完成，确保 stopped 广播先于新任务）

        用于 start_stream 内部，确保旧任务的 stopped 广播完成后才创建新任务，
        避免客户端收到时序错乱（blast_start 之后才收到 stopped）。
        """
        self._streams.pop(event_id, None)
        task = self._tasks.pop(event_id, None)
        if task and not task.done():
            task.cancel()
            try:
                await task  # 等待 CancelledError 处理完成（含 stopped 广播）
            except asyncio.CancelledError:
                pass  # 预期内的取消

    async def _stream_loop(self, event_id: str, state: "StreamState") -> None:
        """
        推送主循环：按 timestep 间隔推送进度帧 + 分段起爆事件

        播放速率：实时推送（timestep 秒/帧），前端通过 playbackRate 控制本地倍速。
        后端不缓存碎片物理状态（碎片 DEM 在前端 Worker 计算），仅推送时间轴进度。
        """
        delay = state.timestep  # 秒
        t = 0.0
        frame = 0
        evt_idx = 0

        try:
            # 起爆通知
            await self.broadcast(event_id, {
                "type": "blast_start",
                "duration": state.duration,
                "timestep": state.timestep,
                "totalFrames": state.total_frames,
                "timestamp": datetime.now().isoformat(),
            })

            while frame < state.total_frames:
                await asyncio.sleep(delay)
                t += state.timestep
                frame += 1

                # 进度帧（JSON 文本）
                await self.broadcast(event_id, {
                    "type": "progress",
                    "t": round(t, 4),
                    "frame": frame,
                    "totalFrames": state.total_frames,
                    "progress": round(frame / state.total_frames, 4),
                })

                # PPV 振动场 + 应力场 + 损伤分区（二进制帧）— 每 2 帧推送一次以降低带宽
                # 三帧在同一时刻 t 计算/推送，前端据此实现振动-应力-损伤的同步演化
                if state.grid_xyz is not None and frame % 2 == 0:
                    if state.use_jwl and state.fdtd_engine is not None:
                        # 问题 8：JWL+FDTD 精确模式
                        # 有状态引擎增量推进 n_substeps 个子步（CFL 稳定），sim_time 与 t 同步
                        # 输出 PPV = √(vx²+vy²+vz²)，物理含 JWL 爆腔源 + 弹性波传播
                        state.fdtd_engine.step(state.n_substeps)
                        ppv = state.fdtd_engine.get_ppv()
                    else:
                        # 萨道夫斯基近似 fallback（后端不可用 JWL 或 use_jwl=False）
                        ppv = ppv_field_3d(
                            state.grid_xyz, state.blast_center,
                            state.charge_kg, t=t
                        )
                    await self.broadcast_bytes(event_id, pack_ppv_binary(
                        frame, t, state.grid_shape,
                        state.bounds_min, state.bounds_max, ppv
                    ))

                    # 结构力学应力反演（σ_vm）+ Persson 损伤分区
                    # 复用同一 PPV 场，避免重复正演；σ_vm 单通道、zones int8，带宽增量小
                    stress = stress_field_from_ppv(ppv)
                    await self.broadcast_bytes(event_id, pack_stress_binary(
                        frame, t, state.grid_shape,
                        state.bounds_min, state.bounds_max, stress['sigma_vm']
                    ))
                    zones = damage_zone_classify(ppv)
                    await self.broadcast_bytes(event_id, pack_damage_binary(
                        frame, t, state.grid_shape,
                        state.bounds_min, state.bounds_max, zones
                    ))

                # 分段起爆事件（在当前时间窗口内触发的）
                while evt_idx < len(state.blast_events) and state.blast_events[evt_idx][0] <= t:
                    await self.broadcast(event_id, state.blast_events[evt_idx][1])
                    evt_idx += 1

            # 完成通知
            await self.broadcast(event_id, {
                "type": "completed",
                "totalFrames": state.total_frames,
                "timestamp": datetime.now().isoformat(),
            })
        except asyncio.CancelledError:
            await self.broadcast(event_id, {"type": "stopped"})
            raise
        except Exception as e:
            logger.exception("[BlastingWS] stream loop error event=%s: %s", event_id, e)
            await self.broadcast(event_id, {"type": "error", "message": str(e)})


class StreamState:
    """单次模拟推送的状态快照"""

    __slots__ = ("duration", "timestep", "total_frames", "blast_events",
                 "charge_kg", "blast_center", "grid_xyz", "grid_shape",
                 "bounds_min", "bounds_max",
                 "use_jwl", "explosive_type", "fdtd_engine", "n_substeps")

    def __init__(self, duration: float, timestep: float,
                 total_frames: int, blast_events: list[tuple[float, dict]],
                 charge_kg: float = 100.0, blast_center: Optional[np.ndarray] = None,
                 grid_xyz: Optional[np.ndarray] = None, grid_shape: Optional[tuple] = None,
                 bounds_min: Optional[np.ndarray] = None, bounds_max: Optional[np.ndarray] = None,
                 use_jwl: bool = True, explosive_type: str = "emulsion",
                 fdtd_engine=None, n_substeps: int = 0):
        self.duration = duration
        self.timestep = timestep
        self.total_frames = total_frames
        self.blast_events = blast_events
        self.charge_kg = charge_kg
        self.blast_center = blast_center
        self.grid_xyz = grid_xyz
        self.grid_shape = grid_shape
        self.bounds_min = bounds_min
        self.bounds_max = bounds_max
        # 问题 8：JWL+FDTD 精确模式 vs 萨道夫斯基近似 fallback
        self.use_jwl = use_jwl
        self.explosive_type = explosive_type
        self.fdtd_engine = fdtd_engine  # ElasticWaveFDTD3D 实例（use_jwl=True 时非空）
        self.n_substeps = n_substeps    # 每推送帧的 FDTD 子步数 = timestep/dt


# 全局单例（FastAPI 应用级别共享）
mgr = BlastConnectionManager()


@router.websocket("/ws/blasting/{event_id}/stream")
async def blasting_stream(ws: WebSocket, event_id: str):
    """
    爆破模拟实时流 WebSocket 端点

    客户端→服务端指令（JSON 文本帧）：
        {"type": "start", "duration": 10.0, "timestep": 0.05, "holes": [...]}
        {"type": "stop"}
        {"type": "ping", "t": 1690000000000}

    服务端→客户端推送（JSON 文本帧）：
        {"type": "blast_start", "duration":..., "timestep":..., "totalFrames":..., "timestamp":...}
        {"type": "progress", "t":..., "frame":..., "totalFrames":..., "progress":...}
        {"type": "blast_segment", "t":..., "holeId":..., "series":..., "chargeKg":...}
        {"type": "completed", "totalFrames":..., "timestamp":...}
        {"type": "pong", "t":...}
        {"type": "stopped"}
        {"type": "error", "message":...}
    """
    await mgr.connect(ws, event_id)
    try:
        while True:
            # 心跳超时检测：客户端 TCP 半开（无 FIN）时，60s 无消息判定断线
            # 前端 blastingWsConnector.js 有 15s ping/30s 超时，此处 60s 兜底
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=60.0)
            except asyncio.TimeoutError:
                logger.info("[BlastingWS] heartbeat timeout event=%s, closing", event_id)
                await ws.close(code=1001, reason="heartbeat timeout")
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "message": "invalid JSON"}))
                continue

            ctype = msg.get("type")
            if ctype == "start":
                duration = float(msg.get("duration", 10.0))
                timestep = float(msg.get("timestep", 0.05))
                holes = msg.get("holes")
                # PPV 振动场计算参数（客户端 camelCase → 后端 snake_case）
                # 未提供时由 start_stream 默认值兜底（charge_kg=100, tunnel 18x15）
                charge_kg = float(msg.get("chargeKg", 100.0))
                bc = msg.get("blastCenter")
                blast_center = tuple(float(v) for v in bc) if isinstance(bc, (list, tuple)) and len(bc) >= 3 else (0.0, 0.0, 0.0)
                tunnel_width = float(msg.get("tunnelWidth", 18.0))
                tunnel_height = float(msg.get("tunnelHeight", 15.0))
                # 问题 8：JWL+FDTD 精确模式参数（未提供时默认 JWL，可显式关闭降级萨道夫斯基）
                explosive_type = str(msg.get("explosiveType", "emulsion"))
                use_jwl = msg.get("useJwl", True)
                use_jwl = bool(use_jwl) if use_jwl is not None else True
                rock_params = msg.get("rockParams")  # 可选 dict
                # start_stream 改为 async：先 await 旧任务取消完成（含 stopped 广播），再创建新任务
                await mgr.start_stream(
                    event_id, duration, timestep, holes,
                    charge_kg=charge_kg,
                    blast_center=blast_center,
                    tunnel_width=tunnel_width,
                    tunnel_height=tunnel_height,
                    explosive_type=explosive_type,
                    use_jwl=use_jwl,
                    rock_params=rock_params,
                )
            elif ctype == "stop":
                mgr.stop_stream(event_id)
            elif ctype == "ping":
                await ws.send_text(json.dumps({"type": "pong", "t": msg.get("t")}))
            else:
                await ws.send_text(json.dumps({"type": "error", "message": f"unknown type: {ctype}"}))
    except WebSocketDisconnect:
        logger.info("[BlastingWS] client disconnected event=%s", event_id)
    except Exception:
        logger.exception("[BlastingWS] unexpected error event=%s", event_id)
    finally:
        mgr.disconnect(ws, event_id)
