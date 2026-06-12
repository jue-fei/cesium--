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
import { DEFAULT_LOD_CONFIG, DEFAULT_ADAPTIVE_LOAD_CONFIG } from '../../../config/constants/modelConfig.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'

/**
 * 自适应降载管理器
 * 负责 FPS 监控、自适应降载评估与执行、LOD 可视化模式
 */
export function createModelAdaptiveLoadManager() {
  const { getViewer, displayQuality, terrainQuality, updateDisplayQuality, updateTerrainQuality } = useViewer()
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
    Object.assign(adaptiveLoadState, createAdaptiveLoadRuntime(), {
      status: '待机',
      appliedStepLabel: '基线'
    })
  }

  const syncAdaptiveBaseline = (lodConfig, displayQualityVal, terrainQualityVal) => {
    adaptiveBaseline = {
      lodConfig: { ...lodConfig },
      displayQuality: displayQualityVal,
      terrainQuality: terrainQualityVal
    }
  }

  function applyAdaptiveLevel(level, reason, tilesetRef, lodConfig, reasonText) {
    if (level <= 0) {
      lodConfig.value = { ...adaptiveBaseline.lodConfig }
      if (tilesetRef.value) applyLodConfigToTileset(tilesetRef.value, { ...lodConfig.value }, () => getViewer()?.scene?.requestRender())
      updateDisplayQuality(adaptiveBaseline.displayQuality)
      updateTerrainQuality(adaptiveBaseline.terrainQuality)
      Object.assign(adaptiveLoadState, {
        level: 0,
        branch: 'standard',
        status: '已恢复',
        appliedStepLabel: '基线',
        lastReason: reasonText || '恢复到基线配置'
      })
      return
    }

    const step = getAdaptiveLoadStep(DEFAULT_ADAPTIVE_LOAD_CONFIG, level)
    if (!step) return

    lodConfig.value = {
      ...adaptiveBaseline.lodConfig,
      ...(step.lodConfig || {})
    }
    if (tilesetRef.value) applyLodConfigToTileset(tilesetRef.value, { ...lodConfig.value }, () => getViewer()?.scene?.requestRender())
    updateDisplayQuality(step.displayQuality || adaptiveBaseline.displayQuality)
    updateTerrainQuality(step.terrainQuality || adaptiveBaseline.terrainQuality)

    Object.assign(adaptiveLoadState, {
      level,
      branch: step.branch || 'standard',
      status: '自动降载中',
      appliedStepLabel: step.label || `等级 ${level}`,
      lastReason: reasonText || step.label || `等级 ${level}`
    })
  }

  function handleAdaptiveLoadEvaluation(tilesetRef, lodConfig, lodRuntime) {
    if (!DEFAULT_ADAPTIVE_LOAD_CONFIG?.enabled || !tilesetRef.value) return
    if (adaptiveLoadState.level === 0) {
      syncAdaptiveBaseline(lodConfig.value, displayQuality.value, terrainQuality.value)
    }

    const metrics = {
      fps: fps.value,
      ...lodRuntime.value,
      totalMemoryUsageInBytes: getTilesetMemoryUsageBytes(tilesetRef.value)
    }
    const result = evaluateAdaptiveLoad(
      metrics,
      adaptiveLoadState,
      DEFAULT_ADAPTIVE_LOAD_CONFIG,
      Date.now()
    )

    Object.assign(adaptiveLoadState, result.nextRuntimePatch)

    if (result.action === 'degrade') {
      const step = getAdaptiveLoadStep(DEFAULT_ADAPTIVE_LOAD_CONFIG, result.nextLevel)
      applyAdaptiveLevel(result.nextLevel, step?.label || '自动降载', tilesetRef, lodConfig, step?.label || '自动降载')
      showOperationMessage(
        `检测到低帧率，已执行${step?.label || '自动降载'}（FPS ${metrics.fps}）`,
        'warning'
      )
    }

    if (result.action === 'recover') {
      applyAdaptiveLevel(result.nextLevel, '性能恢复', tilesetRef, lodConfig,
        result.nextLevel === 0 ? '帧率恢复，已回到基线配置' : '帧率恢复，已逐级回退降载')
      showOperationMessage(
        result.nextLevel === 0 ? '帧率恢复，已回到基线配置' : '帧率恢复，已逐级回退降载',
        'success'
      )
    }
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
      applyAdaptiveLevel(0, '停止自动降载', tilesetRef, lodConfig, '停止自动降载')
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
    syncAdaptiveBaseline: (lodConfigVal) => syncAdaptiveBaseline(lodConfigVal, displayQuality.value, terrainQuality.value),
    applyAdaptiveLevel,
    startGlobalFpsMonitoring,
    stopGlobalFpsMonitoring
  }
}