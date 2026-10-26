/**
 * RapierPhysicsEngine 预计算性能优化回归测试
 *
 * 覆盖：
 * - packReplayKey 直读打包与 getBodyStates() 逐字段一致（pos/quat/flags）
 * - 落地门控（低速 3 帧 + 支撑检测 → 冻结）在睡眠体短路优化后仍生效
 * - 睡眠体回填：_applySettling 对 Rapier 睡眠的未冻结体直接补标 FLAG_LANDED
 *   （防御语义——dt=0.05 下自动睡眠端到端几乎不可触发，门控恒先于它生效）
 * - 性能冒烟：400 体 × 120 步（预计算的典型热相负载）耗时可接受
 *
 * 【场景设计说明】不要把落地门控测试改回"随机初速（水平 ±3 / 垂直 2-8 m/s）
 * + 高空散布"的场景：在该场景下 dt=0.05s 的大步长会导致深穿透接触，求解器的
 * 去穿透速度偏置每弹跳都向系统注入能量（实测 400 步内平均速度从 ~5.6 m/s
 * 增长到 >90 m/s），球体碰撞体永不进入低速带，任何落地门控都不会触发——
 * 这是该合成场景的固有行为（生产环境用凸包 + 真实掌子面初速分布，不存在此
 * 问题），并非门控或睡眠短路逻辑的缺陷。测试场景必须用确定性低能量落地。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import RAPIER from '@dimforge/rapier3d-compat'
import { RapierPhysicsEngine } from '../rapierPhysicsEngine.js'
import { makeRng } from '../../utils/rng.js'

const DT = 0.05
const N = 120

function rectangularBounds() {
  return {
    centerX: 0,
    centerY: 5,
    centerZ: 0,
    // 手性约定（与生产端 threeBlastingRenderer 一致）：right = forward×up，
    // 即 right×up = -forward，[right, up, -forward] 构成正规旋转矩阵。
    // 若传成 right=+X、forward=+Z 的左手组合，basisToQuat 会产出非法四元数，
    // Rapier 不归一化 → 隧道碰撞体退化（碎片穿地永不落地，见引擎内注释）。
    rightX: -1,
    rightY: 0,
    rightZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: 1,
    halfWidth: 5,
    wallHeight: 5,
    archRadius: 5,
    floorY: 0,
    shape: 'rectangular'
  }
}

/** 随机初速场景（仅用于字段一致性与性能冒烟，不用于落地门控） */
function makeSpecs(n, rng) {
  const specs = []
  const positions = []
  const velocities = []
  for (let i = 0; i < n; i++) {
    const physSize = 0.1 + rng() * 0.4
    specs.push({
      physSize,
      dispSize: physSize,
      density: 2600 + rng() * 300,
      restitution: 0.2,
      friction: 0.6,
      maxBounces: 3,
      variantIndex: 0,
      delayTime: i % 10 === 0 ? 0.2 : 0
    })
    positions.push({ x: (rng() - 0.5) * 8, y: 6 + rng() * 4, z: (rng() - 0.5) * 8 })
    velocities.push({ x: (rng() - 0.5) * 6, y: 2 + rng() * 6, z: (rng() - 0.5) * 6 })
  }
  return { specs, positions, velocities }
}

/**
 * 确定性落地场景：零初速、低空（1.5-2.0m）自由下落、低弹性（0.05）。
 * 落地冲击 ~5 m/s → 一次弱反弹（~0.4 m/s）→ 进入低速带 → 门控冻结。
 */
function makeDropSpecs(n, rng) {
  const specs = []
  const positions = []
  const velocities = []
  for (let i = 0; i < n; i++) {
    const physSize = 0.1 + rng() * 0.4
    specs.push({
      physSize,
      dispSize: physSize,
      density: 2600 + rng() * 300,
      restitution: 0.05,
      friction: 0.8,
      maxBounces: 3,
      variantIndex: 0,
      delayTime: 0
    })
    positions.push({ x: (rng() - 0.5) * 8, y: 1.5 + rng() * 0.5, z: (rng() - 0.5) * 8 })
    velocities.push({ x: 0, y: 0, z: 0 })
  }
  return { specs, positions, velocities }
}

describe('RapierPhysicsEngine - 预计算性能优化回归', () => {
  let engine

  beforeAll(async () => {
    await RAPIER.init()
    engine = new RapierPhysicsEngine({ rng: makeRng(7) })
    engine.setTunnelBounds(rectangularBounds())
    const { specs, positions, velocities } = makeSpecs(N, makeRng(42))
    engine.init(specs, positions, velocities)
    engine.activateAll()
  })

  it('packReplayKey 与 getBodyStates() 逐字段一致（pos/quat/flags）', () => {
    for (let s = 0; s < 12; s++) engine.step(DT)
    const buf = new Float32Array(N * 8)
    const written = engine.packReplayKey(buf, 8)
    expect(written).toBe(N)
    const states = engine.getBodyStates()
    for (let i = 0; i < N; i++) {
      const s0 = states[i]
      const o = i * 8
      expect(buf[o]).toBeCloseTo(s0.posX, 6)
      expect(buf[o + 1]).toBeCloseTo(s0.posY, 6)
      expect(buf[o + 2]).toBeCloseTo(s0.posZ, 6)
      expect(buf[o + 3]).toBeCloseTo(s0.quatX, 6)
      expect(buf[o + 4]).toBeCloseTo(s0.quatY, 6)
      expect(buf[o + 5]).toBeCloseTo(s0.quatZ, 6)
      expect(buf[o + 6]).toBeCloseTo(s0.quatW, 6)
      expect(buf[o + 7]).toBe(s0.flags)
    }
  })

  it('落地门控仍生效：确定性落地场景下全部碎片冻结，且冻结后保持稳定', () => {
    const eng = new RapierPhysicsEngine({ rng: makeRng(11) })
    eng.setTunnelBounds(rectangularBounds())
    const { specs, positions, velocities } = makeDropSpecs(N, makeRng(100))
    eng.init(specs, positions, velocities)
    eng.activateAll()

    let landed = 0
    for (let s = 0; s < 200; s++) {
      eng.step(DT)
      landed = eng.landedFragmentCount
      if (landed >= N * 0.99) break
    }
    expect(landed).toBeGreaterThanOrEqual(N * 0.99)

    // 冻结后继续推进 10 步（全部走睡眠短路路径），落地数不得回退
    for (let s = 0; s < 10; s++) eng.step(DT)
    expect(eng.landedFragmentCount).toBeGreaterThanOrEqual(N * 0.99)
  })

  it('睡眠体回填：_applySettling 对 Rapier 睡眠的未冻结体补标 LANDED', () => {
    const eng = new RapierPhysicsEngine({ rng: makeRng(13) })
    eng.setTunnelBounds(rectangularBounds())
    const { specs, positions, velocities } = makeDropSpecs(1, makeRng(300))
    eng.init(specs, positions, velocities)
    eng.activateAll()

    // 正常下落几步（尚未触地、未被门控冻结），然后手动 sleep 模拟
    // "Rapier 自动睡眠先于门控生效"的场景。注：dt=0.05 的接触抖动速度
    // 高于 Rapier 自动睡眠阈值（0.1 m/s），端到端自动睡眠几乎不可触发，
    // 门控（3 帧 ≈ 0.15s）恒快于自动睡眠（0.5s），此回填分支为防御语义，
    // 只能这样直接驱动验证。
    for (let s = 0; s < 5; s++) eng.step(DT)
    const entry = eng._fragmentBodies[0]
    expect(entry.flags & 0x02).toBe(0) // 尚未冻结
    entry.rigidBody.sleep()
    eng._applySettling()
    expect(eng.landedFragmentCount).toBe(1)
    expect(entry.flags & 0x02).not.toBe(0)
  })

  it('性能冒烟：400 体 × 120 步热相负载耗时可接受', () => {
    const bench = new RapierPhysicsEngine({ rng: makeRng(9) })
    bench.setTunnelBounds(rectangularBounds())
    const M = 400
    const { specs, positions, velocities } = makeSpecs(M, makeRng(1234))
    bench.init(specs, positions, velocities)
    bench.activateAll()
    const t0 = performance.now()
    for (let s = 0; s < 120; s++) bench.step(DT)
    const ms = performance.now() - t0
    // 预计算典型规模（3000 体 × ~500 步热相）按此比例外推应 < 60s；
    // 此处仅对 400 体 × 120 步设宽松上限（45s），异常退化（如意外 O(N²)）可检出
    // eslint-disable-next-line no-console
    console.log(`[bench] 400 bodies × 120 steps = ${ms.toFixed(0)}ms`)
    expect(ms).toBeLessThan(45000)
  })
})
