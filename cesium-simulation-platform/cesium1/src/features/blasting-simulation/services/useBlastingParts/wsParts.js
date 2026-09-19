import { BlastingWsConnector, FrameType } from '../core/realtime/blastingWsConnector.js'

/**
 * 实时推送域工厂（WebSocket 推流连接与帧处理）
 *
 * 从 useBlasting() 拆出的"实时推送通道"职责区：与后端建立 WS 实时连接，
 * 接收 PPV/应力/损伤三场二进制帧与完成事件，管理 seek 去重与推流生命周期；
 * 同时承载 clearSimulation（全局清场，原实现位于本职责区内）。
 *
 * 状态归属：blastingWs/blastingManager 及 pendingWsDataset、seek 锁、
 * wsVibrationStarted 等 let 重绑定句柄仍驻留 useBlasting.js 模块作用域，
 * 经 ctx 存取器读写；wsConnected/wsBackendCompleted 为模块级响应式单例（直接共享）。
 *
 * 跨域依赖（运行期经 ctx 延迟调用，构造期不得互调）：
 * - ctx.playback.pausePlayback / effectiveDurationS （clearSimulation 停播放并复位时长）
 * - ctx.keyframe.stopPrecomputeWatch （clearSimulation 停止预计算轮询）
 * - ctx.vibration.ppvPickEnabled / pickedPpv （clearSimulation 清理场点拾取状态）
 */
export function createWsParts(ctx) {
  const {
    showMessage,
    dataset,
    isPlaying,
    currentFrame,
    kcoParams,
    wsConnected,
    wsBackendCompleted,
    loadProgress,
    replayReady,
    replayPrecompute,
    currentEventId,
    abLoop,
    isStaleSeekFrame,
    getManager,
    getWs,
    setWs,
    getPendingWsDataset,
    setPendingWsDataset,
    getLastWsSeekFrame,
    setLastWsSeekFrame,
    setSeekLockFrame,
    setSeekLockDropped,
    setPendingAutoStart,
    getWsVibrationStarted,
    setWsVibrationStarted
  } = ctx

  // ─── 实时推送通道（WebSocket） ──────────────────────
  // 建立与后端的实时连接，接收模拟进度帧与分段起爆事件。
  // 降级策略：WS 不可用或断开时，本地 setInterval 播放不受影响。
  const buildWsStartPayload = ds => {
    if (!ds) return null
    const duration = Number(ds?.result?.simulationDurationS) || 10
    const timestep = Number(ds?.result?.timeStepS) || 0.05
    const holes = (ds?.design?.holes || []).map(h => ({
      id: h.id,
      delayMs: h.delayMs,
      detonatorSeries: h.detonatorSeries,
      chargeKg: h.chargeKg
    }))
    const ppvParams = getManager()?.getPpvStreamParams() || {}
    ppvParams.explosiveType =
      kcoParams.value?.explosiveType || ds?.event?.explosiveType || 'emulsion'
    // 多装药源（各炮孔装药段位置/药量/延时）：后端据此计算多应力波矢量叠加，
    // 非单一同心圆波场，符合真实掏槽微差起爆的波场干涉效果。
    // 【坐标系】getStreamBlastSources 已把源 z 平移到后端"掌子面 z=0"网格系
    // （与 ppvParams.blastCenter 同口径），GPU/本地模拟仍用 g 系源不受影响。
    ppvParams.sources = getManager()?.getStreamBlastSources() || null
    // JWL+FDTD 在 build_ppv_grid 的 1.5m 分辨率网格上无法解析爆腔（R0≈0.28m < 1 格），
    // 实测 PPV 输出 ~1e-11 m/s（低于前端可见阈值 8 个数量级），三场（PPV/应力/损伤）
    // 全部不可见。降级萨道夫斯基近似（与本地模拟器同物理模型，量级正常），
    // 待后端 FDTD 支持亚格子源或自适应加密后再启用。
    ppvParams.useJwl = false
    // 损伤半径由 PPV 阈值纯物理计算得出（见 computeMultiSourcePeakDamageZones），
    // 不设人工硬上限。influenceRadius=波场可达半径，已按岩体几何自动取。
    const bd = getManager()?.getDamageBoundary() || {}
    ppvParams.influenceRadius =
      Number(bd.influenceRadius) > 0 ? bd.influenceRadius : getManager()?.getInfluenceRadius() || 60
    // 掌子面自由面反射（镜象源法）：与本地模拟/GPU 岩面同一物理口径——后端展开
    // 镜象源后，WS 场与本地兜底场在近掌子面处一致（反射放大 + 直达/反射干涉）
    ppvParams.reflections = getManager()?.getVibrationReflections() || null
    if (ds?.event?.rockParams) {
      ppvParams.rockParams = ds.event.rockParams
    }
    return { duration, timestep, holes, ppvParams }
  }

  const startBlastingWsStream = (ds = dataset.value) => {
    if (!getWs()) return
    const payload = buildWsStartPayload(ds)
    if (!payload) return
    // 新一轮推流复位 seek 去重标记，保证首帧拖拽必然下发 seek
    setLastWsSeekFrame(-1)
    setSeekLockFrame(null)
    setSeekLockDropped(0)
    setPendingWsDataset(null)
    wsBackendCompleted.value = false
    setWsVibrationStarted(false)
    // 不立即禁用本地模拟：WS 数据到达前由本地模拟器填充振动场，避免可视化空窗。
    // 首帧 PPV 到达后由 PPV_FIELD 处理器禁用本地模拟，切换到 WS 实时数据。
    getManager()?.setLocalVibrationEnabled(true)
    getWs().startStream(payload.duration, payload.timestep, payload.holes, payload.ppvParams)
  }

  const connectBlastingWs = eventId => {
    disconnectBlastingWs()
    // 启用本地振动场模拟作为主数据源（WS 不可用时自行模拟实时数据）
    // 波前粒子特效始终由播放时钟驱动，保证振动传播可视化始终可用
    getManager()?.setLocalVibrationEnabled(true)
    setWs(new BlastingWsConnector(eventId))
    const ws = getWs()
    ws.on('_open', () => {
      wsConnected.value = true
      wsBackendCompleted.value = false
      getManager()?.setLocalVibrationEnabled(true)
      if (getPendingWsDataset() && currentFrame.value === 0 && isPlaying.value) {
        startBlastingWsStream(getPendingWsDataset())
      }
    })
    ws.on('_close', () => {
      wsConnected.value = false
      setWsVibrationStarted(false)
      // WS 断开：恢复本地热力图模拟，保证可视化不中断
      getManager()?.setLocalVibrationEnabled(true)
    })
    ws.on('_giveup', () => {
      wsConnected.value = false
      setWsVibrationStarted(false)
      getManager()?.setLocalVibrationEnabled(true)
      showMessage('实时连接断开，已切换到本地预览', 'warning')
    })
    ws.on(FrameType.PROGRESS, () => {
      // 不驱动 setFrame：本地播放定时器（startPlayback）已增量推进碎片动画，
      // PROGRESS 帧的 setFrame 会与本地播放冲突——偏差 > 10 帧时 seekTo
      // 触发异步重建粒子系统，碎片 InstancedMesh 在重建期间不更新，
      // 导致动画卡顿、帧跳转、轨迹不连贯。
      // WebSocket 仅负责推送振动场/应力/损伤数据，碎片动画由本地播放独立驱动。
    })
    // PPV 振动场二进制帧：首帧初始化体积，后续帧更新 Data3DTexture
    ws.on(FrameType.PPV_FIELD, payload => {
      const mgr = getManager()
      if (!mgr) return
      if (isStaleSeekFrame(payload.frame)) return
      const { frame, t, gridShape, boundsMin, boundsMax, ppv } = payload
      // 网格不一致时重建体积（本地模拟可能已用默认 32×32×64 网格初始化，
      // 不重建则 WS 帧因长度不匹配被丢弃，画面冻结）
      mgr.ensureVibrationField({ gridShape, boundsMin, boundsMax })
      mgr.updateVibrationField(ppv, t, frame)
      // 首帧 WS 数据到达：禁用本地 PPV 写入（应力/损伤仍由本地兜底），切换到 WS 实时数据
      if (!getWsVibrationStarted()) {
        setWsVibrationStarted(true)
        mgr?.setLocalVibrationEnabled(false)
      }
      // 每帧刷新振动场元信息，使 UI 即时反映 PPV 就绪状态
      ctx.vibration.vibrationFieldInfo.value = mgr?.getVibrationFieldInfo() || null
    })
    // σ_vm 应力场二进制帧：与 PPV 同时刻推送，更新应力纹理
    ws.on(FrameType.STRESS_FIELD, payload => {
      const mgr = getManager()
      if (!mgr) return
      if (isStaleSeekFrame(payload.frame)) return
      const { frame, t, gridShape, boundsMin, boundsMax, sigmaVm } = payload
      mgr.ensureVibrationField({ gridShape, boundsMin, boundsMax })
      mgr.updateStressField(sigmaVm, t, frame)
      // 每帧刷新振动场元信息，使 UI 即时反映应力就绪状态
      ctx.vibration.vibrationFieldInfo.value = mgr?.getVibrationFieldInfo() || null
    })
    // 损伤分区二进制帧：与 PPV 同时刻推送，更新损伤纹理
    ws.on(FrameType.DAMAGE_FIELD, payload => {
      const mgr = getManager()
      if (!mgr) return
      if (isStaleSeekFrame(payload.frame)) return
      const { frame, t, gridShape, boundsMin, boundsMax, zones } = payload
      mgr.ensureVibrationField({ gridShape, boundsMin, boundsMax })
      mgr.updateDamageField(zones, t, frame)
      // 每帧刷新振动场元信息，使 UI 即时反映损伤就绪状态
      ctx.vibration.vibrationFieldInfo.value = mgr?.getVibrationFieldInfo() || null
    })
    ws.on(FrameType.COMPLETED, () => {
      // 后端推送完成 ≠ 本地动画播放完成。
      // 设置标志，等本地播放到达最后一帧时才弹窗（双条件同步）。
      // 若本地播放已停止（本地快于后端），直接弹窗。
      wsBackendCompleted.value = true
      // 推流结束不再有 WS 帧到达：恢复本地模拟写入（首个 WS PPV 帧曾禁用它），
      // 否则完成后拖动进度条时 PPV 热力图冻结在最后一帧、不跟随时间轴回退。
      getManager()?.setLocalVibrationEnabled(true)
      if (!isPlaying.value) {
        showMessage('预览播放完成', 'success')
      }
    })
    ws.connect()
  }

  const disconnectBlastingWs = () => {
    setPendingWsDataset(null)
    setWsVibrationStarted(false)
    const ws = getWs()
    if (ws) {
      ws.disconnect()
      setWs(null)
    }
    wsConnected.value = false
    // WS 断开：恢复本地热力图模拟
    getManager()?.setLocalVibrationEnabled(true)
  }

  const clearSimulation = () => {
    ctx.playback.pausePlayback()
    disconnectBlastingWs()
    ctx.keyframe.stopPrecomputeWatch()
    setPendingAutoStart(false)
    getManager()?.clearScene()
    dataset.value = null
    currentFrame.value = 0
    ctx.playback.effectiveDurationS.value = null
    replayReady.value = false
    replayPrecompute.value = { active: false, pct: 0 }
    currentEventId.value = null
    // B1：重置回放增强状态
    abLoop.value = { a: null, b: null, enabled: false }
    loadProgress.value = 0
    // 清理场点拾取
    getManager()?.disablePpvPick()
    ctx.vibration.ppvPickEnabled.value = false
    ctx.vibration.pickedPpv.value = null
  }

  // 组件卸载时清理播放定时器，避免内存泄漏
  // 面板收起（组件卸载）时不清除播放定时器，保持动画持续运行
  // blastingManager 为模块级单例，生命周期独立于面板组件
  // onUnmounted(() => {
  //   if (playbackTimer) {
  //     clearInterval(playbackTimer)
  //     playbackTimer = null
  //   }
  // })

  return {
    startBlastingWsStream,
    connectBlastingWs,
    disconnectBlastingWs,
    clearSimulation
  }
}
