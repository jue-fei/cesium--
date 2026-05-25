import { buildDirectionVector, computeMetricValue } from '../computation/index.js'
import {
  clamp01,
  buildDirectionSignature,
  buildOverlaySignature
} from '../shared/stressActionShared.js'
import {
  buildSafetySignature,
  isSafetyMetric,
  mapSafetyScoreToIntensity,
  mapSafetyScoreToRadius,
  resolvePointLocalPosition
} from '../safety/index.js'
import {
  extractTensor6Arrays,
  getTensor6FrameCount,
  fract,
  ensureArray,
  isFiniteStressTensor,
  buildStressDetails,
  scaleFiniteSeries,
  scaleTensor6,
  mapStressToIntensity,
  mapStressToRadius,
  computeScalarSeriesFromTensor6,
  computeQuantile,
  buildGridSampleContext,
  sampleTensor6AtContext,
  toStressTensor
} from '../interpolation/config.js'
import { createInterpolationManager } from '../interpolation/interpolationCore.js'
import { parsePointCenter } from '../interpolation/utilsWorker.js'
import { normalizeRenderConfig } from './foundation.js'

const pointMetricSeriesCacheByDataset = new WeakMap()
const DEFAULT_DIRECTION = { azimuthDeg: 0, dipDeg: 0 }

const interpolationManager = createInterpolationManager({
  getPointMetricSeriesValues
})

// -----------------------------------------------------------------------------
// 点文件规范化（从 pointData.js 迁移）
// -----------------------------------------------------------------------------

function parsePointStressData(point, framesCount) {
  const direct = parseScalarSeries(point['von_mises'], framesCount, 'von_mises')
  if (direct.ok) return { ok: true, data: { kind: 'scalar', values: direct.values } }

  const stress = point['应力'] && typeof point['应力'] === 'object' ? point['应力'] : null
  if (!stress) return { ok: false, message: '缺少 von_mises 或 应力' }
  const type = String(stress['类型'] || '')
  if (type === 'von_mises') {
    const scalar = parseScalarSeries(stress['值'], framesCount, '应力.值')
    if (!scalar.ok)
      return { ok: false, message: scalar.message || '应力.类型=von_mises 需要 值=[...]' }
    return { ok: true, data: { kind: 'scalar', values: scalar.values } }
  }
  if (type !== 'tensor6') return { ok: false, message: '应力.类型 仅支持 von_mises / tensor6' }
  const tensorParsed = parseTensor6(stress, framesCount)
  if (!tensorParsed.ok) return { ok: false, message: tensorParsed.message }
  return { ok: true, data: { kind: 'tensor6', tensor6: tensorParsed.tensor6 } }
}

function parseScalarSeries(raw, framesCount, fieldName) {
  if (!Array.isArray(raw)) return { ok: false, message: `${fieldName} 需要数组` }
  const values = raw.map(Number)
  if (values.length !== framesCount) {
    return { ok: false, message: `${fieldName} 长度必须为 ${framesCount}` }
  }
  if (!values.every(v => Number.isFinite(v) && v >= 0)) {
    return { ok: false, message: `${fieldName} 存在非数字/负数` }
  }
  return { ok: true, values }
}

function parseTensor6(stress, framesCount) {
  const tensor6 = {}
  for (const key of ['xx', 'yy', 'zz', 'xy', 'yz', 'zx']) {
    const arr = Array.isArray(stress[key]) ? stress[key].map(Number) : null
    if (!Array.isArray(arr)) {
      return { ok: false, message: '应力.类型=tensor6 需要 xx/yy/zz/xy/yz/zx 数组' }
    }
    if (arr.length !== framesCount) {
      return { ok: false, message: `tensor6 分量长度必须为 ${framesCount}` }
    }
    tensor6[key] = arr
  }
  return { ok: true, tensor6 }
}

function buildPointConfigResult({
  originParsed,
  sizeParsed,
  time,
  unitTime,
  speedMs,
  framesCount,
  timePoints,
  unitStress,
  E,
  nu,
  yieldStrength,
  ucs,
  render,
  parsedPoints,
  allStress
}) {
  const ref =
    Number.isFinite(yieldStrength) && yieldStrength > 0
      ? yieldStrength
      : computeQuantile(allStress, 0.98) || 1
  const sizeResolved = sizeParsed || [200, 200, 100]
  const algo = defaultPointAlgo(sizeResolved, ref)
  const expandedPoints = expandPointSources(parsedPoints, sizeResolved, 100)
  return {
    ok: true,
    data: {
      sourceKind: 'points',
      origin: originParsed.origin,
      originMode: originParsed.mode,
      size: sizeParsed,
      time: {
        dimension: String(time?.['维度'] || unitTime || '秒'),
        speedMs: Number.isFinite(speedMs) && speedMs > 0 ? speedMs : 500,
        frames: framesCount,
        timePoints
      },
      unitStress,
      material: {
        E: Number.isFinite(E) && E > 0 ? E : null,
        nu: Number.isFinite(nu) ? nu : null,
        yieldStrength: Number.isFinite(yieldStrength) && yieldStrength > 0 ? yieldStrength : null,
        ucs: Number.isFinite(ucs) && ucs > 0 ? ucs : null
      },
      render,
      knownPoints: parsedPoints,
      points: expandedPoints,
      sourceCountRaw: parsedPoints.length,
      algo
    }
  }
}

function parseOptionalSize(size) {
  if (!(Array.isArray(size) && size.length === 3)) return { ok: true, size: null }
  const sx = Number(size[0])
  const sy = Number(size[1])
  const sz = Number(size[2])
  if (![sx, sy, sz].every(n => Number.isFinite(n) && n > 0)) {
    return { ok: false, message: '场尺寸格式错误：需要 3 个正数（单位米）' }
  }
  return { ok: true, size: [sx, sy, sz] }
}

function parsePointFileMeta(json, sizeParsed) {
  const time = json['时间']
  const units = json['单位']
  const material = json['材料']
  const renderNormalized = normalizeRenderConfig(json['渲染'])
  if (!renderNormalized.ok) return renderNormalized
  const timeDimension = String(time?.['维度'] || '秒')
  return {
    ok: true,
    time,
    unitTime: String(units?.['时间'] || timeDimension),
    unitStress: String(units?.['应力'] || 'MPa'),
    speedMs: Number(time?.['播放间隔毫秒'] || 500),
    yieldStrength: Number(material?.['屈服强度']),
    ucs: Number(material?.['单轴抗压强度_UCS'] ?? material?.['UCS']),
    E: Number(material?.['弹性模量E']),
    nu: Number(material?.['泊松比nu']),
    render: renderNormalized.data,
    sizeParsed
  }
}

function createEmptyTensor6(framesCount) {
  return {
    xx: new Array(framesCount).fill(null),
    yy: new Array(framesCount).fill(null),
    zz: new Array(framesCount).fill(null),
    xy: new Array(framesCount).fill(null),
    yz: new Array(framesCount).fill(null),
    zx: new Array(framesCount).fill(null)
  }
}

function buildPointDefMap(pointDefs, framesCount) {
  const defList = pointDefs.filter(p => p && typeof p === 'object')
  if (defList.length < 1) {
    return { ok: false, message: '点位格式错误：点位 需要为非空数组（路径：点位）' }
  }
  const byId = new Map()
  const order = []
  for (let i = 0; i < defList.length; i++) {
    const p = defList[i]
    const id = String(p['id'] ?? p['ID'] ?? '')
    if (!id) return { ok: false, message: `点位 第 ${i + 1} 项缺少 id（路径：点位[${i}].id）` }
    const centerParsed = parsePointCenter(p, {
      clampUVW: false,
      allowCenterWGS84Alias: true,
      validateWgs84All: false
    })
    if (!centerParsed.ok) {
      return {
        ok: false,
        message: `点位 第 ${i + 1} 项缺少中心坐标（中心_UVW/中心_ENU_m/中心_WGS84）（路径：点位[${i}]）`
      }
    }
    byId.set(id, {
      id,
      name: String(p['名称'] ?? p['name'] ?? p['名称'] ?? ''),
      coordMode: centerParsed.data.coordMode,
      center: centerParsed.data.center,
      tensor6: createEmptyTensor6(framesCount)
    })
    order.push(id)
  }
  return { ok: true, byId, order }
}

function assignTensorAtFrame(targetTensor6, fi, stress) {
  const xx = Number(stress['xx'])
  const yy = Number(stress['yy'])
  const zz = Number(stress['zz'])
  const xy = Number(stress['xy'])
  const yz = Number(stress['yz'])
  const zx = Number(stress['zx'])
  if (![xx, yy, zz, xy, yz, zx].every(Number.isFinite)) return false
  targetTensor6.xx[fi] = xx
  targetTensor6.yy[fi] = yy
  targetTensor6.zz[fi] = zz
  targetTensor6.xy[fi] = xy
  targetTensor6.yz[fi] = yz
  targetTensor6.zx[fi] = zx
  return true
}

function collectPointFrameData(timeFrames, byId) {
  const framesCount = timeFrames.length
  const timePoints = new Array(framesCount)
  for (let fi = 0; fi < framesCount; fi++) {
    const frame = timeFrames[fi]
    if (!frame || typeof frame !== 'object') {
      return { ok: false, message: `时间点 第 ${fi + 1} 项格式错误（路径：时间点[${fi}]）` }
    }
    const t = Number(frame['t'] ?? frame['时间'] ?? frame['time'] ?? fi)
    timePoints[fi] = Number.isFinite(t) ? t : fi
    const arr = Array.isArray(frame['点'])
      ? frame['点']
      : Array.isArray(frame['points'])
        ? frame['points']
        : null
    if (!arr) return { ok: false, message: `时间点 第 ${fi + 1} 项缺少 点（数组）` }
    for (let pi = 0; pi < arr.length; pi++) {
      const it = arr[pi]
      if (!it || typeof it !== 'object') continue
      const id = String(it['id'] ?? it['ID'] ?? '')
      if (!id) continue
      const target = byId.get(id)
      if (!target) continue
      const stress = it['应力'] && typeof it['应力'] === 'object' ? it['应力'] : it
      if (!assignTensorAtFrame(target.tensor6, fi, stress)) {
        return {
          ok: false,
          message: `时间点 第 ${fi + 1} 项 点 ${id} 应力分量不完整（xx/yy/zz/xy/yz/zx）（路径：时间点[${fi}].点[${pi}].应力）`
        }
      }
    }
  }
  return { ok: true, timePoints }
}

function finalizeFromTensorMap(order, byId, framesCount) {
  const parsedPoints = []
  const allStress = []
  for (const id of order) {
    const p = byId.get(id)
    const t6 = p.tensor6
    for (let i = 0; i < framesCount; i++) {
      if (
        ![t6.xx[i], t6.yy[i], t6.zz[i], t6.xy[i], t6.yz[i], t6.zx[i]].every(v =>
          Number.isFinite(Number(v))
        )
      ) {
        return {
          ok: false,
          message: `点 ${id} 在时间点索引 ${i} 缺少应力分量（路径：时间点[${i}].点[*].应力）`
        }
      }
    }
    const scalarSeries = computeScalarSeriesFromTensor6(t6, 'von_mises', null)
    for (const v of scalarSeries) if (Number.isFinite(v)) allStress.push(v)
    parsedPoints.push({
      id: p.id,
      name: p.name,
      coordMode: p.coordMode,
      center: p.center,
      stressSeries: scalarSeries,
      tensor6: t6
    })
  }
  return { ok: true, parsedPoints, allStress }
}

function parsePointFramesFormat(json, meta) {
  const timeFrames = Array.isArray(json['时间点']) ? json['时间点'] : null
  const pointDefs = Array.isArray(json['点位']) ? json['点位'] : null
  if (!(timeFrames && pointDefs)) return null
  const framesCount = timeFrames.length
  if (!Number.isInteger(framesCount) || framesCount < 1) {
    return { ok: false, message: '时间点格式错误：时间点 需要为非空数组（路径：时间点）' }
  }
  const defMap = buildPointDefMap(pointDefs, framesCount)
  if (!defMap.ok) return defMap
  const collected = collectPointFrameData(timeFrames, defMap.byId)
  if (!collected.ok) return collected
  const finalized = finalizeFromTensorMap(defMap.order, defMap.byId, framesCount)
  if (!finalized.ok) return finalized
  return buildPointConfigResult({
    originParsed: meta.originParsed,
    sizeParsed: meta.sizeParsed,
    time: meta.time,
    unitTime: meta.unitTime,
    speedMs: meta.speedMs,
    framesCount,
    timePoints: collected.timePoints,
    unitStress: meta.unitStress,
    E: meta.E,
    nu: meta.nu,
    yieldStrength: meta.yieldStrength,
    render: meta.render,
    parsedPoints: finalized.parsedPoints,
    allStress: finalized.allStress
  })
}

function buildComputedTensorIndex(computed) {
  if (!(computed?.ok && Array.isArray(computed.data?.points))) return null
  const byId = new Map()
  const byIndex = []
  for (let i = 0; i < computed.data.points.length; i++) {
    const it = computed.data.points[i]
    if (it?.tensor6) {
      byIndex[i] = it.tensor6
      if (it?.id) byId.set(String(it.id), it.tensor6)
    }
  }
  return { byId, byIndex }
}

function parsePointCenterEntry(p, index, sizeParsed) {
  const centerParsed = parsePointCenter(p, {
    clampUVW: true,
    allowCenterWGS84Alias: true,
    validateWgs84All: true
  })
  if (!centerParsed.ok) {
    return {
      ok: false,
      message: `点 第 ${index + 1} 项缺少中心坐标（中心_UVW/中心_ENU_m/中心_WGS84）`
    }
  }
  const coordMode = centerParsed.data.coordMode
  if ((coordMode === 'UVW' || coordMode === 'ENU') && !sizeParsed) {
    return {
      ok: false,
      message: `点 第 ${index + 1} 项使用 ${coordMode === 'UVW' ? '中心_UVW' : '中心_ENU_m'} 但缺少 场尺寸`
    }
  }
  return { ok: true, coordMode, center: centerParsed.data.center }
}

function parseFlatPointData(points, framesCount, sizeParsed, computedTensors) {
  const parsedPoints = []
  const allStress = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!p || typeof p !== 'object') return { ok: false, message: `点 第 ${i + 1} 项格式错误` }
    const id = String(p['id'] ?? p['ID'] ?? '')
    const name = String(p['名称'] ?? p['name'] ?? '')
    const center = parsePointCenterEntry(p, i, sizeParsed)
    if (!center.ok) return center
    let stressParsed = parsePointStressData(p, framesCount)
    if (!stressParsed.ok && stressParsed.message === '缺少 von_mises 或 应力') {
      const t6 = (id ? computedTensors?.byId?.get(id) : null) || computedTensors?.byIndex?.[i]
      if (t6) stressParsed = { ok: true, data: { kind: 'tensor6', tensor6: t6 } }
    }
    if (!stressParsed.ok)
      return { ok: false, message: `点 第 ${i + 1} 项应力：${stressParsed.message}` }
    const scalarSeries =
      stressParsed.data.kind === 'scalar'
        ? stressParsed.data.values
        : computeScalarSeriesFromTensor6(stressParsed.data.tensor6, 'von_mises', null)
    for (const v of scalarSeries) if (Number.isFinite(v)) allStress.push(v)
    parsedPoints.push({
      id,
      name,
      coordMode: center.coordMode,
      center: center.center,
      stressSeries: scalarSeries,
      tensor6: stressParsed.data.kind === 'tensor6' ? stressParsed.data.tensor6 : null
    })
  }
  return { ok: true, parsedPoints, allStress }
}

export function validateAndNormalizePointStressFileCore(
  json,
  { normalizeOrigin, computePointTensor6FromEngineering }
) {
  const originParsed = normalizeOrigin(json['坐标原点'])
  if (!originParsed.ok) return { ok: false, message: originParsed.message }
  const sizeResolved = parseOptionalSize(json['场尺寸'])
  if (!sizeResolved.ok) return sizeResolved
  const meta = parsePointFileMeta(json, sizeResolved.size)
  if (!meta?.ok) return meta
  meta.originParsed = originParsed

  const frameMode = parsePointFramesFormat(json, meta)
  if (frameMode) return frameMode

  const points = Array.isArray(json['点'])
    ? json['点']
    : Array.isArray(json['points'])
      ? json['points']
      : null
  const timePoints = Array.isArray(meta.time?.['时间点']) ? meta.time['时间点'].map(Number) : null
  const framesCount = timePoints?.length || Number(meta.time?.['帧数']) || 0
  if (!Number.isInteger(framesCount) || framesCount < 1) {
    return { ok: false, message: '时间信息错误：需要 时间.时间点 或 时间.帧数（路径：时间）' }
  }
  if (!points || points.length < 1) return { ok: false, message: '点应力文件缺少 点（数组）' }
  const computedTensors = buildComputedTensorIndex(computePointTensor6FromEngineering(json))
  const flatParsed = parseFlatPointData(points, framesCount, meta.sizeParsed, computedTensors)
  if (!flatParsed.ok) return flatParsed
  return buildPointConfigResult({
    originParsed,
    sizeParsed: meta.sizeParsed,
    time: meta.time,
    unitTime: meta.unitTime,
    speedMs: meta.speedMs,
    framesCount,
    timePoints: timePoints || Array.from({ length: framesCount }, (_, i) => i),
    unitStress: meta.unitStress,
    E: meta.E,
    nu: meta.nu,
    yieldStrength: meta.yieldStrength,
    render: meta.render,
    parsedPoints: flatParsed.parsedPoints,
    allStress: flatParsed.allStress
  })
}

// 缓存辅助函数
function getDatasetPointCache(pd) {
  if (!pd || typeof pd !== 'object') return null
  let pointCache = pointMetricSeriesCacheByDataset.get(pd)
  if (!pointCache) {
    pointCache = new WeakMap()
    pointMetricSeriesCacheByDataset.set(pd, pointCache)
  }
  return pointCache
}

function resolveStressDirection(direction) {
  return buildDirectionVector(direction || DEFAULT_DIRECTION)
}

// 指标行构建器
function buildMetricRow(t, tensor, details) {
  return {
    t,
    sxx: tensor.sxx,
    syy: tensor.syy,
    szz: tensor.szz,
    sxy: tensor.sxy,
    syz: tensor.syz,
    szx: tensor.szx,
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
  }
}

function appendMetricRow(rows, t, tensor, directionVector) {
  if (!isFiniteStressTensor(tensor)) return
  rows.push(buildMetricRow(t, tensor, buildStressDetails(tensor, directionVector)))
}

function resolveFramesAndContext(pointWC, ds) {
  if (!ds || !pointWC) return null
  const frames = ds.data?.frames || []
  if (frames.length === 0) return null
  const ctx = buildGridSampleContext(pointWC, ds.grid, ds.origin, ds.size)
  if (!ctx) return null
  return { frames, ctx }
}

function createMetricValueRow(t, value) {
  return {
    t,
    v: Number.isFinite(value) ? value : null
  }
}

// 点位详情/采样
export function buildPointConfigDetails(point, timeIndex, direction) {
  if (!point?.tensor6) return null
  const { xx, yy, zz, xy, yz, zx } = extractTensor6Arrays(point.tensor6)
  const maxIndex = Math.max(0, xx.length - 1)
  const t = Math.max(0, Math.min(maxIndex, timeIndex))
  const s = {
    sxx: xx[t],
    syy: yy[t],
    szz: zz[t],
    sxy: xy[t],
    syz: yz[t],
    szx: zx[t]
  }
  if (!isFiniteStressTensor(s)) return null

  const n = resolveStressDirection(direction)
  const details = buildStressDetails(s, n)

  return {
    tensor: s,
    principal: details.principal,
    invariants: details.invariants,
    traction: details.traction
  }
}

export function buildAllMetricsRowsFromTensor6(tensor6, pd, direction) {
  const timePoints = ensureArray(pd?.time?.timePoints)
  const { xx, yy, zz, xy, yz, zx } = extractTensor6Arrays(tensor6)
  const frames = getTensor6FrameCount(tensor6)
  if (frames < 1) return []

  const n = resolveStressDirection(direction)

  const rows = []
  for (let i = 0; i < frames; i++) {
    appendMetricRow(
      rows,
      timePoints[i] ?? i,
      { sxx: xx[i], syy: yy[i], szz: zz[i], sxy: xy[i], syz: yz[i], szx: zx[i] },
      n
    )
  }
  return rows
}

export function buildPointSeriesForMetric(pointWC, ds, metricKey, direction) {
  const resolved = resolveFramesAndContext(pointWC, ds)
  if (!resolved) return []

  const out = []
  const { frames, ctx } = resolved
  const timePoints = ensureArray(ds.time?.timePoints)
  const n = metricKey === 'snn' || metricKey === 'tau_n' ? resolveStressDirection(direction) : null

  for (let i = 0; i < frames.length; i++) {
    const t = timePoints[i] ?? i
    const src = frames[i]
    const tensor6 = sampleTensor6AtContext(src, ctx)
    if (!tensor6) {
      out.push(createMetricValueRow(t, null))
      continue
    }
    const s = toStressTensor(ds, tensor6)
    const v = computeMetricValue(metricKey, s, n)
    out.push(createMetricValueRow(t, v))
  }
  return out
}

export function buildPointAllMetricsSeries(pointWC, ds, direction) {
  const resolved = resolveFramesAndContext(pointWC, ds)
  if (!resolved) return []

  const { frames, ctx } = resolved
  const n = resolveStressDirection(direction)
  const timePoints = ensureArray(ds.time?.timePoints)

  const rows = []
  for (let i = 0; i < frames.length; i++) {
    const src = frames[i]
    const tensor6 = sampleTensor6AtContext(src, ctx)
    if (!tensor6) continue
    const s = toStressTensor(ds, tensor6)
    appendMetricRow(rows, timePoints[i] ?? i, s, n)
  }
  return rows
}

// 点位扩展/渲染辅助函数
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

export function resolveEffectiveStressRef(pd, globalMaxAbs = null) {
  let ref = Number(pd?.algo?.stressRef)
  if (!(Number.isFinite(ref) && ref > 0)) ref = Number(globalMaxAbs)
  if (!(Number.isFinite(ref) && ref > 0)) ref = 1
  const maxAbs = Number(globalMaxAbs)
  if (Number.isFinite(maxAbs) && maxAbs > 0 && ref > maxAbs * 5) ref = maxAbs
  return ref
}

function resolveSeriesDirection(metric, direction) {
  return metric === 'snn' || metric === 'tau_n' ? resolveStressDirection(direction) : null
}

// 带缓存的指标序列
export function getPointMetricSeriesValues(point, pd, metricKey, direction, overlayItems) {
  const pointCache = getDatasetPointCache(pd)
  if (pointCache && point && typeof point === 'object') {
    let metricCache = pointCache.get(point)
    if (!metricCache) {
      metricCache = new Map()
      pointCache.set(point, metricCache)
    }
    const cacheKey = [
      String(metricKey || 'von_mises'),
      buildDirectionSignature(direction),
      buildOverlaySignature(overlayItems),
      resolveEffectiveStressRef(pd),
      buildSafetySignature(pd?.safetyContext)
    ].join('::')
    if (metricCache.has(cacheKey)) return metricCache.get(cacheKey)
    const computed = computePointMetricSeriesValues(point, pd, metricKey, direction, overlayItems)
    metricCache.set(cacheKey, computed)
    return computed
  }
  return computePointMetricSeriesValues(point, pd, metricKey, direction, overlayItems)
}

function computePointMetricSeriesValues(point, pd, metricKey, direction, overlayItems) {
  const metric = String(metricKey || 'von_mises')
  const algoRef = resolveEffectiveStressRef(pd)
  const safetyContext = pd?.safetyContext || null
  const localPos = point?.localPos || resolvePointLocalPosition(point, pd?.size)
  const safetyExtra = { safetyContext, localPos }

  if (metric === 'overlay') {
    if (!point?.tensor6) return ensureArray(point?.stressSeries)
    const items = ensureArray(overlayItems)
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
      const n = resolveSeriesDirection(mk, direction)
      const series = computeScalarSeriesFromTensor6(
        point.tensor6,
        mk,
        n,
        isSafetyMetric(mk) ? safetyExtra : null
      ).map(v => (Number.isFinite(v) ? Math.abs(v) : 0))
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
    const n = resolveSeriesDirection(metric, direction)
    return computeScalarSeriesFromTensor6(
      point.tensor6,
      metric,
      n,
      isSafetyMetric(metric) ? safetyExtra : null
    )
  }
  return []
}

// 渲染/插值入口点
export function buildRenderablePointsFromPointDataset(pd, metricKey, direction, overlayItems) {
  const baseAlgo = pd?.algo || defaultPointAlgo(pd?.size, 1)
  const algo = { ...baseAlgo }
  const timePoints = ensureArray(pd?.time?.timePoints)

  const raw = ensureArray(pd?.points).slice(0, 1000)
  let globalMaxAbs = 0
  for (const p of raw) {
    const series = getPointMetricSeriesValues(p, pd, metricKey, direction, overlayItems)
    for (const v of series) {
      const n = Math.abs(Number(v))
      if (Number.isFinite(n) && n > globalMaxAbs) globalMaxAbs = n
    }
  }
  algo.stressRef = isSafetyMetric(metricKey)
    ? 10
    : resolveEffectiveStressRef({ algo }, globalMaxAbs)
  if (Number.isFinite(algo.lowCut) && algo.lowCut > 0.02) algo.lowCut = 0.02

  return raw.map((p, idx) => {
    const series = getPointMetricSeriesValues(p, pd, metricKey, direction, overlayItems)

    const intensitySeries = isSafetyMetric(metricKey)
      ? series.map(s => mapSafetyScoreToIntensity(s))
      : series.map(s => mapStressToIntensity(s, algo))
    const radiusSeries = isSafetyMetric(metricKey)
      ? series.map(s => mapSafetyScoreToRadius(s, algo))
      : series.map(s => mapStressToRadius(s, algo))
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

export function buildInterpolatedScalarFieldFromPointDataset(
  pd,
  metricKey,
  direction,
  overlayItems,
  options = {}
) {
  return interpolationManager.buildInterpolatedScalarFieldFromPointDataset(
    pd,
    metricKey,
    direction,
    overlayItems,
    options
  )
}

export async function buildInterpolatedScalarFieldFromPointDatasetAsync(
  pd,
  metricKey,
  direction,
  overlayItems,
  options = {}
) {
  const { buildInterpolatedScalarFieldAsync } =
    await import('../interpolation/pointInterpolationWorkerRuntime.js')
  return buildInterpolatedScalarFieldAsync(
    buildInterpolatedScalarFieldFromPointDataset,
    pd,
    metricKey,
    direction,
    overlayItems,
    options
  )
}

export function buildPointConfigSeries(point, pd, metricKey, direction, overlayItems) {
  const timePoints = ensureArray(pd?.time?.timePoints)
  const seriesValues = getPointMetricSeriesValues(point, pd, metricKey, direction, overlayItems)

  return seriesValues.map((v, i) => createMetricValueRow(timePoints[i] ?? i, v))
}
