import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { swebrecCdf, swebrecInverse, solveX80, cunninghamN } from '../kcoFormulas.js'

// 前后端一致性基线（实时互算契约）：读取仓库根目录 shared-consistency-baseline.json，
// 与后端 test_kco_formulas.py / test_kco_validator.py 共用同一契约文件。
// 任一端公式改动而不同步基线文件/对端实现，对应测试即失败，避免"共享 golden 常量"
// 下两端同步改坏而不被察觉。前端负责"计算值 == 基线"，后端负责"实现 == 基线"。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = path.resolve(
  __dirname,
  '../../../../../../../../shared-consistency-baseline.json'
)
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))

// swebrecCdf(0.5, 0.3, 2.0, 1.2, 2.0)
const EXPECTED_CDF = BASELINE.swebrecCdf['x=0.5, x50=0.3, xmax=2.0, n=1.2, b=2.0']
// solveX80(0.3, 2.0, 1.2, 2.0)
const EXPECTED_X80 = BASELINE.solveX80['x50=0.3, xmax=2.0, n=1.2, b=2.0']

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
    it('标准值：B=1.5, d=0.09, W_abs=0 → n≈2.124', () => {
      // 完整形式（Cunningham 1983/1987）：主导项 d 以 mm 计，d=0.09m → 90mm
      // n = (2.2 - 14*1.5/90) * (1 - 0) * sqrt(1+(2/1.5-1)/2) * (4.5/4.5)
      //   = 1.9667 * 1.0 * 1.0801 * 1.0 ≈ 2.124
      expect(cunninghamN(1.5, 0.09, 0, 2.0, 4.5, 4.5)).toBeCloseTo(2.124, 3)
    })

    it('B<=0 返回 1.0', () => {
      expect(cunninghamN(0, 0.09, 0.1, 2.0, 4.5, 4.5)).toBe(1.0)
    })

    it('结果 clamp 到 [0.5, 2.5]', () => {
      const v = cunninghamN(1.5, 0.0, 0.0, 2.0, 4.5, 4.5)
      expect(v).toBeGreaterThanOrEqual(0.5)
      expect(v).toBeLessThanOrEqual(2.5)
    })
  })
})
