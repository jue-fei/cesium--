/**
 * 碎片初始体积定位回归测试（防"初始碎石不在待爆岩体里 / 爆堆跑到空腔外"复发）
 *
 * 背景（修复前实测，场景局部坐标，掌子面 z=3、进尺 2.55m）：
 *  - 岩体实心区 z ∈ [3, 23]，待爆棱柱 z ∈ [3, 5.55]，已开挖隧道 z < 3；
 *  - 碎片初始 z ∈ [-0.96, 2.44] —— 整片碎块被摆在掌子面**前方**的已开挖隧道里，
 *    与待爆岩体整体错开一个进尺；爆破后爆堆又整体前移，空腔始终是空的；
 *  - 物理层"掌子面封堵板"也放在掌子面处（碎块的自由面），既堵住抛出通道，
 *    又让分离冲量把碎块射进岩体深处（实测 20% 碎块落在 z=8~21，被岩体遮挡）。
 *
 * 本测试锁定两条不变量：
 *  1. 初始碎片中心全部落在待爆棱柱 [faceOffset, faceOffset+进尺] 附近；
 *  2. 堆积完成后没有碎块越过新掌子面（进尺末端）进入完整岩体。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'
import { generateFragmentSpecs } from '../fragmentSpecGenerator.js'
import { RapierPhysicsEngine } from '../../computation/rapierPhysicsEngine.js'
import { makeRng } from '../../utils/rng.js'
import { getRockVariantVertices } from '../rockGeometryFactory.js'

const FACE_OFFSET = 3
const ADVANCE = 2.55
const NEW_FACE = FACE_OFFSET + ADVANCE

const SECTION = { width: 18, wallHeight: 6, archRadius: 9, shape: 'horseshoe' }
// 手性：right = dir × up、forward = up × right（right × up = -forward），与生产端一致
const BOUNDS = {
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  rightX: -1,
  rightY: 0,
  rightZ: 0,
  forwardX: 0,
  forwardY: 0,
  forwardZ: 1,
  halfWidth: SECTION.width / 2,
  wallHeight: SECTION.wallHeight,
  archRadius: SECTION.archRadius,
  floorY: 0,
  faceOffset: FACE_OFFSET,
  faceDepth: ADVANCE,
  shape: SECTION.shape
}
const FACE = {
  cx: 0,
  cy: 0,
  cz: FACE_OFFSET,
  nx: 0,
  ny: 0,
  nz: 1,
  rx: -1,
  ry: 0,
  rz: 0,
  ux: 0,
  uy: 1,
  uz: 0,
  width: SECTION.width,
  wallHeight: SECTION.wallHeight,
  archRadius: SECTION.archRadius,
  shape: SECTION.shape,
  floorY: 0
}

function gen(count, chargeKg = 122.2) {
  return generateFragmentSpecs({
    kco: { x50: 0.3, xmax: 1.2, b: 2.0, n: 1.0 },
    face: FACE,
    chargeKg,
    targetCount: count,
    countLimit: count,
    metrics: { advanceLength: ADVANCE, volumeRoundM3: 600 },
    randomSeed: 5
  })
}

describe('碎片初始体积定位（待爆棱柱内）', () => {
  beforeAll(async () => {
    await RAPIER.init()
  })

  it('初始碎片中心落在掌子面后的待爆棱柱内（不得整体落到已开挖侧）', () => {
    const out = gen(800)
    const zs = out.positions.map(p => p.z).sort((a, b) => a - b)
    const median = zs[Math.floor(zs.length / 2)]
    // 全部在待爆棱柱内（允许首层贴面微凸 ≤0.6m、末层留 0.25m 余量）
    expect(zs[0]).toBeGreaterThan(FACE_OFFSET - 0.6)
    expect(zs[zs.length - 1]).toBeLessThanOrEqual(NEW_FACE)
    // 中位数必须明显进入岩体（旧实现中位数为负值 = 在隧道里）
    expect(median).toBeGreaterThan(FACE_OFFSET)
  })

  it('默认抛掷参数下碎块能被抛出进尺空腔（单耗 0.69kg/m³ 现场量级）', () => {
    // chargeKg 412 / 600m³ ≈ 0.69kg/m³（隧道爆破常见单耗，与 UI 默认 η=0.02 配套）
    const out = gen(400, 412)
    const vm = out.velocities.map(v => Math.hypot(v.x, v.y, v.z))
    const vMean = vm.reduce((a, b) => a + b, 0) / vm.length
    // 初速下界：低于 4m/s 时抛距不足进尺，碎块会堵在空腔里（旧默认 0.42 收缩 + η=0.005
    // 时实测仅 ~1m/s，观感"没有抛掷出去"）
    expect(vMean).toBeGreaterThan(4)

    const eng = new RapierPhysicsEngine({ rng: makeRng(11) })
    eng.setGeometryVertices(getRockVariantVertices())
    eng.setTunnelBounds(BOUNDS)
    eng.init(out.specs, out.positions, out.velocities)
    eng.activateAll()
    for (let s = 0; s < 300; s++) eng.step(0.05)
    const states = eng.getBodyStates().filter(b => b.alive)
    const inCavity = states.filter(b => b.posZ > FACE_OFFSET).length
    // 空腔内残留 ≤20%：爆堆主体已被抛出到掌子面前方
    expect(inCavity / states.length).toBeLessThan(0.2)
  })

  it('堆积后无碎块越过新掌子面进入完整岩体', () => {
    const out = gen(400)
    const eng = new RapierPhysicsEngine({ rng: makeRng(5) })
    eng.setGeometryVertices(getRockVariantVertices())
    eng.setTunnelBounds(BOUNDS)
    eng.init(out.specs, out.positions, out.velocities)
    eng.activateAll()
    for (let s = 0; s < 300; s++) eng.step(0.05)

    const states = eng.getBodyStates()
    const escaped = states.filter(b => b.alive && b.posZ > NEW_FACE + 0.2)
    expect(escaped.length).toBe(0)
    // 抛掷仍正常：多数碎块确实被抛出掌子面进入隧道
    const thrown = states.filter(b => b.alive && b.posZ < FACE_OFFSET).length
    expect(thrown).toBeGreaterThan(states.length * 0.5)
    expect(eng.landedFragmentCount).toBeGreaterThanOrEqual(states.length * 0.99)
  })
})
