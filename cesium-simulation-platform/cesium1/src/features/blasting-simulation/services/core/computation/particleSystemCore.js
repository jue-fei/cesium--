/**
 * 爆破粒子系统核心 —— 数值模拟岩体爆破全过程
 *
 * 模拟阶段：
 * 1. 爆炸冲击波初始膨胀（毫秒级）
 * 2. 岩体破碎产生飞溅碎片（抛物线弹道 + 空气阻力）
 * 3. 碎片间碰撞检测（基于八叉树空间索引）
 * 4. 碎片落地堆积（与地表碰撞反弹后静止）
 *
 * 物理模型：
 * - 冲击波：球形传播，能量随距离 1/r 衰减
 * - 碎片弹道：v(t) = v0 * e^(-k*t)，考虑重力
 * - 碰撞响应：弹性碰撞 + 动量守恒
 */

import { Octree } from './octreeCore.js'

// ─── 物理常量 ──────────────────────────────────────────
const DEFAULT_GRAVITY = 9.8
const DEFAULT_AIR_DRAG = 0.04
const DEFAULT_RESTITUTION = 0.35
const DEFAULT_FRICTION = 0.6
const DEFAULT_TIME_STEP = 0.02

// ─── 粒子类型 ──────────────────────────────────────────
export const PARTICLE_TYPES = {
  SHOCK_WAVE: 'shock_wave',
  ROCK_FRAGMENT: 'rock_fragment',
  DUST: 'dust',
  SPALL: 'spall',
  FIRE: 'fire',
  SMOKE: 'smoke',
  SPARK: 'spark'
}

// ─── 粒子渲染参数（真实爆破效果） ──────────────────────
export const PARTICLE_RENDER_PARAMS = {
  [PARTICLE_TYPES.SHOCK_WAVE]: {
    color: [1.0, 0.78, 0.20, 0.80],
    size: 6,
    glow: true,
    glowPower: 0.3,
    lifetime: 2.0
  },
  [PARTICLE_TYPES.ROCK_FRAGMENT]: {
    color: [0.86, 0.63, 0.31, 0.90],
    size: 5,
    glow: false,
    rotation: true,
    lifetime: 999
  },
  [PARTICLE_TYPES.DUST]: {
    color: [0.71, 0.67, 0.63, 0.40],
    size: 3,
    glow: false,
    expand: true,
    lifetime: 8.0
  },
  [PARTICLE_TYPES.SPALL]: {
    color: [0.78, 0.39, 0.20, 0.85],
    size: 4,
    glow: false,
    rotation: true,
    lifetime: 999
  },
  [PARTICLE_TYPES.FIRE]: {
    color: [1.0, 0.40, 0.05, 0.85],
    size: 8,
    glow: true,
    glowPower: 0.5,
    flicker: true,
    lifetime: 1.5
  },
  [PARTICLE_TYPES.SMOKE]: {
    color: [0.20, 0.20, 0.20, 0.50],
    size: 10,
    glow: false,
    expand: true,
    rise: true,
    lifetime: 8.0
  },
  [PARTICLE_TYPES.SPARK]: {
    color: [1.0, 0.85, 0.30, 0.95],
    size: 2,
    glow: true,
    glowPower: 0.8,
    trail: true,
    lifetime: 3.0
  }
}

// ─── 工具函数 ──────────────────────────────────────────
function createSeededRandom(seed = 20260309) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function metersToLonLatDelta(dx, dy, lat) {
  const latRad = (Number(lat || 0) * Math.PI) / 180
  const metersPerDegreeLat = 110540
  const metersPerDegreeLon = Math.max(1, 111320 * Math.cos(latRad))
  return {
    dLon: dx / metersPerDegreeLon,
    dLat: dy / metersPerDegreeLat
  }
}

function lonLatToMeters(lon, lat, refLon, refLat) {
  const latRad = (Number(refLat || 0) * Math.PI) / 180
  const dx = (lon - refLon) * 111320 * Math.cos(latRad)
  const dy = (lat - refLat) * 110540
  return { dx, dy }
}

function clampHeight(v) {
  return Math.max(0, Number.isFinite(v) ? v : 0)
}

// ─── 粒子类 ─────────────────────────────────────────────
class Particle {
  constructor(id, type, x, y, z, vx, vy, vz, size, density) {
    this.id = id
    this.type = type
    this.x = x
    this.y = y
    this.z = z
    this.vx = vx
    this.vy = vy
    this.vz = vz
    this.size = size
    this.density = density
    this.mass = density * size * size * size
    this.alive = true
    this.landed = false
    this.landedTime = -1
    this.age = 0
    this.energy0 = 0.5 * this.mass * (vx * vx + vy * vy + vz * vz)
    // 渲染属性
    this.rotation = Math.random() * Math.PI * 2
    this.rotationSpeed = (Math.random() - 0.5) * 4
    this.opacity = 1.0
    this.baseSize = size
    this.lifetime = PARTICLE_RENDER_PARAMS[type]?.lifetime || 999
    this.flickerPhase = Math.random() * Math.PI * 2
  }

  position() {
    return { x: this.x, y: this.y, z: this.z, radius: this.size }
  }
}

// ─── 粒子系统 ───────────────────────────────────────────
export class BlastingParticleSystem {
  constructor(config = {}) {
    this.gravity = config.gravity ?? DEFAULT_GRAVITY
    this.airDrag = config.airDrag ?? DEFAULT_AIR_DRAG
    this.restitution = config.restitution ?? DEFAULT_RESTITUTION
    this.friction = config.friction ?? DEFAULT_FRICTION
    this.timeStep = config.timeStep ?? DEFAULT_TIME_STEP
    this.collisionEnabled = config.collisionEnabled !== false
    this.groundHeight = config.groundHeight ?? 0
    this.maxParticles = config.maxParticles ?? 5000
    this.collisionRadius = config.collisionRadius ?? 0.5
    this.random = createSeededRandom(config.seed ?? 20260309)

    /** @type {Particle[]} */
    this.particles = []
    this.octree = null
    this.spatialExtent = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }
  }

  /**
   * 初始化爆破粒子系统
   * @param {Object} params - 爆破参数
   * @param {number} params.centerLon - 爆心经度
   * @param {number} params.centerLat - 爆心纬度
   * @param {number} params.centerHeight - 爆心高度(m)
   * @param {number} params.chargeKg - 装药量(kg)
   * @param {number} params.fragmentCount - 碎片数量
   * @param {number} params.frameCount - 帧数
   * @param {number} params.timeStep - 时间步长(s)
   * @param {Array} params.holes - 炮孔信息
   */
  initialize(params) {
    this.particles = []
    // 存储参考坐标，供 _snapshot 使用
    this.refLon = params.centerLon || 0
    this.refLat = params.centerLat || 0
    this.refHeight = params.centerHeight || 0
    this.spatialExtent = {
      minX: params.centerLon - 0.01,
      maxX: params.centerLon + 0.01,
      minY: params.centerLat - 0.01,
      maxY: params.centerLat + 0.01,
      minZ: 0,
      maxZ: 200
    }

    const chargeKg = Math.max(1, params.chargeKg || 100)
    const fragmentCount = Math.min(this.maxParticles, params.fragmentCount || 200)
    const holes = params.holes || []
    const refLat = params.centerLat

    // ── 1. 生成冲击波粒子 ──
    const shockWaveCount = Math.min(50, Math.max(10, Math.floor(chargeKg / 10)))
    for (let i = 0; i < shockWaveCount; i++) {
      const theta = this.random() * Math.PI * 2
      const phi = this.random() * Math.PI
      const speed = 80 + this.random() * 120
      const p = new Particle(
        `SW${String(i + 1).padStart(3, '0')}`,
        PARTICLE_TYPES.SHOCK_WAVE,
        0, 0, params.centerHeight || 0,
        Math.cos(theta) * Math.sin(phi) * speed,
        Math.sin(theta) * Math.sin(phi) * speed,
        Math.cos(phi) * speed,
        0.3 + this.random() * 0.5,
        0.5
      )
      p.energy0 = chargeKg * 1000 * (0.5 + this.random() * 0.5)
      this.particles.push(p)
    }

    // ── 2. 生成岩体碎片 ──
    for (let i = 0; i < fragmentCount; i++) {
      const baseAngle = (Math.PI * 2 * i) / fragmentCount
      const jitterAngle = (this.random() - 0.5) * 0.8
      const azimuth = baseAngle + jitterAngle
      const elevation = Math.PI * (0.15 + this.random() * 0.35)
      const speed = 15 + this.random() * 45 + Math.sqrt(chargeKg) * 0.8
      const size = 0.15 + this.random() * 1.8
      const density = 2500 + this.random() * 500

      const p = new Particle(
        `RF${String(i + 1).padStart(4, '0')}`,
        PARTICLE_TYPES.ROCK_FRAGMENT,
        0, 0, params.centerHeight || 0,
        Math.cos(azimuth) * Math.cos(elevation) * speed,
        Math.sin(azimuth) * Math.cos(elevation) * speed,
        Math.sin(elevation) * speed,
        size,
        density
      )
      this.particles.push(p)
    }

    // ── 3. 生成粉尘粒子 ──
    const dustCount = Math.min(300, Math.floor(fragmentCount * 1.5))
    for (let i = 0; i < dustCount; i++) {
      const theta = this.random() * Math.PI * 2
      const speed = 2 + this.random() * 8
      const size = 0.05 + this.random() * 0.2
      const p = new Particle(
        `DU${String(i + 1).padStart(3, '0')}`,
        PARTICLE_TYPES.DUST,
        (this.random() - 0.5) * 2,
        (this.random() - 0.5) * 2,
        (params.centerHeight || 0) + this.random() * 2,
        Math.cos(theta) * speed,
        Math.sin(theta) * speed,
        1 + this.random() * 3,
        size,
        100
      )
      this.particles.push(p)
    }

    // ── 4. 生成火焰粒子（火球效果） ──
    const fireCount = Math.min(80, Math.max(20, Math.floor(chargeKg / 8)))
    for (let i = 0; i < fireCount; i++) {
      const theta = this.random() * Math.PI * 2
      const phi = this.random() * Math.PI * 0.5
      const speed = 5 + this.random() * 20
      const size = 0.5 + this.random() * 2.0
      const p = new Particle(
        `FI${String(i + 1).padStart(3, '0')}`,
        PARTICLE_TYPES.FIRE,
        (this.random() - 0.5) * 1,
        (this.random() - 0.5) * 1,
        (params.centerHeight || 0) + this.random() * 1,
        Math.cos(theta) * Math.sin(phi) * speed,
        Math.sin(theta) * Math.sin(phi) * speed,
        Math.cos(phi) * speed + 5,
        size,
        50
      )
      this.particles.push(p)
    }

    // ── 5. 生成烟雾粒子（蘑菇云效果） ──
    const smokeCount = Math.min(100, Math.max(30, Math.floor(chargeKg / 5)))
    for (let i = 0; i < smokeCount; i++) {
      const theta = this.random() * Math.PI * 2
      const speed = 1 + this.random() * 5
      const size = 1.0 + this.random() * 3.0
      const p = new Particle(
        `SM${String(i + 1).padStart(3, '0')}`,
        PARTICLE_TYPES.SMOKE,
        (this.random() - 0.5) * 2,
        (this.random() - 0.5) * 2,
        (params.centerHeight || 0) + this.random() * 3,
        Math.cos(theta) * speed,
        Math.sin(theta) * speed,
        2 + this.random() * 6,
        size,
        30
      )
      this.particles.push(p)
    }

    // ── 6. 生成火花粒子 ──
    const sparkCount = Math.min(60, Math.max(15, Math.floor(chargeKg / 10)))
    for (let i = 0; i < sparkCount; i++) {
      const theta = this.random() * Math.PI * 2
      const phi = this.random() * Math.PI
      const speed = 20 + this.random() * 60
      const size = 0.1 + this.random() * 0.3
      const p = new Particle(
        `SP${String(i + 1).padStart(3, '0')}`,
        PARTICLE_TYPES.SPARK,
        0, 0, (params.centerHeight || 0),
        Math.cos(theta) * Math.sin(phi) * speed,
        Math.sin(theta) * Math.sin(phi) * speed,
        Math.cos(phi) * speed,
        size,
        80
      )
      this.particles.push(p)
    }

    // ── 7. 生成剥落粒子（沿炮孔方向） ──
    if (holes.length > 0) {
      for (const hole of holes) {
        const collarDx = lonLatToMeters(hole.collar.lon, hole.collar.lat, params.centerLon, params.centerLat).dx
        const collarDy = lonLatToMeters(hole.collar.lon, hole.collar.lat, params.centerLon, params.centerLat).dy
        const spallCount = Math.min(20, Math.max(5, Math.floor(hole.chargeKg / 3)))
        for (let i = 0; i < spallCount; i++) {
          const angle = Math.atan2(collarDy, collarDx) + (this.random() - 0.5) * 1.2
          const speed = 10 + this.random() * 25
          const size = 0.1 + this.random() * 0.6
          const p = new Particle(
            `SP${hole.id}-${i}`,
            PARTICLE_TYPES.SPALL,
            collarDx, collarDy,
            hole.collar.height || 0,
            Math.cos(angle) * speed,
            Math.sin(angle) * speed,
            5 + this.random() * 15,
            size,
            2200
          )
          this.particles.push(p)
        }
      }
    }

    // ── 构建八叉树 ──
    this._rebuildOctree()
  }

  _rebuildOctree() {
    if (!this.collisionEnabled || this.particles.length === 0) return
    const halfSize = 150
    this.octree = new Octree(0, 0, 50, halfSize, { maxObjects: 12, maxDepth: 6 })
    for (const p of this.particles) {
      if (p.alive && !p.landed) {
        this.octree.insert(p.position())
      }
    }
  }

  /**
   * 推进一帧物理模拟
   * @param {number} dt - 时间步长(s)
   * @returns {Object} 当前帧的粒子状态快照
   */
  step(dt) {
    const stepTime = dt || this.timeStep
    const aliveParticles = this.particles.filter(p => p.alive)

    // ── 1. 物理积分：更新位置和速度 ──
    for (const p of aliveParticles) {
      if (p.landed) {
        // 已落地粒子：摩擦减速
        p.vx *= (1 - this.friction * stepTime)
        p.vy *= (1 - this.friction * stepTime)
        p.vz = 0
        p.x += p.vx * stepTime
        p.y += p.vy * stepTime
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if (speed < 0.1) {
          p.vx = 0
          p.vy = 0
        }
        continue
      }

      // 空气阻力（指数衰减）
      const dragFactor = Math.exp(-this.airDrag * stepTime)
      p.vx *= dragFactor
      p.vy *= dragFactor
      p.vz = p.vz * dragFactor - this.gravity * stepTime

      // 更新位置
      p.x += p.vx * stepTime
      p.y += p.vy * stepTime
      p.z += p.vz * stepTime

      // 地面碰撞
      if (p.z <= this.groundHeight) {
        p.z = this.groundHeight
        if (p.vz < 0) {
          p.vz = -p.vz * this.restitution
          p.vx *= (1 - this.friction * 0.5)
          p.vy *= (1 - this.friction * 0.5)
          if (Math.abs(p.vz) < 0.5) {
            p.vz = 0
            p.landed = true
            p.landedTime = p.age
          }
        }
      }

      p.age += stepTime

      // 粒子寿命与渲染效果
      const renderParams = PARTICLE_RENDER_PARAMS[p.type]
      if (renderParams) {
        // 寿命判断
        if (p.age > p.lifetime) {
          p.alive = false
          continue
        }

        // 火焰粒子：闪烁与膨胀
        if (p.type === PARTICLE_TYPES.FIRE) {
          const lifeRatio = p.age / p.lifetime
          p.opacity = Math.max(0, 1 - lifeRatio)
          p.size = p.baseSize * (1 + lifeRatio * 2)
          // 闪烁效果
          p.flickerPhase += stepTime * 15
        }

        // 烟雾粒子：膨胀与上升
        if (p.type === PARTICLE_TYPES.SMOKE) {
          const lifeRatio = p.age / p.lifetime
          p.opacity = Math.max(0, 0.5 * (1 - lifeRatio * 0.8))
          p.size = p.baseSize * (1 + lifeRatio * 3)
          // 额外上升力
          p.vz += 2 * stepTime
        }

        // 粉尘粒子：膨胀与消散
        if (p.type === PARTICLE_TYPES.DUST) {
          const lifeRatio = p.age / p.lifetime
          p.opacity = Math.max(0, 0.4 * (1 - lifeRatio))
          p.size = p.baseSize * (1 + lifeRatio * 1.5)
        }

        // 火花粒子：拖尾与衰减
        if (p.type === PARTICLE_TYPES.SPARK) {
          const lifeRatio = p.age / p.lifetime
          p.opacity = Math.max(0, 1 - lifeRatio)
        }

        // 冲击波粒子寿命
        if (p.type === PARTICLE_TYPES.SHOCK_WAVE && p.age > 2.0) {
          p.alive = false
        }
      }

      // 旋转更新
      if (p.type === PARTICLE_TYPES.ROCK_FRAGMENT || p.type === PARTICLE_TYPES.SPALL) {
        p.rotation += p.rotationSpeed * stepTime
      }
    }

    // ── 2. 粒子间碰撞检测（八叉树加速） ──
    if (this.collisionEnabled && this.octree) {
      this._rebuildOctree()
      for (const p of aliveParticles) {
        if (!p.alive || p.landed || p.type === PARTICLE_TYPES.DUST) continue
        const neighbors = this.octree.queryRadius(p.x, p.y, p.z, p.size + this.collisionRadius)
        for (const other of neighbors) {
          if (other === p) continue
          const op = this._findParticleByPosition(other)
          if (!op || !op.alive || op.landed) continue
          this._resolveCollision(p, op)
        }
      }
    }

    return this._snapshot()
  }

  _findParticleByPosition(point) {
    for (const p of this.particles) {
      if (p.alive && Math.abs(p.x - point.x) < 0.01 && Math.abs(p.y - point.y) < 0.01 && Math.abs(p.z - point.z) < 0.01) {
        return p
      }
    }
    return null
  }

  _resolveCollision(a, b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dz = b.z - a.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const minDist = a.size + b.size
    if (dist >= minDist || dist < 1e-6) return

    // 分离重叠
    const overlap = (minDist - dist) * 0.5
    const nx = dx / dist
    const ny = dy / dist
    const nz = dz / dist
    a.x -= nx * overlap
    a.y -= ny * overlap
    a.z -= nz * overlap
    b.x += nx * overlap
    b.y += ny * overlap
    b.z += nz * overlap

    // 弹性碰撞响应（动量守恒）
    const rvx = b.vx - a.vx
    const rvy = b.vy - a.vy
    const rvz = b.vz - a.vz
    const velAlongNormal = rvx * nx + rvy * ny + rvz * nz
    if (velAlongNormal > 0) return

    const e = this.restitution
    const j = -(1 + e) * velAlongNormal / (1 / a.mass + 1 / b.mass)
    const impulseX = j * nx
    const impulseY = j * ny
    const impulseZ = j * nz

    a.vx -= impulseX / a.mass
    a.vy -= impulseY / a.mass
    a.vz -= impulseZ / a.mass
    b.vx += impulseX / b.mass
    b.vy += impulseY / b.mass
    b.vz += impulseZ / b.mass
  }

  /**
   * 生成当前帧的粒子状态快照
   * @param {number} refLon - 参考经度
   * @param {number} refLat - 参考纬度
   * @param {number} refHeight - 参考高度
   * @returns {Object} 帧快照
   */
  _snapshot(refLon, refLat, refHeight) {
    const lon = refLon ?? this.refLon ?? 0
    const lat = refLat ?? this.refLat ?? 0
    const h = refHeight ?? this.refHeight ?? 0

    const fragments = []
    let maxDistance = 0
    let maxSpeed = 0
    let aliveCount = 0
    let landedCount = 0

    for (const p of this.particles) {
      if (!p.alive) continue
      aliveCount++
      if (p.landed) landedCount++

      const { dLon, dLat } = metersToLonLatDelta(p.x, p.y, lat)
      const height = clampHeight(h + p.z)
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz)
      maxSpeed = Math.max(maxSpeed, speed)

      const distMeter = Math.sqrt(p.x * p.x + p.y * p.y)
      maxDistance = Math.max(maxDistance, distMeter)

      fragments.push({
        id: p.id,
        type: p.type,
        size: Number(p.size.toFixed(3)),
        position: {
          lon: lon + dLon,
          lat: lat + dLat,
          height
        },
        velocity: {
          vx: Number(p.vx.toFixed(2)),
          vy: Number(p.vy.toFixed(2)),
          vz: Number(p.vz.toFixed(2))
        },
        speed: Number(speed.toFixed(2)),
        landed: p.landed,
        age: Number(p.age.toFixed(3)),
        opacity: Number(p.opacity.toFixed(3)),
        rotation: Number(p.rotation.toFixed(3)),
        flicker: p.type === PARTICLE_TYPES.FIRE ? Number((Math.sin(p.flickerPhase) * 0.3 + 0.7).toFixed(3)) : 1.0
      })
    }

    return {
      fragments,
      stats: {
        aliveCount,
        landedCount,
        maxDistance: Number(maxDistance.toFixed(2)),
        maxSpeed: Number(maxSpeed.toFixed(2)),
        totalEnergy: this._totalEnergy()
      }
    }
  }

  _totalEnergy() {
    let total = 0
    for (const p of this.particles) {
      if (!p.alive) continue
      const ke = 0.5 * p.mass * (p.vx * p.vx + p.vy * p.vy + p.vz * p.vz)
      const pe = p.mass * this.gravity * p.z
      total += ke + pe
    }
    return Number(total.toFixed(2))
  }

  /**
   * 运行完整模拟并生成所有帧
   * @param {Object} params - 初始化参数
   * @param {number} frameCount - 帧数
   * @param {number} timeStep - 时间步长
   * @returns {Array} 所有帧的快照数组
   */
  simulate(params, frameCount, timeStep) {
    this.initialize(params)
    const frames = []

    for (let i = 0; i < frameCount; i++) {
      const t = i * timeStep
      const snapshot = this.step(timeStep)
      frames.push({
        t: Number(t.toFixed(3)),
        waveRadius: this._computeWaveRadius(t, params.chargeKg || 100),
        fragments: snapshot.fragments,
        stats: snapshot.stats
      })
    }
    return frames
  }

  /**
   * 计算冲击波半径
   * 基于爆炸物理学：r(t) = c * t^(2/3) * Q^(1/3)
   * 其中 c 为经验常数，Q 为装药量
   */
  _computeWaveRadius(t, chargeKg) {
    if (t <= 0) return 0
    const c = 5.0
    const r = c * Math.pow(t, 0.4) * Math.pow(Math.max(1, chargeKg), 1 / 3)
    return Number(r.toFixed(2))
  }

  clear() {
    this.particles = []
    if (this.octree) this.octree.clear()
  }

  get particleCount() {
    return this.particles.filter(p => p.alive).length
  }
}

export default BlastingParticleSystem
