/**
 * 爆破碎片物理引擎
 *
 * 独立于渲染的物理模拟模块，管理 200+ 碎片的弹道轨迹、空气阻力、
 * 隧道壁碰撞、底板反弹和落地堆积。
 *
 * 物理模型：
 * - 重力：标准 9.8 m/s²
 * - 空气阻力：P-01 分段阻力模型（基于雷诺数自动选择湍流/过渡/层流）
 * - 隧道壁碰撞：按断面形状（马蹄形/圆形/矩形）约束碎片在截面内
 * - 底板碰撞：弹性反弹 + 能量衰减 + 摩擦力
 */

/**
 * 模型保真度声明（Model Fidelity Statement）
 * ============================================
 * 本引擎为手写物理引擎，未使用 cannon-es / rapier 等成熟第三方物理库。
 * 以下近似边界需在使用与维护时明确：
 *
 * 1. 碰撞形状近似：球体
 *    - 视觉 mesh 是块状/板状/楔形/不规则多面体（见 rockGeometryFactory.js）
 *    - 物理碰撞按等效球体计算（半径 = physSize/2）
 *    - 选择理由：球-球碰撞解析简单 O(n)，块体碰撞需 GJK/EPA 复杂算法
 *    - 已知偏差：块状碎片在斜面上堆积时视觉棱角与球面支撑不符，可能过度滚动
 *
 * 2. 积分方法：半隐式（辛）Euler + 自适应子步长
 *    - 先更新速度再用新速度更新位置，对保守系统是辛积分器（不泄漏能量）
 *    - 能量耗散仅来自空气阻力项（物理正确的耗散）
 *    - 自适应 1-8 子步，每子步最大位移 0.3m，防高速穿墙
 *    - 精度为一阶，对 200+ 碎片实时可视化是正确的精度-性能折中
 *
 * 3. 安息角判定：单点支撑启发式
 *    - 仅检查单一最近下方支撑，不考虑多接触点形成的稳定堆
 *    - 选择理由：多接触点判定计算量大，单点启发式已能形成视觉合理的堆积
 *    - 已知偏差：堆积形态偏松散，真实安息角应为多接触点稳定判定
 *
 * 4. 未使用第三方物理库
 *    - project_memory.md 历史条目提到的 cannon-es 集成未实际落地
 *    - 选择理由：手写引擎已能满足可视化需求，避免引入大型依赖
 *    - 未来升级方向：rapier-wasm（支持凸包碰撞体）或 cannon-es
 */

// ─── 物理常量 ──────────────────────────────────────────
const GRAVITY = 9.8

// 碎片间碰撞参数
const SPATIAL_HASH_CELL = 0.6  // 空间散列网格尺寸 ≈ 最大碎片直径
const RESTITUTION_INTER = 0.12 // 碎片间恢复系数（岩屑低弹性，快速堆积）
const FRICTION_INTER = 0.6     // 碎片间摩擦系数（高摩擦稳定堆积）
const ANGLE_OF_REPOSE = 37 * Math.PI / 180  // 安息角
const SETTLE_SPEED = 0.8       // 冻结速度阈值(m/s)（提高以加速堆积冻结）
const SETTLE_FRAMES = 3        // 持续低速帧数才冻结（降低以加速堆积冻结）

// 能量统计采样间隔（秒）：每 100ms 采样一次动能与堆积质量比，避免数组过大
const ENERGY_SAMPLE_INTERVAL = 0.1

// 空气动力学常量（原 particleSystemCore.js，内联以解除模块依赖）
const AIR_DENSITY = 1.225 // ρ_air (kg/m³, 海平面 15℃)
const AIR_KINEMATIC_VISC = 1.5e-5 // ν_air (m²/s, 运动粘度)
const SPHERE_DRAG_COEFF = 0.47 // 球体湍流区阻力系数 Cd

/**
 * 计算碎片在空气中受到的阻力加速度（P-01 分段阻力模型）
 * 基于雷诺数自动选择湍流/过渡/层流阻力系数：
 * - Re > 1e4：湍流区，Cd = 0.47（球体常数）
 * - 1 < Re <= 1e4：过渡区，Schiller-Naumann 关联式
 * - Re <= 1：Stokes 区，Cd = 24/Re
 * @param {number} vx - 速度 x 分量 (m/s)
 * @param {number} vy - 速度 y 分量 (m/s)
 * @param {number} vz - 速度 z 分量 (m/s)
 * @param {number} size - 等效直径 (m)
 * @param {number} mass - 质量 (kg)
 * @returns {{ax:number, ay:number, az:number}} 阻力加速度向量（与速度方向相反）
 */
function computeDragAccel(vx, vy, vz, size, mass) {
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz)
  if (v < 1e-6 || mass <= 0) return { ax: 0, ay: 0, az: 0 }
  const d = Math.max(0.01, size) // 等效直径
  const Re = (v * d) / AIR_KINEMATIC_VISC
  // 截面积（按球体）
  const area = Math.PI * (d / 2) * (d / 2)
  // 计算阻力系数 Cd
  let Cd
  if (Re > 1e4) {
    Cd = SPHERE_DRAG_COEFF
  } else if (Re > 1) {
    // Schiller-Naumann 关联式
    Cd = (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687))
  } else {
    // Stokes 区：等价 Cd = 24/Re，最终与 Fd = 3π·μ·d·v 一致
    Cd = 24 / Math.max(1e-3, Re)
  }
  // 阻力大小 Fd = ½·Cd·ρ·A·v²
  const Fd = 0.5 * Cd * AIR_DENSITY * area * v * v
  // 阻力加速度 a = Fd / m，方向与速度相反
  const a = Fd / mass
  const ax = -(a * vx) / v
  const ay = -(a * vy) / v
  const az = -(a * vz) / v
  return { ax, ay, az }
}

// ─── 身体状态标志位 ───────────────────────────────────
const FLAG_ALIVE = 0x01
const FLAG_LANDED = 0x02

/**
 * @typedef {Object} FragmentSpec
 * @property {number} physSize - 真实物理直径(m)
 * @property {number} dispSize - 显示缩放尺寸
 * @property {number} density - 岩石密度(kg/m³)
 * @property {number} restitution - 弹性恢复系数
 * @property {number} friction - 表面摩擦系数
 * @property {number} maxBounces - 最大反弹次数
 * @property {number} variantIndex - 几何体变体索引
 */

/**
 * @typedef {Object} BodyState - 对外导出的身体状态
 * @property {number} posX/posY/posZ - 世界坐标位置
 * @property {number} quatX/quatY/quatZ/quatW - 四元数旋转
 * @property {number} size - 显示尺寸
 * @property {number} alive - 是否存活
 * @property {number} landed - 是否已落地
 */

export class BlastPhysicsEngine {
  constructor(config = {}) {
    this.gravity = config.gravity ?? GRAVITY
    this.enableInterCollision = config.enableInterCollision ?? true
    // 可注入的伪随机数生成器，默认 Math.random；传入种子化 RNG 可实现确定性复现
    this._rng = config.rng || Math.random

    /** @type {PhysicsBody[]} */
    this.bodies = []
    this.activeCount = 0
    this.simTime = 0

    // 能量统计：采样数组与上次采样时间
    this._energyTimeSeries = []
    this._lastSampleTime = 0

    // 隧道边界（由 setTunnelBounds 设置）
    this._tunnelBounds = null

    // 碎片落地回调
    this.onBodyLanded = null
  }

  /**
   * 设置隧道截面边界（用于碰撞检测）
   * @param {Object} bounds
   * @param {number} bounds.centerX/Y/Z - 隧道截面中心世界坐标
   * @param {number} bounds.rightX/Y/Z - 横向单位向量
   * @param {number} bounds.forwardX/Y/Z - 轴向单位向量
   * @param {number} bounds.halfWidth - 直墙半宽
   * @param {number} bounds.wallHeight - 直墙高度（从底板起）
   * @param {number} bounds.archRadius - 拱顶半径
   * @param {number} bounds.floorY - 底板 Y 坐标
   * @param {string} bounds.shape - 断面形状 'horseshoe'|'circular'|'rectangular'
   */
  setTunnelBounds(bounds) {
    this._tunnelBounds = bounds
  }

  /**
   * 用碎片规格初始化物理引擎
   * @param {FragmentSpec[]} specs - 碎片规格数组（可含 delayTime 字段实现分段起爆）
   * @param {Array<{x:number,y:number,z:number}>} positions - 初始位置（世界坐标）
   * @param {Array<{x:number,y:number,z:number}>} velocities - 初始速度（世界坐标）
   */
  init(specs, positions, velocities) {
    this.bodies = []
    this.activeCount = 0
    this.simTime = 0
    // 清空能量统计
    this._energyTimeSeries = []
    this._lastSampleTime = 0

    const count = Math.min(specs.length, positions.length, velocities.length)
    for (let i = 0; i < count; i++) {
      const s = specs[i]
      const p = positions[i]
      const v = velocities[i]
      // 防御：physSize 为 0/负数/NaN 时会导致 mass=0，后续 1/mass=Infinity 产生 NaN 扩散
      const physSize = Math.max(0.01, Number(s.physSize) || 0.01)
      const density = Math.max(100, Number(s.density) || 2700)
      const mass = density * (4 / 3) * Math.PI * Math.pow(physSize / 2, 3)

      const body = {
        posX: p.x, posY: p.y, posZ: p.z,
        velX: v.x, velY: v.y, velZ: v.z,
        physSize,
        mass,
        quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
        angVelX: (this._rng() - 0.5) * 8,
        angVelY: (this._rng() - 0.5) * 8,
        angVelZ: (this._rng() - 0.5) * 8,
        restitution: s.restitution ?? 0.15,
        friction: s.friction ?? 0.7,
        bounceCount: 0,
        maxBounces: s.maxBounces ?? 2,
        // 分段起爆：delayTime > 0 的碎片在 simTime < delayTime 时不参与物理更新
        // 由 step() 中的 delayTime 检查实现，初始时若 simTime < delayTime 则标记为未激活
        delayTime: Math.max(0, Number(s.delayTime) || 0),
        flags: FLAG_ALIVE, // 初始化时 alive=true
        landTriggered: false // 首次落地是否已触发回调
      }
      // 若有延迟，且当前 simTime < delayTime，标记为休眠（清除 ALIVE 标志）
      // activateAll() 不会立即激活有 delayTime 的碎片，而是由 step() 在 simTime >= delayTime 时激活
      if (body.delayTime > 0) {
        body.flags &= ~FLAG_ALIVE // 休眠，等待 delayTime 到达后由 step() 激活
        body._delayed = true // 标记为延迟碎片（step 中识别）
      }
      this.bodies.push(body)
    }
    this.activeCount = count
  }

  /**
   * 激活所有身体（爆破触发时调用）
   * 延迟碎片（delayTime > 0）不立即激活，由 step() 在 simTime >= delayTime 时自动激活，
   * 实现分段起爆的视觉效果
   */
  activateAll() {
    for (const b of this.bodies) {
      if (b._delayed) continue // 延迟碎片保持休眠，等待 step() 到时激活
      b.flags |= FLAG_ALIVE
    }
  }

  /**
   * 推进物理模拟一步
   * 修正：原实现用单步显式 Euler 积分，dt=0.05 + v=30m/s 时单步位移 1.5m，
   * 超过空间散列网格尺寸(0.6m)导致碎片穿墙。改为根据最大速度自适应子步长。
   * @param {number} dt - 时间步长(s)
   */
  step(dt) {
    if (dt <= 0) return
    this.simTime += dt

    // 计算最大速度，确定子步长（防止高速碎片穿墙）
    // 每子步最大位移限制为 0.3m（小于空间散列网格 0.6m 的一半）
    let maxV2 = 0
    for (const b of this.bodies) {
      if (!(b.flags & FLAG_ALIVE) || (b.flags & FLAG_LANDED)) continue
      const v2 = b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ
      if (v2 > maxV2) maxV2 = v2
    }
    const maxV = Math.sqrt(maxV2)
    const subSteps = Math.min(8, Math.max(1, Math.ceil((maxV * dt) / 0.3)))
    const subDt = dt / subSteps

    for (let s = 0; s < subSteps; s++) {
      this._integrate(subDt)
    }

    // 碎片间碰撞 + 安息角堆积（每帧一次，避免子步内重复计算开销）
    // 统一构建一次空间散列 grid，复用给碰撞解析与安息角判定（原为各自构建一次）
    if (this.enableInterCollision && this.bodies.length > 1) {
      const grid = this._buildSpatialHash()
      this._resolveInterCollisions(grid)
      this._applyReposeSettling(grid)
    }

    // 能量统计采样：每 ENERGY_SAMPLE_INTERVAL 秒记录一次总动能与堆积质量比
    if (this.simTime - this._lastSampleTime >= ENERGY_SAMPLE_INTERVAL) {
      let totalKE = 0
      let settledMass = 0
      let totalMass = 0
      for (const b of this.bodies) {
        if (!(b.flags & FLAG_ALIVE)) continue
        const speed2 = b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ
        totalKE += 0.5 * b.mass * speed2
        totalMass += b.mass
        if (b.flags & FLAG_LANDED) {
          settledMass += b.mass
        }
      }
      this._energyTimeSeries.push({
        t: this.simTime,
        kineticEnergy: totalKE,
        settledMassRatio: totalMass > 0 ? settledMass / totalMass : 0
      })
      this._lastSampleTime = this.simTime
    }
  }

  /**
   * 单步积分：重力 + 空气阻力 + 位置积分 + 碰撞 + 旋转
   * @param {number} dt - 子步长(s)
   */
  _integrate(dt) {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]

      // 分段起爆：延迟碎片到时激活
      if (b._delayed && !(b.flags & FLAG_ALIVE)) {
        if (this.simTime >= b.delayTime) {
          b.flags |= FLAG_ALIVE
          b._delayed = false
        } else {
          continue // 未到起爆时间，跳过
        }
      }

      if (!(b.flags & FLAG_ALIVE)) continue
      if (b.flags & FLAG_LANDED) continue

      // 1. 重力
      b.velY -= this.gravity * dt

      // 2. P-01 分段空气阻力
      if (b.physSize > 0.01 && b.mass > 0) {
        const drag = computeDragAccel(b.velX, b.velY, b.velZ, b.physSize, b.mass)
        b.velX += drag.ax * dt
        b.velY += drag.ay * dt
        b.velZ += drag.az * dt
      }

      // 3. 位置积分
      b.posX += b.velX * dt
      b.posY += b.velY * dt
      b.posZ += b.velZ * dt

      // 4. 隧道壁碰撞
      if (this._tunnelBounds) {
        this._resolveWallCollision(b)
      }

      // 5. 底板碰撞（先检查，因为碰撞解析可能要求取 tunnelBounds）
      if (this._tunnelBounds) {
        this._resolveFloorCollision(b)
      } else {
        // 无隧道边界时的简单底板碰撞
        if (b.posY <= 0) {
          b.posY = 0
          if (b.velY < 0) {
            b.bounceCount++
            const restitutionScale = Math.pow(0.75, b.bounceCount - 1)
            b.velY = -b.velY * b.restitution * restitutionScale
            b.velX *= (1 - b.friction * 0.5)
            b.velZ *= (1 - b.friction * 0.5)
            const speed = Math.sqrt(b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ)
            if (b.bounceCount >= b.maxBounces || speed < 1.5) {
              b.flags |= FLAG_LANDED
              b.velX = b.velY = b.velZ = 0
              if (this.onBodyLanded && !b.landTriggered) {
                b.landTriggered = true
                this.onBodyLanded(b, speed)
              }
            }
          }
        }
      }

      // 6. 旋转更新（3D 四元数积分）
      const aSpeed = Math.sqrt(
        b.angVelX * b.angVelX + b.angVelY * b.angVelY + b.angVelZ * b.angVelZ
      )
      if (aSpeed > 0.001) {
        const halfAngle = aSpeed * dt * 0.5
        const sinHalf = Math.sin(halfAngle) / aSpeed
        const dqx = b.angVelX * sinHalf
        const dqy = b.angVelY * sinHalf
        const dqz = b.angVelZ * sinHalf
        const dqw = Math.cos(halfAngle)
        // quat' = dq * quat
        const qx = dqw * b.quatX + dqx * b.quatW + dqy * b.quatZ - dqz * b.quatY
        const qy = dqw * b.quatY - dqx * b.quatZ + dqy * b.quatW + dqz * b.quatX
        const qz = dqw * b.quatZ + dqx * b.quatY - dqy * b.quatX + dqz * b.quatW
        const qw = dqw * b.quatW - dqx * b.quatX - dqy * b.quatY - dqz * b.quatZ
        const invNorm = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        b.quatX = qx * invNorm
        b.quatY = qy * invNorm
        b.quatZ = qz * invNorm
        b.quatW = qw * invNorm
      }
    }
  }

  /**
   * 碎片间碰撞检测与响应（空间散列加速，O(N) 复杂度）
   * 落地碎片作为静态支撑（不移动），飞行碎片与落地碎片碰撞时仅飞行碎片响应
   * @param {Map} grid - 由 step() 统一构建的空间散列网格（复用避免重复构建）
   */
  _resolveInterCollisions(grid) {
    for (let i = 0; i < this.bodies.length; i++) {
      const a = this.bodies[i]
      if (!(a.flags & FLAG_ALIVE)) continue
      const aLanded = !!(a.flags & FLAG_LANDED)
      const neighbors = this._queryNeighbors(grid, a)
      for (const b of neighbors) {
        if (b === a) continue
        // 去重：仅处理 b 的 body 索引 > i 的对，避免同一对碰撞被双向解析两次
        if (b._idx <= i) continue
        const bLanded = !!(b.flags & FLAG_LANDED)
        // 两个落地碎片不互撞（静态）
        if (aLanded && bLanded) continue
        this._resolvePairCollision(a, b, aLanded, bLanded)
      }
    }
  }

  /**
   * 构建空间散列网格
   * 同时为每个 body 记录 _idx（在 bodies 数组中的索引），供 _resolveInterCollisions 去重
   */
  _buildSpatialHash() {
    const grid = new Map()
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]
      if (!(b.flags & FLAG_ALIVE)) continue
      b._idx = i
      const key = this._hashKey(b.posX, b.posY, b.posZ)
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key).push(b)
    }
    return grid
  }

  _hashKey(x, y, z) {
    return `${Math.floor(x / SPATIAL_HASH_CELL)},${Math.floor(y / SPATIAL_HASH_CELL)},${Math.floor(z / SPATIAL_HASH_CELL)}`
  }

  _queryNeighbors(grid, b) {
    const cx = Math.floor(b.posX / SPATIAL_HASH_CELL)
    const cy = Math.floor(b.posY / SPATIAL_HASH_CELL)
    const cz = Math.floor(b.posZ / SPATIAL_HASH_CELL)
    const out = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (arr) out.push(...arr)
        }
      }
    }
    return out
  }

  /**
   * 解析一对碎片间的碰撞（球-球碰撞 + impulse-based 响应）
   * @param {Object} a - 碎片 A
   * @param {Object} b - 碎片 B
   * @param {boolean} aStatic - A 是否静态（已落地）
   * @param {boolean} bStatic - B 是否静态（已落地）
   */
  _resolvePairCollision(a, b, aStatic, bStatic) {
    const dx = b.posX - a.posX
    const dy = b.posY - a.posY
    const dz = b.posZ - a.posZ
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const radiusA = a.physSize * 0.5
    const radiusB = b.physSize * 0.5
    const minDist = radiusA + radiusB
    if (dist >= minDist || dist < 1e-6) return

    // 法向量
    const nx = dx / dist
    const ny = dy / dist
    const nz = dz / dist
    const overlap = minDist - dist

    // 位置修正（解决穿透）：静态碎片不移动
    if (aStatic && !bStatic) {
      b.posX += nx * overlap
      b.posY += ny * overlap
      b.posZ += nz * overlap
    } else if (bStatic && !aStatic) {
      a.posX -= nx * overlap
      a.posY -= ny * overlap
      a.posZ -= nz * overlap
    } else if (!aStatic && !bStatic) {
      // 守卫：mass <= 0 时跳过位置修正（避免 0/0 = NaN 扩散）
      const ma = a.mass, mb = b.mass
      const total = ma + mb
      if (total > 1e-9) {
        a.posX -= nx * overlap * (mb / total)
        a.posY -= ny * overlap * (mb / total)
        a.posZ -= nz * overlap * (mb / total)
        b.posX += nx * overlap * (ma / total)
        b.posY += ny * overlap * (ma / total)
        b.posZ += nz * overlap * (ma / total)
      }
    }

    // 相对速度沿法向分量
    const rvx = b.velX - a.velX
    const rvy = b.velY - a.velY
    const rvz = b.velZ - a.velZ
    const velAlongNormal = rvx * nx + rvy * ny + rvz * nz
    if (velAlongNormal > 0) return  // 已分离

    // 冲量计算（静态碎片视为无限质量，invMass=0）
    // 守卫：mass <= 0 时 invMass 视为 0，避免 1/0 = Infinity 产生 NaN
    const invMassA = (aStatic || !(a.mass > 0)) ? 0 : 1 / a.mass
    const invMassB = (bStatic || !(b.mass > 0)) ? 0 : 1 / b.mass
    const invSum = invMassA + invMassB
    if (invSum < 1e-6) return

    const j = -(1 + RESTITUTION_INTER) * velAlongNormal / invSum
    a.velX -= j * nx * invMassA
    a.velY -= j * ny * invMassA
    a.velZ -= j * nz * invMassA
    b.velX += j * nx * invMassB
    b.velY += j * ny * invMassB
    b.velZ += j * nz * invMassB

    // 切向摩擦（库仑锥夹紧）
    // 正确做法：先计算无系数切向冲量 jt_raw，再夹紧到 |jt| ≤ μ·|j_n|
    const tx = rvx - velAlongNormal * nx
    const ty = rvy - velAlongNormal * ny
    const tz = rvz - velAlongNormal * nz
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz)
    if (tLen > 1e-6) {
      const jtRaw = -tLen / invSum            // 无系数切向冲量
      const jtMax = FRICTION_INTER * Math.abs(j)  // 库仑锥上限 μ·|j_n|
      // 夹紧：库仑锥内取 jtRaw，锥外取 ±jtMax
      const jt = Math.max(-jtMax, Math.min(jtMax, jtRaw))
      a.velX -= (tx / tLen) * jt * invMassA
      a.velY -= (ty / tLen) * jt * invMassA
      a.velZ -= (tz / tLen) * jt * invMassA
      b.velX += (tx / tLen) * jt * invMassB
      b.velY += (ty / tLen) * jt * invMassB
      b.velZ += (tz / tLen) * jt * invMassB
    }
  }

  /**
   * 安息角堆积判定
   * 落地碎片检测下方支撑：若水平偏移与垂直落差构成的斜率超过安息角，解除 LANDED 状态让其沿斜面下滑
   * 飞行碎片速度低于阈值且持续 SETTLE_FRAMES 帧时冻结
   * @param {Map} grid - 由 step() 统一构建的空间散列网格（复用避免重复构建）
   */
  _applyReposeSettling(grid) {
    for (const b of this.bodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const landed = !!(b.flags & FLAG_LANDED)

      if (landed) {
        // 落地碎片：检查是否处于不稳定斜面（安息角判定）
        const neighbors = this._queryNeighbors(grid, b)
        let support = null
        let minHoriz = Infinity
        for (const n of neighbors) {
          if (n === b) continue
          if (!(n.flags & FLAG_LANDED)) continue
          if (n.posY >= b.posY) continue  // 仅看下方
          const horiz = Math.sqrt((n.posX - b.posX) ** 2 + (n.posZ - b.posZ) ** 2)
          if (horiz < minHoriz) { minHoriz = horiz; support = n }
        }
        if (support && minHoriz > 0.01) {
          const radiusSum = b.physSize * 0.5 + support.physSize * 0.5
          const verticalDrop = b.posY - support.posY - radiusSum
          if (verticalDrop > 0.01) {
            const slopeAngle = Math.atan2(verticalDrop, minHoriz)
            if (slopeAngle > ANGLE_OF_REPOSE) {
              // 解除 LANDED，让其沿斜面下滑
              b.flags &= ~FLAG_LANDED
              b.velX = (b.posX - support.posX) * 0.5
              b.velZ = (b.posZ - support.posZ) * 0.5
              b.velY = 0
              b.lowSpeedFrames = 0
            }
          }
        } else if (!support) {
          // 修正：下方完全无支撑（悬空）但被标记为 LANDED 的碎片会永久悬浮
          // 检查是否在底板之上，如果是则解除 LANDED 让它重新下落
          const tb = this._tunnelBounds
          const fragR = b.physSize * 0.5
          const floorY = tb ? tb.floorY : 0
          if (b.posY > floorY + fragR + 0.1) {
            b.flags &= ~FLAG_LANDED
            b.velX = 0; b.velY = 0; b.velZ = 0
            b.lowSpeedFrames = 0
          }
        }
      } else {
        // 飞行碎片：低速持续帧数判定后才冻结（避免立即冻结导致漂浮）
        const speed = Math.sqrt(b.velX ** 2 + b.velY ** 2 + b.velZ ** 2)
        if (speed < SETTLE_SPEED) {
          b.lowSpeedFrames = (b.lowSpeedFrames || 0) + 1
          if (b.lowSpeedFrames >= SETTLE_FRAMES) {
            b.flags |= FLAG_LANDED
            b.velX = b.velY = b.velZ = 0
            b.angVelX *= 0.1; b.angVelY *= 0.1; b.angVelZ *= 0.1
          }
        } else {
          b.lowSpeedFrames = 0
        }
      }
    }
  }

  /**
   * 隧道壁碰撞检测与响应
   */
  _resolveWallCollision(b) {
    const tb = this._tunnelBounds
    const fragR = b.physSize * 0.5
    const shape = tb.shape || 'horseshoe'

    // 碎片相对于隧道截面中心的位置
    const rx = b.posX - tb.centerX
    const ry = b.posY - tb.centerY
    const rz = b.posZ - tb.centerZ
    // 横向投影
    const lateral = rx * tb.rightX + ry * tb.rightY + rz * tb.rightZ
    const y = b.posY

    if (shape === 'circular') {
      const dy = y - (tb.floorY + tb.archRadius)
      const dist = Math.sqrt(lateral * lateral + dy * dy)
      const limit = tb.archRadius - fragR
      if (dist > limit && dist > 0.001) {
        const scale = limit / dist
        const newLat = lateral * scale
        const newDy = dy * scale
        const dLat = newLat - lateral
        b.posX += tb.rightX * dLat
        b.posY += -dy + newDy  // 更准确：修正 y 偏移
        b.posZ += tb.rightZ * dLat
        // 反射速度
        const nx = lateral / dist * tb.rightX
        const ny = dy / dist
        const nz = lateral / dist * tb.rightZ
        const vn = b.velX * nx + b.velY * ny + b.velZ * nz
        if (vn < 0) {
          const refl = b.restitution * 0.6
          b.velX -= (1 + refl) * vn * nx
          b.velY -= (1 + refl) * vn * ny
          b.velZ -= (1 + refl) * vn * nz
        }
      }
      return
    }

    if (shape === 'rectangular') {
      const halfW = tb.halfWidth - fragR
      const topY = tb.floorY + tb.wallHeight - fragR
      if (lateral > halfW) {
        const d = -(lateral - halfW)
        b.posX += tb.rightX * d; b.posZ += tb.rightZ * d
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ  // 先缓存，避免修改后复用
        if (latVel > 0) {
          b.velX -= tb.rightX * latVel * (1 + b.restitution * 0.6)
          b.velZ -= tb.rightZ * latVel * (1 + b.restitution * 0.6)
        }
      }
      if (lateral < -halfW) {
        const d = -(lateral + halfW)
        b.posX += tb.rightX * d; b.posZ += tb.rightZ * d
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ
        if (latVel < 0) {
          b.velX -= tb.rightX * latVel * (1 + b.restitution * 0.6)
          b.velZ -= tb.rightZ * latVel * (1 + b.restitution * 0.6)
        }
      }
      if (y > topY) {
        b.posY = topY
        if (b.velY > 0) b.velY = -b.velY * b.restitution * 0.6
      }
      return
    }

    // 默认：马蹄形断面
    if (y <= tb.wallHeight) {
      // 直墙区
      const wallLimit = tb.halfWidth - fragR
      if (lateral > wallLimit) {
        const d = -(lateral - wallLimit)
        b.posX += tb.rightX * d; b.posZ += tb.rightZ * d
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ
        if (latVel > 0) {
          b.velX -= tb.rightX * latVel * (1 + b.restitution * 0.6)
          b.velZ -= tb.rightZ * latVel * (1 + b.restitution * 0.6)
        }
      } else if (lateral < -wallLimit) {
        const d = -(lateral + wallLimit)
        b.posX += tb.rightX * d; b.posZ += tb.rightZ * d
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ
        if (latVel < 0) {
          b.velX -= tb.rightX * latVel * (1 + b.restitution * 0.6)
          b.velZ -= tb.rightZ * latVel * (1 + b.restitution * 0.6)
        }
      }
    } else {
      // 拱顶区
      // 实际拱顶中心 y0 = floorY + wallHeight (拱从直墙顶部开始)
      const y0 = tb.floorY + tb.wallHeight
      const archDY = y - y0
      const dist = Math.sqrt(lateral * lateral + archDY * archDY)
      const limit = tb.archRadius - fragR
      if (dist > limit && dist > 0.001) {
        const scale = limit / dist
        const newLat = lateral * scale
        const newArchDY = archDY * scale
        const dLat = newLat - lateral
        b.posX += tb.rightX * dLat
        b.posZ += tb.rightZ * dLat
        b.posY = y0 + newArchDY
        // 法向反射
        const nx = lateral / dist * tb.rightX
        const nz = lateral / dist * tb.rightZ
        const ny = archDY / dist
        const vn = b.velX * nx + b.velY * ny + b.velZ * nz
        if (vn < 0) {
          const refl = b.restitution * 0.6
          b.velX -= (1 + refl) * vn * nx
          b.velY -= (1 + refl) * vn * ny
          b.velZ -= (1 + refl) * vn * nz
        }
      }
    }
  }

  /**
   * 底板碰撞检测与反弹
   */
  _resolveFloorCollision(b) {
    const tb = this._tunnelBounds
    const fragR = b.physSize * 0.5
    const floorThreshold = tb.floorY + fragR

    if (b.posY <= floorThreshold) {
      b.posY = floorThreshold
      if (b.velY < 0) {
        b.bounceCount++
        const restitutionScale = Math.pow(0.75, b.bounceCount - 1)
        b.velY = -b.velY * b.restitution * restitutionScale
        b.velX *= (1 - b.friction * 0.5)
        b.velZ *= (1 - b.friction * 0.5)
        // 随机水平偏转（模拟撞击不平整面）
        const speed = Math.sqrt(b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ)
        const deflectAngle = this._rng() * Math.PI * 2
        const deflectStr = Math.min(0.5, speed * 0.015)
        b.velX += Math.cos(deflectAngle) * speed * deflectStr
        b.velZ += Math.sin(deflectAngle) * speed * deflectStr

        if (b.bounceCount >= b.maxBounces || (Math.abs(b.velY) < 0.8 && speed < 1.5)) {
          b.flags |= FLAG_LANDED
          b.velX = b.velY = b.velZ = 0
          b.angVelX *= 0.1; b.angVelY *= 0.1; b.angVelZ *= 0.1
          if (this.onBodyLanded && !b.landTriggered) {
            b.landTriggered = true
            this.onBodyLanded(b, speed)
          }
        }
      }
    }
  }

  /**
   * 获取所有身体状态（供渲染器使用）
   * @returns {BodyState[]}
   */
  getBodyStates() {
    return this.bodies.map(b => ({
      posX: b.posX, posY: b.posY, posZ: b.posZ,
      quatX: b.quatX, quatY: b.quatY, quatZ: b.quatZ, quatW: b.quatW,
      alive: !!(b.flags & FLAG_ALIVE),
      landed: !!(b.flags & FLAG_LANDED),
      physSize: b.physSize
    }))
  }

  /**
   * 获取存活碎片数量
   */
  get aliveFragmentCount() {
    let c = 0
    for (const b of this.bodies) {
      if (b.flags & FLAG_ALIVE) c++
    }
    return c
  }

  /**
   * 获取已落地碎片数量
   */
  get landedFragmentCount() {
    let c = 0
    for (const b of this.bodies) {
      if (b.flags & FLAG_LANDED) c++
    }
    return c
  }

  /**
   * 获取能量统计：当前总动能、已落地质量占比、时间序列
   * 供诊断面板展示能量衰减曲线和堆积一致性。
   * @returns {{totalKineticEnergy:number, settledMassRatio:number, timeSeries:Array<{t:number,kineticEnergy:number,settledMassRatio:number}>}}
   */
  getEnergyStats() {
    let totalKE = 0
    let settledMass = 0
    let totalMass = 0
    for (const b of this.bodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const speed2 = b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ
      totalKE += 0.5 * b.mass * speed2
      totalMass += b.mass
      if (b.flags & FLAG_LANDED) {
        settledMass += b.mass
      }
    }
    return {
      totalKineticEnergy: totalKE,
      settledMassRatio: totalMass > 0 ? settledMass / totalMass : 0,
      timeSeries: this._energyTimeSeries
    }
  }

  /**
   * 重置引擎
   */
  reset() {
    this.bodies = []
    this.activeCount = 0
    this.simTime = 0
    // 清空能量统计
    this._energyTimeSeries = []
    this._lastSampleTime = 0
  }
}

export default BlastPhysicsEngine
