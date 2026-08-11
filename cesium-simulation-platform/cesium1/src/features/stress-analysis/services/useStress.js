import { ref, shallowRef, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { stressDebugLog as emitStressDebugLog } from './heatmap/HeatmapManager.js'
import {
  createDefaultHeatmapDisplay,
  createDefaultOverlayItems,
  DEFAULT_STRESS_METRIC,
  DEFAULT_STRESS_UNIT
} from '../types/stressDefaults.js'
import useViewer from '@/composables/useViewer.js'
import { useModelStore } from '../../../stores/modelStore.js'
import { useGeologyStore } from '../../../stores/geologyStore.js'
import useMessage from '@/composables/useMessage.js'
import {
  buildStressState,
  createRenderProgressController,
  createStressComputedState,
  setupStressWatchers
} from './stressServiceHelpers.js'
import { createStressRuntimeServices } from './stressServiceRuntime.js'

export { STRESS_METRIC_LABELS, buildStressMetricOptions } from './core/computation/index.js'

const manager = ref(null)
const config = shallowRef(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const maxTime = ref(0)
const timeDimension = ref('day')
const playbackSpeed = ref(500)
const playbackRuntime = {
  timer: null,
  rafId: null,
  lastFrameTime: 0,
  lastTimeIndex: 0,
  setTimeRafId: null
}

const stressSource = shallowRef({ kind: '', data: null })
const metric = ref(DEFAULT_STRESS_METRIC)
const directionAzimuth = ref(0)
const directionDip = ref(0)
const pickedPoint = ref(null)
const pickedPointValue = ref(null)
const pickedPointDetails = ref(null)
const pickedPointSeries = shallowRef([])
const unitStress = ref(DEFAULT_STRESS_UNIT)
const materialE = ref(null)
const materialNu = ref(null)
const importReport = ref(null)
const overlayItems = ref(createDefaultOverlayItems())
const heatmapDisplay = ref(createDefaultHeatmapDisplay())
const heatmapBaseRamp = ref([])
const cachedScalarFields = new Map()
const cachedPointInterpolationFields = new Map()
const safetyContext = shallowRef(null)
const pointRenderMode = ref('points')
const pointSourceMode = ref('top4')
const historyPast = ref([])
const historyFuture = ref([])
const historyApplying = ref(false)
const createIdleRenderProgress = () => ({
  active: false,
  percent: 0,
  text: '',
  phase: 'idle',
  requiresConfirm: false,
  fallbackMode: '',
  fallbackReason: ''
})
const renderProgress = ref(createIdleRenderProgress())
const knownPointStressVisible = ref(false)
const whiteModelEnabled = ref(false)
const knownPointOverlayRuntime = {
  dataSource: null,
  attached: false
}

function stressDebugLog(title, payload) {
  emitStressDebugLog('useStress', title, payload)
}

function createStressRuntimeContext({ viewer, geologyStore, tileset, showMessage }) {
  const getGridSource = () => (stressSource.value.kind === 'grid' ? stressSource.value.data : null)
  const getPointSource = () =>
    stressSource.value.kind === 'points' ? stressSource.value.data : null
  const computedState = createStressComputedState({
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
  })
  const setRenderProgress = createRenderProgressController(renderProgress, createIdleRenderProgress)

  return {
    getGridSource,
    getPointSource,
    computedState,
    setRenderProgress,
    runtime: createStressRuntimeServices({
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
      hasStressSource: computedState.hasStressSource,
      safetyContext,
      materialE,
      materialNu,
      pointRenderMode,
      pointSourceMode,
      historyPast,
      historyFuture,
      historyApplying,
      metricUnit: computedState.metricUnit,
      showMessage,
      stressDebugLog,
      importReport,
      timeDimension,
      heatmapBaseRamp,
      cachedScalarFields,
      cachedPointInterpolationFields,
      setRenderProgress,
      createIdleRenderProgress,
      geologyStore
    })
  }
}

function buildStressServiceResult({ runtime, computedState, setKnownPointStressVisible, setWhiteModel }) {
  const state = buildStressState({
    config,
    currentTime,
    maxTime,
    timeDimension,
    isPlaying,
    stressSource,
    pointRenderMode,
    pointSourceMode,
    metric,
    directionAzimuth,
    directionDip,
    unitStress,
    materialE,
    materialNu,
    pickedPoint,
    pickedPointValue,
    pickedPointDetails,
    pickedPointSeries,
    heatmapDisplay,
    knownPointStressVisible,
    whiteModelEnabled,
    renderProgress,
    safetyContext,
    ...computedState
  })
  const actions = {
    initStressManager: runtime.coreActions.initStressManager,
    exitStressAnalysis: runtime.coreActions.exitStressAnalysis,
    togglePlayback: runtime.playback.togglePlayback,
    setTime: runtime.playback.setTime,
    setPointRenderMode: runtime.dataActions.setPointRenderMode,
    setPointSourceMode: runtime.dataActions.setPointSourceStrategy,
    setPointInterpolationGrid: runtime.dataActions.setPointInterpolationGrid,
    setInterpolationPower: runtime.dataActions.setInterpolationPower,
    confirmPointInterpolationFinalPass: runtime.dataActions.confirmPointInterpolationFinalPass,
    keepPointInterpolationPreview: runtime.dataActions.keepPointInterpolationPreview,
    setKnownPointStressVisible,
    setWhiteModel,
    getCurrentValueRange: runtime.samplingActions.getCurrentValueRange,
    parseAndSetStressFile: runtime.importActions.parseAndSetStressFile,
    setHeatmapDisplay: runtime.dataActions.setHeatmapDisplay,
    setMaterial: runtime.dataActions.setMaterial,
    setMetric: runtime.dataActions.setMetric,
    setDirection: runtime.dataActions.setDirection,
    undoHistory: runtime.history.undoHistory,
    redoHistory: runtime.history.redoHistory,
    pickPointOnModel: runtime.samplingActions.pickPointOnModel,
    buildPointSeriesForMetric: runtime.samplingActions.buildPointSeriesForMetric,
    buildPointAllMetricsSeries: runtime.samplingActions.buildPointAllMetricsSeries
  }

  return { ...state, ...actions, state, actions }
}

export default function useStress() {
  const { viewer } = useViewer()
  const modelStore = useModelStore()
  const geologyStore = useGeologyStore()
  const { tileset } = storeToRefs(modelStore)
  const { showMessage } = useMessage()
  const { computedState, runtime } = createStressRuntimeContext({
    viewer,
    geologyStore,
    tileset,
    showMessage
  })
  const {
    updateKnownPointStressOverlay,
    setKnownPointStressVisible,
    destroyKnownPointStressOverlay
  } = runtime.overlay
  setupStressWatchers({
    stressSource,
    pointRenderMode,
    pointSourceMode,
    cachedScalarFields,
    cachedPointInterpolationFields,
    metric,
    tileset,
    sourceKind: computedState.sourceKind,
    knownPointStressVisible,
    directionAzimuth,
    directionDip,
    metricUnit: computedState.metricUnit,
    heatmapDisplay,
    geologyStore,
    safetyContext,
    updateKnownPointStressOverlay,
    refreshSafety: runtime.coreActions.refreshSafety,
    dataActions: runtime.dataActions,
    applyToModel: runtime.coreActions.applyToModel
  })

  const setWhiteModel = enabled => {
    whiteModelEnabled.value = !!enabled
    if (manager.value && tileset.value) {
      manager.value.setWhiteModel(tileset.value, !!enabled)
    }
  }

  onUnmounted(() => {
    runtime.playback.cleanupPlayback()
    destroyKnownPointStressOverlay()
  })
  return buildStressServiceResult({ runtime, computedState, setKnownPointStressVisible, setWhiteModel })
}
