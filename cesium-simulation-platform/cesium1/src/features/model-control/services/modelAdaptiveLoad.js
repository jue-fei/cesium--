import { reactive, watch } from 'vue'
import { createFpsMonitor } from '../../lod-optimization/services/fpsMonitor.js'
import {
  createAdaptiveLoadRuntime,
  evaluateAdaptiveLoad,
  getAdaptiveLoadStep
} from '../../lod-optimization/services/adaptiveLoad.js'
import {
  applyLodConfigToTileset,
  getTilesetMemoryUsageBytes
} from '../../lod-optimization/services/lodRuntime.js'
import {
  DEFAULT_LOD_CONFIG,
  DEFAULT_ADAPTIVE_LOAD_CONFIG
} from '../../../config/constants/modelConfig.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'

function createAdaptiveBaseline(lodConfig, displayQuality, terrainQuality) {
  return {
    lodConfig: { ...lodConfig },
    displayQuality,
    terrainQuality
  }
}

function applyTilesetLodConfig(tilesetRef, lodConfig, getViewer) {
  if (!tilesetRef.value) return
  applyLodConfigToTileset(tilesetRef.value, { ...lodConfig.value }, () =>
    getViewer()?.scene?.requestRender()
  )
}

function assignAdaptiveState(adaptiveLoadState, patch) {
  Object.assign(adaptiveLoadState, patch)
}

function buildAdaptiveMetrics(fps, lodRuntime, tilesetRef) {
  return {
    fps: fps.value,
    ...lodRuntime.value,
    totalMemoryUsageInBytes: getTilesetMemoryUsageBytes(tilesetRef.value)
  }
}

function applyRecoveredAdaptiveLevel({
  adaptiveBaseline,
  tilesetRef,
  lodConfig,
  getViewer,
  updateDisplayQuality,
  updateTerrainQuality,
  adaptiveLoadState,
  reasonText
}) {
  lodConfig.value = { ...adaptiveBaseline.lodConfig }
  applyTilesetLodConfig(tilesetRef, lodConfig, getViewer)
  updateDisplayQuality(adaptiveBaseline.displayQuality)
  updateTerrainQuality(adaptiveBaseline.terrainQuality)
  assignAdaptiveState(adaptiveLoadState, {
    level: 0,
    branch: 'standard',
    status: '已恢复',
    appliedStepLabel: '基线',
    lastReason: reasonText || '恢复到基线配置'
  })
}

function applyDegradedAdaptiveLevel({
  level,
  adaptiveBaseline,
  tilesetRef,
  lodConfig,
  getViewer,
  updateDisplayQuality,
  updateTerrainQuality,
  adaptiveLoadState,
  reasonText
}) {
  const step = getAdaptiveLoadStep(DEFAULT_ADAPTIVE_LOAD_CONFIG, level)
  if (!step) return

  lodConfig.value = {
    ...adaptiveBaseline.lodConfig,
    ...(step.lodConfig || {})
  }
  applyTilesetLodConfig(tilesetRef, lodConfig, getViewer)
  updateDisplayQuality(step.displayQuality || adaptiveBaseline.displayQuality)
  updateTerrainQuality(step.terrainQuality || adaptiveBaseline.terrainQuality)
  assignAdaptiveState(adaptiveLoadState, {
    level,
    branch: step.branch || 'standard',
    status: '自动降载中',
    appliedStepLabel: step.label || `等级 ${level}`,
    lastReason: reasonText || step.label || `等级 ${level}`
  })
}

function applyAdaptiveLevel({
  level,
  tilesetRef,
  lodConfig,
  adaptiveBaseline,
  getViewer,
  updateDisplayQuality,
  updateTerrainQuality,
  adaptiveLoadState,
  reasonText
}) {
  if (level <= 0) {
    applyRecoveredAdaptiveLevel({
      adaptiveBaseline,
      tilesetRef,
      lodConfig,
      getViewer,
      updateDisplayQuality,
      updateTerrainQuality,
      adaptiveLoadState,
      reasonText
    })
    return
  }

  applyDegradedAdaptiveLevel({
    level,
    adaptiveBaseline,
    tilesetRef,
    lodConfig,
    getViewer,
    updateDisplayQuality,
    updateTerrainQuality,
    adaptiveLoadState,
    reasonText
  })
}

function handleAdaptiveLoadResult({
  result,
  metrics,
  tilesetRef,
  lodConfig,
  adaptiveBaseline,
  getViewer,
  updateDisplayQuality,
  updateTerrainQuality,
  adaptiveLoadState,
  showOperationMessage
}) {
  if (result.action === 'degrade') {
    const step = getAdaptiveLoadStep(DEFAULT_ADAPTIVE_LOAD_CONFIG, result.nextLevel)
    applyAdaptiveLevel({
      level: result.nextLevel,
      tilesetRef,
      lodConfig,
      adaptiveBaseline,
      getViewer,
      updateDisplayQuality,
      updateTerrainQuality,
      adaptiveLoadState,
      reasonText: step?.label || '自动降载'
    })
    showOperationMessage(
      `检测到低帧率，已执行${step?.label || '自动降载'}（FPS ${metrics.fps}）`,
      'warning'
    )
  }

  if (result.action === 'recover') {
    const reasonText =
      result.nextLevel === 0 ? '帧率恢复，已回到基线配置' : '帧率恢复，已逐级回退降载'
    applyAdaptiveLevel({
      level: result.nextLevel,
      tilesetRef,
      lodConfig,
      adaptiveBaseline,
      getViewer,
      updateDisplayQuality,
      updateTerrainQuality,
      adaptiveLoadState,
      reasonText
    })
    showOperationMessage(reasonText, 'success')
  }
}

/**
 * 自适应降载管理器
 * 负责 FPS 监控、自适应降载评估与执行、LOD 可视化模式
 */
export function createModelAdaptiveLoadManager() {
  const { getViewer, displayQuality, terrainQuality, updateDisplayQuality, updateTerrainQuality } =
    useViewer()
  const { showOperationMessage } = useMessage()

  const fpsMonitor = createFpsMonitor(() => getViewer())
  const fps = fpsMonitor.fps

  const adaptiveLoadState = reactive({
    ...createAdaptiveLoadRuntime(),
    status: '待机',
    appliedStepLabel: '基线'
  })

  let adaptiveLoadStopHandle = null
  let adaptiveBaseline = {
    lodConfig: { ...DEFAULT_LOD_CONFIG },
    displayQuality: 'high',
    terrainQuality: 'high'
  }

  const resetAdaptiveLoadState = () => {
    assignAdaptiveState(adaptiveLoadState, {
      ...createAdaptiveLoadRuntime(),
      status: '待机',
      appliedStepLabel: '基线'
    })
  }

  const syncAdaptiveBaseline = (lodConfig, displayQualityVal, terrainQualityVal) => {
    adaptiveBaseline = createAdaptiveBaseline(lodConfig, displayQualityVal, terrainQualityVal)
  }

  function applyAdaptiveLevelForManager(level, tilesetRef, lodConfig, reasonText) {
    applyAdaptiveLevel({
      level,
      tilesetRef,
      lodConfig,
      adaptiveBaseline,
      getViewer,
      updateDisplayQuality,
      updateTerrainQuality,
      adaptiveLoadState,
      reasonText
    })
  }

  function handleAdaptiveLoadEvaluation(tilesetRef, lodConfig, lodRuntime) {
    if (!DEFAULT_ADAPTIVE_LOAD_CONFIG?.enabled || !tilesetRef.value) return
    if (adaptiveLoadState.level === 0) {
      syncAdaptiveBaseline(lodConfig.value, displayQuality.value, terrainQuality.value)
    }

    const metrics = buildAdaptiveMetrics(fps, lodRuntime, tilesetRef)
    const result = evaluateAdaptiveLoad(
      metrics,
      adaptiveLoadState,
      DEFAULT_ADAPTIVE_LOAD_CONFIG,
      Date.now()
    )

    assignAdaptiveState(adaptiveLoadState, result.nextRuntimePatch)
    handleAdaptiveLoadResult({
      result,
      metrics,
      tilesetRef,
      lodConfig,
      adaptiveBaseline,
      getViewer,
      updateDisplayQuality,
      updateTerrainQuality,
      adaptiveLoadState,
      showOperationMessage
    })
  }

  function startAdaptiveLoadMonitoring(tilesetRef, lodConfig, lodRuntime) {
    if (adaptiveLoadStopHandle || !DEFAULT_ADAPTIVE_LOAD_CONFIG?.enabled) return
    adaptiveLoadState.enabled = true
    syncAdaptiveBaseline(lodConfig.value, displayQuality.value, terrainQuality.value)
    adaptiveLoadStopHandle = watch(fps, () => {
      handleAdaptiveLoadEvaluation(tilesetRef, lodConfig, lodRuntime)
    })
  }

  function stopAdaptiveLoadMonitoring(tilesetRef, lodConfig) {
    if (adaptiveLoadStopHandle) {
      adaptiveLoadStopHandle()
      adaptiveLoadStopHandle = null
    }
    if (adaptiveLoadState.level > 0) {
      applyAdaptiveLevelForManager(0, tilesetRef, lodConfig, '停止自动降载')
    }
    resetAdaptiveLoadState()
    adaptiveLoadState.enabled = false
  }

  function startGlobalFpsMonitoring(tilesetRef, lodConfig, lodRuntime) {
    fpsMonitor.start()
    startAdaptiveLoadMonitoring(tilesetRef, lodConfig, lodRuntime)
  }

  function stopGlobalFpsMonitoring(tilesetRef, lodConfig) {
    stopAdaptiveLoadMonitoring(tilesetRef, lodConfig)
    fpsMonitor.stop()
  }

  return {
    fps,
    adaptiveLoadState,
    fpsMonitor,
    resetAdaptiveLoadState,
    syncAdaptiveBaseline: lodConfigVal =>
      syncAdaptiveBaseline(lodConfigVal, displayQuality.value, terrainQuality.value),
    applyAdaptiveLevel: (level, _reason, tilesetRef, lodConfig, reasonText) =>
      applyAdaptiveLevelForManager(level, tilesetRef, lodConfig, reasonText),
    startGlobalFpsMonitoring,
    stopGlobalFpsMonitoring
  }
}
