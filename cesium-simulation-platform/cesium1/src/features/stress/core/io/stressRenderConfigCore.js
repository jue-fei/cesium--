import {
  STRESS_BASE_METRIC_SET,
  STRESS_METRIC_ALIAS_MAP
} from '../computation/stressComputation.js'
import { parsePointCenter } from '../points/stressPointCore.js'

function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function normalizeMetricKey(val) {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  if (STRESS_BASE_METRIC_SET.has(s)) return s
  return STRESS_METRIC_ALIAS_MAP[s] || null
}

function normalizeHeatmapPoints(list) {
  if (!Array.isArray(list)) return { ok: true, data: null }
  const out = []
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (!p || typeof p !== 'object')
      return { ok: false, message: `渲染.热力图.点位 第 ${i + 1} 项格式错误` }

    const id = String(p['id'] ?? p['ID'] ?? '')
    const name = String(p['名称'] ?? p['name'] ?? '')
    const radius = Number(p['半径_m'] ?? p['radius_m'] ?? p['radius'] ?? 50)
    const base = Number(p['强度'] ?? p['base'] ?? 1)
    const timeSeries = Array.isArray(p['时间序列'])
      ? p['时间序列'].map(Number)
      : Array.isArray(p['timeSeries'])
        ? p['timeSeries'].map(Number)
        : []

    if (!Number.isFinite(radius) || radius <= 0) {
      return { ok: false, message: `渲染.热力图.点位 第 ${i + 1} 项 半径_m 必须为正数` }
    }
    if (!Number.isFinite(base) || base < 0) {
      return { ok: false, message: `渲染.热力图.点位 第 ${i + 1} 项 强度 必须为非负数` }
    }

    const centerParsed = parsePointCenter(p, {
      clampUVW: true,
      allowCenterWGS84Alias: true,
      validateWgs84All: true
    })
    if (!centerParsed.ok) {
      return {
        ok: false,
        message: `渲染.热力图.点位 第 ${i + 1} 项缺少中心坐标（中心_UVW/中心_ENU_m/中心_WGS84）`
      }
    }
    out.push({
      id,
      name,
      coordMode: centerParsed.data.coordMode,
      center: centerParsed.data.center,
      radius,
      base,
      timeSeries
    })
  }
  return { ok: true, data: out.slice(0, 4) }
}

function normalizeHeatmapMask(mask) {
  if (mask === null || mask === undefined) return { ok: true, data: null }
  if (!mask || typeof mask !== 'object')
    return { ok: false, message: '渲染.热力图.遮罩 格式错误：需要对象' }
  const mode = String(mask['模式'] ?? mask['mode'] ?? '无')
  const power = Number(mask['幂'] ?? mask['power'] ?? 2)
  const cutoff = Number(mask['截断'] ?? mask['cutoff'] ?? 0.02)
  if (!Number.isFinite(power) || power <= 0)
    return { ok: false, message: '渲染.热力图.遮罩.幂 必须为正数' }
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff >= 1)
    return { ok: false, message: '渲染.热力图.遮罩.截断 需满足 0<=截断<1' }
  const normalizedMode = mode === '点位' || mode === 'points' ? 'points' : 'none'
  return { ok: true, data: { mode: normalizedMode, power, cutoff } }
}

function normalizeHeatmapDerived(derived) {
  if (derived === null || derived === undefined) return { ok: true, data: null }
  if (!derived || typeof derived !== 'object')
    return { ok: false, message: '渲染.热力图.衍生 格式错误：需要对象' }
  const contour = derived['等值线'] ?? derived['contour'] ?? {}
  const glow = derived['高应力发光'] ?? derived['glow'] ?? {}
  const marker = derived['点标记'] ?? derived['marker'] ?? {}
  const contourEnabled = Boolean(contour['启用'] ?? contour['enabled'] ?? false)
  const contourLevels = Number(contour['级数'] ?? contour['levels'] ?? 12)
  const contourWidth = Number(contour['宽度'] ?? contour['width'] ?? 0.06)
  const glowEnabled = Boolean(glow['启用'] ?? glow['enabled'] ?? false)
  const glowThreshold = Number(glow['阈值'] ?? glow['threshold'] ?? 0.8)
  const glowStrength = Number(glow['强度'] ?? glow['strength'] ?? 0.35)
  const markerEnabled = Boolean(marker['启用'] ?? marker['enabled'] ?? false)
  const markerRadius = Number(marker['半径_m'] ?? marker['radius_m'] ?? 6)
  if (!Number.isFinite(contourLevels) || contourLevels < 2)
    return { ok: false, message: '渲染.热力图.衍生.等值线.级数 必须为 >=2 的数字' }
  if (!Number.isFinite(contourWidth) || contourWidth <= 0 || contourWidth >= 0.5)
    return { ok: false, message: '渲染.热力图.衍生.等值线.宽度 需满足 0<宽度<0.5' }
  if (!Number.isFinite(glowThreshold) || glowThreshold < 0 || glowThreshold > 1)
    return { ok: false, message: '渲染.热力图.衍生.高应力发光.阈值 需满足 0<=阈值<=1' }
  if (!Number.isFinite(glowStrength) || glowStrength < 0 || glowStrength > 1)
    return { ok: false, message: '渲染.热力图.衍生.高应力发光.强度 需满足 0<=强度<=1' }
  if (!Number.isFinite(markerRadius) || markerRadius <= 0)
    return { ok: false, message: '渲染.热力图.衍生.点标记.半径_m 必须为正数' }
  return {
    ok: true,
    data: {
      contour: { enabled: contourEnabled, levels: contourLevels, width: contourWidth },
      glow: { enabled: glowEnabled, threshold: glowThreshold, strength: glowStrength },
      marker: { enabled: markerEnabled, radius: markerRadius }
    }
  }
}

function normalizeValueRange(valueRange) {
  if (valueRange === undefined || valueRange === null) return { ok: true, data: null }
  if (!valueRange || typeof valueRange !== 'object') {
    return { ok: false, message: '渲染.值域 格式错误：需要对象' }
  }
  const mode = String(valueRange['模式'] || '自动')
  if (mode === '手动') {
    const min = Number(valueRange['最小'])
    const max = Number(valueRange['最大'])
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      return { ok: false, message: '渲染.值域 手动模式需要 最小 < 最大' }
    }
    return { ok: true, data: { mode: '手动', min, max } }
  }
  if (mode === '分位数') {
    const q = Array.isArray(valueRange['分位数']) ? valueRange['分位数'].map(Number) : null
    const qLow = q?.[0]
    const qHigh = q?.[1]
    if (
      !Number.isFinite(qLow) ||
      !Number.isFinite(qHigh) ||
      qLow < 0 ||
      qHigh > 1 ||
      qLow >= qHigh
    ) {
      return { ok: false, message: '渲染.值域 分位数模式需要 分位数=[低,高] 且 0<=低<高<=1' }
    }
    return { ok: true, data: { mode: '分位数', qLow, qHigh } }
  }
  if (mode === '对称零点') {
    const maxAbs = Number(valueRange['最大绝对值'])
    const q = Array.isArray(valueRange['分位数']) ? valueRange['分位数'].map(Number) : null
    const qHigh = Number.isFinite(q?.[1]) ? q?.[1] : Number.isFinite(q?.[0]) ? q?.[0] : null
    if (Number.isFinite(maxAbs) && maxAbs <= 0) {
      return { ok: false, message: '渲染.值域 对称零点模式下 最大绝对值 必须为正数' }
    }
    if (qHigh !== null && (!Number.isFinite(qHigh) || qHigh <= 0 || qHigh > 1)) {
      return {
        ok: false,
        message: '渲染.值域 对称零点模式下 分位数 需为 (0,1]（可写 [0.98] 或 [0,0.98]）'
      }
    }
    return {
      ok: true,
      data: {
        mode: '对称零点',
        maxAbs: Number.isFinite(maxAbs) ? maxAbs : null,
        qHigh
      }
    }
  }
  if (mode === '自动') return { ok: true, data: { mode: '自动' } }
  return { ok: false, message: '渲染.值域.模式 仅允许 自动/手动/分位数/对称零点' }
}

export function normalizeRenderConfig(render) {
  if (render === undefined || render === null) return { ok: true, data: null }
  if (!render || typeof render !== 'object')
    return { ok: false, message: '渲染配置格式错误：需要对象' }
  const heatmap = render['热力图']
  const valueRange = render['值域']
  const defaults = {
    colorRamp: [
      { value: 0.25, color: '#4caf50', label: '低' },
      { value: 0.5, color: '#ffeb3b', label: '中' },
      { value: 0.75, color: '#ff9800', label: '高' },
      { value: 1.0, color: '#f44336', label: '极高' }
    ],
    diffuseMix: 0.85,
    emissiveMix: 0.7
  }
  let colorRamp = defaults.colorRamp
  let diffuseMix = defaults.diffuseMix
  let emissiveMix = defaults.emissiveMix
  let colorLUT = null
  let heatmapPoints = null
  let heatmapMask = null
  let heatmapDerived = null

  if (heatmap && typeof heatmap === 'object') {
    const ramp = Array.isArray(heatmap['配色带']) ? heatmap['配色带'] : null
    if (ramp) {
      if (ramp.length < 4) return { ok: false, message: '渲染.热力图.配色带 至少需要 4 项' }
      const out = []
      for (let idx = 0; idx < 4; idx++) {
        const r = ramp[idx]
        const vRaw = r?.['位置'] ?? r?.['value'] ?? r?.['value01']
        const value = Number(vRaw)
        const color = String(r?.['颜色'] ?? r?.['color'] ?? '')
        const label = r?.['标签'] !== undefined ? String(r['标签']) : undefined
        if (!Number.isFinite(value)) {
          return { ok: false, message: `渲染.热力图.配色带 第 ${idx + 1} 项位置不是数字` }
        }
        if (!color) return { ok: false, message: `渲染.热力图.配色带 第 ${idx + 1} 项颜色为空` }
        out.push({ value: Math.max(0, Math.min(1, value)), color, label })
      }
      colorRamp = out
    }

    const lut = heatmap['LUT'] ?? heatmap['lut'] ?? null
    if (lut !== null && lut !== undefined) {
      if (!lut || typeof lut !== 'object')
        return { ok: false, message: '渲染.热力图.LUT 格式错误：需要对象' }
      const preset = String(lut['色标'] ?? lut['preset'] ?? '')
      const size = Number(lut['级数'] ?? lut['size'] ?? 0)
      const table = Array.isArray(lut['表'])
        ? lut['表']
        : Array.isArray(lut['table'])
          ? lut['table']
          : null
      if (!(Number.isInteger(size) && size >= 2))
        return { ok: false, message: '渲染.热力图.LUT.级数 必须为 >=2 的整数' }
      if (table) {
        if (table.length !== size)
          return { ok: false, message: '渲染.热力图.LUT 表长度必须与 级数 一致' }
        colorLUT = { preset, size, table }
      } else {
        if (!preset) return { ok: false, message: '渲染.热力图.LUT 需要提供 色标 或 表' }
        colorLUT = { preset, size, table: null }
      }
    }

    const pointsRaw = Array.isArray(heatmap['点位'])
      ? heatmap['点位']
      : Array.isArray(heatmap['points'])
        ? heatmap['points']
        : null
    if (pointsRaw) {
      const parsed = normalizeHeatmapPoints(pointsRaw)
      if (!parsed.ok) return parsed
      heatmapPoints = parsed.data
    }
    const maskRaw = heatmap['遮罩'] ?? heatmap['mask'] ?? null
    if (maskRaw !== null && maskRaw !== undefined) {
      const parsed = normalizeHeatmapMask(maskRaw)
      if (!parsed.ok) return parsed
      heatmapMask = parsed.data
    }
    const derivedRaw = heatmap['衍生'] ?? heatmap['derived'] ?? null
    if (derivedRaw !== null && derivedRaw !== undefined) {
      const parsed = normalizeHeatmapDerived(derivedRaw)
      if (!parsed.ok) return parsed
      heatmapDerived = parsed.data
    }
    const mix = heatmap['混合']
    if (mix && typeof mix === 'object') {
      const d = mix['扩散']
      const e = mix['自发光']
      if (d !== undefined) diffuseMix = clamp01(Number(d))
      if (e !== undefined) emissiveMix = clamp01(Number(e))
    }
  }

  const valueRangeNormalized = normalizeValueRange(valueRange)
  if (!valueRangeNormalized.ok) return valueRangeNormalized
  let defaultMetric = null
  if (render['默认显示量'] !== undefined) {
    const m = normalizeMetricKey(render['默认显示量'])
    if (!m) {
      return {
        ok: false,
        message: '渲染.默认显示量 不支持（可填：等效应力/主应力/六分量/方向正应力等）'
      }
    }
    defaultMetric = m
  }

  return {
    ok: true,
    data: {
      colorRamp,
      colorLUT,
      heatmapPoints,
      heatmapMask,
      heatmapDerived,
      diffuseMix,
      emissiveMix,
      valueRange: valueRangeNormalized.data,
      defaultMetric
    }
  }
}
