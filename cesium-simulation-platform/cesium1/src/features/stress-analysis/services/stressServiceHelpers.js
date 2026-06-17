import { computed, watch } from 'vue'
import { HeatmapManager } from './heatmap/HeatmapManager.js'
import { getPointMetricSeriesValues } from './core/data/pointCore.js'
import { resolvePointCenterCartesian } from './core/interpolation/utils.js'
import { sampleGridScalarAt } from './core/interpolation/index.js'
import { createStressSamplingActions } from './core/application/stressSamplingActions.js'
import { createStressHistoryController } from './core/application/stressHistoryController.js'
import { createKnownPointStressOverlayController } from './core/application/knownPointStressOverlayController.js'
import { createStressPlaybackController } from './core/application/stressPlaybackController.js'
import {
  applyHeatmapDisplayToConfigObject,
  buildDefaultStressConfig,
  cloneColorRamp,
  resolveOriginFromModelCenter,
  resolveOriginFromViewer,
  resolveTilesetCenterInfo
} from './core/render/index.js'
import { STRESS_METRIC_LABELS } from './core/computation/index.js'
import {
  buildSafetyAnalysisSummary,
  isSafetyMetric,
  resolveMetricDisplayUnit
} from './core/safety/index.js'
import { buildStressSafetyContext } from './core/safety/projection.js'
import { DEFAULT_STRESS_UNIT } from '../types/stressDefaults.js'

export function createStressComputedState({
  getGridSource,
  stressSource,
  importReport,
  metric,
  config,
  unitStress,
  historyPast,
  historyFuture,
  currentTime,
  safetyContext
}) {
  const isStrainSource = computed(() => getGridSource()?.data?.type === '应变')
  const hasStressSource = computed(() => Boolean(stressSource.value.data))
  const importStatus = computed(() => importReport.value)
  const metricLabel = computed(() => STRESS_METRIC_LABELS[metric.value] || metric.value)
  const metricUnit = computed(() =>
    resolveMetricDisplayUnit(
      metric.value,
      config.value?.field?.data?.unitStress || unitStress.value || ''
    )
  )
  const canUndo = computed(() => historyPast.value.length > 1)
  const canRedo = computed(() => historyFuture.value.length > 0)
  const safetySummary = computed(() =>
    buildSafetyAnalysisSummary(
      stressSource.value.kind,
      stressSource.value.data,
      currentTime.value,
      safetyContext.value
    )
  )
  const sourceKind = computed(() => String(stressSource.value.kind || ''))

  return {
    isStrainSource,
    hasStressSource,
    importStatus,
    metricLabel,
    metricUnit,
    canUndo,
    canRedo,
    safetySummary,
    sourceKind
  }
}

function resolveRenderProgressField(next, prev, key, defaultValue = '') {
  if (next?.[key] !== undefined) {
    return typeof defaultValue === 'boolean'
      ? Boolean(next[key])
      : String(next[key] || defaultValue)
  }
  if (prev?.[key] !== undefined) {
    return typeof defaultValue === 'boolean'
      ? Boolean(prev[key])
      : String(prev[key] || defaultValue)
  }
  return defaultValue
}

export function createRenderProgressController(renderProgress, createIdleRenderProgress) {
  return next => {
    const prev = renderProgress.value || createIdleRenderProgress()
    const active = next?.active !== undefined ? Boolean(next.active) : prev.active
    let rawPercent = Number.isFinite(prev.percent) ? prev.percent : 0
    if (next?.percent !== undefined) rawPercent = Number(next.percent)
    const percent = Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0))
    const text = resolveRenderProgressField(next, prev, 'text')
    const phase = resolveRenderProgressField(next, prev, 'phase', 'idle')
    const requiresConfirm = resolveRenderProgressField(next, prev, 'requiresConfirm', false)
    const fallbackMode = resolveRenderProgressField(next, prev, 'fallbackMode')
    const fallbackReason = resolveRenderProgressField(next, prev, 'fallbackReason')
    renderProgress.value = {
      active,
      percent,
      text,
      phase,
      requiresConfirm,
      fallbackMode,
      fallbackReason
    }
  }
}

export function buildStressState(state) {
  return {
    config: state.config,
    currentTime: state.currentTime,
    maxTime: state.maxTime,
    timeDimension: state.timeDimension,
    isPlaying: state.isPlaying,
    stressSource: state.stressSource,
    pointRenderMode: state.pointRenderMode,
    pointSourceMode: state.pointSourceMode,
    metric: state.metric,
    metricLabel: state.metricLabel,
    directionAzimuth: state.directionAzimuth,
    directionDip: state.directionDip,
    unitStress: state.unitStress,
    materialE: state.materialE,
    materialNu: state.materialNu,
    isStrainSource: state.isStrainSource,
    pickedPoint: state.pickedPoint,
    pickedPointValue: state.pickedPointValue,
    pickedPointDetails: state.pickedPointDetails,
    pickedPointSeries: state.pickedPointSeries,
    importStatus: state.importStatus,
    heatmapDisplay: state.heatmapDisplay,
    knownPointStressVisible: state.knownPointStressVisible,
    renderProgress: state.renderProgress,
    safetyContext: state.safetyContext,
    safetySummary: state.safetySummary,
    sourceKind: state.sourceKind,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    metricUnit: state.metricUnit
  }
}

export function refreshStressSafetyContext({
  stressSource,
  safetyContext,
  geologyStore,
  tileset,
  viewer
}) {
  const sourceKindValue = String(stressSource.value.kind || '')
  const sourceData = stressSource.value.data
  if (!sourceKindValue || !sourceData) {
    safetyContext.value = null
    return null
  }

  const next = buildStressSafetyContext(sourceKindValue, sourceData, {
    boreholes: geologyStore.boreholes,
    tileset: tileset.value,
    viewer: viewer.value,
    resolveOriginFromModelCenter,
    resolveOriginFromViewer
  })
  safetyContext.value = next
  if (sourceData && typeof sourceData === 'object') {
    sourceData.safetyContext = next
  }
  return next
}

export function createStressCoreActions({
  manager,
  tileset,
  config,
  currentTime,
  updateKnownPointStressOverlay,
  stressSource,
  importReport,
  unitStress,
  materialE,
  materialNu,
  cachedScalarFields,
  cachedPointInterpolationFields,
  safetyContext,
  historyPast,
  historyFuture,
  setRenderProgress,
  knownPointStressVisible,
  clearKnownPointStressOverlay,
  samplingActions,
  heatmapBaseRamp,
  heatmapDisplay,
  timeDimension,
  maxTime,
  playbackSpeed,
  geologyStore,
  viewer,
  refreshSafetyContext,
  playback,
  showMessage,
  createIdleRenderProgress
}) {
  const applyToModel = () => {
    if (!manager.value || !tileset.value || !config.value) return
    const updated = manager.value.updateStressConfig?.(tileset.value, config.value)
    if (!updated) manager.value.applyStressConfig(tileset.value, config.value)
    manager.value.updateStressTime(tileset.value, currentTime.value)
    updateKnownPointStressOverlay()
  }

  const clearStressSourceState = () => {
    stressSource.value = { kind: '', data: null }
    importReport.value = null
    unitStress.value = DEFAULT_STRESS_UNIT
    materialE.value = null
    materialNu.value = null
    currentTime.value = 0
    maxTime.value = 0
    cachedScalarFields.clear()
    cachedPointInterpolationFields.clear()
    safetyContext.value = null
    historyPast.value = []
    historyFuture.value = []
    setRenderProgress(createIdleRenderProgress())
    knownPointStressVisible.value = false
    clearKnownPointStressOverlay()
    samplingActions.resetPick()
  }

  const loadConfig = async () => {
    config.value = buildDefaultStressConfig()
    heatmapBaseRamp.value = cloneColorRamp(config.value?.colorRamp)
    heatmapBaseRamp.value = applyHeatmapDisplayToConfigObject(
      config.value,
      heatmapBaseRamp.value,
      heatmapDisplay.value
    ).baseRamp
    timeDimension.value = config.value.time?.dimension || '秒'
    maxTime.value = Math.max(0, (config.value.time?.frames || 1) - 1)
    playbackSpeed.value = config.value.time?.speedMs || 500
    safetyContext.value = null
  }

  const initStressManager = async () => {
    if (!viewer.value) return
    if (!manager.value) manager.value = new HeatmapManager(viewer.value)
    if (!config.value) await loadConfig()
    if (
      tileset.value &&
      manager.value?.stressShaders?.has(tileset.value) &&
      tileset.value.customShader
    ) {
      manager.value.updateStressTime(tileset.value, currentTime.value)
      if (viewer.value?.scene?.requestRender) viewer.value.scene.requestRender()
      return
    }
    applyToModel()
    updateKnownPointStressOverlay()
  }

  const exitStressAnalysis = async () => {
    playback.pause()
    if (manager.value) manager.value.clearAllStress()
    if (manager.value && tileset.value) manager.value.clearStress(tileset.value)
    clearKnownPointStressOverlay()
    clearStressSourceState()
    await loadConfig()
    showMessage('已退出应力分析', 'success')
  }

  const refreshSafety = () =>
    refreshSafetyContext({
      stressSource,
      safetyContext,
      geologyStore,
      tileset,
      viewer
    })

  return {
    applyToModel,
    clearStressSourceState,
    loadConfig,
    initStressManager,
    exitStressAnalysis,
    refreshSafety
  }
}

export function createStressControllers({
  viewer,
  tileset,
  config,
  stressSource,
  metric,
  directionAzimuth,
  directionDip,
  overlayItems,
  pickedPoint,
  pickedPointValue,
  pickedPointDetails,
  pickedPointSeries,
  currentTime,
  maxTime,
  isPlaying,
  playbackSpeed,
  manager,
  unitStress,
  heatmapDisplay,
  knownPointStressVisible,
  playbackRuntime,
  knownPointOverlayRuntime,
  getGridSource,
  getPointSource,
  hasStressSource,
  safetyContext,
  materialE,
  materialNu,
  pointRenderMode,
  pointSourceMode,
  historyPast,
  historyFuture,
  historyApplying,
  metricUnit,
  actionRefs
}) {
  const samplingActions = createStressSamplingActions({
    viewer,
    tileset,
    config,
    stressSource,
    metric,
    directionAzimuth,
    directionDip,
    overlayItems,
    pickedPoint,
    pickedPointValue,
    pickedPointDetails,
    pickedPointSeries,
    currentTime,
    resolveOriginFromModelCenter,
    resolveOriginFromViewer
  })

  const overlay = createKnownPointStressOverlayController({
    viewer,
    tileset,
    config,
    stressSource,
    metric,
    directionAzimuth,
    directionDip,
    overlayItems,
    currentTime,
    metricUnit,
    unitStress,
    heatmapDisplay,
    knownPointStressVisible,
    samplingActions,
    resolveTilesetCenterInfo,
    resolvePointCenterCartesian,
    getPointMetricSeriesValues,
    sampleGridScalarAt,
    runtime: knownPointOverlayRuntime
  })

  const playback = createStressPlaybackController({
    manager,
    tileset,
    currentTime,
    maxTime,
    isPlaying,
    playbackSpeed,
    pickedPoint,
    pickedPointValue,
    pickedPointDetails,
    pickedPointSeries,
    samplingActions,
    updateKnownPointStressOverlay: () => overlay.updateKnownPointStressOverlay(),
    runtime: playbackRuntime
  })

  const history = createStressHistoryController({
    getGridSource,
    getPointSource,
    hasStressSource,
    metric,
    directionAzimuth,
    directionDip,
    currentTime,
    safetyContext,
    heatmapDisplay,
    overlayItems,
    materialE,
    materialNu,
    pointRenderMode,
    pointSourceMode,
    historyPast,
    historyFuture,
    historyApplying,
    rebuildConfig: () => actionRefs.rebuildConfig(),
    applyToModel: () => actionRefs.applyToModel(),
    setTime: timeValue => playback.setTime(timeValue)
  })

  return { samplingActions, overlay, playback, history }
}

export function setupStressWatchers({
  stressSource,
  pointRenderMode,
  pointSourceMode,
  cachedScalarFields,
  cachedPointInterpolationFields,
  metric,
  tileset,
  sourceKind,
  knownPointStressVisible,
  directionAzimuth,
  directionDip,
  metricUnit,
  heatmapDisplay,
  geologyStore,
  safetyContext,
  updateKnownPointStressOverlay,
  refreshSafety,
  dataActions,
  applyToModel
}) {
  watch(
    stressSource,
    next => {
      const pointData = next?.kind === 'points' ? next.data : null
      pointRenderMode.value =
        pointData?.renderMode === 'kriging'
          ? 'kriging'
          : pointData?.renderMode === 'idw'
            ? 'idw'
            : 'points'
      pointSourceMode.value = pointData?.sourceStrategy === 'full' ? 'full' : 'top4'
      refreshSafety()
      updateKnownPointStressOverlay()
    },
    { immediate: true }
  )

  watch(
    () => geologyStore.boreholes,
    () => {
      const prevSignature = String(safetyContext.value?.signature || '')
      const next = refreshSafety()
      if (!next || !stressSource.value.data) return
      if (prevSignature === String(next.signature || '')) return
      cachedScalarFields.clear()
      cachedPointInterpolationFields.clear()
      if (isSafetyMetric(metric.value)) {
        void dataActions.rebuildConfig().then(rebuilt => {
          if (rebuilt !== false) applyToModel()
        })
      }
    },
    { deep: true }
  )

  watch(tileset, async () => {
    if (sourceKind.value !== 'points' && stressSource.value.data?.originMode !== '模型中心') return
    refreshSafety()
    const rebuilt = await dataActions.rebuildConfig()
    if (rebuilt !== false) applyToModel()
  })

  watch(
    [knownPointStressVisible, metric, directionAzimuth, directionDip, metricUnit, heatmapDisplay],
    () => {
      updateKnownPointStressOverlay()
    },
    { immediate: false, deep: true }
  )
}
