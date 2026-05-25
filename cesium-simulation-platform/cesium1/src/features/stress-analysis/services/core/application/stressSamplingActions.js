import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'
import {
  buildAllMetricsRowsFromTensor6,
  buildPointConfigDetails,
  buildPointConfigSeries,
  buildPointAllMetricsSeries as buildPointAllMetricsSeriesCore,
  buildPointSeriesForMetric as buildPointSeriesForMetricCore
} from '../data/index.js'
import {
  computePointDetailsAtTime,
  sampleGridScalarAt,
  findNearestPointConfig,
  getPositionFromClick
} from '../interpolation/index.js'
import { resolveTilesetCenterInfo } from '../render/index.js'

export function createStressSamplingActions(ctx) {
  const getPointDataset = () =>
    ctx.stressSource.value.kind === 'points' ? ctx.stressSource.value.data : null
  const getGridDataset = () =>
    ctx.stressSource.value.kind === 'grid' ? ctx.stressSource.value.data : null
  const getGridField = () => {
    const field = ctx.config.value?.field
    const data = field?.data
    if (!field || field.type !== 'grid' || !data) return null
    const grid = data.grid
    const origin = data.origin
    const size = data.size
    const frames = data.frames || []
    if (!grid || !origin || !size || frames.length === 0) return null
    return { data, grid, origin, size, frames }
  }

  const buildDirection = dirOverride =>
    dirOverride || {
      azimuthDeg: ctx.directionAzimuth.value,
      dipDeg: ctx.directionDip.value
    }

  const resolvePointDatasetOrigin = () => {
    const pd = getPointDataset()
    if (!pd) return null
    let origin = pd.origin
    if (pd.originMode === '模型中心') {
      origin =
        ctx.resolveOriginFromModelCenter(ctx.tileset.value) ||
        ctx.resolveOriginFromViewer(ctx.viewer.value)
    }
    return origin
  }

  const sampleScalarAtPoint = (pointWC, timeIndex) => {
    const f = getGridField()
    if (!f) return null
    const { grid, origin, size, frames } = f
    const frame = frames[Math.max(0, Math.min(frames.length - 1, timeIndex))]
    const values = frame?.values
    if (!(Array.isArray(values) || ArrayBuffer.isView(values))) return null
    return sampleGridScalarAt(pointWC, values, grid, origin, size)
  }

  const buildSeriesAtPoint = pointWC => {
    const f = getGridField()
    if (!f) return []
    const { data, grid, origin, size, frames } = f
    const timePoints = data.timePoints || null
    const series = []
    for (let i = 0; i < frames.length; i++) {
      const t = Array.isArray(timePoints) ? timePoints[i] : i
      const values = frames[i]?.values
      if (!(Array.isArray(values) || ArrayBuffer.isView(values))) continue
      const v = sampleGridScalarAt(pointWC, values, grid, origin, size)
      series.push({ t, v })
    }
    return series
  }

  const resolvePointDatasetSelection = pointWC => {
    const pd = getPointDataset()
    if (!pd) return null
    const origin = resolvePointDatasetOrigin()
    const size = Array.isArray(pd.size) && pd.size.length >= 3 ? pd.size : [200, 200, 100]
    const points = Array.isArray(pd.points) ? pd.points : []
    if (!origin || points.length < 1) return null
    const nearest = findNearestPointConfig(
      points,
      origin,
      size,
      pointWC,
      ctx.tileset.value,
      resolveTilesetCenterInfo
    )
    if (!nearest) return null
    return { pd, nearest }
  }

  const samplePickedPoint = (pointWC, timeIndex) => {
    const dir = buildDirection()
    const pd = getPointDataset()
    if (pd) {
      const mode = String(pd.renderMode || 'points')
      // IDW/Kriging 插值模式：从场纹理采样（与着色器渲染使用相同数据源）
      if (mode === 'idw' || mode === 'kriging') {
        const fieldValue = sampleScalarAtPoint(pointWC, timeIndex)
        if (fieldValue !== null && Number.isFinite(fieldValue)) {
          return {
            value: fieldValue,
            details: computePointDetailsAtTime(pd, pointWC, timeIndex, dir),
            series: buildSeriesAtPoint(pointWC)
          }
        }
      }
      const selected = resolvePointDatasetSelection(pointWC)
      if (!selected) return { value: null, details: null, series: [] }
      const series = buildPointConfigSeries(
        selected.nearest.point,
        selected.pd,
        ctx.metric.value,
        dir,
        ctx.overlayItems.value
      )
      const idx = Math.max(0, Math.min(series.length - 1, timeIndex))
      return {
        value: series[idx]?.v ?? null,
        details: buildPointConfigDetails(selected.nearest.point, timeIndex, dir),
        series
      }
    }
    return {
      value: sampleScalarAtPoint(pointWC, timeIndex),
      details: computePointDetailsAtTime(getGridDataset(), pointWC, timeIndex, dir),
      series: buildSeriesAtPoint(pointWC)
    }
  }

  const resetPick = () => {
    ctx.pickedPoint.value = null
    ctx.pickedPointValue.value = null
    ctx.pickedPointDetails.value = null
    ctx.pickedPointSeries.value = []
  }

  const getCurrentValueRange = () => {
    const range = ctx.config.value?.field?.data?.valueRange
    if (!Array.isArray(range) || range.length !== 2) return null
    const min = Number(range[0])
    const max = Number(range[1])
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return { min, max }
  }

  const pickPointOnModel = async () => {
    const v = ctx.viewer.value
    if (!v) return null
    const previousCursor = v.canvas?.style?.cursor
    if (v.canvas) v.canvas.style.cursor = 'crosshair'
    return await new Promise(resolve => {
      const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
      const cleanup = result => {
        try {
          handler.destroy()
        } catch (e) {
          warn('stress', 'samplingActions', e)
        }
        if (v.canvas && previousCursor !== undefined) v.canvas.style.cursor = previousCursor || ''
        resolve(result)
      }
      handler.setInputAction(evt => {
        const pos = getPositionFromClick(v, evt.position, ctx.tileset.value)
        if (pos) {
          ctx.pickedPoint.value = pos
          const sampled = samplePickedPoint(pos, ctx.currentTime.value)
          ctx.pickedPointValue.value = sampled.value
          ctx.pickedPointDetails.value = sampled.details
          ctx.pickedPointSeries.value = sampled.series
        }
        cleanup(pos || null)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
      handler.setInputAction(() => cleanup(null), Cesium.ScreenSpaceEventType.RIGHT_CLICK)
    })
  }

  const buildPointSeriesForMetric = (pointWC, metricKey, dirOverride) => {
    const dir = buildDirection(dirOverride)
    if (getPointDataset()) {
      const selected = resolvePointDatasetSelection(pointWC)
      if (!selected) return []
      return buildPointConfigSeries(
        selected.nearest.point,
        selected.pd,
        metricKey,
        dir,
        ctx.overlayItems.value
      )
    }
    const ds = getGridDataset()
    if (!ds) return []
    return buildPointSeriesForMetricCore(pointWC, ds, metricKey, dir)
  }

  const buildPointAllMetricsSeries = (pointWC, dirOverride) => {
    const dir = buildDirection(dirOverride)
    if (getPointDataset()) {
      const selected = resolvePointDatasetSelection(pointWC)
      if (!selected?.nearest?.point?.tensor6) return []
      return buildAllMetricsRowsFromTensor6(selected.nearest.point.tensor6, selected.pd, dir)
    }
    const ds = getGridDataset()
    if (!ds) return []
    return buildPointAllMetricsSeriesCore(pointWC, ds, dir)
  }

  return {
    resetPick,
    samplePickedPoint,
    getCurrentValueRange,
    pickPointOnModel,
    buildPointSeriesForMetric,
    buildPointAllMetricsSeries
  }
}
