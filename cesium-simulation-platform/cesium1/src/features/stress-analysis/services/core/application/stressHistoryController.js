import {
  createDefaultHeatmapDisplay,
  createDefaultOverlayItems,
  DEFAULT_STRESS_METRIC
} from '../../../types/stressDefaults.js'

const MAX_HISTORY_ENTRIES = 40

function sameHistorySnapshot(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null)
}

export function createStressHistoryController(deps) {
  const {
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
    rebuildConfig,
    applyToModel,
    setTime
  } = deps

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

  const recordHistory = () => {
    if (historyApplying.value) return false
    if (!hasStressSource.value) return false
    const snapshot = buildHistorySnapshot()
    const last = historyPast.value[historyPast.value.length - 1] || null
    if (sameHistorySnapshot(last, snapshot)) return false
    historyPast.value = [...historyPast.value.slice(-(MAX_HISTORY_ENTRIES - 1)), snapshot]
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
      const rebuilt = await rebuildConfig()
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
    historyFuture.value = [currentSnapshot, ...historyFuture.value].slice(0, MAX_HISTORY_ENTRIES)
    return restoreHistorySnapshot(previousSnapshot)
  }

  const redoHistory = async () => {
    if (historyFuture.value.length < 1) return false
    const nextSnapshot = historyFuture.value[0]
    historyFuture.value = historyFuture.value.slice(1)
    historyPast.value = [...historyPast.value, nextSnapshot].slice(-MAX_HISTORY_ENTRIES)
    return restoreHistorySnapshot(nextSnapshot)
  }

  return {
    recordHistory,
    resetHistory,
    undoHistory,
    redoHistory
  }
}
