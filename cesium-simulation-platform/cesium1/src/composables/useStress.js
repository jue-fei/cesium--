import { ref, onUnmounted, watch, computed } from 'vue'
import { storeToRefs } from 'pinia'
import {
  HeatmapManager,
  stressDebugLog as emitStressDebugLog
} from '../features/simulation/HeatmapManager.js'
import {
  applyHeatmapDisplayToConfigObject,
  cloneColorRamp
} from '../features/stress/core/render/stressRenderCore.js'
import { STRESS_METRIC_LABELS } from '../features/stress/core/computation/stressComputation.js'
import { buildDefaultStressConfig } from '../features/stress/core/render/stressRenderCore.js'
import {
  createStressSamplingActions,
  createStressDataActions,
  createStressImportActions
} from '../features/stress/core/stressActions.js'
import {
  resolveOriginFromModelCenter,
  resolveOriginFromViewer
} from '../features/stress/core/render/stressRenderCore.js'
import useViewer from '@/composables/useViewer.js'
import { useModelStore } from '../stores/modelStore.js'
import useMessage from '@/composables/useMessage.js'

export {
  STRESS_METRIC_LABELS,
  buildStressMetricOptions,
  STRESS_BASE_METRIC_KEYS
} from '../features/stress/core/computation/stressComputation.js'

const manager = ref(null)
const config = ref(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const maxTime = ref(0)
const timeDimension = ref('day')
const playbackSpeed = ref(500)
let timer = null

const dataset = ref(null)
const metric = ref('von_mises')
const directionAzimuth = ref(0)
const directionDip = ref(0)
const pickedPoint = ref(null)
const pickedPointValue = ref(null)
const pickedPointDetails = ref(null)
const pickedPointSeries = ref([])
const unitStress = ref('MPa')
const materialE = ref(null)
const materialNu = ref(null)
const pointDataset = ref(null)
const importReport = ref(null)
const overlayItems = ref([
  { metric: 'von_mises', weight: 1 },
  { metric: 'tau_max', weight: 0.35 }
])
const heatmapDisplay = ref({
  contrast: 1.9,
  gamma: 0.72,
  cutoff: 0,
  forceVisible: 0.82,
  enableContour: false,
  enableGlow: false,
  enableMarker: false
})
const heatmapBaseRamp = ref([])
const cachedScalarFields = new Map()

function stressDebugLog(title, payload) {
  emitStressDebugLog('useStress', title, payload)
}

export default function useStress() {
  const { viewer } = useViewer()
  const modelStore = useModelStore()
  const { tileset } = storeToRefs(modelStore)
  const { showMessage } = useMessage()

  const isStrainSource = computed(() => dataset.value?.data?.type === '应变')
  const importStatus = computed(() => importReport.value)
  const metricLabel = computed(() => STRESS_METRIC_LABELS[metric.value] || metric.value)
  const state = {
    config,
    currentTime,
    maxTime,
    timeDimension,
    isPlaying,
    dataset,
    metric,
    metricLabel,
    directionAzimuth,
    directionDip,
    unitStress,
    materialE,
    materialNu,
    isStrainSource,
    pickedPoint,
    pickedPointValue,
    pickedPointDetails,
    pickedPointSeries,
    importStatus,
    heatmapDisplay
  }

  const applyToModel = () => {
    if (!manager.value || !tileset.value || !config.value) return
    manager.value.applyStressConfig(tileset.value, config.value)
    manager.value.updateStressTime(tileset.value, currentTime.value)
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
  }

  const initStressManager = async () => {
    if (!viewer.value) return
    if (!manager.value) manager.value = new HeatmapManager(viewer.value)
    if (!config.value) await loadConfig()
    applyToModel()
  }

  const samplingDeps = {
    viewer,
    tileset,
    config,
    dataset,
    pointDataset,
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
  }
  const samplingActions = createStressSamplingActions(samplingDeps)

  const sharedActionDeps = {
    viewer,
    tileset,
    showMessage,
    stressDebugLog,
    config,
    dataset,
    pointDataset,
    unitStress,
    materialE,
    materialNu,
    importReport,
    metric,
    directionAzimuth,
    directionDip,
    timeDimension,
    playbackSpeed,
    currentTime,
    maxTime
  }

  const dataActions = createStressDataActions({
    ...sharedActionDeps,
    overlayItems,
    heatmapDisplay,
    heatmapBaseRamp,
    cachedScalarFields,
    resetPick: samplingActions.resetPick,
    applyToModel
  })

  const importActions = createStressImportActions({
    ...sharedActionDeps,
    cachedScalarFields,
    resetPick: samplingActions.resetPick,
    applyToModel,
    rebuildConfigFromDataset: dataActions.rebuildConfigFromDataset,
    rebuildConfigFromPointDataset: dataActions.rebuildConfigFromPointDataset
  })

  const setTime = t => {
    currentTime.value = t
    if (manager.value && tileset.value) manager.value.updateStressTime(tileset.value, t)
    if (pickedPoint.value) {
      const sampled = samplingActions.samplePickedPoint(pickedPoint.value, t)
      pickedPointValue.value = sampled.value
      pickedPointDetails.value = sampled.details
      pickedPointSeries.value = sampled.series
    }
  }

  const play = () => {
    isPlaying.value = true
    timer = setInterval(() => {
      let next = currentTime.value + 1
      if (next > maxTime.value) next = 0
      setTime(next)
    }, playbackSpeed.value)
  }

  const pause = () => {
    isPlaying.value = false
    if (timer) clearInterval(timer)
    timer = null
  }

  const togglePlayback = () => (isPlaying.value ? pause() : play())

  const exitStressAnalysis = async () => {
    pause()
    if (manager.value) {
      manager.value.clearAllStress()
    }
    if (manager.value && tileset.value) {
      manager.value.clearStress(tileset.value)
    }
    dataset.value = null
    pointDataset.value = null
    importReport.value = null
    unitStress.value = 'MPa'
    materialE.value = null
    materialNu.value = null
    currentTime.value = 0
    maxTime.value = 0
    cachedScalarFields.clear()
    samplingActions.resetPick()
    await loadConfig()
    showMessage('已退出应力分析', 'success')
  }

  watch(tileset, async () => {
    if (pointDataset.value) await dataActions.rebuildConfigFromPointDataset()
    else if (dataset.value?.originMode === '模型中心') await dataActions.rebuildConfigFromDataset()
    applyToModel()
  })

  onUnmounted(() => pause())

  const actions = {
    initStressManager,
    exitStressAnalysis,
    togglePlayback,
    setTime,
    getCurrentValueRange: samplingActions.getCurrentValueRange,
    parseAndSetStressFile: importActions.parseAndSetStressFile,
    setHeatmapDisplay: dataActions.setHeatmapDisplay,
    setMaterial: dataActions.setMaterial,
    setMetric: dataActions.setMetric,
    setDirection: dataActions.setDirection,
    pickPointOnModel: samplingActions.pickPointOnModel,
    buildPointSeriesForMetric: samplingActions.buildPointSeriesForMetric,
    buildPointAllMetricsSeries: samplingActions.buildPointAllMetricsSeries
  }
  return {
    ...state,
    ...actions,
    state,
    actions
  }
}
