// --- 预警规则引擎：基于岩石力学准则的预警体系 ---
// 依据: Hoek-Brown (2018), Mohr-Coulomb, GB/T 50218-2014, Russenes岩爆判据

import {
  computeHoekBrownParams,
  hoekBrownUtilization,
  mohrCoulombAssessment,
  assessRockburstRisk
} from './index.js'

export const WARNING_LEVELS = Object.freeze({
  red: { key: 'red', label: '红色预警', severity: 3, color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  orange: {
    key: 'orange',
    label: '橙色预警',
    severity: 2,
    color: '#f97316',
    bg: 'rgba(249,115,22,0.12)'
  },
  yellow: {
    key: 'yellow',
    label: '黄色预警',
    severity: 1,
    color: '#eab308',
    bg: 'rgba(234,179,8,0.12)'
  }
})

const LEVEL_ORDER = ['red', 'orange', 'yellow']

function roundTo(v, d = 2) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const b = 10 ** d
  return Math.round(n * b) / b
}

// ============================================================================
// 规则定义：涵盖应力准则(HB/MC)、岩体分级、岩爆三大类
// ============================================================================

export const DEFAULT_WARNING_RULES = Object.freeze([
  // ——— 综合安全评分 ———
  {
    id: 'safety_score_critical',
    metric: 'safety_score',
    condition: (value, ctx) => value >= (ctx.thresholds?.safetyScoreCritical ?? 8.5),
    level: 'red',
    title: '综合安全评分 — 极高风险',
    description: (result, _ctx) =>
      `综合安全评分 ${result.value.toFixed(2)}/10，已达极高风险等级，需立即检查`
  },
  {
    id: 'safety_score_high',
    metric: 'safety_score',
    condition: (value, ctx) =>
      value >= (ctx.thresholds?.safetyScoreHigh ?? 7.0) &&
      value < (ctx.thresholds?.safetyScoreCritical ?? 8.5),
    level: 'orange',
    title: '综合安全评分 — 高风险',
    description: (result, _ctx) =>
      `综合安全评分 ${result.value.toFixed(2)}/10，进入高风险区间，建议加密监测`
  },
  {
    id: 'safety_score_warning',
    metric: 'safety_score',
    condition: (value, ctx) =>
      value >= (ctx.thresholds?.safetyScoreWarning ?? 5.0) &&
      value < (ctx.thresholds?.safetyScoreHigh ?? 7.0),
    level: 'yellow',
    title: '综合安全评分 — 中风险',
    description: (result, _ctx) =>
      `综合安全评分 ${result.value.toFixed(2)}/10，中风险区间，保持常规监测`
  },

  // ——— Hoek-Brown 破坏准则 (2018) ———
  {
    id: 'hoek_brown_critical',
    metric: 'hb_utilization',
    condition: value => value >= 0.95,
    level: 'red',
    title: 'Hoek-Brown 接近峰值强度',
    description: (result, _ctx) =>
      `Hoek-Brown σ₁/σ₁_peak = ${(result.value * 100).toFixed(1)}% ≥ 95%，裂隙网络贯通，接近极限承载`
  },
  {
    id: 'hoek_brown_yield',
    metric: 'hb_utilization',
    condition: value => value >= 0.75 && value < 0.95,
    level: 'orange',
    title: 'Hoek-Brown 进入屈服阶段',
    description: (result, _ctx) =>
      `Hoek-Brown σ₁/σ₁_peak = ${(result.value * 100).toFixed(1)}%，塑性变形显著发展`
  },

  // ——— Mohr-Coulomb 剪切/拉伸破坏 ———
  {
    id: 'mc_shear_failure',
    metric: 'mc_shear_util',
    condition: value => value >= 0.9,
    level: 'red',
    title: 'Mohr-Coulomb 剪切破坏临近',
    description: (result, _ctx) =>
      `剪切利用率 ${(result.value * 100).toFixed(1)}%，τ_max → c + σₙ·tanφ，可能发生剪切滑移破坏`
  },
  {
    id: 'mc_tension_failure',
    metric: 'mc_tension_util',
    condition: value => value >= 0.85,
    level: 'red',
    title: 'Mohr-Coulomb 拉伸破坏临近',
    description: (result, _ctx) =>
      `拉应力利用率 ${(result.value * 100).toFixed(1)}%，接近抗拉截断值，可能发生张拉裂隙/剥离`
  },

  // ——— von Mises 等效应力 ———
  {
    id: 'von_mises_critical',
    metric: 'von_mises_util',
    condition: value => value >= 0.9,
    level: 'red',
    title: '等效应力达到破坏阶段',
    description: (result, ctx) =>
      `von Mises / 参考强度 = ${(result.value * 100).toFixed(1)}% (参考值 ${roundTo(ctx.referenceStrength || 1, 1)} MPa)`
  },
  {
    id: 'von_mises_elevated',
    metric: 'von_mises_util',
    condition: value => value >= 0.6 && value < 0.9,
    level: 'orange',
    title: '等效应力偏高',
    description: (result, _ctx) =>
      `von Mises / 参考强度 = ${(result.value * 100).toFixed(1)}%，进入损伤-屈服阶段`
  },

  // ——— 岩爆倾向性 (Russenes 1974) ———
  {
    id: 'rockburst_strong',
    metric: 'rockburst_ratio',
    condition: value => value >= 0.55,
    level: 'red',
    title: '强岩爆风险 (σ_θ/σ_c ≥ 0.55)',
    description: (result, _ctx) =>
      `σ_θ/σ_c = ${result.value.toFixed(3)}，岩体可能弹射抛射，伴随巨响和冲击波`
  },
  {
    id: 'rockburst_moderate',
    metric: 'rockburst_ratio',
    condition: value => value >= 0.3 && value < 0.55,
    level: 'orange',
    title: '中等岩爆风险 (0.3 ≤ σ_θ/σ_c < 0.55)',
    description: (result, _ctx) =>
      `σ_θ/σ_c = ${result.value.toFixed(3)}，可能出现片帮、弹射，伴随清脆爆裂声`
  },
  {
    id: 'rockburst_weak',
    metric: 'rockburst_ratio',
    condition: value => value >= 0.2 && value < 0.3,
    level: 'yellow',
    title: '弱岩爆风险 (σ_θ/σ_c < 0.3)',
    description: (result, _ctx) => `σ_θ/σ_c = ${result.value.toFixed(3)}，可能有轻微剥落或小片帮`
  }
])

// ============================================================================
// 趋势检测
// ============================================================================

export function detectStressTrend(timeSeriesData, metricKey, ctx = {}) {
  if (!Array.isArray(timeSeriesData) || timeSeriesData.length < 3) return []

  const warnings = []
  const windowSize = Math.min(timeSeriesData.length, ctx.trendWindowSize || 5)
  const recent = timeSeriesData.slice(-windowSize)

  const values = recent.map(d => Number(d?.[metricKey]) || 0)
  const timestamps = recent.map(d => Number(d?.time) || 0)

  let totalChange = 0
  let validSteps = 0
  for (let i = 1; i < values.length; i++) {
    if (timestamps[i] > timestamps[i - 1]) {
      totalChange += values[i] - values[i - 1]
      validSteps++
    }
  }

  if (validSteps < 2) return warnings

  const avgChangeRate = totalChange / validSteps
  const absRate = Math.abs(avgChangeRate)
  const rateThreshold = ctx.trendRateThreshold || 0.15

  if (absRate > rateThreshold) {
    const direction = avgChangeRate > 0 ? '上升' : '下降'
    const level = absRate > rateThreshold * 1.8 ? 'orange' : 'yellow'
    warnings.push({
      id: `trend_${metricKey}_${Date.now()}`,
      ruleId: 'stress_trend_change',
      metric: metricKey,
      value: values[values.length - 1],
      level,
      title: `应力快速${direction}`,
      description: `${metricKey} 近${windowSize}帧平均每帧${direction} ${absRate.toFixed(3)}${ctx.unit || ''}，趋势${level === 'orange' ? '显著' : '明显'}`,
      trend: { direction, rate: avgChangeRate, absRate, windowSize },
      timestamp: Date.now()
    })
  }

  return warnings
}

// ============================================================================
// 空间聚类检测
// ============================================================================

export function detectSpatialClusters(warnings, ctx = {}) {
  if (!Array.isArray(warnings) || warnings.length < 3) return []

  const highSeverity = warnings.filter(w => w.level === 'red' || w.level === 'orange')
  if (highSeverity.length < (ctx.clusterMinCount || 3)) return []

  const clusterWarnings = []
  const groups = groupWarningsByRegion(highSeverity, ctx.regionGrid || 3)

  for (const [region, members] of Object.entries(groups)) {
    if (members.length >= (ctx.clusterMinCount || 3)) {
      const maxLevel = members.some(m => m.level === 'red') ? 'red' : 'orange'
      clusterWarnings.push({
        id: `cluster_${region}_${Date.now()}`,
        ruleId: 'spatial_cluster',
        metric: 'multi',
        value: members.length,
        level: maxLevel,
        title: '区域风险集中',
        description: `${region}区域 ${members.length} 个高等级预警集中，存在系统风险可能`,
        memberIds: members.map(m => m.id),
        region,
        timestamp: Date.now()
      })
    }
  }

  return clusterWarnings
}

function groupWarningsByRegion(warnings, gridSize) {
  const groups = {}
  for (const w of warnings) {
    if (!w.position) continue
    const gx = Math.floor((w.position.x ?? 0.5) * gridSize)
    const gy = Math.floor((w.position.y ?? 0.5) * gridSize)
    const gz = Math.floor((w.position.z ?? 0.5) * Math.max(1, Math.round(gridSize / 2)))
    const key = `${gx}-${gy}-${gz}`
    if (!groups[key]) groups[key] = []
    groups[key].push(w)
  }
  return groups
}

// ============================================================================
// 主评估函数
// ============================================================================

export function evaluateWarningRules(results, ctx = {}) {
  const rules =
    Array.isArray(ctx.rules) && ctx.rules.length ? ctx.rules : [...DEFAULT_WARNING_RULES]
  const warnings = []

  if (!Array.isArray(results) || results.length === 0) return warnings

  for (const result of results) {
    for (const rule of rules) {
      if (
        rule.metric !== 'safety_score' &&
        rule.metric !== result.metric &&
        rule.metric !== 'multi'
      )
        continue
      if (rule.metric === 'safety_score' && result.metric !== 'safety_score') continue

      const value = rule.metric === 'safety_score' ? result.safetyScore : result.value
      if (value === null || value === undefined || !Number.isFinite(value)) continue

      try {
        if (rule.condition(value, ctx)) {
          warnings.push({
            id: `${rule.id}_${result.id || Math.random().toString(36).slice(2, 8)}_${Date.now()}`,
            ruleId: rule.id,
            metric: rule.metric,
            value,
            level: rule.level,
            title: typeof rule.title === 'function' ? rule.title(result, ctx) : rule.title,
            description:
              typeof rule.description === 'function'
                ? rule.description({ ...result, value }, ctx)
                : rule.description,
            position: result.position || null,
            region: result.region || null,
            timestamp: Date.now()
          })
        }
      } catch (_e) {
        // 规则评估失败跳过
      }
    }
  }

  return warnings
}

export function deduplicateWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length < 2) return warnings || []

  const seen = new Set()
  return warnings.filter(w => {
    const key = `${w.ruleId || ''}|${w.metric || ''}|${w.position?.x?.toFixed(3) || ''}|${w.position?.y?.toFixed(3) || ''}|${w.position?.z?.toFixed(3) || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function sortWarningsBySeverity(warnings) {
  if (!Array.isArray(warnings)) return []
  return [...warnings].sort((a, b) => {
    const sa = LEVEL_ORDER.indexOf(a.level)
    const sb = LEVEL_ORDER.indexOf(b.level)
    if (sa !== sb) return sa - sb
    return (b.value ?? 0) - (a.value ?? 0)
  })
}

export function buildWarningSummary(warnings) {
  const valid = Array.isArray(warnings) ? warnings : []
  const counts = { red: 0, orange: 0, yellow: 0, total: valid.length }
  for (const w of valid) {
    if (counts[w.level] !== undefined) counts[w.level]++
  }

  const topLevel =
    counts.red > 0 ? 'red' : counts.orange > 0 ? 'orange' : counts.yellow > 0 ? 'yellow' : null

  return {
    counts,
    total: counts.total,
    topLevel,
    topLevelLabel: topLevel ? WARNING_LEVELS[topLevel].label : '无预警',
    hasWarnings: counts.total > 0
  }
}

// ============================================================================
// 上下文构建
// ============================================================================

export function buildEvaluationContext(safetyContext, config = {}) {
  return {
    referenceStrength: Number.isFinite(Number(safetyContext?.yieldStrength))
      ? Number(safetyContext?.yieldStrength)
      : Number.isFinite(Number(safetyContext?.stressReference))
        ? Number(safetyContext?.stressReference)
        : null,
    tensileStrength: Number.isFinite(Number(safetyContext?.tensileStrength))
      ? Number(safetyContext?.tensileStrength)
      : null,
    shearStrength: Number.isFinite(Number(safetyContext?.shearStrength))
      ? Number(safetyContext?.shearStrength)
      : null,
    sigmaC: Number.isFinite(safetyContext?.sigmaC) ? safetyContext?.sigmaC : 50,
    GSI: Number.isFinite(safetyContext?.GSI) ? safetyContext?.GSI : 55,
    mi: Number.isFinite(safetyContext?.mi) ? safetyContext?.mi : 12,
    disturbanceFactor: Number.isFinite(safetyContext?.disturbanceFactor)
      ? safetyContext?.disturbanceFactor
      : 0,
    cohesion: Number.isFinite(config?.cohesion) ? config.cohesion : 2,
    frictionAngle: Number.isFinite(config?.frictionAngle) ? config.frictionAngle : 35,
    thresholds: {
      safetyScoreCritical: 8.5,
      safetyScoreHigh: 7.0,
      safetyScoreWarning: 5.0,
      utilizationHigh: 0.8,
      utilizationMedium: 0.6,
      ...(config.thresholds || {})
    },
    trendWindowSize: config.trendWindowSize || 5,
    trendRateThreshold: config.trendRateThreshold || 0.15,
    clusterMinCount: config.clusterMinCount || 3,
    regionGrid: config.regionGrid || 3,
    unit: config.unit || 'MPa'
  }
}

// ============================================================================
// 张量指标计算
// ============================================================================

function evaluateTensorMetrics(tensor, ctx) {
  const xx = Number(tensor?.sxx) || 0
  const yy = Number(tensor?.syy) || 0
  const zz = Number(tensor?.szz) || 0
  const xy = Number(tensor?.sxy) || 0
  const yz = Number(tensor?.syz) || 0
  const szx = Number(tensor?.szx) || 0

  if (![xx, yy, zz].every(v => Number.isFinite(v))) return null

  const p = (xx + yy + zz) / 3
  const dxx = xx - p
  const dyy = yy - p
  const dzz = zz - p
  const j2 = 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz) + (xy * xy + yz * yz + szx * szx)
  const vonMises = Math.sqrt(Math.max(0, 3 * j2))
  const tauMax = Math.max(0, 0.5 * Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy)))

  const stressTensor = { sxx: xx, syy: yy, szz: zz, sxy: xy, syz: yz, szx }

  const ref = ctx.referenceStrength || 1
  const vonMisesUtil = vonMises / Math.max(ref, 1e-6)

  // Hoek-Brown 利用率
  const hbParams = computeHoekBrownParams(
    ctx.sigmaC || 50,
    ctx.GSI || 55,
    ctx.mi || 12,
    ctx.disturbanceFactor || 0
  )
  const principal = [xx, yy, zz].sort((a, b) => b - a)
  const hbUtil = hoekBrownUtilization(principal[0], principal[2], hbParams)

  // Mohr-Coulomb 判别
  const mcResult = mohrCoulombAssessment(stressTensor, {
    cohesion: ctx.cohesion || 2,
    frictionAngle: ctx.frictionAngle || 35,
    tensileStrength: ctx.tensileStrength || ref * 0.1
  })

  // 岩爆倾向性
  const rbResult = assessRockburstRisk(stressTensor, ctx.sigmaC || 50)

  // 安全评分
  const safetyScore = ctx.referenceStrength ? Math.min(10, Math.max(1, vonMisesUtil * 10)) : null

  return {
    von_mises: roundTo(vonMises, 2),
    von_mises_util: roundTo(vonMisesUtil, 3),
    tau_max: roundTo(tauMax, 2),
    sigma1: xx,
    safety_score: safetyScore,
    hb_utilization: roundTo(hbUtil, 3),
    mc_shear_util: roundTo(mcResult.shearUtil, 3),
    mc_tension_util: roundTo(mcResult.tensionUtil, 3),
    rockburst_ratio: roundTo(rbResult.ratio, 3)
  }
}

// ============================================================================
// 数据源评估
// ============================================================================

export function evaluateSourceData(
  sourceKind,
  sourceData,
  currentTime,
  safetyContext,
  options = {}
) {
  const ctx = buildEvaluationContext(safetyContext, options)

  if (sourceKind === 'points') {
    return evaluatePointSource(sourceData, currentTime, ctx)
  }

  if (sourceKind === 'grid') {
    return evaluateGridSource(sourceData, currentTime, ctx)
  }

  return []
}

function evaluatePointSource(data, currentTime, ctx) {
  if (!data?.points?.length) return []

  const frameIndex = Math.max(
    0,
    Math.min(data.points[0]?.stressSeries?.length || 1, Number(currentTime) || 0)
  )
  const results = []

  for (const point of data.points) {
    if (!point?.tensor6) continue

    const tensor = {
      sxx: point.tensor6.xx?.[frameIndex],
      syy: point.tensor6.yy?.[frameIndex],
      szz: point.tensor6.zz?.[frameIndex],
      sxy: point.tensor6.xy?.[frameIndex],
      syz: point.tensor6.yz?.[frameIndex],
      szx: point.tensor6.zx?.[frameIndex]
    }

    const metrics = evaluateTensorMetrics(tensor, ctx)
    if (!metrics) continue

    const localPos = point.localPos || point.center || [0.5, 0.5, 0.5]
    const regionX = localPos[0] < 0.33 ? '西' : localPos[0] < 0.67 ? '中' : '东'
    const regionY = localPos[1] < 0.33 ? '南' : localPos[1] < 0.67 ? '中' : '北'
    const regionZ = localPos[2] < 0.5 ? '浅层' : '深层'

    results.push({
      id: point.id || point.name || `pt_${results.length}`,
      metrics,
      position: { x: localPos[0], y: localPos[1], z: localPos[2] },
      region: `${regionX}${regionY}-${regionZ}`
    })
  }

  const allWarnings = []
  for (const result of results) {
    for (const [metric, value] of Object.entries(result.metrics)) {
      if (value === null || !Number.isFinite(value)) continue
      allWarnings.push(...evaluateWarningRules([{ ...result, metric, value }], ctx))
    }
  }

  return sortWarningsBySeverity(deduplicateWarnings(allWarnings))
}

function evaluateGridSource(data, currentTime, ctx) {
  if (!data?.data?.frames?.length) return []

  const frames = data.data.frames
  const frameIndex = Math.max(0, Math.min(frames.length - 1, Number(currentTime) || 0))
  const frame = frames[frameIndex]
  if (!frame) return []

  const width = Math.max(1, Number(data?.grid?.width) || 1)
  const height = Math.max(1, Number(data?.grid?.height) || 1)
  const depth = Math.max(1, Number(data?.grid?.depth) || 1)
  const total = width * height * depth
  if (total < 1) return []

  const step = Math.max(1, Math.floor(total / 800))
  const results = []

  for (let index = 0; index < total; index += step) {
    const tensor = {
      sxx: frame.xx?.[index],
      syy: frame.yy?.[index],
      szz: frame.zz?.[index],
      sxy: frame.xy?.[index] || 0,
      syz: frame.yz?.[index] || 0,
      szx: frame.zx?.[index] || 0
    }

    const metrics = evaluateTensorMetrics(tensor, ctx)
    if (!metrics) continue

    const plane = width * height
    const zi = Math.floor(index / plane)
    const remain = index - zi * plane
    const yi = Math.floor(remain / width)
    const xi = remain - yi * width
    const lx = width > 1 ? xi / (width - 1) : 0.5
    const ly = height > 1 ? yi / (height - 1) : 0.5
    const lz = depth > 1 ? zi / (depth - 1) : 0.5

    const regionX = lx < 0.33 ? '西' : lx < 0.67 ? '中' : '东'
    const regionY = ly < 0.33 ? '南' : ly < 0.67 ? '中' : '北'
    const regionZ = lz < 0.5 ? '浅层' : '深层'

    results.push({
      id: `grid_${index}`,
      metrics,
      position: { x: lx, y: ly, z: lz },
      region: `${regionX}${regionY}-${regionZ}`
    })
  }

  const allWarnings = []
  for (const result of results) {
    for (const [metric, value] of Object.entries(result.metrics)) {
      if (value === null || !Number.isFinite(value)) continue
      allWarnings.push(...evaluateWarningRules([{ ...result, metric, value }], ctx))
    }
  }

  let finalWarnings = sortWarningsBySeverity(deduplicateWarnings(allWarnings))
  const clusterWarnings = detectSpatialClusters(finalWarnings, ctx)
  if (clusterWarnings.length) {
    finalWarnings = [...clusterWarnings, ...finalWarnings]
  }

  return finalWarnings
}
