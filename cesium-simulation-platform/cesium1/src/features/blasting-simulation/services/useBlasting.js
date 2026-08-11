import { computed, ref } from 'vue'
import { BlastingManager } from './blastingManager.js'
import {
  fetchBlastingEvents,
  fetchBlastingEvent,
  fetchBlastingDesign,
  saveBlastingDesign,
  fetchBlastingResult,
  saveBlastingResult,
  saveRuntimeStats,
  fetchRuntimeStats
} from './blastingApi.js'
import { DEFAULT_KCO_PARAMS } from './core/computation/kcoModelCore.js'
import { BlastingWsConnector, FrameType } from './core/realtime/blastingWsConnector.js'
import useMessage from '@/composables/useMessage.js'

// 本地定义默认播放速度（原 blastingDataCore 已移除）
const DEFAULT_PLAYBACK_SPEED_MS = 50

// ─── 统一高性能模式 ───
// 取消双档切换，始终使用高保真模式：开碰撞、无渲染上限
const PERFORMANCE_PROFILE = {
  fragmentCountRenderLimit: Infinity,
  enableInterCollision: true
}

// 算法版本号（用于运行时统计可追溯）
const ALGORITHM_VERSION = 'kco-v2.1'

let blastingManager = null
let playbackTimer = null
let blastingWs = null
// WS 连接状态（供 UI 显示连接指示器）
const wsConnected = ref(false)
// 后端推送完成标志：COMPLETED 帧到达时置 true，
// 与本地播放到达末尾双条件满足后才弹窗"爆破模拟完成"
const wsBackendCompleted = ref(false)

// ─── 响应式状态 ───────────────────────────────────────
const dataset = ref(null)
const isPlaying = ref(false)
const currentFrame = ref(0)
const playbackSpeedMs = ref(DEFAULT_PLAYBACK_SPEED_MS)
// B1 回放增强：播放倍速（1/2/4/8 循环切换）
const playbackRate = ref(1)
// B1 回放增强：整体循环播放开关（默认开启，保持原有循环行为）
const isLooping = ref(true)
// B1 回放增强：AB 区间循环 { a: 起始帧, b: 结束帧, enabled: 是否启用 }
const abLoop = ref({ a: null, b: null, enabled: false })
// B7 加载进度反馈：0-100
const loadProgress = ref(0)

// 诊断脏标记：blastingManager 是模块级 let 变量（非响应式），
// threeStats computed 需要读取此 ref 才能在 setDataset / replayBlast /
// 播放逐帧后重新求值，否则首次缓存后永久冻结，诊断面板不更新。
const statsVersion = ref(0)

// MySQL 数据库事件相关状态
const dbEvents = ref([])
const dbLoading = ref(false)
const currentEventId = ref(null)

// KCO 模型参数（碎块尺寸分布）
const kcoParams = ref({ ...DEFAULT_KCO_PARAMS, sourceMode: 'design' })

function toFiniteNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function computeRelativeError(actual, target) {
  if (!Number.isFinite(actual) || !Number.isFinite(target) || Math.abs(target) < 1e-6) return null
  return Math.abs(actual - target) / Math.abs(target)
}

function computeSignedPercent(actual, target) {
  const relativeError = computeRelativeError(actual, target)
  if (relativeError == null) return null
  return ((actual - target) / target) * 100
}

function buildMetricStatus(relativeError, okThreshold, warnThreshold) {
  if (relativeError == null) return 'neutral'
  if (relativeError <= okThreshold) return 'ok'
  if (relativeError <= warnThreshold) return 'warning'
  return 'error'
}

function buildDiagnosticMetric({
  label,
  unit = '',
  target = null,
  actual = null,
  okThreshold = 0.1,
  warnThreshold = 0.2
}) {
  const relativeError = computeRelativeError(actual, target)
  return {
    label,
    unit,
    target,
    actual,
    deltaPercent: computeSignedPercent(actual, target),
    status: buildMetricStatus(relativeError, okThreshold, warnThreshold)
  }
}

function summarizeDiagnostics(sections) {
  const counts = { ok: 0, warning: 0, error: 0, neutral: 0 }
  for (const section of sections) {
    for (const metric of section.metrics) {
      counts[metric.status] = (counts[metric.status] || 0) + 1
    }
  }

  const issueCount = counts.warning + counts.error
  const overallStatus = counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'ok'
  const summaryText =
    overallStatus === 'error'
      ? `发现 ${counts.error} 项高风险偏差，建议优先修正。`
      : overallStatus === 'warning'
        ? `发现 ${issueCount} 项待收敛偏差，整体口径已初步闭合。`
        : '当前关键指标已落在预设阈值内。'

  return { counts, issueCount, overallStatus, summaryText }
}

export default function useBlasting() {
  const { showMessage } = useMessage()

  // 运行时统计可追溯的随机种子（当前渲染器未注入种子，仅作为本次运行的种子标识供未来复现）
  const randomSeed = ref(42 + Math.floor(Math.random() * 1000))

  // ─── 时间-based 回放控制 ─────────────────────────────
  // SubTask 6.6：新数据集不再包含 frames 数组，总帧数由
  // result.simulationDurationS / result.timeStepS 计算
  const maxFrame = computed(() => {
    const duration = Number(dataset.value?.result?.simulationDurationS) || 10
    const dt = Number(dataset.value?.result?.timeStepS) || 0.05
    return Math.max(0, Math.floor(duration / dt) - 1)
  })

  const setFrame = frame => {
    if (!dataset.value) return
    const clamped = Math.max(0, Math.min(maxFrame.value, Number(frame) || 0))
    currentFrame.value = clamped
    blastingManager?.setFrame(clamped)
    // 递增脏标记，使 threeStats / consistencyDiagnostics 重新求值
    // 播放过程中能量曲线、堆积质量比才能实时刷新
    statsVersion.value++
  }

  const pausePlayback = () => {
    if (playbackTimer) clearInterval(playbackTimer)
    playbackTimer = null
    isPlaying.value = false
  }

  // B1：根据 playbackRate 计算实际播放间隔（rate 越大间隔越短）
  const computePlaybackInterval = () => {
    const base = Math.max(16, Number(playbackSpeedMs.value || DEFAULT_PLAYBACK_SPEED_MS))
    const rate = Math.max(1, Number(playbackRate.value) || 1)
    return Math.max(16, base / rate)
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

  const startPlayback = () => {
    if (!dataset.value || isPlaying.value) return
    isPlaying.value = true
    playbackTimer = setInterval(() => {
      const next = computeNextFrame()
      // 非循环模式到达末尾：停止
      if (
        next === currentFrame.value &&
        currentFrame.value >= maxFrame.value &&
        !isLooping.value &&
        !(abLoop.value.enabled && abLoop.value.a != null)
      ) {
        pausePlayback()
        // 本地动画播放完成：若后端也已推送完成，弹窗"爆破模拟完成"
        if (wsBackendCompleted.value) {
          showMessage('爆破模拟完成', 'success')
        }
        return
      }
      setFrame(next)
    }, computePlaybackInterval())
  }

  const togglePlayback = () => {
    if (isPlaying.value) pausePlayback()
    else startPlayback()
  }

  // B1：倍速循环切换 1→2→4→8→1
  const cyclePlaybackRate = () => {
    const rates = [1, 2, 4, 8]
    const idx = rates.indexOf(Number(playbackRate.value) || 1)
    playbackRate.value = rates[(idx + 1) % rates.length]
    // 若正在播放，以新倍速重启定时器
    if (isPlaying.value) {
      pausePlayback()
      startPlayback()
    }
    showMessage(`播放倍速 ${playbackRate.value}x`, 'info')
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

  // ─── 实时推送通道（WebSocket） ──────────────────────
  // 建立与后端的实时连接，接收模拟进度帧与分段起爆事件。
  // 降级策略：WS 不可用或断开时，本地 setInterval 播放不受影响。
  const connectBlastingWs = (eventId, ds) => {
    disconnectBlastingWs()
    blastingWs = new BlastingWsConnector(eventId)
    blastingWs.on('_open', () => {
      wsConnected.value = true
      wsBackendCompleted.value = false
      // 连接建立后发送 start 指令，携带模拟参数与炮孔列表
      const duration = Number(ds?.result?.simulationDurationS) || 10
      const timestep = Number(ds?.result?.timeStepS) || 0.05
      const holes = (ds?.design?.holes || []).map(h => ({
        id: h.id,
        delayMs: h.delayMs,
        detonatorSeries: h.detonatorSeries,
        chargeKg: h.chargeKg
      }))
      // PPV 振动场计算参数（装药量/隧道断面），驱动后端萨道夫斯基场正演
      const ppvParams = blastingManager?.getPpvStreamParams?.() || {}
      blastingWs.startStream(duration, timestep, holes, ppvParams)
    })
    blastingWs.on('_close', () => {
      wsConnected.value = false
    })
    blastingWs.on('_giveup', () => {
      wsConnected.value = false
      showMessage('实时连接断开，已切换到本地播放', 'warning')
    })
    blastingWs.on(FrameType.PROGRESS, () => {
      // 不驱动 setFrame：本地播放定时器（startPlayback）已增量推进碎片动画，
      // PROGRESS 帧的 setFrame 会与本地播放冲突——偏差 > 10 帧时 seekTo
      // 触发异步重建粒子系统，碎片 InstancedMesh 在重建期间不更新，
      // 导致动画卡顿、帧跳转、轨迹不连贯。
      // WebSocket 仅负责推送振动场/应力/损伤数据，碎片动画由本地播放独立驱动。
    })
    // PPV 振动场二进制帧：首帧初始化体积，后续帧更新 Data3DTexture
    blastingWs.on(FrameType.PPV_FIELD, payload => {
      if (!blastingManager) return
      const { frame, t, gridShape, boundsMin, boundsMax, ppv } = payload
      if (!blastingManager.hasVibrationField()) {
        blastingManager.initVibrationField({ gridShape, boundsMin, boundsMax })
      }
      blastingManager.updateVibrationField(ppv, t, frame)
    })
    // σ_vm 应力场二进制帧：与 PPV 同时刻推送，更新应力纹理
    blastingWs.on(FrameType.STRESS_FIELD, payload => {
      if (!blastingManager) return
      const { frame, t, gridShape, boundsMin, boundsMax, sigmaVm } = payload
      if (!blastingManager.hasVibrationField()) {
        blastingManager.initVibrationField({ gridShape, boundsMin, boundsMax })
      }
      blastingManager.updateStressField(sigmaVm, t, frame)
    })
    // 损伤分区二进制帧：与 PPV 同时刻推送，更新损伤纹理
    blastingWs.on(FrameType.DAMAGE_FIELD, payload => {
      if (!blastingManager) return
      const { frame, t, gridShape, boundsMin, boundsMax, zones } = payload
      if (!blastingManager.hasVibrationField()) {
        blastingManager.initVibrationField({ gridShape, boundsMin, boundsMax })
      }
      blastingManager.updateDamageField(zones, t, frame)
      // 三帧（PPV→stress→damage）已全部到达，刷新振动场元信息供 UI
      vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
    })
    blastingWs.on(FrameType.COMPLETED, () => {
      // 后端推送完成 ≠ 本地动画播放完成。
      // 设置标志，等本地播放到达最后一帧时才弹窗（双条件同步）。
      // 若本地播放已停止（本地快于后端），直接弹窗。
      wsBackendCompleted.value = true
      if (!isPlaying.value) {
        showMessage('爆破模拟完成', 'success')
      }
    })
    blastingWs.connect()
  }

  const disconnectBlastingWs = () => {
    if (blastingWs) {
      blastingWs.disconnect()
      blastingWs = null
    }
    wsConnected.value = false
  }

  const clearSimulation = () => {
    pausePlayback()
    disconnectBlastingWs()
    blastingManager?.clearScene()
    dataset.value = null
    currentFrame.value = 0
    currentEventId.value = null
    // B1：重置回放增强状态
    abLoop.value = { a: null, b: null, enabled: false }
    loadProgress.value = 0
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

  // ─── 数据集应用 ─────────────────────────────────────
  const applyDataset = (nextDataset, options = {}) => {
    const autoPlay = Boolean(options?.autoPlay)
    pausePlayback()
    dataset.value = nextDataset
    currentFrame.value = 0
    blastingManager?.setDataset(nextDataset)
    blastingManager?.setFrame(0)
    // 数据加载后同步图层可见性与爆破设计数据
    syncLayerVisibility()
    if (autoPlay) startPlayback()
  }

  // ─── MySQL 数据库事件加载 ───────────────────────────

  const loadDbEvents = async () => {
    dbLoading.value = true
    try {
      const events = await fetchBlastingEvents()
      dbEvents.value = events
      return events
    } catch (error) {
      showMessage(`加载事件列表失败: ${error.message}`, 'error')
      dbEvents.value = []
      return []
    } finally {
      dbLoading.value = false
    }
  }

  // SubTask 6.1：重写 loadDbEvent
  // 数据流：fetchBlastingEvent → fetchBlastingDesign + fetchBlastingResult
  //        → 组装 {event, design, result} → BlastingManager.setDataset
  const loadDbEvent = async (eventId, options = {}) => {
    const autoPlay = options.autoPlay !== false
    dbLoading.value = true
    // B7：加载进度反馈
    loadProgress.value = 10
    try {
      // 1. 获取事件（fetchBlastingEvent 返回 { event, design, result }，取 event 字段）
      const eventData = await fetchBlastingEvent(eventId)
      const event = eventData?.event || eventData
      loadProgress.value = 30
      // 2. 获取爆破设计 + 炮孔列表
      const { design, holes } = await fetchBlastingDesign(eventId)
      loadProgress.value = 60
      // 3. 获取爆破结果（新事件可能尚无结果，容错处理）
      let result = null
      try {
        result = await fetchBlastingResult(eventId)
      } catch (e) {
        // result 可能尚未生成（新建事件），置为 null 即可
        result = null
      }
      loadProgress.value = 80
      // 4. 组装数据集
      const nextDataset = {
        event,
        design: { ...design, holes: holes || [] },
        result
      }
      // 5. SubTask 6.3：从 design + result 提取 KCO 参数（不再单独 fetchKCOParams）
      if (result) {
        kcoParams.value = {
          ...DEFAULT_KCO_PARAMS,
          Q: Number(event.chargeKg || 100),
          xmax: result.fragmentXmax ?? 2.0,
          x50: result.fragmentX50 ?? 0.5,
          b: result.fragmentB ?? 2.0,
          n: result.fragmentN ?? 1.5,
          sourceMode: 'result'
        }
      }
      applyDataset(nextDataset, { autoPlay })
      currentEventId.value = eventId
      // 建立实时推送通道（WS 不可用时降级到本地 setInterval 播放）
      connectBlastingWs(eventId, nextDataset)
      loadProgress.value = 100
      showMessage(`爆破事件 ${eventId} 已加载`, 'success')
      return nextDataset
    } catch (error) {
      loadProgress.value = 0
      showMessage(`加载事件失败: ${error.message}`, 'error')
      return null
    } finally {
      dbLoading.value = false
    }
  }

  // SubTask 6.7：保存模拟结果回写到数据库
  // 设计结果写入 blasting_result，运行时统计写入 blasting_runtime_stats
  const saveSimulationResult = async () => {
    if (!currentEventId.value || !dataset.value?.result) {
      showMessage('无可保存的模拟结果', 'warning')
      return
    }
    // 获取 three.js 运行时统计
    const stats = blastingManager?.getThreeStats?.() || {}

    // 步骤1：设计结果字段写入 blasting_result
    // 保留现有 dataset.result 字段（fragmentX50/N/xmax/b、throwDistance、crater 等）
    const resultData = {
      ...dataset.value.result,
      // 仅在算法侧未提供 fragmentCount 时兜底使用生成数，避免用渲染统计污染设计结果语义。
      ...(stats &&
        typeof stats.fragmentCountGenerated === 'number' &&
        !Number.isFinite(Number(dataset.value.result?.fragmentCount))
        ? { fragmentCount: stats.fragmentCountGenerated }
        : {})
    }
    // 新增：数量细分字段
    if (stats.fragmentCountTarget != null)
      resultData.fragmentCountTarget = stats.fragmentCountTarget
    if (stats.fragmentCountGenerated != null)
      resultData.fragmentCountGenerated = stats.fragmentCountGenerated
    if (stats.fragmentCountRendered != null)
      resultData.fragmentCountRendered = stats.fragmentCountRendered
    // 新增：质量字段
    if (stats.fragmentMassTargetKg != null)
      resultData.fragmentMassTargetKg = stats.fragmentMassTargetKg
    if (stats.fragmentMassGeneratedKg != null)
      resultData.fragmentMassGeneratedKg = stats.fragmentMassGeneratedKg
    // 新增：直方图 JSON 字段
    if (stats.sizeHistogramGenerated)
      resultData.fragmentHistogramJson = stats.sizeHistogramGenerated
    if (stats.velocityHistogramGenerated)
      resultData.velocityHistogramJson = stats.velocityHistogramGenerated
    if (stats.renderScaleMode) resultData.renderScaleMode = stats.renderScaleMode

    try {
      await saveBlastingResult(currentEventId.value, resultData)
    } catch (e) {
      console.error('[saveSimulationResult] 保存设计结果失败:', e)
      showMessage(`保存设计结果失败: ${e.message}`, 'error')
    }

    // 步骤2：运行时统计写入 blasting_runtime_stats
    const runtimePayload = {
      randomSeed: randomSeed.value,
      algorithmVersion: ALGORITHM_VERSION,
      paramsSnapshot: {
        // 核心输入参数快照
        chargeKg: stats.chargeKg || null,
        x50: stats.x50Applied || null,
        n: stats.nApplied || null,
        kcoSourceMode: stats.kcoSourceMode || null
      },
      statsSnapshot: {
        fragmentCountGenerated: stats.fragmentCountGenerated || null,
        fragmentCountRendered: stats.fragmentCountRendered || null,
        fragmentMassCoverage: stats.fragmentMassCoverage || null,
        velocityMean: stats.velocityMean || null,
        velocityP95: stats.velocityP95 || null,
        throwDistancePredictedAvg: stats.throwDistancePredictedAvg || null,
        throwDistancePredictedMax: stats.throwDistancePredictedMax || null,
        sizeKLDivergence: stats.sizeKLDivergence || null,
        energyStats: stats.energyStats || null,
        sizeHistogramGenerated: stats.sizeHistogramGenerated || null,
        velocityHistogramGenerated: stats.velocityHistogramGenerated || null
      }
    }

    try {
      await saveRuntimeStats(currentEventId.value, runtimePayload)
      showMessage('模拟结果已保存', 'success')
    } catch (e) {
      console.error('[saveSimulationResult] 保存运行时统计失败:', e)
      showMessage(`保存运行时统计失败: ${e.message}`, 'error')
    }
  }

  // 保存爆破设计到数据库，并自动重新加载事件以同步前端状态
  // designPayload: { design: {...}, holes: [...] }（camelCase）
  const saveDesign = async designPayload => {
    if (!currentEventId.value) {
      showMessage('未选中事件，无法保存设计', 'warning')
      return
    }
    try {
      await saveBlastingDesign(currentEventId.value, designPayload)
      showMessage('爆破设计已保存，正在重新加载...', 'success')
      // 保存成功后自动重载事件，使前端状态与 DB 一致
      await loadDbEvent(currentEventId.value, { autoPlay: false })
    } catch (error) {
      showMessage(`保存设计失败: ${error.message}`, 'error')
    }
  }

  // ─── Three.js 渲染管理 ─────────────────────────────

  const initBlastingManager = viewer => {
    if (!blastingManager && viewer) {
      blastingManager = new BlastingManager(viewer)
    }
  }

  const flyToCenter = () => {
    blastingManager?.flyToCenter()
  }

  // 重新触发 three.js 爆破效果
  // kcoOverride：可选，外部传入的 KCO 参数覆盖（用于 UI 实时编辑后重播）
  const replayBlast = kcoOverride => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    // 不强制 sourceMode='design'：保持与初次加载一致（'result'），
    // 避免重新播放时 KCO 参数计算方式不同导致动画不一致。
    // 只有用户在 UI 中修改了 KCO 参数时，_initThreeBridge 才会自动切到 'design'。
    const merged = {
      ...kcoParams.value,
      ...(kcoOverride || {}),
      fragmentCountRenderLimit: PERFORMANCE_PROFILE.fragmentCountRenderLimit,
      enableInterCollision: PERFORMANCE_PROFILE.enableInterCollision,
      randomSeed: randomSeed.value
    }
    blastingManager?.replayBlast(merged)
    // 递增脏标记，使 threeStats / consistencyDiagnostics 读取到新的 _fragmentStats
    statsVersion.value++
    // 重播后重新同步图层与设计数据
    syncLayerVisibility()

    // 完整重置播放状态：重置帧号 + 重置完成标志 + 重启播放
    // 不重连 WS：重连后端会重新推送振动场帧，与碎片动画 GPU 负载叠加导致卡顿。
    // 振动场数据在重新加载事件（loadDbEvent）时自动推送。
    wsBackendCompleted.value = false
    currentFrame.value = 0
    pausePlayback()
    startPlayback()

    showMessage('爆破效果已重播（KCO 模型）', 'success')
  }

  // 获取 three.js 渲染统计
  // 读取 statsVersion 建立响应式依赖，使 setFrame / replayBlast 后能自动刷新
  const threeStats = computed(() => {
    statsVersion.value // 建立响应式依赖
    return blastingManager?.getThreeStats() || null
  })

  // 块度分布统计（按 physSize 分组）：依赖 statsVersion 以便 replayBlast 后刷新
  const fragmentDistribution = computed(() => {
    statsVersion.value // 建立响应式依赖
    return blastingManager?.getFragmentDistribution?.() || null
  })

  // 高亮指定块度范围的碎片
  const highlightFragmentsBySize = (minSize, maxSize) => {
    blastingManager?.highlightFragmentsBySize?.(minSize, maxSize)
  }

  // 清除碎片高亮，恢复原始颜色
  const clearFragmentHighlight = () => {
    blastingManager?.clearFragmentHighlight?.()
  }

  const consistencyDiagnostics = computed(() => {
    if (!dataset.value || !threeStats.value) return null

    const result = dataset.value.result || {}
    const stats = threeStats.value

    const sectionKco = {
      title: '块度口径',
      description: `当前采用${stats.kcoSourceMode === 'result' ? '结果驱动' : '设计驱动'}。`,
      metrics: [
        buildDiagnosticMetric({
          label: 'x50',
          unit: 'm',
          target: toFiniteNumber(result.fragmentX50),
          actual: toFiniteNumber(stats.x50Applied),
          okThreshold: 0.1,
          warnThreshold: 0.2
        }),
        buildDiagnosticMetric({
          label: 'n',
          target: toFiniteNumber(result.fragmentN),
          actual: toFiniteNumber(stats.nApplied),
          okThreshold: 0.08,
          warnThreshold: 0.15
        })
      ]
    }

    const sectionCount = {
      title: '数量闭合',
      description: '目标数、生成数、渲染数应尽量一致。',
      metrics: [
        buildDiagnosticMetric({
          label: '生成碎石数',
          target: toFiniteNumber(stats.fragmentCountTarget),
          actual: toFiniteNumber(stats.fragmentCountGenerated),
          okThreshold: 0.05,
          warnThreshold: 0.12
        }),
        buildDiagnosticMetric({
          label: '渲染碎石数',
          target: toFiniteNumber(stats.fragmentCountGenerated),
          actual: toFiniteNumber(stats.fragmentCountRendered),
          okThreshold: 0.0,
          warnThreshold: 0.02
        })
      ]
    }

    const sectionMass = {
      title: '质量闭合',
      description: '可见抛掷质量用于约束碎石数与总体量级。',
      metrics: [
        buildDiagnosticMetric({
          label: '可见质量',
          unit: 'kg',
          target: toFiniteNumber(stats.fragmentMassTargetKg),
          actual: toFiniteNumber(stats.fragmentMassGeneratedKg),
          okThreshold: 0.1,
          warnThreshold: 0.2
        })
      ]
    }

    const sectionThrow = {
      title: '抛距闭合',
      description: '速度场应尽量贴合目标平均/最大抛掷距离。',
      metrics: [
        buildDiagnosticMetric({
          label: '平均抛距',
          unit: 'm',
          target: toFiniteNumber(stats.throwDistanceTargetAvg),
          actual: toFiniteNumber(stats.throwDistancePredictedAvg),
          okThreshold: 0.1,
          warnThreshold: 0.18
        }),
        buildDiagnosticMetric({
          label: '最大抛距',
          unit: 'm',
          target: toFiniteNumber(stats.throwDistanceTargetMax),
          actual: toFiniteNumber(stats.throwDistancePredictedMax),
          okThreshold: 0.1,
          warnThreshold: 0.18
        })
      ]
    }

    const klValue = toFiniteNumber(stats.sizeKLDivergence)
    const klStatus =
      klValue == null ? 'neutral' : klValue <= 0.1 ? 'ok' : klValue <= 0.3 ? 'warning' : 'error'
    const sectionDistribution = {
      title: '分布闭合',
      description: '块度分布 KL 散度衡量实际采样与 Swebrec 理论分布的形态差异。',
      metrics: [
        {
          label: '块度 KL 散度',
          unit: '',
          target: 0,
          actual: klValue,
          deltaPercent: null,
          status: klStatus
        }
      ]
    }

    // ─── 能量与堆积区块 ───
    const energyStats = stats.energyStats || null
    const settledRatio = toFiniteNumber(energyStats?.settledMassRatio)
    const settledStatus =
      settledRatio == null
        ? 'neutral'
        : settledRatio >= 0.9
          ? 'ok'
          : settledRatio >= 0.75
            ? 'warning'
            : 'error'
    const sectionEnergy = {
      title: '能量与堆积',
      description: '总动能衰减反映抛掷过程能量耗散；堆积质量比衡量碎片落地完整性。',
      metrics: [
        {
          label: '堆积质量比',
          unit: '',
          target: 1.0,
          actual: settledRatio,
          deltaPercent: null,
          status: settledStatus
        }
      ]
    }

    const sections = [
      sectionKco,
      sectionCount,
      sectionMass,
      sectionThrow,
      sectionDistribution,
      sectionEnergy
    ]
      .map(section => ({
        ...section,
        metrics: section.metrics.filter(metric => metric.target != null && metric.actual != null)
      }))
      .filter(section => section.metrics.length > 0)

    if (!sections.length) return null

    const summary = summarizeDiagnostics(sections)
    const findings = []

    for (const section of sections) {
      for (const metric of section.metrics) {
        if (metric.status === 'warning' || metric.status === 'error') {
          const deltaText =
            metric.deltaPercent == null
              ? ''
              : `${metric.deltaPercent > 0 ? '+' : ''}${metric.deltaPercent.toFixed(1)}%`
          findings.push(`${section.title}·${metric.label} 偏差 ${deltaText}`)
        }
      }
    }

    return {
      summary,
      sections,
      findings,
      stats: {
        kcoSourceMode: stats.kcoSourceMode,
        velocityMean: toFiniteNumber(stats.velocityMean),
        velocityP95: toFiniteNumber(stats.velocityP95),
        velocityScaleApplied: toFiniteNumber(stats.velocityScaleApplied),
        fragmentMassCoverage: toFiniteNumber(stats.fragmentMassCoverage),
        sizeHistogramGenerated: stats.sizeHistogramGenerated || null,
        sizeHistogramTarget: stats.sizeHistogramTarget || null,
        sizeKLDivergence: klValue,
        velocityHistogramGenerated: stats.velocityHistogramGenerated || null,
        energyStats: energyStats || null,
        energyTimeSeries: energyStats?.timeSeries || null
      }
    }
  })

  // 重置 KCO 参数为默认值
  const resetKcoParams = () => {
    kcoParams.value = { ...DEFAULT_KCO_PARAMS, sourceMode: 'design' }
    showMessage('KCO 参数已重置为默认值', 'info')
  }

  // ─── 图层可见性控制（烟雾/碎石/隧道/钻孔/标注等） ─────
  // 图层定义：key → 中文标签，用于 UI 显示
  const LAYER_DEFS = [
    { key: 'smoke', label: '烟雾' },
    { key: 'dust', label: '粉尘' },
    { key: 'fragment', label: '碎石' },
    { key: 'fire', label: '火球' },
    { key: 'spark', label: '火花' },
    { key: 'shock_wave', label: '冲击波' },
    { key: 'tunnel', label: '隧道内壁' },
    { key: 'bench', label: '岩体' },
    { key: 'face', label: '掌子面' },
    { key: 'blastHoles', label: '爆破钻孔' },
    { key: 'annotations', label: '专业标注' }
  ]
  // 各图层开关状态（与渲染器 layerVisibility 同步）
  const layerVisibility = ref(
    LAYER_DEFS.reduce((acc, def) => {
      acc[def.key] = true
      return acc
    }, {})
  )

  // ─── 振动场显示模式（PPV/应力/损伤 三模式切换）──────────────────
  // 与 blastVibrationFieldRenderer.DISPLAY_MODE 对应（字符串形式便于 UI）
  const VIBRATION_MODES = [
    { key: 'ppv', label: 'PPV 振动', unit: 'cm/s' },
    { key: 'stress', label: 'σ_vm 应力', unit: 'MPa' },
    { key: 'damage', label: '损伤分区', unit: '' }
  ]
  const vibrationDisplayMode = ref('ppv')
  // 振动场元信息（gridShape/各场就绪状态/当前时间帧，由 WS 帧处理器刷新）
  const vibrationFieldInfo = ref(null)

  const setVibrationDisplayMode = mode => {
    if (!VIBRATION_MODES.some(m => m.key === mode)) return
    vibrationDisplayMode.value = mode
    blastingManager?.setVibrationDisplayMode(mode)
    // 切换后立即刷新一次元信息（hasField 依赖当前模式）
    vibrationFieldInfo.value = blastingManager?.getVibrationFieldInfo?.() || null
  }
  // 爆破设计数据（炮孔布置图 + 统计）
  const blastDesign = ref(null)

  const setLayerVisible = (layer, visible) => {
    layerVisibility.value[layer] = !!visible
    blastingManager?.setLayerVisible(layer, !!visible)
  }

  // 运行时更新断面参数 + cutPattern，并自动重播以重建布孔
  const updateSection = (payload) => {
    blastingManager?.updateSection(payload)
    replayBlast()
  }

  // 将 Vue 的图层可见性状态推送到渲染器（数据加载后调用，保持用户设置不被覆盖）
  const syncLayerVisibility = () => {
    // 推送当前 Vue 状态到渲染器，而非从渲染器回读
    const current = { ...layerVisibility.value }
    if (blastingManager) {
      blastingManager.setLayersVisible(current)
    }
    blastDesign.value = blastingManager?.getBlastDesign?.() || null
  }

  return {
    dataset,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    // B1 回放增强
    playbackRate,
    isLooping,
    abLoop,
    cyclePlaybackRate,
    stepFrame,
    toggleLoop,
    markAbLoopPoint,
    clearAbLoop,
    toggleAbLoop,
    // B7 加载进度
    loadProgress,
    // 实时推送连接状态
    wsConnected,
    // three.js 渲染
    threeStats,
    consistencyDiagnostics,
    replayBlast,
    // 块度分布与高亮
    fragmentDistribution,
    highlightFragmentsBySize,
    clearFragmentHighlight,
    // KCO 模型参数（碎块尺寸分布）
    kcoParams,
    resetKcoParams,
    // 图层可见性与爆破设计
    LAYER_DEFS,
    layerVisibility,
    setLayerVisible,
    updateSection,
    syncLayerVisibility,
    // 振动场显示模式（PPV/应力/损伤）
    VIBRATION_MODES,
    vibrationDisplayMode,
    vibrationFieldInfo,
    setVibrationDisplayMode,
    blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    loadDbEvents,
    loadDbEvent,
    // SubTask 6.7：模拟结果保存
    saveSimulationResult,
    // 运行时统计随机种子（供 UI 展示或编辑）
    randomSeed,
    // 保存爆破设计（保存后自动重载）
    saveDesign,
    flyToCenter,
    initBlastingManager,
    setFrame,
    togglePlayback,
    clearSimulation
  }
}
