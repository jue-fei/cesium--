import { validateAndNormalizePointStressFileCore } from './stressPointDataCore.js'
import { normalizeRenderConfig } from './stressRenderConfigCore.js'
import {
  buildFramesFromData,
  buildTimeAxis,
  decodeComponentArray,
  generateFrames,
  generateFramesCompositeLoad
} from './stressDataFrameCodecCore.js'
import { computePointTensor6FromEngineering } from './stressEngineeringComputeCore.js'

export {
  buildFramesFromData,
  buildTimeAxis,
  computePointTensor6FromEngineering,
  decodeComponentArray,
  generateFrames,
  generateFramesCompositeLoad
}

export function normalizeOrigin(origin) {
  if (Array.isArray(origin) && origin.length >= 2) {
    return {
      ok: true,
      mode: '数值',
      origin: [Number(origin[0]), Number(origin[1]), Number(origin[2] || 0)]
    }
  }
  if (origin && typeof origin === 'object') {
    const mode = String(origin['模式'] || '')
    if (mode === '模型中心') {
      return { ok: true, mode: '模型中心', origin: [0, 0, 0] }
    }
  }
  return { ok: false, message: '坐标原点格式错误：需要 [经度, 纬度, 高度?] 或 { 模式: 模型中心 }' }
}

export function inferMissingHints(message) {
  const m = String(message || '')
  const out = []
  if (m.includes('格式版本')) out.push('检查：格式版本 需为 “应力点-1.0” 或 “应力分析-1.0”')
  if (m.includes('坐标原点')) out.push('检查：坐标原点 为 [经度,纬度,高] 或 {模式:"模型中心"}')
  if (m.includes('时间')) out.push('检查：时间.时间点=[...] 或 时间.帧数')
  if (m.includes('点')) out.push('检查：点=[...] 且每个点包含 中心_* 与 von_mises')
  if (m.includes('场尺寸')) out.push('检查：场尺寸=[sx,sy,sz]（点使用UV/ENU时必填）')
  if (m.includes('von_mises')) out.push('检查：von_mises 长度需与 时间帧数一致')
  return out
}

export function buildImportDiagnostics(json) {
  if (!json || typeof json !== 'object') return null
  const version = String(json['格式版本'] || '')
  if (!version) return null

  if (version === '应力分析-1.0') {
    const keys = ['坐标原点', '场尺寸', '网格', '时间', '材料', '数据']
    const checks = keys.map(k => ({ 字段: k, 存在: Object.prototype.hasOwnProperty.call(json, k) }))
    const grid = json['网格']
    const w = Number(grid?.['宽'])
    const h = Number(grid?.['高'])
    const d = Number(grid?.['深'])
    const total =
      Number.isInteger(w) && Number.isInteger(h) && Number.isInteger(d) ? w * h * d : null
    const time = json['时间']
    const timePoints = Array.isArray(time?.['时间点']) ? time['时间点'] : []
    const data = json['数据']
    const frames = Array.isArray(data?.['帧']) ? data['帧'] : []
    const first = frames[0] || null
    const compLens = {}
    for (const k of ['xx', 'yy', 'zz', 'xy', 'yz', 'zx']) {
      const arr = Array.isArray(first?.[k]) ? first[k] : null
      compLens[k] = arr ? arr.length : null
    }
    return {
      version,
      topKeys: Object.keys(json),
      checks,
      stats: {
        网格: [w, h, d],
        总点数: total,
        时间点数量: timePoints.length,
        帧数量: frames.length,
        首帧分量长度: compLens
      }
    }
  }

  if (version === '应力点-2.0') {
    const pointDefs = Array.isArray(json['点位']) ? json['点位'] : []
    const timeFrames = Array.isArray(json['时间点']) ? json['时间点'] : []
    const firstPoints = Array.isArray(timeFrames?.[0]?.['点']) ? timeFrames[0]['点'] : []
    const defIds = new Set(pointDefs.map(p => String(p?.['id'] ?? p?.['ID'] ?? '')).filter(Boolean))
    const firstIds = new Set(
      firstPoints.map(p => String(p?.['id'] ?? p?.['ID'] ?? '')).filter(Boolean)
    )
    const missingInFirst = [...defIds].filter(id => !firstIds.has(id))
    const extraInFirst = [...firstIds].filter(id => !defIds.has(id))
    const checks = [
      { 字段: '点位', 存在: pointDefs.length > 0, 说明: `数量=${pointDefs.length}` },
      { 字段: '时间点', 存在: timeFrames.length > 0, 说明: `数量=${timeFrames.length}` }
    ]

    return {
      version,
      topKeys: Object.keys(json),
      checks,
      stats: {
        点位数量: pointDefs.length,
        时间点数量: timeFrames.length,
        首帧点数量: firstPoints.length,
        首帧缺失点位: missingInFirst.slice(0, 20),
        首帧多余点: extraInFirst.slice(0, 20)
      }
    }
  }

  if (version === '应力点-1.0') {
    const points = Array.isArray(json['点'])
      ? json['点']
      : Array.isArray(json.points)
        ? json.points
        : []
    const tp = Array.isArray(json?.['时间']?.['时间点']) ? json['时间']['时间点'] : null
    return {
      version,
      topKeys: Object.keys(json),
      checks: [
        { 字段: '时间.时间点', 存在: Array.isArray(tp) && tp.length > 0, 说明: '' },
        { 字段: '点', 存在: points.length > 0, 说明: `数量=${points.length}` }
      ],
      stats: { 点数量: points.length, 帧数: Array.isArray(tp) ? tp.length : 0 }
    }
  }

  return { version, topKeys: Object.keys(json), checks: [], stats: {} }
}

export function validateAndNormalizePointStressFile(json) {
  return validateAndNormalizePointStressFileCore(json, {
    normalizeOrigin,
    computePointTensor6FromEngineering
  })
}

export function validateAndNormalizeStressFile(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, message: '文件内容为空或不是对象' }
  }
  const version = json['格式版本']
  if (version === '应力点-1.0' || version === '应力点-2.0') {
    return validateAndNormalizePointStressFile(json)
  }
  if (version !== '应力分析-1.0') {
    return { ok: false, message: '格式版本不匹配：需要“应力分析-1.0”或“应力点-1.0/2.0”' }
  }
  const origin = json['坐标原点']
  const size = json['场尺寸']
  const grid = json['网格']
  const time = json['时间']
  const material = json['材料']
  const data = json['数据']
  const units = json['单位']
  const render = json['渲染']

  const originParsed = normalizeOrigin(origin)
  if (!originParsed.ok) return { ok: false, message: originParsed.message }
  if (!Array.isArray(size) || size.length !== 3) {
    return { ok: false, message: '场尺寸格式错误：需要 [东向长度, 北向长度, 上向长度]（单位米）' }
  }
  if (!grid || typeof grid !== 'object') {
    return { ok: false, message: '网格格式错误：需要 { 宽, 高, 深 }' }
  }
  const width = Number(grid['宽'])
  const height = Number(grid['高'])
  const depth = Number(grid['深'])
  if (![width, height, depth].every(n => Number.isInteger(n) && n > 1)) {
    return { ok: false, message: '网格尺寸错误：宽/高/深必须为大于 1 的整数' }
  }
  const timePoints = Array.isArray(time?.['时间点']) ? time['时间点'].map(Number) : null
  const framesCount = timePoints?.length || Number(time?.['帧数']) || 0
  if (!Number.isInteger(framesCount) || framesCount < 1) {
    return { ok: false, message: '时间信息错误：需要 时间.时间点 或 时间.帧数' }
  }
  const timeDimension = String(time?.['维度'] || '秒')
  const speedMs = Number(time?.['播放间隔毫秒'] || 500)
  const law = String(material?.['本构'] || '')
  const E = Number(material?.['弹性模量E'])
  const nu = Number(material?.['泊松比nu'])
  const shearDef = String(material?.['剪应变定义'] || '张量')
  if (law !== '线弹性各向同性')
    return { ok: false, message: '材料.本构 目前仅支持“线弹性各向同性”' }
  if (!(E > 0) || !Number.isFinite(E)) return { ok: false, message: '材料.弹性模量E 必须为正数' }
  if (!Number.isFinite(nu) || nu <= -0.999 || nu >= 0.499) {
    return { ok: false, message: '材料.泊松比nu 取值范围应为 (-1, 0.5)' }
  }
  if (!['张量', '工程'].includes(shearDef)) {
    return { ok: false, message: '材料.剪应变定义 仅允许“张量”或“工程”' }
  }
  const dataType = String(data?.['类型'] || '')
  if (!['应力', '应变'].includes(dataType))
    return { ok: false, message: '数据.类型 仅允许“应力”或“应变”' }
  const total = width * height * depth
  const requiredKeys = ['xx', 'yy', 'zz', 'xy', 'yz', 'zx']
  const framesParsed = buildFramesFromData(data, { framesCount, total, requiredKeys })
  if (!framesParsed.ok) return { ok: false, message: framesParsed.message }
  const frames = framesParsed.frames
  const unitStress = String(units?.['应力'] || 'MPa')
  const unitTime = String(units?.['时间'] || timeDimension)
  const normalizedRender = normalizeRenderConfig(render)
  if (!normalizedRender.ok) return { ok: false, message: normalizedRender.message }
  return {
    ok: true,
    data: {
      origin: originParsed.origin,
      originMode: originParsed.mode,
      size: [Number(size[0]), Number(size[1]), Number(size[2])],
      grid: { width, height, depth },
      time: {
        dimension: String(time?.['维度'] || unitTime || '秒'),
        speedMs: Number.isFinite(speedMs) && speedMs > 0 ? speedMs : 500,
        frames: frames.length,
        timePoints: timePoints || frames.map((_, idx) => idx)
      },
      material: { law, E, nu, shearDef },
      data: { type: dataType, frames },
      unitStress,
      render: normalizedRender.data
    }
  }
}
