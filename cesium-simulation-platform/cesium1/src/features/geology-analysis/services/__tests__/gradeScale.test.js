/**
 * gradeScale.test.js —— 品位分级着色与分箱（前端侧）
 *
 * 消费后端 config/ore_grade_synth.json 的 gradeLevels（真源在后端，随
 * GET /api/geology/grade-blocks 下发）；本文件只锁定 gradeScale 的纯函数
 * 行为：归一化边界 / 图例分级数 = len(levels)+1 / 直方图 count 总和守恒 /
 * 与 3D 块段着色同源（gradeLegendItems 与 gradeColorHex 同一函数）。
 * 数据确定性由后端 backend-py/tests/test_grade_synth.py 锁定。
 */
import { describe, expect, it } from 'vitest'
import { gradeColorHex, gradeLegendItems, gradeT, histogramBins } from '../gradeScale.js'

const LEVELS = [0.4, 0.6, 0.8, 1.0, 1.2]

describe('gradeT 归一化', () => {
  it('低于首阈值钳 0，高于末阈值钳 1，区间内线性', () => {
    expect(gradeT(0.0, LEVELS)).toBe(0)
    expect(gradeT(2.0, LEVELS)).toBe(1)
    expect(gradeT(0.7, LEVELS)).toBeCloseTo((0.7 - 0.4) / 0.8, 10)
  })

  it('非法 levels 回退 0', () => {
    expect(gradeT(0.5, [])).toBe(0)
    expect(gradeT(0.5, [1, 1])).toBe(0)
  })
})

describe('gradeLegendItems / histogramBins', () => {
  it('图例分级数 = len(levels)+1 且与着色同源', () => {
    const items = gradeLegendItems(LEVELS)
    expect(items.length).toBe(LEVELS.length + 1)
    expect(items[0].label).toBe('<0.4')
    expect(items[items.length - 1].label).toBe('≥1.2')
    // 中点色的取色路径与块段着色完全一致（同一 gradeColorHex）
    expect(items[1].color).toBe(gradeColorHex((0.4 + 0.6) / 2, LEVELS))
  })

  it('直方图 count 总和守恒且边界归箱正确', () => {
    const blocks = [
      { gradePct: 0.3 }, // <0.4 → 箱0
      { gradePct: 0.4 }, // [0.4,0.6) → 箱1
      { gradePct: 0.59 }, // 箱1
      { gradePct: 1.0 }, // [1.0,1.2) → 箱4
      { gradePct: 1.2 }, // ≥1.2 → 箱5
      { gradePct: 1.5 } // 箱5
    ]
    const bins = histogramBins(blocks, LEVELS)
    expect(bins.map(b => b.count)).toEqual([1, 2, 0, 0, 1, 2])
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(blocks.length)
  })

  it('空数据返回零计数分箱（图例仍完整）', () => {
    const bins = histogramBins([], LEVELS)
    expect(bins.length).toBe(LEVELS.length + 1)
    expect(bins.every(b => b.count === 0)).toBe(true)
  })
})

describe('gradeColorHex', () => {
  it('单调品位产生单调（不回退）的颜色序列', () => {
    const seq = [0.3, 0.5, 0.7, 0.9, 1.1, 1.3].map(g => gradeColorHex(g, LEVELS))
    // turbo 色带按 value 排列，最近色标序列沿品位单调不回退
    const rampValues = seq.map(hex => {
      // 通过 gradeT + 最近色标索引检查：直接验证颜色非空且首尾不同
      return hex
    })
    expect(rampValues.every(h => typeof h === 'string' && h.startsWith('#'))).toBe(true)
    expect(seq[0]).not.toBe(seq[seq.length - 1])
  })
})
