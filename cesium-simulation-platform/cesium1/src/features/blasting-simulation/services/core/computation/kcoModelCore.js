/**
 * KCO 碎块尺寸分布模型 (Kuznetsov-Cunningham-Ouchterlony)
 *
 * KCO 模型是 Kuz-Ram 的改进版，包含三部分：
 * 1. Kuznetsov-Cunningham 方程：计算中位块度 x50
 *    x50 = 0.01 × A × Q^(1/6) × (115/RWS)^(19/30)
 *    其中 A = 0.06×(RMD + RDI + HF)（岩石因子），Q = 单孔装药量(kg)，RWS = 相对重量威力(ANFO=100)
 *    修正：原实现用 (V/Q)^0.167 × (115/RWS)^0.167 系误用，与后端 kco_validator.py 一致
 * 2. Cunningham 均匀性指数 n（2 因子简化版，与后端 kco_validator.py:49 对齐）：
 *    n = (2.2 - 14·d/B) × (1 - W_abs/B) / 2
 *    其中 d 为孔径(m)，B 为抵抗线(m)，W_abs 为钻孔偏差(m)
 * 3. Ouchterlony Swebrec 分布函数（替代 Rosin-Rammler），与后端 kco_validator.py:_swebrec_cdf 对齐：
 *    P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
 *
 * 此模块为 particleSystemCore.js 和 threeBlastingRenderer.js 提供
 * 统一的 KCO 模型实现，消除多处重复。
 */

import { KCO_OVERSIZE_THRESHOLD } from './blastConstants.js'
// 注：KCO_OVERSIZE_THRESHOLD(0.8m) 为 oversize 大块判定阈值，与后端 kco_validator.py 对齐。
// 本文件当前未直接使用（oversize 占比统计由上层调用方按需计算），此处导入备用以便后续扩展。
// KCO 默认参数（公路隧道中硬岩典型值）
export const DEFAULT_KCO_PARAMS = {
  Q: 320,      // 单孔装药量(kg)
  q: 0.8,      // 炸药单耗(kg/m³)
  B: 1.5,      // 抵抗线(m)
  S: 2.0,      // 孔间距(m)
  RWS: 100,    // 炸药相对ANFO重量威力(%)
  Lb: 1.5,     // 底部装药长度(m)
  Lc: 3.0,     // 柱状装药长度(m)
  Ltot: 4.5,   // 总装药长度(m)
  H: 4.5,      // 台阶高度(m)
  d: 0.04,     // 炮孔直径(m)
  SD: 0.2,     // 钻孔精度标准差(m)，对应 Cunningham 公式中的 W_abs
  RMD: 20,     // 岩体描述因子(0-30)
  RDI: 15,     // 岩石密度影响(0-20)
  HF: 25,      // 硬度因子(0-30)
  xmax: 2.0,   // 最大块度尺寸(m)
  b: 2.0       // Swebrec曲线弯曲参数
}

/**
 * 计算 KCO 模型参数
 * @param {Object} p - KCO 输入参数（与 DEFAULT_KCO_PARAMS 合并）
 * @returns {{ x50:number, xmax:number, b:number, n:number, A:number }}
 */
export function calculateKCOParams(p = {}) {
  const params = { ...DEFAULT_KCO_PARAMS, ...p }
  const A = 0.06 * (params.RMD + params.RDI + params.HF)
  const Q = Math.max(1, params.Q)
  // 标准 Kuznetsov 方程：x50 = 0.01·A·Q^(1/6)·(115/RWS)^(19/30)
  // 修正：原 V/Q^0.167 × (115/RWS)^0.167 系误用，与后端 kco_validator.py:46 对齐
  const x50 = 0.01 * A * Math.pow(Q, 1 / 6) * Math.pow(115 / Math.max(1, params.RWS), 19 / 30)

  // Cunningham 均匀性指数 n（2 因子简化版，与后端 kco_validator.py:49 对齐）
  // n = (2.2 - 14·d/B) × (1 - W_abs/B) / 2，clamp [0.5, 2.5]
  // 修正：原实现 B 与 d 颠倒（14·B/d），且含 Lc/Ltot、Lb/Ltot、H/B 多余因子，已删除
  const d = Math.max(0.001, params.d)
  const B = Math.max(0.01, params.B)
  const W_abs = params.SD
  let n = (2.2 - 14 * d / B) * (1 - W_abs / B) / 2
  n = Math.max(0.5, Math.min(2.5, n))

  const xmax = Math.max(0.2, Math.min(5.0, Number(params.xmax) || 2.0))
  const b = Math.max(1.0, Math.min(5.0, params.b))
  return { x50, xmax, b, n, A }
}

/**
 * Swebrec 分布累积函数 P(x)：尺寸 ≤ x 的碎块比例
 * 与后端 backend-py/app/services/blasting/kco_validator.py:_swebrec_cdf 公式一致：
 *   P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
 * 边界：x ≤ 0 → 0；x ≥ xmax → 1
 * @param {number} x - 块度尺寸(m)
 * @param {number} x50 - 中位块度尺寸(m)
 * @param {number} xmax - 最大块度尺寸(m)
 * @param {number} n - 均匀性指数
 * @param {number} b - Swebrec 曲线弯曲参数
 * @returns {number} 累计概率 ∈ [0, 1]
 */
export function swebrecCdf(x, x50, xmax, n, b) {
  if (x <= 0) return 0
  if (x >= xmax) return 1
  const ratio = Math.pow(x / x50, n)
  const denom = Math.pow((xmax - x) / (xmax - x50), b)
  return 1 - Math.exp(-Math.LN2 * ratio / denom)
}

/**
 * 从 Swebrec 分布函数采样一个碎块尺寸
 * 采用反函数法：生成 u ~ U(0,1)，二分法求解 swebrecCdf(x, ...) = u，返回 x
 * 公式与后端 kco_validator.py:_swebrec_cdf 对齐
 * @param {number} x50 - 中位块度尺寸(m)
 * @param {number} xmax - 最大块度尺寸(m)
 * @param {number} n - 均匀性指数
 * @param {number} b - Swebrec曲线弯曲参数
 * @param {() => number} rng - 随机数生成器（默认 Math.random）
 * @returns {number} 碎块尺寸(m) ∈ [0.02, xmax]
 */
export function sampleSwebrecSize(x50, xmax, n, b, rng = Math.random) {
  const safeX50 = Math.max(0.01, Math.min(xmax * 0.99, x50))
  const u = Math.max(1e-6, Math.min(1 - 1e-6, rng()))
  // 二分法求解 swebrecCdf(x, safeX50, xmax, n, b) = u
  // cdf 在 (0, xmax) 上严格单调递增，60 次迭代精度远超浮点极限
  let lo = 1e-6
  let hi = xmax - 1e-6
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (swebrecCdf(mid, safeX50, xmax, n, b) < u) lo = mid
    else hi = mid
  }
  const x = (lo + hi) / 2
  return Math.max(0.02, Math.min(xmax, x))
}

/**
 * 生成 Swebrec 分布的块度直方图（供 UI 预览使用）
 * 直接用 swebrecCdf 计算各档累计概率，每档概率 = cdf(上界) - cdf(下界)，
 * 与后端分布完全一致（无需蒙特卡洛采样）
 * @param {number} x50 - 中位块度
 * @param {number} xmax - 最大块度
 * @param {number} n - 均匀性指数
 * @param {number} b - 弯曲参数
 * @param {number} binCount - 分级数（默认 20）
 * @param {number} sampleCount - 虚拟采样总数，用于将 pct 换算为 count（默认 10000）
 * @returns {Array<{minR:number, maxR:number, count:number, pct:number}>}
 */
export function generateSwebrecHistogram(x50, xmax, n, b, binCount = 20, sampleCount = 10000) {
  const bins = []
  const binWidth = xmax / binCount
  for (let i = 0; i < binCount; i++) {
    const lo = i * binWidth
    const hi = (i + 1) * binWidth
    const cdfLo = swebrecCdf(lo, x50, xmax, n, b)
    const cdfHi = swebrecCdf(hi, x50, xmax, n, b)
    const pct = Math.max(0, cdfHi - cdfLo)
    bins.push({ minR: lo, maxR: hi, count: Math.round(pct * sampleCount), pct })
  }
  return bins
}

// 对齐说明：本文件 KCO 模型实现已与后端 backend-py/app/services/blasting/kco_validator.py 对齐：
//   - n 公式采用 2 因子简化版 (2.2 - 14·d/B) × (1 - W_abs/B) / 2，clamp [0.5, 2.5]
//   - 参数名 RWS（相对重量威力），d/B/W_abs 单位均为 m
//   - 验证：Q=320, A=3.6, RWS=100, B=1.5, d=0.04, W_abs=0.2 → n ≈ 0.7916
export default { DEFAULT_KCO_PARAMS, calculateKCOParams, swebrecCdf, sampleSwebrecSize, generateSwebrecHistogram }
