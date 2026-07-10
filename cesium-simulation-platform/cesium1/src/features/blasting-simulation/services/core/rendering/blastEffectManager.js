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
  canvas.width = size; canvas.height = size
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
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * size, y = Math.random() * size
    const r = Math.random() * 4 + 1
    const g = Math.floor(100 + Math.random() * 100)
    ctx.fillStyle = `rgba(${g},${g},${g},${Math.random() * 0.6})`
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

// ─── 内部粒子数据 ──────────────────────────────────────
class EffectParticle {
  constructor(opts = {}) {
    this.posX = opts.x || 0; this.posY = opts.y || 0; this.posZ = opts.z || 0
    this.velX = opts.vx || 0; this.velY = opts.vy || 0; this.velZ = opts.vz || 0
    this.size = opts.size || 1; this.baseSize = this.size
    this.opacity = 1
    this.life = opts.life || 1; this.maxLife = this.life
    this.colorR = opts.cr || 1; this.colorG = opts.cg || 1; this.colorB = opts.cb || 1
    this.angle = Math.random() * Math.PI * 2; this.angleSpeed = (Math.random() - 0.5) * 3
    this.gravity = opts.gravity ?? 0
    this.drag = opts.drag ?? 0
    this.rise = opts.rise ?? 0
    this.expand = opts.expand ?? 0
    this.turbulence = opts.turbulence ?? 0
    this.turbPhase = Math.random() * Math.PI * 2
    this.alive = true
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

    // 图层可见性
    this.layerVisibility = {
      fire: true, smoke: true, spark: true, dust: true, shock_wave: true,
      stress_wave: true  // 阶段四：应力波环
    }

    // 编译 ShaderMaterial（缓存复用）
    this._shaderMaterialCache = new Map()

    // ── 应力波环（阶段四） ──────────────────────────
    /** @type {THREE.Mesh|null} */
    this.stressWaveMesh = null
    /** @type {THREE.ShaderMaterial|null} */
    this.stressWaveMaterial = null
    this._stressWaveCenter = { x: 0, y: 0, z: 0 }
    this._stressWaveElapsed = 0
    this._stressWaveMaxTime = 0.5  // 应力波传播持续时间(s)
  }

  /**
   * 初始化爆破特效粒子
   * @param {Object} opts
   * @param {number} opts.chargeKg
   * @param {{x:number,y:number,z:number}} opts.center - 爆心世界坐标
   * @param {{x:number,y:number,z:number}} opts.throwDir - 抛掷方向（单位向量，指向已开挖侧）
   * @param {{x:number,y:number,z:number}} opts.right - 横向方向
   * @param {{x:number,y:number,z:number}} opts.up - 竖向方向
   * @param {Object} opts.tunnelSection - {width, wallHeight, archRadius, shape}
   * @param {Object} opts.kcoOutput - {A} 岩石因子
   */
  init(opts = {}) {
    this.clear()
    const { chargeKg = 320, center = { x: 0, y: 0, z: 0 }, throwDir, right, up,
      tunnelSection = {}, kcoOutput = {} } = opts
    const cx = center.x, cy = center.y, cz = center.z
    const rockA = kcoOutput.A || 3.6

    const allParticles = []

    // ── 火球 ──
    const fireCount = Math.min(120, Math.max(20, Math.floor(chargeKg / 5 * (1 + rockA * 0.1))))
    const fireParticles = []
    for (let i = 0; i < fireCount; i++) {
      const rad = Math.random() * 1.5
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.5
      const speed = 5 + Math.random() * 15
      fireParticles.push(new EffectParticle({
        x: cx + Math.cos(theta) * Math.sin(phi) * rad,
        y: cy + Math.sin(theta) * Math.sin(phi) * rad,
        z: cz + Math.cos(phi) * rad,
        vx: Math.cos(theta) * Math.sin(phi) * speed,
        vy: Math.sin(theta) * Math.sin(phi) * speed,
        vz: Math.cos(phi) * speed + 3,
        size: 4 + Math.random() * 8,
        life: 0.08 + Math.random() * 0.08,
        cr: 1, cg: 0.5 + Math.random() * 0.3, cb: 0.05 + Math.random() * 0.1,
        gravity: -1,
        expand: 1.5
      }))
    }
    allParticles.push({ type: EFFECT_TYPES.FIRE, list: fireParticles })

    // ── 火花 ──
    const sparkCount = Math.min(80, Math.max(15, Math.floor(chargeKg / 10 * (1 + rockA * 0.15))))
    const sparkParticles = []
    for (let i = 0; i < sparkCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.5
      const speed = 20 + Math.random() * 60
      sparkParticles.push(new EffectParticle({
        x: cx, y: cy, z: cz,
        vx: Math.cos(theta) * Math.sin(phi) * speed,
        vy: Math.sin(theta) * Math.sin(phi) * speed,
        vz: Math.cos(phi) * speed,
        size: 2 + Math.random() * 3,
        life: 0.2 + Math.random() * 0.25,
        cr: 1, cg: 0.85, cb: 0.3,
        gravity: 9.8,
        drag: 0.01
      }))
    }
    allParticles.push({ type: EFFECT_TYPES.SPARK, list: sparkParticles })

    // ── 烟雾（沿隧道轴向扩散，不向上柱状升起） ──
    // 修正：原 vy 偏置 +1.0 与 rise:1.0 会让烟雾垂直上飘，违反隧道约束
    const smokeCount = Math.min(30, Math.max(8, Math.floor(chargeKg / 25)))
    const smokeParticles = []
    for (let i = 0; i < smokeCount; i++) {
      const speed = 1 + Math.random() * 3
      const lx = (Math.random() - 0.5) * (tunnelSection.width || 18) * 0.8
      const lh = Math.random() * ((tunnelSection.wallHeight || 6) + (tunnelSection.archRadius || 9))
      smokeParticles.push(new EffectParticle({
        x: cx + (right ? right.x * lx : lx),
        y: cy + lh,
        z: cz + (right ? right.z * lx : 0),
        vx: (throwDir ? throwDir.x * speed : speed) + (Math.random() - 0.5) * 1,
        vy: (Math.random() - 0.5) * 0.5,  // 围绕 0，不再偏上
        vz: (throwDir ? throwDir.z * speed : 0) + (Math.random() - 0.5) * 1,
        size: 2 + Math.random() * 4,
        life: 0.8 + Math.random() * 0.6,
        cr: 0.25, cg: 0.25, cb: 0.25,
        gravity: 0.05,  // 轻微下沉（正重力=下沉，隧道内烟尘自然沉降），原 -0.2 过强
        turbulence: 1.5,
        expand: 2
        // rise: 1.0 已移除（持续上升力违反隧道轴向约束）
      }))
    }
    allParticles.push({ type: EFFECT_TYPES.SMOKE, list: smokeParticles })

    // ── 粉尘（减量+快速消散） ──
    const dustCount = Math.max(4, Math.floor(Math.min(20, chargeKg / 20)))
    const dustParticles = []
    for (let i = 0; i < dustCount; i++) {
      const speed = 3 + Math.random() * 6
      const lx = (Math.random() - 0.5) * (tunnelSection.width || 18) * 0.7
      const lh = Math.random() * ((tunnelSection.wallHeight || 6) + (tunnelSection.archRadius || 9)) * 0.7
      dustParticles.push(new EffectParticle({
        x: cx + (right ? right.x * lx : lx),
        y: cy + lh,
        z: cz + (right ? right.z * lx : 0),
        vx: (throwDir ? throwDir.x * speed : speed) + (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 1,
        vz: (throwDir ? throwDir.z * speed : 0) + (Math.random() - 0.5) * 2,
        size: 2 + Math.random() * 3,
        life: 0.8 + Math.random() * 0.6,
        cr: 0.5, cg: 0.48, cb: 0.44,
        gravity: 0.1,
        turbulence: 1.5,
        expand: 1.5
      }))
    }
    allParticles.push({ type: EFFECT_TYPES.DUST, list: dustParticles })

    // ── 冲击波 ──
    const shockParticles = []
    for (let i = 0; i < 3; i++) {
      shockParticles.push(new EffectParticle({
        x: cx, y: cy, z: cz,
        size: 5 + i * 5,
        life: 0.8,
        cr: 1, cg: 0.8, cb: 0.2,
        gravity: 0,
        expand: 100 + i * 30
      }))
    }
    allParticles.push({ type: EFFECT_TYPES.SHOCK_WAVE, list: shockParticles })

    // 构建 Points 系统
    for (const { type, list } of allParticles) {
      if (list.length === 0) continue
      this._buildPoints(type, list)
    }

    // 构建撞击飞溅池
    this._buildImpactPools()

    // ── 构建应力波环（阶段四） ──
    this._buildStressWave(center, tunnelSection)
  }

  /**
   * 构建应力波传播环（Shader 驱动）
   *
   * 使用自定义 ShaderMaterial 在掌子面上渲染扩散的应力波环。
   * 波速 = 岩体 P 波速度 4500 m/s，到达隧道边界后衰减消失。
   *
   * @param {{x:number,y:number,z:number}} center - 爆心世界坐标
   * @param {Object} tunnelSection - 隧道截面参数
   */
  _buildStressWave(center, tunnelSection = {}) {
    // 清除旧的
    if (this.stressWaveMesh) {
      this.scene.remove(this.stressWaveMesh)
      this.stressWaveMesh.geometry.dispose()
    }

    // 3D 球面波：使用单位球 + 动态缩放实现球壳扩散
    const maxRadius = Math.max(
      (tunnelSection.width || 12),
      (tunnelSection.wallHeight || 5) + (tunnelSection.archRadius || 6)
    ) * 1.5

    // 单位球（半径=1），通过 mesh.scale 动态放大实现波传播
    const geo = new THREE.SphereGeometry(1, 48, 32)
    this.stressWaveMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uElapsed: { value: 0 },
        uMaxTime: { value: this._stressWaveMaxTime },
        uOpacity: { value: 0.6 }
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uElapsed;
        uniform float uMaxTime;
        uniform float uOpacity;
        varying vec3 vNormal;
        varying vec3 vViewDir;

        void main() {
          // Fresnel 效应：球面边缘（掠射角）更亮，正面较暗
          // 模拟应力波在球壳表面的能量分布
          float fresnel = 1.0 - abs(dot(vNormal, vViewDir));
          fresnel = pow(fresnel, 1.5);

          // 时间衰减：波前能量随传播距离衰减
          float timeDecay = 1.0 - smoothstep(0.0, uMaxTime, uElapsed);

          // 颜色渐变：中心白热 → 边缘橙红（模拟高温高压波前冷却）
          vec3 coreColor = vec3(1.0, 0.95, 0.8);    // 白热
          vec3 edgeColor = vec3(1.0, 0.4, 0.05);     // 橙红
          vec3 waveColor = mix(coreColor, edgeColor, fresnel);

          // 透明度：Fresnel 增强边缘可见性 + 时间衰减
          float alpha = (0.15 + fresnel * 0.6) * timeDecay * uOpacity;

          gl_FragColor = vec4(waveColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,  // 渲染球内壁，从外部可看到球壳
      blending: THREE.AdditiveBlending
    })

    this.stressWaveMesh = new THREE.Mesh(geo, this.stressWaveMaterial)
    this.stressWaveMesh.position.set(center.x, center.y, center.z)
    this.stressWaveMesh.scale.set(0.01, 0.01, 0.01)  // 初始极小
    // 爆破前隐藏，仅在 _triggerBlast → triggerStressWave 时显示
    this.stressWaveMesh.visible = false
    this.scene.add(this.stressWaveMesh)

    this._stressWaveCenter = { ...center }
    this._stressWaveElapsed = 0
    this._stressWaveMaxRadius = maxRadius
  }

  /**
   * 触发应力波传播（在爆破触发时调用）
   * 重置计时器为 0 并显示波环，由 update() 驱动传播
   */
  triggerStressWave() {
    if (!this.stressWaveMesh || !this.stressWaveMaterial) return
    this._stressWaveElapsed = 0
    const u = this.stressWaveMaterial.uniforms
    u.uElapsed.value = 0
    u.uOpacity.value = 0.6
    this.stressWaveMesh.scale.set(0.01, 0.01, 0.01)  // 从极小开始扩散
    this.stressWaveMesh.visible = this.layerVisibility.stress_wave !== false
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
      posArr[i * 3] = p.posX; posArr[i * 3 + 1] = p.posY; posArr[i * 3 + 2] = p.posZ
      sizeArr[i] = p.size
      opArr[i] = p.alive ? 1 : 0
      colArr[i * 3] = p.colorR; colArr[i * 3 + 1] = p.colorG; colArr[i * 3 + 2] = p.colorB
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
      const isAdditive = type === EFFECT_TYPES.FIRE || type === EFFECT_TYPES.SPARK || type === EFFECT_TYPES.SHOCK_WAVE
      // 阶段七：粒子深度排序
      // - 半透明粒子（烟雾/粉尘）：depthTest=true 使隧道壁能正确遮挡，depthWrite=false 避免互相遮挡
      // - 发光粒子（火焰/火花/冲击波）：depthTest=false 使叠加光效穿透烟雾层（光辐射物理特性）
      mat = new THREE.ShaderMaterial({
        uniforms: { uTexture: { value: this.textures[type] || this.textures.dust } },
        vertexShader, fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: !isAdditive,
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
        x: 0, y: poolY, z: 0,
        size: 3 + Math.random() * 6,
        life: 0.01,
        cr: 0.5, cg: 0.48, cb: 0.44,
        gravity: 0.3, turbulence: 1.5, expand: 1.5
      })
      p.alive = false
      this._impactDustPool.push(p)
    }
    // 火花池（减量：200→30）
    for (let i = 0; i < 30; i++) {
      const p = new EffectParticle({
        x: 0, y: poolY, z: 0,
        size: 2 + Math.random() * 3,
        life: 0.01,
        cr: 1, cg: 0.85, cb: 0.3,
        gravity: 9.8, drag: 0.01
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
   */
  update(dt) {
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
        if (!p.alive) {
          opAttr.array[i] = 0; sizeAttr.array[i] = 0
          continue
        }
        hasAlive = true

        // 生命期
        p.life -= dt
        if (p.life <= 0) { p.alive = false; opAttr.array[i] = 0; sizeAttr.array[i] = 0; continue }

        const lifeRatio = 1 - p.life / p.maxLife

        // 物理更新
        if (type === EFFECT_TYPES.FIRE || type === EFFECT_TYPES.SPARK || type === EFFECT_TYPES.IMPACT_SPARK) {
          p.velY -= (p.gravity || 9.8) * dt
        } else {
          p.velY += (p.rise || 0) * dt
          p.velY -= (p.gravity || 0) * dt
        }
        // 阻力
        if (p.drag > 0) {
          const spd = Math.sqrt(p.velX * p.velX + p.velY * p.velY + p.velZ * p.velZ)
          if (spd > 0.01) {
            const decel = p.drag / 0.1 * spd
            const factor = Math.max(0, 1 - decel * dt)
            p.velX *= factor; p.velY *= factor; p.velZ *= factor
          }
        }
        // 湍流
        if (p.turbulence > 0) {
          p.turbPhase += dt * 3
          p.velX += Math.sin(p.turbPhase) * p.turbulence * dt * 0.5
          p.velZ += Math.cos(p.turbPhase * 1.3) * p.turbulence * dt * 0.5
        }
        p.posX += p.velX * dt; p.posY += p.velY * dt; p.posZ += p.velZ * dt

        // 渲染属性
        if (type === EFFECT_TYPES.FIRE) {
          p.opacity = Math.min(0.7, lifeRatio * 1.5) * (1 - Math.pow(1 - lifeRatio, 3))
          p.size = p.baseSize * (1 + lifeRatio * 1.5)
        } else if (type === EFFECT_TYPES.SMOKE || type === EFFECT_TYPES.IMPACT_DUST) {
          p.opacity = Math.min(0.10, (1 - lifeRatio) * 0.15)
          p.size = p.baseSize * (1 + lifeRatio * (p.expand || 2))
        } else if (type === EFFECT_TYPES.DUST) {
          p.opacity = Math.min(0.08, (1 - lifeRatio) * 0.12)
          p.size = p.baseSize * (1 + lifeRatio * (p.expand || 1.5))
        } else if (type === EFFECT_TYPES.SHOCK_WAVE) {
          p.opacity = lifeRatio * 0.4
          p.size = p.baseSize + (1 - lifeRatio) * (p.expand || 100)
        } else {
          // 火花
          p.opacity = Math.max(0, 1 - lifeRatio)
        }
        p.angle += p.angleSpeed * dt

        posAttr.array[i * 3] = p.posX; posAttr.array[i * 3 + 1] = p.posY; posAttr.array[i * 3 + 2] = p.posZ
        sizeAttr.array[i] = p.size
        opAttr.array[i] = p.opacity
        colAttr.array[i * 3] = p.colorR; colAttr.array[i * 3 + 1] = p.colorG; colAttr.array[i * 3 + 2] = p.colorB
      }

      posAttr.needsUpdate = true
      sizeAttr.needsUpdate = true
      opAttr.needsUpdate = true
      colAttr.needsUpdate = true
      // 撞击粒子跟随父图层可见性
      let layerOn = this.layerVisibility[type] !== false
      if (type === EFFECT_TYPES.IMPACT_DUST) layerOn = this.layerVisibility.dust !== false
      if (type === EFFECT_TYPES.IMPACT_SPARK) layerOn = this.layerVisibility.spark !== false
      points.visible = hasAlive && layerOn
    }

    // ── 应力波球面传播更新（阶段四） ──
    if (this.stressWaveMaterial && this.stressWaveMesh) {
      this._stressWaveElapsed += dt
      // 可视化波速 50 m/s（真实 P 波 4500m/s 在 27m 断面内仅 6ms 穿过，肉眼不可见）
      // 降至 50 m/s 使球壳在 0.5s 内从爆心扩散到隧道边界，视觉上清晰可见
      const waveSpeed = 50
      const radius = waveSpeed * this._stressWaveElapsed
      // 动态缩放球壳（单位球 → 当前波半径）
      this.stressWaveMesh.scale.set(radius, radius, radius)
      const u = this.stressWaveMaterial.uniforms
      u.uElapsed.value = this._stressWaveElapsed
      // 超过最大时间后隐藏
      if (this._stressWaveElapsed > this._stressWaveMaxTime) {
        this.stressWaveMesh.visible = false
      } else {
        this.stressWaveMesh.visible = this.layerVisibility.stress_wave !== false
      }
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
      p.velX = (Math.random() - 0.5) * 1; p.velY = 0.5 + Math.random() * 1.5; p.velZ = (Math.random() - 0.5) * 1
      p.life = 0.3 + Math.random() * 0.4; p.maxLife = p.life
      p.opacity = 1; p.alive = true
      p.size = 2 + Math.random() * 3; p.baseSize = p.size
      spawned++
      if (spawned >= 2) break
    }

    // 激活火花（仅在高速碰撞时）
    if (impactSpeed > 8) {
      spawned = 0
      for (const p of this._impactSparkPool) {
        if (p.alive) continue
        p.posX = pos.x; p.posY = pos.y + 0.2; p.posZ = pos.z
        const theta = Math.random() * Math.PI * 2
        const phi = Math.random() * Math.PI * 0.4
        const speed = 5 + Math.random() * 10
        p.velX = Math.cos(theta) * Math.sin(phi) * speed
        p.velY = Math.cos(phi) * speed + 3
        p.velZ = Math.sin(theta) * Math.sin(phi) * speed
        p.life = 0.3 + Math.random() * 0.4; p.maxLife = p.life
        p.opacity = 1; p.alive = true
        p.size = 1.5 + Math.random() * 2; p.baseSize = p.size
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
    // 应力波环单独管理（非粒子系统）
    if (type === 'stress_wave' && this.stressWaveMesh) {
      this.stressWaveMesh.visible = visible && this._stressWaveElapsed <= this._stressWaveMaxTime
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

    // 清除应力波环（阶段四）
    if (this.stressWaveMesh) {
      this.scene.remove(this.stressWaveMesh)
      this.stressWaveMesh.geometry.dispose()
      this.stressWaveMesh = null
    }
    if (this.stressWaveMaterial) {
      this.stressWaveMaterial.dispose()
      this.stressWaveMaterial = null
    }
    this._stressWaveElapsed = 0
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
