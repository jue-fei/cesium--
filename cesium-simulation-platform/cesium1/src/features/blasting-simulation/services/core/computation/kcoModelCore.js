/**
 * KCO 碎块尺寸分布模型 (Kuznetsov-Cunningham-Ouchterlony)
 *
 * KCO 模型是 Kuz-Ram 的改进版，包含三部分：
 * 1. Kuznetsov-Cunningham 方程：计算中位块度 x50
 *    x50 = 0.01 × A × Q^(1/6) × (115/RWS)^(19/30)
 *    其中 A = 0.06×(RMD + RDI + HF)（岩石因子），Q = 单孔装药量(kg)，RWS = 相对重量威力(ANFO=100)
 *    修正：原实现用 (V/Q)^0.167 × (115/SANFO)^0.167 系误用，与后端 kco_validator.py 一致
 * 2. Cunningham 均匀性指数 n（完整形式，Cunningham 1983/1987）：
 *    n = (2.2 - 14·B/d_mm) × (1 - W_abs/B) × sqrt(1 + (S/B - 1)/2) × (L/H)，clamp 到 [0.5, 2.5]
 * 3. Swebrec 分布函数（Kuz-Ram exp 形式，与后端 kco_formulas.py 对齐）：
 *    P(x) = 1 - exp(-ln2 · (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
 *
 * 分布函数、反解、x80、Cunningham n 等纯公式统一抽取到 ./kcoFormulas.js，
 * 与后端 backend-py/app/services/blasting/kco_formulas.py 数值对齐。
 *
 * 此模块为 particleSystemCore.js 和 threeBlastingRenderer.js 提供
 * 统一的 KCO 模型实现，消除多处重复。
 *
 * 另提供分布直方图诊断工具：binHistogram（按分箱边界归箱）与
 * computeKLDivergence（KL 散度，衡量实际采样与理论分布的形态差异）。
 */

import { swebrecCdf, swebrecInverse, solveX80, cunninghamN } from './kcoFormulas.js'
import { toFiniteNumber } from '../blastDefaults.js'

// KCO 默认参数（公路隧道中硬岩典型值）
// Q 为单孔装药量(kg)，由单耗 q × 单孔崩落体积 B×S×H 推导（q=0.8, B=1.5, S=2.0, H=4.5 → 10.8kg）
export const DEFAULT_KCO_PARAMS = {
  Q: 10.8, // 单孔装药量(kg) = q × B × S × H
  q: 0.8, // 炸药单耗(kg/m³)
  B: 1.5, // 抵抗线(m)
  S: 2.0, // 孔间距(m)
  SANFO: 100, // 炸药相对ANFO重量威力(%)
  Lb: 1.5, // 底部装药长度(m)
  Lc: 3.0, // 柱状装药长度(m)
  Ltot: 4.5, // 总装药长度(m)
  H: 4.5, // 台阶高度(m)
  d: 90, // 炮孔直径(mm)
  drillDeviation: 0.2, // 钻孔精度标准差(m)，与后端 KCOInput.W_abs 默认 0.2 对齐
  RMD: 20, // 岩体描述因子(0-30)
  RDI: 15, // 岩石密度影响(0-20)
  HF: 25, // 硬度因子(0-30)
  xmax: 2.0, // 最大块度尺寸(m)
  b: 2.0 // Swebrec曲线弯曲参数
}

export const KCO_SOURCE_MODE = {
  DESIGN: 'design',
  RESULT: 'result'
}

/**
 * 场地预设：按工程场景封装岩石因子 + 装药 + 孔网典型值
 * 用于 UI 一键填充，避免用户面对裸数值。数值来源：工程经验典型值，非标定。
 */
export const SITE_PRESETS = {
  'highway-tunnel-hard': {
    label: '公路隧道·中硬岩',
    RMD: 20,
    RDI: 15,
    HF: 25,
    Q: 10.8, // = q × B × S × H
    q: 0.8,
    B: 1.5,
    S: 2.0,
    d: 90,
    SANFO: 100,
    H: 4.5,
    xmax: 2.0,
    b: 2.0
  },
  'subway-tunnel-soft': {
    label: '地铁隧道·软岩',
    RMD: 12,
    RDI: 10,
    HF: 15,
    Q: 3.2, // = q × B × S × H
    q: 0.55,
    B: 1.2,
    S: 1.6,
    d: 64,
    SANFO: 100,
    H: 3.0,
    xmax: 1.5,
    b: 1.8
  },
  'mine-drift-hard': {
    label: '矿山巷道·硬岩',
    RMD: 25,
    RDI: 18,
    HF: 28,
    Q: 19.8, // = q × B × S × H
    q: 1.0,
    B: 1.8,
    S: 2.2,
    d: 102,
    SANFO: 115,
    H: 5.0,
    xmax: 2.5,
    b: 2.2
  }
}

/**
 * 炸药类型 → { SANFO 相对ANFO威力, Eg 比能 J/kg }
 * SANFO 用于 Kuznetsov x50，Eg 用于 Persson 速度模型
 */
export const EXPLOSIVE_TYPES = {
  emulsion: { label: '乳化炸药', SANFO: 100, Eg: 3.9e6 },
  anfo: { label: 'ANFO', SANFO: 100, Eg: 2.484e6 },
  dynamite: { label: '胶质炸药', SANFO: 115, Eg: 3.56e6 }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function calculateUniformityIndex(p = {}) {
  const params = { ...DEFAULT_KCO_PARAMS, ...p }
  const B = Math.max(0.01, toFiniteNumber(params.B, DEFAULT_KCO_PARAMS.B))
  const d = Math.max(
    0.001,
    (toFiniteNumber(params.d, DEFAULT_KCO_PARAMS.d) || DEFAULT_KCO_PARAMS.d) / 1000
  )
  // Cunningham n 完整形式（Cunningham 1983/1987）：
  //   n = (2.2 - 14·B/d_mm)(1 - W_abs/B)·sqrt(1 + (S/B - 1)/2)·(L/H)
  // B=抵抗线(m), d=孔径(m，函数内 ×1000 转 mm 后用于主导项), W_abs=钻孔偏差(m),
  // S=孔距(m), L=装药长度(m), H=台阶高度(m)
  const W_abs = Math.max(0, toFiniteNumber(params.drillDeviation, 0))
  const S = Math.max(0.01, toFiniteNumber(params.S, DEFAULT_KCO_PARAMS.S))
  const L = Math.max(0, toFiniteNumber(params.Ltot, DEFAULT_KCO_PARAMS.Ltot))
  const H = Math.max(0.01, toFiniteNumber(params.H, DEFAULT_KCO_PARAMS.H))
  return cunninghamN(B, d, W_abs, S, L, H)
}

/**
 * 计算 KCO 模型参数
 * @param {Object} p - KCO 输入参数（与 DEFAULT_KCO_PARAMS 合并）
 * @returns {{ x50:number, xmax:number, b:number, n:number, A:number, x80:number }}
 */
export function calculateKCOParams(p = {}) {
  const params = { ...DEFAULT_KCO_PARAMS, ...p }
  const sourceMode =
    params.sourceMode === KCO_SOURCE_MODE.RESULT ? KCO_SOURCE_MODE.RESULT : KCO_SOURCE_MODE.DESIGN
  const A = 0.06 * (params.RMD + params.RDI + params.HF)

  // 标准 Kuznetsov 方程（Cunningham 1983）：
  //   X50 [cm] = A · (V₀/Q)^0.8 · Q^(1/6) · (115/RWS)^(19/30)
  // 其中 V₀ = B × S × H（单孔崩落体积，m³），Q 为单孔装药量（kg）
  // 修正：原实现缺比装药项 (V₀/Q)^0.8，导致 x50 与孔网尺寸脱钩
  const Q = Math.max(0.1, params.Q)
  const V0 = Math.max(0.01, params.B * params.S * params.H)
  const computedX50_cm =
    A *
    Math.pow(V0 / Q, 0.8) *
    Math.pow(Q, 1 / 6) *
    Math.pow(115 / Math.max(1, params.SANFO), 19 / 30)
  const computedX50 = Math.max(0.01, computedX50_cm * 0.01) // cm → m

  const computedN = calculateUniformityIndex(params)

  const resultDrivenX50 = toFiniteNumber(params.x50)
  const resultDrivenN = toFiniteNumber(params.n)
  // 显式提供的 x50/n 优先（后端 /validate/kco 打通或 result 驱动均适用），
  // 否则回退 Kuznetsov/Cunningham 计算。原实现仅 result 模式接受显式值。
  let x50 =
    resultDrivenX50 != null && resultDrivenX50 > 0 ? Math.max(0.01, resultDrivenX50) : computedX50
  const n = resultDrivenN != null ? clamp(resultDrivenN, 0.5, 3.0) : computedN

  const xmax = clamp(toFiniteNumber(params.xmax, 2.0), 0.2, 5.0)

  // x50 ≥ xmax 守卫：防止 NaN 传播到 UI
  if (x50 >= xmax) {
    const fallback = computedX50 < xmax ? computedX50 : xmax * 0.8
    x50 = fallback
    console.warn(
      `[KCO] x50(${x50.toFixed(3)}) 必须小于 xmax(${xmax})，已自动修正为 ${fallback.toFixed(3)}`
    )
  }

  const b = clamp(toFiniteNumber(params.b, 2.0), 1.0, 5.0)
  // x80 由 Swebrec 分布数值反解得到，不再用 x50*(1+b^0.3) 估算
  const x80 = solveX80(x50, xmax, n, b)
  return { x50, xmax, b, n, A, sourceMode, computedX50, computedN, x80 }
}

/**
 * 从 Swebrec 分布函数采样一个碎块尺寸
 * 通过数值反解 P(x)=u（u=rng()），u∈(0,1)
 * @param {number} x50 - 中位块度尺寸(m)
 * @param {number} xmax - 最大块度尺寸(m)
 * @param {number} n - 均匀性指数
 * @param {number} b - Swebrec曲线弯曲参数
 * @param {() => number} rng - 随机数生成器
 * @returns {number} 碎块尺寸(m)
 */
export function sampleSwebrecSize(x50, xmax, n, b, rng = Math.random) {
  const u = Math.max(1e-6, Math.min(1 - 1e-6, rng()))
  return swebrecInverse(u, x50, xmax, n, b)
}

/**
 * 从 Swebrec 分布采样一个碎块尺寸（等质量分层抽样）
 *
 * 目标：恢复 x50 作为**质量中位粒径**的语义——P(x) 是质量通过率（筛分按质量计），
 * 采样集合的（按等质量份额计）通过率曲线应与理论 P(x) 一致。
 *
 * 实现：等质量分层逆变换抽样（每个碎块承载相等质量份额）——
 * 将质量区间 (0,1] 均分为 N 等份，第 i 片（i=0..N-1）代表质量份额
 * [(i)/N, (i+1)/N)，其尺寸取该份额的质量分位（带层内 jitter）：
 *   u = (i + rng()) / N，x = P⁻¹(u)
 * 采样集的质量通过率 ≈ P(x)（分层误差 ≤ 1/N + 层内噪声），且天然覆盖全尺寸范围。
 *
 * 注：本实现舍弃了"数量密度 ∝ p(x)/size³"的方案——该数量密度在 x→0 发散
 * （粉尘数量无穷），有限样本几乎采不到 x50 以上的碎块（数值验证：5000 样本
 * 最大仅 0.25m），无法用有限碎片表达质量分布。等质量分层以"每片等质量"为
 * 代价，在有限样本下严格满足质量通过率 ≈ P，同时保证渲染尺寸分布不坍缩到粉尘端。
 *
 * @param {number} x50 - 中位块度尺寸(m，质量中位数)
 * @param {number} xmax - 最大块度尺寸(m)
 * @param {number} n - 均匀性指数
 * @param {number} b - Swebrec曲线弯曲参数
 * @param {() => number} [rng=Math.random] - 随机数生成器
 * @param {Object} [opts]
 * @param {number} [opts.index] - 当前碎块索引（0-based），用于等质量分层
 * @param {number} [opts.totalCount] - 碎块总数 N，用于等质量分层
 * @returns {number} 碎块尺寸(m)
 */
export function sampleSwebrecMassWeighted(x50, xmax, n, b, rng = Math.random, opts = {}) {
  const total = Number(opts.totalCount)
  const idx = Number(opts.index)
  let u
  if (Number.isFinite(total) && total > 0 && Number.isFinite(idx) && idx >= 0) {
    // 等质量分层：第 i 片承载质量份额 [(i)/N, (i+1)/N)
    const i = Math.min(total - 1, Math.floor(idx))
    u = (i + Math.min(0.999999, Math.max(1e-6, rng()))) / total
  } else {
    // 兜底：未提供分层信息时退化为均匀质量分位采样（避免粉尘坍缩）
    u = Math.min(0.999999, Math.max(1e-6, rng()))
  }
  return swebrecInverse(u, x50, xmax, n, b)
}

/**
 * 生成 Swebrec 分布的质量直方图（供 UI 预览使用）
 * 直接按 swebrecCdf 计算分箱概率：pct[i] = CDF(x_{i+1}) - CDF(x_i)，
 * 其中 P(x) 本身是**质量**通过率（x50 为质量中位数），故 pct 即各尺寸区间的质量占比。
 * @param {number} x50 - 中位块度
 * @param {number} xmax - 最大块度
 * @param {number} n - 均匀性指数
 * @param {number} b - 弯曲参数
 * @param {number} binCount - 分级数（默认 20）
 * @returns {Array<{minR:number, maxR:number, count:number, pct:number}>}
 */
export function generateSwebrecHistogram(x50, xmax, n, b, binCount = 20) {
  const bins = []
  const binWidth = xmax / binCount
  for (let i = 0; i < binCount; i++) {
    const minR = i * binWidth
    const maxR = (i + 1) * binWidth
    const pct = swebrecCdf(maxR, x50, xmax, n, b) - swebrecCdf(minR, x50, xmax, n, b)
    bins.push({ minR, maxR, count: 0, pct })
  }
  return bins
}

/**
 * 将数值数组按指定分箱边界归箱
 * @param {number[]} values - 数值数组（如所有碎石的 physSize）
 * @param {number[]} binEdges - 分箱边界数组（长度为 binCount+1，如 [0, 0.1, ..., xmax]）
 * @param {Object} [opts]
 * @param {(value:number)=>number} [opts.weight] - 权重函数（默认恒 1，即数量计数）。
 *   传 value => value³ 可得到**质量**直方图，用于与质量分布（swebrecCdf）语义对齐的 KL 对比。
 * @returns {Array<{min:number, max:number, count:number, pct:number}>} 长度等于 binEdges.length - 1
 */
export function binHistogram(values, binEdges, opts = {}) {
  const binCount = binEdges.length - 1
  const bins = []
  for (let i = 0; i < binCount; i++) {
    bins.push({ min: binEdges[i], max: binEdges[i + 1], count: 0, pct: 0 })
  }
  const weightFn = typeof opts.weight === 'function' ? opts.weight : null
  const total = Array.isArray(values) ? values.length : 0
  if (total === 0) {
    return bins
  }
  let totalWeight = 0
  for (const value of values) {
    const num = Number(value)
    if (!Number.isFinite(num)) continue
    const w = weightFn ? Math.max(0, Number(weightFn(num)) || 0) : 1
    totalWeight += w
    // 归入对应分箱：min <= value < max，最后一个分箱含上界
    for (let i = 0; i < binCount; i++) {
      const isLast = i === binCount - 1
      if (num >= bins[i].min && (isLast ? num <= bins[i].max : num < bins[i].max)) {
        bins[i].count += w
        break
      }
    }
  }
  for (const bin of bins) {
    bin.pct = totalWeight > 0 ? bin.count / totalWeight : 0
  }
  return bins
}

/**
 * 计算两个概率分布的 KL 散度
 * KL(p||q) = Σ p(i) × ln(p(i)/q(i))
 * 零值平滑：p_i = max(p[i], 1e-9)，q_i = max(q[i], 1e-9)，避免除零与 log(0)
 * @param {number[]} p - 概率分布数组（pct 数组，和为 1）
 * @param {number[]} q - 概率分布数组（pct 数组，和为 1，长度与 p 相同）
 * @returns {number|null} KL 散度值；长度不匹配或空数组时返回 null
 */
export function computeKLDivergence(p, q) {
  if (!Array.isArray(p) || !Array.isArray(q) || p.length === 0 || p.length !== q.length) {
    return null
  }
  let sum = 0
  for (let i = 0; i < p.length; i++) {
    const pi = Math.max(p[i], 1e-9)
    const qi = Math.max(q[i], 1e-9)
    sum += pi * Math.log(pi / qi)
  }
  return sum
}

export default {
  DEFAULT_KCO_PARAMS,
  KCO_SOURCE_MODE,
  SITE_PRESETS,
  EXPLOSIVE_TYPES,
  calculateUniformityIndex,
  calculateKCOParams,
  sampleSwebrecSize,
  sampleSwebrecMassWeighted,
  generateSwebrecHistogram,
  binHistogram,
  computeKLDivergence
}
