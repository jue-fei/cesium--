import { computed, ref } from 'vue'

// 本地定义默认播放速度（原 blastingDataCore 已移除）
export const DEFAULT_PLAYBACK_SPEED_MS = 50

/**
 * 回放控制域工厂（时间-based 回放 / 倍速 / 循环 / AB 区间 / 预览提示）
 *
 * 从 useBlasting() 拆出的"回放控制"职责区：进度条帧计算、RAF 播放循环、
 * 倍速/整体循环/AB 区间循环、逐帧步进与预览文案。
 *
 * 状态归属：模块级单例（dataset/isPlaying/currentFrame 等）与可变句柄
 * （playbackTimer、_playbackAccumulator 等）仍驻留 useBlasting.js 模块作用域，
 * 经 ctx 显式传入（响应式引用直接共享，let 重绑定句柄经存取器读写）。
 * effectiveDurationS 为本域函数内局部 ref——与拆分前"定义在 useBlasting() 函数内"
 * 的生命周期一致（每次调用 useBlasting() 重建）。
 *
 * 跨域依赖（运行期经 ctx 延迟调用，构造期不得互调）：
 * - ctx.render.threeStats  （previewMode 读取渲染统计的 KCO 来源模式）
 * - ctx.ws.startBlastingWsStream （从第 0 帧开播且 WS 已连接时启动推流）
 * - ctx.vibration.vibrationFieldInfo / contourStats （setFrame 回读场元信息与等值线诊断）
 */
export function createPlaybackParts(ctx) {
  const {
    showMessage,
    dataset,
    isPlaying,
    currentFrame,
    playbackSpeedMs,
    playbackRate,
    isLooping,
    abLoop,
    replayReady,
    replayPrecompute,
    wsConnected,
    wsBackendCompleted,
    statsVersion,
    muckPileOutlineEnabled,
    muckPileMeasure,
    kcoParams,
    getManager,
    getWs,
    getPendingWsDataset,
    setPendingWsDataset,
    getLastWsSeekFrame,
    setLastWsSeekFrame,
    setSeekLockFrame,
    setSeekLockDropped,
    getLastStatsUpdateMs,
    setLastStatsUpdateMs,
    getPendingAutoStart,
    setPendingAutoStart,
    getWsVibrationStarted,
    getPlaybackAccumulator,
    setPlaybackAccumulator,
    getPlaybackLastTime,
    setPlaybackLastTime,
    getPlaybackTimer,
    setPlaybackTimer
  } = ctx

  // ─── 时间-based 回放控制 ─────────────────────────────
  // SubTask 6.6：新数据集不再包含 frames 数组，总帧数由
  // result.simulationDurationS / result.timeStepS 计算。
  // 时长优先取渲染器实测/回放时长（全部碎片落地 + 保持 3s，随事件自适应），
  // 使进度条与每个爆破事件真正绑定：碎片还在抛掷时进度条不会提前到底。
  const effectiveDurationS = ref(null)
  const maxFrame = computed(() => {
    const duration =
      effectiveDurationS.value || Number(dataset.value?.result?.simulationDurationS) || 10
    // 显示帧网格固定 0.05s：与回放关键帧烘焙网格/物理子步长一致
    const dt = 0.05
    return Math.max(0, Math.floor(duration / dt) - 1)
  })

  const previewMode = computed(() => {
    const sourceMode = ctx.render.threeStats.value?.kcoSourceMode || kcoParams.value?.sourceMode
    if (sourceMode === 'result') return '历史结果回放'
    return '参数趋势预览'
  })

  const previewDisclaimer = computed(
    () => '当前板块用于辅助观察参数与效果变化趋势，算法结果为可视化估算，不作为工程定量结论。'
  )

  const setFrame = (frame, isSeek = false) => {
    if (!dataset.value) return
    const clamped = Math.max(0, Math.min(maxFrame.value, Number(frame) || 0))
    currentFrame.value = clamped
    getManager()?.setFrame(clamped)
    // 进度条拖拽/jump（isSeek=true）：后端 WS 推流中时通知其复位游标并重置峰值累积，
    // 否则拖动回看仍顶着"未来帧的峰值"，损伤区自愈失效（seek 污染根因之一）。
    // 播放逐帧递增不设 isSeek，避免每 50ms 向后端刷 seek 造成重算风暴。
    if (isSeek && wsConnected.value && getWsVibrationStarted() && getWs()) {
      if (getLastWsSeekFrame() !== clamped) {
        setLastWsSeekFrame(clamped)
        // 【Seek Lock】加锁 + 清空场纹理：锁住期间丢弃旧游标位置的帧，
        // 纹理清零保证目标帧落地前不显示任何残留（不糊成色块）。
        setSeekLockFrame(clamped)
        setSeekLockDropped(0)
        getManager()?.clearVibrationFieldTextures?.()
        getWs().sendSeek(clamped)
      } else {
        // 同一帧重复拖拽：仍需清屏（纹理可能已被旧游标帧污染）
        getManager()?.clearVibrationFieldTextures?.()
      }
    } else if (isSeek) {
      // 本地模式：同样清屏，由本地模拟器下一 tick 重算填充
      getManager()?.clearVibrationFieldTextures?.()
    }
    // 同步渲染器时长信号（回放就绪/实测达成时进度条随之延长，
    // 与每个事件的实际动画时长绑定：全落地 + 保持 3s）
    const d = getManager()?.getDurationS?.()
    if (d != null && Number.isFinite(d) && d > 0 && d !== effectiveDurationS.value) {
      effectiveDurationS.value = d
    }
    // 始终刷新振动场元信息：无论 WS 是否连接，本地模拟与 WS 数据均通过同一渲染器接口
    // 更新场纹理，UI 需即时反映当前帧的 PPV/应力/损伤就绪状态
    ctx.vibration.vibrationFieldInfo.value = getManager()?.getVibrationFieldInfo?.() || null
    // 等值线提取诊断随元信息一并回读（提取为指纹缓存，常规帧为上次结果）
    ctx.vibration.contourStats.value = getManager()?.getVibrationContourStats?.() ?? null
    // 递增脏标记，使 threeStats 重新求值
    // 节流到 200ms（5Hz），避免高倍速播放时 Vue 响应式风暴阻塞主线程
    const now = performance.now()
    const lastStatsUpdateMs = getLastStatsUpdateMs()
    if (!lastStatsUpdateMs || now - lastStatsUpdateMs >= 200) {
      setLastStatsUpdateMs(now)
      statsVersion.value++
    }
    // 爆堆轮廓开启时逐帧回读安息角/堆高/堆宽/堆长（渲染器节流重建，读不到时为 null）
    if (muckPileOutlineEnabled.value) {
      muckPileMeasure.value = getManager()?.getMuckPileMeasure?.() ?? null
    }
  }

  const pausePlayback = () => {
    const timer = getPlaybackTimer()
    if (timer) {
      cancelAnimationFrame(timer)
      setPlaybackTimer(null)
    }
    setPlaybackAccumulator(0)
    setPlaybackLastTime(0)
    isPlaying.value = false
    setPendingWsDataset(null)
    getWs()?.stopStream?.()
    getManager()?.setLocalVibrationEnabled(true)
  }

  // 根据 playbackRate 计算有效帧间隔（ms），rate 越大间隔越短
  // 不设下限，由 RAF 回调节流自然限制（~60fps ≈ 16.7ms/帧）
  const _effectiveFrameInterval = () => {
    const base = Math.max(16, Number(playbackSpeedMs.value || DEFAULT_PLAYBACK_SPEED_MS))
    const rate = Math.max(1, Number(playbackRate.value) || 1)
    return base / rate
  }

  // B1：播放时计算下一帧（处理 AB 区间循环与整体循环）
  const computeNextFrame = () => {
    const cur = currentFrame.value
    const last = maxFrame.value
    // AB 区间循环优先
    if (abLoop.value.enabled && abLoop.value.a != null && abLoop.value.b != null) {
      const a = Math.min(abLoop.value.a, abLoop.value.b)
      const b = Math.max(abLoop.value.a, abLoop.value.b)
      // 当前位于区间内：到 B 点回到 A 点
      if (cur >= a && cur <= b) {
        return cur >= b ? a : cur + 1
      }
      // 当前位于区间外：跳回 A 点
      if (cur < a) return a
      return a // cur > b
    }
    // 整体循环
    if (cur >= last) {
      return isLooping.value ? 0 : cur
    }
    return cur + 1
  }

  const _playbackTick = timestamp => {
    if (!isPlaying.value || !dataset.value) return
    if (getPlaybackLastTime() === 0) {
      setPlaybackLastTime(timestamp)
      setPlaybackTimer(requestAnimationFrame(_playbackTick))
      return
    }
    const elapsed = timestamp - getPlaybackLastTime()
    setPlaybackLastTime(timestamp)
    setPlaybackAccumulator(getPlaybackAccumulator() + elapsed)

    const interval = _effectiveFrameInterval()
    while (getPlaybackAccumulator() >= interval) {
      setPlaybackAccumulator(getPlaybackAccumulator() - interval)
      const next = computeNextFrame()
      if (next === currentFrame.value && currentFrame.value >= maxFrame.value) {
        // 非循环模式到达末尾：停止
        if (!isLooping.value && !(abLoop.value.enabled && abLoop.value.a != null)) {
          pausePlayback()
          if (wsBackendCompleted.value) {
            showMessage('预览播放完成', 'success')
          }
          return
        }
      }
      setFrame(next)
    }
    setPlaybackTimer(requestAnimationFrame(_playbackTick))
  }

  const startPlayback = () => {
    if (!dataset.value || isPlaying.value) return
    // 全速预计算（关键帧烘焙）未完成：提示并等待，完成后自动开始播放。
    // 这样首次播放即进入关键帧回放——倍速/循环/拖拽/进度条时长全部即时、精确。
    if (!replayReady.value) {
      setPendingAutoStart(true)
      const pct = replayPrecompute.value?.pct ?? 0
      showMessage(
        pct > 0
          ? `爆破物理预计算中（${pct}%），完成后自动播放`
          : '爆破物理预计算中，完成后自动播放',
        'info'
      )
      return
    }
    isPlaying.value = true
    setPlaybackAccumulator(0)
    setPlaybackLastTime(0)
    if (currentFrame.value === 0) {
      setPendingWsDataset(dataset.value)
      if (wsConnected.value) {
        ctx.ws.startBlastingWsStream(dataset.value)
      }
    } else {
      getManager()?.setLocalVibrationEnabled(true)
    }
    setPlaybackTimer(requestAnimationFrame(_playbackTick))
  }

  const togglePlayback = () => {
    if (isPlaying.value) pausePlayback()
    else startPlayback()
  }

  // B1：直接设置播放倍速（下拉选择全部倍数）
  const PLAYBACK_RATES = [1, 2, 4, 8]
  const setPlaybackRate = rate => {
    const r = Number(rate)
    if (!Number.isFinite(r) || r <= 0) return
    playbackRate.value = r
    // RAF 驱动模式下，速度切换后下一帧自然按新 interval 计算，无需重启
    showMessage(`播放倍速 ${r}x`, 'info')
  }

  // B1：逐帧步进（direction: +1 前进 / -1 后退）
  const stepFrame = (direction = 1) => {
    if (!dataset.value) return
    pausePlayback()
    const target = currentFrame.value + (direction > 0 ? 1 : -1)
    setFrame(Math.max(0, Math.min(maxFrame.value, target)))
  }

  // B1：整体循环开关
  const toggleLoop = () => {
    isLooping.value = !isLooping.value
    showMessage(`整体循环已${isLooping.value ? '开启' : '关闭'}`, 'info')
  }

  // B1：标记 AB 区间点（在当前帧打点，第一次标记 A，第二次标记 B）
  const markAbLoopPoint = () => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    const cur = currentFrame.value
    const ab = abLoop.value
    if (ab.a == null) {
      abLoop.value = { ...ab, a: cur, b: null }
      showMessage(`已标记 A 点（帧 ${cur + 1}）`, 'info')
    } else if (ab.b == null) {
      abLoop.value = { ...ab, b: cur, enabled: true }
      showMessage(`已标记 B 点（帧 ${cur + 1}），AB 循环已启用`, 'success')
    } else {
      // 重新开始标记
      abLoop.value = { a: cur, b: null, enabled: false }
      showMessage(`重新标记 A 点（帧 ${cur + 1}）`, 'info')
    }
  }

  // B1：清除 AB 区间
  const clearAbLoop = () => {
    abLoop.value = { a: null, b: null, enabled: false }
    showMessage('AB 区间循环已清除', 'info')
  }

  // B1：切换 AB 循环启用状态
  const toggleAbLoop = () => {
    const ab = abLoop.value
    if (ab.a == null || ab.b == null) {
      showMessage('请先标记 A、B 两点', 'warning')
      return
    }
    abLoop.value = { ...ab, enabled: !ab.enabled }
    showMessage(`AB 循环已${abLoop.value.enabled ? '启用' : '禁用'}`, 'info')
  }

  return {
    effectiveDurationS,
    maxFrame,
    previewMode,
    previewDisclaimer,
    setFrame,
    pausePlayback,
    startPlayback,
    togglePlayback,
    PLAYBACK_RATES,
    setPlaybackRate,
    stepFrame,
    toggleLoop,
    markAbLoopPoint,
    clearAbLoop,
    toggleAbLoop
  }
}
