import { ref, shallowRef, onUnmounted, watch, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { HeatmapManager, stressDebugLog as emitStressDebugLog } from './heatmap/HeatmapManager.js'
import {
  applyHeatmapDisplayToConfigObject,
  buildDefaultStressConfig,
  cloneColorRamp,
  resolveOriginFromModelCenter,
  resolveOriginFromViewer,
  resolveTilesetCenterInfo
} from './core/render/index.js'
import { STRESS_METRIC_LABELS } from './core/computation/index.js'
import { getPointMetricSeriesValues } from './core/data/pointCore.js'
import { resolvePointCenterCartesian } from './core/interpolation/utils.js'
import { sampleGridScalarAt } from './core/interpolation/index.js'
import { createStressSamplingActions } from './core/application/stressSamplingActions.js'
import { createStressImportActions } from './core/application/stressImportActions.js'
import { createStressDataControlService } from './core/application/stressDataControlService.js'
import { createStressDataRebuildService } from './core/application/stressDataRebuildService.js'
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
import { buildStressSafetyContext } from './core/safety/projection.js'
import {
  buildSafetyAnalysisSummary,
  isSafetyMetric,
  resolveMetricDisplayUnit
} from './core/safety/index.js'

export { STRESS_METRIC_LABELS, buildStressMetricOptions } from './core/computation/index.js'

const manager = ref(null)
const config = shallowRef(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const maxTime = ref(0)
const timeDimension = ref('day')
const playbackSpeed = ref(500)
let timer = null
let rafId = null
let lastFrameTime = 0
let lastTimeIndex = 0
let setTimeRafId = null

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
let knownPointStressDataSource = null
let knownPointStressDataSourceAttached = false

// #region debug-point A:known-point-debug-reporter
const KNOWN_POINT_STRESS_DEBUG_ENDPOINT = 'http://127.0.0.1:7777/event'

const isKnownPointStressDebugEnabled = () =>
  import.meta.env.DEV && globalThis.__STRESS_POINT_DEBUG__ === true

const reportKnownPointStressDebug = (hypothesisId, location, msg, data = {}) => {
  if (!isKnownPointStressDebugEnabled()) return Promise.resolve()
  return fetch(KNOWN_POINT_STRESS_DEBUG_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'known-point-stress-crash',
      runId: 'post-fix',
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now()
    })
  }).catch(() => {})
}
// #endregion

const KNOWN_POINT_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(120, 1.25, 8000, 0.55)
const KNOWN_POINT_PIXEL_OFFSET_SCALE = new Cesium.NearFarScalar(120, 1.0, 8000, 0.7)

function stressDebugLog(title, payload) {
  emitStressDebugLog('useStress', title, payload)
}

export default function useStress() {
  const { viewer } = useViewer()
  const modelStore = useModelStore()
  const geologyStore = useGeologyStore()
  const { tileset } = storeToRefs(modelStore)
  const { showMessage } = useMessage()

  const getGridSource = () => (stressSource.value.kind === 'grid' ? stressSource.value.data : null)
  const getPointSource = () =>
    stressSource.value.kind === 'points' ? stressSource.value.data : null
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
  const setRenderProgress = next => {
    const prev = renderProgress.value || createIdleRenderProgress()
    const active = next?.active !== undefined ? Boolean(next.active) : prev.active
    let rawPercent = Number.isFinite(prev.percent) ? prev.percent : 0
    if (next?.percent !== undefined) rawPercent = Number(next.percent)
    const percent = Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0))
    const text = next?.text !== undefined ? String(next.text || '') : String(prev.text || '')
    const phase =
      next?.phase !== undefined ? String(next.phase || 'idle') : String(prev.phase || 'idle')
    const requiresConfirm =
      next?.requiresConfirm !== undefined
        ? Boolean(next.requiresConfirm)
        : Boolean(prev.requiresConfirm)
    const fallbackMode =
      next?.fallbackMode !== undefined
        ? String(next.fallbackMode || '')
        : String(prev.fallbackMode || '')
    const fallbackReason =
      next?.fallbackReason !== undefined
        ? String(next.fallbackReason || '')
        : String(prev.fallbackReason || '')
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
  const sourceKind = computed(() => String(stressSource.value.kind || ''))
  const state = {
    config,
    currentTime,
    maxTime,
    timeDimension,
    isPlaying,
    stressSource,
    pointRenderMode,
    pointSourceMode,
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
    heatmapDisplay,
    knownPointStressVisible,
    renderProgress,
    safetyContext,
    safetySummary,
    sourceKind,
    canUndo,
    canRedo,
    metricUnit
  }

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
  const buildMaterialSnapshot = () =>
    getGridSource()?.material
      ? {
          E: Number(getGridSource().material.E),
          nu: Number(getGridSource().material.nu)
        }
      : null
  const buildPointSnapshot = () =>
    getPointSource() && typeof getPointSource() === 'object'
      ? {
          renderMode: String(getPointSource().renderMode || 'points'),
          sourceStrategy: String(getPointSource().sourceStrategy || 'top4'),
          interpolationGrid: Array.isArray(getPointSource()?.interpolation?.grid)
            ? getPointSource()
                .interpolation.grid.slice(0, 3)
                .map(v => Math.max(1, Math.round(Number(v) || 1)))
            : null
        }
      : null
  const applyMaterialSnapshot = snapshot => {
    const ds = getGridSource()
    if (!ds?.material || !snapshot) return
    ds.material.E = Number(snapshot.E)
    ds.material.nu = Number(snapshot.nu)
    materialE.value = Number(snapshot.E)
    materialNu.value = Number(snapshot.nu)
  }
  const applyPointSnapshot = snapshot => {
    const pd = getPointSource()
    if (!pd || !snapshot) return
    pd.renderMode = String(snapshot.renderMode || 'points')
    pd.sourceStrategy = String(snapshot.sourceStrategy || 'top4')
    pointRenderMode.value = pd.renderMode
    pointSourceMode.value = pd.sourceStrategy
    if (Array.isArray(snapshot.interpolationGrid)) {
      pd.interpolation = {
        ...(pd.interpolation || {}),
        grid: snapshot.interpolationGrid.slice(0, 3)
      }
    }
  }

  const buildHistorySnapshot = () => ({
    metric: metric.value,
    directionAzimuth: Number(directionAzimuth.value) || 0,
    directionDip: Number(directionDip.value) || 0,
    currentTime: Number(currentTime.value) || 0,
    safetyContextSignature: String(safetyContext.value?.signature || ''),
    heatmapDisplay: { ...(heatmapDisplay.value || {}) },
    overlayItems: Array.isArray(overlayItems.value)
      ? overlayItems.value.map(item => ({
          metric: String(item?.metric || ''),
          weight: Number(item?.weight) || 0
        }))
      : [],
    material: buildMaterialSnapshot(),
    point: buildPointSnapshot()
  })

  const sameHistorySnapshot = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null)
  const maxHistoryEntries = 40
  const recordHistory = () => {
    if (historyApplying.value) return false
    if (!hasStressSource.value) return false
    const snapshot = buildHistorySnapshot()
    const last = historyPast.value[historyPast.value.length - 1] || null
    if (sameHistorySnapshot(last, snapshot)) return false
    historyPast.value = [...historyPast.value.slice(-(maxHistoryEntries - 1)), snapshot]
    historyFuture.value = []
    return true
  }

  const resetHistory = () => {
    if (!hasStressSource.value) {
      historyPast.value = []
      historyFuture.value = []
      return
    }
    historyPast.value = [buildHistorySnapshot()]
    historyFuture.value = []
  }

  const restoreHistorySnapshot = async snapshot => {
    if (!snapshot || historyApplying.value) return false
    historyApplying.value = true
    try {
      metric.value = String(snapshot.metric || DEFAULT_STRESS_METRIC)
      directionAzimuth.value = Number(snapshot.directionAzimuth) || 0
      directionDip.value = Number(snapshot.directionDip) || 0
      heatmapDisplay.value = {
        ...createDefaultHeatmapDisplay(),
        ...(snapshot.heatmapDisplay || {})
      }
      overlayItems.value = Array.isArray(snapshot.overlayItems)
        ? snapshot.overlayItems.map(item => ({
            metric: String(item?.metric || DEFAULT_STRESS_METRIC),
            weight: Number(item?.weight) || 0
          }))
        : createDefaultOverlayItems()
      applyMaterialSnapshot(snapshot.material)
      applyPointSnapshot(snapshot.point)
      const rebuilt = await dataActions.rebuildConfig()
      if (rebuilt !== false) applyToModel()
      setTime(Number(snapshot.currentTime) || 0)
      return true
    } finally {
      historyApplying.value = false
    }
  }

  const undoHistory = async () => {
    if (historyPast.value.length < 2) return false
    const currentSnapshot = historyPast.value[historyPast.value.length - 1]
    const previousSnapshot = historyPast.value[historyPast.value.length - 2]
    historyPast.value = historyPast.value.slice(0, -1)
    historyFuture.value = [currentSnapshot, ...historyFuture.value].slice(0, maxHistoryEntries)
    return restoreHistorySnapshot(previousSnapshot)
  }

  const redoHistory = async () => {
    if (historyFuture.value.length < 1) return false
    const nextSnapshot = historyFuture.value[0]
    historyFuture.value = historyFuture.value.slice(1)
    historyPast.value = [...historyPast.value, nextSnapshot].slice(-maxHistoryEntries)
    return restoreHistorySnapshot(nextSnapshot)
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

  const refreshSafetyContext = () => {
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

  const samplingDeps = {
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
  }
  const samplingActions = createStressSamplingActions(samplingDeps)

  const ensureKnownPointStressDataSource = () => {
    // #region debug-point A:ensure-known-point-datasource-enter
    reportKnownPointStressDebug(
      'A',
      'useStress.js:ensureKnownPointStressDataSource:enter',
      'ensure known point datasource',
      {
        hasViewer: Boolean(viewer.value),
        hasDataSource: Boolean(knownPointStressDataSource),
        attachedFlag: Boolean(knownPointStressDataSourceAttached),
        attached: Boolean(
          viewer.value &&
          knownPointStressDataSource &&
          viewer.value.dataSources?.contains?.(knownPointStressDataSource)
        )
      }
    )
    // #endregion
    if (!viewer.value) return null
    if (!knownPointStressDataSource) {
      knownPointStressDataSource = new Cesium.CustomDataSource('stress-known-points')
    }
    if (!knownPointStressDataSourceAttached) {
      viewer.value.dataSources.add(knownPointStressDataSource)
      knownPointStressDataSourceAttached = true
      // #region debug-point A:ensure-known-point-datasource-created
      reportKnownPointStressDebug(
        'A',
        'useStress.js:ensureKnownPointStressDataSource:created',
        'created and added known point datasource',
        {
          containsAfterAdd: Boolean(
            viewer.value.dataSources?.contains?.(knownPointStressDataSource)
          ),
          attachedFlag: Boolean(knownPointStressDataSourceAttached),
          dataSourceName: knownPointStressDataSource?.name || ''
        }
      )
      // #endregion
    }
    return knownPointStressDataSource
  }

  const clearKnownPointStressOverlay = () => {
    // #region debug-point B:clear-known-point-overlay
    reportKnownPointStressDebug(
      'B',
      'useStress.js:clearKnownPointStressOverlay',
      'clear known point overlay',
      {
        hasViewer: Boolean(viewer.value),
        hasDataSource: Boolean(knownPointStressDataSource),
        attachedFlag: Boolean(knownPointStressDataSourceAttached),
        entityCount: Number(knownPointStressDataSource?.entities?.values?.length) || 0,
        visible: Boolean(knownPointStressVisible.value)
      }
    )
    // #endregion
    if (knownPointStressDataSource) knownPointStressDataSource.entities.removeAll()
    if (viewer.value?.scene?.requestRender) viewer.value.scene.requestRender()
  }

  const formatKnownPointValue = value => {
    if (!Number.isFinite(value)) return '—'
    const abs = Math.abs(value)
    if (abs >= 1000 || (abs > 0 && abs < 0.01)) return value.toExponential(2)
    if (abs >= 100) return value.toFixed(1)
    if (abs >= 1) return value.toFixed(2)
    return value.toFixed(3)
  }

  const getRenderableFieldFrame = timeIndex => {
    const fieldData = config.value?.field?.data
    const grid = fieldData?.grid
    const origin = fieldData?.origin
    const size = fieldData?.size
    const frames = fieldData?.frames
    if (!grid || !origin || !size || !Array.isArray(frames) || frames.length < 1) return null
    const frame = frames[Math.max(0, Math.min(frames.length - 1, timeIndex))]
    const values = frame?.values
    if (!(Array.isArray(values) || ArrayBuffer.isView(values))) return null
    return { grid, origin, size, values }
  }

  const sampleRenderableFieldValue = (position, timeIndex) => {
    const field = getRenderableFieldFrame(timeIndex)
    if (!field || !position) return Number.NaN
    const sampled = sampleGridScalarAt(position, field.values, field.grid, field.origin, field.size)
    return Number.isFinite(sampled) ? Number(sampled) : Number.NaN
  }

  const sampleRampColor = (ramp, t) => {
    const list = Array.isArray(ramp) ? ramp : []
    if (list.length < 1) return Cesium.Color.WHITE
    const stops = list
      .map((row, idx) => ({
        value: Number.isFinite(Number(row?.value))
          ? Number(row.value)
          : idx / Math.max(1, list.length - 1),
        color: Cesium.Color.fromCssColorString(String(row?.color || '#ffffff'))
      }))
      .sort((a, b) => a.value - b.value)
    const x = Math.max(0, Math.min(1, Number(t) || 0))
    if (x <= stops[0].value) return stops[0].color.clone()
    for (let i = 1; i < stops.length; i++) {
      const left = stops[i - 1]
      const right = stops[i]
      if (x <= right.value) {
        const localT = (x - left.value) / Math.max(1e-6, right.value - left.value)
        return Cesium.Color.lerp(left.color, right.color, localT, new Cesium.Color())
      }
    }
    return stops[stops.length - 1].color.clone()
  }

  const resolveKnownPointColor = value => {
    const rangeCandidate =
      Array.isArray(config.value?.field?.data?.valueRange) &&
      config.value.field.data.valueRange.length === 2
        ? {
            min: Number(config.value.field.data.valueRange[0]),
            max: Number(config.value.field.data.valueRange[1])
          }
        : samplingActions.getCurrentValueRange?.()
    const min = Number(rangeCandidate?.min)
    const max = Number(rangeCandidate?.max)
    const rawValue = Number(value)
    if (!(Number.isFinite(rawValue) && Number.isFinite(min) && Number.isFinite(max) && max > min)) {
      return Cesium.Color.WHITE
    }
    const normalized = Math.max(0, Math.min(1, (rawValue - min) / (max - min)))
    const cutoff = Math.max(0, Math.min(0.95, Number(heatmapDisplay.value?.cutoff) || 0))
    const colorW =
      normalized <= cutoff
        ? 0
        : Math.max(0, Math.min(1, (normalized - cutoff) / Math.max(1e-6, 1 - cutoff)))
    return sampleRampColor(config.value?.colorRamp, colorW)
  }

  const updateKnownPointStressOverlay = () => {
    const ds = getPointSource()
    const points = Array.isArray(ds?.knownPoints) ? ds.knownPoints : []
    // #region debug-point C:update-known-point-overlay-enter
    reportKnownPointStressDebug(
      'C',
      'useStress.js:updateKnownPointStressOverlay:enter',
      'update known point overlay',
      {
        hasViewer: Boolean(viewer.value),
        visible: Boolean(knownPointStressVisible.value),
        hasPointSource: Boolean(ds),
        pointsLength: points.length,
        hasDataSource: Boolean(knownPointStressDataSource),
        attachedFlag: Boolean(knownPointStressDataSourceAttached),
        timeIndex: Math.max(0, Number(currentTime.value) || 0)
      }
    )
    // #endregion
    if (!viewer.value || !knownPointStressVisible.value) {
      clearKnownPointStressOverlay()
      return
    }
    if (!ds || points.length < 1) {
      // #region debug-point D:update-known-point-overlay-empty
      reportKnownPointStressDebug(
        'D',
        'useStress.js:updateKnownPointStressOverlay:empty',
        'skip known point overlay due to empty source',
        {
          hasPointSource: Boolean(ds),
          pointsLength: points.length,
          visible: Boolean(knownPointStressVisible.value)
        }
      )
      // #endregion
      clearKnownPointStressOverlay()
      return
    }
    const dataSource = ensureKnownPointStressDataSource()
    if (!dataSource) return
    const entities = dataSource.entities
    entities.removeAll()

    const direction = {
      azimuthDeg: Number(directionAzimuth.value) || 0,
      dipDeg: Number(directionDip.value) || 0
    }
    const unit = metricUnit.value || ds.unitStress || unitStress.value || ''
    const currentIndex = Math.max(0, Number(currentTime.value) || 0)
    const origin = Array.isArray(ds.origin) ? ds.origin : null
    const size = Array.isArray(ds.size) ? ds.size : null

    for (const point of points) {
      if (!point || typeof point !== 'object') continue
      const position = resolvePointCenterCartesian(
        point,
        origin,
        size,
        tileset.value,
        resolveTilesetCenterInfo
      )
      if (!position) continue
      const series = getPointMetricSeriesValues(
        point,
        ds,
        metric.value,
        direction,
        overlayItems.value
      )
      const rawValue = Array.isArray(series) ? series[currentIndex] : null
      const rawValueNumber =
        rawValue === null || rawValue === undefined ? Number.NaN : Number(rawValue)
      const sampledFieldValue = sampleRenderableFieldValue(position, currentIndex)
      const value = Number.isFinite(sampledFieldValue) ? sampledFieldValue : rawValueNumber
      const color = resolveKnownPointColor(value)
      const title = String(point.name || point.id || '已知点')
      const rawDifferent =
        Number.isFinite(rawValueNumber) &&
        Number.isFinite(value) &&
        Math.abs(rawValueNumber - value) > Math.max(1e-4, Math.abs(rawValueNumber) * 0.001)
      const valueText = Number.isFinite(value)
        ? rawDifferent
          ? `${formatKnownPointValue(value)} ${unit} (原 ${formatKnownPointValue(rawValueNumber)})`.trim()
          : `${formatKnownPointValue(value)} ${unit}`.trim()
        : '—'
      entities.add({
        id: `stress-known-point-${point.id || title}`,
        position,
        point: {
          pixelSize: 11,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: KNOWN_POINT_SCALE_BY_DISTANCE
        },
        label: {
          text: `${title}\n${valueText}`,
          font: 'bold 13px sans-serif',
          fillColor: color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.72),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -24),
          pixelOffsetScaleByDistance: KNOWN_POINT_PIXEL_OFFSET_SCALE,
          scaleByDistance: KNOWN_POINT_SCALE_BY_DISTANCE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM
        }
      })
    }
    // #region debug-point E:update-known-point-overlay-finish
    reportKnownPointStressDebug(
      'E',
      'useStress.js:updateKnownPointStressOverlay:finish',
      'known point overlay rendered',
      {
        entityCount: Number(entities?.values?.length) || 0,
        pointsLength: points.length,
        visible: Boolean(knownPointStressVisible.value)
      }
    )
    // #endregion
    if (viewer.value?.scene?.requestRender) viewer.value.scene.requestRender()
  }

  const sharedActionDeps = {
    viewer,
    tileset,
    showMessage,
    stressDebugLog,
    config,
    stressSource,
    pointRenderMode,
    pointSourceMode,
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
    maxTime,
    safetyContext
  }

  const dataActionCtx = {
    ...sharedActionDeps,
    overlayItems,
    heatmapDisplay,
    heatmapBaseRamp,
    cachedScalarFields,
    cachedPointInterpolationFields,
    setRenderProgress,
    resetPick: samplingActions.resetPick,
    applyToModel,
    recordHistory,
    resetHistory
  }
  const rebuilders = createStressDataRebuildService(dataActionCtx)
  const controls = createStressDataControlService(dataActionCtx, rebuilders)
  const dataActions = { ...rebuilders, ...controls }

  const importActions = createStressImportActions({
    ...sharedActionDeps,
    cachedScalarFields,
    cachedPointInterpolationFields,
    resetPick: samplingActions.resetPick,
    applyToModel,
    heatmapDisplay,
    resetHistory,
    rebuildConfig: dataActions.rebuildConfig
  })

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
      refreshSafetyContext()
      updateKnownPointStressOverlay()
    },
    { immediate: true }
  )

  watch(
    () => geologyStore.boreholes,
    () => {
      const prevSignature = String(safetyContext.value?.signature || '')
      const next = refreshSafetyContext()
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

  const setTime = t => {
    currentTime.value = t
    if (setTimeRafId) cancelAnimationFrame(setTimeRafId)
    setTimeRafId = requestAnimationFrame(() => {
      setTimeRafId = null
      if (manager.value && tileset.value) manager.value.updateStressTime(tileset.value, t)
    })
    if (pickedPoint.value) {
      const sampled = samplingActions.samplePickedPoint(pickedPoint.value, t)
      pickedPointValue.value = sampled.value
      pickedPointDetails.value = sampled.details
      pickedPointSeries.value = sampled.series
    }
    updateKnownPointStressOverlay()
  }

  const play = () => {
    isPlaying.value = true
    lastFrameTime = performance.now()
    lastTimeIndex = currentTime.value
    const tick = () => {
      if (!isPlaying.value) return
      rafId = requestAnimationFrame(tick)
      const now = performance.now()
      const elapsed = now - lastFrameTime
      if (elapsed < playbackSpeed.value) return
      const framesToAdvance = Math.max(1, Math.floor(elapsed / playbackSpeed.value))
      lastFrameTime += framesToAdvance * playbackSpeed.value
      if (lastFrameTime < now - playbackSpeed.value * 2) {
        lastFrameTime = now
      }
      let next = lastTimeIndex + 1
      if (next > maxTime.value) next = 0
      lastTimeIndex = next
      setTime(next)
    }
    rafId = requestAnimationFrame(tick)
  }

  const pause = () => {
    isPlaying.value = false
    if (timer) clearInterval(timer)
    timer = null
    if (rafId) cancelAnimationFrame(rafId)
    rafId = null
  }

  const togglePlayback = () => (isPlaying.value ? pause() : play())

  const exitStressAnalysis = async () => {
    // #region debug-point G:exit-stress-analysis
    reportKnownPointStressDebug(
      'G',
      'useStress.js:exitStressAnalysis',
      'exit stress analysis called',
      {
        hasManager: Boolean(manager.value),
        hasTileset: Boolean(tileset.value),
        hasDataSource: Boolean(knownPointStressDataSource),
        attachedFlag: Boolean(knownPointStressDataSourceAttached),
        visible: Boolean(knownPointStressVisible.value)
      }
    )
    // #endregion
    pause()
    if (manager.value) manager.value.clearAllStress()
    if (manager.value && tileset.value) manager.value.clearStress(tileset.value)
    clearKnownPointStressOverlay()
    clearStressSourceState()
    await loadConfig()
    showMessage('已退出应力分析', 'success')
  }

  watch(tileset, async () => {
    if (sourceKind.value !== 'points' && stressSource.value.data?.originMode !== '模型中心') return
    refreshSafetyContext()
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

  onUnmounted(() => {
    // #region debug-point F:known-point-on-unmounted
    reportKnownPointStressDebug('F', 'useStress.js:onUnmounted', 'stress composable unmounted', {
      hasViewer: Boolean(viewer.value),
      hasDataSource: Boolean(knownPointStressDataSource),
      attachedFlag: Boolean(knownPointStressDataSourceAttached),
      entityCount: Number(knownPointStressDataSource?.entities?.values?.length) || 0,
      visible: Boolean(knownPointStressVisible.value)
    })
    // #endregion
    pause()
    clearKnownPointStressOverlay()
    if (viewer.value && knownPointStressDataSource && knownPointStressDataSourceAttached) {
      try {
        // #region debug-point F:known-point-before-remove
        reportKnownPointStressDebug(
          'F',
          'useStress.js:onUnmounted:beforeRemove',
          'remove known point datasource on unmount',
          {
            containsBeforeRemove: Boolean(
              viewer.value.dataSources?.contains?.(knownPointStressDataSource)
            ),
            attachedFlag: Boolean(knownPointStressDataSourceAttached),
            entityCount: Number(knownPointStressDataSource?.entities?.values?.length) || 0
          }
        )
        // #endregion
        viewer.value.dataSources.remove(knownPointStressDataSource)
        knownPointStressDataSourceAttached = false
        // #region debug-point F:known-point-after-remove
        reportKnownPointStressDebug(
          'F',
          'useStress.js:onUnmounted:afterRemove',
          'removed known point datasource on unmount',
          {
            containsAfterRemove: Boolean(
              viewer.value.dataSources?.contains?.(knownPointStressDataSource)
            ),
            attachedFlag: Boolean(knownPointStressDataSourceAttached),
            entityCount: Number(knownPointStressDataSource?.entities?.values?.length) || 0
          }
        )
        // #endregion
      } catch {
        /* noop */
      }
    }
    knownPointStressDataSourceAttached = false
    knownPointStressDataSource = null
  })

  const setKnownPointStressVisible = visible => {
    // #region debug-point C:set-known-point-visible
    reportKnownPointStressDebug(
      'C',
      'useStress.js:setKnownPointStressVisible',
      'toggle known point stress visibility',
      {
        previousVisible: Boolean(knownPointStressVisible.value),
        nextVisible: Boolean(visible)
      }
    )
    // #endregion
    knownPointStressVisible.value = Boolean(visible)
    updateKnownPointStressOverlay()
  }

  const actions = {
    initStressManager,
    exitStressAnalysis,
    togglePlayback,
    setTime,
    setPointRenderMode: dataActions.setPointRenderMode,
    setPointSourceMode: dataActions.setPointSourceStrategy,
    setPointInterpolationGrid: dataActions.setPointInterpolationGrid,
    setInterpolationPower: dataActions.setInterpolationPower,
    confirmPointInterpolationFinalPass: dataActions.confirmPointInterpolationFinalPass,
    keepPointInterpolationPreview: dataActions.keepPointInterpolationPreview,
    setKnownPointStressVisible,
    getCurrentValueRange: samplingActions.getCurrentValueRange,
    parseAndSetStressFile: importActions.parseAndSetStressFile,
    setHeatmapDisplay: dataActions.setHeatmapDisplay,
    setMaterial: dataActions.setMaterial,
    setMetric: dataActions.setMetric,
    setDirection: dataActions.setDirection,
    undoHistory,
    redoHistory,
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
