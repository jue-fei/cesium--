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
    build_ppv_grid, ppv_field_3d, ppv_field_3d_multi, pack_ppv_binary,
    stress_field_from_ppv, damage_zone_classify, damage_zone_field,
    damage_zone_radius,
    tunnel_void_mask, peak_ppv_envelope_multi,
    pack_stress_binary, pack_damage_binary,
    make_fdtd_engine, RockMedium,
    compute_near_field_radius,
    _expand_sources_with_reflections, _radial_energy_envelope,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _parse_face_reflection(reflections):
    """解析前端 reflections 配置 [{axis,value,coeff}] → (face_z, coeff) | (None, 0.0)。

    仅支持 axis='z' 的掌子面平面（与后端网格 face_axis='z'、隧道空腔掩码一致）。
    """
    if not isinstance(reflections, list):
        return None, 0.0
    for r in reflections:
        if not isinstance(r, dict):
            continue
        if str(r.get('axis', 'z')).lower() != 'z':
            continue
        try:
            value = float(r.get('value'))
            coeff = float(r.get('coeff', 0.85))
        except (TypeError, ValueError):
            continue
        if coeff > 0.001:
            return value, max(0.0, min(1.0, coeff))
    return None, 0.0


def _compute_stream_ppv(state, t: float) -> np.ndarray:
    """计算某模拟时刻的 PPV 场（(N,) 平坦一维，空腔已掩码）。

    抽取为独立函数：常规推流与 seek 即时校正推送共用同一口径，
    确保拖进度条后场值与实时推流完全一致，无时间轴错位。
    """
    if state.use_jwl and state.fdtd_engine is not None:
        # JWL+FDTD：有状态引擎增量推进（seek 时不做回退，seed 后仅重置峰值）
        ppv = state.fdtd_engine.get_ppv()
    elif state.multi_sources:
        ppv = ppv_field_3d_multi(
            state.grid_xyz, state.multi_sources, t,
            K=state.k, alpha=state.alpha, visual_c_p=35.0,
            influence_radius=getattr(state, 'influence_radius', None),
        )
    else:
        ppv = ppv_field_3d(
            state.grid_xyz, state.blast_center, state.charge_kg,
            K=state.k, alpha=state.alpha, t=t,
            visual_c_p=35.0,
            influence_radius=getattr(state, 'influence_radius', None),
        )
    ppv = np.asarray(ppv).reshape(-1)
    if state.void_mask is not None:
        ppv = np.where(state.void_mask, 0.0, ppv)
    return ppv


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
                          sources: Optional[list[dict]] = None,
                          charge_kg: float = 100.0,
                          blast_center: tuple = (0.0, 0.0, 0.0),
                          tunnel_width: float = 18.0,
                          tunnel_height: float = 15.0,
                          explosive_type: str = "emulsion",
                          use_jwl: bool = True,
                          rock_params: Optional[dict] = None,
                          k: float = 30.0, alpha: float = 1.5,
                          influence_radius: float = 15.0,
                          reflections: Optional[list[dict]] = None) -> None:
        """启动（或重启）指定事件的模拟推送循环

        async 修正：先 await 旧任务取消完成（含 stopped 广播），再创建新任务，
        确保客户端不会在新 blast_start 之后才收到旧 stopped（时序错乱）。

        :param charge_kg: 装药量(kg)，用于 PPV 场计算
        :param blast_center: 爆心坐标 (x, y, z)
        :param tunnel_width: 隧道宽度(m)，用于 PPV 采样网格范围
        :param tunnel_height: 隧道高度(m)
        :param explosive_type: 炸药类型 'emulsion'|'anfo'|'dynamite'（JWL 模式用）
        :param use_jwl: True=JWL+FDTD 精确模式；False=萨道夫斯基近似 fallback
        :param sources: 多装药源列表 [{x,y,z,chargeKg,delayMs}]（前端按实际炮孔布孔推算）。
            提供时萨道夫斯基 fallback 走多源矢量叠加（多应力波干涉波场，非单一同心圆）；
            未提供则退化为单源（blast_center）。
        :param rock_params: 岩体参数 {density, p_wave_speed, s_wave_speed, ...}（可选）
        :param k: 萨道夫斯基场地常数（默认 30，供近似模式使用）
        :param alpha: 萨道夫斯基衰减指数（默认 1.5）
        """
        # 取消已有任务并 await 其清理完成（含 stopped 广播）
        await self.stop_stream_async(event_id)

        # 归一化多装药源 → 后端 {pos, charge_kg, delay_s}
        multi_sources: list[dict] = []
        if isinstance(sources, list) and sources:
            for s in sources:
                if not isinstance(s, dict):
                    continue
                q = float(s.get('chargeKg') or s.get('charge_kg') or 0)
                if q <= 0:
                    continue
                pos = [
                    float(s.get('x') or s.get('posX') or 0),
                    float(s.get('y') or s.get('posY') or 0),
                    float(s.get('z') or s.get('posZ') or 0),
                ]
                multi_sources.append({
                    'pos': pos,
                    'charge_kg': q,
                    'delay_s': float(s.get('delayMs') or s.get('delay_ms') or 0) / 1000.0,
                })
        if multi_sources:
            logger.info("[BlastingWS] 多装药源叠加模式启用 event=%s 源数=%d", event_id, len(multi_sources))

        # 自由面（掌子面）镜象反射：与本地模拟/GPU 岩面同一物理口径——源在岩体侧
        # 时生成同号镜象源（幅值×coeff，仅岩体一侧接收），近掌子面出现反射放大与
        # 直达/反射干涉。无多源时对单一爆心源同样展开（转走多源路径，保证瞬时场
        # 与峰值场口径一致）；无 reflections 配置时保持旧行为。
        face_z, refl_coeff = _parse_face_reflection(reflections)
        if face_z is not None and not multi_sources and charge_kg > 0:
            multi_sources = [{
                'pos': [float(blast_center[0]), float(blast_center[1]), float(blast_center[2])],
                'charge_kg': float(charge_kg),
                'delay_s': 0.0,
            }]
        if face_z is not None and multi_sources:
            multi_sources = _expand_sources_with_reflections(multi_sources, face_z, refl_coeff)
            logger.info("[BlastingWS] 掌子面镜象反射启用 event=%s face_z=%.2f coeff=%.2f 展开后源数=%d",
                        event_id, face_z, refl_coeff, len(multi_sources))

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
        # 【P0-2】隧道空腔掩码（已开挖洞身=自由面/临空面空洞）：空腔内无岩体，
        # PPV/应力/损伤一律归 0，避免"隧道是透明贴图、场值随意穿洞"。
        void_mask = tunnel_void_mask(
            grid_xyz, tunnel_width=tunnel_width, tunnel_height=tunnel_height,
            face_axis='z', face_pos=0.0,
        )
        # 【损伤范围理论】裂隙区半径（damage_zone_radius，宗琦 1994 / 梁瑞 2020）：
        # 损伤半径完全由"孔壁初始压力→粉碎区→裂隙区"纯物理推算，不设人工上限
        # （max_radius 传 None → 取裂隙区理论半径）；min_radius=2×网格分辨率作
        # 可见性下限（r_t 亚体素时损伤区不至于整体不可见）。此处一次性计算并随 state 下发。
        _sz = np.asarray(bounds_max, dtype=np.float64) - np.asarray(bounds_min, dtype=np.float64)
        _sh = np.maximum(np.asarray(grid_shape, dtype=np.float64) - 1.0, 1.0)
        _grid_h = float(np.max(_sz / _sh))
        damage_theory = damage_zone_radius()
        damage_min_radius = 2.0 * _grid_h

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
            # 多装药源（JWL 模式用）：每个炮孔装药段作为独立 JWL 爆腔源→多应力波叠加
            # （仅直达源；镜象反射 gate 条目 FDTD 无法表达，不参与）
            fdtd_sources = None
            if multi_sources:
                fdtd_sources = [
                    {"x": s["pos"][0], "y": s["pos"][1], "z": s["pos"][2],
                     "chargeKg": s["charge_kg"], "delayMs": s["delay_s"] * 1000.0}
                    for s in multi_sources if s.get('gate_z_min') is None
                ] or None
            try:
                fdtd_engine = make_fdtd_engine(
                    grid_xyz, grid_shape, bounds_min, bounds_max,
                    charge_kg, explosive_type, rock,
                    blast_center=np.array(blast_center, dtype=np.float32),
                    sources=fdtd_sources
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
            multi_sources=multi_sources,
            k=k, alpha=alpha,
            influence_radius=influence_radius,
            void_mask=void_mask,
        )
        # 损伤峰值累积缓冲（见 StreamState.peak_ppv 说明）
        state.peak_ppv = np.zeros(grid_xyz.shape[0], dtype=np.float32)
        # 应力近场几何修正：各点到爆心距离（只算一次）+ 交叉半径（由装药量反算）。
        # 见 blast_physics.NEAR_FIELD_* —— 让应力场（峰值判据场）与振速场
        # （瞬时波形）空间结构不同，而不是只差一个常数。
        state.grid_r = np.linalg.norm(
            np.asarray(grid_xyz, dtype=np.float32)
            - np.asarray(blast_center, dtype=np.float32),
            axis=1,
        ).astype(np.float32)
        state.near_field_radius = compute_near_field_radius(charge_kg)
        # 【Seek 即时修复】解析路径预计算确定性峰值包络：peak_ppv(t) 由
        # (peak_full, arrival) 门控直接给出，seek/回拉 O(N) 即时、无逐帧重算
        if not (use_jwl and fdtd_engine is not None):
            peak_sources = multi_sources or [
                {'pos': list(np.asarray(blast_center, dtype=np.float64)),
                 'charge_kg': charge_kg, 'delay_s': 0.0}
            ]
            # 包络拆分缓存：核心峰值场（O(nS·N)，与 influenceRadius 无关）+ dmin
            # 一次算好；影响半径热更新只做 O(N) 的 peak_core × env(dmin) 重乘
            state.peak_core, state.peak_arrival, state.peak_dmin = peak_ppv_envelope_multi(
                grid_xyz, peak_sources,
                K=k, alpha=alpha,
                influence_radius=influence_radius,
                split_envelope=True,
            )
            state.peak_full = state.peak_core * _radial_energy_envelope(
                state.peak_dmin, influence_radius
            )
            if void_mask is not None:
                state.peak_full = np.where(void_mask, 0.0, state.peak_full)
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
        # ── 第六章实验·运行时统计（仅日志，不改变任何推流行为）────────────
        run_stats = {"frames_bin": 0, "bytes_ppv": 0, "bytes_stress": 0, "bytes_damage": 0}

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
                # ── seek 处理：拖进度条/jump 跳变时推进时间轴游标，并即时推送
                # seek 目标时刻的三场。解析路径的损伤峰值由确定性包络
                # （peak_full × t≥arrival 门控）直接给出——无需也不允许逐帧
                # 重算累积峰值：旧实现 while f<=target 逐 2 帧全场正演
                # （~228ms/次），拖到后段一次 seek 阻塞事件循环数十秒，
                # 期间零推流零响应，前端损伤纹理停留在拖动前的旧状态
                # （"回到 50 帧仍显示 235 帧累积损伤"的直接根因）。
                if state.seek_frame is not None:
                    target = max(0, min(int(state.seek_frame), state.total_frames))
                    state.seek_frame = None
                    seek_t = state.timestep * target
                    # 【Seek 诊断】打印目标帧号与回滚前的峰值统计，供核对
                    # "peak_ppv 是否按当前时间戳回滚，而非保留未来帧最大值"
                    logger.info(
                        "[BlastingWS][SEEK] event=%s target_frame=%d/%d t=%.3fs "
                        "mode=%s peak_before max=%.3e mean=%.3e",
                        event_id, target, state.total_frames, seek_t,
                        "FDTD" if (state.use_jwl and state.fdtd_engine is not None) else "Sadosky",
                        float(np.max(state.peak_ppv)) if state.peak_ppv is not None else -1.0,
                        float(np.mean(state.peak_ppv)) if state.peak_ppv is not None else -1.0,
                    )
                    if state.use_jwl and state.fdtd_engine is not None:
                        # FDTD 有状态引擎无法回退：仅重置峰值（后续从当前时刻继续累积）
                        state.peak_ppv.fill(0.0)
                    else:
                        # 萨道夫斯基确定性场：门控即时给出 target 时刻峰值，O(N)
                        t = seek_t
                        frame = target
                        while evt_idx < len(state.blast_events) and state.blast_events[evt_idx][0] <= t:
                            evt_idx += 1
                        await self.broadcast(event_id, {
                            "type": "progress",
                            "t": round(t, 4),
                            "frame": frame,
                            "totalFrames": state.total_frames,
                            "progress": round(frame / state.total_frames, 4),
                        })
                        # 即时推送 seek 时刻三场：前端拖动后立即可见校正结果
                        # （损伤已按确定性峰值重置，无未来帧污染），而非等
                        # target+2 帧的下一常规推送
                        if state.grid_xyz is not None:
                            ppv = _compute_stream_ppv(state, seek_t)
                            ppv_bytes = pack_ppv_binary(
                                frame, t, state.grid_shape,
                                state.bounds_min, state.bounds_max, ppv,
                            )
                            await self.broadcast_bytes(event_id, ppv_bytes)
                            run_stats["frames_bin"] += 1
                            run_stats["bytes_ppv"] += len(ppv_bytes)
                            # 峰值包络（损伤判据用）：解析路径门控即得 target 时刻的
                            # 确定性峰值，与前端本地模拟同口径
                            np.multiply(
                                state.peak_full, t >= state.peak_arrival,
                                out=state.peak_ppv,
                            )
                            # 【Seek 回滚日志】peak_ppv 已按 target 时刻的确定性包络
                            # 门控重算（不是保留未来帧最大值），此处打印回滚后统计
                            logger.info(
                                "[BlastingWS][SEEK] peak_ppv rolled back event=%s "
                                "frame=%d max=%.3e mean=%.3e",
                                event_id, frame,
                                float(np.max(state.peak_ppv)),
                                float(np.mean(state.peak_ppv)),
                            )
                            # 应力由**瞬时振速**反演 + 近场几何修正：与前端 shader
                            # 解析支同口径（mps × stressFactor × F(r)），保证波前可见
                            stress = stress_field_from_ppv(
                                ppv,
                                r=state.grid_r,
                                near_field_radius=state.near_field_radius,
                            )
                            sigma_vm = np.asarray(stress['sigma_vm']).reshape(-1)
                            if state.void_mask is not None:
                                sigma_vm = np.where(state.void_mask, 0.0, sigma_vm)
                            stress_bytes = pack_stress_binary(
                                frame, t, state.grid_shape,
                                state.bounds_min, state.bounds_max, sigma_vm,
                            )
                            await self.broadcast_bytes(event_id, stress_bytes)
                            run_stats["bytes_stress"] += len(stress_bytes)
                            # 【损伤范围理论】radius_model='theory'：损伤半径=裂隙区理论半径 r_t
                            # （max_radius=None 不设人工上限），并以 2×网格分辨率为
                            # 可见性下限（见 damage_zone_field）
                            zones = damage_zone_field(
                                state.grid_xyz, state.peak_ppv,
                                sources=(state.multi_sources or None),
                                blast_center=tuple(state.blast_center),
                                max_radius=None,
                                void_mask=state.void_mask,
                                radius_model='theory',
                                min_radius=getattr(state, 'damage_min_radius', 0.0),
                            )
                            damage_bytes = pack_damage_binary(
                                frame, t, state.grid_shape,
                                state.bounds_min, state.bounds_max, zones,
                            )
                            await self.broadcast_bytes(event_id, damage_bytes)
                            run_stats["bytes_damage"] += len(damage_bytes)

                state.current_frame = frame
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
                        # K/α 由客户端经 start 指令传入（k/alpha），未提供时默认 K=30、α=1.5
                        # 有多装药源时走矢量叠加（多应力波干涉，非单一同心圆）
                        if state.multi_sources:
                            ppv = ppv_field_3d_multi(
                                state.grid_xyz, state.multi_sources,
                                t, K=state.k, alpha=state.alpha, visual_c_p=35.0,
                                influence_radius=getattr(state, 'influence_radius', None),
                            )
                        else:
                            ppv = ppv_field_3d(
                                state.grid_xyz, state.blast_center,
                                state.charge_kg, K=state.k, alpha=state.alpha, t=t,
                                visual_c_p=35.0,
                                influence_radius=getattr(state, 'influence_radius', None),
                            )
                    # 统一展平为 (N,)，再对隧道空腔（已开挖洞身/自由面）内无岩体的
                    # 网格点归 0，避免场值穿洞（FDTD 模式 get_ppv() 为三维，需先展平）
                    ppv = np.asarray(ppv).reshape(-1)
                    if state.void_mask is not None:
                        ppv = np.where(state.void_mask, 0.0, ppv)
                    ppv_bytes = pack_ppv_binary(
                        frame, t, state.grid_shape,
                        state.bounds_min, state.bounds_max, ppv
                    )
                    await self.broadcast_bytes(event_id, ppv_bytes)
                    run_stats["frames_bin"] += 1
                    run_stats["bytes_ppv"] += len(ppv_bytes)

                    # 峰值包络先行（应力与损伤共用同一包络）：
                    # 解析路径用确定性峰值包络（与前端本地模拟
                    # computeMultiSourcePeakDamageZones 同口径：几何峰值 × 到达门控，
                    # 正放/回拉/拖进度条结果一致）；FDTD 有状态引擎走逐帧 np.maximum
                    # 累积（get_ppv() 三维数组需对齐展平）。
                    if state.peak_full is not None:
                        np.multiply(
                            state.peak_full, t >= state.peak_arrival,
                            out=state.peak_ppv,
                        )
                    else:
                        np.maximum(state.peak_ppv, np.asarray(ppv).reshape(-1), out=state.peak_ppv)

                    # 结构力学应力反演（σ_vm）
                    if state.use_jwl and state.fdtd_engine is not None:
                        # JWL+FDTD 精确模式：由速度-应力 FDTD 的完整应力张量
                        # （sxx..syz）直接算 von Mises，保留真实波场径向压+切向拉的
                        # 空间分布，比 PPV 标量反演的一阶近似更接近数值解。
                        stress = {'sigma_vm': state.fdtd_engine.get_sigma_vm()}
                    else:
                        # 萨道夫斯基 fallback：由**瞬时振速**反演 + 近场几何修正
                        # F(r)=1+A·(r_nf/r)²。与前端 shader 解析支同口径
                        # （mps × stressFactor × F(r)）→ 波前/梯度清晰可见。
                        # 【勿改回峰值包络】峰值场是静态云图，会丢失波前时间结构
                        # （用户实测："巨大的黄色高斯云，缺乏波场结构"）。
                        stress = stress_field_from_ppv(
                            ppv,
                            r=state.grid_r,
                            near_field_radius=state.near_field_radius,
                        )
                    # 隧道空腔内无岩体：σ_vm 归 0（解析路径的 ppv 已掩码，此处兜底 FDTD）
                    sigma_vm = np.asarray(stress['sigma_vm']).reshape(-1)
                    if state.void_mask is not None:
                        sigma_vm = np.where(state.void_mask, 0.0, sigma_vm)
                    stress_bytes = pack_stress_binary(
                        frame, t, state.grid_shape,
                        state.bounds_min, state.bounds_max, sigma_vm
                    )
                    await self.broadcast_bytes(event_id, stress_bytes)
                    run_stats["bytes_stress"] += len(stress_bytes)
                    # 【P0-1/P0-2 + 损伤范围理论】Persson 阈值 + 裂隙区半径硬上限
                    #（theory：min(UI 上限, r_t)，min_radius=2×网格分辨率可见性下限）
                    # + 隧道空腔掩码，使损伤收束在炮孔群裂隙区范围内，而非等向红圆。
                    zones = damage_zone_field(
                        state.grid_xyz, state.peak_ppv,
                        sources=(state.multi_sources or None),
                        blast_center=tuple(state.blast_center),
                        max_radius=None,
                        void_mask=state.void_mask,
                        radius_model='theory',
                        min_radius=getattr(state, 'damage_min_radius', 0.0),
                    )
                    damage_bytes = pack_damage_binary(
                        frame, t, state.grid_shape,
                        state.bounds_min, state.bounds_max, zones
                    )
                    await self.broadcast_bytes(event_id, damage_bytes)
                    run_stats["bytes_damage"] += len(damage_bytes)

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
            # ── 第六章实验·运行时统计汇总（真实推送测得的字节与网格维度）──
            nx, ny, nz = state.grid_shape
            V = nx * ny * nz
            per_ppv = 45 + 4 * V
            logger.info(
                "[CH6_RUNTIME] event=%s grid_shape=%sx%sx%s V=%d "
                "bin_frames=%d per_frame_ppv=%dB per_frame_stress=%dB per_frame_damage=%dB "
                "total_ppv=%.1fKB total_stress=%.1fKB total_damage=%.1fKB total_all=%.1fKB",
                event_id, nx, ny, nz, V,
                run_stats["frames_bin"], 45 + 4 * V, 45 + 4 * V, 45 + V,
                run_stats["bytes_ppv"] / 1024, run_stats["bytes_stress"] / 1024,
                run_stats["bytes_damage"] / 1024,
                (run_stats["bytes_ppv"] + run_stats["bytes_stress"] + run_stats["bytes_damage"]) / 1024,
            )
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
                 "use_jwl", "explosive_type", "fdtd_engine", "n_substeps",
                 "multi_sources", "k", "alpha", "peak_ppv",
                 "peak_full", "peak_arrival", "peak_core", "peak_dmin",
                 "grid_r", "near_field_radius",
                 "influence_radius", "void_mask",
                 "seek_frame", "current_frame")

    def __init__(self, duration: float, timestep: float,
                 total_frames: int, blast_events: list[tuple[float, dict]],
                 charge_kg: float = 100.0, blast_center: Optional[np.ndarray] = None,
                 grid_xyz: Optional[np.ndarray] = None, grid_shape: Optional[tuple] = None,
                 bounds_min: Optional[np.ndarray] = None, bounds_max: Optional[np.ndarray] = None,
                 use_jwl: bool = True, explosive_type: str = "emulsion",
                 fdtd_engine=None, n_substeps: int = 0,
                 multi_sources: Optional[list] = None,
                 k: float = 30.0, alpha: float = 1.5,
                 influence_radius: float = 15.0,
                 void_mask: Optional[np.ndarray] = None):
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
        # 多装药源（萨道夫斯基 fallback 走多源矢量叠加时非空）
        self.multi_sources = multi_sources or []
        self.k = k                      # 萨道夫斯基场地常数
        self.alpha = alpha              # 萨道夫斯基衰减指数
        # 【P0-2】爆源影响半径（解析场能量包络，米）。损伤半径由 PPV 阈值纯理论
        # 计算（damage_zone_field max_radius=None → 裂隙区理论半径），不设人工上限。
        self.influence_radius = influence_radius
        # 【P0-2】隧道空腔掩码（(N,) bool）：已开挖洞身内无岩体→场值/损伤归零
        self.void_mask = void_mask
        # 损伤持久性：各网格点经历过的最大 PPV（损伤不可逆，不随波峰后的时变
        # 衰减回落；波前到达前保持 0）。解析路径由确定性峰值包络
        # （peak_full × t≥arrival 门控）直接给出；FDTD 路径逐帧 np.maximum 累积。
        self.peak_ppv = None
        # 确定性峰值包络（解析路径，start_stream 预计算一次）：
        #   peak_full  (N,) float32 全程几何峰值（含空腔/包络掩码，m/s）
        #   peak_arrival (N,) float64 最早波前到达时刻（s）
        # 任意 t 的峰值 = peak_full × 1[t ≥ peak_arrival] —— 正放/回拉/seek 全一致
        self.peak_full = None
        self.peak_arrival = None
        # 包络拆分缓存（start_stream 解析路径预计算）：核心峰值场与 dmin，
        # 影响半径热更新只做 O(N) 重乘
        self.peak_core = None
        self.peak_dmin = None
        # 应力近场几何修正（start_stream 预计算）：各点到爆心距离 (N,) 与交叉半径
        self.grid_r = None
        self.near_field_radius = 0.0
        # 当前推送游标（供 setFieldParams 热更新后按当前时刻重推校正帧）
        self.current_frame = 0
        # 待处理的 seek 跳转目标帧（None=无）：前端拖进度条时下发，_stream_loop
        # 消费后仅推进时间轴游标（峰值由包络门控即时给出，无需逐帧重算）
        self.seek_frame = None


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
                # 多装药源（各炮孔装药段）：[{x,y,z,chargeKg,delayMs}] 驱动多应力波矢量叠加
                sources_raw = msg.get("sources")
                sources = (
                    [s for s in sources_raw if isinstance(s, dict)]
                    if isinstance(sources_raw, list)
                    else None
                )
                # 萨道夫斯基 K/α 参数（客户端可调，未提供时默认 K=30、α=1.5）
                k = float(msg.get("k", 30.0))
                alpha = float(msg.get("alpha", 1.5))
                # 【P0-2】爆源影响半径（解析场能量包络，米）
                influence_radius = float(msg.get("influenceRadius", 15.0))
                # 自由面（掌子面）镜象反射配置 [{axis:'z', value: faceZ, coeff}]（可选，
                # 与本地模拟 sim.params.reflections 同源；未提供时后端不加反射）
                reflections = msg.get("reflections")
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
                    sources=sources,
                    k=k, alpha=alpha,
                    influence_radius=influence_radius,
                    reflections=reflections,
                )
            elif ctype == "stop":
                mgr.stop_stream(event_id)
            elif ctype == "ping":
                await ws.send_text(json.dumps({"type": "pong", "t": msg.get("t")}))
            elif ctype == "seek":
                # 拖进度条/jump：通知推流协程推进时间轴游标并即时推送目标时刻
                # 三场（损伤峰值由确定性包络门控给出，无未来帧峰值污染）。
                st = mgr._streams.get(event_id)
                if st is not None:
                    st.seek_frame = max(0, min(int(msg.get("frame", 0)), st.total_frames))
                else:
                    await ws.send_text(json.dumps({"type": "error", "message": "seek: stream not running"}))
            elif ctype == "setFieldParams":
                # 【实时生效】推流中热更新包络半径：influence_radius 参与确定性峰值
                # 包络，变更时重算 peak_full/peak_arrival 并重推校正帧。
                st = mgr._streams.get(event_id)
                if st is None:
                    await ws.send_text(json.dumps({"type": "error", "message": "setFieldParams: stream not running"}))
                else:
                    new_inf = float(msg.get("influenceRadius", st.influence_radius) or st.influence_radius)
                    inf_changed = abs(new_inf - st.influence_radius) > 1e-6
                    if inf_changed:
                        st.influence_radius = new_inf
                        if st.peak_core is not None:
                            # O(N) 重乘包络即可（核心峰值场与 influence_radius 无关）
                            st.peak_full = st.peak_core * _radial_energy_envelope(
                                st.peak_dmin, new_inf
                            )
                            if st.void_mask is not None:
                                st.peak_full = np.where(st.void_mask, 0.0, st.peak_full)
                        # 立即按当前游标重推校正帧（否则要等下一常规帧）
                        st.seek_frame = st.current_frame
                        logger.info(
                            "[BlastingWS][FIELD-PARAMS] event=%s influence_radius=%.1f (实时热更新)",
                            event_id, new_inf,
                        )
                        await ws.send_text(json.dumps({
                            "type": "fieldParamsApplied",
                            "influenceRadius": new_inf,
                        }))
            else:
                await ws.send_text(json.dumps({"type": "error", "message": f"unknown type: {ctype}"}))
    except WebSocketDisconnect:
        logger.info("[BlastingWS] client disconnected event=%s", event_id)
    except Exception:
        logger.exception("[BlastingWS] unexpected error event=%s", event_id)
    finally:
        mgr.disconnect(ws, event_id)
