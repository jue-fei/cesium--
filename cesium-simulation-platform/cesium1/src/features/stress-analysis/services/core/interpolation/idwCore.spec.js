import { describe, expect, it } from 'vitest'
import { buildInterpolationSeriesStats, selectInterpolationPoints } from './idwCore.js'

describe('idwCore interpolation point selection', () => {
  it('统计序列峰值与均值时忽略非法值', () => {
    const stats = buildInterpolationSeriesStats([1, -3, Number.NaN, Infinity, 2])

    expect(stats).toEqual({
      peakAbs: 3,
      meanAbs: 2
    })
  })

  it('在保留热点的同时优先补齐空间分散点', () => {
    const localPoints = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 8, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 }
    ]
    const allSeries = [
      [1, 1],
      [18, 22],
      [3, 3],
      [2, 2]
    ]

    const result = selectInterpolationPoints(
      localPoints,
      allSeries,
      [20, 20, 20],
      2,
      { hotspotRatio: 0.5 },
      'idw'
    )

    expect(result.localPoints).toEqual([localPoints[1], localPoints[3]])
    expect(result.allSeries).toEqual([allSeries[1], allSeries[3]])
  })
})
