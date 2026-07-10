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
 * - 爆生气膨胀：JWL 状态方程驱动的持续推力（0-100ms）
 */

import { computeGasThrustAccel } from './gasExpansionModel.js'
import { GAS_EFFECTIVE_TIME } from './blastConstants.js'

/**
 * mulberry32 伪随机数生成器
 * @param {number} seed - 种子（32位整数）
 * @returns {Function} 返回 [0,1) 随机数的函数
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── 物理常量 ──────────────────────────────────────────
const GRAVITY = 9.8

// 碎片间碰撞参数
const SPATIAL_HASH_CELL = 0.6  // 空间散列网格尺寸 ≈ 最大碎片直径
const RESTITUTION_INTER = 0.2  // 碎片间恢复系数（岩屑低弹性）
const FRICTION_INTER = 0.4     // 碎片间摩擦系数
const ANGLE_OF_REPOSE = 37 * Math.PI / 180  // 安息角
const SETTLE_SPEED = 0.3       // 冻结速度阈值(m/s)（堆积上方碎片速度通常 0.1-0.3，提高阈值让碎片更快凝固堆积）
const SETTLE_FRAMES = 5        // 持续低速帧数才冻结（5帧≈83ms，平衡堆积稳定性与响应速度）
const DEEP_SLEEP_FRAMES = 60   // LANDED 后延迟深度休眠（60帧≈1s，让碎片充分参与碰撞堆积后再冻结）
const WAKE_IMPULSE_THRESHOLD = 2.0  // 唤醒休眠碎片的最小碰撞冲量(N·s)

// 粘滞区判定参数（阶段三）
const STICK_VELOCITY_THRESHOLD = 0.05  // m/s，相对速度阈值
const STICK_IMPULSE_THRESHOLD = 0.5    // N·s，法向冲量阈值

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
 * 库仑摩擦堆积判定（阶段三）
 *
 * 用静力学平衡替代固定角度阈值。改用"重心差法"：
 * 取支撑碎片群重心到当前碎片位置的水平向量作为下坡方向，
 * 省去特征值求解，对稀疏支撑更稳健。
 *
 * @param {Object} body - 待判定的碎片
 * @param {Array<Object>} supportBodies - 下方已落地的支撑碎片
 * @returns {{ shouldSlide: boolean, slideDir: {x,y,z}, theta: number }}
 */
function computeCoulombSlide(body, supportBodies) {
  if (supportBodies.length === 0) {
    // 无支撑 → 自由下落
    return { shouldSlide: true, slideDir: { x: 0, y: -1, z: 0 }, theta: Math.PI / 2 }
  }

  // 1. 计算支撑碎片群的质心
  const n = supportBodies.length
  let cx = 0, cy = 0, cz = 0
  for (const s of supportBodies) {
    cx += s.posX; cy += s.posY; cz += s.posZ
  }
  cx /= n; cy /= n; cz /= n

  // 2. 下坡方向：从支撑质心指向当前碎片（水平投影）
  const horizDX = body.posX - cx
  const horizDZ = body.posZ - cz
  const horizMag = Math.sqrt(horizDX * horizDX + horizDZ * horizDZ)

  // 3. 垂直落差：碎片与支撑质心的高度差
  const verticalDrop = body.posY - cy

  // 4. 坡角 θ = atan2(水平偏移, 垂直落差)
  //    若垂直落差 ≤ 0（碎片低于支撑），视为平铺，不滑动
  if (verticalDrop <= 0.01) {
    return { shouldSlide: false, slideDir: { x: 0, y: 0, z: 0 }, theta: 0 }
  }
  const theta = Math.atan2(horizMag, verticalDrop)

  // 5. 单位下坡方向（水平）
  const slideDX = horizMag > 1e-6 ? horizDX / horizMag : 0
  const slideDZ = horizMag > 1e-6 ? horizDZ / horizMag : 0

  // 6. 力平衡判定（库仑摩擦）
  //    F_drive = mg·sin(θ) > F_f_max = μ_s·mg·cos(θ)
  //    ⇒ tan(θ) > μ_s
  const mu_s = body.interFriction || 0.34
  const shouldSlide = Math.tan(theta) > mu_s

  // 7. 滑动方向单位向量：水平分量乘 cos(θ)，垂直分量为 -sin(θ)
  //    验证 slideDir 为单位向量：|slideDir|² = cos²(θ)*(dirX²+dirZ²) + sin²(θ) = cos²(θ)*1 + sin²(θ) = 1
  // console.assert(Math.abs((cosTheta*slideDX)**2 + Math.sin(theta)**2 + (cosTheta*slideDZ)**2 - 1) < 1e-6, 'slideDir must be unit vector')
  const cosTheta = Math.cos(theta)
  return {
    shouldSlide,
    slideDir: { x: cosTheta * slideDX, y: -Math.sin(theta), z: cosTheta * slideDZ },
    theta
  }
}

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

    // 确定性模式：传入 randomSeed 时使用 mulberry32 PRNG，否则回退到 Math.random
    // 验证方法：构造两个 BlastPhysicsEngine({randomSeed: 42})，用相同 specs/positions/velocities
    // 初始化，调用 step(0.05) 共 10 步，对比 bodyStates 完全一致（已验证通过）。
    this._rng = config.randomSeed != null ? mulberry32(config.randomSeed) : Math.random

    /** @type {PhysicsBody[]} */
    this.bodies = []
    this.activeCount = 0
    this.simTime = 0
    this._gasExpansionTime = 0  // 重置爆生气累计时间

    // 隧道边界（由 setTunnelBounds 设置）
    this._tunnelBounds = null

    // 碎片落地回调
    this.onBodyLanded = null

    // ─── 爆生气膨胀配置（阶段二） ──────────────────────
    this._gasExpansionEnabled = config.gasExpansionEnabled ?? true
    this._gasExpansionTime = 0          // 气体膨胀累计时间（秒，按子步推进）
    this._blastCenterX = 0
    this._blastCenterY = 0
    this._blastCenterZ = 0
    this._chargeVolume = 0              // 装药体积(m³) = chargeKg / explosiveDensity
    this._chargeLength = 3.0            // 装药长度(m)，用于近场/远场判定
    this._explosiveType = 'emulsion'
    this._throwDirX = 0
    this._throwDirY = 0
    this._throwDirZ = 1                 // 默认 Z+（隧道开挖方向）
  }

  /**
   * 设置爆生气膨胀配置（爆破触发前调用）
   * @param {Object} cfg
   * @param {number} [cfg.blastCenterX/Y/Z] - 爆心世界坐标
   * @param {number} [cfg.chargeVolume] - 装药体积(m³)
   * @param {number} [cfg.chargeLength] - 装药长度(m)
   * @param {string} [cfg.explosiveType] - 炸药类型 'emulsion'|'anfo'|'dynamite'
   * @param {number} [cfg.throwDirX/Y/Z] - 抛掷方向单位向量
   * @param {boolean} [cfg.enabled] - 是否启用气体膨胀
   */
  setBlastConfig(cfg = {}) {
    if (cfg.blastCenterX !== undefined) this._blastCenterX = cfg.blastCenterX
    if (cfg.blastCenterY !== undefined) this._blastCenterY = cfg.blastCenterY
    if (cfg.blastCenterZ !== undefined) this._blastCenterZ = cfg.blastCenterZ
    if (cfg.chargeVolume !== undefined) this._chargeVolume = Math.max(1e-6, cfg.chargeVolume)
    if (cfg.chargeLength !== undefined) this._chargeLength = Math.max(0.1, cfg.chargeLength)
    if (cfg.explosiveType !== undefined) this._explosiveType = cfg.explosiveType
    if (cfg.throwDirX !== undefined) this._throwDirX = cfg.throwDirX
    if (cfg.throwDirY !== undefined) this._throwDirY = cfg.throwDirY
    if (cfg.throwDirZ !== undefined) this._throwDirZ = cfg.throwDirZ
    if (cfg.enabled !== undefined) this._gasExpansionEnabled = !!cfg.enabled
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
    this._gasExpansionTime = 0  // 重置爆生气累计时间

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
        // 初始角速度 ±6 rad/s（碎片飞出时高速翻滚，视觉上明显可见）
        angVelX: (this._rng() - 0.5) * 12,
        angVelY: (this._rng() - 0.5) * 12,
        angVelZ: (this._rng() - 0.5) * 12,
        restitution: s.restitution ?? 0.38,
        friction: s.friction ?? 0.5,
        // 尺寸相关碰撞物性（阶段一新增）
        interRestitution: s.interRestitution ?? RESTITUTION_INTER,
        interFriction: s.interFriction ?? FRICTION_INTER,
        collisionRadiusScale: s.collisionRadiusScale ?? 1.0,
        bounceCount: 0,
        maxBounces: s.maxBounces ?? 4,
        // 分段起爆：delayTime > 0 的碎片在 simTime < delayTime 时不参与物理更新
        delayTime: Math.max(0, Number(s.delayTime) || 0),
        flags: FLAG_ALIVE, // 初始化时 alive=true
        landTriggered: false, // 首次落地是否已触发回调
        lowSpeedFrames: 0,    // 低速持续帧数
        settledFrames: 0      // 连续 LANDED 帧数（深度休眠计数）
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
    if (this.enableInterCollision && this.bodies.length > 1) {
      this._resolveInterCollisions()
      this._applyReposeSettling()
    }
  }

  /**
   * 单步积分：重力 + 空气阻力 + 爆生气推力 + 位置积分 + 碰撞 + 旋转
   * @param {number} dt - 子步长(s)
   */
  _integrate(dt) {
    const gasActive = this._gasExpansionEnabled && this._gasExpansionTime < GAS_EFFECTIVE_TIME
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

      // 2.5 JWL 爆生气膨胀推力（仅前 100ms，对飞行中的碎片施加径向推力）
      if (gasActive && this._chargeVolume > 0) {
        const gas = computeGasThrustAccel({
          posX: b.posX, posY: b.posY, posZ: b.posZ,
          blastCX: this._blastCenterX, blastCY: this._blastCenterY, blastCZ: this._blastCenterZ,
          physSize: b.physSize, mass: b.mass, simTime: this._gasExpansionTime,
          chargeVolume: this._chargeVolume, explosiveType: this._explosiveType,
          throwDir: [this._throwDirX, this._throwDirY, this._throwDirZ],
          chargeLength: this._chargeLength
        })
        b.velX += gas.ax * dt
        b.velY += gas.ay * dt
        b.velZ += gas.az * dt
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
            b.velX *= (1 - b.friction * 0.25)
            b.velZ *= (1 - b.friction * 0.25)
            const speed = Math.sqrt(b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ)
            // 与有隧道边界时的冻结阈值一致（velY<0.3 & speed<0.5）
            if (b.bounceCount >= b.maxBounces || (Math.abs(b.velY) < 0.3 && speed < 0.5)) {
              b.flags |= FLAG_LANDED
              b.velX = b.velY = b.velZ = 0
              b.angVelX = b.angVelY = b.angVelZ = 0
              if (this.onBodyLanded && !b.landTriggered) {
                b.landTriggered = true
                this.onBodyLanded(b, speed)
              }
            }
          }
        }
      }

      // 6. 旋转更新（3D 四元数积分）
      // 角速度空气阻尼衰减：每帧衰减 2%，模拟空气阻力对旋转的阻碍
      // 飞行 3 秒后角速度衰减到原来的 55%，避免碎片停止移动后仍持续旋转
      const ANG_DAMP = 0.98
      b.angVelX *= ANG_DAMP
      b.angVelY *= ANG_DAMP
      b.angVelZ *= ANG_DAMP
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
    // 爆生气累计时间按子步推进（确保高速子步下气体推力时间精度）
    if (this._gasExpansionEnabled) {
      this._gasExpansionTime += dt
    }
  }

  /**
   * 碎片间碰撞检测与响应（空间散列加速，O(N) 复杂度）
   * 落地碎片作为静态支撑（不移动），飞行碎片与落地碎片碰撞时仅飞行碎片响应
   */
  _resolveInterCollisions() {
    const grid = this._buildSpatialHash()
    for (let i = 0; i < this.bodies.length; i++) {
      const a = this.bodies[i]
      if (!(a.flags & FLAG_ALIVE)) continue
      const aLanded = !!(a.flags & FLAG_LANDED)
      const neighbors = this._queryNeighbors(grid, a)
      for (const b of neighbors) {
        if (b === a) continue
        const bLanded = !!(b.flags & FLAG_LANDED)
        // 两个落地碎片不互撞（静态）
        if (aLanded && bLanded) continue
        this._resolvePairCollision(a, b, aLanded, bLanded)
      }
    }
  }

  /**
   * 构建空间散列网格
   */
  _buildSpatialHash() {
    const grid = new Map()
    for (const b of this.bodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
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
   * 解析一对碎片间的碰撞（球-球碰撞 + impulse-based 响应 + 角动量传递）
   *
   * 阶段一改进：
   * 1. 形态感知半径：radiusA = physSize * 0.5 * collisionRadiusScale
   * 2. Per-body 碰撞参数：使用 a/b 各自的 interRestitution/interFriction 的平均值
   * 3. 角动量传递：切向冲量产生力矩 τ = r × J_t，更新 angVel
   *    转动惯量 I = 0.4 * m * r²（球体近似）
   *
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
    // 形态感知半径（阶段一改进）
    const radiusA = a.physSize * 0.5 * (a.collisionRadiusScale ?? 1.0)
    const radiusB = b.physSize * 0.5 * (b.collisionRadiusScale ?? 1.0)
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

    // Per-body 碰撞参数（阶段一改进）：取两者平均值
    const restAvg = 0.5 * ((a.interRestitution ?? RESTITUTION_INTER) + (b.interRestitution ?? RESTITUTION_INTER))
    const fricAvg = 0.5 * ((a.interFriction ?? FRICTION_INTER) + (b.interFriction ?? FRICTION_INTER))

    // 冲量计算（静态碎片视为无限质量，invMass=0）
    const invMassA = (aStatic || !(a.mass > 0)) ? 0 : 1 / a.mass
    const invMassB = (bStatic || !(b.mass > 0)) ? 0 : 1 / b.mass
    const invSum = invMassA + invMassB
    if (invSum < 1e-6) return

    const j = -(1 + restAvg) * velAlongNormal / invSum

    // ── 粘滞区判定（阶段三）──
    // 当相对速度很低且法向冲量足够大时，两碎片进入粘滞态（完全非弹性碰撞）
    // 模拟细碎粒在堆积表面的"锁死"行为
    const vRelMag = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz)
    if (vRelMag < STICK_VELOCITY_THRESHOLD && j > STICK_IMPULSE_THRESHOLD) {
      const totalMass = a.mass + b.mass
      if (totalMass > 1e-9) {
        const vCommonX = (a.mass * a.velX + b.mass * b.velX) / totalMass
        const vCommonY = (a.mass * a.velY + b.mass * b.velY) / totalMass
        const vCommonZ = (a.mass * a.velZ + b.mass * b.velZ) / totalMass
        if (!aStatic) {
          a.velX = vCommonX; a.velY = vCommonY; a.velZ = vCommonZ
        }
        if (!bStatic) {
          b.velX = vCommonX; b.velY = vCommonY; b.velZ = vCommonZ
        }
        return  // 粘滞态：无反弹、无切向冲量
      }
    }

    const jnX = j * nx, jnY = j * ny, jnZ = j * nz
    a.velX -= jnX * invMassA
    a.velY -= jnY * invMassA
    a.velZ -= jnZ * invMassA
    b.velX += jnX * invMassB
    b.velY += jnY * invMassB
    b.velZ += jnZ * invMassB

    // 切向摩擦冲量 + 角动量传递（阶段一核心改进）
    const tx = rvx - velAlongNormal * nx
    const ty = rvy - velAlongNormal * ny
    const tz = rvz - velAlongNormal * nz
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz)
    if (tLen > 1e-6) {
      const jt = -tLen / invSum * fricAvg
      const jtX = (tx / tLen) * jt
      const jtY = (ty / tLen) * jt
      const jtZ = (tz / tLen) * jt
      a.velX -= jtX * invMassA
      a.velY -= jtY * invMassA
      a.velZ -= jtZ * invMassA
      b.velX += jtX * invMassB
      b.velY += jtY * invMassB
      b.velZ += jtZ * invMassB

      // ── 角动量传递 ──
      // 接触点相对于碎片中心的向量 r_A = -n * radiusA（指向 A 表面）
      // 切向冲量 J_t 产生力矩 τ = r × J_t
      // 角速度变化 Δω = I⁻¹ · τ，I = 0.4·m·r²（球体转动惯量）
      const rAx = -nx * radiusA
      const rAy = -ny * radiusA
      const rAz = -nz * radiusA
      const rBx = nx * radiusB
      const rBy = ny * radiusB
      const rBz = nz * radiusB

      // τ_A = r_A × J_t（A 受到的冲量是 -J_t，所以 τ_A = r_A × (-J_t_total)）
      // A 的切向冲量方向是 -jtX（A 减速），所以 J_t_A = -jtX * invMassA * massA = -jtX * (1 - 0/1)
      // 简化：直接用总切向冲量方向
      // τ_A = r_A × (-jt_direction * |jt * invMassA * massA|) = r_A × (-jt_vec * jt_mag_A)
      // 实际：A 速度变化 = -jt_vec * jt * invMassA，对应冲量 = -jt_vec * jt * invMassA * massA = -jt_vec * jt（当 invMassA=1/massA）
      const tauAx = rAy * (-jtZ) - rAz * (-jtY)
      const tauAy = rAz * (-jtX) - rAx * (-jtZ)
      const tauAz = rAx * (-jtY) - rAy * (-jtX)
      const tauBx = rBy * jtZ - rBz * jtY
      const tauBy = rBz * jtX - rBx * jtZ
      const tauBz = rBx * jtY - rBy * jtX

      // I_A = 0.4 * massA * radiusA²，invI_A = 1 / I_A
      const invInertiaA = (aStatic || !(a.mass > 0)) ? 0 : 1 / (0.4 * a.mass * radiusA * radiusA)
      const invInertiaB = (bStatic || !(b.mass > 0)) ? 0 : 1 / (0.4 * b.mass * radiusB * radiusB)

      // Δω = invI · τ
      a.angVelX += tauAx * invInertiaA
      a.angVelY += tauAy * invInertiaA
      a.angVelZ += tauAz * invInertiaA
      b.angVelX += tauBx * invInertiaB
      b.angVelY += tauBy * invInertiaB
      b.angVelZ += tauBz * invInertiaB
    }
  }

  /**
   * 安息角堆积判定
   * 落地碎片检测下方支撑：若水平偏移与垂直落差构成的斜率超过安息角，解除 LANDED 状态让其沿斜面下滑
   * 飞行碎片速度低于阈值且持续 SETTLE_FRAMES 帧时冻结
   */
  _applyReposeSettling() {
    const grid = this._buildSpatialHash()
    for (const b of this.bodies) {
      if (!(b.flags & FLAG_ALIVE)) continue
      const landed = !!(b.flags & FLAG_LANDED)

      if (landed) {
        // 连续 LANDED 帧数计数
        b.settledFrames = (b.settledFrames || 0) + 1

        // 深度休眠：连续 LANDED 超过 DEEP_SLEEP_FRAMES 帧后完全冻结，跳过所有物理
        // 这是解决碎片静止后抖动的关键：不再做滑动检查，不再参与碰撞
        if (b.settledFrames >= DEEP_SLEEP_FRAMES) {
          b.velX = b.velY = b.velZ = 0
          b.angVelX = b.angVelY = b.angVelZ = 0
          continue  // 深度休眠：跳过滑动检查
        }

        // 落地碎片：收集下方所有支撑碎片，用库仑摩擦判定是否滑动
        const neighbors = this._queryNeighbors(grid, b)
        const supports = []
        for (const n of neighbors) {
          if (n === b) continue
          if (!(n.flags & FLAG_LANDED)) continue
          if (n.posY >= b.posY) continue  // 仅看下方
          supports.push(n)
        }

        if (supports.length > 0) {
          // 库仑摩擦判定：tan(θ) > μ_s 时滑动
          const slide = computeCoulombSlide(b, supports)
          if (slide.shouldSlide) {
            // 解除 LANDED，赋予下滑初速（降低速度避免抖动）
            b.flags &= ~FLAG_LANDED
            b.settledFrames = 0
            const slideSpeed = 0.15  // 降低下滑速度（原1.0→0.15），减少可见抖动
            b.velX = slide.slideDir.x * slideSpeed
            b.velY = slide.slideDir.y * slideSpeed
            b.velZ = slide.slideDir.z * slideSpeed
            b.lowSpeedFrames = 0
          }
        } else {
          // 下方完全无支撑（悬空）但被标记为 LANDED → 解除让其重新下落
          const tb = this._tunnelBounds
          const fragR = b.physSize * 0.5
          const floorY = tb ? tb.floorY : 0
          if (b.posY > floorY + fragR + 0.1) {
            b.flags &= ~FLAG_LANDED
            b.settledFrames = 0
            b.velX = 0; b.velY = 0; b.velZ = 0
            b.lowSpeedFrames = 0
          }
        }
      } else {
        // 飞行碎片：低速持续帧数判定后才冻结
        const speed = Math.sqrt(b.velX ** 2 + b.velY ** 2 + b.velZ ** 2)
        if (speed < SETTLE_SPEED) {
          b.lowSpeedFrames = (b.lowSpeedFrames || 0) + 1
          if (b.lowSpeedFrames >= SETTLE_FRAMES) {
            b.flags |= FLAG_LANDED
            b.velX = b.velY = b.velZ = 0
            b.angVelX = b.angVelY = b.angVelZ = 0
            b.settledFrames = 0
          }
        } else {
          b.lowSpeedFrames = 0
        }
      }
    }
  }

  /**
   * 隧道壁碰撞检测与响应（含角动量更新）
   * 阶段一改进：壁面碰撞时切向速度产生摩擦力矩，更新 angVel
   */
  _resolveWallCollision(b) {
    const tb = this._tunnelBounds
    const fragR = b.physSize * 0.5 * (b.collisionRadiusScale ?? 1.0)
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
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ
        if (latVel > 0) {
          const reflect = latVel * (1 + b.restitution * 0.6)
          b.velX -= tb.rightX * reflect
          b.velZ -= tb.rightZ * reflect
        }
      }
      if (lateral < -halfW) {
        const d = -(lateral + halfW)
        b.posX += tb.rightX * d; b.posZ += tb.rightZ * d
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ
        if (latVel < 0) {
          const reflect = latVel * (1 + b.restitution * 0.6)
          b.velX -= tb.rightX * reflect
          b.velZ -= tb.rightZ * reflect
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
          // 角动量更新（阶段一新增）：右墙法向量 = right
          this._applyImpactTorque(b, tb.rightX, 0, tb.rightZ, fragR)
        }
      } else if (lateral < -wallLimit) {
        const d = -(lateral + wallLimit)
        b.posX += tb.rightX * d; b.posZ += tb.rightZ * d
        const latVel = b.velX * tb.rightX + b.velZ * tb.rightZ
        if (latVel < 0) {
          b.velX -= tb.rightX * latVel * (1 + b.restitution * 0.6)
          b.velZ -= tb.rightZ * latVel * (1 + b.restitution * 0.6)
          // 角动量更新（阶段一新增）：左墙法向量 = -right
          this._applyImpactTorque(b, -tb.rightX, 0, -tb.rightZ, fragR)
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
          // 角动量更新（阶段一新增）：拱顶法向量 (nx, ny, nz)
          this._applyImpactTorque(b, nx, ny, nz, fragR)
        }
      }
    }
  }

  /**
   * 碰撞力矩辅助方法（阶段一新增）
   * 根据碰撞法向量和切向速度，给碎片添加滚动角速度
   * 物理原理：纯滚动条件下 ω = (n × v_t) / r，取部分比例模拟非纯滚动
   *
   * @param {Object} b - 碎片
   * @param {number} nx/ny/nz - 碰撞面法向量（指向碎片外侧）
   * @param {number} radius - 接触半径
   */
  _applyImpactTorque(b, nx, ny, nz, radius) {
    if (!(b.mass > 0) || radius < 0.01) return
    // 切向速度 v_t = v - (v·n)n
    const vn = b.velX * nx + b.velY * ny + b.velZ * nz
    const vtx = b.velX - vn * nx
    const vty = b.velY - vn * ny
    const vtz = b.velZ - vn * nz
    const vtLen = Math.sqrt(vtx * vtx + vty * vty + vtz * vtz)
    if (vtLen < 0.01) return
    // 滚动角速度 ω = (n × v_t) / r，取 30% × 摩擦系数 比例
    const rollFactor = 0.3 * (b.friction ?? 0.5) / radius
    b.angVelX += (ny * vtz - nz * vty) * rollFactor
    b.angVelY += (nz * vtx - nx * vtz) * rollFactor
    b.angVelZ += (nx * vty - ny * vtx) * rollFactor
  }

  /**
   * 底板碰撞检测与反弹（含角动量更新）
   */
  _resolveFloorCollision(b) {
    const tb = this._tunnelBounds
    const fragR = b.physSize * 0.5 * (b.collisionRadiusScale ?? 1.0)
    const floorThreshold = tb.floorY + fragR

    if (b.posY <= floorThreshold) {
      b.posY = floorThreshold
      if (b.velY < 0) {
        b.bounceCount++
        const restitutionScale = Math.pow(0.75, b.bounceCount - 1)
        b.velY = -b.velY * b.restitution * restitutionScale
        b.velX *= (1 - b.friction * 0.25)
        b.velZ *= (1 - b.friction * 0.25)
        // 随机水平偏转（模拟撞击不平整面）
        const speed = Math.sqrt(b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ)
        const deflectAngle = this._rng() * Math.PI * 2
        const deflectStr = Math.min(0.5, speed * 0.015)
        b.velX += Math.cos(deflectAngle) * speed * deflectStr
        b.velZ += Math.sin(deflectAngle) * speed * deflectStr

        // 角动量更新（阶段一新增）：底板法向量 (0,1,0)，切向速度产生滚动
        this._applyImpactTorque(b, 0, 1, 0, fragR)

        // 堆积改进：仅在反弹后速度极低时才标记 LANDED
        // 之前阈值过高(speed<2.0)导致碎片第一次撞击就冻结，无法形成堆积
        const postBounceSpeed = Math.sqrt(b.velX * b.velX + b.velY * b.velY + b.velZ * b.velZ)
        if (b.bounceCount >= b.maxBounces || (Math.abs(b.velY) < 0.3 && postBounceSpeed < 0.5)) {
          b.flags |= FLAG_LANDED
          b.velX = b.velY = b.velZ = 0
          b.angVelX = b.angVelY = b.angVelZ = 0
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
      velX: b.velX, velY: b.velY, velZ: b.velZ,
      angVelX: b.angVelX, angVelY: b.angVelY, angVelZ: b.angVelZ,
      alive: !!(b.flags & FLAG_ALIVE),
      landed: !!(b.flags & FLAG_LANDED),
      physSize: b.physSize,
      bounceCount: b.bounceCount
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
   * 重置引擎
   */
  reset() {
    this.bodies = []
    this.activeCount = 0
    this.simTime = 0
    this._gasExpansionTime = 0  // 重置爆生气累计时间
  }

  /**
   * 设置随机种子（用于 Worker 路径的确定性模式）
   * Worker 入口 blastPhysicsWorker.js 用无参构造创建引擎，
   * 主线程通过 init/seekTo 消息携带 randomSeed 后由 Worker 调用本方法重置 PRNG。
   * 必须在 init() 之前调用，以确保碎片初始角速度等随机量使用新 PRNG。
   * @param {number|null} seed - 种子（null 时回退到 Math.random）
   */
  setRandomSeed(seed) {
    this._rng = seed != null ? mulberry32(seed) : Math.random
  }

}

export default BlastPhysicsEngine
