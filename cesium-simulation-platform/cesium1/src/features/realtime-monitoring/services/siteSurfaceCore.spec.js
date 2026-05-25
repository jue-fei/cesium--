import { describe, expect, it } from 'vitest'
import {
  buildSurfacePoolCandidates,
  buildSurfaceSearchCandidates,
  findNearestSurfacePoint,
  isDuplicateSurfacePoint,
  resolveInitialPlacementRadius,
  resolveScaledSiteRadius,
  selectResolvedSurfacePool
} from './siteSurfaceCore.js'

describe('siteSurfaceCore', () => {
  it('生成以中心点开头的表面候选点集合', () => {
    const candidates = buildSurfacePoolCandidates(12, 8)

    expect(candidates[0]).toEqual([0, 0])
    expect(candidates.length).toBe(1 + 2 * 8)
  })

  it('判定重复表面点并选择最近表面点', () => {
    const points = [
      { eastMeters: 0, northMeters: 0, height: 100 },
      { eastMeters: 10, northMeters: 10, height: 90 }
    ]

    expect(isDuplicateSurfacePoint(points, 0.9, 0.9)).toBe(true)
    expect(isDuplicateSurfacePoint(points, 5, 5)).toBe(false)
    expect(findNearestSurfacePoint(points, 8, 9)).toEqual(points[1])
  })

  it('优先保留顶部表面点，不足时回退到全部点', () => {
    const manyTopPoints = [{ height: 101 }, { height: 100 }, { height: 99 }, { height: 98 }]
    const fallbackPoints = [{ height: 101 }, { height: 80 }]

    expect(selectResolvedSurfacePool(manyTopPoints, 3, 3)).toEqual(manyTopPoints)
    expect(selectResolvedSurfacePool(fallbackPoints, 3, 3)).toEqual([
      { height: 101 },
      { height: 80 }
    ])
  })

  it('生成表面搜索偏移候选', () => {
    expect(buildSurfaceSearchCandidates(5, 6, 2)).toEqual([
      [7, 6],
      [3, 6],
      [5, 8],
      [5, 4],
      [7, 8],
      [7, 4],
      [3, 8],
      [3, 4]
    ])
  })

  it('计算采场半径和初始落点半径', () => {
    expect(resolveScaledSiteRadius(100, 2, 0.05, 18, 65)).toBe(18)
    expect(resolveScaledSiteRadius(1000, 2, 0.05, 18, 65)).toBe(65)
    expect(resolveInitialPlacementRadius(30, 0.2, 4, 12)).toBe(6)
    expect(resolveInitialPlacementRadius(100, 0.2, 4, 12)).toBe(12)
  })
})
