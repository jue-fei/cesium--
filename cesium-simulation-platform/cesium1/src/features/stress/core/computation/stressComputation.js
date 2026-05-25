export const STRESS_METRIC_LABELS = Object.freeze({
  von_mises: '等效应力（von Mises）',
  overlay: '叠加场（多指标加权）',
  principal_1: '最大主应力（σ1）',
  principal_2: '中间主应力（σ2）',
  principal_3: '最小主应力（σ3）',
  max_abs_normal: '三向正应力合成（最大绝对值）',
  mean_stress: '平均应力（p=tr(σ)/3）',
  pressure: '静水压力（-p）',
  j2: '第二偏应力不变量（J2）',
  tau_max: '最大剪应力（τmax）',
  tau_oct: '八面体剪应力（τ_oct）',
  sxx: 'σxx',
  syy: 'σyy',
  szz: 'σzz',
  sxy: 'σxy',
  syz: 'σyz',
  szx: 'σzx',
  snn: '方向正应力（σnn）',
  tau_n: '方向剪应力（τn）'
})

export const STRESS_BASE_METRIC_KEYS = Object.freeze([
  'von_mises',
  'principal_1',
  'principal_2',
  'principal_3',
  'max_abs_normal',
  'mean_stress',
  'pressure',
  'j2',
  'tau_max',
  'tau_oct',
  'sxx',
  'syy',
  'szz',
  'sxy',
  'syz',
  'szx',
  'snn',
  'tau_n'
])

export const STRESS_BASE_METRIC_SET = new Set(STRESS_BASE_METRIC_KEYS)

export const STRESS_METRIC_ALIAS_MAP = Object.freeze({
  等效应力: 'von_mises',
  vonMises: 'von_mises',
  最大主应力: 'principal_1',
  中间主应力: 'principal_2',
  最小主应力: 'principal_3',
  σ1: 'principal_1',
  σ2: 'principal_2',
  σ3: 'principal_3',
  三向正应力合成: 'max_abs_normal',
  平均应力: 'mean_stress',
  静水压力: 'pressure',
  第二偏应力不变量: 'j2',
  最大剪应力: 'tau_max',
  八面体剪应力: 'tau_oct',
  σxx: 'sxx',
  σyy: 'syy',
  σzz: 'szz',
  σxy: 'sxy',
  σyz: 'syz',
  σzx: 'szx',
  方向正应力: 'snn',
  σnn: 'snn',
  方向剪应力: 'tau_n',
  τn: 'tau_n'
})

export function buildStressMetricOptions(includeOverlay = false) {
  const base = STRESS_BASE_METRIC_KEYS.map(key => ({
    value: key,
    label: STRESS_METRIC_LABELS[key] || key
  }))
  if (!includeOverlay) return base
  return [
    { value: 'von_mises', label: STRESS_METRIC_LABELS.von_mises || 'von_mises' },
    { value: 'overlay', label: STRESS_METRIC_LABELS.overlay || 'overlay' },
    ...base.filter(item => item.value !== 'von_mises')
  ]
}

export function computeScalarField(ds, metric, direction, valueRangePolicy) {
  const { width, height, depth } = ds.grid
  const total = width * height * depth

  const lambda =
    (ds.material.E * ds.material.nu) / ((1 + ds.material.nu) * (1 - 2 * ds.material.nu))
  const mu = ds.material.E / (2 * (1 + ds.material.nu))
  const shearIsEngineering = ds.material.shearDef === '工程'

  const n = metric === 'snn' || metric === 'tau_n' ? buildDirectionVector(direction) : null

  const frames = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  const totalValues = total * ds.data.frames.length
  const maxSamples = 200000
  const step = Math.max(1, Math.floor(totalValues / maxSamples))
  const samples = []
  let globalIndex = 0

  for (let fi = 0; fi < ds.data.frames.length; fi++) {
    const src = ds.data.frames[fi]
    const out = new Array(total)
    for (let i = 0; i < total; i++) {
      const xx = src.xx[i]
      const yy = src.yy[i]
      const zz = src.zz[i]
      const xy = src.xy[i]
      const yz = src.yz[i]
      const zx = src.zx[i]

      let sxx = xx
      let syy = yy
      let szz = zz
      let sxy = xy
      let syz = yz
      let szx = zx

      if (ds.data.type === '应变') {
        const exx = xx
        const eyy = yy
        const ezz = zz
        const exy = shearIsEngineering ? xy * 0.5 : xy
        const eyz = shearIsEngineering ? yz * 0.5 : yz
        const ezx = shearIsEngineering ? zx * 0.5 : zx
        const tr = exx + eyy + ezz

        sxx = 2 * mu * exx + lambda * tr
        syy = 2 * mu * eyy + lambda * tr
        szz = 2 * mu * ezz + lambda * tr
        sxy = 2 * mu * exy
        syz = 2 * mu * eyz
        szx = 2 * mu * ezx
      }

      const v = computeMetricValue(metric, { sxx, syy, szz, sxy, syz, szx }, n)
      out[i] = v
      if (v < min) min = v
      if (v > max) max = v
      if (globalIndex % step === 0 && samples.length < maxSamples) {
        samples.push(v)
      }
      globalIndex++
    }
    frames.push({ values: out })
  }

  const valueRange = computeValueRange({ min, max, samples }, valueRangePolicy)
  return { frames, valueRange, timePoints: ds.time.timePoints }
}

export function computeValueRange(stats, policy) {
  const fallback = buildFallbackValueRange(stats)
  if (!policy || typeof policy !== 'object') return fallback
  const byMode = VALUE_RANGE_MODE_HANDLERS[policy.mode]
  return byMode ? byMode(stats, policy, fallback) : fallback
}

function buildFallbackValueRange(stats) {
  let min = stats.min
  let max = stats.max
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 1
  } else if (min === max) {
    max = min + 1
  }
  return [min, max]
}

function getFiniteSamples(stats) {
  return Array.isArray(stats.samples) ? stats.samples.filter(Number.isFinite) : []
}

function resolveQuantile(sortedValues, q) {
  const pos = Math.floor(Number(q) * (sortedValues.length - 1))
  const idx = Math.max(0, Math.min(sortedValues.length - 1, pos))
  return sortedValues[idx]
}

function resolveQuantileRange(stats, policy, fallback) {
  const qLow = Number(policy.qLow)
  const qHigh = Number(policy.qHigh)
  if (!Number.isFinite(qLow) || !Number.isFinite(qHigh) || qLow < 0 || qHigh > 1 || qLow >= qHigh) {
    return fallback
  }
  const arr = getFiniteSamples(stats)
  if (arr.length < 10) return fallback
  arr.sort((a, b) => a - b)
  const lo = resolveQuantile(arr, qLow)
  const hi = resolveQuantile(arr, qHigh)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return fallback
  return [lo, hi]
}

function resolveSymmetricRange(stats, policy) {
  const maxAbsManual = Number(policy.maxAbs)
  if (Number.isFinite(maxAbsManual) && maxAbsManual > 0) {
    return [-maxAbsManual, maxAbsManual]
  }
  const absMaxFromMinMax = Math.max(
    Math.abs(Number(stats.min) || 0),
    Math.abs(Number(stats.max) || 0)
  )
  const arr = getFiniteSamples(stats)
  if (arr.length < 10) {
    const m = absMaxFromMinMax > 0 ? absMaxFromMinMax : 1
    return [-m, m]
  }
  const absArr = arr.map(v => Math.abs(v)).filter(Number.isFinite)
  absArr.sort((a, b) => a - b)
  const qHigh = Number(policy.qHigh)
  const q = Number.isFinite(qHigh) && qHigh > 0 && qHigh <= 1 ? qHigh : 1
  const v = resolveQuantile(absArr, q)
  const m = Number.isFinite(v) && v > 0 ? v : absMaxFromMinMax > 0 ? absMaxFromMinMax : 1
  return [-m, m]
}

const VALUE_RANGE_MODE_HANDLERS = Object.freeze({
  手动: (_stats, policy, fallback) => {
    const min = Number(policy.min)
    const max = Number(policy.max)
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return fallback
    return [min, max]
  },
  分位数: (stats, policy, fallback) => resolveQuantileRange(stats, policy, fallback),
  对称零点: (stats, policy) => resolveSymmetricRange(stats, policy)
})

const DIRECT_METRIC_FIELD_MAP = Object.freeze({
  sxx: 'sxx',
  syy: 'syy',
  szz: 'szz',
  sxy: 'sxy',
  syz: 'syz',
  szx: 'szx'
})

function computeMeanStress(s) {
  return (s.sxx + s.syy + s.szz) / 3
}

function computeJ2Invariant(s) {
  const p = computeMeanStress(s)
  const dxx = s.sxx - p
  const dyy = s.syy - p
  const dzz = s.szz - p
  return 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz) + (s.sxy * s.sxy + s.syz * s.syz + s.szx * s.szx)
}

function computeDirectionalTraction(s, n) {
  if (!n) return { snn: 0, tauN: 0 }
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
  return { snn, tauN: Math.hypot(sx, sy, sz) }
}

function computePrincipalValues(s) {
  return eigenvaluesSymmetric3({
    m00: s.sxx,
    m11: s.syy,
    m22: s.szz,
    m01: s.sxy,
    m12: s.syz,
    m02: s.szx
  })
}

const METRIC_RESOLVERS = Object.freeze({
  von_mises: s => Math.sqrt(Math.max(0, 3 * computeJ2Invariant(s))),
  max_abs_normal: s => Math.max(Math.abs(s.sxx), Math.abs(s.syy), Math.abs(s.szz)),
  mean_stress: s => computeMeanStress(s),
  pressure: s => -computeMeanStress(s),
  j2: s => computeJ2Invariant(s),
  snn: (s, n) => computeDirectionalTraction(s, n).snn,
  tau_n: (s, n) => computeDirectionalTraction(s, n).tauN,
  principal_1: s => computePrincipalValues(s)[0],
  principal_2: s => computePrincipalValues(s)[1],
  principal_3: s => computePrincipalValues(s)[2],
  tau_max: s => {
    const e = computePrincipalValues(s)
    return Math.max(0, (e[0] - e[2]) * 0.5)
  },
  tau_oct: s => Math.sqrt(Math.max(0, (2 / 3) * computeJ2Invariant(s)))
})

export function computeMetricValue(metric, s, n) {
  const directKey = DIRECT_METRIC_FIELD_MAP[metric]
  if (directKey) return s[directKey]
  const resolver = METRIC_RESOLVERS[metric]
  if (resolver) return resolver(s, n)
  return 0
}

export function buildDirectionVector({ azimuthDeg, dipDeg }) {
  const az = (Number(azimuthDeg) || 0) * (Math.PI / 180)
  const dip = (Number(dipDeg) || 0) * (Math.PI / 180)
  const ch = Math.cos(dip)
  const nx = ch * Math.sin(az)
  const ny = ch * Math.cos(az)
  const nz = Math.sin(dip)
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

export function eigenvaluesSymmetric3(m) {
  const a00 = m.m00
  const a11 = m.m11
  const a22 = m.m22
  const a01 = m.m01
  const a02 = m.m02
  const a12 = m.m12

  const p1 = a01 * a01 + a02 * a02 + a12 * a12
  if (p1 === 0) {
    const vals = [a00, a11, a22].sort((x, y) => y - x)
    return vals
  }

  const q = (a00 + a11 + a22) / 3
  const b00 = a00 - q
  const b11 = a11 - q
  const b22 = a22 - q

  const p2 = b00 * b00 + b11 * b11 + b22 * b22 + 2 * p1
  const p = Math.sqrt(p2 / 6)

  const invP = 1 / p
  const c00 = b00 * invP
  const c11 = b11 * invP
  const c22 = b22 * invP
  const c01 = a01 * invP
  const c02 = a02 * invP
  const c12 = a12 * invP

  const detC =
    c00 * (c11 * c22 - c12 * c12) - c01 * (c01 * c22 - c12 * c02) + c02 * (c01 * c12 - c11 * c02)
  const r = detC / 2

  let phi = 0
  if (r <= -1) phi = Math.PI / 3
  else if (r >= 1) phi = 0
  else phi = Math.acos(r) / 3

  const eig1 = q + 2 * p * Math.cos(phi)
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
  const eig2 = 3 * q - eig1 - eig3

  return [eig1, eig2, eig3].sort((x, y) => y - x)
}
