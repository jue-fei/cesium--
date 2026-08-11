import { describe, it, expect } from 'vitest'
import {
  swebrecCdf,
  swebrecInverse,
  solveX80,
  cunninghamN
} from '../kcoFormulas.js'

// 前后端对齐基准值（运行一次记录，作为后端测试的对标基准）
// swebrecCdf(0.5, 0.3, 2.0, 1.2, 2.0)
export const EXPECTED_CDF = 0.8066900763516753
// solveX80(0.3, 2.0, 1.2, 2.0)
export const EXPECTED_X80 = 0.4944131281749693

describe('kcoFormulas', () => {
  describe('swebrecCdf', () => {
    it('返回值在合理范围 [0,1] 且与基准一致', () => {
      const v = swebrecCdf(0.5, 0.3, 2.0, 1.2, 2.0)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      expect(v).toBeCloseTo(EXPECTED_CDF, 9)
    })

    it('边界：x<=0 返回 0，x>=xmax 返回 1', () => {
      expect(swebrecCdf(0, 0.3, 2.0, 1.2, 2.0)).toBe(0)
      expect(swebrecCdf(-1, 0.3, 2.0, 1.2, 2.0)).toBe(0)
      expect(swebrecCdf(2.0, 0.3, 2.0, 1.2, 2.0)).toBe(1)
      expect(swebrecCdf(2.5, 0.3, 2.0, 1.2, 2.0)).toBe(1)
    })

    it('非法参数返回 NaN', () => {
      expect(Number.isNaN(swebrecCdf(0.5, 0, 2.0, 1.2, 2.0))).toBe(true)
      expect(Number.isNaN(swebrecCdf(0.5, 2.0, 2.0, 1.2, 2.0))).toBe(true)
    })
  })

  describe('swebrecInverse / solveX80', () => {
    it('solveX80 约等于基准值（容差 1e-4）', () => {
      const x80 = solveX80(0.3, 2.0, 1.2, 2.0)
      expect(x80).toBeCloseTo(EXPECTED_X80, 4)
    })

    it('反解一致性：swebrecCdf(swebrecInverse(u)) ≈ u', () => {
      const u = 0.35
      const x = swebrecInverse(u, 0.3, 2.0, 1.2, 2.0)
      expect(swebrecCdf(x, 0.3, 2.0, 1.2, 2.0)).toBeCloseTo(u, 6)
    })
  })

  describe('cunninghamN', () => {
    it('标准值：B=1.5, d=0.09, W_abs=0 → 0.68', () => {
      // (2.2 - 14*0.09/1.5) * (1 - 0) / 2 = 1.36 / 2 = 0.68
      expect(cunninghamN(1.5, 0.09, 0)).toBeCloseTo(0.68, 6)
    })

    it('B<=0 返回 1.0', () => {
      expect(cunninghamN(0, 0.09, 0.1)).toBe(1.0)
    })

    it('结果 clamp 到 [0.5, 2.5]', () => {
      const v = cunninghamN(1.5, 0.0, 0.0)
      expect(v).toBeGreaterThanOrEqual(0.5)
      expect(v).toBeLessThanOrEqual(2.5)
    })
  })
})
