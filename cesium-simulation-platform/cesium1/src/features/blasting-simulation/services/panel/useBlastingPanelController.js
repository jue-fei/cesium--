import { computed, ref, onMounted } from 'vue'
import useBlasting from '../useBlasting.js'
import { fetchRenderConfigs } from '../blastingApi.js'

export function useBlastingPanelController() {
  const fileInput = ref(null)
  const activeTab = ref('playback')

  const {
    dataset,
    importStatus,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    summary,
    stressSummary,
    monitorPoints,
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
  } = useBlasting()

  const eventName = computed(() => dataset.value?.event?.name || '-')

  // 选中的渲染配置名称
  const selectedRenderConfig = ref('realistic')

  // 加载渲染配置列表
  const loadRenderConfigs = async () => {
    try {
      const configs = await fetchRenderConfigs()
      renderConfigs.value = configs
    } catch (e) {
      // 忽略错误，使用默认配置
    }
  }

  // 组件挂载时加载事件列表与渲染配置
  onMounted(() => {
    loadDbEvents()
    loadRenderConfigs()
  })

  // 当前帧统计
  const currentStats = computed(() => {
    const frame = dataset.value?.frames?.[currentFrame.value]
    return frame?.stats || null
  })

  // 当前帧应力列表
  const currentStressList = computed(() => {
    return currentStresses.value.map(s => ({
      ...s,
      safetyLabel: _safetyLabel(s.safetyLevel)
    }))
  })

  // 应力汇总表
  const stressSummaryList = computed(() => {
    return stressSummary.value.map(s => ({
      ...s,
      safetyLabel: _safetyLabel(s.safetyLevel)
    }))
  })

  // 选中监测点的应力历史
  const selectedPointHistory = computed(() => {
    if (!selectedMonitorPoint.value || !dataset.value) return []
    const history = []
    for (const frame of dataset.value.frames) {
      const stress = frame.stresses?.find(s => s.pointId === selectedMonitorPoint.value)
      if (stress) history.push(stress)
    }
    return history
  })

  function _safetyLabel(level) {
    const labels = {
      safe: '安全',
      watch: '关注',
      warning: '预警',
      danger: '危险',
      critical: '临界'
    }
    return labels[level] || level
  }

  const onFileChange = async event => {
    const file = event?.target?.files?.[0]
    if (!file) return
    const text = await file.text()
    importFromText(text)
    if (event.target) event.target.value = ''
  }

  // 加载数据库事件
  const onDbEventChange = async eventId => {
    if (!eventId) return
    await loadDbEvent(eventId, {
      autoPlay: true,
      renderConfigName: selectedRenderConfig.value
    })
  }

  // 切换渲染配置
  const onRenderConfigChange = configName => {
    selectedRenderConfig.value = configName
    applyRenderConfig(configName)
  }

  return {
    fileInput,
    activeTab,
    dataset,
    importStatus,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    summary,
    stressSummary,
    stressSummaryList,
    monitorPoints,
    currentStats,
    currentStressList,
    streamStatus,
    streamStatusLabel,
    streamMode,
    wsUrl,
    showHeatmap,
    showMonitorPoints,
    showStressChart,
    selectedMonitorPoint,
    selectedPointHistory,
    eventName,
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
    selectedRenderConfig,
    loadDbEvents,
    loadDbEvent,
    applyRenderConfig,
    flyToCenter,
    onDbEventChange,
    onRenderConfigChange,
    loadExample,
    togglePlayback,
    clearSimulation,
    onFileChange,
    onFrameChange: setFrame,
    onSpeedChange: v => {
      playbackSpeedMs.value = Number(v || 50)
    },
    onStreamModeChange: setStreamMode,
    onWsUrlChange: setWsUrl,
    toggleStream,
    toggleHeatmap,
    toggleMonitorPoints,
    selectMonitorPoint
  }
}
