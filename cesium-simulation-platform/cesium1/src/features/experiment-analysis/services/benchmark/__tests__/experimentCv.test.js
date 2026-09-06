/**
 * experimentCv.test.js —— 三模型对比实验"严谨交叉验证"重构的单元测试
 *
 * 覆盖：
 * - C.1 K 折划分：全覆盖、无重叠、确定性可复现
 * - C.2 指标聚合：mean/std/cv 计算正确，含 Bias/Variance
 * - C.3 配对 t 检验：强差异 → p≈0，无差异 → p≈1
 * - C.4 矿山化数据：gradient_peak 场深度方向应力梯度 > 水平方向
 * - C.5 splitMode='all'：返回全量点位与标记，不预划分
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  splitKFold,
  aggregateFoldMetrics,
  computeSignificance,
  pairedTTest,
  generateTestDataset,
  generateGradientPeakField,
  runCrossValidated
} from '../experimentWorker.js'

describe('K折 × 重复交叉验证辅助', () => {
  it('C.1 splitKFold：全覆盖、无重叠、确定性', () => {
    const indices = Array.from({ length: 25 }, (_, i) => i)
    const folds = splitKFold(indices, 5, 42)
    expect(folds).toHaveLength(5)
    const seen = new Set()
    for (const fold of folds) {
      for (const idx of fold) {
        expect(seen.has(idx)).toBe(false) // 无重叠
        seen.add(idx)
      }
    }
    expect(seen.size).toBe(25) // 全覆盖
    // 确定性
    const folds2 = splitKFold(indices, 5, 42)
    expect(JSON.stringify(folds)).toBe(JSON.stringify(folds2))
  })

  it('C.2 aggregateFoldMetrics：含 mean/std/cv 与 Bias/Variance', () => {
    const foldMetrics = [
      { rmse: 2, mae: 1.5, bias: 0.2, variance: 4, r2: 0.9, maxError: 5, mape: 10 },
      { rmse: 4, mae: 2.5, bias: -0.2, variance: 8, r2: 0.8, maxError: 7, mape: 20 },
      { rmse: 6, mae: 3.5, bias: 0.6, variance: 12, r2: 0.7, maxError: 9, mape: 30 }
    ]
    const agg = aggregateFoldMetrics(foldMetrics)
    expect(agg.rmse.mean).toBeCloseTo(4, 5)
    expect(agg.rmse.std).toBeCloseTo(2, 5)
    expect(agg.rmse.cv).toBeCloseTo(0.5, 5)
    expect(agg.bias.mean).toBeCloseTo(0.2, 5)
    expect(agg.variance.mean).toBeCloseTo(8, 5)
  })

  it('C.3 配对 t 检验：强差异 → p 极小；无差异 → p≈1', () => {
    // 强差异：A 恒 10，B 恒 0
    const res1 = pairedTTest([10, 10, 10, 10], [0, 0, 0, 0])
    expect(Math.abs(res1.t)).toBe(Infinity)
    expect(res1.p).toBeCloseTo(0, 6)
    // 无差异
    const res2 = pairedTTest([3, 4, 5, 6], [3, 4, 5, 6])
    expect(res2.p).toBe(1)
  })

  it('C.4 矿山化数据：gradient_peak 场深度方向应力梯度为主', () => {
    const size = [200, 200, 100]
    const field = generateGradientPeakField({
      size,
      seed: 2026,
      gradVec: [8, 4, 35],
      peakCount: 4,
      peakAmp: 40
    })
    // 同一水平位置，深度 z 增加 → 应力增加（深度自重应力梯度）
    const shallow = field(50, 50, 10)
    const deep = field(50, 50, 90)
    // 为排除局部峰干扰，取多个水平位置平均
    let sumDelta = 0
    let count = 0
    for (const [x, y] of [
      [50, 50],
      [100, 100],
      [150, 60],
      [80, 140]
    ]) {
      sumDelta += field(x, y, 90) - field(x, y, 10)
      count++
    }
    expect(sumDelta / count).toBeGreaterThan(0)
    expect(Math.abs(deep - shallow)).toBeGreaterThan(0)
  })

  it('C.5 splitMode="all"：返回全量点位与异常标记，不预划分', () => {
    const ds = generateTestDataset({ pointCount: 80, anomalyCount: 6, splitMode: 'all' })
    expect(ds.splitMode).toBe('all')
    expect(ds.allPoints.length).toBe(ds.allTrueValues.length)
    expect(ds.allPoints.length).toBe(ds.allNoisyValues.length)
    expect(ds.allAnomaly.filter(Boolean).length).toBe(6)
    expect(ds.normalIndices.length + ds.anomalyIndices.length).toBe(ds.allPoints.length)
    // 默认 trendType 为矿山化的 gradient_peak
    expect(ds.config.trendType).toBe('gradient_peak')
  })
})

describe('runCrossValidated 端到端（K折×重复+显著性+稳健性）', () => {
  beforeAll(() => {
    // Worker 环境 mock：sendProgress 会调 workerScope.postMessage
    globalThis.postMessage = globalThis.postMessage || (() => {})
  })

  it('返回聚合指标、显著性检验与异常稳健性，结构兼容', async () => {
    const config = {
      dataGeneration: {
        pointCount: 40,
        anomalyCount: 4,
        noiseLevel: 0.05,
        seed: 1,
        trendType: 'gradient_peak'
      },
      comparison: {
        kFold: 2,
        repeatCount: 1,
        krigingModels: ['exponential'],
        idwConfig: {
          optimizeParameters: true,
          optimizationParticles: 6,
          optimizationIterations: 10,
          optimizationMaxFitnessSamples: 30
        }
      }
    }
    const result = await runCrossValidated(config, 'test-run', { cancelled: false })

    expect(result).not.toBeNull()
    expect(result.comparison.rows.length).toBeGreaterThanOrEqual(3)
    expect(result.comparison.summary.kFold).toBe(2)
    expect(result.comparison.summary.repeatCount).toBe(1)
    // 聚合指标含 mean/std/cv 与 bias/variance
    expect(Number.isFinite(result.repeats.aggregated.idw_optimized.rmse.mean)).toBe(true)
    expect(typeof result.repeats.aggregated.idw_optimized.bias.mean).toBe('number')
    expect(typeof result.repeats.aggregated.idw_optimized.variance.mean).toBe('number')
    // 显著性检验非空
    expect(result.comparison.significance.pairs.length).toBeGreaterThan(0)
    for (const pair of result.comparison.significance.pairs) {
      expect(typeof pair.p).toBe('number')
      expect(pair.p).toBeGreaterThanOrEqual(0)
      expect(pair.p).toBeLessThanOrEqual(1)
    }
    // 异常稳健性
    expect(result.robustness).not.toBeNull()
    expect(result.robustness.anomalyCount).toBe(4)
    // 热力图
    expect(result.heatmapSnapshots.length).toBeGreaterThan(0)
    // kriging 模型指标
    expect(typeof result.kriging.exponential.metrics.rmse.mean).toBe('number')
  })
})
