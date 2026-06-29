/**
 * Three.js 爆破粒子渲染器
 * 基于 GPU 粒子系统实现真实爆破效果：
 *  - 火球（膨胀消散 + 颜色渐变 + 闪烁）
 *  - 烟雾柱（蘑菇云 + 上升膨胀 + 湍流）
 *  - 火花（高速拖尾 + 重力衰减）
 *  - 岩石碎片（旋转 + 落地堆积）
 *  - 冲击波（球面扩散 + 透明度衰减）
 *
 * 该渲染器运行在独立的 three.js 场景中，通过 Cesium-Three 桥接器同步相机。
 */
import * as THREE from 'three'

// ─── 粒子类型常量 ──────────────────────────────────────
export const THREE_PARTICLE_TYPES = {
  FIRE: 'fire',
  SMOKE: 'smoke',
  SPARK: 'spark',
  FRAGMENT: 'fragment',
  SHOCK_WAVE: 'shock_wave',
  DUST: 'dust'
}

// ─── 粒子纹理生成（程序化，无需外部资源） ──────────────
function createFireTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.2, 'rgba(255,220,120,0.9)')
  gradient.addColorStop(0.5, 'rgba(255,120,20,0.6)')
  gradient.addColorStop(0.8, 'rgba(180,40,10,0.2)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function createSmokeTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // 噪声烟雾纹理
  const imageData = ctx.createImageData(size, size)
  const data = imageData.data
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const dx = i - size / 2
      const dy = j - size / 2
      const dist = Math.sqrt(dx * dx + dy * dy) / (size / 2)
      const noise = Math.random() * 0.3 + 0.7
      const alpha = Math.max(0, (1 - dist) * noise)
      const idx = (i * size + j) * 4
      data[idx] = 80 + Math.random() * 40
      data[idx + 1] = 80 + Math.random() * 40
      data[idx + 2] = 80 + Math.random() * 40
      data[idx + 3] = alpha * 255
    }
  }
  ctx.putImageData(imageData, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function createSparkTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,200,1)')
  gradient.addColorStop(0.3, 'rgba(255,200,50,0.8)')
  gradient.addColorStop(1, 'rgba(255,100,0,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function createFragmentTexture() {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#8a5a2b'
  ctx.fillRect(0, 0, size, size)
  // 添加岩石纹理噪点
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = Math.random() * 3 + 1
    const gray = 100 + Math.random() * 80
    ctx.fillStyle = `rgba(${gray},${gray * 0.7},${gray * 0.4},${Math.random() * 0.5})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

// ─── 3D 岩石几何体生成（低多边形，用于实例化渲染） ───
function createRockGeometry(seed = 0) {
  // 基于二十面体细分1（80面），通过随机扰动顶点产生不规则岩石形状
  const geo = new THREE.IcosahedronGeometry(1, 1) // 细分 1，80 面
  const positions = geo.attributes.position
  const rng = (() => {
    let s = (seed + 1) >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  })()
  // 对每个顶点进行非均匀缩放，产生扁平/拉长的岩石形状
  const flatten = 0.5 + rng() * 0.4 // 0.5~0.9，使岩石扁平
  const stretchX = 0.8 + rng() * 0.6
  const stretchZ = 0.8 + rng() * 0.6
  for (let i = 0; i < positions.count; i++) {
    const factor = 0.6 + rng() * 0.6 // 0.6~1.2
    positions.setXYZ(
      i,
      positions.getX(i) * factor * stretchX,
      positions.getY(i) * factor * flatten,
      positions.getZ(i) * factor * stretchZ
    )
  }
  geo.computeVertexNormals()
  return geo
}

// 预生成多种岩石几何变体，避免所有碎片看起来一样
const ROCK_GEOMETRY_VARIANTS = 4
function createRockGeometryPool() {
  return Array.from({ length: ROCK_GEOMETRY_VARIANTS }, (_, i) => createRockGeometry(i * 997))
}

// ─── 程序化岩石纹理（用于掌子面/台阶） ─────────────────
function createRockTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // 基础颜色：棕灰色
  ctx.fillStyle = '#6b5a47'
  ctx.fillRect(0, 0, size, size)
  // 添加岩石纹理：随机色块
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = Math.random() * 20 + 5
    const gray = 80 + Math.random() * 80
    ctx.fillStyle = `rgba(${gray},${gray * 0.8},${gray * 0.6},${Math.random() * 0.6})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // 添加裂纹
  ctx.strokeStyle = 'rgba(40,30,20,0.4)'
  ctx.lineWidth = 1
  for (let i = 0; i < 15; i++) {
    ctx.beginPath()
    ctx.moveTo(Math.random() * size, Math.random() * size)
    for (let j = 0; j < 5; j++) {
      ctx.lineTo(Math.random() * size, Math.random() * size)
    }
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(2, 2)
  tex.needsUpdate = true
  return tex
}

// ─── Rosin-Rammler 碎块尺寸分布 ───────────────────────
// 模拟爆破后岩体碎块的尺寸分布：P(d) = 1 - exp(-(d/d63)^n)
// d63 = 特征尺寸（63% 通过的筛孔），n = 均匀性指数
function sampleRosinRammlerSize(d63, n, rng = Math.random) {
  const u = rng()
  return d63 * Math.pow(-Math.log(1 - u), 1 / n)
}

// ─── 粒子数据结构 ─────────────────────────────────────
class BlastParticle {
  constructor(type, position, velocity, options = {}) {
    this.type = type
    this.position = position.clone()
    this.velocity = velocity.clone()
    this.life = options.life || 2.0
    this.maxLife = this.life
    this.size = options.size || 1.0
    this.baseSize = this.size
    // 物理尺寸（真实米数，用于空气阻力计算；与显示尺寸 size 分离）
    this.physicsSize = options.physicsSize ?? this.size
    this.color = options.color || new THREE.Color(1, 1, 1)
    this.rotation = Math.random() * Math.PI * 2
    this.rotationSpeed = (Math.random() - 0.5) * 4
    // 3D 旋转（用于实例化碎片网格）
    this.quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2
      )
    )
    this.angularVelocity = new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8
    )
    this.alive = true
    this.landed = false
    this.landedTime = -1
    this.bounceCount = 0
    this.maxBounces = options.maxBounces ?? 4
    this.gravity = options.gravity ?? 9.8
    this.drag = options.drag ?? 0.02
    this.expand = options.expand || 1.0
    this.rise = options.rise || 0
    this.turbulence = options.turbulence || 0
    this.turbPhase = Math.random() * Math.PI * 2
    this.restitution = options.restitution ?? 0.35
    this.friction = options.friction ?? 0.6
    // 落地回调（由渲染器注入，用于触发撞击飞溅：扬尘 + 火花 + 二次碎片）
    this.onLand = options.onLand || null
  }

  update(dt) {
    if (!this.alive) return
    this.life -= dt
    if (this.life <= 0) {
      this.alive = false
      return
    }

    // 重力
    if (!this.landed) {
      this.velocity.y -= this.gravity * dt
    }

    // 空气阻力（二次阻力模型：F ∝ v²，弹道系数 ∝ 1/size）
    // 小碎片面积/质量比大，减速快；大碎片弹道系数好，飞得远
    const speed = this.velocity.length()
    if (speed > 0.01) {
      // 弹道系数：drag 越小飞得越远；与物理尺寸成正比（大碎片 drag 小）
      const ballisticCoef = this.drag / Math.max(0.1, this.physicsSize)
      const dragForce = ballisticCoef * speed * speed
      this.velocity.multiplyScalar(Math.max(0, 1 - dragForce * dt))
    }

    // 烟雾上升力
    if (this.rise > 0) {
      this.velocity.y += this.rise * dt
    }

    // 湍流
    if (this.turbulence > 0) {
      this.turbPhase += dt * 3
      this.velocity.x += Math.sin(this.turbPhase) * this.turbulence * dt
      this.velocity.z += Math.cos(this.turbPhase * 1.3) * this.turbulence * dt
    }

    // 位置更新
    this.position.addScaledVector(this.velocity, dt)

    // 落地检测（改进：弹跳 + 随机偏转 + 滚动 + 飞溅回调）
    if (
      this.position.y <= 0 &&
      this.type !== THREE_PARTICLE_TYPES.SMOKE &&
      this.type !== THREE_PARTICLE_TYPES.FIRE &&
      this.type !== THREE_PARTICLE_TYPES.DUST
    ) {
      this.position.y = 0
      if (this.velocity.y < 0) {
        const impactSpeed = this.velocity.length()
        this.bounceCount++

        // 法向反弹（恢复系数随弹跳次数衰减，模拟能量损失）
        const restitutionScale = Math.pow(0.75, this.bounceCount - 1)
        this.velocity.y = -this.velocity.y * this.restitution * restitutionScale

        // 切向摩擦（降低系数让碎片滚动更远，更真实）
        this.velocity.x *= 1 - this.friction * 0.25
        this.velocity.z *= 1 - this.friction * 0.25

        // 随机水平偏转（飞溅感：撞击点不平整导致方向偏转）
        const deflectStrength = Math.min(0.6, impactSpeed * 0.02)
        const deflectAngle = Math.random() * Math.PI * 2
        this.velocity.x += Math.cos(deflectAngle) * impactSpeed * deflectStrength
        this.velocity.z += Math.sin(deflectAngle) * impactSpeed * deflectStrength

        // 角速度变化（撞击使碎片翻滚）
        this.angularVelocity.multiplyScalar(0.6)
        this.angularVelocity.x += (Math.random() - 0.5) * impactSpeed * 0.3
        this.angularVelocity.z += (Math.random() - 0.5) * impactSpeed * 0.3

        // 触发飞溅回调（首次落地时生成扬尘/火花/二次碎片）
        if (this.onLand && this.bounceCount === 1) {
          this.onLand(this.position.clone(), impactSpeed, this.size)
        }

        // 速度过小或弹跳次数用尽则停止（堆积）
        if (
          this.bounceCount >= this.maxBounces ||
          (Math.abs(this.velocity.y) < 1.0 && this.velocity.length() < 2.0)
        ) {
          this.landed = true
          this.landedTime = this.maxLife - this.life
          this.velocity.set(0, 0, 0)
          this.angularVelocity.multiplyScalar(0.1)
        }
      }
    }

    // 旋转更新（2D + 3D）；已落地碎片完全冻结，避免持续微动
    if (!this.landed) {
      this.rotation += this.rotationSpeed * dt
      if (this.type === THREE_PARTICLE_TYPES.FRAGMENT) {
        // 3D 四元数旋转（角速度积分）
        const angSpeed = this.angularVelocity.length()
        if (angSpeed > 0.001) {
          const axis = this.angularVelocity.clone().multiplyScalar(1 / angSpeed)
          const angle = angSpeed * dt
          const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle)
          this.quaternion.premultiply(dq)
        }
      }
    }

    // 大小变化（膨胀）
    const lifeRatio = 1 - this.life / this.maxLife
    if (this.type === THREE_PARTICLE_TYPES.FIRE) {
      this.size = this.baseSize * (1 + lifeRatio * 1.5)
    } else if (this.type === THREE_PARTICLE_TYPES.SMOKE) {
      this.size = this.baseSize * (1 + lifeRatio * 3)
    } else if (this.type === THREE_PARTICLE_TYPES.DUST) {
      this.size = this.baseSize * (1 + lifeRatio * 2)
    }
  }
}

// ─── 主渲染器 ─────────────────────────────────────────
export class ThreeBlastingRenderer {
  constructor(container) {
    this.container = container
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000)
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false
    })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.container.appendChild(this.renderer.domElement)

    // 纹理
    this.textures = {
      fire: createFireTexture(),
      smoke: createSmokeTexture(),
      spark: createSparkTexture(),
      fragment: createFragmentTexture()
    }

    // 粒子组
    this.particleGroups = {
      [THREE_PARTICLE_TYPES.FIRE]: null,
      [THREE_PARTICLE_TYPES.SMOKE]: null,
      [THREE_PARTICLE_TYPES.SPARK]: null,
      [THREE_PARTICLE_TYPES.FRAGMENT]: null,
      [THREE_PARTICLE_TYPES.SHOCK_WAVE]: null,
      [THREE_PARTICLE_TYPES.DUST]: null
    }

    this.particles = []
    this.clock = new THREE.Clock()
    this.center = new THREE.Vector3(0, 0, 0)
    this.chargeKg = 100
    this.active = false
    // 粒子模拟时间（秒），由时间轴驱动
    this.simTime = 0
    // 爆破触发标志（掌子面损伤演化：爆破前掌子面完整，触发后碎石化飞出）
    this.blastTriggered = false
    this.blastTriggerTime = 0.1 // 起爆时刻（秒）
    // 保存最近一次 initBlast 参数，用于时间轴跳变时重建粒子
    this._lastBlastParams = null

    // 图层可见性开关（供 UI 切换烟雾/碎石/隧道/钻孔/标注等）
    // 粒子图层：与 THREE_PARTICLE_TYPES 对应；mesh 图层：tunnel/bench/face/blastHoles/annotations
    this.layerVisibility = {
      fire: true,
      smoke: true,
      spark: true,
      fragment: true,
      shock_wave: true,
      dust: true,
      tunnel: true,
      bench: true,
      face: true,
      blastHoles: true,
      annotations: true
    }

    // 掌子面/台阶几何参数（爆破方向参考）
    this.faceDirection = new THREE.Vector3(1, 0, 0) // 默认朝 +X 方向
    this.facePosition = new THREE.Vector3(0, 0, 0) // 掌子面位置
    this.benchLength = 60 // 岩体深度(m)

    // 隧道断面参数（马蹄形：直墙 + 半圆拱，垂直于地面）
    // 尺寸放大至真实隧道规模，与碎片/烟雾比例协调
    this.tunnelWidth = 18 // 隧道宽度(m)
    this.tunnelWallHeight = 6 // 直墙高度(m)
    this.tunnelArchRadius = 9 // 拱部半径(m) = tunnelWidth/2
    this.tunnelHeight = this.tunnelWallHeight + this.tunnelArchRadius // 总高度(m)=15
    // 兼容旧字段：碎片散布范围沿用隧道断面尺寸
    this.benchHeight = this.tunnelHeight
    this.benchWidth = this.tunnelWidth

    // 3D 岩石碎片实例化网格
    this.fragmentMeshes = []
    this.rockGeometries = createRockGeometryPool()
    this.rockMaterial = null

    // 撞击飞溅粒子池（落地时激活）
    this.impactDustPool = []
    this.impactSparkPool = []
    this.impactChipPool = []

    // 掌子面/岩体网格（faceMesh=完整掌子面，faceDamagedMesh=爆破后损伤掌子面）
    this.benchMesh = null
    this.faceMesh = null
    this.faceDamagedMesh = null
    // 隧道内壁（从掌子面向已开挖侧延伸的空心马蹄形管，供内部视角观察）
    this.tunnelShellMesh = null
    // 掌子面上的爆破钻孔组（掏槽孔/辅助孔/周边孔），爆破时随掌子面消失
    this.blastHolesGroup = null

    // 光照
    this._setupLights()

    // 窗口大小调整
    this._resizeHandler = () => this.resize()
    window.addEventListener('resize', this._resizeHandler)
  }

  _setupLights() {
    // 环境光（增强至 1.4，确保隧道内部阴影中也能看清）
    const ambient = new THREE.AmbientLight(0x808890, 1.4)
    this.scene.add(ambient)

    // 方向光（模拟太阳光，照亮岩石碎片和掌子面）
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.5)
    this.sunLight.position.set(50, 80, 30)
    this.scene.add(this.sunLight)

    // 半球光（天空-地面，提供更自然的环境光照）
    const hemiLight = new THREE.HemisphereLight(0x88aaff, 0x886644, 0.8)
    this.scene.add(hemiLight)

    // 隧道内部补光（暖白色点光源，位于掌子面后方已开挖段，模拟施工照明）
    // 位置稍后由 initBlast 同步到掌子面后方，初始放原点
    this.tunnelLight = new THREE.PointLight(0xffeecc, 1.2, 80, 1.5)
    this.tunnelLight.position.set(0, 8, -10)
    this.scene.add(this.tunnelLight)

    // 爆心点光源（动态火光）
    this.fireLight = new THREE.PointLight(0xff6600, 0, 500, 2)
    this.scene.add(this.fireLight)
  }

  /**
   * 设置爆破方向（掌子面朝向）
   * @param {number} dx - 方向向量 X 分量
   * @param {number} dy - 方向向量 Y 分量
   * @param {number} dz - 方向向量 Z 分量
   */
  setFaceDirection(dx, dy, dz) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len > 0.001) {
      this.faceDirection.set(dx / len, dy / len, dz / len)
    }
  }

  /**
   * 构建隧道掌子面与岩体几何体
   * 掌子面为马蹄形（直墙 + 半圆拱）垂直平面，垂直于地面、法线沿爆破方向。
   * - benchMesh：掌子面后方待爆岩体（马蹄形挤出）
   * - faceMesh：完整掌子面（爆破前可见）
   * - faceDamagedMesh：损伤掌子面，中央带爆破漏斗洞口（爆破后可见）
   */
  _buildBenchGeometry() {
    // 清理旧网格
    if (this.benchMesh) {
      this.scene.remove(this.benchMesh)
      this.benchMesh.geometry.dispose()
      this.benchMesh.material.dispose()
      this.benchMesh = null
    }
    if (this.faceMesh) {
      this.scene.remove(this.faceMesh)
      this.faceMesh.geometry.dispose()
      this.faceMesh.material.dispose()
      this.faceMesh = null
    }
    if (this.faceDamagedMesh) {
      this.scene.remove(this.faceDamagedMesh)
      this.faceDamagedMesh.geometry.dispose()
      this.faceDamagedMesh.material.dispose()
      this.faceDamagedMesh = null
    }
    // 清理旧标注组（掘进深度/断面尺寸/孔型标签等）
    if (this.annotationsGroup) {
      this.scene.remove(this.annotationsGroup)
      this.annotationsGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) {
          if (o.material.map) o.material.map.dispose()
          o.material.dispose()
        }
      })
      this.annotationsGroup = null
    }

    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection

    // 创建岩石纹理（程序化生成）
    if (!this.rockTexture) {
      this.rockTexture = createRockTexture()
    }

    // 隧道断面尺寸
    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight

    // 构建马蹄形断面 Shape（直墙 + 半圆拱），可选中央爆破漏斗洞口
    const buildTunnelShape = withCrater => {
      const shape = new THREE.Shape()
      shape.moveTo(-W / 2, 0)
      shape.lineTo(-W / 2, Hw)
      // 半圆拱：从左侧经顶部到右侧（顺时针扫过 π→0）
      shape.absarc(0, Hw, R, Math.PI, 0, true)
      shape.lineTo(W / 2, 0)
      shape.closePath()

      if (withCrater) {
        // 爆破漏斗：中央不规则破碎洞口
        const hole = new THREE.Path()
        const craterR = Math.min(W, totalH) * 0.32
        const hcx = 0
        const hcy = Hw * 0.5 + R * 0.2
        const pts = 14
        for (let i = 0; i < pts; i++) {
          const a = (i / pts) * Math.PI * 2
          // 确定性伪随机半径，保证洞口边缘锯齿状
          const r = craterR * (0.55 + (((i * 37) % 100) / 100) * 0.6)
          const x = hcx + Math.cos(a) * r
          const y = hcy + Math.sin(a) * r
          if (i === 0) hole.moveTo(x, y)
          else hole.lineTo(x, y)
        }
        hole.closePath()
        shape.holes.push(hole)
      }
      return shape
    }

    // 岩体材质（掌子面颜色稍深以区分）
    const benchMat = new THREE.MeshStandardMaterial({
      color: 0x8b6f47,
      map: this.rockTexture,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true
    })
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0x5a4a3a,
      map: this.rockTexture,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true,
      side: THREE.DoubleSide
    })

    // 朝向旋转：绕 Y 轴旋转，使局部 +Z（挤出方向）对齐爆破方向 dir
    // dir 在水平面内（dir.y=0），此旋转保证掌子面始终垂直于地面
    const yaw = Math.atan2(dir.x, dir.z)
    const faceOffset = 3 // 掌子面距爆心前方 3m

    // ── 岩体（马蹄形挤出，表示掌子面前方待爆岩体） ──
    const benchDepth = this.benchLength
    const benchGeo = new THREE.ExtrudeGeometry(buildTunnelShape(false), {
      depth: benchDepth,
      bevelEnabled: false
    })
    benchGeo.translate(0, 0, -benchDepth / 2) // 沿深度居中
    this.benchMesh = new THREE.Mesh(benchGeo, benchMat)
    // 岩体位于掌子面前方（+forward，未开挖岩体方向），后端贴合掌子面
    // 这样相机在掌子面后方（已开挖隧道内）不会被岩体遮挡
    this.benchMesh.position.set(
      cx + dir.x * (faceOffset + benchDepth / 2),
      cz,
      cy + dir.z * (faceOffset + benchDepth / 2)
    )
    this.benchMesh.rotation.y = yaw
    this.benchMesh.castShadow = true
    this.benchMesh.receiveShadow = true
    this.scene.add(this.benchMesh)

    // ── 隧道内壁（已开挖段，从掌子面向相机方向延伸的空心马蹄形管） ──
    // 内部视角时相机位于掌子面后方（-forward），需要看到隧道壁以营造"在隧道内"的感觉。
    // 使用 BackSide 材质：相机在管内只看到内壁，看不到外壁（实为实心 extrude，但内壁可见）。
    if (this.tunnelShellMesh) {
      this.scene.remove(this.tunnelShellMesh)
      this.tunnelShellMesh.geometry.dispose()
      this.tunnelShellMesh.material.dispose()
    }
    const shellLength = 80 // 已开挖隧道长度(m)，足够覆盖相机视野
    const shellGeo = new THREE.ExtrudeGeometry(buildTunnelShape(false), {
      depth: shellLength,
      bevelEnabled: false
    })
    // 沿 +Z extrude；translate 使其一端在 Z=0（掌子面端），另一端在 Z=-shellLength（相机后方）
    shellGeo.translate(0, 0, -shellLength)
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x3a3530,
      side: THREE.BackSide, // 仅渲染内壁（从管内观察）
      roughness: 0.95,
      metalness: 0.05
    })
    this.tunnelShellMesh = new THREE.Mesh(shellGeo, shellMat)
    // 前端贴合掌子面（faceOffset），向 -forward 延伸
    this.tunnelShellMesh.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    this.tunnelShellMesh.rotation.y = yaw
    this.tunnelShellMesh.receiveShadow = true
    this.scene.add(this.tunnelShellMesh)

    // ── 完整掌子面（薄板马蹄形，爆破前可见） ──
    const faceThickness = 2
    const faceGeo = new THREE.ExtrudeGeometry(buildTunnelShape(false), {
      depth: faceThickness,
      bevelEnabled: false
    })
    faceGeo.translate(0, 0, -faceThickness / 2)
    this.faceMesh = new THREE.Mesh(faceGeo, faceMat)
    this.faceMesh.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    this.faceMesh.rotation.y = yaw
    this.faceMesh.castShadow = true
    this.faceMesh.receiveShadow = true
    this.faceMesh.visible = true
    this.scene.add(this.faceMesh)

    // ── 损伤掌子面（带爆破漏斗洞口，爆破后可见） ──
    const damagedMat = faceMat.clone()
    damagedMat.color = new THREE.Color(0x4a3a2a) // 损伤面颜色更深
    const damagedGeo = new THREE.ExtrudeGeometry(buildTunnelShape(true), {
      depth: faceThickness,
      bevelEnabled: false
    })
    damagedGeo.translate(0, 0, -faceThickness / 2)
    this.faceDamagedMesh = new THREE.Mesh(damagedGeo, damagedMat)
    this.faceDamagedMesh.position.copy(this.faceMesh.position)
    this.faceDamagedMesh.rotation.y = yaw
    this.faceDamagedMesh.castShadow = true
    this.faceDamagedMesh.receiveShadow = true
    this.faceDamagedMesh.visible = false
    this.scene.add(this.faceDamagedMesh)

    // ── 掌子面爆破钻孔（掏槽孔/辅助孔/周边孔） ──
    this._buildBlastHoles(yaw, faceOffset)
  }

  /**
   * 在掌子面上构建爆破钻孔布孔图案（隧道掘进爆破典型布孔）。
   * 孔位在掌子面局部坐标系（X=横向，Y=高度，Z=深度）中定义，
   * 然后整体平移旋转到掌子面位置。孔为短圆柱，向岩体内部延伸（-Z 方向）。
   * - 掏槽孔：中央 4 孔 + 1 空孔，菱形布置
   * - 辅助孔：围绕掏槽的 2 圈
   * - 周边孔：沿马蹄形轮廓布置
   */
  _buildBlastHoles(yaw, faceOffset) {
    if (this.blastHolesGroup) {
      this.scene.remove(this.blastHolesGroup)
      this.blastHolesGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      })
      this.blastHolesGroup = null
    }

    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight

    // 钻孔几何（短圆柱，默认沿 Y 轴，需旋转使其沿 -Z 方向延伸入岩体）
    const holeRadius = 0.18 // 孔径（视觉放大）
    const holeDepth = 2.5 // 孔深（视觉，从掌子面向岩体内延伸）
    const holeGeo = new THREE.CylinderGeometry(holeRadius, holeRadius, holeDepth, 10)
    // 旋转：Y 轴 → Z 轴（圆柱轴向沿 Z），便于向 -Z 延伸
    holeGeo.rotateX(Math.PI / 2)
    // 掏槽空孔稍大，用区分色
    const emptyHoleGeo = new THREE.CylinderGeometry(holeRadius * 1.6, holeRadius * 1.6, holeDepth, 12)
    emptyHoleGeo.rotateX(Math.PI / 2)

    const holeMat = new THREE.MeshStandardMaterial({
      color: 0x1a1208,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true
    })
    const emptyHoleMat = new THREE.MeshStandardMaterial({
      color: 0x2a2010,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true
    })

    // 收集孔位（局部 X=横向，Y=高度，孔向 -Z 延伸）
    const holes = [] // {x, y, isEmpty}
    const cy0 = totalH * 0.5 // 掌子面中心高度

    // 1) 掏槽孔：中央菱形 4 孔 + 1 空孔
    const cutR = 1.0
    holes.push({ x: 0, y: cy0, isEmpty: true })
    holes.push({ x: cutR, y: cy0, isEmpty: false })
    holes.push({ x: -cutR, y: cy0, isEmpty: false })
    holes.push({ x: 0, y: cy0 + cutR, isEmpty: false })
    holes.push({ x: 0, y: cy0 - cutR, isEmpty: false })

    // 2) 辅助孔：2 圈，四眼掏槽外扩
    const helperRings = [
      { r: 2.6, n: 8 },
      { r: 4.2, n: 12 }
    ]
    helperRings.forEach(({ r, n }) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.cos(a) * r
        const y = cy0 + Math.sin(a) * r
        // 剔除超出断面的孔
        if (this._isInsideTunnelSection(x, y, W, Hw, R)) {
          holes.push({ x, y, isEmpty: false })
        }
      }
    })

    // 3) 周边孔：沿马蹄形轮廓
    const perimSpacing = 1.2
    // 左右直墙
    for (let y = 1.0; y <= Hw - 0.3; y += perimSpacing) {
      holes.push({ x: -W / 2 + 0.35, y, isEmpty: false })
      holes.push({ x: W / 2 - 0.35, y, isEmpty: false })
    }
    // 拱部半圆
    const archN = Math.max(8, Math.floor((Math.PI * R) / perimSpacing))
    for (let i = 1; i < archN; i++) {
      const a = Math.PI - (i / archN) * Math.PI
      const x = Math.cos(a) * R
      const y = Hw + Math.sin(a) * R
      holes.push({ x, y, isEmpty: false })
    }
    // 底板两角
    holes.push({ x: -W / 2 + 0.4, y: 0.5, isEmpty: false })
    holes.push({ x: W / 2 - 0.4, y: 0.5, isEmpty: false })

    // 构建孔网格组，定位到掌子面前表面（Z = +faceThickness/2），向 -Z 延伸
    const group = new THREE.Group()
    const faceThickness = 2
    const frontZ = faceThickness / 2 + 0.02 // 略凸出掌子面前表面
    holes.forEach(({ x, y, isEmpty }) => {
      const mesh = new THREE.Mesh(isEmpty ? emptyHoleGeo : holeGeo, isEmpty ? emptyHoleMat : holeMat)
      // 圆柱中心位于 frontZ - holeDepth/2，使前端贴齐掌子面、向岩体内延伸
      mesh.position.set(x, y, frontZ - holeDepth / 2)
      group.add(mesh)
    })

    // 整体定位到掌子面位置（与 faceMesh 一致：center + forward*faceOffset，绕 Y 旋转 yaw）
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = true
    this.scene.add(group)
    this.blastHolesGroup = group

    // 保存炮孔布置数据（供 UI 绘制 2D 布置图与统计）
    // 分类：cut=掏槽孔(含空孔), auxiliary=辅助孔, perimeter=周边孔
    const cutHoles = holes.filter(h => Math.hypot(h.x, h.y - cy0) <= cutR + 0.01)
    const cutSet = new Set(cutHoles)
    const perimHoles = holes.filter(h => {
      // 周边孔：贴边轮廓（直墙边缘 + 拱部）
      const onWall = Math.abs(Math.abs(h.x) - (W / 2 - 0.35)) < 0.1 && h.y <= Hw
      const onArch =
        h.y > Hw && Math.hypot(h.x, h.y - Hw) > R - 0.6
      return onWall || onArch
    })
    const perimSet = new Set(perimHoles)
    this.blastHolePattern = {
      section: { W, Hw, R, totalH: totalH },
      holes: holes.map(h => ({
        x: h.x,
        y: h.y,
        isEmpty: h.isEmpty,
        type: cutSet.has(h)
          ? 'cut'
          : perimSet.has(h)
            ? 'perimeter'
            : 'auxiliary'
      })),
      counts: {
        cut: cutHoles.length,
        auxiliary: holes.length - cutHoles.length - perimHoles.length,
        perimeter: perimHoles.length,
        total: holes.length,
        empty: cutHoles.filter(h => h.isEmpty).length
      }
    }

    // 构建专业标注（掘进深度、断面尺寸、孔型分区标签）
    this._buildAnnotations(yaw, faceOffset)
  }

  /**
   * 构建专业爆破元素 3D 标注（掘进深度、断面尺寸、孔型分区标签）
   * 使用 Canvas 纹理 Sprite，始终面向相机，便于阅读。
   */
  _buildAnnotations(yaw, faceOffset) {
    const group = new THREE.Group()
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight

    // 掘进深度标注（掌子面右上方，显示当前循环掘进进尺）
    // 进尺 = 单循环爆破深度，取装药孔深 ~2.5m × 0.85（利用率）
    const advanceDepth = 2.5 * 0.85
    const depthLabel = this._createTextSprite(
      `掘进进尺: ${advanceDepth.toFixed(2)} m`,
      '#ffd166',
      32
    )
    // 位置：掌子面右上方，向 right 偏移、向上偏移
    depthLabel.position.set(W * 0.5 + 1.5, totalH - 1, 0.1)
    group.add(depthLabel)

    // 断面尺寸标注（掌子面左上方）
    const sectionArea = W * Hw + (Math.PI * R * R) / 2 // 直墙矩形 + 半圆拱面积
    const sizeLabel = this._createTextSprite(
      `断面: ${W}m × ${totalH.toFixed(1)}m  (A=${sectionArea.toFixed(1)}m²)`,
      '#4fc3f7',
      28
    )
    sizeLabel.position.set(-W * 0.5 - 1.5, totalH - 1, 0.1)
    group.add(sizeLabel)

    // 孔型分区标签（掏槽/辅助/周边）
    const cy0 = totalH * 0.5
    const cutLabel = this._createTextSprite('掏槽孔', '#ff6b6b', 22)
    cutLabel.position.set(0, cy0 + 2.2, 0.1)
    group.add(cutLabel)

    const auxLabel = this._createTextSprite('辅助孔', '#feca57', 20)
    auxLabel.position.set(3.5, cy0 + 1, 0.1)
    group.add(auxLabel)

    const perimLabel = this._createTextSprite('周边孔', '#1dd1a1', 20)
    perimLabel.position.set(W * 0.5 - 1, Hw + 0.5, 0.1)
    group.add(perimLabel)

    // 掌子面位置标注（底部）
    const faceLabel = this._createTextSprite('掌子面 (开挖面)', '#ffffff', 22)
    faceLabel.position.set(0, -1.5, 0.1)
    group.add(faceLabel)

    // 整体定位到掌子面前表面
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = this.layerVisibility.annotations !== false
    this.scene.add(group)
    this.annotationsGroup = group
  }

  /**
   * 创建文字 Sprite（Canvas 纹理，始终面向相机）
   * @param {string} text - 文字内容
   * @param {string} color - 文字颜色（CSS）
   * @param {number} fontSize - 字号
   * @returns {THREE.Sprite}
   */
  _createTextSprite(text, color = '#ffffff', fontSize = 24) {
    const padding = 8
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
    const metrics = ctx.measureText(text)
    canvas.width = Math.ceil(metrics.width) + padding * 2
    canvas.height = fontSize + padding * 2
    // 重新设置 font（canvas resize 会重置上下文状态）
    ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
    // 半透明背景
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // 边框
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2)
    // 文字
    ctx.fillStyle = color
    ctx.textBaseline = 'middle'
    ctx.fillText(text, padding, canvas.height / 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.needsUpdate = true
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // 标注不被掌子面遮挡
      depthWrite: false
    })
    const sprite = new THREE.Sprite(material)
    // 缩放：让文字在 3D 场景中可读（按 canvas 宽高比）
    const scale = 0.04
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1)
    return sprite
  }

  /**
   * 判断点 (x, y) 是否在马蹄形断面内（直墙 + 半圆拱）
   * x∈[-W/2, W/2]，y 从底板起算
   */
  _isInsideTunnelSection(x, y, W, Hw, R) {
    if (Math.abs(x) > W / 2 - 0.2) return false
    if (y < 0.2) return false
    if (y <= Hw) return true
    const dx = x
    const dy = y - Hw
    return dx * dx + dy * dy <= (R - 0.2) * (R - 0.2)
  }

  /**
   * 构建 3D 岩石碎片的实例化网格
   * 用 InstancedMesh 替代 Points，实现真实 3D 岩石外观
   * 使用多种几何变体 + 稳定颜色，避免闪烁和千篇一律
   */
  _buildFragmentMesh(fragments) {
    // 清理旧网格（geometry/material 为共享资源，不在这里 dispose）
    this.fragmentMeshes.forEach(mesh => {
      this.scene.remove(mesh)
    })
    this.fragmentMeshes = []

    if (fragments.length === 0) return

    // 使用 MeshStandardMaterial 获得更真实的光照效果
    if (!this.rockMaterial) {
      this.rockMaterial = new THREE.MeshStandardMaterial({
        roughness: 0.9,
        metalness: 0.0,
        flatShading: true // 平面着色，突出岩石棱角
      })
    }

    // 按几何变体分组，每种变体创建一个 InstancedMesh
    const variantCount = this.rockGeometries.length
    const groups = Array.from({ length: variantCount }, () => [])
    fragments.forEach((p, i) => {
      const variant = i % variantCount
      groups[variant].push({ p, index: i })
    })

    groups.forEach((group, variant) => {
      if (group.length === 0) return
      const geometry = this.rockGeometries[variant]
      const mesh = new THREE.InstancedMesh(geometry, this.rockMaterial, group.length)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = true
      mesh.receiveShadow = true
      // 关闭视锥裁剪：InstancedMesh 默认 boundingSphere 基于几何体（不含实例位置），
      // 会导致飞出的碎片被错误裁剪而不可见
      mesh.frustumCulled = false

      const dummy = new THREE.Object3D()
      group.forEach(({ p }, localIdx) => {
        dummy.position.copy(p.position)
        dummy.quaternion.copy(p.quaternion)
        dummy.scale.setScalar(p.size)
        dummy.updateMatrix()
        mesh.setMatrixAt(localIdx, dummy.matrix)
        mesh.setColorAt(localIdx, p.color)
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.userData.group = group // {p, index}[]

      this.scene.add(mesh)
      this.fragmentMeshes.push(mesh)
    })
  }

  /**
   * 更新实例化碎片网格的变换矩阵
   * 已落地碎片保持可见，形成固定碎石堆
   */
  _updateFragmentMesh() {
    if (this.fragmentMeshes.length === 0) return
    const dummy = new THREE.Object3D()

    for (const mesh of this.fragmentMeshes) {
      const group = mesh.userData.group
      let visibleCount = 0

      for (let localIdx = 0; localIdx < group.length; localIdx++) {
        const { p } = group[localIdx]
        // 碎片不会自然死亡（life=999），落地后仍保留为固定碎石
        if (!p.alive) {
          dummy.position.set(0, -9999, 0)
          dummy.scale.setScalar(0)
          dummy.updateMatrix()
          mesh.setMatrixAt(localIdx, dummy.matrix)
          continue
        }
        dummy.position.copy(p.position)
        dummy.quaternion.copy(p.quaternion)
        dummy.scale.setScalar(p.size)
        dummy.updateMatrix()
        mesh.setMatrixAt(localIdx, dummy.matrix)
        visibleCount++
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.count = group.length
      mesh.visible = visibleCount > 0
    }
  }

  /**
   * 设置爆心位置（three.js 局部坐标，单位：米）
   */
  setCenter(x, y, z) {
    this.center.set(x, y, z)
    // 火光位于掌子面处（爆心 + faceDirection*3）
    this.fireLight.position.copy(this.center).addScaledVector(this.faceDirection, 3)
  }

  setChargeKg(kg) {
    this.chargeKg = Math.max(1, kg)
  }

  /**
   * 初始化爆破粒子系统
   * @param {Object} params
   * @param {number} params.chargeKg - 装药量(kg)
   * @param {number} params.fragmentCount - 碎片数量
   */
  initBlast(params = {}) {
    this.clear()
    this._lastBlastParams = { ...params }
    this.simTime = 0
    const chargeKg = params.chargeKg || this.chargeKg
    this.setChargeKg(chargeKg)

    // 设置爆破方向（如果提供了掌子面方向）
    if (params.faceDirection) {
      this.setFaceDirection(params.faceDirection.x, params.faceDirection.y, params.faceDirection.z)
    }

    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection

    // 构建爆破方向的局部坐标系（隧道轴向 = forward，爆破沿此方向推进）
    // 烟雾/粉尘在隧道内部应沿 forward 扩散，而非向上（顶板阻挡）
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    // 构建掌子面/台阶几何体
    this._buildBenchGeometry()

    // 同步隧道内部补光到掌子面后方（已开挖侧，相机所在区域）
    // 位置：center - forward*15（后退 15m），高度为隧道半高，照亮掌子面与隧道壁
    if (this.tunnelLight) {
      this.tunnelLight.position.set(
        cx - dir.x * 15,
        cz + this.tunnelHeight * 0.5,
        cy - dir.z * 15
      )
    }

    // ── 1. 火球粒子（在掌子面处起爆，减少数量和尺寸避免遮挡 3D 碎片） ──
    const fireCount = Math.min(80, Math.max(20, Math.floor(chargeKg / 5)))
    // 火球中心 = 掌子面位置（center + forward*3），爆炸发生在掌子面岩体处
    const faceCenter = new THREE.Vector3().copy(this.center).addScaledVector(forward, 3)
    for (let i = 0; i < fireCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI * 0.6
      const speed = 10 + Math.random() * 25
      // 火球向掌子面前方（+forward，破碎腔方向）扩散，伴随断面内随机散布
      const vel = new THREE.Vector3()
        .addScaledVector(forward, Math.cos(phi) * speed + 5)
        .addScaledVector(right, Math.cos(theta) * Math.sin(phi) * speed)
        .addScaledVector(up, Math.sin(theta) * Math.sin(phi) * speed)
      const pos = new THREE.Vector3(
        faceCenter.x + (Math.random() - 0.5) * 4,
        faceCenter.y + Math.random() * 4,
        faceCenter.z + (Math.random() - 0.5) * 4
      )
      const color = new THREE.Color().setHSL(
        0.05 + Math.random() * 0.05,
        1,
        0.5 + Math.random() * 0.3
      )
      this.particles.push(
        new BlastParticle(THREE_PARTICLE_TYPES.FIRE, pos, vel, {
          life: 1.0 + Math.random() * 1.0,
          size: 5 + Math.random() * 8,
          color,
          gravity: -3,
          drag: 0.05,
          expand: 2
        })
      )
    }

    // ── 2. 烟雾粒子（隧道内部掘进爆破：沿隧道轴向扩散，非向上） ──
    // 隧道顶板阻挡向上运动，烟雾主要沿 forward（掘进方向）向掌子面前方涌出，
    // 并在断面内横向扩散，伴随轴向湍流。
    const smokeCount = Math.min(300, Math.max(80, Math.floor(chargeKg / 2)))
    for (let i = 0; i < smokeCount; i++) {
      // 轴向速度：主方向沿 forward，速度较高（涌出掌子面）
      const axialSpeed = 8 + Math.random() * 18
      // 断面内横向扩散（right 方向）+ 有限的垂直扰动（顶板/底板约束）
      const lateralSpeed = (Math.random() - 0.5) * 8
      const verticalSpeed = (Math.random() - 0.5) * 4 // 双向，非单向上升
      const vel = new THREE.Vector3()
        .addScaledVector(forward, axialSpeed)
        .addScaledVector(right, lateralSpeed)
        .addScaledVector(up, verticalSpeed)

      // 初始位置：掌子面前方附近，散布在断面内（避免聚团）
      const lateralPos = (Math.random() - 0.5) * this.tunnelWidth * 0.8
      const heightPos = Math.random() * this.tunnelHeight
      const pos = new THREE.Vector3()
        .copy(this.center)
        .addScaledVector(forward, 3 + Math.random() * 2) // 掌子面及其前方
        .addScaledVector(right, lateralPos)
      pos.y = cy + heightPos

      const gray = 0.15 + Math.random() * 0.25
      const color = new THREE.Color(gray, gray, gray)
      this.particles.push(
        new BlastParticle(THREE_PARTICLE_TYPES.SMOKE, pos, vel, {
          life: 8 + Math.random() * 6,
          size: 6 + Math.random() * 12, // 缩小尺寸，与隧道比例协调
          color,
          gravity: 0, // 无重力沉降（悬浮于隧道内）
          drag: 0.04,
          rise: 0, // 去除上升力（顶板阻挡）
          turbulence: 6, // 断面内湍流扩散
          expand: 3
        })
      )
    }

    // ── 3. 火花粒子 ──
    const sparkCount = Math.min(150, Math.max(40, Math.floor(chargeKg / 5)))
    for (let i = 0; i < sparkCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI
      const speed = 50 + Math.random() * 100
      // 火花从掌子面处向破碎腔方向（+forward）高速飞溅
      const vel = new THREE.Vector3()
        .addScaledVector(forward, Math.cos(phi) * speed)
        .addScaledVector(right, Math.cos(theta) * Math.sin(phi) * speed)
        .addScaledVector(up, Math.sin(theta) * Math.sin(phi) * speed)
      const pos = new THREE.Vector3(
        faceCenter.x + (Math.random() - 0.5) * 2,
        faceCenter.y + (Math.random() - 0.5) * 2,
        faceCenter.z + (Math.random() - 0.5) * 2
      )
      const color = new THREE.Color(1, 0.85, 0.3)
      this.particles.push(
        new BlastParticle(THREE_PARTICLE_TYPES.SPARK, pos, vel, {
          life: 2 + Math.random() * 2,
          size: 2 + Math.random() * 3,
          color,
          gravity: 9.8,
          drag: 0.01
        })
      )
    }

    // ── 4. 岩石碎片（方向性爆破 + Rosin-Rammler 尺寸分布 + 真实弹道学） ──
    const fragmentCount = Math.min(400, Math.max(80, params.fragmentCount || Math.floor(chargeKg)))
    // Rosin-Rammler 参数（真实爆破工程值）：
    // d63 = 特征尺寸，与装药量正相关；n = 均匀性指数（1.0~1.8）
    const d63 = 0.3 + Math.sqrt(chargeKg) * 0.04 // 真实特征尺寸(m)，320kg → ~1.0m
    const n = 1.0 + Math.random() * 0.4

    // 显示缩放因子：降低以避免碎片视觉重叠成团，与放大后的隧道比例协调
    const FRAGMENT_DISPLAY_SCALE = 1.4

    for (let i = 0; i < fragmentCount; i++) {
      // 真实碎块尺寸（Rosin-Rammler 采样，限制在 0.15~3.0m）
      const physicsSize = Math.max(0.15, Math.min(3.0, sampleRosinRammlerSize(d63, n, Math.random)))
      const displaySize = physicsSize * FRAGMENT_DISPLAY_SCALE

      // 发射角分布（真实爆破：30~65°，峰值约 45°）
      // 大碎片角度偏低（贴近地面飞），小碎片角度偏高（抛物线明显）
      const angleBias = (3.0 - physicsSize) * 0.08
      const launchAngle = (Math.PI * 0.25 + angleBias) + (Math.random() - 0.5) * Math.PI * 0.25

      // 方位角（锥形扩散，扩大以增强横向散开，避免聚团）
      const azimuth = (Math.random() - 0.5) * Math.PI * 0.9 // ±81°，大角度横向抛掷

      // 初始速度（真实爆破：冲击波对所有尺寸碎片施加相近速度）
      // 基础速度与装药量正相关：v ∝ √(Q/M)
      // 提高基数保证初期就快速向外散开，避免视觉聚团
      const vBase = 45 + Math.sqrt(chargeKg) * 3.0
      // 速度变化 ±45%（爆腔不均匀性 + 方向性反射增强散布）
      const vVariation = 0.6 + Math.random() * 0.9
      const speed = vBase * vVariation

      // 构建速度向量：主方向沿掌子面法线（forward），锥角散布
      // 所有碎片向掌子面前方飞出，不向后飞（避免飞入台阶内部）
      const vel = new THREE.Vector3()
        .addScaledVector(forward, Math.cos(launchAngle) * Math.cos(azimuth) * speed)
        .addScaledVector(up, Math.sin(launchAngle) * speed)
        .addScaledVector(right, Math.cos(launchAngle) * Math.sin(azimuth) * speed)

      // 初始位置：从掌子面表面（马蹄形垂直平面）随机点飞出
      // 掌子面位于 center + forward*3，碎片分散在整个断面，天然避免聚团
      // 拒绝采样：剔除马蹄形拱顶外侧的点，保证碎片源自掌子面实际区域
      let lateralPos = 0
      let heightPos = 0
      for (let s = 0; s < 8; s++) {
        lateralPos = (Math.random() - 0.5) * this.tunnelWidth
        heightPos = Math.random() * this.tunnelHeight
        // 直墙区（y <= 直墙高）全部有效；拱顶区需在半圆内
        if (heightPos <= this.tunnelWallHeight) break
        const dx = lateralPos
        const dy = heightPos - this.tunnelWallHeight
        if (dx * dx + dy * dy <= this.tunnelArchRadius * this.tunnelArchRadius) break
      }
      const pos = new THREE.Vector3()
        .copy(this.center)
        .addScaledVector(forward, 3) // 掌子面位置
        .addScaledVector(right, lateralPos)
      pos.y = cy + heightPos

      // 岩石颜色（棕灰色系，随尺寸变化：大块偏深）
      const brown = 0.35 + Math.random() * 0.25 - physicsSize * 0.03
      const color = new THREE.Color(
        Math.max(0.15, brown),
        Math.max(0.12, brown * 0.72),
        Math.max(0.08, brown * 0.45)
      )

      // 阻力系数：所有碎片共享基础值，实际弹道系数 = drag / physicsSize
      const onLand = (landPos, impactSpeed, fragSz) => {
        this._spawnImpactDebris(landPos, impactSpeed, fragSz)
      }
      this.particles.push(
        new BlastParticle(THREE_PARTICLE_TYPES.FRAGMENT, pos, vel, {
          life: 999,
          size: displaySize,
          physicsSize,
          color,
          gravity: 9.8,
          drag: 0.18, // 降低基础阻力，保证初期快速散开
          restitution: 0.38,
          friction: 0.5,
          maxBounces: 4,
          onLand
        })
      )
    }

    // ── 5. 冲击波（从掌子面处向外膨胀） ──
    const shockCount = 3
    for (let i = 0; i < shockCount; i++) {
      const pos = new THREE.Vector3(faceCenter.x, faceCenter.y, faceCenter.z)
      const color = new THREE.Color(1, 0.8, 0.2)
      this.particles.push(
        new BlastParticle(THREE_PARTICLE_TYPES.SHOCK_WAVE, pos, new THREE.Vector3(0, 0, 0), {
          life: 2.5,
          size: 5 + i * 5,
          color,
          gravity: 0,
          drag: 0,
          expand: 100 + i * 30
        })
      )
    }

    // ── 6. 粉尘（隧道内沿轴向扩散，非上升） ──
    const dustCount = Math.min(200, Math.max(50, Math.floor(chargeKg / 3)))
    for (let i = 0; i < dustCount; i++) {
      const axialSpeed = 4 + Math.random() * 14
      const lateralSpeed = (Math.random() - 0.5) * 6
      const verticalSpeed = (Math.random() - 0.5) * 3
      const vel = new THREE.Vector3()
        .addScaledVector(forward, axialSpeed)
        .addScaledVector(right, lateralSpeed)
        .addScaledVector(up, verticalSpeed)
      const lateralPos = (Math.random() - 0.5) * this.tunnelWidth * 0.8
      const heightPos = Math.random() * this.tunnelHeight
      const pos = new THREE.Vector3()
        .copy(this.center)
        .addScaledVector(forward, 3 + Math.random() * 3)
        .addScaledVector(right, lateralPos)
      pos.y = cy + heightPos
      const gray = 0.5 + Math.random() * 0.2
      const color = new THREE.Color(gray, gray * 0.95, gray * 0.9)
      this.particles.push(
        new BlastParticle(THREE_PARTICLE_TYPES.DUST, pos, vel, {
          life: 6 + Math.random() * 4,
          size: 3 + Math.random() * 7,
          color,
          gravity: 0,
          drag: 0.05,
          rise: 0,
          turbulence: 3,
          expand: 3
        })
      )
    }

    // 预分配撞击飞溅粒子池（落地时激活，避免动态重建缓冲区）
    this._buildImpactPools()

    // 构建粒子系统（Points 用于火焰/烟雾/火花等，InstancedMesh 用于碎片）
    this._buildParticleSystems()

    // 单独构建 3D 岩石碎片实例化网格
    const fragmentParticles = this.particles.filter(p => p.type === THREE_PARTICLE_TYPES.FRAGMENT)
    this._buildFragmentMesh(fragmentParticles)

    console.log('[ThreeBlastingRenderer] initBlast 完成', {
      totalParticles: this.particles.length,
      fragments: fragmentParticles.length,
      hasFragmentMesh: !!this.fragmentMesh,
      hasBenchMesh: !!this.benchMesh,
      hasFaceMesh: !!this.faceMesh,
      benchSize: `${this.benchLength}x${this.benchHeight}x${this.benchWidth}m`,
      faceDirection: this.faceDirection.toArray()
    })

    // ── 掌子面损伤演化：爆破前掌子面完整，所有爆破粒子隐藏等待触发 ──
    this.blastTriggered = false
    if (this.faceMesh) this.faceMesh.visible = this.layerVisibility.face !== false
    if (this.faceDamagedMesh) this.faceDamagedMesh.visible = false
    if (this.blastHolesGroup) {
      this.blastHolesGroup.visible = this.layerVisibility.blastHoles !== false
    }
    if (this.benchMesh) this.benchMesh.visible = this.layerVisibility.bench !== false
    if (this.tunnelShellMesh) {
      this.tunnelShellMesh.visible = this.layerVisibility.tunnel !== false
    }
    if (this.annotationsGroup) {
      this.annotationsGroup.visible = this.layerVisibility.annotations !== false
    }
    for (const p of this.particles) {
      p.alive = false
    }
    // 立即初始化碎片实例矩阵为隐藏状态，避免首次渲染时在原点闪烁可见
    this._updateFragmentMesh()

    this.active = true
  }

  /**
   * 预分配撞击飞溅粒子池（扬尘 + 火花 + 二次小碎片），初始全部死亡。
   * 碎片落地时通过 _spawnImpactDebris 激活，避免动态扩展缓冲区。
   */
  _buildImpactPools() {
    this.impactDustPool = []
    this.impactSparkPool = []
    this.impactChipPool = []
    const poolPos = new THREE.Vector3(0, -9999, 0)

    // 扬尘池（400 个）：撞击扬起的灰尘云
    for (let i = 0; i < 400; i++) {
      const gray = 0.5 + Math.random() * 0.2
      const color = new THREE.Color(gray, gray * 0.95, gray * 0.9)
      const p = new BlastParticle(THREE_PARTICLE_TYPES.DUST, poolPos, new THREE.Vector3(), {
        life: 0.01,
        size: 8 + Math.random() * 16,
        color,
        gravity: -0.5,
        drag: 0.05,
        rise: 1,
        turbulence: 2,
        expand: 3
      })
      p.alive = false
      p.isPool = true
      this.particles.push(p)
      this.impactDustPool.push(p)
    }

    // 火花池（200 个）：高速撞击产生的火花
    for (let i = 0; i < 200; i++) {
      const color = new THREE.Color(1, 0.85, 0.3)
      const p = new BlastParticle(THREE_PARTICLE_TYPES.SPARK, poolPos, new THREE.Vector3(), {
        life: 0.01,
        size: 3 + Math.random() * 4,
        color,
        gravity: 9.8,
        drag: 0.01
      })
      p.alive = false
      p.isPool = true
      this.particles.push(p)
      this.impactSparkPool.push(p)
    }

    // 二次小碎片池（150 个）：撞击溅起的小石屑
    for (let i = 0; i < 150; i++) {
      const brown = 0.3 + Math.random() * 0.3
      const color = new THREE.Color(brown, brown * 0.7, brown * 0.4)
      const p = new BlastParticle(THREE_PARTICLE_TYPES.FRAGMENT, poolPos, new THREE.Vector3(), {
        life: 0.01,
        size: 1.5 + Math.random() * 2.5,
        physicsSize: 0.3,
        color,
        gravity: 9.8,
        drag: 0.3,
        restitution: 0.3,
        friction: 0.5,
        maxBounces: 2
      })
      p.alive = false
      p.isPool = true
      this.particles.push(p)
      this.impactChipPool.push(p)
    }
  }

  /**
   * 碎片落地时生成飞溅粒子（扬尘 + 火花 + 二次小碎片）。
   * 从预分配池中激活，避免动态扩展缓冲区。
   */
  _spawnImpactDebris(landPos, impactSpeed, fragSize) {
    if (impactSpeed < 3) return // 低速落地不产生飞溅

    // ── 扬尘飞溅 ──
    // 数量与撞击速度成正比，最小 4 个保证可见
    const dustCount = Math.min(20, 4 + Math.floor(impactSpeed / 3))
    for (let i = 0; i < dustCount; i++) {
      const p = this.impactDustPool.find(dp => !dp.alive)
      if (!p) break
      const theta = Math.random() * Math.PI * 2
      const speed = 5 + Math.random() * 15
      p.position.copy(landPos)
      p.position.y = 0.5 + Math.random() * 2
      p.velocity.set(
        Math.cos(theta) * speed,
        3 + Math.random() * 10,
        Math.sin(theta) * speed
      )
      p.life = 4 + Math.random() * 3
      p.maxLife = p.life
      p.size = 10 + Math.random() * 20
      p.alive = true
      p.landed = false
      p.bounceCount = 0
    }

    // ── 火花飞溅（中高速撞击）──
    if (impactSpeed > 12) {
      const sparkCount = Math.min(15, Math.floor((impactSpeed - 12) / 3))
      for (let i = 0; i < sparkCount; i++) {
        const p = this.impactSparkPool.find(sp => !sp.alive)
        if (!p) break
        const theta = Math.random() * Math.PI * 2
        const phi = Math.random() * Math.PI * 0.5
        const speed = 20 + Math.random() * 35
        p.position.copy(landPos)
        p.position.y = 0.5
        p.velocity.set(
          Math.cos(theta) * Math.sin(phi) * speed,
          Math.cos(phi) * speed + 8,
          Math.sin(theta) * Math.sin(phi) * speed
        )
        p.life = 1.0 + Math.random() * 1.2
        p.maxLife = p.life
        p.size = 3 + Math.random() * 4
        p.alive = true
        p.landed = false
        p.bounceCount = 0
      }
    }

    // ── 二次小碎片飞溅（高速撞击溅起石屑）──
    if (impactSpeed > 8) {
      const chipCount = Math.min(12, Math.floor((impactSpeed - 8) / 4))
      for (let i = 0; i < chipCount; i++) {
        const p = this.impactChipPool.find(cp => !cp.alive)
        if (!p) break
        const theta = Math.random() * Math.PI * 2
        const phi = Math.random() * Math.PI * 0.4
        const speed = 10 + Math.random() * 25
        p.position.copy(landPos)
        p.position.y = 0.5
        p.velocity.set(
          Math.cos(theta) * Math.sin(phi) * speed,
          Math.cos(phi) * speed + 5,
          Math.sin(theta) * Math.sin(phi) * speed
        )
        p.life = 1.5 + Math.random() * 1.5
        p.maxLife = p.life
        p.size = 1.5 + Math.random() * 2.5
        p.alive = true
        p.landed = false
        p.bounceCount = 0
      }
    }
  }

  _buildParticleSystems() {
    // 按类型分组
    const groups = {}
    for (const p of this.particles) {
      if (!groups[p.type]) groups[p.type] = []
      groups[p.type].push(p)
    }

    // 清理旧的
    for (const key of Object.keys(this.particleGroups)) {
      if (this.particleGroups[key]) {
        this.scene.remove(this.particleGroups[key])
        this.particleGroups[key].geometry?.dispose()
        this.particleGroups[key].material?.dispose()
        this.particleGroups[key] = null
      }
    }

    // 为每种类型创建 Points（碎片除外，碎片用 InstancedMesh）
    for (const [type, particles] of Object.entries(groups)) {
      // 跳过碎片类型，它们由 _buildFragmentMesh 单独处理
      if (type === THREE_PARTICLE_TYPES.FRAGMENT) continue

      const geometry = new THREE.BufferGeometry()
      const positions = new Float32Array(particles.length * 3)
      const colors = new Float32Array(particles.length * 3)
      const sizes = new Float32Array(particles.length)
      const opacities = new Float32Array(particles.length)
      const angles = new Float32Array(particles.length)

      particles.forEach((p, i) => {
        positions[i * 3] = p.position.x
        positions[i * 3 + 1] = p.position.y
        positions[i * 3 + 2] = p.position.z
        colors[i * 3] = p.color.r
        colors[i * 3 + 1] = p.color.g
        colors[i * 3 + 2] = p.color.b
        sizes[i] = p.size
        opacities[i] = 1.0
        angles[i] = p.rotation
      })

      // 注意：使用 aColor/aSize/aOpacity/aAngle 避免与 Three.js 内置属性名冲突
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
      geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
      geometry.setAttribute('aOpacity', new THREE.BufferAttribute(opacities, 1))
      geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1))

      const texture = this._getTexture(type)
      const blending =
        type === THREE_PARTICLE_TYPES.FIRE ||
          type === THREE_PARTICLE_TYPES.SPARK ||
          type === THREE_PARTICLE_TYPES.SHOCK_WAVE
          ? THREE.AdditiveBlending
          : THREE.NormalBlending

      // 改进的着色器：pointMultiplier 透视缩放 + 软圆形 discard + 旋转 UV
      const material = new THREE.ShaderMaterial({
        uniforms: {
          pointTexture: { value: texture },
          uPixelRatio: { value: this.renderer.getPixelRatio() },
          uPointMultiplier: {
            value: window.innerHeight / (2.0 * Math.tan((0.5 * 60 * Math.PI) / 180.0))
          }
        },
        vertexShader: `
          attribute float aSize;
          attribute float aOpacity;
          attribute vec3 aColor;
          attribute float aAngle;
          varying vec3 vColor;
          varying float vOpacity;
          varying vec2 vAngle;
          uniform float uPixelRatio;
          uniform float uPointMultiplier;
          void main() {
            vColor = aColor;
            vOpacity = aOpacity;
            vAngle = vec2(cos(aAngle), sin(aAngle));
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * uPixelRatio * uPointMultiplier / max(0.1, -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: `
          uniform sampler2D pointTexture;
          varying vec3 vColor;
          varying float vOpacity;
          varying vec2 vAngle;
          void main() {
            // 旋转 UV（用于碎片等需要方向感的粒子）
            vec2 coords = (gl_PointCoord - 0.5) * mat2(vAngle.x, vAngle.y, -vAngle.y, vAngle.x) + 0.5;
            vec4 texColor = texture2D(pointTexture, coords);
            // 软圆形裁剪
            float d = distance(gl_PointCoord, vec2(0.5));
            if (d > 0.5) discard;
            float softAlpha = 1.0 - smoothstep(0.4, 0.5, d);
            gl_FragColor = vec4(vColor, vOpacity * softAlpha) * texColor;
            if (gl_FragColor.a < 0.01) discard;
          }
        `,
        blending,
        depthWrite: false,
        transparent: true
      })

      const points = new THREE.Points(geometry, material)
      points.userData.particles = particles
      points.userData.angles = angles
      // 应用当前图层可见性（UI 切换可能在粒子创建前发生）
      if (this.layerVisibility && type in this.layerVisibility) {
        points.visible = this.layerVisibility[type]
      }
      this.scene.add(points)
      this.particleGroups[type] = points
    }
  }

  _getTexture(type) {
    switch (type) {
      case THREE_PARTICLE_TYPES.FIRE:
      case THREE_PARTICLE_TYPES.SHOCK_WAVE:
        return this.textures.fire
      case THREE_PARTICLE_TYPES.SMOKE:
      case THREE_PARTICLE_TYPES.DUST:
        return this.textures.smoke
      case THREE_PARTICLE_TYPES.SPARK:
        return this.textures.spark
      case THREE_PARTICLE_TYPES.FRAGMENT:
        return this.textures.fragment
      default:
        return this.textures.fire
    }
  }

  /**
   * 更新粒子系统
   * @param {number} dt - 时间步长（秒）
   */
  update(dt) {
    if (!this.active) return
    if (dt <= 0) return

    this.simTime += dt

    // ── 掌子面损伤演化：到达起爆时刻时，掌子面破碎、碎片激活飞出 ──
    if (!this.blastTriggered && this.simTime >= this.blastTriggerTime) {
      this._triggerBlast()
    }

    // 更新所有粒子
    for (const p of this.particles) {
      p.update(dt)
    }

    // 更新 Points 几何体
    for (const [, points] of Object.entries(this.particleGroups)) {
      if (!points) continue
      const particles = points.userData.particles
      const angles = points.userData.angles
      const positionAttr = points.geometry.attributes.position
      const sizeAttr = points.geometry.attributes.aSize
      const opacityAttr = points.geometry.attributes.aOpacity
      const colorAttr = points.geometry.attributes.aColor
      const angleAttr = points.geometry.attributes.aAngle

      let hasAlive = false
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        if (p.alive) {
          hasAlive = true
          positionAttr.array[i * 3] = p.position.x
          positionAttr.array[i * 3 + 1] = p.position.y
          positionAttr.array[i * 3 + 2] = p.position.z
          sizeAttr.array[i] = p.size
          angleAttr.array[i] = p.rotation

          // 透明度随生命周期衰减
          const lifeRatio = p.life / p.maxLife
          let opacity = lifeRatio
          if (p.type === THREE_PARTICLE_TYPES.FIRE) {
            // 使用 smoothstep 实现更平滑的火球出现与消散，避免闪烁
            opacity = Math.min(1, lifeRatio * 2.0) * (1.0 - Math.pow(1.0 - lifeRatio, 3))
          } else if (p.type === THREE_PARTICLE_TYPES.SMOKE) {
            opacity = Math.min(0.6, (1 - lifeRatio) * 0.8)
          } else if (p.type === THREE_PARTICLE_TYPES.SHOCK_WAVE) {
            opacity = lifeRatio * 0.4
            // 冲击波膨胀
            p.size = p.baseSize + (1 - lifeRatio) * p.expand
            sizeAttr.array[i] = p.size
          } else if (p.type === THREE_PARTICLE_TYPES.DUST) {
            opacity = Math.min(0.4, (1 - lifeRatio) * 0.5)
          }
          opacityAttr.array[i] = opacity
        } else {
          opacityAttr.array[i] = 0
          sizeAttr.array[i] = 0
        }
      }

      positionAttr.needsUpdate = true
      sizeAttr.needsUpdate = true
      opacityAttr.needsUpdate = true
      colorAttr.needsUpdate = true
      angleAttr.needsUpdate = true
      points.visible = hasAlive
    }

    // 更新 3D 岩石碎片实例化网格
    this._updateFragmentMesh()

    // 更新火光强度（使用低通滤波平滑，避免粒子生灭导致的闪烁）
    const fireParticles = this.particles.filter(
      p => p.type === THREE_PARTICLE_TYPES.FIRE && p.alive
    )
    let targetIntensity = 0
    if (fireParticles.length > 0) {
      const avgLife =
        fireParticles.reduce((s, p) => s + p.life / p.maxLife, 0) / fireParticles.length
      targetIntensity = avgLife * 1.5
    }
    // 每帧只向目标值移动 20%，避免突变
    this.fireLight.intensity += (targetIntensity - this.fireLight.intensity) * 0.2
    if (this.fireLight.intensity < 0.01) this.fireLight.intensity = 0

    this.renderFrame()
  }

  /**
   * 触发爆破：完整掌子面破碎为损伤状态（显示漏斗洞口），激活所有爆破粒子
   * （碎片、火球、烟雾、火花、冲击波）。飞溅池粒子不在此激活（由碎片落地时触发）。
   */
  _triggerBlast() {
    this.blastTriggered = true
    // 掌子面破碎：隐藏完整掌子面，显示带爆破漏斗洞口的损伤掌子面（遵守 face 图层开关）
    if (this.faceMesh) this.faceMesh.visible = false
    if (this.faceDamagedMesh) {
      this.faceDamagedMesh.visible = this.layerVisibility.face !== false
    }
    // 钻孔随掌子面破碎消失
    if (this.blastHolesGroup) this.blastHolesGroup.visible = false
    // 岩体已破碎为碎石，隐藏实体岩体（露出掌子面后方的破碎腔与抛掷碎石）
    if (this.benchMesh) this.benchMesh.visible = false
    // 激活所有爆破粒子（跳过飞溅池粒子，它们由碎片落地时触发）
    for (const p of this.particles) {
      if (p.isPool) continue
      p.alive = true
    }
  }

  /**
   * 仅渲染当前场景（不推进粒子模拟）。
   * 由桥接器在每帧同步相机后调用，确保相机移动时画面即时更新。
   */
  renderFrame() {
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * 将粒子系统定位到指定模拟时间（与时间轴同步）。
   * - 时间轴正常推进：增量更新粒子
   * - 时间轴暂停（targetTime ≈ simTime）：不更新，粒子静止
   * - 时间轴跳变（回退或大跨度前进）：重建粒子并快进到 targetTime
   * @param {number} targetTime - 目标模拟时间（秒）
   */
  seekTo(targetTime) {
    if (!this.active) return
    const t = Math.max(0, Number(targetTime) || 0)
    const delta = t - this.simTime

    // 暂停或静止：不推进
    if (Math.abs(delta) < 0.001) return

    // 回退或大跨度前进（>0.5s，相当于跳变）：重建粒子并快进
    if (delta < 0 || delta > 0.5) {
      this._rebuildAndFastForward(t)
      return
    }

    // 正常增量推进
    this.update(delta)
  }

  /**
   * 重建粒子系统并快进到指定时间（用于时间轴跳变）。
   * 复用 initBlast 重新生成粒子，然后按固定步长快进到 targetTime。
   */
  _rebuildAndFastForward(targetTime) {
    if (!this._lastBlastParams) return
    const params = this._lastBlastParams
    // 保存爆心与方向（initBlast 的 clear 不应改变它们，但显式保存更安全）
    const savedCenter = this.center.clone()
    const savedDir = this.faceDirection.clone()

    // initBlast 内部会 clear + 重新生成粒子 + 重置 simTime=0
    this.initBlast(params)

    // 恢复爆心与方向（防止 initBlast 中 faceDirection 被覆盖）
    this.center.copy(savedCenter)
    this.faceDirection.copy(savedDir)

    // 按固定步长快进到目标时间，保证物理稳定性
    const step = 0.05
    let remaining = Math.max(0, targetTime)
    // 限制最大快进步数，避免极端值导致卡顿
    const maxSteps = 400
    let stepCount = 0
    while (remaining > 0 && stepCount < maxSteps) {
      const dt = Math.min(step, remaining)
      this.update(dt)
      remaining -= dt
      stepCount++
    }
  }

  /**
   * 同步相机参数（由 Cesium-Three 桥接器调用）
   * @param {THREE.Vector3} position - 相机位置
   * @param {THREE.Vector3} direction - 视线方向
   * @param {THREE.Vector3} up - 上方向
   * @param {number} fov - 视场角（度）
   * @param {number} aspect - 宽高比
   * @param {number} near - 近裁剪面
   * @param {number} far - 远裁剪面
   */
  syncCamera(position, direction, up, fov, aspect, near, far) {
    this.camera.fov = fov
    this.camera.aspect = aspect
    this.camera.near = near
    this.camera.far = far
    this.camera.position.copy(position)
    this.camera.up.copy(up)

    // 使用方向/上方向直接构造相机姿态，避免大坐标下 lookAt 的精度损失。
    const forward = direction.clone().normalize()
    const cameraZ = forward.clone().negate()
    const cameraX = new THREE.Vector3().crossVectors(up, cameraZ).normalize()
    const cameraY = new THREE.Vector3().crossVectors(cameraZ, cameraX).normalize()
    const rotationMatrix = new THREE.Matrix4().makeBasis(cameraX, cameraY, cameraZ)
    this.camera.quaternion.setFromRotationMatrix(rotationMatrix)
    this.camera.updateMatrixWorld(true)
    this.camera.updateProjectionMatrix()
  }

  resize() {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  clear() {
    this.particles = []
    for (const key of Object.keys(this.particleGroups)) {
      if (this.particleGroups[key]) {
        this.scene.remove(this.particleGroups[key])
        this.particleGroups[key].geometry?.dispose()
        this.particleGroups[key].material?.dispose()
        this.particleGroups[key] = null
      }
    }
    // 清理 3D 岩石碎片实例化网格（共享 geometry/material 在 dispose() 中统一释放）
    this.fragmentMeshes.forEach(mesh => {
      this.scene.remove(mesh)
    })
    this.fragmentMeshes = []
    // 清理掌子面/台阶几何体
    if (this.benchMesh) {
      this.scene.remove(this.benchMesh)
      this.benchMesh.geometry.dispose()
      this.benchMesh.material.dispose()
      this.benchMesh = null
    }
    if (this.faceMesh) {
      this.scene.remove(this.faceMesh)
      this.faceMesh.geometry.dispose()
      this.faceMesh.material.dispose()
      this.faceMesh = null
    }
    if (this.faceDamagedMesh) {
      this.scene.remove(this.faceDamagedMesh)
      this.faceDamagedMesh.geometry.dispose()
      this.faceDamagedMesh.material.dispose()
      this.faceDamagedMesh = null
    }
    if (this.blastHolesGroup) {
      this.scene.remove(this.blastHolesGroup)
      this.blastHolesGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      })
      this.blastHolesGroup = null
    }
    // 清理岩石纹理
    if (this.rockTexture) {
      this.rockTexture.dispose()
      this.rockTexture = null
    }
    this.fireLight.intensity = 0
    this.active = false
    this.simTime = 0
    this.blastTriggered = false
    this.impactDustPool = []
    this.impactSparkPool = []
    this.impactChipPool = []
  }

  dispose() {
    this.clear()
    window.removeEventListener('resize', this._resizeHandler)
    Object.values(this.textures).forEach(tex => tex.dispose())
    if (this.rockMaterial) this.rockMaterial.dispose()
    this.rockGeometries.forEach(g => g.dispose())
    this.rockGeometries = []
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }

  getStats() {
    const alive = this.particles.filter(p => p.alive)
    return {
      total: this.particles.length,
      alive: alive.length,
      fire: alive.filter(p => p.type === THREE_PARTICLE_TYPES.FIRE).length,
      smoke: alive.filter(p => p.type === THREE_PARTICLE_TYPES.SMOKE).length,
      spark: alive.filter(p => p.type === THREE_PARTICLE_TYPES.SPARK).length,
      fragment: alive.filter(p => p.type === THREE_PARTICLE_TYPES.FRAGMENT).length,
      dust: alive.filter(p => p.type === THREE_PARTICLE_TYPES.DUST).length
    }
  }

  /**
   * 设置图层可见性（供 UI 切换烟雾/碎石/隧道/钻孔/标注等）
   * @param {string} layer - 图层名：fire/smoke/spark/fragment/shock_wave/dust
   *                         /tunnel/bench/face/blastHoles/annotations
   * @param {boolean} visible
   */
  setLayerVisible(layer, visible) {
    if (!this.layerVisibility || !(layer in this.layerVisibility)) return
    this.layerVisibility[layer] = !!visible
    this._applyLayerVisibility(layer)
  }

  /** 批量设置多个图层可见性 */
  setLayersVisible(map = {}) {
    for (const [layer, vis] of Object.entries(map)) {
      if (this.layerVisibility && layer in this.layerVisibility) {
        this.layerVisibility[layer] = !!vis
        this._applyLayerVisibility(layer)
      }
    }
  }

  /** 将指定图层的可见性应用到对应 Three.js 对象 */
  _applyLayerVisibility(layer) {
    const visible = this.layerVisibility[layer]
    // 粒子图层：控制对应 Points 组的 visible
    if (this.particleGroups && this.particleGroups[layer] != null) {
      const g = this.particleGroups[layer]
      if (g) g.visible = visible
    }
    // mesh 图层
    switch (layer) {
      case 'tunnel':
        if (this.tunnelShellMesh) this.tunnelShellMesh.visible = visible
        break
      case 'bench':
        if (this.benchMesh && this.blastTriggered === false) this.benchMesh.visible = visible
        break
      case 'face':
        if (this.faceMesh) this.faceMesh.visible = visible && !this.blastTriggered
        if (this.faceDamagedMesh) this.faceDamagedMesh.visible = visible && this.blastTriggered
        break
      case 'blastHoles':
        if (this.blastHolesGroup) {
          this.blastHolesGroup.visible = visible && !this.blastTriggered
        }
        break
      case 'annotations':
        if (this.annotationsGroup) this.annotationsGroup.visible = visible
        break
      case 'fragment':
        // 碎片使用 InstancedMesh，按 variant 分组
        if (this.fragmentMeshes) {
          for (const m of this.fragmentMeshes) m.visible = visible
        }
        break
    }
  }

  /** 获取当前所有图层可见性状态（供 UI 回显） */
  getLayerVisibility() {
    return { ...this.layerVisibility }
  }

  /**
   * 获取爆破设计数据（供 UI 展示炮孔布置图与统计）
   * @returns {object|null} 包含炮孔布置、统计、装药参数等
   */
  getBlastDesign() {
    if (!this.blastHolePattern) return null
    const p = this.blastHolePattern
    const W = p.section.W
    const Hw = p.section.Hw
    const R = p.section.R
    const totalH = p.section.totalH
    const sectionArea = W * Hw + (Math.PI * R * R) / 2
    const holeDepth = 2.5 // 装药孔深(m)
    const advanceDepth = holeDepth * 0.85 // 单循环进尺(m)
    const volumePerRound = sectionArea * advanceDepth // 单循环爆破方量(m³)
    // 装药量估算（按孔型分配比，掏槽孔药量更大）
    // 每米装药线密度 ~0.8 kg/m（Φ32 药卷），掏槽孔加倍
    const chargeDensity = 0.8
    const cutCharge = p.counts.cut * holeDepth * chargeDensity * 1.5
    const auxCharge = p.counts.auxiliary * holeDepth * chargeDensity * 1.0
    const perimCharge = p.counts.perimeter * holeDepth * chargeDensity * 0.7 // 周边孔光面爆破，线密度低
    const totalCharge = cutCharge + auxCharge + perimCharge
    const specificCharge = totalCharge / volumePerRound // 炸药单耗 kg/m³
    return {
      section: { W, Hw, R, totalH, area: sectionArea },
      holeDepth,
      advanceDepth,
      volumePerRound,
      counts: p.counts,
      holes: p.holes,
      charge: {
        cut: cutCharge,
        auxiliary: auxCharge,
        perimeter: perimCharge,
        total: totalCharge,
        specific: specificCharge
      }
    }
  }
}
