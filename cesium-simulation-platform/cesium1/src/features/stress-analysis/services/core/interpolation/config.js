/**
 * 插值模块公共配置与基础工具。
 *
 * 这里沉淀被多个历史模块重复实现的数值规范化、数组解析和各向异性距离计算，
 * 供新聚合入口与旧兼容模块同时复用，避免在低风险优化阶段改变外部行为。
 */

import {
  eigenvaluesSymmetric3,
  computeMetricValue,
  computeDirectionalTraction,
  buildDirectionVector
} from '../computation/index.js'
import { stressFromStrainTensor } from '../shared/stressActionShared.js'
import {
  toFiniteNumber,
  clampInt,
  clamp01,
  ensureArray,
  parseSizeArray
} from '../shared/stressMathUtils.js'

export function createAnisotropyParams(scaleX, scaleY, scaleZ, angle) {
  return {
    scaleX: Math.max(1e-6, toFiniteNumber(scaleX, 1)),
    scaleY: Math.max(1e-6, toFiniteNumber(scaleY, 1)),
    scaleZ: Math.max(1e-6, toFiniteNumber(scaleZ, 1)),
    angle: toFiniteNumber(angle, 0)
  }
}

export function resolveAnisotropyParams(options) {
  const input =
    options &&
    typeof options === 'object' &&
    options.anisotropy &&
    typeof options.anisotropy === 'object'
      ? options.anisotropy
      : options
  if (!input || typeof input !== 'object') return null

  return createAnisotropyParams(input.scaleX, input.scaleY, input.scaleZ, input.angle)
}

export function resolveDefaultGrid(size, targetResolution = 48, maxGrid = null) {
  const [sx, sy, sz] = parseSizeArray(size)
  const base = Math.max(1, Math.min(sx, sy, sz))
  const target = clampInt(targetResolution, 16, 120)
  const grid = {
    width: clampInt((sx / base) * target, 16, maxGrid?.width || 160),
    height: clampInt((sy / base) * target, 16, maxGrid?.height || 160),
    depth: clampInt((sz / base) * Math.max(10, target * 0.6), 10, maxGrid?.depth || 96)
  }
  return grid
}

export function computeAnisotropicDistanceSquared(dx, dy, dz, anisotropyParams) {
  if (!anisotropyParams) {
    return dx * dx + dy * dy + dz * dz
  }

  const scaleX = Math.max(1e-6, anisotropyParams.scaleX || 1)
  const scaleY = Math.max(1e-6, anisotropyParams.scaleY || 1)
  const scaleZ = Math.max(1e-6, anisotropyParams.scaleZ || 1)
  const angle = anisotropyParams.angle || 0

  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const rx = dx * cosA + dy * sinA
  const ry = -dx * sinA + dy * cosA
  const rz = dz

  const nx = rx / scaleX
  const ny = ry / scaleY
  const nz = rz / scaleZ
  return nx * nx + ny * ny + nz * nz
}

export function computeAnisotropicDistance(dx, dy, dz, anisotropyParams) {
  return Math.sqrt(computeAnisotropicDistanceSquared(dx, dy, dz, anisotropyParams))
}

export function extractTensor6Arrays(tensor6) {
  return {
    xx: ensureArray(tensor6?.xx),
    yy: ensureArray(tensor6?.yy),
    zz: ensureArray(tensor6?.zz),
    xy: ensureArray(tensor6?.xy),
    yz: ensureArray(tensor6?.yz),
    zx: ensureArray(tensor6?.zx)
  }
}

export function getTensor6FrameCount(tensor6) {
  const { xx, yy, zz, xy, yz, zx } = extractTensor6Arrays(tensor6)
  return Math.min(xx.length, yy.length, zz.length, xy.length, yz.length, zx.length)
}

// ============ Sampling functions (merged from sampling.js) ============

const TENSOR6_KEYS = ['xx', 'yy', 'zz', 'xy', 'yz', 'zx']

export function isFiniteStressTensor(s) {
  return s && [s.sxx, s.syy, s.szz, s.sxy, s.syz, s.szx].every(Number.isFinite)
}

export function buildStressDetails(s, n) {
  const p = (s.sxx + s.syy + s.szz) / 3
  const dxx = s.sxx - p
  const dyy = s.syy - p
  const dzz = s.szz - p
  const j2 =
    0.5 * (dxx * dxx + dyy * dyy + dzz * dzz) + (s.sxy * s.sxy + s.syz * s.syz + s.szx * s.szx)
  const vonMises = Math.sqrt(Math.max(0, 3 * j2))

  const eig = eigenvaluesSymmetric3({
    m00: s.sxx,
    m11: s.syy,
    m22: s.szz,
    m01: s.sxy,
    m12: s.syz,
    m02: s.szx
  })
  const sigma1 = eig[0]
  const sigma2 = eig[1]
  const sigma3 = eig[2]
  const tauMax = Math.max(0, (sigma1 - sigma3) * 0.5)
  const tauOct = Math.sqrt(Math.max(0, (2 / 3) * j2))

  const direction = resolveDirectionVector(n)
  const traction = computeDirectionalTraction(s, direction)

  return {
    principal: { sigma1, sigma2, sigma3 },
    invariants: { mean: p, pressure: -p, j2, vonMises, tauMax, tauOct },
    traction
  }
}

export { stressFromStrainTensor as stressFromStrain }

export function scaleFiniteSeries(series, factor) {
  if (!Array.isArray(series)) return []
  return series.map(value => {
    const n = Number(value)
    return Number.isFinite(n) ? n * factor : 0
  })
}

export function scaleTensor6(tensor6, factor) {
  if (!tensor6 || typeof tensor6 !== 'object') return null
  return TENSOR6_KEYS.reduce((acc, key) => {
    acc[key] = scaleFiniteSeries(tensor6[key], factor)
    return acc
  }, {})
}

export function mapStressToIntensity(stress, algo) {
  const s = Number(stress)
  if (!Number.isFinite(s) || s <= 0) return 0
  const ref = Number(algo?.stressRef) || 1
  const x = Math.max(0, s / ref)
  const low = Number(algo?.lowCut) || 0
  const t = Math.max(0, (x - low) / Math.max(1e-6, 1 - low))
  const g = Number(algo?.gamma) || 1
  return clamp01(Math.pow(Math.min(1, t), g))
}

export function mapStressToRadius(stress, algo) {
  const a = mapStressToIntensity(stress, algo)
  const r0 = Number(algo?.radiusMin) || 10
  const rs = Number(algo?.radiusScale) || 50
  const g = Number(algo?.radiusGamma) || 1
  return Math.max(0.1, r0 + rs * Math.pow(a, g))
}

export function computeScalarSeriesFromTensor6(tensor6, metricKey, n, extraContext = null) {
  const { xx, yy, zz, xy, yz, zx } = extractTensor6Arrays(tensor6)
  const frames = getTensor6FrameCount(tensor6)
  const out = new Array(frames)
  const direction = metricKey === 'snn' || metricKey === 'tau_n' ? resolveDirectionVector(n) : n
  for (let i = 0; i < frames; i++) {
    const v = computeMetricValue(
      metricKey,
      { sxx: xx[i], syy: yy[i], szz: zz[i], sxy: xy[i], syz: yz[i], szx: zx[i] },
      direction,
      extraContext
    )
    out[i] = Number.isFinite(v) ? v : null
  }
  return out
}

export function computeQuantile(values, q) {
  const arr = Array.isArray(values) ? values.filter(Number.isFinite) : []
  if (arr.length < 1) return null
  const qq = clamp01(Number(q))
  arr.sort((a, b) => a - b)
  return arr[Math.max(0, Math.min(arr.length - 1, Math.floor(qq * (arr.length - 1))))]
}

function resolveDirectionVector(n) {
  if (!Array.isArray(n) || n.length < 3) return [0, 1, 0]
  const nx = Number(n[0])
  const ny = Number(n[1])
  const nz = Number(n[2])
  if (![nx, ny, nz].every(Number.isFinite)) return [0, 1, 0]
  const len = Math.hypot(nx, ny, nz)
  if (!(len > 1e-9)) return [0, 1, 0]
  return [nx / len, ny / len, nz / len]
}

function getCesiumRef() {
  return typeof globalThis !== 'undefined' ? globalThis.Cesium : null
}

function isValidWorldPosition(positionWC) {
  return Boolean(
    positionWC &&
    Number.isFinite(positionWC.x) &&
    Number.isFinite(positionWC.y) &&
    Number.isFinite(positionWC.z)
  )
}

function resolveGridDimensions(grid) {
  const width = Number(grid.width)
  const height = Number(grid.height)
  const depth = Number(grid.depth)
  return width > 1 && height > 1 && depth > 1 ? { width, height, depth } : null
}

export function buildGridSampleContext(positionWC, grid, origin, size) {
  const Cesium = getCesiumRef()
  if (!Cesium) return null
  const dimensions = resolveGridDimensions(grid)
  if (!dimensions || !isValidWorldPosition(positionWC)) return null
  const { width: w, height: h, depth: d } = dimensions
  const position = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(position)
  const worldToLocal = Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
  const local = Cesium.Matrix4.multiplyByPoint(worldToLocal, positionWC, new Cesium.Cartesian3())
  const sx = Number(size[0])
  const sy = Number(size[1])
  const sz = Number(size[2])
  const px = local.x + sx * 0.5
  const py = local.y + sy * 0.5
  const pz = local.z + sz * 0.5
  if (px < 0 || py < 0 || pz < 0 || px > sx || py > sy || pz > sz) return null
  const u = px / Math.max(1e-6, sx)
  const v = py / Math.max(1e-6, sy)
  const u3 = pz / Math.max(1e-6, sz)
  const gx = u * (w - 1)
  const gy = v * (h - 1)
  const gz = u3 * (d - 1)
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const z0 = Math.floor(gz)
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const z1 = Math.min(z0 + 1, d - 1)
  const fx = gx - x0
  const fy = gy - y0
  const fz = gz - z0
  const idx = (x, y, z) => z * w * h + y * w + x
  const nearestX = Math.max(0, Math.min(w - 1, Math.floor(gx + 0.5)))
  const nearestY = Math.max(0, Math.min(h - 1, Math.floor(gy + 0.5)))
  const nearestZ = Math.max(0, Math.min(d - 1, Math.floor(gz + 0.5)))
  return {
    total: w * h * d,
    i000: idx(x0, y0, z0),
    i100: idx(x1, y0, z0),
    i010: idx(x0, y1, z0),
    i110: idx(x1, y1, z0),
    i001: idx(x0, y0, z1),
    i101: idx(x1, y0, z1),
    i011: idx(x0, y1, z1),
    i111: idx(x1, y1, z1),
    w000: (1 - fx) * (1 - fy) * (1 - fz),
    w100: fx * (1 - fy) * (1 - fz),
    w010: (1 - fx) * fy * (1 - fz),
    w110: fx * fy * (1 - fz),
    w001: (1 - fx) * (1 - fy) * fz,
    w101: fx * (1 - fy) * fz,
    w011: (1 - fx) * fy * fz,
    w111: fx * fy * fz,
    nearestIndex: idx(nearestX, nearestY, nearestZ)
  }
}

export function sampleWithContext(values, ctx) {
  if (!ctx || !values || typeof values.length !== 'number' || values.length !== ctx.total) {
    return null
  }
  return (
    values[ctx.i000] * ctx.w000 +
    values[ctx.i100] * ctx.w100 +
    values[ctx.i010] * ctx.w010 +
    values[ctx.i110] * ctx.w110 +
    values[ctx.i001] * ctx.w001 +
    values[ctx.i101] * ctx.w101 +
    values[ctx.i011] * ctx.w011 +
    values[ctx.i111] * ctx.w111
  )
}

export function sampleNearestWithContext(values, ctx) {
  if (!ctx || !values || typeof values.length !== 'number' || values.length !== ctx.total) {
    return null
  }
  return values[ctx.nearestIndex]
}

export function sampleTensor6AtContext(src, ctx) {
  const xx = sampleWithContext(src?.xx, ctx)
  const yy = sampleWithContext(src?.yy, ctx)
  const zz = sampleWithContext(src?.zz, ctx)
  const xy = sampleWithContext(src?.xy, ctx)
  const yz = sampleWithContext(src?.yz, ctx)
  const zx = sampleWithContext(src?.zx, ctx)
  if (![xx, yy, zz, xy, yz, zx].every(Number.isFinite)) return null
  return { xx, yy, zz, xy, yz, zx }
}

export function toStressTensor(ds, tensor6) {
  if (!tensor6) return null
  if (ds.data.type === '应变') {
    return stressFromStrainTensor(tensor6, ds.material)
  }
  return {
    sxx: tensor6.xx,
    syy: tensor6.yy,
    szz: tensor6.zz,
    sxy: tensor6.xy,
    syz: tensor6.yz,
    szx: tensor6.zx
  }
}

export function sampleStressAtTime(ds, positionWC, timeIndex) {
  if (!ds) return null
  const src = ds.data?.frames?.[Math.max(0, Math.min(ds.data.frames.length - 1, timeIndex))]
  if (!src) return null
  const ctx = buildGridSampleContext(positionWC, ds.grid, ds.origin, ds.size)
  if (!ctx) return null
  return toStressTensor(ds, sampleTensor6AtContext(src, ctx))
}

export function computePointDetailsAtTime(ds, positionWC, timeIndex, direction) {
  if (!ds || !positionWC) return null
  const s = sampleStressAtTime(ds, positionWC, timeIndex)
  if (!isFiniteStressTensor(s)) return null
  const n = buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 })
  const details = buildStressDetails(s, n)
  return {
    tensor: s,
    principal: details.principal,
    invariants: details.invariants,
    traction: details.traction
  }
}

export function sampleGridScalarAt(positionWC, values, grid, origin, size) {
  const ctx = buildGridSampleContext(positionWC, grid, origin, size)
  return sampleWithContext(values, ctx)
}

export function sampleGridScalarNearestAt(positionWC, values, grid, origin, size) {
  const ctx = buildGridSampleContext(positionWC, grid, origin, size)
  return sampleNearestWithContext(values, ctx)
}
