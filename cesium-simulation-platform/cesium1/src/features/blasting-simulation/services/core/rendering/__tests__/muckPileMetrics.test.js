/**
 * 爆堆形态指标测试：用已知楔形堆验证堆高、安息角、抛距、落差、横向展布、粒度偏析。
 *
 * 合成场景：沿隧道轴向（s 从 -2 到 -10.2）高度从 8m 线性降到 1.1m 的楔形堆，
 * 理论安息角 = atan(6.9 / 8.2) ≈ 40°（分箱取值会略低，断言区间留出裕量）。
 * 坡脚块径 0.6m、堆顶 0.35m → 偏析比 ≈ 1.7。
 */
import { describe, it, expect } from 'vitest'
import { computeMuckPileMetrics, MUCK_PILE_REFERENCE } from '../muckPileMetrics.js'

// 世界坐标约定：pos = center + forward*s + right*t + up*h
// forward=(0,0,-1) → posZ = -s；right=(1,0,0) → posX = t；posY = h
const BOUNDS = {
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  rightX: 1,
  rightY: 0,
  rightZ: 0,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
  floorY: 0,
  wallHeight: 6,
  archRadius: 9,
  faceOffset: 3
}

function buildWedgePile({ rows = 24, perRow = 4 } = {}) {
  const states = []
  for (let i = 0; i < rows; i++) {
    const s = -2 - i * 0.357
    const h = 8 - i * 0.3
    // 偏析按**轴向位置**分区（近端 30% vs 远端 30%）：远端（i 大）用大块
    const size = i < rows * 0.7 ? 0.35 : 0.6
    for (let k = 0; k < perRow; k++) {
      const t = (k - (perRow - 1) / 2) * 1.2
      states.push({
        posX: t,
        posY: h,
        posZ: -s,
        velX: 0,
        velY: 0,
        velZ: 0,
        physSize: size,
        alive: true,
        landed: true
      })
    }
  }
  return states
}

describe('muckPileMetrics', () => {
  it('空输入返回 null 指标', () => {
    const m = computeMuckPileMetrics([], BOUNDS)
    expect(m.sampleCount).toBe(0)
    expect(m.pileHeight).toBeNull()
    expect(m.reposeAngleDeg).toBeNull()
  })

  it('楔形堆：堆高、安息角、抛距、落差、横向展布符合几何构造', () => {
    const m = computeMuckPileMetrics(buildWedgePile(), BOUNDS)
    expect(m.sampleCount).toBe(96)
    // 堆高 ≈ 8m（±0.5 分箱误差）
    expect(m.pileHeight).toBeGreaterThan(7.5)
    expect(m.pileHeight).toBeLessThan(8.5)
    // 安息角理论 40°，分箱取列最高点会略低估（±5°）
    expect(m.reposeAngleDeg).toBeGreaterThan(35)
    expect(m.reposeAngleDeg).toBeLessThan(45)
    // 抛距：峰顶近、坡脚远（faceOffset=3，最远 s≈-10.2 → 13.2m）
    expect(m.throwMax).toBeGreaterThan(12)
    expect(m.throwMax).toBeLessThan(14)
    expect(m.throwP95).toBeLessThanOrEqual(m.throwMax)
    // 落差 ≈ 6.5m
    expect(m.drop).toBeGreaterThan(5.5)
    expect(m.drop).toBeLessThan(7.5)
    // 横向展布 ≈ 3.6m（4 列 × 1.2m）
    expect(m.lateralSpread).toBeGreaterThan(3)
    expect(m.lateralSpread).toBeLessThan(4.2)
  })

  it('粒度偏析：远端块径 0.6 / 近端 0.35 → 比值约 1.7', () => {
    const m = computeMuckPileMetrics(buildWedgePile(), BOUNDS)
    expect(m.topD50).toBeCloseTo(0.35, 2)
    expect(m.toeD50).toBeCloseTo(0.6, 2)
    expect(m.segregationRatio).toBeCloseTo(1.71, 1)
    expect(m.withinReference.segregation).toBe(true)
  })

  it('文献对照标志：安息角落在 3°~45°（隧道摊铺口径）、堆高比 8/15=0.53 不在 0.05~0.35', () => {
    const m = computeMuckPileMetrics(buildWedgePile(), BOUNDS)
    expect(MUCK_PILE_REFERENCE.freeReposeAngleDeg).toEqual([35, 42])
    expect(MUCK_PILE_REFERENCE.reposeAngleDeg).toEqual([3, 45])
    expect(m.pileHeightRatio).toBeCloseTo(8 / 15, 1)
    expect(m.withinReference.reposeAngle).toBe(true)
    expect(m.withinReference.pileHeight).toBe(false)
  })

  it('飞行中的高速碎块不计入爆堆形态', () => {
    const states = buildWedgePile()
    states.push({
      posX: 0,
      posY: 20,
      posZ: 10,
      velX: 0,
      velY: -12,
      velZ: 0,
      physSize: 0.3,
      alive: true,
      landed: false
    })
    const m = computeMuckPileMetrics(states, BOUNDS)
    expect(m.sampleCount).toBe(96)
    expect(m.pileHeight).toBeLessThan(8.5)
  })
})
