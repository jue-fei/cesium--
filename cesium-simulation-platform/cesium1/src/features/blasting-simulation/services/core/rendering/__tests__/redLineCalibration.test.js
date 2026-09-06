import { describe, it, expect } from 'vitest'
import { generateFragmentSpecs } from '../fragmentSpecGenerator.js'

/**
 * 回归红线 — 速度/抛距校准默认关闭（gated by enableVelocityCalibration）
 *
 * 行为测试（非源码 grep）：直接调用 generateFragmentSpecs，
 * 断言「默认不校准、仅显式开启 enableVelocityCalibration 后才校准」的输出行为。
 */

function makeFace() {
  return {
    cx: 0,
    cy: 0,
    cz: 0,
    nx: 0,
    ny: 0,
    nz: -1, // 掌子面法线指向岩体
    rx: 1,
    ry: 0,
    rz: 0,
    ux: 0,
    uy: 1,
    uz: 0,
    width: 18,
    wallHeight: 6,
    archRadius: 4.5,
    shape: 'horseshoe',
    floorY: 0
  }
}

function makeKco() {
  return { x50: 0.5, xmax: 1.5, b: 2.0, n: 1.2 }
}

function baseOptions(extra = {}) {
  return {
    kco: makeKco(),
    face: makeFace(),
    chargeKg: 320,
    targetCount: 200,
    countLimit: 320,
    randomSeed: 42,
    ...extra
  }
}

describe('回归红线 — 速度/抛距校准默认关闭（gated by enableVelocityCalibration）', () => {
  it('默认（未开启 enableVelocityCalibration）时不校准：velocityCalibrated=false 且 scale=1', () => {
    const out = generateFragmentSpecs(baseOptions())
    expect(out.meta.velocityCalibrated).toBe(false)
    // 未校准意味着速度场保持原始物理输出，未被缩放
    expect(out.stats.velocityScaleApplied).toBe(1)
  })

  it('显式开启 enableVelocityCalibration=true 后才标记校准', () => {
    const out = generateFragmentSpecs(
      baseOptions({
        metrics: {
          enableVelocityCalibration: true,
          throwDistanceTargetAvg: 200,
          throwDistanceTargetMax: 300
        }
      })
    )
    expect(out.meta.velocityCalibrated).toBe(true)
  })

  it('校准真实作用于输出速度：同种子下开启校准后速度被缩放（scale ≠ 1）', () => {
    const baseline = generateFragmentSpecs(baseOptions())
    const calibrated = generateFragmentSpecs(
      baseOptions({
        metrics: {
          enableVelocityCalibration: true,
          throwDistanceTargetAvg: 200,
          throwDistanceTargetMax: 300
        }
      })
    )

    // 校准目标抛距远大于默认物理抛距，速度应被放大而非保持不变
    expect(calibrated.stats.velocityScaleApplied).toBeGreaterThan(1)
    expect(calibrated.meta.velocityCalibrated).toBe(true)

    // 开启校准后速度矢量确实改变（与未校准输出存在差异）
    const speedsOf = out =>
      out.velocities.map(v => Number(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z).toFixed(3)))
    const baseSpeeds = speedsOf(baseline)
    const calSpeeds = speedsOf(calibrated)
    expect(calSpeeds.length).toBe(baseSpeeds.length)
    const anyChanged = calSpeeds.some((s, i) => Math.abs(s - baseSpeeds[i]) > 1e-6)
    expect(anyChanged).toBe(true)
  })
})
