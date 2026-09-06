import { KCO_SOURCE_MODE, calculateKCOParams, EXPLOSIVE_TYPES } from './kcoModelCore.js'

export const BASELINE_KEYS = [
  'Q',
  'q',
  'B',
  'S',
  'xmax',
  'b',
  'eta',
  'fragmentCountRenderLimit',
  'rockDensity',
  'explosiveType'
]

export const PARAM_LABELS = {
  Q: '单孔装药量',
  q: '炸药单耗',
  B: '抵抗线',
  S: '孔间距',
  xmax: '最大块度',
  b: 'Swebrec 参数 b',
  eta: '能量耦合系数',
  fragmentCountRenderLimit: '碎片渲染上限',
  rockDensity: '岩体密度',
  explosiveType: '炸药类型'
}

export function normalizeComparableValue(key, value) {
  if (key === 'explosiveType') return value || 'emulsion'
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export function snapshotBaselineParams(params = {}) {
  return BASELINE_KEYS.reduce((acc, key) => {
    acc[key] = normalizeComparableValue(key, params[key])
    return acc
  }, {})
}

export function normalizeKcoInput(params = {}) {
  const normalized = {}
  for (const key of Object.keys(params || {})) {
    if (key === 'sourceMode' || key === 'explosiveType') normalized[key] = params[key]
    else normalized[key] = Number(params[key])
  }
  return normalized
}

export function buildBlastPreviewInsights({ currentParams = {}, baselineParams = null } = {}) {
  const normalizedCurrent = normalizeKcoInput(currentParams)
  const currentPreview = calculateKCOParams(normalizedCurrent)
  const kcoX50 = Number(currentPreview?.x50) || 0
  const kcoX80 = Number(currentPreview?.x80) || 0
  const brokenVolume =
    (Number(currentParams.B) || 0) * (Number(currentParams.S) || 0) * (Number(currentParams.H) || 0)
  const fragmentCountEst = estimateFragmentCount(
    kcoX50,
    brokenVolume,
    currentParams.fragmentCountRenderLimit
  )
  const renderLimit = Math.max(40, Number(currentParams.fragmentCountRenderLimit) || 3000)
  const renderLoadRatio = renderLimit > 0 ? fragmentCountEst / renderLimit : 0
  const baselinePreview = baselineParams
    ? calculateKCOParams({
        ...baselineParams,
        sourceMode: KCO_SOURCE_MODE.DESIGN
      })
    : null

  const throwProxy = computeThrowProxy(currentParams)
  const baselineThrowProxy = computeThrowProxy(baselineParams || currentParams)
  const baseX50 = Number(baselinePreview?.x50) || kcoX50
  const x50Ratio = baseX50 > 0 ? kcoX50 / baseX50 : 1
  const throwRatio = baselineThrowProxy > 0 ? throwProxy / baselineThrowProxy : 1
  const volumeBaseline = baselineParams
    ? (Number(baselineParams.B) || 0) *
      (Number(baselineParams.S) || 0) *
      (Number(currentParams.H) || 0)
    : brokenVolume
  const volumeRatio = volumeBaseline > 0 ? brokenVolume / volumeBaseline : 1

  const trendCards = [
    {
      title: '块度趋势',
      value: x50Ratio <= 0.92 ? '块度更细' : x50Ratio >= 1.08 ? '块度更粗' : '块度接近基线',
      note:
        baseX50 > 0
          ? `x50 ${kcoX50.toFixed(3)}m / 基线 ${baseX50.toFixed(3)}m`
          : `x50 ${kcoX50.toFixed(3)}m`,
      extra: formatPercentDelta(x50Ratio - 1),
      tone: toneFromRatio(x50Ratio, true)
    },
    {
      title: '抛掷趋势',
      value: throwRatio >= 1.08 ? '飞散更强' : throwRatio <= 0.92 ? '飞散更弱' : '飞散接近基线',
      note: `速度代理 ${throwProxy.toFixed(3)} m/s`,
      extra: formatPercentDelta(throwRatio - 1),
      tone: toneFromRatio(throwRatio, false)
    },
    {
      title: '预览负载',
      value:
        renderLoadRatio >= 0.95
          ? '预览负载高'
          : renderLoadRatio >= 0.7
            ? '预览负载中'
            : '预览负载低',
      note: `预计碎片 ${fragmentCountEst} / 上限 ${renderLimit}`,
      extra: `${(renderLoadRatio * 100).toFixed(0)}%`,
      tone: renderLoadRatio >= 0.95 ? 'warning' : renderLoadRatio >= 0.7 ? 'neutral' : 'ok'
    },
    {
      title: '孔网尺度',
      value: volumeRatio >= 1.08 ? '孔网更疏' : volumeRatio <= 0.92 ? '孔网更密' : '孔网接近基线',
      note: `单孔体积 ${brokenVolume.toFixed(2)}m³ / 基线 ${volumeBaseline.toFixed(2)}m³`,
      extra: formatPercentDelta(volumeRatio - 1),
      tone: toneFromRatio(volumeRatio, false)
    }
  ]

  const parameterDiffs = baselineParams ? buildParameterDiffs(currentParams, baselineParams) : []

  return {
    currentPreview,
    baselinePreview,
    kcoX50,
    kcoX80,
    brokenVolume,
    fragmentCountEst,
    renderLoadRatio,
    trendCards,
    parameterDiffs
  }
}

function estimateFragmentCount(x50, brokenVolume, renderLimit) {
  if (x50 <= 0 || brokenVolume <= 0) return 0
  const avgFragVol = (Math.PI / 6) * Math.pow(x50, 3)
  if (avgFragVol <= 0) return 0
  const count = (brokenVolume * 0.8) / avgFragVol
  const limit = Math.max(40, Math.min(20000, Number(renderLimit) || 3000))
  return Math.max(40, Math.min(limit, Math.round(count)))
}

function buildParameterDiffs(currentParams, baselineParams) {
  const effectMap = {
    Q: delta => (delta > 0 ? '装药增大，通常会提升飞散活跃度' : '装药减小，通常会压低飞散活跃度'),
    q: delta => (delta > 0 ? '炸药单耗更高，趋势上更激进' : '炸药单耗更低，趋势上更保守'),
    B: delta => (delta > 0 ? '抵抗线增大，块度可能偏粗' : '抵抗线减小，块度通常会变细'),
    S: delta => (delta > 0 ? '孔间距增大，单孔控制范围扩大' : '孔间距减小，孔网更密'),
    xmax: delta => (delta > 0 ? '允许更大块出现' : '最大块度上限收紧'),
    b: delta => (delta > 0 ? '分布尾部更收敛' : '分布尾部更发散'),
    eta: delta => (delta > 0 ? '能量耦合增强，抛掷趋势更强' : '能量耦合减弱，抛掷趋势更弱'),
    fragmentCountRenderLimit: delta =>
      delta > 0 ? '预览可承载更多碎片' : '预览会更早触达数量上限',
    rockDensity: delta => (delta > 0 ? '岩体更重，速度趋势会被压低' : '岩体更轻，速度趋势会被抬高'),
    explosiveType: () => '已切换炸药能量等级'
  }

  return BASELINE_KEYS.map(key => {
    const baseline = baselineParams?.[key]
    const current = normalizeComparableValue(key, currentParams?.[key])
    if (!isMeaningfulChange(key, baseline, current)) return null
    const delta =
      typeof current === 'number' && typeof baseline === 'number' ? current - baseline : null
    return {
      key,
      label: PARAM_LABELS[key] || key,
      baselineText: formatParamValue(key, baseline),
      currentText: formatParamValue(key, current),
      deltaText: formatDeltaText(key, baseline, current),
      effect: effectMap[key]?.(delta) || '参数已变化',
      tone: delta == null ? 'neutral' : delta > 0 ? 'up' : 'down'
    }
  })
    .filter(Boolean)
    .sort((a, b) => diffPriority(a.key) - diffPriority(b.key))
    .slice(0, 8)
}

function computeThrowProxy(params = {}) {
  const explosive = EXPLOSIVE_TYPES[params?.explosiveType || 'emulsion'] || EXPLOSIVE_TYPES.emulsion
  const Eg = Number(params?.Eg) || Number(explosive?.Eg) || 3.9e6
  const eta = Math.max(0.05, Number(params?.eta) || 0.18)
  const q = Math.max(0.05, Number(params?.q) || 0.5)
  const density = Math.max(1800, Number(params?.rockDensity) || 2650)
  return Math.sqrt((2 * eta * q * Eg) / density)
}

function toneFromRatio(ratio, inverse = false) {
  if (!Number.isFinite(ratio)) return 'neutral'
  if (inverse) {
    if (ratio <= 0.92) return 'ok'
    if (ratio >= 1.08) return 'warning'
    return 'neutral'
  }
  if (ratio >= 1.08) return 'warning'
  if (ratio <= 0.92) return 'ok'
  return 'neutral'
}

function formatPercentDelta(delta) {
  if (!Number.isFinite(delta)) return '0%'
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`
}

function formatParamValue(key, value) {
  if (key === 'explosiveType') {
    return EXPLOSIVE_TYPES[value]?.label || String(value || '-')
  }
  const unitMap = {
    Q: 'kg',
    q: 'kg/m³',
    B: 'm',
    S: 'm',
    xmax: 'm',
    eta: '',
    fragmentCountRenderLimit: '',
    rockDensity: 'kg/m³',
    b: ''
  }
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  const formatted =
    Math.abs(num) >= 100 ? num.toFixed(0) : Math.abs(num) >= 10 ? num.toFixed(1) : num.toFixed(3)
  return `${formatted}${unitMap[key] || ''}`
}

function formatDeltaText(key, baseline, current) {
  if (key === 'explosiveType') return '类型切换'
  const base = Number(baseline)
  const cur = Number(current)
  if (!Number.isFinite(base) || !Number.isFinite(cur)) return '已变化'
  if (Math.abs(base) < 1e-6) return `${cur >= 0 ? '+' : ''}${cur.toFixed(2)}`
  return formatPercentDelta(cur / base - 1)
}

function isMeaningfulChange(key, baseline, current) {
  if (key === 'explosiveType') return baseline !== current
  const base = Number(baseline)
  const cur = Number(current)
  if (!Number.isFinite(base) || !Number.isFinite(cur)) return false
  const thresholdMap = {
    Q: 0.05,
    q: 0.05,
    B: 0.03,
    S: 0.03,
    xmax: 0.03,
    b: 0.03,
    eta: 0.03,
    fragmentCountRenderLimit: 0.03,
    rockDensity: 0.01
  }
  const threshold = thresholdMap[key] || 0.03
  if (Math.abs(base) < 1e-6) return Math.abs(cur - base) > threshold
  return Math.abs(cur / base - 1) >= threshold
}

function diffPriority(key) {
  const order = [
    'Q',
    'q',
    'B',
    'S',
    'eta',
    'explosiveType',
    'rockDensity',
    'xmax',
    'b',
    'fragmentCountRenderLimit'
  ]
  const index = order.indexOf(key)
  return index >= 0 ? index : order.length
}
