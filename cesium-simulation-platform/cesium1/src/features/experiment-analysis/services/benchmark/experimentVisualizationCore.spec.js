import { describe, expect, it } from 'vitest'
import { clampInt, computeHeatmapGlobalRange } from './experimentVisualizationCore.js'

describe('experimentVisualizationCore', () => {
  it('按整数边界夹断输入并在非法值时回退默认值', () => {
    expect(clampInt(7.9, 1, 10, 4)).toBe(7)
    expect(clampInt(99, 1, 10, 4)).toBe(10)
    expect(clampInt(undefined, 1, 10, 4)).toBe(4)
  })

  it('为热力图计算稳健显示范围，避免被少数异常值拉爆', () => {
    const normalValues = Array.from({ length: 100 }, (_, i) => 10 + i * 0.2)
    const snapshots = [
      {
        gridData: {
          values: new Float32Array([...normalValues, 5000])
        }
      }
    ]

    const range = computeHeatmapGlobalRange(snapshots)

    expect(range.rawMax).toBe(5000)
    expect(range.max).toBeLessThan(5000)
    expect(range.min).toBeLessThan(range.max)
    expect(range.max).toBeGreaterThan(range.min)
  })

  it('保留真实负值下界，避免把 Kriging 图整体推向红端', () => {
    const snapshots = [
      {
        gridData: {
          values: new Float32Array([-30, -20, -10, 0, 20, 40, 60, 80, 100, 300])
        }
      }
    ]

    const range = computeHeatmapGlobalRange(snapshots)

    expect(range.rawMin).toBe(-30)
    expect(range.min).toBeLessThan(0)
    expect(range.max).toBeGreaterThan(100)
  })

  it('在空快照时返回默认范围', () => {
    expect(computeHeatmapGlobalRange([])).toEqual({
      min: 0,
      max: 1,
      rawMin: 0,
      rawMax: 1
    })
  })
})
