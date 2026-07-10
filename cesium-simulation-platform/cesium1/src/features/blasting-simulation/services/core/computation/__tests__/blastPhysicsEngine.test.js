/**
 * BlastPhysicsEngine 单元测试
 *
 * 覆盖：
 * - Task 2：computeCoulombSlide slideDir 单位向量修复（间接通过 _applyReposeSettling 验证）
 * - Task 17：randomSeed 确定性模式（mulberry32）
 * - step：子步长自适应、重力自由落体
 * - computeDragAccel：P-01 分段阻力（间接通过 step 验证）
 *
 * 说明：computeCoulombSlide / computeDragAccel 为模块私有函数（未导出），
 * 通过 BlastPhysicsEngine 的可访问方法（_applyReposeSettling / step）间接测试。
 * 注意：DEEP_SLEEP_FRAMES=1 使正常流程下 LANDED 碎片立即深度休眠，滑动检查不可达；
 * 本测试通过设置 body.settledFrames=-1 触达滑动检查代码路径以验证 Task 2 修复。
 */
import { describe, it, expect, vi } from 'vitest'
import { BlastPhysicsEngine, mulberry32 } from '../blastPhysicsEngine.js'

// 标志位（与源码常量保持一致）
const FLAG_ALIVE = 0x01
const FLAG_LANDED = 0x02

// 构造简单碎片规格
function makeSpec(over = {}) {
  return { physSize: 0.2, density: 2700, restitution: 0.38, friction: 0.5, ...over }
}

// ─── Task 2：computeCoulombSlide slideDir 单位向量 ─────────────────────────
describe('Task 2: computeCoulombSlide slideDir 单位向量', () => {
  // 构造陡坡场景：碎片 A 落在支撑 B 上方且有水平偏移，坡角 45° > 安息角 37°
  // 通过 _applyReposeSettling 触发 computeCoulombSlide，滑动后速度 = slideDir * 0.15
  // 若 slideDir 为单位向量，则 |速度| = 0.15
  it('陡坡(45°)滑动后 |slideDir|=1 → |速度|≈0.15', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec(), makeSpec()]
    const positions = [{ x: 0.5, y: 1.0, z: 0 }, { x: 0, y: 0.5, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)

    const A = engine.bodies[0]
    const B = engine.bodies[1]
    // 两个碎片均标记为 ALIVE | LANDED，参与堆积判定
    A.flags = FLAG_ALIVE | FLAG_LANDED
    B.flags = FLAG_ALIVE | FLAG_LANDED
    // 关键：settledFrames=-1 使递增后为 0，绕过 DEEP_SLEEP_FRAMES=1 的深度休眠，触达滑动检查
    A.settledFrames = -1

    engine._applyReposeSettling()

    // A 应解除 LANDED 并获得下滑速度
    expect(A.flags & FLAG_LANDED).toBe(0)
    const mag = Math.sqrt(A.velX ** 2 + A.velY ** 2 + A.velZ ** 2)
    // |slideDir|=1 → |速度|=slideSpeed=0.15（容差 1e-6 验证单位向量）
    expect(Math.abs(mag - 0.15)).toBeLessThan(1e-6)
  })

  it('陡坡滑动速度分量匹配 cos(θ)·dir 与 -sin(θ)（Task 2 修复）', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec(), makeSpec()]
    const positions = [{ x: 0.5, y: 1.0, z: 0 }, { x: 0, y: 0.5, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)

    const A = engine.bodies[0]
    const B = engine.bodies[1]
    A.flags = FLAG_ALIVE | FLAG_LANDED
    B.flags = FLAG_ALIVE | FLAG_LANDED
    A.settledFrames = -1

    engine._applyReposeSettling()

    // theta = atan2(0.5, 0.5) = 45°；下坡水平方向 (1,0)
    const theta = Math.atan2(0.5, 0.5)
    const cosT = Math.cos(theta)
    const sinT = Math.sin(theta)
    const slideSpeed = 0.15
    expect(A.velX).toBeCloseTo(cosT * 1 * slideSpeed, 6)
    expect(A.velY).toBeCloseTo(-sinT * slideSpeed, 6)
    expect(A.velZ).toBeCloseTo(cosT * 0 * slideSpeed, 6)
  })

  it('缓坡(5.7°<安息角)不滑动，保持 LANDED', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec(), makeSpec()]
    // A 水平偏移很小，坡角约 5.7°，tan(5.7°)=0.1 < μ_s=0.34 → 不滑动
    const positions = [{ x: 0.05, y: 1.0, z: 0 }, { x: 0, y: 0.5, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)

    const A = engine.bodies[0]
    const B = engine.bodies[1]
    A.flags = FLAG_ALIVE | FLAG_LANDED
    B.flags = FLAG_ALIVE | FLAG_LANDED
    A.settledFrames = -1

    engine._applyReposeSettling()

    // shouldSlide=false → A 保持 LANDED 且速度为 0
    expect(A.flags & FLAG_LANDED).not.toBe(0)
    expect(A.velX).toBe(0)
    expect(A.velY).toBe(0)
    expect(A.velZ).toBe(0)
  })

  it('不同坡角的 slideDir 始终为单位向量', () => {
    // 多组水平偏移/垂直落差，验证 |slideDir|=1 恒成立
    // 注：makeSpec 未设 interFriction，init 默认 FRICTION_INTER=0.4，故 μ_s=0.4
    const cases = [
      { dx: 0.5, drop: 0.5 },   // 45°, tan=1 > 0.4 滑动
      { dx: 1.0, drop: 0.5 },   // 63°, tan=2 > 0.4 滑动
      { dx: 0.5, drop: 0.3 }    // 59°, tan=1.67 > 0.4 滑动
    ]
    for (const c of cases) {
      const engine = new BlastPhysicsEngine({})
      const specs = [makeSpec(), makeSpec()]
      const positions = [
        { x: c.dx, y: 1.0, z: 0 },
        { x: 0, y: 1.0 - c.drop, z: 0 }
      ]
      const velocities = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
      engine.init(specs, positions, velocities)

      const A = engine.bodies[0]
      const B = engine.bodies[1]
      A.flags = FLAG_ALIVE | FLAG_LANDED
      B.flags = FLAG_ALIVE | FLAG_LANDED
      A.settledFrames = -1

      engine._applyReposeSettling()

      const theta = Math.atan2(c.dx, c.drop)
      const mu_s = A.interFriction || 0.34
      // 仅在超安息角（tan(θ) > μ_s）时验证单位向量
      if (Math.tan(theta) > mu_s) {
        expect(A.flags & FLAG_LANDED).toBe(0)
        const mag = Math.sqrt(A.velX ** 2 + A.velY ** 2 + A.velZ ** 2)
        expect(Math.abs(mag - 0.15)).toBeLessThan(1e-6)
      }
    }
  })
})

// ─── Task 17：确定性模式（randomSeed / mulberry32）─────────────────────────
describe('Task 17: 确定性模式（randomSeed）', () => {
  it('相同 randomSeed 产生完全一致的 bodyStates', () => {
    const specs = [makeSpec(), makeSpec()]
    const positions = [{ x: 0, y: 0.5, z: 0 }, { x: 0.3, y: 0.5, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]

    const engine1 = new BlastPhysicsEngine({ randomSeed: 42 })
    const engine2 = new BlastPhysicsEngine({ randomSeed: 42 })
    engine1.init(specs, positions, velocities)
    engine2.init(specs, positions, velocities)
    engine1.activateAll()
    engine2.activateAll()

    // 推进 10 步（0.5s），使碎片下落、触底反弹，触发 _rng() 用于角速度与底板偏转
    for (let i = 0; i < 10; i++) {
      engine1.step(0.05)
      engine2.step(0.05)
    }

    const s1 = engine1.getBodyStates()
    const s2 = engine2.getBodyStates()
    expect(s1.length).toBe(s2.length)
    // 相同种子 + 相同操作 → 浮点逐位一致
    expect(s1).toEqual(s2)
  })

  it('init 阶段角速度由 randomSeed 决定（相同种子一致）', () => {
    const specs = [makeSpec(), makeSpec(), makeSpec()]
    const positions = [
      { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }
    ]
    const velocities = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]

    const e1 = new BlastPhysicsEngine({ randomSeed: 123 })
    const e2 = new BlastPhysicsEngine({ randomSeed: 123 })
    e1.init(specs, positions, velocities)
    e2.init(specs, positions, velocities)

    for (let i = 0; i < 3; i++) {
      expect(e1.bodies[i].angVelX).toBe(e2.bodies[i].angVelX)
      expect(e1.bodies[i].angVelY).toBe(e2.bodies[i].angVelY)
      expect(e1.bodies[i].angVelZ).toBe(e2.bodies[i].angVelZ)
    }
  })
})

// ─── step：子步长自适应计算 ────────────────────────────────────────────────
describe('step: 子步长自适应计算', () => {
  it('高速碎片(v=30, dt=0.05)触发 5 个子步', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec()]
    const positions = [{ x: 0, y: 100, z: 0 }]  // 高位避免触底
    const velocities = [{ x: 30, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    const spy = vi.spyOn(engine, '_integrate')
    engine.step(0.05)
    // subSteps = ceil(30*0.05/0.3) = ceil(5) = 5
    expect(spy).toHaveBeenCalledTimes(5)
  })

  it('静止碎片(v=0)触发 1 个子步', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec()]
    const positions = [{ x: 0, y: 100, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    const spy = vi.spyOn(engine, '_integrate')
    engine.step(0.05)
    // maxV=0 → subSteps = max(1, 0) = 1
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('极高速碎片(v=100)子步数被钳制为 8', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec()]
    const positions = [{ x: 0, y: 100, z: 0 }]
    const velocities = [{ x: 100, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    const spy = vi.spyOn(engine, '_integrate')
    engine.step(0.05)
    // subSteps = min(8, ceil(100*0.05/0.3)) = min(8, 17) = 8
    expect(spy).toHaveBeenCalledTimes(8)
  })
})

// ─── step：重力自由落体 ────────────────────────────────────────────────────
describe('step: 重力自由落体', () => {
  it('静止碎片受重力下落，vy ≈ -g·dt', () => {
    // 使用大质量碎片使空气阻力可忽略
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec({ physSize: 1.0, density: 10000 })]
    const positions = [{ x: 0, y: 100, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    engine.step(0.1)
    const b = engine.bodies[0]
    // vy = -g*dt = -9.8*0.1 = -0.98（阻力影响 < 1e-4）
    expect(b.velY).toBeCloseTo(-0.98, 3)
    // posY 下降
    expect(b.posY).toBeLessThan(100)
  })
})

// ─── computeDragAccel：P-01 分段阻力（间接验证）──────────────────────────
describe('computeDragAccel: 空气阻力（间接通过 step 验证）', () => {
  it('运动碎片受阻力减速（vx 减小）', () => {
    const engine = new BlastPhysicsEngine({})
    // 轻质大块碎片，阻力效果明显
    const specs = [makeSpec({ physSize: 0.3, density: 100 })]
    const positions = [{ x: 0, y: 100, z: 0 }]
    const velocities = [{ x: 20, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    engine.step(0.01)
    const b = engine.bodies[0]
    // vx 仅受阻力影响（重力为 y 方向），应小于初速 20
    expect(b.velX).toBeLessThan(20)
  })

  it('零速度时阻力为 0（vx 不变，仅重力作用于 y）', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec({ physSize: 1.0, density: 10000 })]
    const positions = [{ x: 0, y: 100, z: 0 }]
    const velocities = [{ x: 0, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    engine.step(0.01)
    const b = engine.bodies[0]
    // v=0 → 阻力返回 0，vx 保持 0
    expect(b.velX).toBe(0)
    expect(b.velZ).toBe(0)
    // vy 仅由重力产生
    expect(b.velY).toBeCloseTo(-0.098, 4)
  })

  it('阻力方向与速度相反（减速而非加速）', () => {
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec({ physSize: 0.3, density: 100 })]
    const positions = [{ x: 0, y: 100, z: 0 }]
    const velocities = [{ x: 15, y: 0, z: 0 }]
    engine.init(specs, positions, velocities)
    engine.activateAll()

    engine.step(0.01)
    const b = engine.bodies[0]
    // 正向速度应减小（阻力做负功）
    expect(b.velX).toBeGreaterThan(0)
    expect(b.velX).toBeLessThan(15)
  })
})

// ─── Task 7：矩形断面壁面碰撞（latVel 缓存修复）─────────────────────────────
// 反射公式：vel -= normal * (vel·normal) * (1 + restitution * 0.6)
// 修复前 Bug：velZ 反射量用了已被修改的 velX，导致反射方向与能量损失错误
describe('Task 7: 矩形断面壁面碰撞（latVel 缓存修复）', () => {
  // 矩形断面隧道：right=(1,0,0)，半宽 2，fragR=0.1 → halfW=1.9
  function makeRectTunnel(over = {}) {
    return {
      shape: 'rectangular',
      centerX: 0, centerY: 0, centerZ: 0,
      rightX: 1, rightY: 0, rightZ: 0,
      forwardX: 0, forwardY: 0, forwardZ: 1,
      halfWidth: 2, wallHeight: 10, archRadius: 0,
      floorY: 0,
      ...over
    }
  }

  it('右墙(法线(1,0,0))反射：vel(3,0,4),rest=0.5 → velX=-0.9, velZ=4', () => {
    // latVel = 3*1 + 4*0 = 3；reflect = 3*(1+0.5*0.6) = 3*1.3 = 3.9
    // velX = 3 - 1*3.9 = -0.9；velZ = 4 - 0*3.9 = 4
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec({ restitution: 0.5 })]
    engine.init(specs, [{ x: 2, y: 5, z: 0 }], [{ x: 3, y: 0, z: 4 }])
    engine.setTunnelBounds(makeRectTunnel())
    const b = engine.bodies[0]
    // posX=2 → lateral=2 > halfW=1.9 触发右墙
    engine._resolveWallCollision(b)
    expect(b.velX).toBeCloseTo(-0.9, 6)
    expect(b.velZ).toBeCloseTo(4, 6)
  })

  it('对角法线右墙反射：latVel 缓存修复后 velZ 不受 velX 修改污染', () => {
    // right=(s,0,s), s=1/√2。posX=posZ=2 → lateral=4s≈2.83 > halfW=1.9 触发右墙
    // latVel = 3*s + 4*s = 7s；reflect = 7s*1.3 = 9.1s
    // s*reflect = 9.1*s² = 9.1*0.5 = 4.55
    // velX = 3 - 4.55 = -1.55；velZ = 4 - 4.55 = -0.55
    // 修复前(Bug)：velZ 用已修改的 velX 重算 latVel → velZ≈2.41（错误方向/能量）
    const s = Math.SQRT1_2
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec({ restitution: 0.5 })]
    engine.init(specs, [{ x: 2, y: 5, z: 2 }], [{ x: 3, y: 0, z: 4 }])
    engine.setTunnelBounds(makeRectTunnel({
      rightX: s, rightZ: s, forwardX: -s, forwardZ: s
    }))
    const b = engine.bodies[0]
    engine._resolveWallCollision(b)
    expect(b.velX).toBeCloseTo(-1.55, 6)
    expect(b.velZ).toBeCloseTo(-0.55, 6)
  })

  it('左墙(法线(1,0,0))反射：vel(-3,0,4),rest=0.5 → velX=0.9, velZ=4', () => {
    // posX=-2 → lateral=-2 < -halfW=-1.9 触发左墙
    // latVel = -3*1 + 4*0 = -3；reflect = -3*1.3 = -3.9
    // velX = -3 - 1*(-3.9) = 0.9；velZ = 4 - 0*(-3.9) = 4
    const engine = new BlastPhysicsEngine({})
    const specs = [makeSpec({ restitution: 0.5 })]
    engine.init(specs, [{ x: -2, y: 5, z: 0 }], [{ x: -3, y: 0, z: 4 }])
    engine.setTunnelBounds(makeRectTunnel())
    const b = engine.bodies[0]
    engine._resolveWallCollision(b)
    expect(b.velX).toBeCloseTo(0.9, 6)
    expect(b.velZ).toBeCloseTo(4, 6)
  })
})

// ─── mulberry32 导出（供其他模块使用）──────────────────────────────────────
describe('mulberry32 导出', () => {
  it('已作为命名导出且为函数', () => {
    expect(typeof mulberry32).toBe('function')
  })

  it('相同种子产生一致序列，值域 [0,1)', () => {
    const rng1 = mulberry32(42)
    const rng2 = mulberry32(42)
    const seq1 = Array.from({ length: 5 }, () => rng1())
    const seq2 = Array.from({ length: 5 }, () => rng2())
    expect(seq1).toEqual(seq2)
    for (const v of seq1) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('不同种子产生不同序列', () => {
    const a = mulberry32(1)()
    const b = mulberry32(2)()
    expect(a).not.toBe(b)
  })
})
