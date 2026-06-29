import { computed, ref } from 'vue'
import { BlastingManager } from './blastingManager.js'
import {
  buildExampleBlastingDataset,
  normalizeBlastingDataset,
  DEFAULT_BLASTING_SUMMARY,
  DEFAULT_PLAYBACK_SPEED_MS
} from './core/io/blastingDataCore.js'
import { STREAM_STATUS, STREAM_STATUS_LABELS } from './core/io/blastingStreamConnector.js'
import {
  fetchBlastingEvents,
  fetchBlastingDataset,
  fetchRenderConfig,
  parseRenderConfig
} from './blastingApi.js'
import useMessage from '@/composables/useMessage.js'

let blastingManager = null
let playbackTimer = null

const dataset = ref(null)
const isPlaying = ref(false)
const currentFrame = ref(0)
const playbackSpeedMs = ref(DEFAULT_PLAYBACK_SPEED_MS)
const importStatus = ref(null)
const streamStatus = ref(STREAM_STATUS.IDLE)
const streamMode = ref('local')
const wsUrl = ref('ws://localhost:3003/ws/blasting')
const showHeatmap = ref(true)
const showMonitorPoints = ref(true)
const showStressChart = ref(false)
const selectedMonitorPoint = ref(null)

// MySQL 数据库事件相关状态
const dbEvents = ref([])
const dbLoading = ref(false)
const currentEventId = ref(null)
const renderConfigs = ref([])
const currentRenderConfig = ref(null)

export default function useBlasting() {
  const { showMessage } = useMessage()

  const maxFrame = computed(() => {
    const frameCount = Number(dataset.value?.summary?.frameCount || 0)
    return Math.max(0, frameCount - 1)
  })

  const summary = computed(() => {
    return dataset.value?.summary || DEFAULT_BLASTING_SUMMARY
  })

  const stressSummary = computed(() => dataset.value?.stressSummary || [])

  const monitorPoints = computed(() => dataset.value?.monitorPoints || [])

  const currentFrameData = computed(() => {
    if (!dataset.value) return null
    return dataset.value.frames[currentFrame.value] || null
  })

  const currentStresses = computed(() => {
    return currentFrameData.value?.stresses || []
  })

  const streamStatusLabel = computed(() => {
    return STREAM_STATUS_LABELS[streamStatus.value] || '未知'
  })

  const setFrame = frame => {
    if (!dataset.value) return
    const clamped = Math.max(0, Math.min(maxFrame.value, Number(frame) || 0))
    currentFrame.value = clamped
    blastingManager?.setFrame(clamped)
  }

  const pausePlayback = () => {
    if (playbackTimer) clearInterval(playbackTimer)
    playbackTimer = null
    isPlaying.value = false
  }

  const startPlayback = () => {
    if (!dataset.value || isPlaying.value) return
    isPlaying.value = true
    playbackTimer = setInterval(
      () => {
        const next = currentFrame.value >= maxFrame.value ? 0 : currentFrame.value + 1
        setFrame(next)
      },
      Math.max(16, Number(playbackSpeedMs.value || DEFAULT_PLAYBACK_SPEED_MS))
    )
  }

  const togglePlayback = () => {
    if (isPlaying.value) pausePlayback()
    else startPlayback()
  }

  const clearSimulation = () => {
    pausePlayback()
    stopStream()
    blastingManager?.clearScene()
    dataset.value = null
    currentFrame.value = 0
    importStatus.value = null
    selectedMonitorPoint.value = null
    currentEventId.value = null
  }

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

  const loadExample = () => {
    const example = buildExampleBlastingDataset()
    applyDataset(example, { autoPlay: true })
    importStatus.value = { ok: true, message: '粒子模拟数据已加载' }
    showMessage('爆破粒子模拟已加载', 'success')
  }

  const importFromText = rawText => {
    try {
      const json = JSON.parse(rawText)
      const normalized = normalizeBlastingDataset(json)
      if (!normalized.ok) {
        importStatus.value = { ok: false, message: normalized.message }
        showMessage(normalized.message, 'error')
        return false
      }
      applyDataset(normalized.dataset, { autoPlay: true })
      importStatus.value = { ok: true, message: '数据导入成功，已启动粒子模拟' }
      showMessage('爆破数据导入成功', 'success')
      return true
    } catch (error) {
      importStatus.value = { ok: false, message: '文件解析失败，请确认是合法 JSON' }
      showMessage('文件解析失败，请确认是合法 JSON', 'error')
      return false
    }
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

  const loadDbEvent = async (eventId, options = {}) => {
    const autoPlay = options.autoPlay !== false
    const renderConfigName = options.renderConfigName || 'realistic'
    dbLoading.value = true
    try {
      // 获取完整数据集
      const ds = await fetchBlastingDataset(eventId)
      // 获取渲染配置
      try {
        const cfg = await fetchRenderConfig(renderConfigName)
        currentRenderConfig.value = cfg
        blastingManager?.setRenderConfig(parseRenderConfig(cfg))
      } catch (e) {
        // 使用默认渲染配置
      }
      applyDataset(ds, { autoPlay })
      currentEventId.value = eventId
      importStatus.value = { ok: true, message: `事件 ${eventId} 数据加载成功` }
      showMessage(`爆破事件 ${eventId} 已加载`, 'success')
      return ds
    } catch (error) {
      importStatus.value = { ok: false, message: `加载失败: ${error.message}` }
      showMessage(`加载事件失败: ${error.message}`, 'error')
      return null
    } finally {
      dbLoading.value = false
    }
  }

  const applyRenderConfig = configName => {
    if (!blastingManager) return
    const cfg = renderConfigs.value.find(c => c.config_name === configName)
    if (cfg) {
      blastingManager.setRenderConfig(parseRenderConfig(cfg))
      currentRenderConfig.value = cfg
      // 重新应用数据集以重建场景
      if (dataset.value) {
        blastingManager.setDataset(dataset.value)
        blastingManager.setFrame(currentFrame.value)
      }
    }
  }

  // ─── 实时数据推送 ───────────────────────────────────

  const startStream = () => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    pausePlayback()
    blastingManager?.startStream({
      mode: streamMode.value,
      wsUrl: wsUrl.value,
      frameInterval: Number(playbackSpeedMs.value) || 50
    })

    // 监听流状态
    const checkStatus = setInterval(() => {
      const status = blastingManager?.getStreamStatus()
      streamStatus.value = status || STREAM_STATUS.IDLE
      if (status === STREAM_STATUS.COMPLETE || status === STREAM_STATUS.DISCONNECTED) {
        clearInterval(checkStatus)
      }
    }, 200)

    showMessage('实时数据推送已启动', 'success')
  }

  const stopStream = () => {
    blastingManager?.stopStream()
    streamStatus.value = STREAM_STATUS.IDLE
  }

  const toggleStream = () => {
    if (streamStatus.value === STREAM_STATUS.STREAMING) {
      stopStream()
    } else {
      startStream()
    }
  }

  const setStreamMode = mode => {
    streamMode.value = mode
  }

  const setWsUrl = url => {
    wsUrl.value = url
  }

  // ─── 显示控制 ───────────────────────────────────────

  const toggleHeatmap = () => {
    showHeatmap.value = !showHeatmap.value
    if (!showHeatmap.value) {
      blastingManager?._clearHeatmap()
    } else {
      blastingManager?.setFrame(currentFrame.value)
    }
  }

  const toggleMonitorPoints = () => {
    showMonitorPoints.value = !showMonitorPoints.value
    for (const entity of blastingManager?.monitorEntities || []) {
      entity.show = showMonitorPoints.value
    }
  }

  const selectMonitorPoint = pointId => {
    selectedMonitorPoint.value = pointId
    showStressChart.value = !!pointId
  }

  const initBlastingManager = viewer => {
    if (!blastingManager && viewer) {
      blastingManager = new BlastingManager(viewer)
    }
  }

  const flyToCenter = () => {
    blastingManager?.flyToCenter()
  }

  // 重新触发 three.js 爆破效果
  const replayBlast = () => {
    if (!dataset.value) {
      showMessage('请先加载数据', 'warning')
      return
    }
    blastingManager?.replayBlast()
    // 重播后重新同步图层与设计数据
    syncLayerVisibility()
    showMessage('爆破效果已重播', 'success')
  }

  // 获取 three.js 渲染统计
  const threeStats = computed(() => {
    return blastingManager?.getThreeStats() || null
  })

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
  // 爆破设计数据（炮孔布置图 + 统计）
  const blastDesign = ref(null)

  const setLayerVisible = (layer, visible) => {
    layerVisibility.value[layer] = !!visible
    blastingManager?.setLayerVisible(layer, !!visible)
  }

  // 从渲染器同步当前图层可见性状态（数据加载后调用）
  const syncLayerVisibility = () => {
    const state = blastingManager?.getLayerVisibility?.()
    if (state) {
      layerVisibility.value = { ...layerVisibility.value, ...state }
    }
    blastDesign.value = blastingManager?.getBlastDesign?.() || null
  }

  return {
    dataset,
    importStatus,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    summary,
    stressSummary,
    monitorPoints,
    currentFrameData,
    currentStresses,
    streamStatus,
    streamStatusLabel,
    streamMode,
    wsUrl,
    showHeatmap,
    showMonitorPoints,
    showStressChart,
    selectedMonitorPoint,
    // three.js 渲染
    threeStats,
    replayBlast,
    // 图层可见性与爆破设计
    LAYER_DEFS,
    layerVisibility,
    setLayerVisible,
    syncLayerVisibility,
    blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    renderConfigs,
    currentRenderConfig,
    loadDbEvents,
    loadDbEvent,
    applyRenderConfig,
    flyToCenter,
    initBlastingManager,
    importFromText,
    loadExample,
    setFrame,
    togglePlayback,
    clearSimulation,
    startStream,
    stopStream,
    toggleStream,
    setStreamMode,
    setWsUrl,
    toggleHeatmap,
    toggleMonitorPoints,
    selectMonitorPoint
  }
}
