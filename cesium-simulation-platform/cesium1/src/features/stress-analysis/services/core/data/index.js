import {
  buildAllMetricsRowsFromTensor6,
  buildInterpolatedScalarFieldFromPointDataset,
  buildInterpolatedScalarFieldFromPointDatasetAsync,
  buildPointAllMetricsSeries,
  buildPointConfigDetails,
  buildPointConfigSeries,
  buildPointSeriesForMetric,
  buildRenderablePointsFromPointDataset,
  defaultPointAlgo,
  expandPointSources,
  getPointMetricSeriesValues,
  resolveEffectiveStressRef,
  validateAndNormalizePointStressFileCore
} from './pointCore.js'
import { normalizeRenderConfig } from './foundation.js'
import {
  buildFramesFromData,
  buildTimeAxis,
  decodeComponentArray,
  generateFrames,
  generateFramesCompositeLoad
} from './foundation.js'
import { computePointTensor6FromEngineering } from './foundation.js'

export {
  buildFramesFromData,
  buildAllMetricsRowsFromTensor6,
  buildInterpolatedScalarFieldFromPointDataset,
  buildInterpolatedScalarFieldFromPointDatasetAsync,
  buildPointAllMetricsSeries,
  buildPointConfigDetails,
  buildPointConfigSeries,
  buildPointSeriesForMetric,
  buildTimeAxis,
  buildRenderablePointsFromPointDataset,
  computePointTensor6FromEngineering,
  decodeComponentArray,
  defaultPointAlgo,
  expandPointSources,
  generateFrames,
  generateFramesCompositeLoad,
  getPointMetricSeriesValues,
  normalizeRenderConfig,
  resolveEffectiveStressRef
}

export function normalizeOrigin(origin) {
  if (Array.isArray(origin) && origin.length >= 2) {
    const lon = Number(origin[0])
    const lat = Number(origin[1])
    const h = Number(origin[2] || 0)
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(h)) {
      return { ok: false, message: '坐标原点数值错误：经度/纬度/高度 必须为有限数字' }
    }
    if (lon < -180 || lon > 180) {
      return { ok: false, message: '坐标原点范围错误：经度需在 [-180, 180] 内' }
    }
    if (lat < -90 || lat > 90) {
      return { ok: false, message: '坐标原点范围错误：纬度需在 [-90, 90] 内' }
    }
    return {
      ok: true,
      mode: '数值',
      origin: [lon, lat, h]
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

function classifyStressDataShape(json) {
  if (!json || typeof json !== 'object') return ''
  if (Array.isArray(json['时间点']) && Array.isArray(json['点位'])) return 'point_frames'
  if (Array.isArray(json['点']) || Array.isArray(json.points)) return 'point_series'
  if (json['网格'] && json['数据']) return 'grid_field'
  return ''
}

function validateAndNormalizePointStressFile(json) {
  return validateAndNormalizePointStressFileCore(json, {
    normalizeOrigin,
    computePointTensor6FromEngineering
  })
}

function validateAndNormalizeGridStressFile(json) {
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
  const ucs = Number(material?.['单轴抗压强度_UCS'] ?? material?.['UCS'])
  const shearDef = String(material?.['剪应变定义'] || '张量')
  if (law !== '线弹性各向同性') {
    return { ok: false, message: '材料.本构 目前仅支持"线弹性各向同性"' }
  }
  if (!(E > 0) || !Number.isFinite(E)) return { ok: false, message: '材料.弹性模量E 必须为正数' }
  if (!Number.isFinite(nu) || nu <= -0.999 || nu >= 0.499) {
    return { ok: false, message: '材料.泊松比nu 取值范围应为 (-1, 0.5)' }
  }
  if (!['张量', '工程'].includes(shearDef)) {
    return { ok: false, message: '材料.剪应变定义 仅允许"张量"或"工程"' }
  }
  const dataType = String(data?.['类型'] || '')
  if (!['应力', '应变'].includes(dataType)) {
    return { ok: false, message: '数据.类型 仅允许"应力"或"应变"' }
  }
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
      material: {
        law,
        E,
        nu,
        shearDef,
        ucs: Number.isFinite(ucs) && ucs > 0 ? ucs : null
      },
      data: { type: dataType, frames },
      unitStress,
      render: normalizedRender.data
    }
  }
}

export function validateAndNormalizeStressFile(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, message: '文件内容为空或不是对象' }
  }
  const shape = classifyStressDataShape(json)
  if (shape === 'point_frames' || shape === 'point_series') {
    return validateAndNormalizePointStressFile(json)
  }
  if (shape === 'grid_field') return validateAndNormalizeGridStressFile(json)

  return {
    ok: false,
    message: '无法识别导入数据：请提供 点/点位+时间点 或 网格+数据 等必要字段'
  }
}
