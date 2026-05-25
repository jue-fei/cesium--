import { eigenvaluesSymmetric3, computeMetricValue } from '../computation/stressComputation.js'

const TENSOR6_KEYS = ['xx', 'yy', 'zz', 'xy', 'yz', 'zx']

/**
 * 检查应力张量对象的所有分量是否均为有限数值。
 */
export function isFiniteStressTensor(s) {
  return s && [s.sxx, s.syy, s.szz, s.sxy, s.syz, s.szx].every(Number.isFinite)
}

/**
 * 根据应力张量和法向向量计算详细力学量（主应力、不变量、牵引力等）。
 */
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

  const nx = n[0]
  const ny = n[1]
  const nz = n[2]
  const tx = s.sxx * nx + s.sxy * ny + s.szx * nz
  const ty = s.sxy * nx + s.syy * ny + s.syz * nz
  const tz = s.szx * nx + s.syz * ny + s.szz * nz
  const snn =
    nx * (s.sxx * nx + s.sxy * ny + s.szx * nz) +
    ny * (s.sxy * nx + s.syy * ny + s.syz * nz) +
    nz * (s.szx * nx + s.syz * ny + s.szz * nz)
  const sx = tx - snn * nx
  const sy = ty - snn * ny
  const sz = tz - snn * nz
  const tauN = Math.hypot(sx, sy, sz)

  return {
    principal: { sigma1, sigma2, sigma3 },
    invariants: { mean: p, pressure: -p, j2, vonMises, tauMax, tauOct },
    traction: { nx, ny, nz, tx, ty, tz, snn, tauN }
  }
}

/**
 * 根据应变张量和材料参数计算应力张量。
 */
export function stressFromStrain(e, material) {
  const E = material.E
  const nu = material.nu
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu))
  const mu = E / (2 * (1 + nu))
  const shearIsEngineering = material.shearDef === '工程'

  const exx = e.xx
  const eyy = e.yy
  const ezz = e.zz
  const exy = shearIsEngineering ? e.xy * 0.5 : e.xy
  const eyz = shearIsEngineering ? e.yz * 0.5 : e.yz
  const ezx = shearIsEngineering ? e.zx * 0.5 : e.zx
  const tr = exx + eyy + ezz

  return {
    sxx: 2 * mu * exx + lambda * tr,
    syy: 2 * mu * eyy + lambda * tr,
    szz: 2 * mu * ezz + lambda * tr,
    sxy: 2 * mu * exy,
    syz: 2 * mu * eyz,
    szx: 2 * mu * ezx
  }
}

/**
 * 对数值数组进行缩放（乘以因子）。
 */
export function scaleFiniteSeries(series, factor) {
  if (!Array.isArray(series)) return []
  return series.map(value => {
    const n = Number(value)
    return Number.isFinite(n) ? n * factor : 0
  })
}

/**
 * 对六分量张量对象的每个数组分量进行缩放。
 */
export function scaleTensor6(tensor6, factor) {
  if (!tensor6 || typeof tensor6 !== 'object') return null
  return TENSOR6_KEYS.reduce((acc, key) => {
    acc[key] = scaleFiniteSeries(tensor6[key], factor)
    return acc
  }, {})
}

/**
 * 将应力值映射到 [0,1] 强度值（用于可视化）。
 */
export function mapStressToIntensity(stress, algo) {
  const s = Number(stress)
  if (!Number.isFinite(s) || s <= 0) return 0
  const ref = Number(algo?.stressRef) || 1
  const x = Math.max(0, s / ref)
  const low = Number(algo?.lowCut) || 0
  const t = Math.max(0, (x - low) / Math.max(1e-6, 1 - low))
  const g = Number(algo?.gamma) || 1
  return Math.max(0, Math.min(1, Math.pow(Math.min(1, t), g)))
}

/**
 * 将应力值映射到球体半径（用于可视化）。
 */
export function mapStressToRadius(stress, algo) {
  const a = mapStressToIntensity(stress, algo)
  const r0 = Number(algo?.radiusMin) || 10
  const rs = Number(algo?.radiusScale) || 50
  const g = Number(algo?.radiusGamma) || 1
  return Math.max(0.1, r0 + rs * Math.pow(a, g))
}

/**
 * 从六分量张量数组计算指定指标的时间序列。
 */
export function computeScalarSeriesFromTensor6(tensor6, metricKey, n) {
  const xx = Array.isArray(tensor6?.xx) ? tensor6.xx : []
  const yy = Array.isArray(tensor6?.yy) ? tensor6.yy : []
  const zz = Array.isArray(tensor6?.zz) ? tensor6.zz : []
  const xy = Array.isArray(tensor6?.xy) ? tensor6.xy : []
  const yz = Array.isArray(tensor6?.yz) ? tensor6.yz : []
  const zx = Array.isArray(tensor6?.zx) ? tensor6.zx : []
  const frames = Math.min(xx.length, yy.length, zz.length, xy.length, yz.length, zx.length)
  const out = new Array(frames)
  for (let i = 0; i < frames; i++) {
    const v = computeMetricValue(
      metricKey,
      { sxx: xx[i], syy: yy[i], szz: zz[i], sxy: xy[i], syz: yz[i], szx: zx[i] },
      n
    )
    out[i] = Number.isFinite(v) ? v : 0
  }
  return out
}

/**
 * 计算有限数值数组的分位数。
 */
export function computeQuantile(values, q) {
  const arr = Array.isArray(values) ? values.filter(Number.isFinite) : []
  if (arr.length < 1) return null
  const qq = Math.max(0, Math.min(1, Number(q)))
  arr.sort((a, b) => a - b)
  return arr[Math.max(0, Math.min(arr.length - 1, Math.floor(qq * (arr.length - 1))))]
}
