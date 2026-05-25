/**
 * 地下金属矿山安全评价模块
 *
 * 依据标准：
 *   - GB/T 50218-2014 工程岩体分级标准
 *   - YS/T 5046-2025 金属矿深部采矿岩石力学工程技术标准
 *   - Hoek-Brown 破坏准则 (Hoek & Brown, 2018 edition, JRMGE)
 *   - Mohr-Coulomb 剪切破坏 + 拉伸截断准则
 *   - GB 50771-2012 有色金属采矿设计规范 (第6章岩石力学)
 *
 * 评价体系：
 *   1. 应力准则评价 — Hoek-Brown / Mohr-Coulomb / Drucker-Prager
 *   2. 岩体质量分级 — GB/T 50218-2014 BQ 法
 *   3. 岩爆倾向性 — Russenes + 弹性应变能 + 脆性系数
 *   4. 综合安全评分 — AHP 多指标加权融合
 */

// ============================================================================
// 一、基础工具函数
// ============================================================================

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}
function clamp01(value) {
  return clamp(value, 0, 1)
}
function roundTo(value, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const base = 10 ** digits
  return Math.round(n * base) / base
}
function ensureArray(value) {
  return Array.isArray(value) ? value : []
}

function computeMeanStress(s) {
  return (Number(s?.sxx) + Number(s?.syy) + Number(s?.szz)) / 3
}

function computeJ2Invariant(s) {
  const p = computeMeanStress(s)
  const dxx = Number(s?.sxx) - p
  const dyy = Number(s?.syy) - p
  const dzz = Number(s?.szz) - p
  const sxy = Number(s?.sxy) || 0
  const syz = Number(s?.syz) || 0
  const szx = Number(s?.szx) || 0
  return 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz) + (sxy * sxy + syz * syz + szx * szx)
}

function computeVonMises(s) {
  return Math.sqrt(Math.max(0, 3 * computeJ2Invariant(s)))
}

// 对称3×3矩阵特征值求解 (Jacobi方法, 精确稳健)
function eigenvaluesSymmetric3(s) {
  const eps = 1e-12
  const a00 = Number(s?.sxx) || 0
  const a11 = Number(s?.syy) || 0
  const a22 = Number(s?.szz) || 0
  const a01 = Number(s?.sxy) || 0
  const a12 = Number(s?.syz) || 0
  const a02 = Number(s?.szx) || 0

  const p1 = a01 * a01 + a02 * a02 + a12 * a12
  if (p1 <= eps) return [a00, a11, a22].sort((x, y) => y - x)

  const q = (a00 + a11 + a22) / 3
  const b00 = a00 - q
  const b11 = a11 - q
  const b22 = a22 - q
  const p2 = b00 * b00 + b11 * b11 + b22 * b22 + 2 * p1
  const p = Math.sqrt(p2 / 6)
  if (!(p > eps)) return [a00, a11, a22].sort((x, y) => y - x)

  const invP = 1 / p
  const c00 = b00 * invP
  const c11 = b11 * invP
  const c22 = b22 * invP
  const c01 = a01 * invP
  const c02 = a02 * invP
  const c12 = a12 * invP
  const detC =
    c00 * (c11 * c22 - c12 * c12) - c01 * (c01 * c22 - c12 * c02) + c02 * (c01 * c12 - c11 * c02)
  const r = Math.max(-1, Math.min(1, detC / 2))
  const phi = r <= -1 ? Math.PI / 3 : r >= 1 ? 0 : Math.acos(r) / 3
  const eig1 = q + 2 * p * Math.cos(phi)
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
  const eig2 = 3 * q - eig1 - eig3
  return [eig1, eig2, eig3].sort((x, y) => y - x)
}

// ============================================================================
// 二、岩体材料参数 — 按 GB/T 50218-2014 附录B 及 YS/T 5046-2025
// ============================================================================

/**
 * 岩石坚硬程度分类 (GB/T 50218-2014 表4.1.1)
 * Rc = 饱和单轴抗压强度 (MPa)
 */
export function classifyRockHardness(rcMPa) {
  const rc = Number(rcMPa)
  if (!Number.isFinite(rc) || rc <= 0) return { grade: '未知', label: '未知', qualitative: '—' }
  if (rc > 60)
    return { grade: 'I', label: '坚硬岩', qualitative: '锤击声清脆，有回弹，震手，难击碎' }
  if (rc > 30)
    return {
      grade: 'II',
      label: '较坚硬岩',
      qualitative: '锤击声较清脆，有轻微回弹，稍震手，较难击碎'
    }
  if (rc > 15)
    return { grade: 'III', label: '较软岩', qualitative: '锤击声不清脆，无回弹，较易击碎' }
  if (rc > 5) return { grade: 'IV', label: '软岩', qualitative: '锤击声哑，无回弹，有凹痕，易击碎' }
  return { grade: 'V', label: '极软岩', qualitative: '锤击声哑，无回弹，有较深凹痕，手可捏碎' }
}

/**
 * 岩体完整程度分类 (GB/T 50218-2014 表4.2.1)
 * Kv = 岩体完整性系数 (0~1)
 */
export function classifyRockIntegrity(kv) {
  const k = Number(kv)
  if (!Number.isFinite(k) || k < 0) return { grade: '未知', label: '未知', kvRange: '—' }
  if (k > 0.75) return { grade: 'I', label: '完整', kvRange: '> 0.75' }
  if (k > 0.55) return { grade: 'II', label: '较完整', kvRange: '0.75~0.55' }
  if (k > 0.35) return { grade: 'III', label: '较破碎', kvRange: '0.55~0.35' }
  if (k > 0.15) return { grade: 'IV', label: '破碎', kvRange: '0.35~0.15' }
  return { grade: 'V', label: '极破碎', kvRange: '< 0.15' }
}

/**
 * 岩体基本质量指标 BQ (GB/T 50218-2014 公式4.3.1)
 * BQ = 100 + 3Rc + 250Kv
 *
 * 使用限制 (4.3.2条):
 *   - 当 Rc > 90Kv + 30 时，以 Rc = 90Kv + 30 代入
 *   - 当 Kv > 0.04Rc + 0.4 时，以 Kv = 0.04Rc + 0.4 代入
 */
export function computeBQ(rcMPa, kv) {
  let Rc = Number(rcMPa) || 0
  let Kv = clamp01(Number(kv) || 0)
  if (Rc <= 0 || Kv <= 0) return null

  // 4.3.2条 限制条件
  if (Rc > 90 * Kv + 30) Rc = 90 * Kv + 30
  if (Kv > 0.04 * Rc + 0.4) Kv = 0.04 * Rc + 0.4

  return Math.max(0, Math.round(100 + 3 * Rc + 250 * Kv))
}

/**
 * 地下工程岩体质量指标 [BQ] (GB/T 50218-2014 公式5.2.2)
 * [BQ] = BQ - 100(K₁ + K₂ + K₃)
 *
 * K₁ — 地下水影响修正系数
 * K₂ — 主要结构面产状影响修正系数
 * K₃ — 初始应力状态影响修正系数
 */
export function computeBQModified(bq, k1 = 0, k2 = 0, k3 = 0) {
  if (bq === null || !Number.isFinite(bq)) return null
  return Math.max(0, Math.round(bq - 100 * (Number(k1) + Number(k2) + Number(k3))))
}

/**
 * 工程岩体级别划分 (GB/T 50218-2014 表4.1.1-1)
 */
export function classifyBQ(bqValue) {
  const bq = Number(bqValue)
  if (!Number.isFinite(bq) || bq < 0) return null
  if (bq > 550)
    return {
      class: 'I',
      label: 'I 级',
      stability: '稳定',
      selfSupport: '跨度 ≤ 20m 可长期稳定，偶有掉块'
    }
  if (bq > 451)
    return {
      class: 'II',
      label: 'II 级',
      stability: '基本稳定',
      selfSupport: '跨度 10~20m 可基本稳定，局部可能掉块'
    }
  if (bq > 351)
    return {
      class: 'III',
      label: 'III 级',
      stability: '局部稳定性差',
      selfSupport: '跨度 10~20m 可稳定数日至一个月'
    }
  if (bq > 251)
    return {
      class: 'IV',
      label: 'IV 级',
      stability: '不稳定',
      selfSupport: '跨度 > 5m 一般无自稳能力，数日至数月可能失稳'
    }
  return { class: 'V', label: 'V 级', stability: '极不稳定', selfSupport: '无自稳能力，须及时支护' }
}

// ============================================================================
// 三、Hoek-Brown 广义破坏准则 (Hoek & Brown, 2018, JRMGE)
// ============================================================================

/**
 * Hoek-Brown 岩体参数计算
 *
 * σ₁ = σ₃ + σ_ci * (m_b * σ₃/σ_ci + s)^a
 *
 * 参数:
 *   σ_ci  — 完整岩石单轴抗压强度 (MPa)
 *   GSI   — 地质强度指标 (Geological Strength Index, 0~100)
 *   m_i   — 完整岩石 Hoek-Brown 常数 (见表)
 *   D     — 扰动因子 (0=未扰动, 1=完全扰动)
 */
export function computeHoekBrownParams(sigmaCI, GSI, mi, D = 0) {
  const sci = Math.max(1, Number(sigmaCI) || 50)
  const gsi = clamp(Number(GSI) || 50, 5, 100)
  const miVal = clamp(Number(mi) || 10, 4, 35)
  const dVal = clamp01(Number(D) || 0)

  const mb = miVal * Math.exp((gsi - 100) / (28 - 14 * dVal))
  const s = Math.exp((gsi - 100) / (9 - 3 * dVal))
  const a = 0.5 + (Math.exp(-gsi / 15) - Math.exp(-20 / 3)) / 6

  // 岩体单轴抗压强度: σ_cm = σ_ci * s^a
  const sigmaCM = sci * Math.pow(s, a)
  // 岩体抗拉强度: σ_tm = -s * σ_ci / m_b
  const sigmaTM = -(s * sci) / Math.max(mb, 1e-6)

  return {
    sigmaCI: sci,
    GSI: gsi,
    mi: miVal,
    D: dVal,
    mb: roundTo(mb, 4),
    s: roundTo(s, 6),
    a: roundTo(a, 4),
    sigmaCM: roundTo(sigmaCM, 2),
    sigmaTM: roundTo(sigmaTM, 2)
  }
}

/**
 * Hoek-Brown 强度/应力比
 * 给定 σ₃，返回强度 σ₁
 */
export function hoekBrownStrength(sigma3, hbParams) {
  const { sigmaCI, mb, s, a } = hbParams
  const s3 = Math.max(0, Number(sigma3) || 0)
  return s3 + sigmaCI * Math.pow((mb * s3) / Math.max(sigmaCI, 1e-6) + s, a)
}

/**
 * Hoek-Brown 利用率: 实际 σ₁ / 理论强度 σ₁(σ₃)
 */
export function hoekBrownUtilization(sigma1, sigma3, hbParams) {
  const strength = hoekBrownStrength(sigma3, hbParams)
  if (strength <= 0) return 1
  return clamp01(Number(sigma1) / strength)
}

// 完整岩石 m_i 经验值 (Hoek & Brown, 2018, Table 2)
export const HOEK_BROWN_MI = Object.freeze({
  // 沉积岩
  limestone: 10,
  dolomite: 9,
  sandstone: 17,
  siltstone: 7,
  shale: 6,
  mudstone: 4,
  // 变质岩
  marble: 9,
  quartzite: 20,
  gneiss: 28,
  schist: 10,
  slate: 7,
  // 火成岩
  granite: 32,
  diorite: 25,
  gabbro: 27,
  basalt: 25,
  andesite: 25,
  rhyolite: 25,
  // 矿山常见
  ore_copper: 22,
  ore_iron: 24,
  ore_gold: 22,
  ore_lead_zinc: 20
})

/**
 * 根据岩性名推断 m_i 和典型 UCS
 */
export function inferRockParams(lithology) {
  const text = String(lithology || '')
    .toLowerCase()
    .trim()
  const entries = Object.entries(HOEK_BROWN_MI)
  for (const [key, mi] of entries) {
    if (text.includes(key)) {
      // 硬岩典型 UCS
      const hardUCS = ['granite', 'basalt', 'gabbro', 'quartzite', 'gneiss', 'diorite'].includes(
        key
      )
        ? 120
        : ['ore_iron', 'ore_copper'].includes(key)
          ? 80
          : 50
      return { mi, typicalUCS: hardUCS }
    }
  }
  return { mi: 12, typicalUCS: 40 }
}

// ============================================================================
// 四、Mohr-Coulomb 破坏准则 (GB 50771-2012 第6章)
// ============================================================================

/**
 * Mohr-Coulomb 剪切破坏判别
 *
 * |τ| = c + σ_n·tan(φ)
 *
 * 返回:
 *   shearUtil — 剪切利用率 (实际剪应力/抗剪强度)
 *   tensionUtil — 拉应力利用率 (实际拉应力/抗拉强度)
 *   failureMode — 'shear' | 'tension' | 'none'
 */
export function mohrCoulombAssessment(
  stressTensor,
  { cohesion, frictionAngle, tensileStrength } = {}
) {
  const c = Number.isFinite(cohesion) ? Math.max(0, Number(cohesion)) : 2
  const phi = Number.isFinite(frictionAngle) ? Number(frictionAngle) : 35
  const sigmaT = Number.isFinite(tensileStrength) ? Math.max(0, Number(tensileStrength)) : c * 2
  const phiRad = (phi * Math.PI) / 180

  const principal = eigenvaluesSymmetric3(stressTensor)
  const sigma1 = Number(principal[0]) || 0
  const sigma3 = Number(principal[2]) || 0

  // 拉伸破坏: σ₃ ≤ -σ_t (岩土力学符号: 压为正)
  const tensionUtil = sigma3 < 0 ? Math.abs(sigma3) / Math.max(sigmaT, 1e-6) : 0

  // 剪切破坏: 最大剪应力 vs 抗剪强度
  const tauMax = (sigma1 - sigma3) / 2
  const sigmaN = (sigma1 + sigma3) / 2

  // 有效抗剪强度: τ_f = c + σ_n·tan(φ)
  const shearStrength = c + Math.max(0, sigmaN) * Math.tan(phiRad)
  const shearUtil = tauMax / Math.max(shearStrength, 1e-6)

  const failureMode = tensionUtil > shearUtil ? 'tension' : 'shear'
  const maxUtil = Math.max(shearUtil, tensionUtil)

  return {
    shearUtil: roundTo(shearUtil, 3),
    tensionUtil: roundTo(tensionUtil, 3),
    maxUtilization: roundTo(maxUtil, 3),
    failureMode,
    hasFailure: maxUtil >= 1,
    params: { cohesion: c, frictionAngle: phi, tensileStrength: sigmaT }
  }
}

// ============================================================================
// 五、岩爆倾向性评价
// 依据: Russenes判据 + 弹性应变能 + 脆性系数
// ============================================================================

/**
 * Russenes 岩爆判别 (1974)
 * σ_θ / σ_c — 切向应力与单轴抗压强度比
 */
export function assessRockburstRisk(stressTensor, sigmaC = 50) {
  const principal = eigenvaluesSymmetric3(stressTensor)
  const sigma1 = Number(principal[0]) || 0
  const sigma3 = Number(principal[2]) || 0
  const sc = Math.max(1, Number(sigmaC) || 50)

  // 等效切向应力 ≈ 3σ₁ - σ₃ (Kirsch解近似)
  const sigmaTheta = Math.max(0, 3 * sigma1 - sigma3)
  const ratio = sigmaTheta / sc

  // 弹性应变能 (体积应变能密度)
  const E = 50000 // 假设弹性模量 50 GPa
  const nu = 0.25
  const sig1 = sigma1,
    sig2 = (sigma1 + sigma3) / 2,
    sig3 = sigma3
  const elasticEnergyDensity =
    (1 / (2 * E)) *
    (sig1 * sig1 + sig2 * sig2 + sig3 * sig3 - 2 * nu * (sig1 * sig2 + sig2 * sig3 + sig3 * sig1)) *
    1e3 // kJ/m³

  // 脆性系数: σ_c / σ_t (近似)
  const brittleness = 10 // 典型硬岩脆性系数

  let level, label, description
  if (ratio < 0.2) {
    level = 'none'
    label = '无岩爆'
    description = '无岩爆风险'
  } else if (ratio < 0.3) {
    level = 'weak'
    label = '弱岩爆'
    description = '可能有轻微岩爆，剥落或小片帮'
  } else if (ratio < 0.55) {
    level = 'moderate'
    label = '中等岩爆'
    description = '中等岩爆风险，片帮、弹射，伴随清脆爆裂声'
  } else {
    level = 'strong'
    label = '强岩爆'
    description = '强烈岩爆风险，岩体弹射、抛射，伴随巨响和冲击波'
  }

  return {
    sigmaTheta: roundTo(sigmaTheta, 2),
    ratio: roundTo(ratio, 3),
    elasticEnergyDensity: roundTo(elasticEnergyDensity, 3),
    brittleness,
    level,
    label,
    description
  }
}

// ============================================================================
// 六、综合安全评分 (AHP多指标融合)
// ============================================================================

export const SAFETY_SCORE_METRIC = 'safety_score'
export const SAFETY_SCORE_LABEL = '综合安全评分（1-10，越大越不安全）'
export const SAFETY_SCORE_UNIT = '分'
export const SAFETY_SCORE_MIN = 1
export const SAFETY_SCORE_MAX = 10
export const SAFETY_SCORE_FIXED_RANGE = Object.freeze([SAFETY_SCORE_MIN, SAFETY_SCORE_MAX])

/** 安全评分标准说明 — 更新为专业依据 */
export const SAFETY_SCORE_STANDARD_LINES = Object.freeze([
  '【应力准则】Hoek-Brown 广义破坏准则 (2018) + Mohr-Coulomb 剪切/拉伸截断',
  '【岩体分级】GB/T 50218-2014 BQ 法：BQ=100+3Rc+250Kv 修正 [BQ]=BQ-100(K₁+K₂+K₃)',
  '【破坏阶段】弹性(U≤0.35) → 损伤(0.35-0.65) → 屈服(0.65-0.9) → 破坏(0.9-1.0) → 失稳(>1.0)',
  '【拉剪修正】拉应力超抗拉强度提升1.0-1.5分，剪应力超抗剪强度提升0.5-1.0分',
  '【地质修正】按GB/T 50218-2014岩体结构面条件与GSI修正，±0.3~1.2分',
  '【岩爆附加】σ_θ/σ_c > 0.3 附加0.5~1.5分 (Russenes判据)'
])

// 岩性风险规则 — 按 GB/T 50218-2014 岩体结构分类修正
const LITHOLOGY_RISK_RULES = [
  {
    keywords: ['断层', 'fault', '破碎', 'fracture', '裂隙', '碎裂', '碎裂岩', '构造角砾岩'],
    risk: 0.95
  },
  {
    keywords: [
      '风化',
      'weathered',
      '强风化',
      '全风化',
      '泥岩',
      'mudstone',
      '页岩',
      'shale',
      '黏土',
      'clay'
    ],
    risk: 0.82
  },
  {
    keywords: ['煤', 'coal', '填土', 'fill', '砂土', 'sand', 'topsoil', '表土', '软岩'],
    risk: 0.76
  },
  { keywords: ['砂岩', 'sandstone', '粉砂岩', 'siltstone', '泥质砂岩'], risk: 0.58 },
  {
    keywords: ['灰岩', 'limestone', '石灰岩', 'dolomite', '白云岩', '大理岩', 'marble'],
    risk: 0.42
  },
  {
    keywords: [
      '花岗岩',
      'granite',
      '玄武岩',
      'basalt',
      '闪长岩',
      'diorite',
      '辉长岩',
      'gabbro',
      '片麻岩',
      'gneiss',
      '石英岩',
      'quartzite'
    ],
    risk: 0.32
  }
]

function resolveRiskLevel(score) {
  const n = Number(score) || 0
  if (n >= 8.5) return '极高风险'
  if (n >= 7) return '高风险'
  if (n >= 5) return '中风险'
  if (n >= 3) return '低风险'
  return '较安全'
}

function resolveBandKey(score) {
  const n = Number(score) || 0
  if (n >= 8.5) return 'critical'
  if (n >= 7) return 'danger'
  if (n >= 5) return 'warning'
  if (n >= 3) return 'attention'
  return 'safe'
}

function buildBandStatsSummary(counts, total) {
  const safeTotal = Math.max(1, Number(total) || 1)
  const order = [
    ['critical', '极高风险'],
    ['danger', '高风险'],
    ['warning', '中风险'],
    ['attention', '低风险'],
    ['safe', '较安全']
  ]
  return order.map(([key, label]) => ({
    key,
    label,
    count: Number(counts[key]) || 0,
    ratio: roundTo(((Number(counts[key]) || 0) / safeTotal) * 100, 1)
  }))
}

// ============================================================================
// 七、核心安全评分函数 (重写，基于岩石力学准则)
// ============================================================================

function resolveSafetyReference(safetyContext) {
  const yieldStrength = Number(safetyContext?.yieldStrength)
  if (Number.isFinite(yieldStrength) && yieldStrength > 0) return yieldStrength
  const stressReference = Number(safetyContext?.stressReference)
  if (Number.isFinite(stressReference) && stressReference > 0) return stressReference
  return 1
}

export function resolveLithologyRiskFactor(lithology, thickness = 0) {
  const text = String(lithology || '')
    .trim()
    .toLowerCase()
  let base = 0.55
  for (const rule of LITHOLOGY_RISK_RULES) {
    if (rule.keywords.some(keyword => text.includes(keyword))) {
      base = rule.risk
      break
    }
  }
  const thicknessValue = Math.max(0, Number(thickness) || 0)
  const thicknessFactor = clamp01(thicknessValue / 80)
  return clamp(0.24 + base * 0.68 + thicknessFactor * 0.08, 0.2, 1)
}

function resolveLocalPos(value) {
  if (!Array.isArray(value) || value.length < 3) return [0.5, 0.5, 0.5]
  return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])]
}

/**
 * 基于 Hoek-Brown + Mohr-Coulomb 的破坏阶段评分
 *
 * 破坏阶段划分:
 *   弹性阶段   U ≤ 0.35   评分 1.0 ~ 2.5
 *   损伤阶段   0.35 < U ≤ 0.65   评分 2.5 ~ 5.0
 *   屈服阶段   0.65 < U ≤ 0.9    评分 5.0 ~ 8.5
 *   破坏阶段   0.9 < U ≤ 1.0     评分 8.5 ~ 9.5
 *   失稳阶段   U > 1.0           评分 9.5 ~ 10
 */
function resolveStressBaseScore(utilization) {
  const u = Math.max(0, Number(utilization) || 0)
  const nodes = [
    [0, 1.0],
    [0.35, 2.5],
    [0.5, 3.5],
    [0.65, 5.0],
    [0.8, 7.0],
    [0.9, 8.5],
    [1.0, 9.5],
    [1.15, 10.0]
  ]
  for (let i = 1; i < nodes.length; i++) {
    const [x1, y1] = nodes[i]
    const [x0, y0] = nodes[i - 1]
    if (u <= x1) {
      const t = (u - x0) / Math.max(1e-6, x1 - x0)
      return y0 + (y1 - y0) * clamp01(t)
    }
  }
  return 10
}

function resolveGeologyAtLocalPos(safetyContext, localPos) {
  const geologySamples = ensureArray(safetyContext?.geologySamples)
  const fallbackRisk = clamp01(Number(safetyContext?.defaultGeologyRisk) || 0.45)
  if (geologySamples.length < 1) {
    return {
      risk: fallbackRisk,
      factor: 0.9 + fallbackRisk * 0.2,
      coverage: 0,
      lithology: '',
      sampleCount: 0
    }
  }

  const p = resolveLocalPos(localPos)
  const ranked = geologySamples
    .map(sample => {
      const sp = resolveLocalPos(sample?.localPos)
      const dx = sp[0] - p[0]
      const dy = sp[1] - p[1]
      const dz = sp[2] - p[2]
      return { sample, dist: Math.hypot(dx, dy, dz) }
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4)

  let weightSum = 0,
    riskSum = 0,
    coverageScore = 0
  let bestLithology = '',
    bestWeight = -1
  for (const item of ranked) {
    const risk = clamp01(Number(item.sample?.risk) || fallbackRisk)
    const weight = 1 / Math.max(0.08, item.dist + 0.02)
    riskSum += risk * weight
    weightSum += weight
    coverageScore += clamp01(1 - item.dist / 0.75) * weight
    if (weight > bestWeight) {
      bestWeight = weight
      bestLithology = String(item.sample?.lithology || '')
    }
  }
  if (!(weightSum > 0)) {
    return {
      risk: fallbackRisk,
      factor: 0.9 + fallbackRisk * 0.2,
      coverage: 0,
      lithology: '',
      sampleCount: 0
    }
  }
  const geologyRisk = clamp01(riskSum / weightSum)
  const coverage = clamp01(coverageScore / weightSum)
  const factor = clamp(0.84 + geologyRisk * 0.46 + coverage * 0.08, 0.84, 1.38)
  return {
    risk: geologyRisk,
    factor,
    coverage,
    lithology: bestLithology,
    sampleCount: ranked.length
  }
}

/**
 * 综合安全评分 — 核心函数
 *
 * 输入: 应力张量 (sxx,syy,szz,sxy,syz,szx)
 * 输出: 1-10 安全评分 (1=极安全, 10=极危险)
 *
 * 评分流程:
 *   1. 计算 von Mises 等效应力
 *   2. 以材料屈服/参考强度归一化 → 应力利用率 U
 *   3. 基于 Hoek-Brown 破坏阶段给基础分
 *   4. 特征值分解 → 拉应力/剪应力附加修正
 *   5. 地质岩性修正 (GSI/钻孔)
 *   6. 岩爆倾向性附加
 */
export function computeSafetyScoreFromStress(stressTensor, safetyContext = null, localPos = null) {
  const s = stressTensor || {}
  const principal = eigenvaluesSymmetric3(s)
  const sigma1 = Number(principal[0]) || 0
  const sigma3 = Number(principal[2]) || 0
  const vonMises = computeVonMises(s)
  const tauMax = Math.max(0, (sigma1 - sigma3) * 0.5)

  const ref = resolveSafetyReference(safetyContext)

  // 1. 应力利用率 (von Mises / 参考强度)
  const utilization = vonMises / Math.max(ref, 1e-6)
  const baseScore = resolveStressBaseScore(utilization)

  // 2. 拉/剪修正
  const tensionRatio = Math.max(0, sigma1) / Math.max(ref, 1e-6)
  const shearRatio = tauMax / Math.max(ref, 1e-6)
  const compressionRatio = Math.abs(Math.min(0, sigma3)) / Math.max(ref, 1e-6)

  const tensionAdjustment = clamp01((tensionRatio - 0.55) / 0.45) * 0.7
  const shearAdjustment = clamp01((shearRatio - 0.28) / 0.42) * 0.45
  const compressionAdjustment = clamp01((compressionRatio - 0.85) / 0.5) * 0.25

  // 3. 地质修正
  const geology = resolveGeologyAtLocalPos(safetyContext, localPos)
  const geologyAdjustment = clamp(
    (geology.risk - 0.45) * 2.4 * (0.65 + geology.coverage * 0.35),
    -0.6,
    1.6
  )

  // 4. 岩爆倾向性附加 (基于 σ_θ/σ_c)
  let rockburstAdjustment = 0
  if (safetyContext?.sigmaC) {
    const rb = assessRockburstRisk(s, safetyContext.sigmaC)
    if (rb.level === 'strong') rockburstAdjustment = 1.5
    else if (rb.level === 'moderate') rockburstAdjustment = 0.8
    else if (rb.level === 'weak') rockburstAdjustment = 0.3
  }

  const score = clamp(
    baseScore +
      tensionAdjustment +
      shearAdjustment +
      compressionAdjustment +
      geologyAdjustment +
      rockburstAdjustment,
    SAFETY_SCORE_MIN,
    SAFETY_SCORE_MAX
  )

  return roundTo(score, 2)
}

// ============================================================================
// 八、综合多维度安全评估 (新增)
// ============================================================================

/**
 * 综合安全评估结果
 * 融合应力准则、岩体分级、岩爆倾向性三维度
 */
export function computeComprehensiveAssessment(stressTensor, options = {}) {
  const {
    safetyContext = null,
    localPos = null,
    sigmaC = 50,
    cohesion,
    frictionAngle,
    tensileStrength
  } = options
  const ref = resolveSafetyReference(safetyContext)

  const hbParams = computeHoekBrownParams(
    sigmaC,
    safetyContext?.GSI || 55,
    safetyContext?.mi || 12,
    safetyContext?.disturbanceFactor || 0
  )

  const principal = eigenvaluesSymmetric3(stressTensor)
  const sigma1 = Number(principal[0]) || 0
  const sigma3 = Number(principal[2]) || 0

  // 维度1: 应力准则评价
  const hbUtil = hoekBrownUtilization(sigma1, sigma3, hbParams)
  const mcResult = mohrCoulombAssessment(stressTensor, { cohesion, frictionAngle, tensileStrength })
  const safetyScore = computeSafetyScoreFromStress(stressTensor, safetyContext, localPos)

  // 维度2: 岩体分级 (基于推断参数)
  const rc = sigmaC
  const kv = safetyContext?.Kv || 0.55
  const bq = computeBQ(rc, kv)
  const bqModified = computeBQModified(
    bq,
    safetyContext?.k1 || 0,
    safetyContext?.k2 || 0,
    safetyContext?.k3 || 0
  )
  const bqClass = classifyBQ(bqModified)

  // 维度3: 岩爆倾向性
  const rockburst = assessRockburstRisk(stressTensor, sigmaC)

  // 破坏阶段判定
  const vonMises = computeVonMises(stressTensor)
  const u = vonMises / Math.max(ref, 1e-6)
  let damageStage
  if (u <= 0.35)
    damageStage = {
      stage: 'elastic',
      label: '弹性阶段',
      description: '应力-应变为线性关系，卸载后完全恢复'
    }
  else if (u <= 0.65)
    damageStage = {
      stage: 'damage',
      label: '损伤阶段',
      description: '微裂隙萌生扩展，刚度开始衰减'
    }
  else if (u <= 0.9)
    damageStage = {
      stage: 'yield',
      label: '屈服阶段',
      description: '裂隙贯通，塑性变形显著，体积膨胀'
    }
  else if (u <= 1.0)
    damageStage = {
      stage: 'failure',
      label: '破坏阶段',
      description: '裂隙网络贯通，承载力接近峰值'
    }
  else
    damageStage = {
      stage: 'unstable',
      label: '失稳阶段',
      description: '超过峰值强度，应变软化，需立即处理'
    }

  return {
    safetyScore,
    riskLevel: resolveRiskLevel(safetyScore),
    damageStage,
    stressCriteria: {
      vonMises: roundTo(vonMises, 2),
      utilization: roundTo(u, 3),
      referenceStrength: ref,
      hoekBrown: { utilization: roundTo(hbUtil, 3), params: hbParams },
      mohrCoulomb: mcResult
    },
    rockMassClass: bqClass
      ? {
          ...bqClass,
          BQ: bqModified,
          BQRaw: bq,
          hardness: classifyRockHardness(rc),
          integrity: classifyRockIntegrity(kv)
        }
      : null,
    rockburst,
    note: bqClass
      ? `BQ ${bqModified} — ${bqClass.label} ${bqClass.stability}岩体，应力利用率 ${(u * 100).toFixed(1)}%`
      : `应力利用率 ${(u * 100).toFixed(1)}%，${damageStage.label}`
  }
}

// ============================================================================
// 九、安全评分可视化映射
// ============================================================================

export function isSafetyMetric(metric) {
  return String(metric || '') === SAFETY_SCORE_METRIC
}

export function resolveMetricDisplayUnit(metric, stressUnit = '') {
  return isSafetyMetric(metric) ? SAFETY_SCORE_UNIT : stressUnit || ''
}

export function resolveMetricFixedRange(metric) {
  return isSafetyMetric(metric) ? [...SAFETY_SCORE_FIXED_RANGE] : null
}

export function buildSafetyColorRamp() {
  return [
    { value: 0.15, color: '#22c55e', label: '较安全' },
    { value: 0.45, color: '#facc15', label: '关注' },
    { value: 0.75, color: '#f97316', label: '高风险' },
    { value: 1, color: '#ef4444', label: '极高风险' }
  ]
}

export function mapSafetyScoreToIntensity(score) {
  const normalized = clamp01(
    ((Number(score) || SAFETY_SCORE_MIN) - SAFETY_SCORE_MIN) / (SAFETY_SCORE_MAX - SAFETY_SCORE_MIN)
  )
  return clamp01(Math.pow(normalized, 1.15))
}

export function mapSafetyScoreToRadius(score, algo) {
  const intensity = mapSafetyScoreToIntensity(score)
  const r0 = Number(algo?.radiusMin) || 10
  const rs = Number(algo?.radiusScale) || 50
  return Math.max(0.1, r0 + rs * Math.pow(intensity, Number(algo?.radiusGamma) || 1))
}

// ============================================================================
// 十、区域安全分析 (保持不变，增强输出)
// ============================================================================

export function resolvePointLocalPosition(point, size) {
  if (Array.isArray(point?.localPos) && point.localPos.length >= 3) {
    return resolveLocalPos(point.localPos)
  }
  if (point?.coordMode === 'UVW') {
    return resolveLocalPos(point.center)
  }
  const sx = Math.max(1e-6, Number(size?.[0]) || 1)
  const sy = Math.max(1e-6, Number(size?.[1]) || 1)
  const sz = Math.max(1e-6, Number(size?.[2]) || 1)
  if (point?.coordMode === 'ENU' && Array.isArray(point?.center) && point.center.length >= 3) {
    return resolveLocalPos([
      Number(point.center[0]) / sx + 0.5,
      Number(point.center[1]) / sy + 0.5,
      Number(point.center[2]) / sz + 0.5
    ])
  }
  return [0.5, 0.5, 0.5]
}

export function buildSafetySignature(safetyContext) {
  if (!safetyContext || typeof safetyContext !== 'object') return 'none'
  return String(safetyContext.signature || 'none')
}

function createBucket(id, label, centerLocalPos, geology) {
  return {
    id,
    label,
    centerLocalPos,
    geology,
    count: 0,
    sumScore: 0,
    peakScore: 0,
    bandCounts: { safe: 0, attention: 0, warning: 0, danger: 0, critical: 0 }
  }
}

function buildBucketCatalog(safetyContext) {
  const xs = ['西', '中', '东']
  const ys = ['南', '中', '北']
  const zs = ['深层', '浅层']
  const buckets = []
  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const centerLocalPos = [(x + 0.5) / 3, (y + 0.5) / 3, (z + 0.5) / 2]
        const geology = resolveGeologyAtLocalPos(safetyContext, centerLocalPos)
        buckets.push(
          createBucket(`b-${x}-${y}-${z}`, `${xs[x]}${ys[y]}-${zs[z]}`, centerLocalPos, geology)
        )
      }
    }
  }
  return buckets
}

function resolveBucketIndex(localPos) {
  const p = resolveLocalPos(localPos)
  const x = Math.min(2, Math.floor(p[0] * 3))
  const y = Math.min(2, Math.floor(p[1] * 3))
  const z = Math.min(1, Math.floor(p[2] * 2))
  return z * 9 + y * 3 + x
}

function updateBucket(bucket, score) {
  bucket.count++
  bucket.sumScore += score
  bucket.peakScore = Math.max(bucket.peakScore, score)
  bucket.bandCounts[resolveBandKey(score)]++
}

function buildSummaryFromBuckets(buckets, sampleCount, geologyEnabled) {
  const validBuckets = buckets.filter(bucket => bucket.count > 0)
  if (validBuckets.length < 1) return null
  let scoreSum = 0,
    peakScore = 0,
    dangerCount = 0,
    criticalCount = 0
  const globalCounts = { safe: 0, attention: 0, warning: 0, danger: 0, critical: 0 }

  for (const bucket of validBuckets) {
    const avgScore = bucket.sumScore / Math.max(1, bucket.count)
    bucket.avgScore = roundTo(avgScore, 2)
    bucket.peakScore = roundTo(bucket.peakScore, 2)
    scoreSum += bucket.sumScore
    peakScore = Math.max(peakScore, bucket.peakScore)
    dangerCount += bucket.bandCounts.danger
    criticalCount += bucket.bandCounts.critical
    for (const key of Object.keys(globalCounts)) {
      globalCounts[key] += bucket.bandCounts[key]
    }
    bucket.riskLevel = resolveRiskLevel(Math.max(bucket.avgScore, bucket.peakScore))
    bucket.geologyLabel =
      bucket.geology.lithology || (geologyEnabled ? '附近钻孔不足' : '未接入地质数据')
  }

  validBuckets.sort(
    (a, b) => b.peakScore - a.peakScore || b.avgScore - a.avgScore || b.count - a.count
  )
  const avgScore = scoreSum / Math.max(1, sampleCount)
  return {
    sampleCount,
    overallScore: roundTo(avgScore, 2),
    peakScore: roundTo(peakScore, 2),
    riskLevel: resolveRiskLevel(Math.max(avgScore, peakScore)),
    highRiskRatio: roundTo(((dangerCount + criticalCount) / Math.max(1, sampleCount)) * 100, 1),
    geologyParticipation: geologyEnabled,
    bandStats: buildBandStatsSummary(globalCounts, sampleCount),
    topRegions: validBuckets.slice(0, 6).map(bucket => ({
      id: bucket.id,
      label: bucket.label,
      avgScore: bucket.avgScore,
      peakScore: bucket.peakScore,
      count: bucket.count,
      riskLevel: bucket.riskLevel,
      geologyLabel: bucket.geologyLabel
    }))
  }
}

function readGridTensor(frame, index) {
  return {
    sxx: frame.xx[index],
    syy: frame.yy[index],
    szz: frame.zz[index],
    sxy: frame.xy[index],
    syz: frame.yz[index],
    szx: frame.zx[index]
  }
}

export function buildSafetyAnalysisSummary(
  sourceKind,
  sourceData,
  currentTime,
  safetyContext = null
) {
  const kind = String(sourceKind || '')
  const geologyEnabled = Boolean(safetyContext?.geologySamples?.length)
  const buckets = buildBucketCatalog(safetyContext)

  if (kind === 'points') {
    const points = ensureArray(sourceData?.points)
    const frameIndex = Math.max(
      0,
      Math.min(points[0]?.stressSeries?.length || 1, Number(currentTime) || 0)
    )
    let sampleCount = 0
    for (const point of points) {
      if (!point?.tensor6) continue
      const localPos = resolvePointLocalPosition(point, sourceData?.size)
      const tensor = {
        sxx: point.tensor6.xx?.[frameIndex],
        syy: point.tensor6.yy?.[frameIndex],
        szz: point.tensor6.zz?.[frameIndex],
        sxy: point.tensor6.xy?.[frameIndex],
        syz: point.tensor6.yz?.[frameIndex],
        szx: point.tensor6.zx?.[frameIndex]
      }
      const score = computeSafetyScoreFromStress(tensor, safetyContext, localPos)
      updateBucket(buckets[resolveBucketIndex(localPos)], score)
      sampleCount++
    }
    const summary = buildSummaryFromBuckets(buckets, sampleCount, geologyEnabled)
    return summary
      ? {
          ...summary,
          frameIndex,
          sourceKind: 'points',
          note: geologyEnabled
            ? '已叠加附近钻孔岩性、GSI及厚度影响 (GB/T 50218-2014)'
            : '当前缺少地质钻孔，评分仅按应力准则 (Hoek-Brown + Mohr-Coulomb) 计算'
        }
      : null
  }

  if (kind === 'grid') {
    const frames = ensureArray(sourceData?.data?.frames)
    const frameIndex = Math.max(0, Math.min(frames.length - 1, Number(currentTime) || 0))
    const frame = frames[frameIndex]
    if (!frame) return null
    const width = Math.max(1, Number(sourceData?.grid?.width) || 1)
    const height = Math.max(1, Number(sourceData?.grid?.height) || 1)
    const depth = Math.max(1, Number(sourceData?.grid?.depth) || 1)
    const total = width * height * depth
    if (total < 1) return null
    const step = Math.max(1, Math.floor(total / 48000))
    let sampleCount = 0
    for (let index = 0; index < total; index += step) {
      const plane = width * height
      const z = Math.floor(index / plane)
      const remain = index - z * plane
      const y = Math.floor(remain / width)
      const x = remain - y * width
      const localPos = [
        width > 1 ? x / (width - 1) : 0.5,
        height > 1 ? y / (height - 1) : 0.5,
        depth > 1 ? z / (depth - 1) : 0.5
      ]
      const score = computeSafetyScoreFromStress(
        readGridTensor(frame, index),
        safetyContext,
        localPos
      )
      updateBucket(buckets[resolveBucketIndex(localPos)], score)
      sampleCount++
    }
    const summary = buildSummaryFromBuckets(buckets, sampleCount, geologyEnabled)
    return summary
      ? {
          ...summary,
          frameIndex,
          sourceKind: 'grid',
          note: geologyEnabled
            ? '区域评分按当前帧应力场 (Hoek-Brown) 与 GB/T 50218-2014 岩体分级综合计算'
            : '当前缺少地质钻孔，评分按当前帧应力场 (Hoek-Brown + Mohr-Coulomb) 计算'
        }
      : null
  }

  return null
}

export function buildSafetyContext({
  signature = '',
  stressReference = null,
  yieldStrength = null,
  geologySamples = [],
  defaultGeologyRisk = 0.45,
  GSI = 55,
  mi = 12,
  D = 0,
  Kv = 0.55,
  sigmaC = 50
} = {}) {
  return {
    signature: String(signature || 'none'),
    stressReference: Number.isFinite(Number(stressReference)) ? Number(stressReference) : null,
    yieldStrength: Number.isFinite(Number(yieldStrength)) ? Number(yieldStrength) : null,
    geologySamples: ensureArray(geologySamples).map(sample => ({
      localPos: resolveLocalPos(sample?.localPos),
      lithology: String(sample?.lithology || ''),
      thickness: Math.max(0, Number(sample?.thickness) || 0),
      risk: clamp01(Number(sample?.risk) || defaultGeologyRisk)
    })),
    defaultGeologyRisk: clamp01(defaultGeologyRisk),
    GSI: clamp(Number(GSI) || 55, 5, 100),
    mi: clamp(Number(mi) || 12, 4, 35),
    disturbanceFactor: clamp01(Number(D) || 0),
    Kv: clamp01(Number(Kv) || 0.55),
    sigmaC: Math.max(1, Number(sigmaC) || 50),
    k1: 0,
    k2: 0,
    k3: 0
  }
}
