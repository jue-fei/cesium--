/**
 * 碎石落地稳定性回归测试（防"落地后一直跳动 / 周期弹起 / 爆堆体积回缩"复发）
 *
 * 背景（修复前实测，400 块真实规格、40s 演化）：
 *  - 已冻结（仅 sleep）的碎块被邻居接触反复唤醒，休眠期间积压的穿透修正
 *    在唤醒步一次性释放 → 分离冲量把块弹起：竖向峰值 13.7 m/s、单块弹起 8.2m；
 *  - 每次弹起后落回都会被压进更密接触 → 爆堆逐次收紧（"体积不自然减小"）；
 *  - 尾段仍有数十块持续醒着，堆体永不静止（关键帧回放里就是"一直跳动"）。
 *
 * 修复：停稳判定通过后把刚体转为 Fixed（静态）——不可被推动/唤醒，同时仍作为
 * 静态碰撞体支撑后续落石。本测试断言：
 *  1) 起爆前（未激活）不会被误判为"已停稳"而静态化；
 *  2) 抛掷仍正常（平均位移、抛距不为 0）；
 *  3) 落地后位置不再变化（关键帧数据与位置双重校验），无 landed→未 landed 回退；
 *  4) 全部碎片最终静态化，且循环重播 resetToInitial 能恢复动态重新抛掷。
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

const FLOATS = 8

function build() {
  const out = generateFragmentSpecs({
    kco: { x50: 0.5, xmax: 1.5, b: 2.0, n: 1.2 },
    face: FACE,
    chargeKg: 320,
    targetCount: 400,
    countLimit: 600,
    randomSeed: 7
  })
  const eng = new RapierPhysicsEngine({ rng: makeRng(7) })
  eng.setGeometryVertices(getRockVariantVertices())
  eng.setTunnelBounds(BOUNDS)
  eng.init(out.specs, out.positions, out.velocities)
  return { eng, out }
}

describe('碎石落地稳定性（停稳即静态化）', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  it('起爆前不会被误判停稳（岩体不得在 t=0 静态化）', () => {
    const { eng } = build()
    // 未 activateAll：全部刚体处于 disabled（待激活）状态
    for (let i = 0; i < 10; i++) eng.step(0.05)
    expect(eng.landedFragmentCount).toBe(0)
    expect(eng.getBodyStates().every(b => b.landed === false)).toBe(true)
  })

  it('落地后位置不再变化，且全部停稳', () => {
    const { eng, out } = build()
    const n = out.specs.length
    eng.activateAll()

    const firstLandedY = new Float32Array(n).fill(NaN)
    const latched = new Float32Array(n * 7).fill(NaN) // 落地瞬间的关键帧变换
    const wasLanded = new Uint8Array(n)
    let unfreezeEvents = 0
    let maxRiseAfterLand = 0
    let keyDriftAfterLand = 0
    const key = new Float32Array(n * FLOATS)

    for (let s = 0; s < 400; s++) {
      eng.step(0.05)
      eng.packReplayKey(key, FLOATS)
      const states = eng.getBodyStates()
      for (let i = 0; i < states.length; i++) {
        const b = states[i]
        if (!b.alive) continue
        const o = i * 7
        if (b.landed) {
          if (Number.isNaN(firstLandedY[i])) {
            firstLandedY[i] = b.posY
            for (let k = 0; k < 7; k++) latched[o + k] = key[i * FLOATS + k]
          } else {
            // 落地后仍"上升"= 弹跳
            const rise = b.posY - firstLandedY[i]
            if (rise > maxRiseAfterLand) maxRiseAfterLand = rise
            // 关键帧（渲染数据源）与落地瞬间的偏差
            const ko = i * FLOATS
            const dp = Math.hypot(
              key[ko] - latched[o],
              key[ko + 1] - latched[o + 1],
              key[ko + 2] - latched[o + 2]
            )
            if (dp > keyDriftAfterLand) keyDriftAfterLand = dp
          }
          wasLanded[i] = 1
        } else if (wasLanded[i]) {
          unfreezeEvents++
          wasLanded[i] = 0
        }
      }
    }

    // 抛掷仍正常（不是"一开始就冻住"）
    const states = eng.getBodyStates()
    let sumDisp = 0
    for (let i = 0; i < n; i++) {
      sumDisp += Math.hypot(
        states[i].posX - out.positions[i].x,
        states[i].posY - out.positions[i].y,
        states[i].posZ - out.positions[i].z
      )
    }
    expect(sumDisp / n).toBeGreaterThan(5)

    // 零回弹：无解冻事件、落地后不上升、渲染关键帧不漂移
    expect(unfreezeEvents).toBe(0)
    expect(maxRiseAfterLand).toBeLessThan(0.02)
    expect(keyDriftAfterLand).toBeLessThan(0.02)
    // 全部静态化（轴向飞出洞口的块也计入 LANDED）
    expect(eng.landedFragmentCount).toBeGreaterThanOrEqual(n * 0.99)
  })

  it('循环重播 resetToInitial 后恢复动态并重新堆积', () => {
    const { eng, out } = build()
    const n = out.specs.length
    eng.activateAll()
    for (let s = 0; s < 400; s++) eng.step(0.05)
    expect(eng.landedFragmentCount).toBeGreaterThanOrEqual(n * 0.99)

    // 回到 t=0（复用刚体）
    eng.resetToInitial(out.positions, out.velocities)
    expect(eng.getBodyStates().every(b => b.landed === false)).toBe(true)
    eng.activateAll()
    for (let s = 0; s < 400; s++) eng.step(0.05)

    const states = eng.getBodyStates()
    let sumDisp = 0
    for (let i = 0; i < n; i++) {
      sumDisp += Math.hypot(
        states[i].posX - out.positions[i].x,
        states[i].posY - out.positions[i].y,
        states[i].posZ - out.positions[i].z
      )
    }
    expect(sumDisp / n).toBeGreaterThan(5)
    expect(eng.landedFragmentCount).toBeGreaterThanOrEqual(n * 0.99)
  })
})
