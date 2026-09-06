/**
 * 等质量分层抽样（R1）验证测试
 *
 * 背景：Swebrec 的 P(x) 是质量通过率（筛分按质量计），x50 为质量中位粒径。
 * sampleSwebrecMassWeighted 采用**等质量分层逆变换抽样**：将质量区间 (0,1] 均分
 * 为 N 等份，第 i 片承载质量份额 [(i)/N, (i+1)/N)，尺寸取该份额的质量分位
 * x = P⁻¹((i + ξ)/N)（ξ 为层内 jitter）。于是每个碎块承载相等质量份额，
 * 采样集的（等质量份额）通过率曲线与理论 P(x) 一致。
 *
 * 此语义下"质量通过率" = 承载该质量份额的碎块计数占比（每片 = 1/N），
 * 因此用**计数占比**与理论 P(x) 对比，而非按碎片实际体积 size³ 加权
 * （实际体积加权在有限样本下必然偏向大粒径，见"语义说明"用例）。
 *
 * 验收标准（对应优化方案 R1）：
 * 1. 对 5000 个抽样样本，等质量通过率直方图与 Swebrec 理论 KL < 0.01；
 * 2. 各尺寸点等质量通过率与理论 P(x) 最大绝对误差 < 5%；
 * 3. 采样集等质量中位数（50% 质量通过点）≈ x50；
 * 4. 全尺寸覆盖：最小样本 ≤ P⁻¹(0.1)、最大样本 ≥ P⁻¹(0.9)（不坍缩到粉尘端）。
 */
import { describe, it, expect } from 'vitest'
import {
  sampleSwebrecSize,
  sampleSwebrecMassWeighted,
  generateSwebrecHistogram,
  binHistogram,
  computeKLDivergence
} from '../kcoModelCore.js'
import { swebrecCdf, swebrecInverse } from '../kcoFormulas.js'

// 确定性随机数生成器（mulberry32），避免测试抖动
function makeSeededRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 等质量份额通过率：每片承载相等质量份额，故 = 尺寸 ≤ x 的碎块计数占比
function massPassingRate(sizes, x) {
  let countBelow = 0
  for (const s of sizes) if (s <= x) countBelow++
  return sizes.length > 0 ? countBelow / sizes.length : 0
}

// 采样集的等质量中位数：计数通过率达到 0.5 的尺寸点（= 数量中位粒径）
function massMedian(sizes) {
  let lo = 1e-4
  let hi = Math.max(...sizes) * 1.01
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (massPassingRate(sizes, mid) < 0.5) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// 按碎片实际体积 size³ 加权的通过率中位粒径（用于"语义说明"用例）
function volumeWeightedMedian(sizes) {
  const total = sizes.reduce((s, x) => s + Math.pow(x, 3), 0)
  const below = t =>
    sizes.reduce((s, x) => (x <= t ? s + Math.pow(x, 3) : s), 0) / total
  let lo = 1e-4
  let hi = Math.max(...sizes) * 1.01
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (below(mid) < 0.5) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// 参数组合（公路隧道·中硬岩典型值）
const X50 = 0.3
const XMAX = 2.0
const N = 1.2
const B = 2.0
const SAMPLE_COUNT = 5000

function sampleSet(massWeighted, seed = 12345) {
  const rng = makeSeededRng(seed)
  const sizes = []
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    sizes.push(
      massWeighted
        ? sampleSwebrecMassWeighted(X50, XMAX, N, B, rng, {
            index: i,
            totalCount: SAMPLE_COUNT
          })
        : sampleSwebrecSize(X50, XMAX, N, B, rng)
    )
  }
  return sizes
}

describe('sampleSwebrecMassWeighted（R1 等质量分层抽样）', () => {
  it('等质量通过率曲线与 Swebrec 理论 P(x) 最大绝对误差 < 5%', () => {
    const sizes = sampleSet(true)
    // 在多个尺寸点检验：涵盖 x50 上下及 x80 附近
    const checkPoints = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5]
    for (const x of checkPoints) {
      const actual = massPassingRate(sizes, x)
      const expected = swebrecCdf(x, X50, XMAX, N, B)
      expect(Math.abs(actual - expected)).toBeLessThan(0.05)
    }
  })

  it('5000 样本等质量通过率直方图与理论 KL < 0.01（R1 验收标准）', () => {
    const sizes = sampleSet(true)
    const binCount = 20
    const binWidth = XMAX / binCount
    const binEdges = Array.from({ length: binCount + 1 }, (_, i) => i * binWidth)

    // 等质量份额计数直方图（每片 = 1/N 质量份额）与理论质量分布对比
    const actualMass = binHistogram(sizes, binEdges)
    const targetMass = generateSwebrecHistogram(X50, XMAX, N, B, binCount)

    const kl = computeKLDivergence(
      actualMass.map(b => b.pct),
      targetMass.map(b => b.pct)
    )
    expect(kl).not.toBeNull()
    expect(kl).toBeLessThan(0.01)
  })

  it('采样集等质量中位数（50% 质量通过点）≈ x50', () => {
    const sizes = sampleSet(true)
    expect(Math.abs(massMedian(sizes) - X50)).toBeLessThan(0.05)
  })

  it('全尺寸覆盖：不坍缩到粉尘端（最小 ≤ P⁻¹(0.1)，最大 ≥ P⁻¹(0.9)）', () => {
    const sizes = sampleSet(true)
    const x10 = swebrecInverse(0.1, X50, XMAX, N, B)
    const x90 = swebrecInverse(0.9, X50, XMAX, N, B)
    expect(Math.min(...sizes)).toBeLessThanOrEqual(x10)
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(x90)
  })

  it('语义说明：按碎片实际体积 size³ 加权的中位粒径 > x50（故用等质量份额计数）', () => {
    const sizes = sampleSet(true)
    // 等质量表示下每片代表相等质量份额，但渲染碎片的实际体积仍 ∝ size³，
    // 若按实际体积加权，大碎块会主导通过率、把中位粒径推高（有限样本下无法
    // 让"实际体积加权通过率"等于 P(x)——那要求数量密度 ∝ p/x³，会坍缩到粉尘端）。
    // 此用例记录该语义，防止未来误用 size³ 加权对比。
    expect(volumeWeightedMedian(sizes)).toBeGreaterThan(X50 * 1.2)
  })

  it('同一种子可复现', () => {
    const a = sampleSet(true, 999)
    const b = sampleSet(true, 999)
    expect(a).toEqual(b)
  })
})
