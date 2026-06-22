import {
  buildStrainStressCoefficients,
  stressFromStrainByCoefficients,
  ensureArray
} from '../shared/stressActionShared.js'
import {
  SAFETY_SCORE_LABEL,
  SAFETY_SCORE_METRIC,
  computeSafetyScoreFromStress,
  isSafetyMetric,
  resolveMetricFixedRange
} from '../safety/index.js'
import { eigenvaluesSymmetric3 } from '../shared/eigenvalues.js'

export const STRESS_METRIC_LABELS = Object.freeze({
  von_mises: '等效应力（von Mises）',
  [SAFETY_SCORE_METRIC]: SAFETY_SCORE_LABEL,
  overlay: '叠加场（多指标加权）',
  principal_1: '最大主应力（σ1）',
  principal_2: '中间主应力（σ2）',
  principal_3: '最小主应力（σ3）',
  max_abs_normal: '三向正应力合成（最大绝对值）',
  mean_stress: '平均应力（p=tr(σ)/3）',
  pressure: '静水压力（-p）',
  j2: '第二偏应力不变量（J2）',
  tau_max: '最大剪应力（τmax）',
  tau_oct: '八面体剪应力（τoct）',
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
  SAFETY_SCORE_METRIC,
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
  安全评分: SAFETY_SCORE_METRIC,
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

function buildStressAtIndex(src, i, isStrain, strainCoefficients) {
  const xx = src.xx[i]
  const yy = src.yy[i]
  const zz = src.zz[i]
  const xy = src.xy[i]
  const yz = src.yz[i]
  const zx = src.zx[i]

  if (isStrain) {
    const converted = stressFromStrainByCoefficients({ xx, yy, zz, xy, yz, zx }, strainCoefficients)
    return {
      sxx: converted.sxx,
      syy: converted.syy,
      szz: converted.szz,
      sxy: converted.sxy,
      syz: converted.syz,
      szx: converted.szx
    }
  }
  return { sxx: xx, syy: yy, szz: zz, sxy: xy, syz: yz, szx: zx }
}

function computeOverlayScalarField(ds, direction, valueRangePolicy, extraContext, overlayItems) {
  const items = ensureArray(overlayItems).filter(
    it => it && typeof it === 'object' && it.metric && Number(it.weight) > 0
  )
  if (items.length < 1) {
    return computeScalarField(ds, 'von_mises', direction, valueRangePolicy, extraContext, null)
  }

  const { width, height, depth } = ds.grid
  const total = width * height * depth
  const frameCount = ds.data.frames.length
  const safetyContext = extraContext?.safetyContext || null
  const isStrain = ds.data.type === '应变'
  const strainCoefficients = isStrain ? buildStrainStressCoefficients(ds.material) : null

  const frames = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  const totalValues = total * frameCount
  const maxSamples = 200000
  const step = Math.max(1, Math.floor(totalValues / maxSamples))
  const samples = []
  let globalIndex = 0
  let nextSampleIndex = 0

  for (let fi = 0; fi < frameCount; fi++) {
    const src = ds.data.frames[fi]

    const itemFields = []
    const itemMaxAbs = []
    for (const it of items) {
      const mk = String(it.metric)
      const evaluator = buildScalarMetricEvaluator(mk, direction)
      const useSafety = isSafetyMetric(mk)
      const values = new Array(total)
      let maxAbs = 0
      for (let i = 0; i < total; i++) {
        const stress = buildStressAtIndex(src, i, isStrain, strainCoefficients)
        const v = useSafety
          ? computeSafetyScoreFromStress(
              stress,
              safetyContext,
              resolveGridLocalPos(i, width, height, depth)
            )
          : evaluator(stress)
        values[i] = v
        const av = Math.abs(v)
        if (av > maxAbs) maxAbs = av
      }
      itemFields.push(values)
      itemMaxAbs.push(maxAbs)
    }

    const out = new Array(total)
    for (let i = 0; i < total; i++) {
      let sumW = 0
      let sumV = 0
      for (let ii = 0; ii < items.length; ii++) {
        const w = Number(items[ii].weight)
        if (!(w > 0)) continue
        const maxAbs = itemMaxAbs[ii]
        if (maxAbs > 0) {
          sumV += (Math.abs(itemFields[ii][i]) / maxAbs) * w
        }
        sumW += w
      }
      const v = sumW > 0 ? Math.max(0, sumV / sumW) : 0
      out[i] = v
      if (v < min) min = v
      if (v > max) max = v
      if (globalIndex === nextSampleIndex && samples.length < maxSamples) {
        samples.push(v)
        nextSampleIndex += step
      }
      globalIndex++
    }
    frames.push({ values: out })
  }

  const valueRange =
    resolveMetricFixedRange('overlay') || computeValueRange({ min, max, samples }, valueRangePolicy)
  return { frames, valueRange, timePoints: ds.time.timePoints }
}

export function computeScalarField(
  ds,
  metric,
  direction,
  valueRangePolicy,
  extraContext = null,
  overlayItems = null
) {
  if (metric === 'overlay') {
    return computeOverlayScalarField(ds, direction, valueRangePolicy, extraContext, overlayItems)
  }

  const { width, height, depth } = ds.grid
  const total = width * height * depth
  const frameCount = ds.data.frames.length

  const metricEvaluator = buildScalarMetricEvaluator(metric, direction)
  const safetyContext = extraContext?.safetyContext || null
  const useSafetyMetric = isSafetyMetric(metric)
  const isStrain = ds.data.type === '应变'
  const strainCoefficients = isStrain ? buildStrainStressCoefficients(ds.material) : null

  const frames = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  const totalValues = total * frameCount
  const maxSamples = 200000
  const step = Math.max(1, Math.floor(totalValues / maxSamples))
  const samples = []
  let globalIndex = 0
  let nextSampleIndex = 0

  for (let fi = 0; fi < frameCount; fi++) {
    const src = ds.data.frames[fi]
    const out = new Array(total)
    for (let i = 0; i < total; i++) {
      const stress = buildStressAtIndex(src, i, isStrain, strainCoefficients)

      const v = useSafetyMetric
        ? computeSafetyScoreFromStress(
            stress,
            safetyContext,
            resolveGridLocalPos(i, width, height, depth)
          )
        : metricEvaluator(stress)
      out[i] = v
      if (v < min) min = v
      if (v > max) max = v
      if (globalIndex === nextSampleIndex && samples.length < maxSamples) {
        samples.push(v)
        nextSampleIndex += step
      }
      globalIndex++
    }
    frames.push({ values: out })
  }

  const valueRange =
    resolveMetricFixedRange(metric) || computeValueRange({ min, max, samples }, valueRangePolicy)
  return { frames, valueRange, timePoints: ds.time.timePoints }
}

function buildScalarMetricEvaluator(metric, direction) {
  if (isSafetyMetric(metric)) {
    return s => computeSafetyScoreFromStress(s)
  }
  const directKey = DIRECT_METRIC_FIELD_MAP[metric]
  if (directKey) {
    return s => s[directKey]
  }
  const n = metric === 'snn' || metric === 'tau_n' ? buildDirectionVector(direction) : null
  const resolver = METRIC_RESOLVERS[metric]
  if (!resolver) return () => 0
  return s => resolver(s, n)
}

export function computeValueRange(stats, policy) {
  const fallback = buildFallbackValueRange(stats)
  if (!policy || typeof policy !== 'object') return buildRobustValueRange(stats, fallback)
  const byMode = VALUE_RANGE_MODE_HANDLERS[policy.mode]
  return byMode ? byMode(stats, policy, fallback) : buildRobustValueRange(stats, fallback)
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

function buildRobustValueRange(stats, fallback) {
  const arr = getFiniteSamples(stats)
  if (arr.length < 20) return fallback
  arr.sort((a, b) => a - b)
  const lo = resolveQuantile(arr, 0.02)
  const hi = resolveQuantile(arr, 0.98)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return fallback
  const padding = (hi - lo) * 0.05
  return [lo - padding, hi + padding]
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

export function computeDirectionalTraction(s, n) {
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
  return { nx, ny, nz, tx, ty, tz, snn, tauN: Math.hypot(sx, sy, sz) }
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

export function computeMetricValue(metric, s, n, extraContext = null) {
  if (isSafetyMetric(metric)) {
    return computeSafetyScoreFromStress(
      s,
      extraContext?.safetyContext || extraContext || null,
      extraContext?.localPos || null
    )
  }
  const directKey = DIRECT_METRIC_FIELD_MAP[metric]
  if (directKey) return s[directKey]
  const resolver = METRIC_RESOLVERS[metric]
  if (resolver) return resolver(s, n)
  return 0
}

function resolveGridLocalPos(index, width, height, depth) {
  const plane = width * height
  const z = Math.floor(index / plane)
  const remain = index - z * plane
  const y = Math.floor(remain / width)
  const x = remain - y * width
  return [
    width > 1 ? x / (width - 1) : 0.5,
    height > 1 ? y / (height - 1) : 0.5,
    depth > 1 ? z / (depth - 1) : 0.5
  ]
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

export { eigenvaluesSymmetric3 } from '../shared/eigenvalues.js'
