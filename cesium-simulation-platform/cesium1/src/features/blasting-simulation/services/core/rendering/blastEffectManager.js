/**
 * 爆破粒子特效管理器
 *
 * 管理火焰、烟雾、火花、粉尘、冲击波等 GPU 粒子特效。
 * 所有特效使用 THREE.Points + ShaderMaterial 渲染，与碎片 InstancedMesh 分离。
 *
 * 包含：
 * - init: 根据爆破参数生成初始粒子
 * - update: 每帧更新粒子物理/生命期/渲染属性
 * - spawnImpactDebris: 碎片落地时触发撞击飞溅
 * - 图层可见性控制
 * - 撞击飞溅粒子池管理
 */

import * as THREE from 'three'
import {
  DEFAULT_TUNNEL_WIDTH,
  DEFAULT_TUNNEL_WALL_HEIGHT,
  DEFAULT_TUNNEL_ARCH_RADIUS
} from '../blastDefaults.js'

// ─── 粒子类型常量 ──────────────────────────────────────
const EFFECT_TYPES = {
  FIRE: 'fire',
  SMOKE: 'smoke',
  SPARK: 'spark',
  DUST: 'dust',
  SHOCK_WAVE: 'shock_wave',
  IMPACT_DUST: 'impact_dust',
  IMPACT_SPARK: 'impact_spark'
}

// ─── ShaderMaterial 代码（GPU 粒子渲染） ──────────────
const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aOpacity;
  attribute vec3 aColor;
  attribute float aAngle;
  varying float vOpacity;
  varying vec3 vColor;
  varying float vAngle;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (250.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    vOpacity = aOpacity;
    vColor = aColor;
    vAngle = aAngle;
  }
`

const fragmentShader = /* glsl */ `
  varying float vOpacity;
  varying vec3 vColor;
  varying float vAngle;
  uniform sampler2D uTexture;
  void main() {
    vec2 uv = gl_PointCoord;
    float cx = uv.x - 0.5, cy = uv.y - 0.5;
    // 旋转
    float c = cos(vAngle), s = sin(vAngle);
    float rx = cx * c - cy * s + 0.5;
    float ry = cx * s + cy * c + 0.5;
    vec4 tex = texture2D(uTexture, vec2(rx, ry));
    float alpha = tex.a * vOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor * tex.rgb, alpha);
  }
`

// ─── 纹理生成（程序化，无外部依赖） ────────────────────
function createGlowTexture(innerColor, outerColor, size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, innerColor)
  gradient.addColorStop(0.35, innerColor)
  gradient.addColorStop(0.7, outerColor)
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function createNoiseTexture(size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // 团块更密、更亮：提升每个噪点的半径/灰度/alpha，使烟雾/粉尘 puffs 清晰可辨
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * size,
      y = Math.random() * size
    const r = Math.random() * 7 + 2
    const g = Math.floor(115 + Math.random() * 115)
    ctx.fillStyle = `rgba(${g},${g},${g},${0.35 + Math.random() * 0.5})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

// ─── 内部粒子数据 ──────────────────────────────────────
class EffectParticle {
  constructor(opts = {}) {
    this.posX = opts.x || 0
    this.posY = opts.y || 0
    this.posZ = opts.z || 0
    this.velX = opts.vx || 0
    this.velY = opts.vy || 0
    this.velZ = opts.vz || 0
    this.size = opts.size || 1
    this.baseSize = this.size
    this.opacity = 1
    this.life = opts.life || 1
    this.maxLife = this.life
    this.colorR = opts.cr || 1
    this.colorG = opts.cg || 1
    this.colorB = opts.cb || 1
    this.angle = Math.random() * Math.PI * 2
    this.angleSpeed = (Math.random() - 0.5) * 3
    this.gravity = opts.gravity ?? 0
    this.drag = opts.drag ?? 0
    this.rise = opts.rise ?? 0
    this.expand = opts.expand ?? 0
    this.turbulence = opts.turbulence ?? 0
    this.turbPhase = Math.random() * Math.PI * 2
    this.alive = true
    // 出生时刻（模拟时间 s）：出生前不老化、不渲染。
    // 主爆破粒子 bornAt=起爆时刻 → 火球/火花/烟雾等从起爆瞬间才开始涌现，
    // 避免 initBlast 预灌注后于起爆前（0→blastTriggerTime）提前燃尽/预显示。
    this.bornAt = opts.bornAt || 0
  }
}

export class BlastEffectManager {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this.scene = scene
    this.renderer = renderer

    // 纹理
    this.textures = {
      fire: createGlowTexture('rgba(255,255,200,0.95)', 'rgba(255,100,10,0.15)'),
      smoke: createNoiseTexture(64),
      spark: createGlowTexture('rgba(255,255,220,1)', 'rgba(255,180,30,0.1)', 32),
      dust: createNoiseTexture(48),
      shock_wave: createGlowTexture('rgba(255,220,150,0.6)', 'rgba(255,120,30,0)', 64)
    }

    // Points 系统：按类型分组
    /** @type {Record<string, {points:THREE.Points, particles:EffectParticle[]}>} */
    this.groups = {}

    // 撞击飞溅池
    this._impactDustPool = []
    this._impactSparkPool = []

    // 泛光光斑总开关：false 时隐藏火花/火球/冲击波/落地火星等辉光类粒子
    this._glowMaster = true

    // 图层可见性
    this.layerVisibility = {
      fire: true,
      smoke: true,
      spark: true,
      dust: true,
      shock_wave: true
    }

    // 编译 ShaderMaterial（缓存复用）
    this._shaderMaterialCache = new Map()
  }

  /**
   * 初始化爆破特效粒子
   * @param {Object} opts
   * @param {number} opts.chargeKg
   * @param {{x:number,y:number,z:number}} opts.center - 爆心世界坐标
   * @param {{x:number,y:number,z:number}} opts.throwDir - 抛掷方向（单位向量，指向已开挖侧）
   * @param {{x:number,y:number,z:number}} opts.right - 横向方向
   * @param {Object} opts.tunnelSection - {width, wallHeight, archRadius, shape}
   * @param {Object} opts.kcoOutput - {A} 岩石因子
   */
  init(opts = {}) {
    this.clear()
    const {
      chargeKg = 320,
      center = { x: 0, y: 0, z: 0 },
      throwDir,
      right,
      up,
      tunnelSection = {},
      kcoOutput = {},
      triggerTime = 0.1
    } = opts
    const cx = center.x,
      cy = center.y,
      cz = center.z
    const rockA = kcoOutput.A || 3.6
    // 向已开挖侧（-forward，朝相机）的抛掷方向（无 fallback 时默认轴向 -Z）
    const out = throwDir || { x: 0, y: 0, z: -1 }
    this._simTime = 0

    // 存下掌子面几何信息，用于约束粒子不跑出隧道截面外
    // n = 抛掷方向（指向已开挖侧/隧道内），作为截面局部坐标系轴向
    this._face = {
      cx: center.x,
      cy: center.y,
      cz: center.z,
      rx: right.x,
      ry: right.y,
      rz: right.z,
      ux: up ? up.x : 0,
      uy: up ? up.y : 1,
      uz: up ? up.z : 0,
      nx: out.x,
      ny: out.y,
      nz: out.z,
      width: (tunnelSection.width || 10),
      wallHeight: (tunnelSection.wallHeight || 6),
      archRadius: (tunnelSection.archRadius || 5),
      shape: (tunnelSection.shape || 'horseshoe')
    }

    const allParticles = []

    // ── 火球 ──
    // 修正：初速/出生位置不再指向掌子面内（+forward 会被岩体遮挡），
    // 改为沿抛掷方向（out）从掌子面冲入隧道，火球持续 ~0.5-0.95s 肉眼可见。
    const fireCount = Math.min(140, Math.max(25, Math.floor((chargeKg / 5) * (1 + rockA * 0.1))))
    const fireParticles = []
    for (let i = 0; i < fireCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.55
      const radial = 2 + Math.random() * 7
      const base = 4 + Math.random() * 10
      fireParticles.push(
        new EffectParticle({
          x: cx + out.x * 1.2 + Math.cos(theta) * Math.sin(phi) * radial,
          y: cy + Math.sin(theta) * Math.sin(phi) * radial + Math.random() * 1.5,
          z: cz + out.z * 1.2 + Math.cos(phi) * radial * 0.5,
          vx: out.x * base + Math.cos(theta) * Math.sin(phi) * 6,
          vy: 2 + Math.sin(theta) * Math.sin(phi) * 6,
          vz: out.z * base + Math.cos(phi) * 4,
          size: 5 + Math.random() * 9,
          life: 0.7 + Math.random() * 0.8, // 火球延续 ~0.7-1.5s
          cr: 1,
          cg: 0.5 + Math.random() * 0.3,
          cb: 0.05 + Math.random() * 0.1,
          gravity: -1,
          expand: 1.5,
          bornAt: triggerTime
        })
      )
    }
    allParticles.push({ type: EFFECT_TYPES.FIRE, list: fireParticles })

    // ── 火花 ──
    const sparkCount = Math.min(90, Math.max(20, Math.floor((chargeKg / 10) * (1 + rockA * 0.15))))
    const sparkParticles = []
    for (let i = 0; i < sparkCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.5
      const speed = 10 + Math.random() * 28
      const base = 6 + Math.random() * 18
      sparkParticles.push(
        new EffectParticle({
          x: cx + out.x + Math.cos(theta) * Math.sin(phi) * 1.5,
          y: cy + Math.sin(theta) * Math.sin(phi) * 1.5,
          z: cz + out.z + Math.cos(phi),
          vx: out.x * base + Math.cos(theta) * Math.sin(phi) * speed * 0.5,
          vy: 3 + Math.sin(theta) * Math.sin(phi) * speed * 0.5,
          vz: out.z * base + Math.cos(phi) * speed * 0.35,
          size: 4 + Math.random() * 5, // 火花调大：4-9
          life: 1.0 + Math.random() * 1.0, // 火花延续 ~1-2s（受重力回落）
          cr: 1,
          cg: 0.85,
          cb: 0.3,
          gravity: 9.8,
          drag: 0.01,
          bornAt: triggerTime
        })
      )
    }
    allParticles.push({ type: EFFECT_TYPES.SPARK, list: sparkParticles })

    // ── 烟雾（沿隧道轴向扩散，不向上柱状升起） ──
    // 修正：原本视效过淡（opacity≤0.10、暗灰色）在黑色隧道里几乎不可见；
    // 提高亮度/透明度上限与大团块尺寸，同时压低轴向初速（不冲脸、不挡视野）。
    const smokeCount = Math.min(40, Math.max(18, Math.floor(chargeKg / 20)))
    const smokeParticles = []
    for (let i = 0; i < smokeCount; i++) {
      const speed = 0.5 + Math.random() * 1.2
      const lx = (Math.random() - 0.5) * (tunnelSection.width || DEFAULT_TUNNEL_WIDTH) * 0.8
      const lh =
        Math.random() *
        ((tunnelSection.wallHeight || DEFAULT_TUNNEL_WALL_HEIGHT) +
          (tunnelSection.archRadius || DEFAULT_TUNNEL_ARCH_RADIUS))
      smokeParticles.push(
        new EffectParticle({
          x: cx + (right ? right.x * lx : lx),
          y: cy + lh,
          z: cz + (right ? right.z * lx : 0),
          vx: out.x * speed + (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.3, // 围绕 0，不再偏上
          vz: out.z * speed + (Math.random() - 0.5) * 0.5,
          size: 8 + Math.random() * 8, // 烟雾团块调大：8-16
          life: 4.5 + Math.random() * 2.5, // 烟雾延续 ~4.5-7s，缓慢飘散
          cr: 0.5,
          cg: 0.5,
          cb: 0.5,
          gravity: -0.05, // 轻微下沉（隧道内烟尘自然沉降）
          turbulence: 1.5,
          expand: 2,
          bornAt: triggerTime
        })
      )
    }
    allParticles.push({ type: EFFECT_TYPES.SMOKE, list: smokeParticles })

    // ── 粉尘（可见但不糊屏：慢速多团、透明上限 ~0.24） ──
    const dustCount = Math.max(10, Math.floor(Math.min(32, chargeKg / 16)))
    const dustParticles = []
    for (let i = 0; i < dustCount; i++) {
      const speed = 1.2 + Math.random() * 2.2
      const lx = (Math.random() - 0.5) * (tunnelSection.width || DEFAULT_TUNNEL_WIDTH) * 0.7
      const lh =
        Math.random() *
        ((tunnelSection.wallHeight || DEFAULT_TUNNEL_WALL_HEIGHT) +
          (tunnelSection.archRadius || DEFAULT_TUNNEL_ARCH_RADIUS)) *
        0.7
      dustParticles.push(
        new EffectParticle({
          x: cx + (right ? right.x * lx : lx),
          y: cy + lh,
          z: cz + (right ? right.z * lx : 0),
          vx: out.x * speed + (Math.random() - 0.5) * 1.5,
          vy: (Math.random() - 0.5) * 0.8,
          vz: out.z * speed + (Math.random() - 0.5) * 1.5,
          size: 5 + Math.random() * 5, // 粉尘团块调大：5-10
          life: 3.0 + Math.random() * 2.0, // 粉尘延续 ~3-5s
          cr: 0.6,
          cg: 0.58,
          cb: 0.55,
          gravity: -0.1,
          turbulence: 1.5,
          expand: 1.8,
          bornAt: triggerTime
        })
      )
    }
    allParticles.push({ type: EFFECT_TYPES.DUST, list: dustParticles })

    // ── 冲击波（出生点略靠已开挖侧，避免膨胀环被岩体面遮挡） ──
    const shockParticles = []
    for (let i = 0; i < 3; i++) {
      shockParticles.push(
        new EffectParticle({
          x: cx,
          y: cy,
          z: cz + out.z * 1.0,
          size: 6 + i * 5,
          life: 1.8, // 冲击波延续 ~1.8s
          cr: 1,
          cg: 0.8,
          cb: 0.2,
          gravity: 0,
          expand: 120 + i * 40,
          bornAt: triggerTime
        })
      )
    }
    allParticles.push({ type: EFFECT_TYPES.SHOCK_WAVE, list: shockParticles })

    // 构建 Points 系统
    for (const { type, list } of allParticles) {
      if (list.length === 0) continue
      this._buildPoints(type, list)
    }

    // 构建撞击飞溅池
    this._buildImpactPools()
  }

  /**
   * 为指定类型构建 THREE.Points
   */
  _buildPoints(type, particles) {
    const geom = new THREE.BufferGeometry()
    const count = particles.length
    const posArr = new Float32Array(count * 3)
    const sizeArr = new Float32Array(count)
    const opArr = new Float32Array(count)
    const colArr = new Float32Array(count * 3)
    const angArr = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      const p = particles[i]
      posArr[i * 3] = p.posX
      posArr[i * 3 + 1] = p.posY
      posArr[i * 3 + 2] = p.posZ
      sizeArr[i] = p.size
      // 初始不透明度一律 0：主爆破粒子 bornAt=起爆时刻，出生前不可见（避免
      // 起爆前静态渲染出火球/烟尘）；出生后由 update() 按生命期即时刷新。
      opArr[i] = 0
      colArr[i * 3] = p.colorR
      colArr[i * 3 + 1] = p.colorG
      colArr[i * 3 + 2] = p.colorB
      angArr[i] = p.angle
    }

    geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1))
    geom.setAttribute('aOpacity', new THREE.BufferAttribute(opArr, 1))
    geom.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3))
    geom.setAttribute('aAngle', new THREE.BufferAttribute(angArr, 1))
    geom.setDrawRange(0, count)

    let mat = this._shaderMaterialCache.get(type)
    if (!mat) {
      const isAdditive =
        type === EFFECT_TYPES.FIRE ||
        type === EFFECT_TYPES.SPARK ||
        type === EFFECT_TYPES.SHOCK_WAVE
      mat = new THREE.ShaderMaterial({
        uniforms: { uTexture: { value: this.textures[type] || this.textures.dust } },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: isAdditive ? THREE.AdditiveBlending : THREE.NormalBlending
      })
      this._shaderMaterialCache.set(type, mat)
    }

    const points = new THREE.Points(geom, mat)
    points.frustumCulled = false
    points.userData.particles = particles
    this.scene.add(points)
    this.groups[type] = { points, particles }
  }

  /**
   * 构建撞击飞溅粒子池（预分配，动态激活）
   */
  _buildImpactPools() {
    const poolY = -9999
    this._impactDustPool = []
    this._impactSparkPool = []

    // 扬尘池（减量：400→60，尺寸缩小避免遮挡）
    // 修正：移除 rise:0.5（隧道内扬尘不应持续上升，由 gravity 自然下沉）
    for (let i = 0; i < 60; i++) {
      const p = new EffectParticle({
        x: 0,
        y: poolY,
        z: 0,
        size: 3 + Math.random() * 6,
        life: 0.01,
        cr: 0.5,
        cg: 0.48,
        cb: 0.44,
        gravity: -0.3,
        turbulence: 1.5,
        expand: 1.5
      })
      p.alive = false
      this._impactDustPool.push(p)
    }
    // 火花池（减量：200→30）
    for (let i = 0; i < 30; i++) {
      const p = new EffectParticle({
        x: 0,
        y: poolY,
        z: 0,
        size: 2 + Math.random() * 3,
        life: 0.01,
        cr: 1,
        cg: 0.85,
        cb: 0.3,
        gravity: 9.8,
        drag: 0.01
      })
      p.alive = false
      this._impactSparkPool.push(p)
    }

    // 构建池的 Points 系统
    this._buildPoints(EFFECT_TYPES.IMPACT_DUST, this._impactDustPool)
    if (this.groups[EFFECT_TYPES.IMPACT_DUST]) {
      this.groups[EFFECT_TYPES.IMPACT_DUST].points.visible = false
    }
    this._buildPoints(EFFECT_TYPES.IMPACT_SPARK, this._impactSparkPool)
    if (this.groups[EFFECT_TYPES.IMPACT_SPARK]) {
      this.groups[EFFECT_TYPES.IMPACT_SPARK].points.visible = false
    }
  }

  /**
   * 更新所有特效粒子
   * @param {number} dt - 时间步长(s)
   * @param {number} [simTime] - 当前模拟时间(s)：未达到粒子 bornAt 时不老化、不渲染
   *                             （主爆破粒子从起爆时刻才开始涌现）
   */
  update(dt, simTime = 0) {
    this._simTime = simTime
    for (const [type, group] of Object.entries(this.groups)) {
      const { points, particles } = group
      if (!points) continue

      const posAttr = points.geometry.attributes.position
      const sizeAttr = points.geometry.attributes.aSize
      const opAttr = points.geometry.attributes.aOpacity
      const colAttr = points.geometry.attributes.aColor

      let hasAlive = false
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        // 出生前：冻结状态、完全不渲染（opacity=0、size=0）
        if (p.bornAt > 0 && simTime < p.bornAt) {
          opAttr.array[i] = 0
          sizeAttr.array[i] = 0
          continue
        }
        if (!p.alive) {
          opAttr.array[i] = 0
          sizeAttr.array[i] = 0
          continue
        }
        hasAlive = true

        // 生命期
        p.life -= dt
        if (p.life <= 0) {
          p.alive = false
          opAttr.array[i] = 0
          sizeAttr.array[i] = 0
          continue
        }

        const lifeRatio = 1 - p.life / p.maxLife

        // 物理更新
        if (
          type === EFFECT_TYPES.FIRE ||
          type === EFFECT_TYPES.SPARK ||
          type === EFFECT_TYPES.IMPACT_SPARK
        ) {
          p.velY -= (p.gravity || 9.8) * dt
        } else {
          p.velY += (p.rise || 0) * dt
          p.velY -= (p.gravity || 0) * dt
        }
        // 阻力
        if (p.drag > 0) {
          const spd = Math.sqrt(p.velX * p.velX + p.velY * p.velY + p.velZ * p.velZ)
          if (spd > 0.01) {
            const decel = (p.drag / 0.1) * spd
            const factor = Math.max(0, 1 - decel * dt)
            p.velX *= factor
            p.velY *= factor
            p.velZ *= factor
          }
        }
        // 湍流
        if (p.turbulence > 0) {
          p.turbPhase += dt * 3
          p.velX += Math.sin(p.turbPhase) * p.turbulence * dt * 0.5
          p.velZ += Math.cos(p.turbPhase * 1.3) * p.turbulence * dt * 0.5
        }
        p.posX += p.velX * dt
        p.posY += p.velY * dt
        p.posZ += p.velZ * dt

        // 约束特效粒子不跑出隧道截面外（火花/火球易穿过巷道壁渲染到岩层里）
        if (p.bornAt > 0 && this._face && simTime >= p.bornAt) {
          this._constrainToTunnel(p)
        }

        // 渲染属性
        if (type === EFFECT_TYPES.FIRE) {
          p.opacity = Math.min(0.72, lifeRatio * 1.5) * (1 - Math.pow(1 - lifeRatio, 3))
          p.size = p.baseSize * (1 + lifeRatio * 1.5)
        } else if (type === EFFECT_TYPES.SMOKE || type === EFFECT_TYPES.IMPACT_DUST) {
          // 烟雾：大团淡灰在暗隧道中清晰可见（上限 0.3），随生命期渐隐，不糊屏
          p.opacity = Math.min(0.3, (1 - lifeRatio) * 0.42)
          p.size = p.baseSize * (1 + lifeRatio * (p.expand || 2))
        } else if (type === EFFECT_TYPES.DUST) {
          // 粉尘：上限 0.24，多团慢速扩散
          p.opacity = Math.min(0.24, (1 - lifeRatio) * 0.36)
          p.size = p.baseSize * (1 + lifeRatio * (p.expand || 1.8))
        } else if (type === EFFECT_TYPES.SHOCK_WAVE) {
          p.opacity = lifeRatio * 0.45
          p.size = p.baseSize + (1 - lifeRatio) * (p.expand || 120)
        } else {
          // 火花
          p.opacity = Math.max(0, 1 - lifeRatio)
        }
        p.angle += p.angleSpeed * dt

        posAttr.array[i * 3] = p.posX
        posAttr.array[i * 3 + 1] = p.posY
        posAttr.array[i * 3 + 2] = p.posZ
        sizeAttr.array[i] = p.size
        opAttr.array[i] = p.opacity
        colAttr.array[i * 3] = p.colorR
        colAttr.array[i * 3 + 1] = p.colorG
        colAttr.array[i * 3 + 2] = p.colorB
      }

      posAttr.needsUpdate = true
      sizeAttr.needsUpdate = true
      opAttr.needsUpdate = true
      colAttr.needsUpdate = true
      // 撞击粒子跟随父图层可见性
      let layerOn = this.layerVisibility[type] !== false
      if (type === EFFECT_TYPES.IMPACT_DUST) layerOn = this.layerVisibility.dust !== false
      if (type === EFFECT_TYPES.IMPACT_SPARK) layerOn = this.layerVisibility.spark !== false
      // 泛光光斑总开关（火花/火球/冲击波属辉光类）
      if (
        type === EFFECT_TYPES.SPARK ||
        type === EFFECT_TYPES.FIRE ||
        type === EFFECT_TYPES.SHOCK_WAVE ||
        type === EFFECT_TYPES.IMPACT_SPARK
      ) {
        layerOn = layerOn && this._glowMaster !== false
      }
      points.visible = hasAlive && layerOn
    }
  }

  /**
   * 在碎片落地位置触发撞击飞溅
   * @param {{x:number,y:number,z:number}} pos - 撞击点世界坐标
   * @param {number} impactSpeed - 撞击速度(m/s)
   */
  spawnImpactDebris(pos, impactSpeed) {
    if (!pos) return

    // 激活扬尘
    let spawned = 0
    for (const p of this._impactDustPool) {
      if (p.alive) continue
      p.posX = pos.x + (Math.random() - 0.5) * 0.5
      p.posY = pos.y + 0.2
      p.posZ = pos.z + (Math.random() - 0.5) * 0.5
      p.velX = (Math.random() - 0.5) * 1
      p.velY = 0.5 + Math.random() * 1.5
      p.velZ = (Math.random() - 0.5) * 1
      p.life = 0.3 + Math.random() * 0.4
      p.maxLife = p.life
      p.opacity = 1
      p.alive = true
      p.bornAt = this._simTime || 0 // 落地即出生（当前模拟时刻）
      p.size = 2 + Math.random() * 3
      p.baseSize = p.size
      spawned++
      if (spawned >= 2) break
    }

    // 激活火花（仅在高速碰撞时）
    if (impactSpeed > 8) {
      spawned = 0
      for (const p of this._impactSparkPool) {
        if (p.alive) continue
        p.posX = pos.x
        p.posY = pos.y + 0.2
        p.posZ = pos.z
        const theta = Math.random() * Math.PI * 2
        const phi = Math.random() * Math.PI * 0.4
        const speed = 5 + Math.random() * 10
        p.velX = Math.cos(theta) * Math.sin(phi) * speed
        p.velY = Math.cos(phi) * speed + 3
        p.velZ = Math.sin(theta) * Math.sin(phi) * speed
        p.life = 0.3 + Math.random() * 0.4
        p.maxLife = p.life
        p.opacity = 1
        p.alive = true
        p.bornAt = this._simTime || 0 // 落地即出生（当前模拟时刻）
        p.size = 1.5 + Math.random() * 2
        p.baseSize = p.size
        spawned++
        if (spawned >= 2) break
      }
    }

    // 触发可见性
    const dustGrp = this.groups[EFFECT_TYPES.IMPACT_DUST]
    if (dustGrp) dustGrp.points.visible = true
    const sparkGrp = this.groups[EFFECT_TYPES.IMPACT_SPARK]
    if (sparkGrp) sparkGrp.points.visible = true
  }

  /**
   * 获取火球光照强度（供动态点光源使用）
   */
  getFireLightIntensity() {
    const grp = this.groups[EFFECT_TYPES.FIRE]
    if (!grp) return 0
    const alive = grp.particles.filter(p => p.alive)
    if (alive.length === 0) return 0
    const avgLife = alive.reduce((s, p) => s + p.life / p.maxLife, 0) / alive.length
    return avgLife * 0.6
  }

  /**
   * 设置特效图层可见性
   */
  setVisible(type, visible) {
    this.layerVisibility[type] = visible
    const grp = this.groups[type]
    if (grp) grp.points.visible = visible
  }

  /**
   * 将特效粒子位置约束在马蹄形/圆形/矩形隧道截面内，防止火花/火球等
   * 穿过巷道壁渲染到岩层里（"特效跑到巷道外"）。
   * 实现：世界坐标投影到截面局部系（right/up/轴向），约束横向与竖向，
   * 再投影回世界坐标；轴向（沿隧道方向）不做限制，允许正常扩散。
   */
  _constrainToTunnel(p) {
    const face = this._face
    if (!face) return

    // 世界坐标 → 掌子面局部坐标
    const dx = p.posX - face.cx
    const dy = p.posY - face.cy
    const dz = p.posZ - face.cz
    let lx = dx * face.rx + dy * face.ry + dz * face.rz // 横向（面内右侧）
    let ly = dx * face.ux + dy * face.uy + dz * face.uz // 竖向（面内上方）
    const ln = dx * face.nx + dy * face.ny + dz * face.nz // 轴向（沿隧道，保留不变）

    const halfW = face.width / 2
    const hw = face.wallHeight
    const R = face.archRadius
    const sv = 0.95 // 内缩安全系数，避免贴壁

    // 侧墙约束（左右对称）
    const lxLimit = halfW * sv
    lx = Math.max(-lxLimit, Math.min(lxLimit, lx))

    // 底板约束（y ≥ 0，不穿地）
    ly = Math.max(0, ly)

    // 拱部/顶部约束
    if (face.shape === 'circular') {
      // 圆形断面：圆心在 y = R（半径半径取拱顶到圆心距离），整圆按 R 约束
      const cy = R
      const du = ly - cy
      const limit = R * sv
      const d = Math.hypot(lx, du)
      if (d > limit) {
        const s = limit / Math.max(1e-6, d)
        lx *= s
        ly = cy + du * s
      }
    } else if (face.shape === 'horseshoe' && ly > hw) {
      // 马蹄形：直墙以上为半圆弧，圆心在高度 hw
      const du = ly - hw
      const limit = R * sv
      const d = Math.hypot(lx, du)
      if (d > limit) {
        const s = limit / Math.max(1e-6, d)
        lx *= s
        ly = hw + du * s
      }
    } else if (face.shape === 'rectangular') {
      // 矩形断面：仅约束直墙高度
      ly = Math.min(hw * sv, ly)
    }

    // 局部坐标 → 世界坐标（含轴向分量，保持沿隧道深度不变）
    p.posX = face.cx + face.rx * lx + face.ux * ly + face.nx * ln
    p.posY = face.cy + face.ry * lx + face.uy * ly + face.ny * ln
    p.posZ = face.cz + face.rz * lx + face.uz * ly + face.nz * ln
  }

  /**
   * 泛光光斑总开关：统一管控所有辉光类粒子（火花/火球/冲击波/落地火星）的显隐。
   * 与各粒子图层开关做"与"运算——总开关关闭时，即使单独图层为开也不显示。
   */
  setGlowVisible(visible) {
    this._glowMaster = !!visible
    const glowLayers = [
      EFFECT_TYPES.SPARK,
      EFFECT_TYPES.FIRE,
      EFFECT_TYPES.SHOCK_WAVE,
      EFFECT_TYPES.IMPACT_SPARK
    ]
    for (const t of glowLayers) {
      const grp = this.groups[t]
      if (!grp) continue
      const layerOn =
        t === EFFECT_TYPES.IMPACT_SPARK
          ? this.layerVisibility.spark !== false
          : this.layerVisibility[t] !== false
      grp.points.visible = this._glowMaster && layerOn
    }
  }

  /**
   * 批量设置图层可见性
   */
  setLayersVisible(map) {
    for (const [type, vis] of Object.entries(map)) {
      this.setVisible(type, vis)
    }
  }

  /**
   * 获取图层可见性
   */
  getLayerVisibility() {
    return { ...this.layerVisibility }
  }

  /**
   * 清除所有特效
   */
  clear() {
    for (const grp of Object.values(this.groups)) {
      if (grp.points) {
        this.scene.remove(grp.points)
        grp.points.geometry.dispose()
      }
    }
    this.groups = {}
    this._impactDustPool = []
    this._impactSparkPool = []
  }

  /**
   * 销毁（释放 GPU 资源）
   */
  dispose() {
    this.clear()
    for (const mat of this._shaderMaterialCache.values()) {
      mat.dispose()
    }
    this._shaderMaterialCache.clear()
    for (const tex of Object.values(this.textures)) {
      tex.dispose()
    }
  }
}

export default BlastEffectManager
