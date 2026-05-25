import {
  computeQuantile,
  computeScalarSeriesFromTensor6,
  defaultPointAlgo,
  expandPointSources,
  parsePointCenter
} from '../points/stressPointCore.js'

export function parsePointStressData(point, framesCount) {
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

export function buildPointConfigResult({
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
      __type: 'point_config',
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
        yieldStrength: Number.isFinite(yieldStrength) && yieldStrength > 0 ? yieldStrength : null
      },
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
  const timeDimension = String(time?.['维度'] || '秒')
  return {
    time,
    unitTime: String(units?.['时间'] || timeDimension),
    unitStress: String(units?.['应力'] || 'MPa'),
    speedMs: Number(time?.['播放间隔毫秒'] || 500),
    yieldStrength: Number(material?.['屈服强度']),
    E: Number(material?.['弹性模量E']),
    nu: Number(material?.['泊松比nu']),
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
    parsedPoints: flatParsed.parsedPoints,
    allStress: flatParsed.allStress
  })
}
