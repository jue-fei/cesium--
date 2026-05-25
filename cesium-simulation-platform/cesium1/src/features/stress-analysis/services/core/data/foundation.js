import { STRESS_BASE_METRIC_SET, STRESS_METRIC_ALIAS_MAP } from '../computation/index.js'
import { parsePointCenter } from '../interpolation/utilsWorker.js'
import { DEFAULT_COLOR_RAMP } from '../render/heatmapPalette.js'
import { clamp01 } from '../shared/stressActionShared.js'

function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback
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
    if (!p || typeof p !== 'object') {
      return { ok: false, message: `渲染.热力图.点位 第 ${i + 1} 项格式错误` }
    }

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
  return { ok: true, data: out.slice(0, 1000) }
}

function normalizeHeatmapMask(mask) {
  if (mask === null || mask === undefined) return { ok: true, data: null }
  if (!mask || typeof mask !== 'object') {
    return { ok: false, message: '渲染.热力图.遮罩 格式错误：需要对象' }
  }
  const mode = String(mask['模式'] ?? mask['mode'] ?? '无')
  const power = Number(mask['幂'] ?? mask['power'] ?? 2)
  const cutoff = Number(mask['截断'] ?? mask['cutoff'] ?? 0.02)
  if (!Number.isFinite(power) || power <= 0) {
    return { ok: false, message: '渲染.热力图.遮罩.幂 必须为正数' }
  }
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff >= 1) {
    return { ok: false, message: '渲染.热力图.遮罩.截断 需满足 0<=截断<1' }
  }
  const normalizedMode = mode === '点位' || mode === 'points' ? 'points' : 'none'
  return { ok: true, data: { mode: normalizedMode, power, cutoff } }
}

function normalizeHeatmapDerived(derived) {
  if (derived === null || derived === undefined) return { ok: true, data: null }
  if (!derived || typeof derived !== 'object') {
    return { ok: false, message: '渲染.热力图.衍生 格式错误：需要对象' }
  }
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
  if (!Number.isFinite(contourLevels) || contourLevels < 2) {
    return { ok: false, message: '渲染.热力图.衍生.等值线.级数 必须为 >=2 的数字' }
  }
  if (!Number.isFinite(contourWidth) || contourWidth <= 0 || contourWidth >= 0.5) {
    return { ok: false, message: '渲染.热力图.衍生.等值线.宽度 需满足 0<宽度<0.5' }
  }
  if (!Number.isFinite(glowThreshold) || glowThreshold < 0 || glowThreshold > 1) {
    return { ok: false, message: '渲染.热力图.衍生.高应力发光.阈值 需满足 0<=阈值<=1' }
  }
  if (!Number.isFinite(glowStrength) || glowStrength < 0 || glowStrength > 1) {
    return { ok: false, message: '渲染.热力图.衍生.高应力发光.强度 需满足 0<=强度<=1' }
  }
  if (!Number.isFinite(markerRadius) || markerRadius <= 0) {
    return { ok: false, message: '渲染.热力图.衍生.点标记.半径_m 必须为正数' }
  }
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

function normalizeBlendMode(value) {
  const raw = String(value ?? 'max').trim()
  if (!raw) return 'max'
  if (raw === 'max' || raw === '最大值') return 'max'
  if (raw === 'add' || raw === '叠加') return 'add'
  if (raw === 'overlay' || raw === '覆写') return 'overlay'
  return null
}

function normalizeHeatmapDisplayConfig({
  heatmap,
  mask,
  derived,
  diffuseMix,
  emissiveMix,
  blendModeRaw
}) {
  const contrastRaw = heatmap?.['色值对比度'] ?? heatmap?.contrast
  const gammaRaw = heatmap?.['色值伽马'] ?? heatmap?.gamma
  const cutoffRaw =
    heatmap?.['截止阈值'] ?? heatmap?.['颜色阈值'] ?? heatmap?.cutoff ?? mask?.cutoff
  const forceVisibleRaw = heatmap?.['可见增强'] ?? heatmap?.forceVisible
  const anchorToModelRaw = heatmap?.['锚定模型'] ?? heatmap?.anchorToModel
  const blendMode = normalizeBlendMode(heatmap?.['混合模式'] ?? heatmap?.blendMode ?? blendModeRaw)
  if (!blendMode) {
    return {
      ok: false,
      message: '渲染.热力图.混合模式 仅允许 max/add/overlay（或 最大值/叠加/覆写）'
    }
  }
  return {
    ok: true,
    data: {
      contrast: Number.isFinite(Number(contrastRaw)) ? Number(contrastRaw) : 1.9,
      gamma: Number.isFinite(Number(gammaRaw)) ? Number(gammaRaw) : 0.72,
      cutoff: Number.isFinite(Number(cutoffRaw)) ? Number(cutoffRaw) : 0,
      forceVisible: Number.isFinite(Number(forceVisibleRaw)) ? Number(forceVisibleRaw) : 0.82,
      diffuseMix,
      emissiveMix,
      anchorToModel: anchorToModelRaw !== undefined ? Boolean(anchorToModelRaw) : true,
      blendMode,
      maskMode: mask?.mode === 'points' ? 'points' : 'none',
      enableContour: Boolean(derived?.contour?.enabled),
      enableGlow: Boolean(derived?.glow?.enabled),
      enableMarker: Boolean(derived?.marker?.enabled)
    }
  }
}

export function normalizeRenderConfig(render) {
  if (render === undefined || render === null) return { ok: true, data: null }
  if (!render || typeof render !== 'object') {
    return { ok: false, message: '渲染配置格式错误：需要对象' }
  }
  const heatmap = render['热力图']
  const valueRange = render['值域']
  const defaults = {
    colorRamp: DEFAULT_COLOR_RAMP.map(item => ({ ...item })),
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
  let blendMode = 'max'

  if (heatmap && typeof heatmap === 'object') {
    const ramp = Array.isArray(heatmap['配色带']) ? heatmap['配色带'] : null
    if (ramp) {
      if (ramp.length < 4) return { ok: false, message: '渲染.热力图.配色带 至少需要 4 项' }
      const out = []
      for (let idx = 0; idx < ramp.length; idx++) {
        const r = ramp[idx]
        const vRaw = r?.['位置'] ?? r?.value ?? r?.value01
        const value = Number(vRaw)
        const color = String(r?.['颜色'] ?? r?.color ?? '')
        const label = r?.['标签'] !== undefined ? String(r['标签']) : undefined
        if (!Number.isFinite(value)) {
          return { ok: false, message: `渲染.热力图.配色带 第 ${idx + 1} 项位置不是数字` }
        }
        if (!color) return { ok: false, message: `渲染.热力图.配色带 第 ${idx + 1} 项颜色为空` }
        out.push({ value: Math.max(0, Math.min(1, value)), color, label })
      }
      colorRamp = out
    }

    const lut = heatmap['LUT'] ?? heatmap.lut ?? null
    if (lut !== null && lut !== undefined) {
      if (!lut || typeof lut !== 'object') {
        return { ok: false, message: '渲染.热力图.LUT 格式错误：需要对象' }
      }
      const preset = String(lut['色标'] ?? lut.preset ?? '')
      const size = Number(lut['级数'] ?? lut.size ?? 0)
      const table = Array.isArray(lut['表'])
        ? lut['表']
        : Array.isArray(lut.table)
          ? lut.table
          : null
      if (!(Number.isInteger(size) && size >= 2)) {
        return { ok: false, message: '渲染.热力图.LUT.级数 必须为 >=2 的整数' }
      }
      if (table) {
        if (table.length !== size) {
          return { ok: false, message: '渲染.热力图.LUT 表长度必须与 级数 一致' }
        }
        colorLUT = { preset, size, table }
      } else {
        if (!preset) return { ok: false, message: '渲染.热力图.LUT 需要提供 色标 或 表' }
        colorLUT = { preset, size, table: null }
      }
    }

    const pointsRaw = Array.isArray(heatmap['点位'])
      ? heatmap['点位']
      : Array.isArray(heatmap.points)
        ? heatmap.points
        : null
    if (pointsRaw) {
      const parsed = normalizeHeatmapPoints(pointsRaw)
      if (!parsed.ok) return parsed
      heatmapPoints = parsed.data
    }
    const maskRaw = heatmap['遮罩'] ?? heatmap.mask ?? null
    if (maskRaw !== null && maskRaw !== undefined) {
      const parsed = normalizeHeatmapMask(maskRaw)
      if (!parsed.ok) return parsed
      heatmapMask = parsed.data
    }
    const derivedRaw = heatmap['衍生'] ?? heatmap.derived ?? null
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

  const displayNormalized = normalizeHeatmapDisplayConfig({
    heatmap,
    mask: heatmapMask,
    derived: heatmapDerived,
    diffuseMix,
    emissiveMix,
    blendModeRaw: render['混合模式'] ?? render.blendMode
  })
  if (!displayNormalized.ok) return displayNormalized
  blendMode = displayNormalized.data.blendMode

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
      heatmapDisplay: displayNormalized.data,
      blendMode,
      diffuseMix,
      emissiveMix,
      valueRange: valueRangeNormalized.data,
      defaultMetric
    }
  }
}

export function buildFramesFromData(data, { framesCount, total, requiredKeys }) {
  const generator = data?.['生成']
  const framesRaw = Array.isArray(data?.['帧']) ? data['帧'] : null

  if (generator) {
    const generated = generateFrames(generator, framesCount, total, requiredKeys)
    if (!generated.ok) return generated
    return { ok: true, frames: generated.frames }
  }

  if (!framesRaw || framesRaw.length < 1) {
    return { ok: false, message: '数据.帧 不能为空（或提供 数据.生成）' }
  }
  if (framesCount && framesRaw.length !== framesCount) {
    return { ok: false, message: '数据帧数量与时间信息不一致' }
  }

  const frames = []
  for (let i = 0; i < framesRaw.length; i++) {
    const f = framesRaw[i]
    if (!f || typeof f !== 'object') {
      return { ok: false, message: `第 ${i + 1} 帧数据格式错误` }
    }
    const out = { t: f.t ?? i }
    for (const k of requiredKeys) {
      const decoded = decodeComponentArray(f[k], total)
      if (!decoded.ok) return { ok: false, message: `第 ${i + 1} 帧分量 ${k}：${decoded.message}` }
      out[k] = decoded.values
    }
    frames.push(out)
  }

  return { ok: true, frames }
}

export function decodeComponentArray(spec, total) {
  if (Array.isArray(spec)) {
    if (spec.length !== total) return { ok: false, message: `长度必须为 ${total}` }
    for (const v of spec) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, message: '存在非数字' }
    }
    return { ok: true, values: spec }
  }

  if (spec && typeof spec === 'object') {
    const encoding = String(spec['编码'] || '')
    if (encoding === 'RLE') {
      const pairs = Array.isArray(spec['值']) ? spec['值'] : null
      if (!pairs) return { ok: false, message: 'RLE 编码需要 值=[[数值,次数],...]' }
      const out = new Array(total)
      let idx = 0
      for (const p of pairs) {
        const v = Number(p?.[0])
        const c = Number(p?.[1])
        if (!Number.isFinite(v) || !Number.isFinite(c) || c <= 0) {
          return { ok: false, message: 'RLE 值非法' }
        }
        const count = Math.floor(c)
        for (let i = 0; i < count && idx < total; i++) out[idx++] = v
        if (idx >= total) break
      }
      if (idx !== total) return { ok: false, message: `RLE 展开长度不等于 ${total}` }
      return { ok: true, values: out }
    }
  }

  return { ok: false, message: '需要数组或 { 编码: RLE, 值: [[v,count],...] }' }
}

export function generateFrames(generator, framesCount, total, requiredKeys) {
  if (!generator || typeof generator !== 'object') {
    return { ok: false, message: '数据.生成 格式错误：需要对象' }
  }
  const type = String(generator['类型'] || '')
  if (type !== '三维高斯' && type !== '复合载荷场') {
    return { ok: false, message: '数据.生成.类型 目前仅支持“三维高斯/复合载荷场”' }
  }
  if (!Number.isInteger(framesCount) || framesCount < 1) {
    return { ok: false, message: '时间信息错误：生成模式需要 时间.时间点 或 时间.帧数' }
  }

  const dims = generator['网格']
  const w = Number(dims?.['宽'])
  const h = Number(dims?.['高'])
  const d = Number(dims?.['深'])
  if (![w, h, d].every(n => Number.isInteger(n) && n > 1)) {
    return { ok: false, message: '数据.生成.网格 需要 {宽,高,深} 且均>1' }
  }
  if (w * h * d !== total) {
    return { ok: false, message: '数据.生成.网格 必须与顶层 网格 一致' }
  }

  if (type === '复合载荷场') {
    return generateFramesCompositeLoad(generator, framesCount, { w, h, d, total, requiredKeys })
  }

  const center = Array.isArray(generator['中心']) ? generator['中心'].map(Number) : [0.5, 0.5, 0.5]
  const sigma = Array.isArray(generator['尺度'])
    ? generator['尺度'].map(Number)
    : [0.18, 0.18, 0.18]
  const base = generator['基准'] && typeof generator['基准'] === 'object' ? generator['基准'] : {}
  const peak = generator['峰值'] && typeof generator['峰值'] === 'object' ? generator['峰值'] : {}
  const time =
    generator['时间函数'] && typeof generator['时间函数'] === 'object' ? generator['时间函数'] : {}

  const period = Math.max(1, Number(time['周期'] || framesCount))
  const bias = Number(time['偏置'] ?? 0.6)
  const amp = Number(time['幅值'] ?? 0.4)

  const safeSigma = sigma.map(v => Math.max(1e-6, Number.isFinite(v) ? v : 0.18))
  const safeCenter = [
    clamp01(Number.isFinite(center[0]) ? center[0] : 0.5),
    clamp01(Number.isFinite(center[1]) ? center[1] : 0.5),
    clamp01(Number.isFinite(center[2]) ? center[2] : 0.5)
  ]

  const frames = []
  for (let t = 0; t < framesCount; t++) {
    const f = { t }
    const tf = clamp01(bias + amp * Math.sin((2 * Math.PI * t) / period))

    for (const k of requiredKeys) {
      const b = Number(base[k] ?? 0)
      const p = Number(peak[k] ?? (k === 'xx' || k === 'yy' || k === 'zz' ? 1 : 0.3))
      const out = new Array(total)
      let idx = 0
      for (let zz = 0; zz < d; zz++) {
        const nz = zz / (d - 1)
        for (let yy = 0; yy < h; yy++) {
          const ny = yy / (h - 1)
          for (let xx = 0; xx < w; xx++) {
            const nx = xx / (w - 1)
            const gx = (nx - safeCenter[0]) / safeSigma[0]
            const gy = (ny - safeCenter[1]) / safeSigma[1]
            const gz = (nz - safeCenter[2]) / safeSigma[2]
            const g = Math.exp(-(gx * gx + gy * gy + gz * gz))
            const s = b + p * g * tf
            const sign = (xx + yy + zz) % 2 === 0 ? 1 : -1
            out[idx++] = k === 'xy' || k === 'yz' || k === 'zx' ? s * sign : s
          }
        }
      }
      f[k] = out
    }
    frames.push(f)
  }
  return { ok: true, frames }
}

export function generateFramesCompositeLoad(
  generator,
  framesCount,
  { w, h, d, total, requiredKeys }
) {
  const time =
    generator['时间函数'] && typeof generator['时间函数'] === 'object' ? generator['时间函数'] : {}
  const period = Math.max(2, Number(time['周期'] || framesCount))

  const loads = generator['载荷'] && typeof generator['载荷'] === 'object' ? generator['载荷'] : {}
  const axial = loads['轴向'] && typeof loads['轴向'] === 'object' ? loads['轴向'] : {}
  const bendY = loads['弯曲Y'] && typeof loads['弯曲Y'] === 'object' ? loads['弯曲Y'] : {}
  const bendZ = loads['弯曲Z'] && typeof loads['弯曲Z'] === 'object' ? loads['弯曲Z'] : {}
  const torsion = loads['扭转'] && typeof loads['扭转'] === 'object' ? loads['扭转'] : {}
  const hotspots = Array.isArray(loads['热点']) ? loads['热点'] : []

  const aAx = Number.isFinite(axial['幅值']) ? Number(axial['幅值']) : 8e-5
  const aBy = Number.isFinite(bendY['幅值']) ? Number(bendY['幅值']) : 6e-5
  const aBz = Number.isFinite(bendZ['幅值']) ? Number(bendZ['幅值']) : 4e-5
  const aTor = Number.isFinite(torsion['幅值']) ? Number(torsion['幅值']) : 5e-5

  const phaseAx = (Number(axial['相位'] || 0) * Math.PI) / 180
  const phaseBy = (Number(bendY['相位'] || 90) * Math.PI) / 180
  const phaseBz = (Number(bendZ['相位'] || 180) * Math.PI) / 180
  const phaseTor = (Number(torsion['相位'] || 45) * Math.PI) / 180

  const biasAx = Number.isFinite(axial['偏置']) ? Number(axial['偏置']) : 0
  const biasBy = Number.isFinite(bendY['偏置']) ? Number(bendY['偏置']) : 0
  const biasBz = Number.isFinite(bendZ['偏置']) ? Number(bendZ['偏置']) : 0
  const biasTor = Number.isFinite(torsion['偏置']) ? Number(torsion['偏置']) : 0

  const clamp = v => (Number.isFinite(v) ? v : 0)
  const safeHotspots = hotspots
    .map(hs => {
      const c = Array.isArray(hs?.['中心']) ? hs['中心'].map(Number) : null
      const s = Array.isArray(hs?.['尺度']) ? hs['尺度'].map(Number) : null
      const wgt = hs?.['权重'] && typeof hs['权重'] === 'object' ? hs['权重'] : {}
      if (!c || c.length < 3 || !s || s.length < 3) return null
      const center = [clamp01(Number(c[0])), clamp01(Number(c[1])), clamp01(Number(c[2]))]
      const sigma = [
        Math.max(1e-6, clamp(s[0])),
        Math.max(1e-6, clamp(s[1])),
        Math.max(1e-6, clamp(s[2]))
      ]
      return {
        center,
        sigma,
        weights: {
          xx: clamp(wgt['xx']),
          yy: clamp(wgt['yy']),
          zz: clamp(wgt['zz']),
          xy: clamp(wgt['xy']),
          yz: clamp(wgt['yz']),
          zx: clamp(wgt['zx'])
        }
      }
    })
    .filter(Boolean)

  const frames = []
  for (let t = 0; t < framesCount; t++) {
    const tt = (2 * Math.PI * t) / period
    const fAx = biasAx + aAx * Math.sin(tt + phaseAx)
    const fBy = biasBy + aBy * Math.sin(tt + phaseBy)
    const fBz = biasBz + aBz * Math.sin(tt + phaseBz)
    const fTor = biasTor + aTor * Math.sin(tt + phaseTor)

    const out = { t }
    for (const k of requiredKeys) out[k] = new Array(total)

    let idx = 0
    for (let zz = 0; zz < d; zz++) {
      const nz01 = zz / (d - 1)
      const nz = nz01 * 2 - 1
      for (let yy = 0; yy < h; yy++) {
        const ny01 = yy / (h - 1)
        const ny = ny01 * 2 - 1
        for (let xx = 0; xx < w; xx++) {
          const nx01 = xx / (w - 1)
          const nx = nx01 * 2 - 1

          let exx = fAx * (1 + 0.15 * nz) + fBy * ny + fBz * nz
          let eyy = -0.35 * exx + 0.25 * fBy * -ny + 0.08 * fBz * nx
          let ezz = -0.25 * exx + 0.1 * fBy * nx + 0.2 * fBz * -nz
          let exy = fTor * -nz * (0.8 + 0.2 * Math.cos(Math.PI * nx))
          let eyz = fTor * nx * (0.8 + 0.2 * Math.cos(Math.PI * ny))
          let ezx = fTor * ny * (0.8 + 0.2 * Math.cos(Math.PI * nz))

          for (const hs of safeHotspots) {
            const gx = (nx01 - hs.center[0]) / hs.sigma[0]
            const gy = (ny01 - hs.center[1]) / hs.sigma[1]
            const gz = (nz01 - hs.center[2]) / hs.sigma[2]
            const g = Math.exp(-(gx * gx + gy * gy + gz * gz))
            exx += hs.weights.xx * g
            eyy += hs.weights.yy * g
            ezz += hs.weights.zz * g
            exy += hs.weights.xy * g
            eyz += hs.weights.yz * g
            ezx += hs.weights.zx * g
          }

          out.xx[idx] = exx
          out.yy[idx] = eyy
          out.zz[idx] = ezz
          out.xy[idx] = exy
          out.yz[idx] = eyz
          out.zx[idx] = ezx
          idx++
        }
      }
    }

    frames.push(out)
  }
  return { ok: true, frames }
}

export function buildTimeAxis(time) {
  const frames = Number(time?.frames ?? time?.['帧数'] ?? 0)
  const timePoints = Array.isArray(time?.timePoints)
    ? time.timePoints.map(Number)
    : Array.isArray(time?.['时间点'])
      ? time['时间点'].map(Number)
      : null
  const n = Number.isInteger(frames) && frames > 0 ? frames : timePoints?.length || 0
  return {
    frames: n,
    timePoints:
      timePoints && timePoints.length === n ? timePoints : Array.from({ length: n }, (_, i) => i)
  }
}

export function computePointTensor6FromEngineering(input) {
  const json = input && typeof input === 'object' ? input : {}
  const timeAxis = buildTimeAxis(json['时间'] || json.time)
  const frames = timeAxis.frames
  const points = Array.isArray(json['点'])
    ? json['点']
    : Array.isArray(json.points)
      ? json.points
      : []
  const geometry = json['几何'] || json.geometry || null
  const loads = Array.isArray(json['载荷工况'])
    ? json['载荷工况']
    : Array.isArray(json.loads)
      ? json.loads
      : []

  if (!(frames > 0)) return { ok: false, message: '时间轴无效：无法计算' }
  if (points.length < 1) return { ok: false, message: '点数组为空：无法计算' }

  const section = geometry?.['截面'] || geometry?.section || null
  const area = Number(
    section?.['面积_m2'] ??
      section?.area_m2 ??
      geometry?.['截面积_m2'] ??
      geometry?.area_m2 ??
      geometry?.['截面积'] ??
      geometry?.area
  )
  if (!(Number.isFinite(area) && area > 0)) {
    return { ok: false, message: '几何信息缺少有效截面积：无法计算简化应力' }
  }

  const axialLoads = loads.filter(
    l => (l && typeof l === 'object' ? String(l['类型'] ?? l.type ?? '') : '') === '端面力'
  )
  const baseLoad = axialLoads[0] || null
  if (!baseLoad) return { ok: false, message: '载荷工况缺少“端面力”：无法计算简化应力' }
  const amplitudeN = Number(
    baseLoad['幅值_N'] ?? baseLoad.amplitude_N ?? baseLoad['幅值'] ?? baseLoad.amplitude
  )
  if (!(Number.isFinite(amplitudeN) && amplitudeN !== 0)) {
    return { ok: false, message: '载荷工况幅值无效：无法计算简化应力' }
  }

  const dir = Array.isArray(baseLoad['方向_ENU'] ?? baseLoad.direction_ENU)
    ? (baseLoad['方向_ENU'] ?? baseLoad.direction_ENU).map(Number)
    : [1, 0, 0]
  const dx = Number(dir[0])
  const dy = Number(dir[1])
  const dz = Number(dir[2])
  if (![dx, dy, dz].every(Number.isFinite)) {
    return { ok: false, message: '载荷工况方向无效：方向向量必须为有限数值' }
  }
  const dNorm = Math.hypot(dx, dy, dz)
  if (!(dNorm > 1e-9)) {
    return { ok: false, message: '载荷工况方向无效：方向向量长度必须大于 0' }
  }
  const ux = dx / dNorm
  const uy = dy / dNorm
  const uz = dz / dNorm

  const tf = baseLoad['时间函数'] ?? baseLoad.timeFunction ?? {}
  const type = String(tf['类型'] ?? tf.type ?? '常数')
  const factors =
    type === '线性'
      ? timeAxis.timePoints.map(t => {
          const t0 = Number(tf['起始'] ?? tf.t0 ?? timeAxis.timePoints[0] ?? 0)
          const t1 = Number(tf['结束'] ?? tf.t1 ?? timeAxis.timePoints[frames - 1] ?? frames - 1)
          const a0 = finiteOr(Number(tf['起始系数'] ?? tf.a0 ?? 0), 0)
          const a1 = finiteOr(Number(tf['结束系数'] ?? tf.a1 ?? 1), 1)
          const denom = Math.max(1e-9, t1 - t0)
          const u = Math.max(0, Math.min(1, (Number(t) - t0) / denom))
          return a0 + (a1 - a0) * u
        })
      : type === '正弦'
        ? timeAxis.timePoints.map(t => {
            const base = finiteOr(Number(tf['基值'] ?? tf.base ?? 0.5), 0.5)
            const amp = finiteOr(Number(tf['幅值'] ?? tf.amp ?? 0.5), 0.5)
            const w = finiteOr(
              Number(tf['角频率'] ?? tf.w ?? (Math.PI * 2) / Math.max(1, frames - 1)),
              (Math.PI * 2) / Math.max(1, frames - 1)
            )
            const phi = finiteOr(Number(tf['相位'] ?? tf.phi ?? 0), 0)
            const value = base + amp * Math.sin(w * Number(t) + phi)
            return Number.isFinite(value) ? value : 0
          })
        : Array.from({ length: frames }, () => 1)

  const perPoint = points.map(p => {
    const id = String(p?.id ?? p?.ID ?? '')
    const name = String(p?.['名称'] ?? p?.name ?? '')
    const xx = new Array(frames)
    const yy = new Array(frames)
    const zz = new Array(frames)
    const xy = new Array(frames)
    const yz = new Array(frames)
    const zx = new Array(frames)
    for (let i = 0; i < frames; i++) {
      const F = amplitudeN * factors[i]
      const sigma = (F / area) * 1e-6
      xx[i] = sigma * ux * ux
      yy[i] = sigma * uy * uy
      zz[i] = sigma * uz * uz
      xy[i] = sigma * ux * uy
      yz[i] = sigma * uy * uz
      zx[i] = sigma * uz * ux
    }
    return { id, name, tensor6: { xx, yy, zz, xy, yz, zx } }
  })

  return { ok: true, data: { frames, timePoints: timeAxis.timePoints, points: perPoint } }
}
