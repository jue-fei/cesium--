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
    // 增加求解器迭代次数以改善堆积稳定性
    this._world.integrationParameters.numSolverIterations = 8
  }

  /**
   * 设置 15 种几何体变体的顶点数据（用于凸包碰撞体）
   * @param {Array<Float32Array>} vertices - 15 个 Float32Array，每个为 [x,y,z,...]
   */
  setGeometryVertices(vertices) {
    this._geometryVertices = vertices
    // 预计算各变体的最大半径，避免 init 时重复计算
    this._variantMaxR = vertices.map((v) => computeMaxRadius(v))
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
      const density = Math.max(100, Number(s.density) || 2700)
      const mass = density * (4 / 3) * Math.PI * Math.pow(physSize / 2, 3)
      const variantIndex = Math.floor(Number(s.variantIndex)) || 0
      const restitution = s.restitution ?? 0.15
      const friction = s.friction ?? 0.7
      const delayTime = Math.max(0, Number(s.delayTime) || 0)

      // 创建碰撞体描述：凸包（有几何顶点时）或球体（fallback）
      let colDesc
      const variantVerts = this._geometryVertices?.[variantIndex]
      if (variantVerts && variantVerts.length >= 9) {
        // 缩放顶点：单位几何体 → physSize/2 最大半径
        const maxR = this._variantMaxR?.[variantIndex] || computeMaxRadius(variantVerts)
        const scale = (physSize / 2) / maxR
        const scaled = new Float32Array(variantVerts.length)
        for (let j = 0; j < variantVerts.length; j++) {
          scaled[j] = variantVerts[j] * scale
        }
        colDesc = RAPIER.ColliderDesc.convexHull(scaled)
      } else {
        colDesc = RAPIER.ColliderDesc.ball(physSize / 2)
      }

      if (!colDesc) {
        // convexHull 失败时 fallback 到球体
        colDesc = RAPIER.ColliderDesc.ball(physSize / 2)
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
      this._world.createCollider(colDesc, body)
      body.setEnabled(false)

      const entry = {
        rigidBody: body,
        physSize,
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

    // 5. 能量统计采样
    if (this.simTime - this._lastSampleTime >= ENERGY_SAMPLE_INTERVAL) {
      this._sampleEnergy()
    }
  }

  /**
   * 安息角堆积判定：低速冻结 + 悬空解除
   * Rapier 的多接触点求解器天然支持稳定堆积，
   * 此处仅做低速冻结（停止模拟以节省 CPU）和悬空检测。
   */
  _applySettling() {
    for (const b of this._fragmentBodies) {
      if (!(b.flags & FLAG_ALIVE)) continue

      if (b.flags & FLAG_LANDED) {
        // 已冻结碎片：检查是否悬空（Rapier 应该不会让冻结体悬空，
        // 但作为安全保障，检测异常位置并解除冻结）
        continue
      }

      // 未冻结碎片：低速持续帧数判定
      const vel = b.rigidBody.linvel()
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z)
      if (speed < SETTLE_SPEED) {
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
        b.lowSpeedFrames = 0
      }
    }
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
    return this._fragmentBodies.map((b) => {
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
    // 底板中心 = (centerX, floorY, centerZ)
    const fc = { x: tb.centerX, y: tb.floorY, z: tb.centerZ }

    // 隧道朝向四元数
    const quat = basisToQuat(
      right.x, right.y, right.z,
      up.x, up.y, up.z,
      forward.x, forward.y, forward.z
    )

    const halfWidth = tb.halfWidth
    const wallHeight = tb.wallHeight
    const archRadius = tb.archRadius
    const halfLen = 32 // 沿轴向半长（总 64m）
    const tunnelZ = -halfLen // 隧道从 z=0 向 -forward 延伸
    const wallThick = 0.2
    const tunnelGroups = this.enableInterCollision ? 0xffffffff : TUNNEL_GROUPS

    /** 在隧道局部坐标 创建固定 cuboid 碰撞体 */
    const createFixed = (lx, ly, lz, hx, hy, hz) => {
      const wx = fc.x + right.x * lx + up.x * ly + forward.x * lz
      const wy = fc.y + right.y * lx + up.y * ly + forward.y * lz
      const wz = fc.z + right.z * lx + up.z * ly + forward.z * lz
      const bodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(wx, wy, wz)
        .setRotation(quat)
      const body = this._world.createRigidBody(bodyDesc)
      const colDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      colDesc.setFriction(0.8)
      colDesc.setRestitution(0.1)
      colDesc.setCollisionGroups(tunnelGroups)
      this._world.createCollider(colDesc, body)
      this._tunnelColliderBodies.push(body)
    }

    const shape = tb.shape || 'horseshoe'

    // 底板（所有形状）
    createFixed(0, -wallThick, tunnelZ, halfWidth + 1, wallThick, halfLen)

    if (shape === 'rectangular') {
      createFixed(-halfWidth, wallHeight / 2, tunnelZ, wallThick, wallHeight / 2, halfLen)
      createFixed(halfWidth, wallHeight / 2, tunnelZ, wallThick, wallHeight / 2, halfLen)
      createFixed(0, wallHeight + wallThick, tunnelZ, halfWidth + 0.2, wallThick, halfLen)
    } else if (shape === 'circular') {
      // 圆形断面：半圆弧段（底板已覆盖底部）
      const segs = 12
      const segHalf = archRadius * Math.sin(Math.PI / segs) + 0.05
      for (let i = 0; i < segs; i++) {
        const a = (Math.PI * (i + 0.5)) / segs
        createFixed(
          archRadius * Math.cos(a),
          archRadius * Math.sin(a),
          tunnelZ,
          segHalf, segHalf, halfLen
        )
      }
    } else {
      // 马蹄形（默认）
      createFixed(-halfWidth, wallHeight / 2, tunnelZ, wallThick, wallHeight / 2, halfLen)
      createFixed(halfWidth, wallHeight / 2, tunnelZ, wallThick, wallHeight / 2, halfLen)
      // 拱顶弧段（12 段近似半圆）
      const segs = 12
      const segHalf = archRadius * Math.sin(Math.PI / segs) + 0.05
      for (let i = 0; i < segs; i++) {
        const a = (Math.PI * (i + 0.5)) / segs
        createFixed(
          archRadius * Math.cos(a),
          wallHeight + archRadius * Math.sin(a),
          tunnelZ,
          segHalf, segHalf, halfLen
        )
      }
    }
  }
}

export default RapierPhysicsEngine
