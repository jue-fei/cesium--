import * as Cesium from 'cesium'
import {
  resolvePointCenterCartesian,
  resolvePointCenterDegrees
} from '../points/stressPointCore.js'
import { resolveTilesetCenterInfo, resolveTilesetRadius } from './stressRenderRuntime.js'

export {
  computeRadiusScaleFactor,
  emitConsoleRenderProbe,
  resolveOriginFromModelCenter,
  resolveOriginFromViewer,
  resolveRuntimeRenderHints,
  resolveTilesetCenterInfo,
  resolveTilesetRadius,
  toCartesian3IfValid,
  toSimpleCartesian
} from './stressRenderRuntime.js'

const DEFAULT_COLOR_RAMP = Object.freeze([
  { value: 0.2, color: '#0000ff', label: '低' },
  { value: 0.5, color: '#00ff00', label: '中' },
  { value: 0.8, color: '#ff7f00', label: '高' },
  { value: 1.0, color: '#ff0000', label: '极高' }
])

const DEFAULT_SHADER_STYLE = Object.freeze({
  diffuseMix: 0.85,
  emissiveMix: 0.75,
  cutoff: 0.02,
  fieldMaskMode: 'none',
  fieldMaskPower: 2,
  contourEnabled: false,
  contourLevels: 12,
  contourWidth: 0.06,
  glowEnabled: false,
  glowThreshold: 0.8,
  glowStrength: 0.35,
  markerEnabled: false,
  markerRadius: 6
})

export function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

export function normalizeHeatmapDisplay(raw) {
  const contrast = Number.isFinite(Number(raw?.contrast)) ? Number(raw.contrast) : 1.9
  const gamma = Number.isFinite(Number(raw?.gamma)) ? Number(raw.gamma) : 0.72
  const cutoff = Number.isFinite(Number(raw?.cutoff)) ? Number(raw.cutoff) : 0
  const forceVisible = Number.isFinite(Number(raw?.forceVisible)) ? Number(raw.forceVisible) : 0.82
  const enableContour = raw?.enableContour !== undefined ? Boolean(raw.enableContour) : false
  const enableGlow = raw?.enableGlow !== undefined ? Boolean(raw.enableGlow) : false
  const enableMarker = raw?.enableMarker !== undefined ? Boolean(raw.enableMarker) : false
  return {
    contrast: Math.max(0.6, Math.min(2.8, contrast)),
    gamma: Math.max(0.45, Math.min(2.4, gamma)),
    cutoff: Math.max(0, Math.min(0.25, cutoff)),
    forceVisible: clamp01(forceVisible),
    enableContour,
    enableGlow,
    enableMarker
  }
}

export function cloneColorRamp(ramp) {
  return [...(Array.isArray(ramp) ? ramp : []), ...DEFAULT_COLOR_RAMP]
    .slice(0, 4)
    .map((r, idx) => ({
      value: clamp01(Number(r?.value ?? DEFAULT_COLOR_RAMP[idx].value)),
      color: String(r?.color || DEFAULT_COLOR_RAMP[idx].color),
      label: r?.label !== undefined ? String(r.label) : DEFAULT_COLOR_RAMP[idx].label
    }))
}

export function buildAdjustedColorRamp(baseRamp, display) {
  const ramp = cloneColorRamp(baseRamp)
  const tuned = normalizeHeatmapDisplay(display)
  const minGap = 0.03
  const values = ramp.map((r, idx) => {
    const base = clamp01(Number(r.value))
    if (idx === ramp.length - 1) return 1
    const c = clamp01(0.5 + (base - 0.5) * tuned.contrast)
    return clamp01(Math.pow(c, tuned.gamma))
  })
  for (let i = 1; i < values.length; i++) {
    values[i] = Math.max(values[i], values[i - 1] + minGap)
  }
  if (values[values.length - 1] > 1) {
    const first = values[0]
    const span = values[values.length - 1] - first
    if (span > 1e-6) {
      const scale = (1 - first) / span
      for (let i = 1; i < values.length; i++) {
        values[i] = first + (values[i] - first) * scale
      }
    }
  }
  values[values.length - 1] = 1
  for (let i = values.length - 2; i >= 0; i--) {
    values[i] = Math.min(values[i], values[i + 1] - minGap)
  }
  values[0] = clamp01(values[0])
  for (let i = 1; i < values.length; i++) {
    values[i] = clamp01(Math.max(values[i], values[i - 1] + minGap))
  }
  values[values.length - 1] = 1
  return ramp.map((r, idx) => ({ ...r, value: values[idx] }))
}

export function applyHeatmapDisplayToConfigObject(configObj, baseRamp, display) {
  if (!configObj || typeof configObj !== 'object') {
    return { baseRamp: cloneColorRamp(baseRamp), display: normalizeHeatmapDisplay(display) }
  }
  const normalized = normalizeHeatmapDisplay(display)
  const resolvedBaseRamp =
    Array.isArray(baseRamp) && baseRamp.length >= 4
      ? cloneColorRamp(baseRamp)
      : cloneColorRamp(configObj?.colorRamp)

  configObj.colorRamp = buildAdjustedColorRamp(resolvedBaseRamp, normalized)
  const style = configObj.style || {}
  configObj.style = {
    ...style,
    cutoff: normalized.cutoff,
    forceVisible: normalized.forceVisible,
    contourEnabled: Boolean(normalized.enableContour),
    glowEnabled: Boolean(normalized.enableGlow),
    markerEnabled: Boolean(normalized.enableMarker)
  }
  return { baseRamp: resolvedBaseRamp, display: normalized }
}

export function buildDefaultStressConfig(
  normalized,
  {
    metric = 'von_mises',
    direction = [1, 0, 0],
    directionMode = 'global',
    smooth = 1.0,
    opacity = 0.95
  } = {}
) {
  if (!normalized || typeof normalized !== 'object') {
    return {
      time: { frames: 1, dimension: '秒', speedMs: 500 },
      blendMode: 'max',
      colorRamp: cloneColorRamp(DEFAULT_COLOR_RAMP),
      colorLUT: { preset: 'Jet', size: 256, table: null },
      style: { ...DEFAULT_SHADER_STYLE, cutoff: 0.04, fieldMaskPower: 2.2 },
      sources: []
    }
  }
  return {
    origin: normalized.origin,
    originMode: normalized.originMode || '数值',
    size: normalized.size,
    grid: normalized.grid,
    time: normalized.time,
    material: normalized.material,
    data: normalized.data,
    unitStress: normalized.unitStress || 'MPa',
    defaultMetric: metric,
    pointOptions: { smooth, opacity, direction, directionMode }
  }
}

export function buildHeatmapConfigFromPointDataset(ds, options = {}) {
  const time = ds.time || { frames: 1, speedMs: 500, dimension: '秒' }
  const size = Array.isArray(ds.size) && ds.size.length >= 3 ? ds.size : [200, 200, 100]
  const radiusScaleFactor = Number(options?.radiusScaleFactor) || 1
  const tileset = options?.tileset
  const modelRadius = resolveTilesetRadius(tileset)
  const minVisibleRadius =
    Number.isFinite(modelRadius) && modelRadius > 0 ? Math.max(12, modelRadius * 0.03) : 12
  const sources = (ds.points || []).slice(0, 100).map(p => {
    const center = resolvePointCenterDegrees(p, ds.origin, size, tileset, resolveTilesetCenterInfo)
    const centerCartesian = resolvePointCenterCartesian(
      p,
      ds.origin,
      size,
      tileset,
      resolveTilesetCenterInfo
    )
    const radiusBase = Number(p.radius) || Math.max(10, Math.min(size[0], size[1], size[2]) * 0.1)
    return {
      id: p.id || '',
      name: p.name || '',
      center,
      centerCartesian,
      radius: Math.max(minVisibleRadius, radiusBase * radiusScaleFactor),
      base: 1,
      timeSeries: Array.isArray(p.timeSeries) ? p.timeSeries : [],
      radiusSeries: scaleRadiusSeries(p.radiusSeries, minVisibleRadius, radiusScaleFactor)
    }
  })
  return {
    time: { frames: time.frames, dimension: time.dimension, speedMs: time.speedMs },
    blendMode: 'max',
    colorRamp: cloneColorRamp(DEFAULT_COLOR_RAMP),
    colorLUT: { preset: 'Jet', size: 256, table: null },
    style: { ...DEFAULT_SHADER_STYLE, cutoff: 0.01, fieldMaskPower: 2.2 },
    sources
  }
}

export function buildShaderConfigFromScalarField(ds, scalarField, { unitStress, render }) {
  const colorRamp = cloneColorRamp(
    Array.isArray(render?.colorRamp) && render.colorRamp.length >= 4 ? render.colorRamp : null
  )
  const sources = buildSourcesFromHeatmapPoints(ds, render?.heatmapPoints)
  const mask = render?.heatmapMask || null
  const derived = render?.heatmapDerived || null
  return {
    blendMode: 'max',
    colorRamp,
    colorLUT: render?.colorLUT || null,
    style: {
      diffuseMix: Number.isFinite(render?.diffuseMix)
        ? render.diffuseMix
        : DEFAULT_SHADER_STYLE.diffuseMix,
      emissiveMix: Number.isFinite(render?.emissiveMix)
        ? render.emissiveMix
        : DEFAULT_SHADER_STYLE.emissiveMix,
      cutoff: Number.isFinite(mask?.cutoff) ? Math.max(0, Math.min(0.95, mask.cutoff)) : 0.02,
      fieldMaskMode: mask?.mode === 'points' ? 'points' : 'none',
      fieldMaskPower: Number.isFinite(mask?.power)
        ? Math.max(0.1, mask.power)
        : DEFAULT_SHADER_STYLE.fieldMaskPower,
      contourEnabled: Boolean(derived?.contour?.enabled),
      contourLevels: Number.isFinite(derived?.contour?.levels)
        ? Math.max(2, derived.contour.levels)
        : DEFAULT_SHADER_STYLE.contourLevels,
      contourWidth: Number.isFinite(derived?.contour?.width)
        ? Math.max(0.005, Math.min(0.2, derived.contour.width))
        : DEFAULT_SHADER_STYLE.contourWidth,
      glowEnabled: derived?.glow?.enabled !== undefined ? Boolean(derived.glow.enabled) : false,
      glowThreshold: Number.isFinite(derived?.glow?.threshold)
        ? Math.max(0, Math.min(1, derived.glow.threshold))
        : DEFAULT_SHADER_STYLE.glowThreshold,
      glowStrength: Number.isFinite(derived?.glow?.strength)
        ? Math.max(0, Math.min(1, derived.glow.strength))
        : DEFAULT_SHADER_STYLE.glowStrength,
      markerEnabled:
        derived?.marker?.enabled !== undefined ? Boolean(derived.marker.enabled) : false,
      markerRadius: Number.isFinite(derived?.marker?.radius)
        ? Math.max(0.1, derived.marker.radius)
        : DEFAULT_SHADER_STYLE.markerRadius
    },
    time: {
      frames: ds.time.frames,
      dimension: ds.time.dimension,
      speedMs: ds.time.speedMs
    },
    field: {
      type: 'grid',
      combine: sources.length > 0 ? 'max' : 'replace',
      data: {
        grid: { width: ds.grid.width, height: ds.grid.height, depth: ds.grid.depth },
        origin: ds.origin,
        size: ds.size,
        frames: scalarField.frames,
        valueRange: scalarField.valueRange,
        timePoints: scalarField.timePoints,
        unitStress
      }
    },
    sources
  }
}

export function buildSourcesFromHeatmapPoints(ds, points) {
  if (!ds || !Array.isArray(points) || points.length === 0) return []
  if (!Array.isArray(ds.origin) || ds.origin.length < 2) return []
  if (!Array.isArray(ds.size) || ds.size.length < 3) return []
  const originCart = Cesium.Cartesian3.fromDegrees(ds.origin[0], ds.origin[1], ds.origin[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(originCart)
  const sx = Number(ds.size[0]) || 0
  const sy = Number(ds.size[1]) || 0
  const sz = Number(ds.size[2]) || 0
  const ranked = points
    .map((p, idx) => ({ p, idx, score: resolveSourceScore(p) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, 8)

  const out = []
  for (const item of ranked) {
    const p = item.p
    if (!p || typeof p !== 'object') continue
    const base = Number(p.base)
    const radius = Number(p.radius)
    if (!Number.isFinite(base) || base < 0) continue
    if (!Number.isFinite(radius) || radius <= 0) continue
    const centerDeg = resolveSourceCenterDegrees(p, localToWorld, sx, sy, sz)
    if (!centerDeg) continue
    out.push({
      id: String(p.id || ''),
      name: String(p.name || ''),
      center: centerDeg,
      radius,
      base,
      timeSeries: Array.isArray(p.timeSeries) ? p.timeSeries : []
    })
  }
  return out
}

export function buildCacheKey(metric, azimuth, dip) {
  if (typeof metric === 'object' && metric !== null) {
    const m = String(metric.metric || 'von_mises')
    if (m !== 'snn' && m !== 'tau_n') return m
    return `${m}:${Number(metric.azimuth) || 0}:${Number(metric.dip) || 0}`
  }
  if (metric !== 'snn' && metric !== 'tau_n') return metric
  return `${metric}:${Number(azimuth) || 0}:${Number(dip) || 0}`
}

export function scaleRadiusSeries(series, minVisibleRadius, radiusScaleFactor) {
  if (!Array.isArray(series)) return []
  return series.map(value => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(minVisibleRadius, n * radiusScaleFactor) : 0
  })
}

function resolveSourceCenterDegrees(p, localToWorld, sx, sy, sz) {
  if (p.coordMode === 'WGS84' && Array.isArray(p.center) && p.center.length >= 2) {
    const lon = Number(p.center[0])
    const lat = Number(p.center[1])
    const h = Number(p.center[2] || 0)
    if (Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(h)) return [lon, lat, h]
    return null
  }
  if (p.coordMode === 'ENU' && Array.isArray(p.center) && p.center.length >= 3) {
    const x = Number(p.center[0])
    const y = Number(p.center[1])
    const z = Number(p.center[2])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return toDegreesByOffset(localToWorld, x, y, z)
  }
  if (p.coordMode === 'UVW' && Array.isArray(p.center) && p.center.length >= 3) {
    const u = Number(p.center[0])
    const v = Number(p.center[1])
    const w = Number(p.center[2])
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(w)) return null
    return toDegreesByOffset(
      localToWorld,
      (Math.max(0, Math.min(1, u)) - 0.5) * sx,
      (Math.max(0, Math.min(1, v)) - 0.5) * sy,
      (Math.max(0, Math.min(1, w)) - 0.5) * sz
    )
  }
  return null
}

function toDegreesByOffset(localToWorld, x, y, z) {
  const world = Cesium.Matrix4.multiplyByPoint(
    localToWorld,
    new Cesium.Cartesian3(x, y, z),
    new Cesium.Cartesian3()
  )
  const carto = Cesium.Cartographic.fromCartesian(world)
  return [
    Cesium.Math.toDegrees(carto.longitude),
    Cesium.Math.toDegrees(carto.latitude),
    carto.height || 0
  ]
}

function resolveSourceScore(p) {
  const base = Number(p?.base)
  const ts = Array.isArray(p?.timeSeries) ? p.timeSeries : []
  let peak = 0
  for (let i = 0; i < ts.length; i++) {
    const n = Number(ts[i])
    if (Number.isFinite(n) && n > peak) peak = n
  }
  return Math.max(0, Number.isFinite(base) ? base : 0) * Math.max(1, peak)
}
