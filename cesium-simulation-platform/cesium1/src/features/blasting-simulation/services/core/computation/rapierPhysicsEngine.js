/**
 * Rapier 物理引擎 — 基于 @dimforge/rapier3d-compat
 *
 * 替换手写 BlastPhysicsEngine，使用 Rapier 的凸包碰撞体和 PGS 求解器：
 * - 凸包碰撞体：从 rockGeometryFactory 的 15 种几何体顶点构建，解决块状碎片
 *   在斜面上球面支撑不符、过度滚动的问题
 * - PGS 多接触点求解器：天然支持多接触点稳定堆积，无需手写安息角启发式
 * - CCD 连续碰撞检测：防止高速碎片穿墙，替代手写自适应子步长
 * - BVH 宽相：高效处理 3000 动态体，替代手写空间散列
 *
 * API 与 BlastPhysicsEngine 完全一致，可透明替换。
 * 空气阻力（P-01 分段模型）和延迟激活（分段起爆）逻辑保留。
 */

import RAPIER from '@dimforge/rapier3d-compat'
import { DEFAULT_RESTITUTION, DEFAULT_FRICTION, REST_SPEED } from '../blastDefaults.js'

// ─── 物理常量（与 blastPhysicsEngine.js 一致）──────────
const GRAVITY = 9.8
const SETTLE_SPEED = 0.8
const SETTLE_FRAMES = 3
const ENERGY_SAMPLE_INTERVAL = 0.1

// 空气动力学常量
const AIR_DENSITY = 1.225
const AIR_KINEMATIC_VISC = 1.5e-5
const SPHERE_DRAG_COEFF = 0.47

// 碰撞分组（enableInterCollision=false 时使用）
const FRAG_GROUPS = 0x00020001 // group=0x0001, mask=0x0002（仅与隧道碰撞）
const TUNNEL_GROUPS = 0x00010002 // group=0x0002, mask=0x0001（仅与碎片碰撞）

// body 状态标志位（与 blastPhysicsEngine.js 一致）
const FLAG_ALIVE = 0x01
const FLAG_LANDED = 0x02

// ─── 空气阻力计算（P-01 分段模型，与原引擎完全一致）────
function computeDragAccel(vx, vy, vz, size, mass) {
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz)
  if (v < 1e-6 || mass <= 0) return { ax: 0, ay: 0, az: 0 }
  const d = Math.max(0.01, size)
  const Re = (v * d) / AIR_KINEMATIC_VISC
  const area = Math.PI * (d / 2) * (d / 2)
  let Cd
  if (Re > 1e4) {
    Cd = SPHERE_DRAG_COEFF
  } else if (Re > 1) {
    Cd = (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687))
  } else {
    Cd = 24 / Math.max(1e-3, Re)
  }
  const Fd = 0.5 * Cd * AIR_DENSITY * area * v * v
  const a = Fd / mass
  return { ax: -(a * vx) / v, ay: -(a * vy) / v, az: -(a * vz) / v }
}

// ─── 基向量 → 四元数（隧道朝向）────────────────────────
function basisToQuat(rx, ry, rz, ux, uy, uz, fx, fy, fz) {
  const trace = rx + uy + fz
  let qw, qx, qy, qz
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    qw = 0.25 / s
    qx = (uz - fy) * s
    qy = (fx - rz) * s
    qz = (ry - ux) * s
  } else if (rx > uy && rx > fz) {
    const s = 2 * Math.sqrt(1 + rx - uy - fz)
    qw = (uz - fy) / s
    qx = 0.25 * s
    qy = (ux + ry) / s
    qz = (fx + rz) / s
  } else if (uy > fz) {
    const s = 2 * Math.sqrt(1 + uy - rx - fz)
    qw = (fx - rz) / s
    qx = (ux + ry) / s
    qy = 0.25 * s
    qz = (fy + uz) / s
  } else {
    const s = 2 * Math.sqrt(1 + fz - rx - uy)
    qw = (ry - ux) / s
    qx = (fx + rz) / s
    qy = (fy + uz) / s
    qz = 0.25 * s
  }
  return { x: qx, y: qy, z: qz, w: qw }
}

// ─── 计算顶点数组的最大半径 ─────────────────────────────
function computeMaxRadius(points) {
  let maxR = 0
  for (let i = 0; i < points.length; i += 3) {
    const r = Math.sqrt(points[i] ** 2 + points[i + 1] ** 2 + points[i + 2] ** 2)
    if (r > maxR) maxR = r
  }
  return maxR || 1
}

export class RapierPhysicsEngine {
  constructor(config = {}) {
    this.gravity = config.gravity ?? GRAVITY
    this.enableInterCollision = config.enableInterCollision ?? true
    this._rng = config.rng || Math.random

    /** @type {RAPIER.World|null} */
    this._world = null
    /** @type {Array<Object>} 碎片刚体元数据 */
    this._fragmentBodies = []
    /** @type {Array<RAPIER.RigidBody>} 隧道壁固定刚体 */
    this._tunnelColliderBodies = []
    /** @type {Array<Float32Array>|null} 15 种几何体变体的顶点数据 */
    this._geometryVertices = null
    /** @type {Array<{maxR:number}>|null} 预计算的各变体最大半径 */
    this._variantMaxR = null

    this._tunnelBounds = null
    this.simTime = 0
    this._energyTimeSeries = []
    this._lastSampleTime = 0
    this.onBodyLanded = null
    this.activeCount = 0
  }

  /**
   * 初始化 Rapier World（必须在 init 前调用）
   * 在 Worker 中于 RAPIER.init() 完成后同步调用。
   */
  ensureReady() {
    if (this._world) return
    this._world = new RAPIER.World({ x: 0, y: -this.gravity, z: 0 })
    this._world.timestep = 0.05
    // 求解器迭代次数：8 → 4（Rapier 默认值）。4500+ 凸包刚体互撞时，
    // 迭代次数是单步耗时的主要乘数：8 次迭代的堆叠稳定增益对数千刚体
    // 而言已过剩，降到 4 次可换取 ~1.5-2x 的预计算提速（等待"关键帧
    // 回放就绪"的时间减半）。堆积稳定性由下方 _applySettling 低速冻结兜底。
    this._world.integrationParameters.numSolverIterations = 4
  }

  /**
   * 设置 15 种几何体变体的顶点数据（用于凸包碰撞体）
   * @param {Array<Float32Array>} vertices - 15 个 Float32Array，每个为 [x,y,z,...]
   */
  setGeometryVertices(vertices) {
    this._geometryVertices = vertices
    // 预计算各变体的最大半径，避免 init 时重复计算
    this._variantMaxR = vertices.map(v => computeMaxRadius(v))
  }

  /**
   * 设置隧道截面边界（与 BlastPhysicsEngine.setTunnelBounds 兼容）
   */
  setTunnelBounds(bounds) {
    this._tunnelBounds = bounds
    // 隧道碰撞体在 init() 中创建（需要先 reset 世界）
  }

  /**
   * 用碎片规格初始化物理引擎
   * @param {FragmentSpec[]} specs
   * @param {Array<{x,y,z}>} positions
   * @param {Array<{x,y,z}>} velocities
   */
  init(specs, positions, velocities) {
    this.ensureReady()
    this._clearBodies()

    // 创建隧道壁碰撞体
    this._createTunnelColliders()

    const count = Math.min(specs.length, positions.length, velocities.length)
    const fragGroups = this.enableInterCollision ? 0xffffffff : FRAG_GROUPS

    for (let i = 0; i < count; i++) {
      const s = specs[i]
      const p = positions[i]
      const v = velocities[i]
      const physSize = Math.max(0.01, Number(s.physSize) || 0.01)
      // 视觉直径 = dispSize：渲染网格 scale=dispSize、半径 = maxR×dispSize。
      // 物理碰撞体必须与之同尺寸，否则贴墙堆积时视觉网格穿出隧道壁
      //（"碎石挤到隧道外"）。质量仍按 KCO physSize 直径计算（下方 setMass 覆盖）。
      const dispSize = Math.max(0.01, Number(s.dispSize) || physSize)
      const density = Math.max(100, Number(s.density) || 2700)
      const mass = density * (4 / 3) * Math.PI * Math.pow(physSize / 2, 3)
      const variantIndex = Math.floor(Number(s.variantIndex)) || 0
      const restitution = s.restitution ?? DEFAULT_RESTITUTION
      const friction = s.friction ?? DEFAULT_FRICTION
      const delayTime = Math.max(0, Number(s.delayTime) || 0)

      // 创建碰撞体描述：凸包（有几何顶点时）或球体（fallback）
      let colDesc
      const variantVerts = this._geometryVertices?.[variantIndex]
      // 变体最大半径（决定凸包与视觉网格的统一外伸尺寸）
      const hullMaxR =
        variantVerts && variantVerts.length >= 9
          ? this._variantMaxR?.[variantIndex] || computeMaxRadius(variantVerts)
          : 1
      if (variantVerts && variantVerts.length >= 9) {
        // 顶点缩放 scale=dispSize：凸包最大半径 = hullMaxR×dispSize
        // = 渲染网格（scale=dispSize）的真实外伸半径，物理与视觉完全同尺寸。
        const scaled = new Float32Array(variantVerts.length)
        for (let j = 0; j < variantVerts.length; j++) {
          scaled[j] = variantVerts[j] * dispSize
        }
        colDesc = RAPIER.ColliderDesc.convexHull(scaled)
      } else {
        colDesc = RAPIER.ColliderDesc.ball(dispSize * hullMaxR)
      }

      if (!colDesc) {
        // convexHull 失败时 fallback 到球体（同样按渲染尺寸）
        colDesc = RAPIER.ColliderDesc.ball(dispSize * hullMaxR)
      }

      colDesc.setRestitution(restitution)
      colDesc.setFriction(friction)
      colDesc.setDensity(density)
      colDesc.setCollisionGroups(fragGroups)

      // 创建动态刚体（初始禁用，等 activateAll 激活）
      // 注意：RAPIER.RigidBodyDesc 无 enabled() 方法，需在 createRigidBody 后调用 setEnabled
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setLinvel(v.x, v.y, v.z)
        .setAngularDamping(0.5)
        .setLinearDamping(0) // 空气阻力手动施加
        .setCcdEnabled(true) // 连续碰撞检测防穿墙

      const body = this._world.createRigidBody(bodyDesc)
      const collider = this._world.createCollider(colDesc, body)
      // 碰撞体已按渲染尺寸放大（dispSize），但其体积质量会随体积³膨胀；
      // 显式覆盖为 KCO physSize 直径对应的真实质量，保持抛掷/堆积动力学不变。
      if (collider?.setMass) collider.setMass(mass)
      body.setEnabled(false)

      const entry = {
        rigidBody: body,
        physSize,
        // 碰撞半径 = 渲染网格的外伸半径（hullMaxR×dispSize，凸包/球体一致口径）
        collisionRadius: dispSize * hullMaxR,
        mass,
        flags: delayTime > 0 ? 0 : FLAG_ALIVE,
        delayTime,
        _delayed: delayTime > 0,
        bounceCount: 0,
        lowSpeedFrames: 0,
        landTriggered: false,
        variantIndex
      }
      this._fragmentBodies.push(entry)
    }
    this.activeCount = count
  }

  /**
   * 激活所有非延迟碎片（爆破触发时调用）
   */
  activateAll() {
    for (const b of this._fragmentBodies) {
      if (b._delayed) continue
      b.flags |= FLAG_ALIVE
      b.rigidBody.setEnabled(true)
      b.rigidBody.wakeUp()
    }
  }

  /**
   * 设置碎片间碰撞开关
   */
  setEnableInterCollision(value) {
    this.enableInterCollision = !!value
    // 更新已有碎片碰撞体的碰撞分组
    const groups = this.enableInterCollision ? 0xffffffff : FRAG_GROUPS
    for (const b of this._fragmentBodies) {
      // Rapier 不支持直接修改碰撞分组，需通过 collider
      const collider = b.rigidBody.collider(0)
      if (collider) collider.setCollisionGroups(groups)
    }
  }

  /**
   * 推进物理模拟一步
   * @param {number} dt - 时间步长(s)
   */
  step(dt) {
    if (dt <= 0 || !this._world) return
    this.simTime += dt

    // 1. 激活到时的延迟碎片
    for (const b of this._fragmentBodies) {
      if (b._delayed && !(b.flags & FLAG_ALIVE)) {
        if (this.simTime >= b.delayTime) {
          b.flags |= FLAG_ALIVE
          b._delayed = false
          b.rigidBody.setEnabled(true)
          b.rigidBody.wakeUp()
        }
      }
    }

    // 2. 重置力 + 施加空气阻力
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const rb = b.rigidBody
      rb.resetForces(true)
      rb.resetTorques(true)

      if (b.flags & FLAG_LANDED) continue
      if (b.physSize <= 0.01 || b.mass <= 0) continue

      const vel = rb.linvel()
      const drag = computeDragAccel(vel.x, vel.y, vel.z, b.physSize, b.mass)
      rb.addForce({ x: drag.ax * b.mass, y: drag.ay * b.mass, z: drag.az * b.mass }, true)
    }

    // 3. 步进世界（Rapier 内部处理重力、碰撞、约束求解）
    this._world.timestep = dt
    this._world.step()

    // 4. 安息角堆积检测（低速冻结 + 悬空解除）
    this._applySettling()

    // 5. 隧道外碎石检查与消除：任何中心越出断面的碎片被"传送"回断面内
    //    最近合法点并清零速度。根治"碎石被挤到隧道外"——物理源头上就不
    //    存在越界块，渲染层与爆堆轮廓不会再被它们撑偏/撑高（此前只能靠
    //    渲染隐藏 + 轮廓剔除，壳仍被架桥出大片空档）
    this._containOutsideFragments()

    // 6. 能量统计采样
    if (this.simTime - this._lastSampleTime >= ENERGY_SAMPLE_INTERVAL) {
      this._sampleEnergy()
    }
  }

  /**
   * 隧道外碎石检查与消除：每步扫描存活碎片，中心越出隧道断面的碎片
   * （被挤到侧墙外/拱顶外侧/截面上方）立即传送回断面内最近的合法点，
   * 速度清零并赋予轻微下落速度，使其落回爆堆重新停稳。
   * 容差允许贴墙/贴拱正常堆积（与轮廓剔除口径一致）。
   */
  _containOutsideFragments() {
    const tb = this._tunnelBounds
    if (!tb || !this._world) return
    const fc = { x: tb.centerX, y: tb.floorY, z: tb.centerZ }
    const rx = tb.rightX
    const ry = tb.rightY
    const rz = tb.rightZ
    const halfW = tb.halfWidth
    const wallH = tb.wallHeight
    const R = tb.archRadius
    const shape = tb.shape || 'horseshoe'
    const tol = 0.15 // 轻微越界的贴墙/贴拱堆积不误传
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const p = b.rigidBody.translation()
      const dx = p.x - fc.x
      const dy = p.y - fc.y
      const dz = p.z - fc.z
      const t = dx * rx + dy * ry + dz * rz
      const u = p.y - fc.y
      // 越界判定（与轮廓 _outsideSection 同构）
      let outside = false
      if (shape === 'circular') {
        if (Math.hypot(t, u - R) > R + tol) outside = true
      } else if (shape === 'rectangular') {
        if (Math.abs(t) > halfW + tol || u > wallH + R + tol) outside = true
      } else {
        if (u <= wallH) {
          if (Math.abs(t) > halfW + tol) outside = true
        } else if (Math.hypot(t, u - wallH) > R + tol) outside = true
      }
      if (!outside) continue
      // 求断面内最近合法点：侧向夹到 [-(halfW-ε), halfW-ε]，竖向夹到
      // [0.05, 净空(t)-0.05]（保留轴向 s 不变）
      const maxT = Math.max(0.05, halfW - 0.05)
      const ct = Math.max(-maxT, Math.min(maxT, t))
      let ceilU = wallH + R
      if (shape === 'circular') {
        const dd = Math.min(R, Math.abs(ct))
        ceilU = R + Math.sqrt(Math.max(0, R * R - dd * dd))
      } else if (shape !== 'rectangular') {
        ceilU =
          Math.abs(ct) > R ? wallH : wallH + Math.sqrt(Math.max(0, R * R - ct * ct))
      }
      const cu = Math.max(0.05, Math.min(Math.max(0.05, ceilU - 0.05), u))
      b.rigidBody.setTranslation({ x: fc.x + rx * ct, y: fc.y + cu, z: fc.z + rz * ct }, false)
      b.rigidBody.setLinvel({ x: 0, y: -1, z: 0 }, true) // 轻微下落，落回堆体
      b.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
      b.lowSpeedFrames = 0
    }
  }

  /**
   * 安息角堆积判定：低速冻结 + 悬空解除
   * Rapier 的多接触点求解器天然支持稳定堆积，
   * 此处仅做低速冻结（停止模拟以节省 CPU）和悬空检测。
   *
   * 关键修正：冻结必须要求"贴靠支撑"（底板或下方接触物）。此前仅凭低速
   * 就 sleep 冻结，碎片在掌子面/拱腰/侧墙处短暂减速即被冻在半空，重力停止
   * 作用 → 永久悬空，表现为"碎石卡在掌子面/卡在半空"。现改为：
   *  - 未冻结：低速 + 有支撑才累计冻结；无支撑低速则继续下落
   *  - 已冻结：被唤醒后（受扰）若无支撑则解除冻结重新下落
   */
  _applySettling() {
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const vel = b.rigidBody.linvel()
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z)

      if (b.flags & FLAG_LANDED) {
        // 已冻结碎片：若 Rapier 因受扰将其唤醒（有速度）且失去支撑
        // （被顶飞/支撑滑走），解除冻结让其重新下落，避免残影悬空。
        if (speed > 0.05 && !this._bodyHasSupport(b)) {
          b.flags &= ~FLAG_LANDED
          b.lowSpeedFrames = 0
          b.rigidBody.wakeUp()
        }
        continue
      }

      // 未冻结碎片：低速 + 贴靠支撑才冻结（禁止悬空卡石）
      if (speed < SETTLE_SPEED) {
        if (this._bodyHasSupport(b)) {
          b.lowSpeedFrames = (b.lowSpeedFrames || 0) + 1
          if (b.lowSpeedFrames >= SETTLE_FRAMES) {
            b.flags |= FLAG_LANDED
            b.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
            b.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
            b.rigidBody.sleep()
            if (this.onBodyLanded && !b.landTriggered) {
              b.landTriggered = true
              const pos = b.rigidBody.translation()
              this.onBodyLanded({ posX: pos.x, posY: pos.y, posZ: pos.z }, speed)
            }
          }
        } else {
          // 悬空无支撑：不冻结，清空计数，让它继续下落
          b.lowSpeedFrames = 0
        }
      } else {
        b.lowSpeedFrames = 0
      }
    }
  }

  /**
   * 检查碎片是否贴靠支撑（底板或下方接触物）。
   * 用于禁止"悬空冻结"：无支撑的半空碎片不应被标记 LANDED，
   * 否则碎片会在拱腰/掌子面处永久悬浮（重力停止作用），表现为"卡石"。
   *
   * 判定方式：
   *  - 快速路径：碎片底部贴近底板（含底板上薄层堆积）
   *  - 接触判定：Rapier 接触检测，存在接触点位于碎片中心下方的支撑物
   *    （接触点在下方半球 → 支撑在底部；侧壁/掌子面接触点约在中心高度，
   *     不会被误判为支撑）
   * @param {Object} b - 碎片 entry（含 rigidBody/physSize）
   * @returns {boolean}
   */
  _bodyHasSupport(b) {
    const pos = b.rigidBody.translation()
    const tb = this._tunnelBounds
    const fragR = b.collisionRadius || b.physSize * 0.5
    const floorY = tb ? tb.floorY : 0
    if (pos.y - fragR <= floorY + 0.2) return true

    const collider = b.rigidBody.collider(0)
    if (!collider || !this._world) return false
    const centerY = pos.y
    const pt = { x: 0, y: 0, z: 0 }
    let supported = false
    try {
      this._world.contactPairsWith(collider, other => {
        if (supported) return
        this._world.contactPair(collider, other, manifold => {
          if (supported) return
          const n = manifold.numSolverContacts()
          for (let i = 0; i < n; i++) {
            const p = manifold.solverContactPoint(i, pt)
            if (p && p.y < centerY - 0.02) {
              supported = true
              return
            }
          }
        })
      })
    } catch (_) {
      // 接触查询失败时保守视为无支撑（不冻结），避免卡石
    }
    return supported
  }

  /** 能量统计采样 */
  _sampleEnergy() {
    let totalKE = 0
    let settledMass = 0
    let totalMass = 0
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const vel = b.rigidBody.linvel()
      const speed2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z
      totalKE += 0.5 * b.mass * speed2
      totalMass += b.mass
      if (b.flags & FLAG_LANDED) settledMass += b.mass
    }
    this._energyTimeSeries.push({
      t: this.simTime,
      kineticEnergy: totalKE,
      settledMassRatio: totalMass > 0 ? settledMass / totalMass : 0
    })
    this._lastSampleTime = this.simTime
  }

  /**
   * 获取所有身体状态（供渲染器使用）
   * @returns {BodyState[]}
   */
  getBodyStates() {
    return this._fragmentBodies.map(b => {
      const pos = b.rigidBody.translation()
      const rot = b.rigidBody.rotation()
      const vel = b.rigidBody.linvel()
      return {
        posX: pos.x,
        posY: pos.y,
        posZ: pos.z,
        quatX: rot.x,
        quatY: rot.y,
        quatZ: rot.z,
        quatW: rot.w,
        velX: vel.x,
        velY: vel.y,
        velZ: vel.z,
        // packBodyStates 读取 b.flags（数字），必须返回 flags 字段而非布尔 alive
        flags: b.flags,
        alive: !!(b.flags & FLAG_ALIVE),
        landed: !!(b.flags & FLAG_LANDED),
        physSize: b.physSize,
        bounceCount: b.bounceCount || 0
      }
    })
  }

  /** 存活碎片数量 */
  get aliveFragmentCount() {
    let c = 0
    for (const b of this._fragmentBodies) {
      if (b.flags & FLAG_ALIVE) c++
    }
    return c
  }

  /** 已落地碎片数量 */
  get landedFragmentCount() {
    let c = 0
    for (const b of this._fragmentBodies) {
      if (b.flags & FLAG_LANDED) c++
    }
    return c
  }

  /**
   * 静止质量比（动画"抛掷结束"判据，质量加权，0~1）。
   *
   * 与 getEnergyStats().settledMassRatio 的区别：后者只认 FLAG_LANDED，而
   * "落地/冻结"要求低速持续若干帧且有支撑——少数贴合不良或反复受扰被唤醒的
   * 边角石可能长期不置位，使比值卡在平台期，"99% 碎片落地"这类计数判据
   * 永不达成 → 回放时长回退到硬上限（时间条虚长数倍）。本口径以速度为准，
   * 天然收敛到 1。与 BlastPhysicsEngine.restMassRatio 同口径。
   * @returns {number} 静止质量占比 0~1
   */
  get restMassRatio() {
    let restMass = 0
    let totalMass = 0
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      totalMass += b.mass
      if (b.flags & FLAG_LANDED) {
        restMass += b.mass
        continue
      }
      const vel = b.rigidBody.linvel()
      const v2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z
      if (v2 <= REST_SPEED * REST_SPEED) restMass += b.mass
    }
    return totalMass > 0 ? restMass / totalMass : 0
  }

  /**
   * 获取能量统计
   * @returns {{totalKineticEnergy:number, settledMassRatio:number, timeSeries:Array}}
   */
  getEnergyStats() {
    let totalKE = 0
    let settledMass = 0
    let totalMass = 0
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const vel = b.rigidBody.linvel()
      const speed2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z
      totalKE += 0.5 * b.mass * speed2
      totalMass += b.mass
      if (b.flags & FLAG_LANDED) settledMass += b.mass
    }
    return {
      totalKineticEnergy: totalKE,
      settledMassRatio: totalMass > 0 ? settledMass / totalMass : 0,
      timeSeries: this._energyTimeSeries
    }
  }

  /** 重置引擎 */
  reset() {
    this._clearBodies()
    this._fragmentBodies = []
    this.activeCount = 0
    this.simTime = 0
    this._energyTimeSeries = []
    this._lastSampleTime = 0
  }

  /**
   * 原位重置到初始状态（循环重播回到 t=0 时调用）。
   * 复用现有刚体与凸包碰撞体，仅重设位置/速度/启用状态，避免销毁重建
   * 数千个凸包导致的数秒卡顿与 WASM 内存抖动（表现为"碎石回到掌子面
   * 后长时间不抛掷"）。
   * 要求 specs 与首次 init 一致（_resetToStart 复用 _lastFragmentData）。
   * @param {Array<{x,y,z}>} positions - 初始位置
   * @param {Array<{x,y,z}>} velocities - 初始速度
   */
  resetToInitial(positions, velocities) {
    const n = Math.min(this._fragmentBodies.length, positions.length)
    for (let i = 0; i < n; i++) {
      const b = this._fragmentBodies[i]
      const p = positions[i]
      const v = velocities[i]
      b.rigidBody.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
      b.rigidBody.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
      b.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
      b.rigidBody.setEnabled(false)
      b.flags = b.delayTime > 0 ? 0 : FLAG_ALIVE
      b._delayed = b.delayTime > 0
      b.bounceCount = 0
      b.lowSpeedFrames = 0
      b.landTriggered = false
    }
    this.activeCount = this._fragmentBodies.length
    this.simTime = 0
    this._energyTimeSeries = []
    this._lastSampleTime = 0
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /** 清除所有刚体和碰撞体 */
  _clearBodies() {
    if (!this._world) return
    for (const b of this._fragmentBodies) {
      try {
        this._world.removeRigidBody(b.rigidBody)
      } catch (_) {
        /* ignore */
      }
    }
    for (const body of this._tunnelColliderBodies) {
      try {
        this._world.removeRigidBody(body)
      } catch (_) {
        /* ignore */
      }
    }
    this._tunnelColliderBodies = []
  }

  /**
   * 创建隧道壁碰撞体（固定 cuboid）
   * 马蹄形：底板 + 左右直墙 + 拱顶弧段
   * 圆形：底板 + 半圆弧段
   * 矩形：底板 + 左右直墙 + 顶板
   */
  _createTunnelColliders() {
    const tb = this._tunnelBounds
    if (!tb || !this._world) return

    const right = { x: tb.rightX, y: tb.rightY, z: tb.rightZ }
    const forward = { x: tb.forwardX, y: tb.forwardY, z: tb.forwardZ }
    const up = { x: 0, y: 1, z: 0 }
    const fc = { x: tb.centerX, y: tb.floorY, z: tb.centerZ }

    // 隧道朝向四元数（右手系：用 -forward 作为 z 轴）
    const quat = basisToQuat(
      right.x,
      right.y,
      right.z,
      up.x,
      up.y,
      up.z,
      -forward.x,
      -forward.y,
      -forward.z
    )

    const halfWidth = tb.halfWidth
    const wallHeight = tb.wallHeight
    const archRadius = tb.archRadius
    const halfLen = 60
    const tunnelGroups = this.enableInterCollision ? 0xffffffff : TUNNEL_GROUPS
    const shape = tb.shape || 'horseshoe'

    // 构建马蹄形/圆形/矩形截面轮廓点（局部 x-y，不含底板，逆时针）
    const points = []
    if (shape === 'rectangular') {
      const totalH = wallHeight + (archRadius || 0)
      points.push([-halfWidth, 0])
      points.push([-halfWidth, totalH])
      points.push([halfWidth, totalH])
      points.push([halfWidth, 0])
    } else if (shape === 'circular') {
      // 半圆（底板已覆盖底部）
      const segs = 24
      for (let i = 0; i <= segs; i++) {
        const a = Math.PI * (1 - i / segs) // 从 π 到 0
        points.push([archRadius * Math.cos(a), archRadius * Math.sin(a)])
      }
    } else {
      // 马蹄形（默认）：左墙 + 拱顶弧 + 右墙
      points.push([-halfWidth, 0])
      points.push([-halfWidth, wallHeight])
      const segs = 24
      for (let i = 1; i < segs; i++) {
        const a = Math.PI - (Math.PI * i) / segs // 从 π 到 0
        points.push([archRadius * Math.cos(a), wallHeight + archRadius * Math.sin(a)])
      }
      points.push([halfWidth, wallHeight])
      points.push([halfWidth, 0])
    }

    // 构建 trimesh 顶点：轮廓 × 2（z=±halfLen），局部坐标
    const verts = []
    for (const [px, py] of points) {
      verts.push(px, py, halfLen) // 前端面
      verts.push(px, py, -halfLen) // 后端面
    }
    // 侧面三角形（相邻轮廓点 × 前后 = 2 三角形）
    // 注意：原绕序计算出的法线朝外，Rapier 的 trimesh 是单面碰撞体，
    // 碎片从隧道内部撞到背面 → 直接穿墙。这里按"双面"发射（每个三角形
    // 同时写入正/反两个绕序），无论碎片从内部还是外部撞击都被阻挡，杜绝穿模。
    const idx = []
    for (let i = 0; i < points.length; i++) {
      const next = (i + 1) % points.length
      const i0 = i * 2
      const i1 = i * 2 + 1
      const i2 = next * 2
      const i3 = next * 2 + 1
      // 面 1 的两个绕序（原绕序 + 反向）
      idx.push(i0, i2, i1)
      idx.push(i0, i1, i2)
      // 面 2 的两个绕序（原绕序 + 反向）
      idx.push(i1, i2, i3)
      idx.push(i1, i3, i2)
    }

    // 创建隧道侧壁 trimesh 碰撞体（固定刚体，位置在 fc，旋转对齐隧道朝向）
    const wallBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(fc.x, fc.y, fc.z)
      .setRotation(quat)
    const wallBody = this._world.createRigidBody(wallBodyDesc)
    const wallCol = RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx))
    // 侧墙摩擦 0.4（原 0.8 过高，碎片贴壁/贴拱易滞留不滑落，加剧"卡石"）
    wallCol.setFriction(0.4)
    wallCol.setRestitution(0.1)
    wallCol.setCollisionGroups(tunnelGroups)
    this._world.createCollider(wallCol, wallBody)
    this._tunnelColliderBodies.push(wallBody)

    // 底板单独用 cuboid（平坦，碎片在上面堆积）
    const floorBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(fc.x, fc.y - 0.25, fc.z)
      .setRotation(quat)
    const floorBody = this._world.createRigidBody(floorBodyDesc)
    const floorCol = RAPIER.ColliderDesc.cuboid(halfWidth + 1, 0.25, halfLen)
    floorCol.setFriction(0.8)
    floorCol.setRestitution(0.1)
    floorCol.setCollisionGroups(tunnelGroups)
    this._world.createCollider(floorCol, floorBody)
    this._tunnelColliderBodies.push(floorBody)

    // 掌子面封堵板：在掌子面（局部 z = -faceOffset）加一块与该断面同形的平板，
    // 阻止碎片反向飞进未爆破岩体（视觉上表现为"嵌进/卡在掌子面"）。
    // 低摩擦 + 近零恢复：贴面碎片不会反弹弹回后方，而是沿面滑落入堆。
    const zFace = -Math.max(1, Number(tb.faceOffset) || 3)
    // 计算轮廓质心（fan 三角剖分中心）
    let cxx = 0
    let cyy = 0
    for (const [px, py] of points) {
      cxx += px
      cyy += py
    }
    cxx /= points.length
    cyy /= points.length
    const capVerts = []
    const capIdx = []
    for (let i = 0; i < points.length; i++) {
      const [px, py] = points[i]
      const [px2, py2] = points[(i + 1) % points.length]
      capVerts.push(px, py, zFace)
      capVerts.push(px2, py2, zFace)
      capVerts.push(cxx, cyy, zFace)
      const base = capVerts.length / 3 - 3
      // 双面绕序（正/反），无论碎片从哪侧撞击都被阻挡
      capIdx.push(base, base + 1, base + 2)
      capIdx.push(base, base + 2, base + 1)
    }
    const capBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(fc.x, fc.y, fc.z)
      .setRotation(quat)
    const capBody = this._world.createRigidBody(capBodyDesc)
    const capCol = RAPIER.ColliderDesc.trimesh(new Float32Array(capVerts), new Uint32Array(capIdx))
    capCol.setFriction(0.3)
    capCol.setRestitution(0.05)
    capCol.setCollisionGroups(tunnelGroups)
    this._world.createCollider(capCol, capBody)
    this._tunnelColliderBodies.push(capBody)
  }
}

export default RapierPhysicsEngine
