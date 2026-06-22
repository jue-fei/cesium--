import * as Cesium from 'cesium'
import {
  cartesianToDegreesIfValid,
  resolvePointCenterCartesian,
  resolvePointCenterDegrees
} from '../interpolation/index.js'
import { DEFAULT_COLOR_RAMP } from './heatmapPalette.js'
import { STRESS_TURBO_RAMP_32 } from './stressColormap.js'
import { clamp01 as clamp01Core } from '../shared/stressActionShared.js'

export function resolveTilesetCenterInfo(tileset) {
  try {
    const localCenter =
      tileset?.boundingSphere?.center ||
      tileset?.boundingSphere3D?.center ||
      tileset?._boundingSphere?.center ||
      tileset?.model?.boundingSphere?.center ||
      tileset?.root?.boundingSphere?.center ||
      tileset?._root?.boundingSphere?.center ||
      null
    if (!localCenter) return null
    const modelMatrix = tileset?.modelMatrix || tileset?.model?.modelMatrix || tileset?._modelMatrix
    const rootTransform = tileset?.root?.transform || tileset?._root?.transform || null
    const transformMatrix =
      modelMatrix && rootTransform
        ? Cesium.Matrix4.multiply(modelMatrix, rootTransform, new Cesium.Matrix4())
        : modelMatrix || rootTransform || null
    const localLen = Cesium.Cartesian3.magnitude(localCenter)
    const isPlausibleEcef = localLen > 4.5e6 && localLen < 7.5e6
    if (transformMatrix) {
      const worldCenter = Cesium.Matrix4.multiplyByPoint(
        transformMatrix,
        localCenter,
        new Cesium.Cartesian3()
      )
      const worldLen = Cesium.Cartesian3.magnitude(worldCenter)
      const worldPlausibleEcef = worldLen > 4.5e6 && worldLen < 7.5e6
      if (worldPlausibleEcef && !isPlausibleEcef) {
        return { mode: 'local+matrix', localCenter, worldCenter, modelMatrix, transformMatrix }
      }
    }
    if (isPlausibleEcef) {
      return {
        mode: 'world',
        localCenter,
        worldCenter: localCenter,
        modelMatrix: null,
        transformMatrix
      }
    }
    if (!transformMatrix) {
      return {
        mode: 'local',
        localCenter,
        worldCenter: null,
        modelMatrix: null,
        transformMatrix: null
      }
    }
    const worldCenter = Cesium.Matrix4.multiplyByPoint(
      transformMatrix,
      localCenter,
      new Cesium.Cartesian3()
    )
    const worldLen = Cesium.Cartesian3.magnitude(worldCenter)
    const worldPlausibleEcef = worldLen > 4.5e6 && worldLen < 7.5e6
    if (worldPlausibleEcef) {
      return { mode: 'local+matrix', localCenter, worldCenter, modelMatrix, transformMatrix }
    }
    return { mode: 'local', localCenter, worldCenter: null, modelMatrix, transformMatrix }
  } catch (e) {
    return null
  }
}

export function resolveOriginFromModelCenter(tileset) {
  try {
    const info = resolveTilesetCenterInfo(tileset)
    const center = info?.worldCenter
    if (!center) return null
    return cartesianToDegreesIfValid(center)
  } catch (e) {
    return null
  }
}

export function resolveTilesetRadius(tileset) {
  try {
    const r =
      tileset?.boundingSphere?.radius ||
      tileset?.boundingSphere3D?.radius ||
      tileset?._boundingSphere?.radius ||
      tileset?.model?.boundingSphere?.radius ||
      tileset?.root?.boundingSphere?.radius ||
      tileset?._root?.boundingSphere?.radius ||
      null
    return Number.isFinite(r) && r > 0 ? Number(r) : null
  } catch (e) {
    return null
  }
}

export function resolveOriginFromViewer(viewer) {
  try {
    const v = viewer
    if (!v?.scene || !v?.camera) return null
    const canvas = v.scene.canvas
    const cx = Math.floor((canvas?.clientWidth || 0) * 0.5)
    const cy = Math.floor((canvas?.clientHeight || 0) * 0.5)
    let pos = null
    if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) {
      pos = v.camera.pickEllipsoid(new Cesium.Cartesian2(cx, cy), v.scene.globe.ellipsoid)
    }
    if (!pos) {
      const cartoCam = v.camera.positionCartographic
      if (!cartoCam) return null
      const lon = Cesium.Math.toDegrees(cartoCam.longitude)
      const lat = Cesium.Math.toDegrees(cartoCam.latitude)
      const h = cartoCam.height || 0
      if (![lon, lat, h].every(Number.isFinite)) return null
      return [lon, lat, h]
    }
    return cartesianToDegreesIfValid(pos)
  } catch (e) {
    return null
  }
}

export function computeRadiusScaleFactor(tileset, size) {
  const baseSize =
    Array.isArray(size) && size.length >= 3 ? Math.min(size[0], size[1], size[2]) : null
  if (!(Number.isFinite(baseSize) && baseSize > 0)) return 1
  try {
    const r = resolveTilesetRadius(tileset)
    if (!(Number.isFinite(r) && r > 0)) return 1
    const diameter = r * 2
    const raw = diameter / baseSize
    return Math.max(0.5, Math.min(10, raw))
  } catch (e) {
    return 1
  }
}

export function resolveModelCoverSize(tileset, size, { padding = 1.08 } = {}) {
  const normalizedPadding = Number.isFinite(Number(padding)) ? Math.max(1, Number(padding)) : 1.08
  const diameter = (resolveTilesetRadius(tileset) || 0) * 2 * normalizedPadding
  const base =
    Array.isArray(size) && size.length >= 3
      ? size.slice(0, 3).map(value => {
          const n = Number(value)
          return Number.isFinite(n) && n > 0 ? n : null
        })
      : [null, null, null]
  if (!(diameter > 0)) {
    return base.every(Number.isFinite) ? base : null
  }
  return base.map(value => Math.max(Number.isFinite(value) ? value : 0, diameter))
}

const DEFAULT_SHADER_STYLE = Object.freeze({
  diffuseMix: 0.88,
  emissiveMix: 0.72,
  cutoff: 0.04,
  lowRangeOpacity: 0.12,
  fieldMaskMode: 'none',
  fieldMaskPower: 2.2,
  contourEnabled: false,
  contourLevels: 24,
  contourWidth: 0.015,
  glowEnabled: false,
  glowThreshold: 0.8,
  glowStrength: 0.35,
  markerEnabled: false,
  markerRadius: 6
})

export const clamp01 = clamp01Core

function mixChannel(a, b, t) {
  return Math.round(a + (b - a) * t)
}

// ---- CIELAB 色彩空间转换（感知均匀插值） ----

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function linearToSrgb(v) {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.round(Math.max(0, Math.min(1, c)) * 255)
}

// D65 白点
const D65_X = 0.95047
const D65_Y = 1.0
const D65_Z = 1.08883

function rgb2xyz(r, g, b) {
  const rl = srgbToLinear(r)
  const gl = srgbToLinear(g)
  const bl = srgbToLinear(b)
  return [
    (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) * 100,
    (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) * 100,
    (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) * 100
  ]
}

function xyz2lab(x, y, z) {
  const fx = x / (D65_X * 100)
  const fy = y / (D65_Y * 100)
  const fz = z / (D65_Z * 100)
  const k = 6 / 29
  const k3 = k * k * k
  const f = v => (v > k3 ? Math.cbrt(v) : v / (3 * k * k) + 4 / 29)
  return [116 * f(fy) - 16, 500 * (f(fx) - f(fy)), 200 * (f(fy) - f(fz))]
}

function lab2xyz(L, a, b) {
  const fy = (L + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200
  const k = 6 / 29
  const g = v => (v > k ? v * v * v : 3 * k * k * (v - 4 / 29))
  return [g(fx) * D65_X * 100, g(fy) * D65_Y * 100, g(fz) * D65_Z * 100]
}

function xyz2rgb(x, y, z) {
  const xl = x / 100
  const yl = y / 100
  const zl = z / 100
  return [
    linearToSrgb(3.2404542 * xl - 1.5371385 * yl - 0.4985314 * zl),
    linearToSrgb(-0.969266 * xl + 1.8760108 * yl + 0.041556 * zl),
    linearToSrgb(0.0556434 * xl - 0.2040259 * yl + 1.0572252 * zl)
  ]
}

/** 在 CIELAB 空间中做感知均匀的颜色插值 */
function lerpCIELAB(rgbaA, rgbaB, t) {
  const xyzA = rgb2xyz(rgbaA[0], rgbaA[1], rgbaA[2])
  const xyzB = rgb2xyz(rgbaB[0], rgbaB[1], rgbaB[2])
  const labA = xyz2lab(xyzA[0], xyzA[1], xyzA[2])
  const labB = xyz2lab(xyzB[0], xyzB[1], xyzB[2])
  const L = labA[0] + (labB[0] - labA[0]) * t
  const aa = labA[1] + (labB[1] - labA[1]) * t
  const bb = labA[2] + (labB[2] - labA[2]) * t
  const xyz = lab2xyz(L, aa, bb)
  const rgb = xyz2rgb(xyz[0], xyz[1], xyz[2])
  return [rgb[0], rgb[1], rgb[2], Math.round(rgbaA[3] + (rgbaB[3] - rgbaA[3]) * t)]
}

function ensureRampStops(ramp) {
  const normalized = (Array.isArray(ramp) && ramp.length >= 2 ? ramp : DEFAULT_COLOR_RAMP)
    .map((row, idx) => {
      const fallback = DEFAULT_COLOR_RAMP[Math.min(idx, DEFAULT_COLOR_RAMP.length - 1)]
      const color = Cesium.Color.fromCssColorString(String(row?.color || fallback.color))
      return {
        value: clamp01(Number(row?.value ?? fallback.value)),
        rgba: [
          Math.round(color.red * 255),
          Math.round(color.green * 255),
          Math.round(color.blue * 255),
          Math.round((Number.isFinite(color.alpha) ? color.alpha : 1) * 255)
        ]
      }
    })
    .sort((a, b) => a.value - b.value)

  const first = normalized[0]
  const last = normalized[normalized.length - 1]
  const stops = normalized.slice()
  if (first.value > 0) {
    stops.unshift({ value: 0, rgba: [...first.rgba] })
  } else {
    stops[0] = { value: 0, rgba: [...first.rgba] }
  }
  if (last.value < 1) {
    stops.push({ value: 1, rgba: [...last.rgba] })
  } else {
    stops[stops.length - 1] = { value: 1, rgba: [...last.rgba] }
  }
  return stops
}

/**
 * 从色带数组构建 LUT 规格
 * @param {Array} ramp 色带数组 [{value, color}, ...]
 * @param {number|{size?: number, colorSpace?: 'rgb'|'cielab'}} sizeOrOptions
 *    - number: 保持兼容旧调用，LUT 大小
 *    - object: { size, colorSpace }，colorSpace='cielab' 时使用感知均匀插值
 */
export function buildColorLUTSpecFromRamp(ramp, sizeOrOptions = 256) {
  const lutSize =
    typeof sizeOrOptions === 'object'
      ? Number.isInteger(sizeOrOptions.size) && sizeOrOptions.size >= 2
        ? sizeOrOptions.size
        : 256
      : Number.isInteger(sizeOrOptions) && sizeOrOptions >= 2
        ? sizeOrOptions
        : 256
  const colorSpace =
    typeof sizeOrOptions === 'object' && sizeOrOptions.colorSpace === 'cielab' ? 'cielab' : 'rgb'
  const stops = ensureRampStops(ramp)
  const table = []
  let stopIdx = 0
  for (let i = 0; i < lutSize; i++) {
    const t = lutSize === 1 ? 0 : i / (lutSize - 1)
    while (stopIdx < stops.length - 2 && t > stops[stopIdx + 1].value) {
      stopIdx += 1
    }
    const left = stops[stopIdx]
    const right = stops[Math.min(stopIdx + 1, stops.length - 1)]
    const span = Math.max(1e-6, right.value - left.value)
    const localT = clamp01((t - left.value) / span)
    if (colorSpace === 'cielab') {
      table.push(lerpCIELAB(left.rgba, right.rgba, localT))
    } else {
      table.push([
        mixChannel(left.rgba[0], right.rgba[0], localT),
        mixChannel(left.rgba[1], right.rgba[1], localT),
        mixChannel(left.rgba[2], right.rgba[2], localT),
        mixChannel(left.rgba[3], right.rgba[3], localT)
      ])
    }
  }
  return { preset: 'custom', size: lutSize, table, colorSpace }
}

export function buildDefaultStressColorLUT(size = 256, colorSpace = 'cielab') {
  return buildColorLUTSpecFromRamp(STRESS_TURBO_RAMP_32, { size, colorSpace })
}

export function normalizeHeatmapDisplay(raw) {
  const contrast = Number.isFinite(Number(raw?.contrast)) ? Number(raw.contrast) : 1.0
  const gamma = Number.isFinite(Number(raw?.gamma)) ? Number(raw.gamma) : 0.65
  const cutoff = Number.isFinite(Number(raw?.cutoff)) ? Number(raw.cutoff) : 0.04
  const lowRangeOpacity = Number.isFinite(Number(raw?.lowRangeOpacity))
    ? Number(raw.lowRangeOpacity)
    : 0.12
  const forceVisible = Number.isFinite(Number(raw?.forceVisible)) ? Number(raw.forceVisible) : 0.18
  const diffuseMix = Number.isFinite(Number(raw?.diffuseMix)) ? Number(raw.diffuseMix) : 0.88
  const emissiveMix = Number.isFinite(Number(raw?.emissiveMix)) ? Number(raw.emissiveMix) : 0.72
  const anchorToModel = raw?.anchorToModel !== undefined ? Boolean(raw.anchorToModel) : true
  const blendModeRaw = String(raw?.blendMode || 'max')
  const blendMode =
    blendModeRaw === 'add' || blendModeRaw === 'overlay' || blendModeRaw === 'max'
      ? blendModeRaw
      : 'max'
  const maskModeRaw = String(raw?.maskMode || 'none')
  const maskMode = maskModeRaw === 'points' ? 'points' : 'none'
  const enableContour = raw?.enableContour !== undefined ? Boolean(raw.enableContour) : false
  const contourLevels = Number.isFinite(Number(raw?.contourLevels))
    ? Math.max(2, Math.min(40, Number(raw.contourLevels)))
    : 24
  const contourWidth = Number.isFinite(Number(raw?.contourWidth))
    ? Math.max(0.003, Math.min(0.12, Number(raw.contourWidth)))
    : 0.015
  const enableGlow = raw?.enableGlow !== undefined ? Boolean(raw.enableGlow) : false
  const enableMarker = raw?.enableMarker !== undefined ? Boolean(raw.enableMarker) : false
  return {
    contrast: Math.max(0.6, Math.min(2.8, contrast)),
    gamma: Math.max(0.45, Math.min(2.4, gamma)),
    cutoff: Math.max(0, Math.min(0.25, cutoff)),
    lowRangeOpacity: Math.max(0, Math.min(0.6, lowRangeOpacity)),
    forceVisible: clamp01(forceVisible),
    diffuseMix: clamp01(diffuseMix),
    emissiveMix: clamp01(emissiveMix),
    anchorToModel,
    blendMode,
    maskMode,
    enableContour,
    contourLevels,
    contourWidth,
    enableGlow,
    enableMarker
  }
}

export function cloneColorRamp(ramp) {
  const fallbackRamp = STRESS_TURBO_RAMP_32
  const source =
    Array.isArray(ramp) && ramp.length >= 4
      ? ramp
      : [...(Array.isArray(ramp) ? ramp : []), ...fallbackRamp].slice(0, fallbackRamp.length)
  return source.map((r, idx) => ({
    value: clamp01(Number(r?.value ?? fallbackRamp[Math.min(idx, fallbackRamp.length - 1)].value)),
    color: String(r?.color || fallbackRamp[Math.min(idx, fallbackRamp.length - 1)].color),
    label:
      r?.label !== undefined
        ? String(r.label)
        : fallbackRamp[Math.min(idx, fallbackRamp.length - 1)].label
  }))
}

export function buildAdjustedColorRamp(baseRamp, display) {
  const ramp = cloneColorRamp(baseRamp)
  const tuned = normalizeHeatmapDisplay(display)
  const n = ramp.length
  // 自适应最小间距：色标越多间距越小，避免累计挤压
  const minGap = n <= 8 ? 0.035 : n <= 12 ? 0.022 : 0.014
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
    diffuseMix: normalized.diffuseMix,
    emissiveMix: normalized.emissiveMix,
    cutoff: normalized.cutoff,
    lowRangeOpacity: normalized.lowRangeOpacity,
    forceVisible: normalized.forceVisible,
    anchorToModel: normalized.anchorToModel,
    fieldMaskMode: normalized.maskMode,
    contourEnabled: Boolean(normalized.enableContour),
    contourLevels: normalized.contourLevels,
    contourWidth: normalized.contourWidth,
    glowEnabled: Boolean(normalized.enableGlow),
    markerEnabled: Boolean(normalized.enableMarker)
  }
  configObj.blendMode = normalized.blendMode
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
      colorRamp: cloneColorRamp(STRESS_TURBO_RAMP_32),
      colorLUT: buildDefaultStressColorLUT(),
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
  const sourceStrategy = options?.sourceStrategy === 'full' ? 'full' : 'top4'
  const tileset = options?.tileset
  const modelRadius = resolveTilesetRadius(tileset)
  const minVisibleRadius =
    Number.isFinite(modelRadius) && modelRadius > 0 ? Math.max(12, modelRadius * 0.03) : 12
  const sources = (ds.points || []).slice(0, 1000).map(p => {
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
    colorRamp: cloneColorRamp(STRESS_TURBO_RAMP_32),
    colorLUT: buildDefaultStressColorLUT(),
    style: {
      ...DEFAULT_SHADER_STYLE,
      cutoff: 0.04,
      fieldMaskPower: 2.2,
      useSourceTexture: sourceStrategy === 'full' && (ds.points || []).length > 32,
      sourceLimit: sourceStrategy === 'full' ? 1000 : 32
    },
    sources
  }
}

export function buildShaderConfigFromScalarField(ds, scalarField, { unitStress, render, metric }) {
  const sources = buildSourcesFromHeatmapPoints(ds, render?.heatmapPoints)
  const mask = render?.heatmapMask || null
  const derived = render?.heatmapDerived || null
  const display = normalizeHeatmapDisplay({
    ...render?.heatmapDisplay,
    cutoff:
      render?.heatmapDisplay?.cutoff !== undefined ? render.heatmapDisplay.cutoff : mask?.cutoff,
    maskMode:
      render?.heatmapDisplay?.maskMode !== undefined ? render.heatmapDisplay.maskMode : mask?.mode,
    enableContour:
      render?.heatmapDisplay?.enableContour !== undefined
        ? render.heatmapDisplay.enableContour
        : derived?.contour?.enabled,
    enableGlow:
      render?.heatmapDisplay?.enableGlow !== undefined
        ? render.heatmapDisplay.enableGlow
        : derived?.glow?.enabled,
    enableMarker:
      render?.heatmapDisplay?.enableMarker !== undefined
        ? render.heatmapDisplay.enableMarker
        : derived?.marker?.enabled,
    diffuseMix: Number.isFinite(render?.diffuseMix)
      ? render.diffuseMix
      : render?.heatmapDisplay?.diffuseMix,
    emissiveMix: Number.isFinite(render?.emissiveMix)
      ? render.emissiveMix
      : render?.heatmapDisplay?.emissiveMix
  })
  const colorRamp = cloneColorRamp(
    Array.isArray(render?.colorRamp) && render.colorRamp.length >= 4 ? render.colorRamp : null
  )
  return {
    blendMode: display.blendMode,
    colorRamp,
    colorLUT: render?.colorLUT || buildColorLUTSpecFromRamp(colorRamp),
    style: {
      diffuseMix: display.diffuseMix,
      emissiveMix: display.emissiveMix,
      useSourceTexture: true,
      sourceLimit: 1000,
      cutoff: display.cutoff,
      anchorToModel: display.anchorToModel,
      forceVisible: display.forceVisible,
      fieldMaskMode: display.maskMode,
      fieldMaskPower: Number.isFinite(mask?.power)
        ? Math.max(0.1, mask.power)
        : DEFAULT_SHADER_STYLE.fieldMaskPower,
      contourEnabled: Boolean(display.enableContour),
      contourLevels: Number.isFinite(display.contourLevels)
        ? Math.max(2, Math.min(40, display.contourLevels))
        : Number.isFinite(derived?.contour?.levels)
          ? Math.max(2, derived.contour.levels)
          : DEFAULT_SHADER_STYLE.contourLevels,
      contourWidth: Number.isFinite(display.contourWidth)
        ? Math.max(0.003, Math.min(0.12, display.contourWidth))
        : Number.isFinite(derived?.contour?.width)
          ? Math.max(0.003, Math.min(0.12, derived.contour.width))
          : DEFAULT_SHADER_STYLE.contourWidth,
      glowEnabled: Boolean(display.enableGlow),
      glowThreshold: Number.isFinite(derived?.glow?.threshold)
        ? Math.max(0, Math.min(1, derived.glow.threshold))
        : DEFAULT_SHADER_STYLE.glowThreshold,
      glowStrength: Number.isFinite(derived?.glow?.strength)
        ? Math.max(0, Math.min(1, derived.glow.strength))
        : DEFAULT_SHADER_STYLE.glowStrength,
      markerEnabled: Boolean(display.enableMarker),
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
        metric: String(metric || ''),
        unitStress,
        material: ds.material || null,
        safetyContext: ds.safetyContext || null
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
    .slice(0, 1000)

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
