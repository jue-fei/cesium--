import { describe, it, expect } from 'vitest'
import {
  buildDirectionVector,
  buildStressMetricOptions,
  computeMetricValue,
  computeValueRange,
  eigenvaluesSymmetric3
} from './stressComputation.js'

describe('stressComputation', () => {
  it('buildStressMetricOptions 在 overlay 模式下返回叠加项', () => {
    const list = buildStressMetricOptions(true)
    expect(list[0].value).toBe('von_mises')
    expect(list[1].value).toBe('overlay')
    expect(list.some(item => item.value === 'principal_1')).toBe(true)
  })

  it('computeMetricValue 计算 von_mises / j2 / 平均应力', () => {
    const s = { sxx: 10, syy: -2, szz: 4, sxy: 3, syz: -1, szx: 2 }
    const mean = computeMetricValue('mean_stress', s)
    const pressure = computeMetricValue('pressure', s)
    const j2 = computeMetricValue('j2', s)
    const vm = computeMetricValue('von_mises', s)
    expect(mean).toBeCloseTo(4)
    expect(pressure).toBeCloseTo(-4)
    expect(j2).toBeGreaterThan(0)
    expect(vm).toBeCloseTo(Math.sqrt(3 * j2))
  })

  it('computeMetricValue 计算方向应力与方向剪应力', () => {
    const s = { sxx: 12, syy: 8, szz: 5, sxy: 0, syz: 0, szx: 0 }
    const n = buildDirectionVector({ azimuthDeg: 90, dipDeg: 0 })
    const snn = computeMetricValue('snn', s, n)
    const tauN = computeMetricValue('tau_n', s, n)
    expect(snn).toBeCloseTo(12, 6)
    expect(tauN).toBeCloseTo(0, 6)
  })

  it('computeMetricValue 计算主应力与最大剪应力', () => {
    const s = { sxx: 5, syy: 2, szz: -1, sxy: 0, syz: 0, szx: 0 }
    const sigma1 = computeMetricValue('principal_1', s)
    const sigma3 = computeMetricValue('principal_3', s)
    const tauMax = computeMetricValue('tau_max', s)
    expect(sigma1).toBeGreaterThanOrEqual(sigma3)
    expect(tauMax).toBeCloseTo((sigma1 - sigma3) * 0.5, 6)
  })

  it('computeValueRange 支持 手动/分位数/对称零点', () => {
    const stats = { min: -10, max: 30, samples: [-10, -2, 1, 3, 8, 10, 12, 15, 19, 30] }
    expect(computeValueRange(stats, { mode: '手动', min: -5, max: 20 })).toEqual([-5, 20])
    const q = computeValueRange(stats, { mode: '分位数', qLow: 0.1, qHigh: 0.9 })
    expect(q[0]).toBeLessThan(q[1])
    const sym = computeValueRange(stats, { mode: '对称零点', qHigh: 0.8 })
    expect(sym[0]).toBeCloseTo(-sym[1], 6)
  })

  it('eigenvaluesSymmetric3 返回降序特征值', () => {
    const e = eigenvaluesSymmetric3({ m00: 3, m11: 2, m22: 1, m01: 0, m02: 0, m12: 0 })
    expect(e[0]).toBeGreaterThanOrEqual(e[1])
    expect(e[1]).toBeGreaterThanOrEqual(e[2])
    expect(e).toEqual([3, 2, 1])
  })
})
