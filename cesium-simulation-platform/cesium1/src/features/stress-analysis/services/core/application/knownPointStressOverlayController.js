const KNOWN_POINT_STRESS_DEBUG_ENDPOINT = 'http://127.0.0.1:7777/event'
const KNOWN_POINT_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(120, 1.25, 8000, 0.55)
const KNOWN_POINT_PIXEL_OFFSET_SCALE = new Cesium.NearFarScalar(120, 1.0, 8000, 0.7)

function isKnownPointStressDebugEnabled() {
  return import.meta.env.DEV && globalThis.__STRESS_POINT_DEBUG__ === true
}

function reportKnownPointStressDebug(hypothesisId, location, msg, data = {}) {
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

function formatKnownPointValue(value) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return value.toExponential(2)
  if (abs >= 100) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

export function createKnownPointStressOverlayController(deps) {
  const {
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
    runtime
  } = deps

  const getPointSource = () =>
    stressSource.value.kind === 'points' ? stressSource.value.data : null

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

  const ensureKnownPointStressDataSource = () => {
    reportKnownPointStressDebug(
      'A',
      'knownPointStressOverlayController.js:ensureKnownPointStressDataSource:enter',
      'ensure known point datasource',
      {
        hasViewer: Boolean(viewer.value),
        hasDataSource: Boolean(runtime.dataSource),
        attachedFlag: Boolean(runtime.attached),
        attached: Boolean(
          viewer.value &&
          runtime.dataSource &&
          viewer.value.dataSources?.contains?.(runtime.dataSource)
        )
      }
    )
    if (!viewer.value) return null
    if (!runtime.dataSource) {
      runtime.dataSource = new Cesium.CustomDataSource('stress-known-points')
    }
    if (!runtime.attached) {
      viewer.value.dataSources.add(runtime.dataSource)
      runtime.attached = true
      reportKnownPointStressDebug(
        'A',
        'knownPointStressOverlayController.js:ensureKnownPointStressDataSource:created',
        'created and added known point datasource',
        {
          containsAfterAdd: Boolean(viewer.value.dataSources?.contains?.(runtime.dataSource)),
          attachedFlag: Boolean(runtime.attached),
          dataSourceName: runtime.dataSource?.name || ''
        }
      )
    }
    return runtime.dataSource
  }

  const clearKnownPointStressOverlay = () => {
    reportKnownPointStressDebug(
      'B',
      'knownPointStressOverlayController.js:clearKnownPointStressOverlay',
      'clear known point overlay',
      {
        hasViewer: Boolean(viewer.value),
        hasDataSource: Boolean(runtime.dataSource),
        attachedFlag: Boolean(runtime.attached),
        entityCount: Number(runtime.dataSource?.entities?.values?.length) || 0,
        visible: Boolean(knownPointStressVisible.value)
      }
    )
    if (runtime.dataSource) runtime.dataSource.entities.removeAll()
    if (viewer.value?.scene?.requestRender) viewer.value.scene.requestRender()
  }

  const updateKnownPointStressOverlay = () => {
    const ds = getPointSource()
    const points = Array.isArray(ds?.knownPoints) ? ds.knownPoints : []
    reportKnownPointStressDebug(
      'C',
      'knownPointStressOverlayController.js:updateKnownPointStressOverlay:enter',
      'update known point overlay',
      {
        hasViewer: Boolean(viewer.value),
        visible: Boolean(knownPointStressVisible.value),
        hasPointSource: Boolean(ds),
        pointsLength: points.length,
        hasDataSource: Boolean(runtime.dataSource),
        attachedFlag: Boolean(runtime.attached),
        timeIndex: Math.max(0, Number(currentTime.value) || 0)
      }
    )
    if (!viewer.value || !knownPointStressVisible.value) {
      clearKnownPointStressOverlay()
      return
    }
    if (!ds || points.length < 1) {
      reportKnownPointStressDebug(
        'D',
        'knownPointStressOverlayController.js:updateKnownPointStressOverlay:empty',
        'skip known point overlay due to empty source',
        {
          hasPointSource: Boolean(ds),
          pointsLength: points.length,
          visible: Boolean(knownPointStressVisible.value)
        }
      )
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

    reportKnownPointStressDebug(
      'E',
      'knownPointStressOverlayController.js:updateKnownPointStressOverlay:finish',
      'known point overlay rendered',
      {
        entityCount: Number(entities?.values?.length) || 0,
        pointsLength: points.length,
        visible: Boolean(knownPointStressVisible.value)
      }
    )
    if (viewer.value?.scene?.requestRender) viewer.value.scene.requestRender()
  }

  const setKnownPointStressVisible = visible => {
    reportKnownPointStressDebug(
      'C',
      'knownPointStressOverlayController.js:setKnownPointStressVisible',
      'toggle known point stress visibility',
      {
        previousVisible: Boolean(knownPointStressVisible.value),
        nextVisible: Boolean(visible)
      }
    )
    knownPointStressVisible.value = Boolean(visible)
    updateKnownPointStressOverlay()
  }

  const destroyKnownPointStressOverlay = () => {
    reportKnownPointStressDebug(
      'F',
      'knownPointStressOverlayController.js:destroy',
      'stress composable unmounted',
      {
        hasViewer: Boolean(viewer.value),
        hasDataSource: Boolean(runtime.dataSource),
        attachedFlag: Boolean(runtime.attached),
        entityCount: Number(runtime.dataSource?.entities?.values?.length) || 0,
        visible: Boolean(knownPointStressVisible.value)
      }
    )
    clearKnownPointStressOverlay()
    if (viewer.value && runtime.dataSource && runtime.attached) {
      try {
        reportKnownPointStressDebug(
          'F',
          'knownPointStressOverlayController.js:destroy:beforeRemove',
          'remove known point datasource on unmount',
          {
            containsBeforeRemove: Boolean(viewer.value.dataSources?.contains?.(runtime.dataSource)),
            attachedFlag: Boolean(runtime.attached),
            entityCount: Number(runtime.dataSource?.entities?.values?.length) || 0
          }
        )
        viewer.value.dataSources.remove(runtime.dataSource)
        runtime.attached = false
        reportKnownPointStressDebug(
          'F',
          'knownPointStressOverlayController.js:destroy:afterRemove',
          'removed known point datasource on unmount',
          {
            containsAfterRemove: Boolean(viewer.value.dataSources?.contains?.(runtime.dataSource)),
            attachedFlag: Boolean(runtime.attached),
            entityCount: Number(runtime.dataSource?.entities?.values?.length) || 0
          }
        )
      } catch {
        /* noop */
      }
    }
    runtime.attached = false
    runtime.dataSource = null
  }

  return {
    updateKnownPointStressOverlay,
    clearKnownPointStressOverlay,
    setKnownPointStressVisible,
    destroyKnownPointStressOverlay
  }
}
