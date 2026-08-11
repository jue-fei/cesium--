/**
 * KCO 碎块尺寸分布模型 (Kuznetsov-Cunningham-Ouchterlony)
 *
 * KCO 模型是 Kuz-Ram 的改进版，包含三部分：
 * 1. Kuznetsov-Cunningham 方程：计算中位块度 x50
 *    x50 = 0.01 × A × Q^(1/6) × (115/RWS)^(19/30)
 *    其中 A = 0.06×(RMD + RDI + HF)（岩石因子），Q = 单孔装药量(kg)，RWS = 相对重量威力(ANFO=100)
 *    修正：原实现用 (V/Q)^0.167 × (115/SANFO)^0.167 系误用，与后端 kco_validator.py 一致
 * 2. Cunningham 均匀性指数 n：
 *    n = (2.2 - 14·d/B) × (1 - W_abs/B) / 2，clamp 到 [0.5, 2.5]
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

import {
  swebrecCdf,
  swebrecInverse,
  solveX80,
  cunninghamN
} from './kcoFormulas.js'

// KCO 默认参数（公路隧道中硬岩典型值）
export const DEFAULT_KCO_PARAMS = {
  Q: 320, // 单孔装药量(kg)
  q: 0.8, // 炸药单耗(kg/m³)
  B: 1.5, // 抵抗线(m)
  S: 2.0, // 孔间距(m)
  SANFO: 100, // 炸药相对ANFO重量威力(%)
  Lb: 1.5, // 底部装药长度(m)
  Lc: 3.0, // 柱状装药长度(m)
  Ltot: 4.5, // 总装药长度(m)
  H: 4.5, // 台阶高度(m)
  d: 90, // 炮孔直径(mm)
  SD: 0.2, // 钻孔精度标准差(m)
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function toFiniteNumber(value, fallback = null) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function calculateUniformityIndex(p = {}) {
  const params = { ...DEFAULT_KCO_PARAMS, ...p }
  const B = Math.max(0.01, toFiniteNumber(params.B, DEFAULT_KCO_PARAMS.B))
  const d = Math.max(
    0.001,
    (toFiniteNumber(params.d, DEFAULT_KCO_PARAMS.d) || DEFAULT_KCO_PARAMS.d) / 1000
  )
  // Cunningham n：B=抵抗线，d=孔径(m)，W_abs=钻孔偏差(drillDeviation，缺失则 0)
  const W_abs = Math.max(0, toFiniteNumber(params.drillDeviation, 0))
  return cunninghamN(B, d, W_abs)
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
  const Q = Math.max(1, params.Q)
  // 标准 Kuznetsov 方程：x50 = 0.01·A·Q^(1/6)·(115/RWS)^(19/30)
  // 修正：原 V/Q^0.167 × (115/SANFO)^0.167 系误用，与后端 kco_validator.py:45 对齐
  const computedX50 =
    0.01 * A * Math.pow(Q, 1 / 6) * Math.pow(115 / Math.max(1, params.SANFO), 19 / 30)
  const computedN = calculateUniformityIndex(params)

  const resultDrivenX50 = toFiniteNumber(params.x50)
  const resultDrivenN = toFiniteNumber(params.n)
  const x50 =
    sourceMode === KCO_SOURCE_MODE.RESULT && resultDrivenX50 != null
      ? Math.max(0.01, resultDrivenX50)
      : computedX50
  const n =
    sourceMode === KCO_SOURCE_MODE.RESULT && resultDrivenN != null
      ? clamp(resultDrivenN, 0.5, 3.0)
      : computedN

  const xmax = clamp(toFiniteNumber(params.xmax, 2.0), 0.2, 5.0)
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
 * 生成 Swebrec 分布的块度直方图（供 UI 预览使用）
 * 直接按 swebrecCdf 计算分箱概率：pct[i] = CDF(x_{i+1}) - CDF(x_i)
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
 * @returns {Array<{min:number, max:number, count:number, pct:number}>} 长度等于 binEdges.length - 1
 */
export function binHistogram(values, binEdges) {
  const binCount = binEdges.length - 1
  const bins = []
  for (let i = 0; i < binCount; i++) {
    bins.push({ min: binEdges[i], max: binEdges[i + 1], count: 0, pct: 0 })
  }
  const total = Array.isArray(values) ? values.length : 0
  if (total === 0) {
    return bins
  }
  for (const value of values) {
    const num = Number(value)
    if (!Number.isFinite(num)) continue
    // 归入对应分箱：min <= value < max，最后一个分箱含上界
    for (let i = 0; i < binCount; i++) {
      const isLast = i === binCount - 1
      if (num >= bins[i].min && (isLast ? num <= bins[i].max : num < bins[i].max)) {
        bins[i].count++
        break
      }
    }
  }
  for (const bin of bins) {
    bin.pct = bin.count / total
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
  calculateUniformityIndex,
  calculateKCOParams,
  sampleSwebrecSize,
  generateSwebrecHistogram,
  binHistogram,
  computeKLDivergence
}
