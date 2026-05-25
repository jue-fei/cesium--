import {
  isFiniteStressTensor,
  buildStressDetails,
  scaleFiniteSeries,
  scaleTensor6,
  mapStressToIntensity,
  mapStressToRadius,
  computeScalarSeriesFromTensor6
} from './stressTensorUtils.js'
import { buildGridSampleContext, sampleTensor6AtContext, toStressTensor } from './gridSampling.js'
import { buildDirectionVector, computeMetricValue } from '../computation/stressComputation.js'

/**
 * 构建单个点在不同时间的详细应力信息（基于点自身的 tensor6 数据）。
 */
export function buildPointConfigDetails(point, timeIndex, direction) {
  if (!point?.tensor6) return null
  const t = Math.max(0, Math.min(Math.max(0, point.tensor6.xx.length - 1), timeIndex))
  const s = {
    sxx: point.tensor6.xx[t],
    syy: point.tensor6.yy[t],
    szz: point.tensor6.zz[t],
    sxy: point.tensor6.xy[t],
    syz: point.tensor6.yz[t],
    szx: point.tensor6.zx[t]
  }
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

/**
 * 从六分量张量数组构建包含所有指标的时间序列行。
 */
export function buildAllMetricsRowsFromTensor6(tensor6, pd, direction) {
  const timePoints = Array.isArray(pd?.time?.timePoints) ? pd.time.timePoints : null
  const xx = Array.isArray(tensor6?.xx) ? tensor6.xx : []
  const yy = Array.isArray(tensor6?.yy) ? tensor6.yy : []
  const zz = Array.isArray(tensor6?.zz) ? tensor6.zz : []
  const xy = Array.isArray(tensor6?.xy) ? tensor6.xy : []
  const yz = Array.isArray(tensor6?.yz) ? tensor6.yz : []
  const zx = Array.isArray(tensor6?.zx) ? tensor6.zx : []
  const frames = Math.min(xx.length, yy.length, zz.length, xy.length, yz.length, zx.length)
  if (frames < 1) return []

  const n = buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 })

  const rows = []
  for (let i = 0; i < frames; i++) {
    const sxx = xx[i]
    const syy = yy[i]
    const szz = zz[i]
    const sxy = xy[i]
    const syz = yz[i]
    const szx = zx[i]
    const s = { sxx, syy, szz, sxy, syz, szx }
    if (!isFiniteStressTensor(s)) continue
    const details = buildStressDetails(s, n)

    const t = Array.isArray(timePoints) ? timePoints[i] : i
    rows.push({
      t,
      sxx: s.sxx,
      syy: s.syy,
      szz: s.szz,
      sxy: s.sxy,
      syz: s.syz,
      szx: s.szx,
      sigma1: details.principal.sigma1,
      sigma2: details.principal.sigma2,
      sigma3: details.principal.sigma3,
      mean: details.invariants.mean,
      pressure: details.invariants.pressure,
      j2: details.invariants.j2,
      von_mises: details.invariants.vonMises,
      tau_max: details.invariants.tauMax,
      tau_oct: details.invariants.tauOct,
      snn: details.traction.snn,
      tau_n: details.traction.tauN
    })
  }
  return rows
}

/**
 * 构建单个点指定指标的时间序列（基于网格数据集）。
 */
export function buildPointSeriesForMetric(pointWC, ds, metricKey, direction) {
  if (!ds || !pointWC) return []
  const frames = ds.data?.frames || []
  if (frames.length === 0) return []
  const ctx = buildGridSampleContext(pointWC, ds.grid, ds.origin, ds.size)
  if (!ctx) return []

  const out = []
  const n =
    metricKey === 'snn' || metricKey === 'tau_n'
      ? buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 })
      : null

  for (let i = 0; i < frames.length; i++) {
    const t = Array.isArray(ds.time?.timePoints) ? ds.time.timePoints[i] : i
    const src = frames[i]
    const tensor6 = sampleTensor6AtContext(src, ctx)
    if (!tensor6) {
      out.push({ t, v: null })
      continue
    }
    const s = toStressTensor(ds, tensor6)
    const v = computeMetricValue(metricKey, s, n)
    out.push({ t, v: Number.isFinite(v) ? v : null })
  }
  return out
}

/**
 * 构建单个点所有指标的时间序列（基于网格数据集）。
 */
export function buildPointAllMetricsSeries(pointWC, ds, direction) {
  if (!ds || !pointWC) return []
  const frames = ds.data?.frames || []
  if (frames.length === 0) return []
  const ctx = buildGridSampleContext(pointWC, ds.grid, ds.origin, ds.size)
  if (!ctx) return []

  const n = buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 })

  const rows = []
  for (let i = 0; i < frames.length; i++) {
    const t = Array.isArray(ds.time?.timePoints) ? ds.time.timePoints[i] : i
    const src = frames[i]
    const tensor6 = sampleTensor6AtContext(src, ctx)
    if (!tensor6) continue
    const s = toStressTensor(ds, tensor6)
    if (!isFiniteStressTensor(s)) continue
    const details = buildStressDetails(s, n)

    rows.push({
      t,
      sxx: s.sxx,
      syy: s.syy,
      szz: s.szz,
      sxy: s.sxy,
      syz: s.syz,
      szx: s.szx,
      sigma1: details.principal.sigma1,
      sigma2: details.principal.sigma2,
      sigma3: details.principal.sigma3,
      mean: details.invariants.mean,
      pressure: details.invariants.pressure,
      j2: details.invariants.j2,
      von_mises: details.invariants.vonMises,
      tau_max: details.invariants.tauMax,
      tau_oct: details.invariants.tauOct,
      snn: details.traction.snn,
      tau_n: details.traction.tauN
    })
  }
  return rows
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

function fract(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return n - Math.floor(n)
}

/**
 * 通过抖动原始点生成更多点（用于可视化点云扩展）。
 */
export function expandPointSources(points, size, targetCount) {
  const src = Array.isArray(points) ? points.filter(p => p && typeof p === 'object') : []
  const target = Math.max(1, Math.min(100, Number(targetCount) || 1))
  if (src.length < 1) return []
  if (src.length >= target) return src.slice(0, target)

  const sx = Array.isArray(size) && size.length >= 3 ? Number(size[0]) : 200
  const sy = Array.isArray(size) && size.length >= 3 ? Number(size[1]) : 200
  const sz = Array.isArray(size) && size.length >= 3 ? Number(size[2]) : 100

  const out = []
  const golden = 2.399963229728653
  const f1 = 0.618033988749895
  const f2 = 0.7548776662466927

  for (let i = 0; i < target; i++) {
    const base = src[i % src.length]
    const center = Array.isArray(base.center) ? base.center : [0.5, 0.5, 0.5]
    const coordMode = base.coordMode

    const a = i * golden
    const r = Math.sqrt(fract(i * f1)) * 0.12
    const dz = (fract(i * f2) - 0.5) * 0.06

    let nextCenter = center
    let atten = 1

    if (coordMode === 'UVW') {
      const du = r * Math.cos(a)
      const dv = r * Math.sin(a)
      const u = clamp01(Number(center[0]) + du)
      const v = clamp01(Number(center[1]) + dv)
      const w = clamp01(Number(center[2]) + dz)
      nextCenter = [u, v, w]
      const dist = Math.hypot(du, dv, dz)
      atten = clamp01(1 - dist / 0.16) * 0.85 + 0.15
    } else if (coordMode === 'ENU') {
      const du = r * Math.cos(a) * sx
      const dv = r * Math.sin(a) * sy
      const dw = dz * sz
      const x = Number(center[0]) + du
      const y = Number(center[1]) + dv
      const z = Number(center[2]) + dw
      nextCenter = [x, y, z]
      const dist = Math.hypot(du, dv, dw)
      const denom = Math.max(1e-6, Math.min(sx, sy, sz) * 0.16)
      atten = clamp01(1 - dist / denom) * 0.85 + 0.15
    } else {
      nextCenter = center
      atten = 1
    }

    const stressSeries = scaleFiniteSeries(base.stressSeries, atten)
    const tensor6 = scaleTensor6(base.tensor6, atten)

    out.push({
      id: base.id ? `${base.id}_${i + 1}` : `P_${i + 1}`,
      name: base.name || '',
      coordMode,
      center: nextCenter,
      stressSeries,
      tensor6
    })
  }

  return out
}

/**
 * 默认的点可视化算法参数。
 */
export function defaultPointAlgo(size, stressRef) {
  const s0 = Array.isArray(size) && size.length >= 3 ? Math.min(size[0], size[1], size[2]) : 200
  return {
    stressRef: Number.isFinite(stressRef) && stressRef > 0 ? stressRef : 1,
    lowCut: 0.05,
    gamma: 1.15,
    radiusMin: Math.max(10, s0 * 0.08),
    radiusScale: Math.max(30, s0 * 0.22),
    radiusGamma: 0.9
  }
}

/**
 * 获取点对象指定指标的时间序列值（优先使用点内 tensor6 或 stressSeries）。
 */
export function getPointMetricSeriesValues(point, pd, metricKey, direction, overlayItems) {
  const metric = String(metricKey || 'von_mises')
  const algoRef = Number(pd?.algo?.stressRef) || 1

  if (metric === 'overlay') {
    if (!point?.tensor6) return Array.isArray(point?.stressSeries) ? point.stressSeries : []
    const items = Array.isArray(overlayItems) ? overlayItems : []
    const active = items.filter(
      it => it && typeof it === 'object' && it.metric && Number(it.weight) > 0
    )
    if (active.length < 1) {
      return computeScalarSeriesFromTensor6(point.tensor6, 'von_mises', null)
    }

    let sumW = 0
    let out = null
    for (const it of active) {
      const mk = String(it.metric)
      const w = Number(it.weight)
      if (!(w > 0)) continue
      const needsN = mk === 'snn' || mk === 'tau_n'
      const n = needsN ? buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 }) : null
      const series = computeScalarSeriesFromTensor6(point.tensor6, mk, n).map(v =>
        Number.isFinite(v) ? Math.abs(v) : 0
      )
      let maxAbs = 0
      for (const v of series) if (v > maxAbs) maxAbs = v
      if (!(maxAbs > 0)) continue

      if (!out) out = new Array(series.length).fill(0)
      for (let i = 0; i < series.length; i++) {
        out[i] += (series[i] / maxAbs) * w
      }
      sumW += w
    }

    if (!out || !(sumW > 0)) {
      return computeScalarSeriesFromTensor6(point.tensor6, 'von_mises', null)
    }
    return out.map(v => Math.max(0, v / sumW) * algoRef)
  }

  if (metric === 'von_mises') {
    if (Array.isArray(point?.stressSeries) && point.stressSeries.length > 0)
      return point.stressSeries
    if (point?.tensor6) return computeScalarSeriesFromTensor6(point.tensor6, 'von_mises', null)
    return []
  }

  if (point?.tensor6) {
    const needsN = metric === 'snn' || metric === 'tau_n'
    const n = needsN ? buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 }) : null
    return computeScalarSeriesFromTensor6(point.tensor6, metric, n)
  }
  return []
}

/**
 * 从点数据集构建用于渲染的点列表（包含可视化参数）。
 */
export function buildRenderablePointsFromPointDataset(pd, metricKey, direction, overlayItems) {
  const baseAlgo = pd?.algo || defaultPointAlgo(pd?.size, 1)
  const algo = { ...baseAlgo }
  const timePoints = Array.isArray(pd?.time?.timePoints) ? pd.time.timePoints : null

  const raw = (Array.isArray(pd?.points) ? pd.points : []).slice(0, 100)
  let globalMaxAbs = 0
  for (const p of raw) {
    const series = getPointMetricSeriesValues(p, pd, metricKey, direction, overlayItems)
    for (const v of series) {
      const n = Math.abs(Number(v))
      if (Number.isFinite(n) && n > globalMaxAbs) globalMaxAbs = n
    }
  }
  if (!(Number.isFinite(algo.stressRef) && algo.stressRef > 0)) {
    algo.stressRef = globalMaxAbs > 0 ? globalMaxAbs : 1
  } else if (globalMaxAbs > 0 && algo.stressRef > globalMaxAbs * 5) {
    algo.stressRef = globalMaxAbs
  }
  if (Number.isFinite(algo.lowCut) && algo.lowCut > 0.02) algo.lowCut = 0.02

  return raw.map((p, idx) => {
    const series = getPointMetricSeriesValues(p, pd, metricKey, direction, overlayItems)

    const intensitySeries = series.map(s => mapStressToIntensity(s, algo))
    const radiusSeries = series.map(s => mapStressToRadius(s, algo))
    const timeSeries = intensitySeries.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(radiusSeries[i]) && radiusSeries[i] > 0 ? v : 0
    )
    const radius = Number.isFinite(radiusSeries[0])
      ? radiusSeries[0]
      : Number(algo?.radiusMin) || 10

    return {
      id: p?.id || `P_${idx + 1}`,
      name: p?.name || '',
      coordMode: p?.coordMode,
      center: p?.center,
      radius,
      base: 1,
      timeSeries,
      radiusSeries,
      timePoints
    }
  })
}

/**
 * 构建点对象指定指标的时间序列（用于图表等）。
 */
export function buildPointConfigSeries(point, pd, metricKey, direction, overlayItems) {
  const timePoints = Array.isArray(pd?.time?.timePoints) ? pd.time.timePoints : null
  const seriesValues = getPointMetricSeriesValues(point, pd, metricKey, direction, overlayItems)

  const out = []
  for (let i = 0; i < seriesValues.length; i++) {
    const t = Array.isArray(timePoints) ? timePoints[i] : i
    const v = seriesValues[i]
    out.push({ t, v: Number.isFinite(v) ? v : null })
  }
  return out
}
