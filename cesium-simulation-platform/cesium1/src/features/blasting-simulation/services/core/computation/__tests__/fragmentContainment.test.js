/**
 * 碎石隧道包含性回归测试（防"碎石漏到巷道外"复发）
 *
 * 背景：底板原为 0.5m 薄板，爆破初速下深穿透越过板厚一半后，求解器按
 * "最近面"把碎片推向板底；而 _containOutsideFragments 只判侧墙/拱顶越界，
 * u<0（底板下方）既不拉回也不剔除 → 碎片一路自由落体到巷道外
 * （实测 400 体中 58 块穿底、43 块冻结在巷道下方，即截图症状）。
 *
 * 本测试用生产默认马蹄形断面（W=18 / Hw=6 / R=9）与真实 fragmentSpecs
 * 跑完整抛掷-堆积过程，断言：
 *  - 任意时刻不存在低于底板、横向越界、拱顶越界的存活碎片
 *  - 全部碎片落地冻结（修复前 383/400，且在巷道外冻结 43 块）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'
import { RapierPhysicsEngine } from '../rapierPhysicsEngine.js'
import { makeRng } from '../../utils/rng.js'
import { generateFragmentSpecs } from '../../rendering/fragmentSpecGenerator.js'
import { getRockVariantVertices } from '../../rendering/rockGeometryFactory.js'

const W = 18
const HW = 6
const R = 9

// 手性：right × up = -forward（与 threeBlastingRenderer 生产端一致）
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
  halfWidth: W / 2,
  wallHeight: HW,
  archRadius: R,
  floorY: 0,
  faceOffset: 3,
  shape: 'horseshoe'
}

const FACE = {
  cx: 0,
  cy: 0,
  cz: -3,
  nx: 0,
  ny: 0,
  nz: -1,
  rx: 1,
  ry: 0,
  rz: 0,
  ux: 0,
  uy: 1,
  uz: 0,
  width: W,
  wallHeight: HW,
  archRadius: R,
  shape: 'horseshoe',
  floorY: 0
}

/** 判定越界维度（与引擎 _containOutsideFragments / 渲染 _outsideSection 同构） */
function violation(pos) {
  const t = pos.x
  const u = pos.y - BOUNDS.floorY
  const ceil = Math.abs(t) > R ? HW : HW + Math.sqrt(Math.max(0, R * R - t * t))
  return {
    below: u < -0.15,
    side: Math.abs(t) > BOUNDS.halfWidth + 0.15,
    top: u > ceil + 0.15
  }
}

describe('碎石隧道包含性回归', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  it('真实爆堆抛掷全程无碎片漏出断面（不含轴向出洞口）', () => {
    const out = generateFragmentSpecs({
      kco: { x50: 0.5, xmax: 1.5, b: 2.0, n: 1.2 },
      face: FACE,
      chargeKg: 320,
      targetCount: 400,
      countLimit: 600,
      randomSeed: 7
    })
    expect(out.specs.length).toBeGreaterThan(300)

    const eng = new RapierPhysicsEngine({ rng: makeRng(7) })
    eng.setGeometryVertices(getRockVariantVertices())
    eng.setTunnelBounds(BOUNDS)
    eng.init(out.specs, out.positions, out.velocities)
    eng.activateAll()

    let maxBelow = 0
    let maxSide = 0
    let maxTop = 0
    for (let s = 0; s < 400; s++) {
      eng.step(0.05)
      let below = 0
      let side = 0
      let top = 0
      for (const b of eng.getBodyStates()) {
        if (!b.alive) continue
        const v = violation({ x: b.posX, y: b.posY, z: b.posZ })
        if (v.below) below++
        if (v.side) side++
        if (v.top) top++
      }
      maxBelow = Math.max(maxBelow, below)
      maxSide = Math.max(maxSide, side)
      maxTop = Math.max(maxTop, top)
    }

    expect(maxBelow).toBe(0)
    expect(maxSide).toBe(0)
    expect(maxTop).toBe(0)
    // 全部落地冻结（轴向出洞口的碎片由引擎冻结并计入 LANDED）；
    // 冻结阈值随块径尺度相关，个别大块可能晚 1~2 帧冻结，留 1% 余量
    expect(eng.landedFragmentCount).toBeGreaterThanOrEqual(out.specs.length * 0.99)
  })
})
