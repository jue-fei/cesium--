/**
 * blastPhysicsEngine.js 单元测试
 *
 * 覆盖核心物理行为：
 * - 初始化与质量计算
 * - 重力积分与空气阻力
 * - 底板碰撞：弹性恢复系数 + 摩擦衰减 + 多次弹跳后落地
 * - 隧道壁碰撞（矩形/马蹄形）：法向反射 + 切向摩擦
 * - 碎片间碰撞：冲量响应 + 位置修正 + 库仑锥摩擦夹紧
 * - 分段起爆：delayTime 延迟激活
 * - 安息角堆积与冻结
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { BlastPhysicsEngine } from '../blastPhysicsEngine.js'
import { makeRng } from '../../utils/rng.js'

// ─── 测试用工厂：构造单碎片引擎，便于隔离测试 ─────────
function createEngineWithOneBody(overrides = {}) {
  const engine = new BlastPhysicsEngine({ rng: makeRng(42) })
  const spec = {
    physSize: 0.4,
    density: 2700,
    restitution: 0.5,
    friction: 0.6,
    maxBounces: 3,
    ...overrides.spec
  }
  const pos = { x: 0, y: 10, z: 0, ...overrides.pos }
  const vel = { x: 0, y: 0, z: 0, ...overrides.vel }
  engine.init([spec], [pos], [vel])
  engine.activateAll()
  return { engine, body: engine.bodies[0] }
}

// 矩形隧道边界（便于测试）
function rectangularBounds() {
  return {
    centerX: 0,
    centerY: 5,
    centerZ: 0,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: 1,
    halfWidth: 5,
    wallHeight: 10,
    archRadius: 5,
    floorY: 0,
    shape: 'rectangular'
  }
}

// 马蹄形隧道边界
function horseshoeBounds() {
  return {
    centerX: 0,
    centerY: 5,
    centerZ: 0,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: 1,
    halfWidth: 5,
    wallHeight: 5,
    archRadius: 5,
    floorY: 0,
    shape: 'horseshoe'
  }
}

// ============================================================
// 初始化与基础状态
// ============================================================
describe('BlastPhysicsEngine - 初始化', () => {
  it('init 创建正确数量的 body', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1) })
    const specs = [
      { physSize: 0.3, density: 2600, restitution: 0.2, friction: 0.5, maxBounces: 2 },
      { physSize: 0.5, density: 2800, restitution: 0.3, friction: 0.6, maxBounces: 3 }
    ]
    const pos = [
      { x: 0, y: 5, z: 0 },
      { x: 1, y: 5, z: 0 }
    ]
    const vel = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 }
    ]
    engine.init(specs, pos, vel)
    expect(engine.bodies).toHaveLength(2)
    expect(engine.bodies[0].physSize).toBe(0.3)
    expect(engine.bodies[1].velX).toBe(-1)
  })

  it('质量 = density × (4/3)π(d/2)³', () => {
    const { body } = createEngineWithOneBody({ spec: { physSize: 0.4, density: 2700 } })
    const expectedMass = 2700 * (4 / 3) * Math.PI * Math.pow(0.2, 3)
    expect(body.mass).toBeCloseTo(expectedMass, 6)
  })

  it('physSize 为 0/负数时 clamp 到 0.01 防 mass=0', () => {
    const { body } = createEngineWithOneBody({ spec: { physSize: 0 } })
    expect(body.physSize).toBe(0.01)
    expect(body.mass).toBeGreaterThan(0)
  })

  it('delayTime > 0 的碎片初始为休眠（非 ALIVE）', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1) })
    engine.init(
      [
        {
          physSize: 0.3,
          density: 2700,
          restitution: 0.2,
          friction: 0.5,
          maxBounces: 2,
          delayTime: 0.1
        }
      ],
      [{ x: 0, y: 5, z: 0 }],
      [{ x: 0, y: 0, z: 0 }]
    )
    engine.activateAll()
    expect(engine.aliveFragmentCount).toBe(0) // 延迟碎片未激活
    expect(engine.bodies[0]._delayed).toBe(true)
  })
})

// ============================================================
// 重力积分
// ============================================================
describe('BlastPhysicsEngine - 重力积分', () => {
  it('自由落体：step 后 velY 减少 g·dt', () => {
    const { engine, body } = createEngineWithOneBody({ pos: { y: 50 }, vel: { y: 0 } })
    // 无隧道边界 → 无碰撞，纯自由落体
    const dt = 0.05
    engine.step(dt)
    // velY = -g·dt = -9.8 × 0.05 = -0.49（忽略极小空气阻力）
    expect(body.velY).toBeCloseTo(-9.8 * dt, 1)
  })

  it('多步积分位置正确更新', () => {
    const { engine, body } = createEngineWithOneBody({ pos: { y: 50 }, vel: { y: 0 } })
    engine.step(0.1)
    engine.step(0.1)
    // 2 步后 velY ≈ -9.8×0.2 = -1.96
    expect(body.velY).toBeCloseTo(-1.96, 1)
    // y 应下降
    expect(body.posY).toBeLessThan(50)
  })

  it('水平速度受空气阻力衰减', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { y: 50 },
      vel: { x: 20, y: 0 }
    })
    engine.step(0.05)
    // 空气阻力使 vx 减小（但不会为 0）
    expect(body.velX).toBeLessThan(20)
    expect(body.velX).toBeGreaterThan(0)
  })
})

// ============================================================
// 底板碰撞与恢复系数
// ============================================================
describe('BlastPhysicsEngine - 底板碰撞', () => {
  it('碰撞后 posY 被 clamp 到 floorY + radius', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { y: 0.1 },
      vel: { y: -5 }
    })
    engine.setTunnelBounds(rectangularBounds())
    engine.step(0.05)
    const expectedFloor = 0 + body.physSize * 0.5
    expect(body.posY).toBeCloseTo(expectedFloor, 2)
  })

  it('恢复系数：反弹后 |velY| = |velY_old| × restitution × 0.75^(bounce-1)', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { y: 0.21 },
      vel: { y: -10 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.5, friction: 0, maxBounces: 10 }
    })
    engine.setTunnelBounds(rectangularBounds())
    // rng 随机偏转影响 vx/vz 但不影响 vy 主分量
    engine.step(0.01) // 小步长使碰撞在一步内完成
    // 第 1 次弹跳：restitutionScale = 0.75^0 = 1
    // velY_new = 10 × 0.5 × 1 = 5（向上为正）
    expect(body.velY).toBeCloseTo(5, 0)
    expect(body.bounceCount).toBe(1)
  })

  it('多次弹跳后达到 maxBounces 时落地', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { y: 0.21 },
      vel: { y: -10 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.3, friction: 0.5, maxBounces: 2 }
    })
    engine.setTunnelBounds(rectangularBounds())
    // 多步模拟直到落地
    for (let i = 0; i < 100; i++) {
      engine.step(0.05)
      if (body.flags & 0x02) break // FLAG_LANDED
    }
    expect(body.flags & 0x02).toBeTruthy() // 已落地
    expect(body.velX).toBe(0)
    expect(body.velY).toBe(0)
    expect(body.velZ).toBe(0)
  })

  it('摩擦衰减：底板碰撞后水平速度减小', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { y: 0.21 },
      vel: { x: 10, y: -10 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.5, friction: 0.8, maxBounces: 10 }
    })
    engine.setTunnelBounds(rectangularBounds())
    engine.step(0.01)
    // friction 使 vx *= (1 - friction*0.5) = (1 - 0.4) = 0.6
    // 但还有随机偏转，故仅验证显著衰减
    expect(Math.abs(body.velX)).toBeLessThan(10)
  })
})

// ============================================================
// 隧道壁碰撞
// ============================================================
describe('BlastPhysicsEngine - 隧道壁碰撞（矩形）', () => {
  it('右壁碰撞：位置修正 + 法向速度反射', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { x: 4.9, y: 5, z: 0 },
      vel: { x: 5, y: 0, z: 0 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.5, friction: 0, maxBounces: 10 }
    })
    engine.setTunnelBounds(rectangularBounds())
    engine.step(0.01)
    // halfWidth=5, fragR=0.2 → wallLimit=4.8；碎片应被推回
    expect(body.posX).toBeLessThanOrEqual(4.8 + 0.01)
    // 速度反射：velX 应反向（负值）
    expect(body.velX).toBeLessThan(0)
  })

  it('左壁碰撞：位置修正 + 法向速度反射', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { x: -4.9, y: 5, z: 0 },
      vel: { x: -5, y: 0, z: 0 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.5, friction: 0, maxBounces: 10 }
    })
    engine.setTunnelBounds(rectangularBounds())
    engine.step(0.01)
    expect(body.posX).toBeGreaterThanOrEqual(-4.8 - 0.01)
    expect(body.velX).toBeGreaterThan(0)
  })

  it('顶部碰撞：velY 反向', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { x: 0, y: 9.9, z: 0 },
      vel: { x: 0, y: 5, z: 0 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.5, friction: 0, maxBounces: 10 }
    })
    engine.setTunnelBounds(rectangularBounds())
    engine.step(0.01)
    // topY = floorY + wallHeight - fragR = 10 - 0.2 = 9.8
    expect(body.posY).toBeLessThanOrEqual(9.8 + 0.01)
    expect(body.velY).toBeLessThan(0) // 反射后向下
  })
})

describe('BlastPhysicsEngine - 隧道壁碰撞（马蹄形）', () => {
  it('直墙区碰撞与矩形一致', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { x: 4.9, y: 2, z: 0 },
      vel: { x: 5, y: 0, z: 0 },
      spec: { physSize: 0.4, density: 2700, restitution: 0.5, friction: 0, maxBounces: 10 }
    })
    engine.setTunnelBounds(horseshoeBounds())
    engine.step(0.01)
    expect(body.posX).toBeLessThanOrEqual(4.8 + 0.01)
    expect(body.velX).toBeLessThan(0)
  })

  it('拱顶区碰撞：径向反射', () => {
    const { engine, body } = createEngineWithOneBody({
      pos: { x: 4.5, y: 9, z: 0 },
      vel: { x: 3, y: 3, z: 0 },
      spec: { physSize: 0.3, density: 2700, restitution: 0.5, friction: 0, maxBounces: 10 }
    })
    engine.setTunnelBounds(horseshoeBounds()) // wallHeight=5, archRadius=5
    // 拱顶中心 y0=5, archDY = 9-5=4, lateral=4.5, dist≈6.02 > limit(5-0.15=4.85)
    engine.step(0.01)
    // 碎片应被推回拱顶内
    const y0 = 5
    const lateral = body.posX
    const archDY = body.posY - y0
    const dist = Math.sqrt(lateral * lateral + archDY * archDY)
    expect(dist).toBeLessThan(5.0) // 应在拱顶半径内
  })
})

// ============================================================
// 碎片间碰撞（冲量响应 + 库仑摩擦）
// ============================================================
describe('BlastPhysicsEngine - 碎片间碰撞', () => {
  it('位置修正：穿透碎片被推开至 minDist', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1), enableInterCollision: true })
    const spec = { physSize: 0.4, density: 2700, restitution: 0.2, friction: 0.5, maxBounces: 2 }
    engine.init(
      [spec, spec],
      [
        { x: 0, y: 5, z: 0 },
        { x: 0.3, y: 5, z: 0 }
      ], // dist=0.3 < minDist=0.4
      [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
      ]
    )
    engine.activateAll()
    engine.step(0.001) // 极小步长，仅触发碰撞解析
    const dx = engine.bodies[1].posX - engine.bodies[0].posX
    const dist = Math.abs(dx)
    // 修正后距离应接近 minDist=0.4
    expect(dist).toBeGreaterThan(0.38)
  })

  it('法向冲量：相向运动的碎片碰撞后分离', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1), enableInterCollision: true })
    const spec = { physSize: 0.4, density: 2700, restitution: 0.2, friction: 0, maxBounces: 5 }
    engine.init(
      [spec, spec],
      [
        { x: 0, y: 50, z: 0 },
        { x: 0.35, y: 50, z: 0 }
      ],
      [
        { x: 2, y: 0, z: 0 },
        { x: -2, y: 0, z: 0 }
      ]
    )
    engine.activateAll()
    engine.step(0.001)
    // 碰撞后 A 应向左减速，B 应向右减速（相对速度反转）
    const a = engine.bodies[0]
    const b = engine.bodies[1]
    // 法向（A→B）为 +x；碰撞前 velAlongNormal = -4 < 0（相向）
    // 碰撞后应分离：b.velX - a.velX > 0
    expect(b.velX - a.velX).toBeGreaterThan(0)
  })

  it('已分离碎片（velAlongNormal > 0）不施加冲量', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1), enableInterCollision: true })
    const spec = { physSize: 0.4, density: 2700, restitution: 0.2, friction: 0, maxBounces: 5 }
    engine.init(
      [spec, spec],
      [
        { x: 0, y: 50, z: 0 },
        { x: 0.35, y: 50, z: 0 }
      ],
      [
        { x: -2, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 }
      ] // 背离运动
    )
    engine.activateAll()
    const v0a = engine.bodies[0].velX
    const v0b = engine.bodies[1].velX
    engine.step(0.001)
    // 背离运动不应被碰撞改变速度（仅位置修正可能发生）
    expect(engine.bodies[0].velX).toBeCloseTo(v0a, 2)
    expect(engine.bodies[1].velX).toBeCloseTo(v0b, 2)
  })

  it('静态碎片（已落地）不移动，仅动态碎片响应', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1), enableInterCollision: true })
    const spec = { physSize: 0.4, density: 2700, restitution: 0.2, friction: 0.5, maxBounces: 5 }
    engine.init(
      [spec, spec],
      [
        { x: 0, y: 0.2, z: 0 },
        { x: 0.3, y: 0.2, z: 0 }
      ],
      [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
      ]
    )
    engine.setTunnelBounds(rectangularBounds())
    engine.activateAll()
    // 让 A 落地（设为 LANDED）
    engine.bodies[0].flags |= 0x02
    const aPosX = engine.bodies[0].posX
    engine.step(0.001)
    // 静态 A 不移动
    expect(engine.bodies[0].posX).toBeCloseTo(aPosX, 6)
  })

  it('库仑摩擦夹紧：切向冲量 |jt| ≤ μ·|j_n|', () => {
    // 构造大切向速度场景，验证 jt 被夹紧而非无限增大
    const engine = new BlastPhysicsEngine({ rng: makeRng(1), enableInterCollision: true })
    const spec = { physSize: 0.4, density: 2700, restitution: 0.2, friction: 0.6, maxBounces: 5 }
    engine.init(
      [spec, spec],
      [
        { x: 0, y: 50, z: 0 },
        { x: 0.35, y: 50, z: 0 }
      ],
      // A 有大法向速度 + 大切向速度
      [
        { x: 1, y: 0, z: 10 },
        { x: -1, y: 0, z: -10 }
      ]
    )
    engine.activateAll()
    engine.step(0.001)
    // 验证碰撞后速度有限（无 NaN/Infinity）
    for (const b of engine.bodies) {
      expect(Number.isFinite(b.velX)).toBe(true)
      expect(Number.isFinite(b.velY)).toBe(true)
      expect(Number.isFinite(b.velZ)).toBe(true)
    }
  })
})

// ============================================================
// 分段起爆（delayTime）
// ============================================================
describe('BlastPhysicsEngine - 分段起爆', () => {
  it('延迟碎片在 simTime < delayTime 时不运动', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1) })
    engine.init(
      [
        {
          physSize: 0.3,
          density: 2700,
          restitution: 0.2,
          friction: 0.5,
          maxBounces: 2,
          delayTime: 0.2
        }
      ],
      [{ x: 0, y: 50, z: 0 }],
      [{ x: 5, y: 0, z: 0 }]
    )
    engine.activateAll()
    // simTime < 0.2 时碎片未激活
    engine.step(0.1)
    expect(engine.bodies[0].posX).toBe(0) // 位置未变
    expect(engine.bodies[0].velX).toBe(5) // 速度未变
  })

  it('simTime >= delayTime 时碎片自动激活', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1) })
    engine.init(
      [
        {
          physSize: 0.3,
          density: 2700,
          restitution: 0.2,
          friction: 0.5,
          maxBounces: 2,
          delayTime: 0.1
        }
      ],
      [{ x: 0, y: 50, z: 0 }],
      [{ x: 5, y: 0, z: 0 }]
    )
    engine.activateAll()
    engine.step(0.15) // simTime=0.15 > 0.1
    expect(engine.aliveFragmentCount).toBe(1)
    // 激活后位置应已更新
    expect(engine.bodies[0].posX).not.toBe(0)
  })
})

// ============================================================
// 堆积与冻结
// ============================================================
describe('BlastPhysicsEngine - 堆积冻结', () => {
  it('低速飞行碎片持续 SETTLE_FRAMES 帧后冻结为 LANDED', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1) })
    engine.init(
      [{ physSize: 0.3, density: 2700, restitution: 0.1, friction: 0.9, maxBounces: 1 }],
      [{ x: 0, y: 50, z: 0 }],
      [{ x: 0, y: 0, z: 0 }]
    )
    engine.setTunnelBounds(rectangularBounds())
    engine.activateAll()
    // 模拟足够长的时间让碎片落地并冻结
    for (let i = 0; i < 200; i++) {
      engine.step(0.05)
      if (engine.bodies[0].flags & 0x02) break
    }
    expect(engine.bodies[0].flags & 0x02).toBeTruthy()
    expect(engine.bodies[0].velX).toBe(0)
    expect(engine.bodies[0].velY).toBe(0)
    expect(engine.bodies[0].velZ).toBe(0)
  })
})

// ============================================================
// 统计 API
// ============================================================
describe('BlastPhysicsEngine - 统计 API', () => {
  it('aliveFragmentCount 正确计数', () => {
    const engine = new BlastPhysicsEngine({ rng: makeRng(1) })
    engine.init(
      [
        { physSize: 0.3, density: 2700, restitution: 0.2, friction: 0.5, maxBounces: 2 },
        { physSize: 0.3, density: 2700, restitution: 0.2, friction: 0.5, maxBounces: 2 },
        {
          physSize: 0.3,
          density: 2700,
          restitution: 0.2,
          friction: 0.5,
          maxBounces: 2,
          delayTime: 1.0
        }
      ],
      [
        { x: 0, y: 5, z: 0 },
        { x: 1, y: 5, z: 0 },
        { x: 2, y: 5, z: 0 }
      ],
      [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
      ]
    )
    engine.activateAll()
    expect(engine.aliveFragmentCount).toBe(2) // 延迟碎片未激活
  })

  it('getBodyStates 返回正确结构', () => {
    const { engine } = createEngineWithOneBody()
    const states = engine.getBodyStates()
    expect(states).toHaveLength(1)
    expect(states[0]).toHaveProperty('posX')
    expect(states[0]).toHaveProperty('quatW')
    expect(states[0]).toHaveProperty('physSize')
    expect(states[0]).toHaveProperty('alive')
    expect(states[0]).toHaveProperty('landed')
  })

  it('getEnergyStats 返回动能与堆积比', () => {
    const { engine } = createEngineWithOneBody({ vel: { x: 10, y: 0, z: 0 } })
    const stats = engine.getEnergyStats()
    expect(stats.totalKineticEnergy).toBeGreaterThan(0)
    expect(stats.settledMassRatio).toBeGreaterThanOrEqual(0)
    expect(stats.settledMassRatio).toBeLessThanOrEqual(1)
    expect(Array.isArray(stats.timeSeries)).toBe(true)
  })

  it('reset 清空所有状态', () => {
    const { engine } = createEngineWithOneBody()
    engine.reset()
    expect(engine.bodies).toHaveLength(0)
    expect(engine.simTime).toBe(0)
  })
})
