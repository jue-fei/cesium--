/**
 * 场景构建器
 *
 * 负责场景光照、隧道/掌子面/台阶网格、爆破钻孔、标注等场景元素的构建与管理。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'

// ─── 默认光照配置（可由 config.lighting 覆盖） ──────────
const DEFAULT_LIGHTING = {
  ambient: { color: 0xb0b8c0, intensity: 2.5 },
  sun: { color: 0xffffff, intensity: 2.2, position: [50, 80, 30] },
  hemisphere: { sky: 0xaaccff, ground: 0x998866, intensity: 1.5 },
  tunnelLight: { color: 0xffeecc, intensity: 3.0, distance: 180, decay: 1.5, position: [0, 8, -10] },
  tunnelLight2: { color: 0xfff4dd, intensity: 2.5, distance: 180, decay: 1.5, position: [0, 6, -30] },
  fireLight: { color: 0xff6600, intensity: 0, distance: 500, decay: 2 }
}

// ─── 炮孔类型颜色编码 ──────────────────────────────────
const HOLE_TYPE_COLORS = {
  cut: 0xff6b6b,
  easing: 0xff6b6b,      // easing 等同 cut
  auxiliary: 0xfeca57,
  production: 0xfeca57,  // production 默认归入辅助
  perimeter: 0x1dd1a1
}
const EMPTY_HOLE_COLOR = 0xffffff

// ─── seeded RNG（mulberry32，保证漏斗形状可复现） ──────
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── 粒子纹理生成（程序化，无需外部资源） ──────────────
export function createFireTexture() {
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

export function createSmokeTexture() {
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

export function createSparkTexture() {
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

// ─── 程序化岩石纹理（用于掌子面/台阶） ─────────────────
export function createRockTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // 基础颜色：亮棕灰色
  ctx.fillStyle = '#9a8a78'
  ctx.fillRect(0, 0, size, size)
  // 添加岩石纹理：随机亮色块
  for (let i = 0; i < 350; i++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = Math.random() * 20 + 5
    const gray = 120 + Math.random() * 80
    ctx.fillStyle = `rgba(${gray},${gray * 0.85},${gray * 0.7},${Math.random() * 0.5})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // 添加裂纹
  ctx.strokeStyle = 'rgba(80,60,40,0.25)'
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

/**
 * 场景构建器类
 * 管理场景中的静态/半静态元素：光照、隧道壳体、掌子面、岩体、爆破钻孔、标注等。
 */
export class SceneBuilder {
  /**
   * @param {THREE.Scene} scene - Three.js 场景
   * @param {Object} config - 配置项
   * @param {THREE.Vector3} config.center - 爆心位置（引用，随主渲染器更新）
   * @param {THREE.Vector3} config.faceDirection - 掌子面朝向（引用）
   * @param {Object} config.layerVisibility - 图层可见性（引用）
   * @param {number} config.tunnelWidth - 隧道宽度
   * @param {number} config.tunnelWallHeight - 直墙高度
   * @param {number} config.tunnelArchRadius - 拱部半径
   * @param {number} config.tunnelHeight - 隧道总高
   * @param {number} config.benchLength - 岩体深度
   * @param {Object} config.tunnelSection - 隧道断面参数
   * @param {Object} [config.lighting] - 光照参数覆盖（结构同 DEFAULT_LIGHTING）
   * @param {number} [config.craterSeed] - 漏斗形状随机种子（默认 12345，保证可复现）
   */
  constructor(scene, config) {
    this.scene = scene

    // 共享状态引用（由主渲染器持有和更新）
    this.center = config.center
    this.faceDirection = config.faceDirection
    this.layerVisibility = config.layerVisibility

    // 隧道断面参数
    this.tunnelWidth = config.tunnelWidth
    this.tunnelWallHeight = config.tunnelWallHeight
    this.tunnelArchRadius = config.tunnelArchRadius
    this.tunnelHeight = config.tunnelHeight
    this.benchLength = config.benchLength
    this.tunnelSection = config.tunnelSection

    // 光照配置（支持外部覆盖，默认值经调校保证隧道内部可见度）
    this.lighting = { ...DEFAULT_LIGHTING, ...(config.lighting || {}) }
    // 漏斗形状随机种子（保证可复现，便于调试与回归测试）
    this._rng = mulberry32(config.craterSeed ?? 12345)

    // 设计数据（由主渲染器注入）
    this.blastHoleDesign = null
    this.designParams = null
    this.blastEffect = null
    this.blastHolePattern = null

    // 场景网格（由 SceneBuilder 创建和管理）
    this.benchMesh = null
    this.faceMesh = null
    this.faceDamagedMesh = null
    this.tunnelShellMesh = null
    this.blastHolesGroup = null
    this.annotationsGroup = null
    this.craterMesh = null
    this.rockTexture = null

    // 光照
    this.sunLight = null
    this.tunnelLight = null
    this.tunnelLight2 = null
    this.fireLight = null

    this._setupLights()
  }

  // ─── 光照 ─────────────────────────────────────────────
  _setupLights() {
    const L = this.lighting

    // 环境光（大幅增强，暗部细节清晰可见）
    const ambient = new THREE.AmbientLight(L.ambient.color, L.ambient.intensity)
    this.scene.add(ambient)

    // 方向光（模拟太阳光）
    this.sunLight = new THREE.DirectionalLight(L.sun.color, L.sun.intensity)
    this.sunLight.position.set(...L.sun.position)
    this.scene.add(this.sunLight)

    // 半球光（天空-地面）
    const hemiLight = new THREE.HemisphereLight(L.hemisphere.sky, L.hemisphere.ground, L.hemisphere.intensity)
    this.scene.add(hemiLight)

    // 隧道内部补光 #1（掌子面附近，模拟施工照明）
    const tl = L.tunnelLight
    this.tunnelLight = new THREE.PointLight(tl.color, tl.intensity, tl.distance, tl.decay)
    this.tunnelLight.position.set(...tl.position)
    this.scene.add(this.tunnelLight)

    // 隧道内部补光 #2（相机后方，向前照射掌子面+碎石）
    const tl2 = L.tunnelLight2
    this.tunnelLight2 = new THREE.PointLight(tl2.color, tl2.intensity, tl2.distance, tl2.decay)
    this.tunnelLight2.position.set(...tl2.position)
    this.scene.add(this.tunnelLight2)

    // 爆心点光源（动态火光）
    const fl = L.fireLight
    this.fireLight = new THREE.PointLight(fl.color, fl.intensity, fl.distance, fl.decay)
    this.scene.add(this.fireLight)
  }

  /**
   * 同步隧道补光位置（由主渲染器在 initBlast 后调用）
   * @param {THREE.Vector3} center - 爆心位置
   * @param {THREE.Vector3} faceDirection - 掌子面朝向
   * @param {number} tunnelHeight - 隧道总高
   */
  updateTunnelLights(center, faceDirection, tunnelHeight) {
    if (this.tunnelLight) {
      this.tunnelLight.position.set(
        center.x - faceDirection.x * 15,
        center.z + tunnelHeight * 0.5,
        center.y - faceDirection.z * 15
      )
    }
    if (this.tunnelLight2) {
      this.tunnelLight2.position.set(
        center.x - faceDirection.x * 40,
        center.z + tunnelHeight * 0.45,
        center.y - faceDirection.z * 40
      )
    }
  }

  // ─── 隧道断面 Shape 构建 ─────────────────────────────
  /**
   * 构建马蹄形断面 Shape（直墙 + 半圆拱），可选中央爆破漏斗洞口
   * @param {boolean} withCrater - 是否包含爆破漏斗洞口
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @param {number} totalH - 隧道总高
   * @returns {THREE.Shape}
   */
  _createTunnelShape(withCrater, W, Hw, R, totalH) {
    const shape = new THREE.Shape()
    shape.moveTo(-W / 2, 0)
    shape.lineTo(-W / 2, Hw)
    // 半圆拱：从左侧经顶部到右侧（顺时针扫过 π→0）
    shape.absarc(0, Hw, R, Math.PI, 0, true)
    shape.lineTo(W / 2, 0)
    shape.closePath()

    if (withCrater) {
      // 真实爆破掌子面：中心深破碎抛出 + 围岩一圈残留（轮廓孔光面爆破痕迹）
      // 1) 中央破碎区（掏槽+辅助孔区域，完全破碎抛出，形成深凹腔）
      const crater = new THREE.Path()
      const craterCX = 0
      const craterCY = totalH * 0.40
      // 中央破碎区约占断面 90%（大面积破碎抛出）
      const craterW = W * 0.90
      const craterH = totalH * 0.90
      const craterPts = 24
      for (let i = 0; i < craterPts; i++) {
        const a = (i / craterPts) * Math.PI * 2
        const jag1 = Math.sin(i * 1.4 + 0.5) * 0.12
        const jag2 = Math.sin(i * 4.1 + 1.8) * 0.05
        const jag3 = Math.sin(i * 8.3 + 0.3) * 0.03
        const noise = (this._rng() - 0.5) * 0.08
        const rScale = 0.88 + jag1 + jag2 + jag3 + noise
        const x = craterCX + Math.cos(a) * craterW * 0.5 * rScale
        const y = craterCY + Math.sin(a) * craterH * 0.5 * rScale
        if (i === 0) crater.moveTo(x, y)
        else crater.lineTo(x, y)
      }
      crater.closePath()
      shape.holes.push(crater)

      // 2) 围岩轮廓超挖/欠挖痕迹：沿马蹄形轮廓的微小不规则碎裂
      const perimCount = 20
      for (let h = 0; h < perimCount; h++) {
        const ph = new THREE.Path()
        const t = h / perimCount
        // 沿马蹄形轮廓均匀采样
        const perimeterLen = 2 * Hw + Math.PI * R
        const d = t * perimeterLen
        let px, py
        if (d < Hw) {
          px = -W / 2 + 0.3; py = d
        } else if (d < 2 * Hw) {
          px = W / 2 - 0.3; py = 2 * Hw - d
        } else {
          const a = Math.PI - ((d - 2 * Hw) / (Math.PI * R)) * Math.PI
          px = Math.cos(a) * (R - 0.3); py = Hw + Math.sin(a) * (R - 0.3)
        }
        const pr = W * 0.018
        const ppts = 5
        for (let i = 0; i < ppts; i++) {
          const a = (i / ppts) * Math.PI * 2
          const r = pr * (0.6 + this._rng() * 0.5)
          const x = px + Math.cos(a) * r
          const y = py + Math.sin(a) * r
          if (i === 0) ph.moveTo(x, y)
          else ph.lineTo(x, y)
        }
        ph.closePath()
        shape.holes.push(ph)
      }
    }
    return shape
  }

  // ─── 统一释放 Group 及其子对象资源 ────────────────────
  _disposeGroup(group) {
    if (!group) return
    this.scene.remove(group)
    group.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        if (o.material.map) o.material.map.dispose()
        o.material.dispose()
      }
    })
  }

  // ─── 清理旧场景网格 ──────────────────────────────────
  _cleanupBenchGeometry() {
    const disposeSingle = (mesh) => {
      if (!mesh) return
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    disposeSingle(this.benchMesh); this.benchMesh = null
    disposeSingle(this.faceMesh); this.faceMesh = null
    disposeSingle(this.faceDamagedMesh); this.faceDamagedMesh = null
    disposeSingle(this.tunnelShellMesh); this.tunnelShellMesh = null
    disposeSingle(this.craterMesh); this.craterMesh = null
    this._disposeGroup(this.blastHolesGroup); this.blastHolesGroup = null
    this._disposeGroup(this.annotationsGroup); this.annotationsGroup = null
  }

  // ─── 主构建入口 ───────────────────────────────────────
  /**
   * 构建隧道掌子面与岩体几何体
   * 掌子面为马蹄形（直墙 + 半圆拱）垂直平面，垂直于地面、法线沿爆破方向。
   * - benchMesh：掌子面后方待爆岩体（马蹄形挤出）
   * - faceMesh：完整掌子面（爆破前可见）
   * - faceDamagedMesh：损伤掌子面，中央带爆破漏斗洞口（爆破后可见）
   */
  buildBenchGeometry() {
    this._cleanupBenchGeometry()

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

    // 朝向旋转：绕 Y 轴旋转，使局部 +Z（挤出方向）对齐爆破方向 dir
    const yaw = Math.atan2(dir.x, dir.z)
    const faceOffset = 3 // 掌子面距爆心前方 3m

    // 缓存无漏斗断面 Shape（bench/shell/face 共用，避免重复构建 3 次）
    const tunnelShape = this._createTunnelShape(false, W, Hw, R, totalH)
    const ctx = { W, Hw, R, totalH, yaw, faceOffset, cx, cy, cz, dir, tunnelShape }

    // 材质
    const benchMat = new THREE.MeshStandardMaterial({
      color: 0xb8946e,
      map: this.rockTexture,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide
    })
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0x8a7a6a,
      map: this.rockTexture,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide
    })

    this._buildBenchMesh({ ...ctx, benchMat })
    this._buildTunnelShell(ctx)
    this._buildFaceMesh({ ...ctx, faceMat })
    this._buildFaceDamagedMesh({ ...ctx, faceMat })
    this._buildBlastHoles(yaw, faceOffset)
  }

  // ─── 岩体（马蹄形挤出，掌子面前方待爆岩体） ──────────
  _buildBenchMesh(ctx) {
    const benchDepth = this.benchLength
    const benchGeo = new THREE.ExtrudeGeometry(
      ctx.tunnelShape,
      { depth: benchDepth, bevelEnabled: false }
    )
    benchGeo.translate(0, 0, -benchDepth / 2) // 沿深度居中
    this.benchMesh = new THREE.Mesh(benchGeo, ctx.benchMat)
    // 岩体位于掌子面前方（+forward，未开挖岩体方向），后端贴合掌子面
    this.benchMesh.position.set(
      ctx.cx + ctx.dir.x * (ctx.faceOffset + benchDepth / 2),
      ctx.cz,
      ctx.cy + ctx.dir.z * (ctx.faceOffset + benchDepth / 2)
    )
    this.benchMesh.rotation.y = ctx.yaw
    this.benchMesh.castShadow = true
    this.benchMesh.receiveShadow = true
    this.scene.add(this.benchMesh)
  }

  // ─── 隧道内壁（已开挖段） ────────────────────────────
  _buildTunnelShell(ctx) {
    const shellLength = 80 // 已开挖隧道长度(m)，足够覆盖相机视野
    const shellGeo = new THREE.ExtrudeGeometry(
      ctx.tunnelShape,
      { depth: shellLength, bevelEnabled: false }
    )
    // 沿 +Z extrude；translate 使其一端在 Z=0（掌子面端），另一端在 Z=-shellLength（相机后方）
    shellGeo.translate(0, 0, -shellLength)
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x6a6560,
      side: THREE.BackSide, // 仅渲染内壁（从管内观察）
      roughness: 0.95,
      metalness: 0.05
    })
    this.tunnelShellMesh = new THREE.Mesh(shellGeo, shellMat)
    // 前端贴合掌子面（faceOffset），向 -forward 延伸
    this.tunnelShellMesh.position.set(ctx.cx + ctx.dir.x * ctx.faceOffset, ctx.cz, ctx.cy + ctx.dir.z * ctx.faceOffset)
    this.tunnelShellMesh.rotation.y = ctx.yaw
    this.tunnelShellMesh.receiveShadow = true
    this.scene.add(this.tunnelShellMesh)
  }

  // ─── 完整掌子面（薄板马蹄形，爆破前可见） ────────────
  _buildFaceMesh(ctx) {
    const faceThickness = 2
    const faceGeo = new THREE.ExtrudeGeometry(
      ctx.tunnelShape,
      { depth: faceThickness, bevelEnabled: false }
    )
    faceGeo.translate(0, 0, -faceThickness / 2)
    this.faceMesh = new THREE.Mesh(faceGeo, ctx.faceMat)
    this.faceMesh.position.set(ctx.cx + ctx.dir.x * ctx.faceOffset, ctx.cz, ctx.cy + ctx.dir.z * ctx.faceOffset)
    this.faceMesh.rotation.y = ctx.yaw
    this.faceMesh.castShadow = true
    this.faceMesh.receiveShadow = true
    this.faceMesh.visible = true
    this.scene.add(this.faceMesh)
  }

  // ─── 损伤掌子面 + 3D 爆破漏斗（爆破后可见） ──────────
  _buildFaceDamagedMesh(ctx) {
    const faceThickness = 2
    const damagedMat = ctx.faceMat.clone()
    damagedMat.color = new THREE.Color(0x7a6a5a) // 损伤面颜色
    // 损伤面含漏斗洞口，使用独立 Shape（withCrater=true）
    const damagedGeo = new THREE.ExtrudeGeometry(
      this._createTunnelShape(true, ctx.W, ctx.Hw, ctx.R, ctx.totalH),
      { depth: faceThickness, bevelEnabled: false }
    )
    damagedGeo.translate(0, 0, -faceThickness / 2)
    this.faceDamagedMesh = new THREE.Mesh(damagedGeo, damagedMat)
    this.faceDamagedMesh.position.copy(this.faceMesh.position)
    this.faceDamagedMesh.rotation.y = ctx.yaw
    this.faceDamagedMesh.castShadow = true
    this.faceDamagedMesh.receiveShadow = true
    this.faceDamagedMesh.visible = false
    this.scene.add(this.faceDamagedMesh)

    // ── 3D 爆破漏斗（更深更宽，真实体现掏槽爆破的破碎腔） ──
    // 漏斗直径占断面宽度 90%，使爆破面覆盖大部分掌子面
    const craterDepth = Math.max(6, Math.min(ctx.totalH * 0.65, 12))
    const craterRadius = ctx.W * 0.45
    const craterGeo = this._buildCraterGeometry(craterRadius, craterDepth, 40)
    const craterMat = new THREE.MeshStandardMaterial({
      color: 0x0d0805,
      roughness: 1.0, metalness: 0.0, flatShading: true, side: THREE.DoubleSide
    })
    this.craterMesh = new THREE.Mesh(craterGeo, craterMat)
    const rectArea = ctx.W * ctx.Hw
    const archArea = (Math.PI * ctx.R * ctx.R) / 2
    const totalArea = rectArea + archArea
    const hcy = (rectArea * (ctx.Hw * 0.5) + archArea * (ctx.Hw + (4 * ctx.R) / (3 * Math.PI))) / totalArea
    this.craterMesh.position.set(
      ctx.cx + ctx.dir.x * (ctx.faceOffset + 0.15), ctx.cz + hcy, ctx.cy + ctx.dir.z * (ctx.faceOffset + 0.15)
    )
    this.craterMesh.rotation.y = ctx.yaw
    this.craterMesh.castShadow = true
    this.craterMesh.receiveShadow = true
    this.craterMesh.visible = false
    this.scene.add(this.craterMesh)
  }

  // ─── 爆破钻孔（主协调入口） ──────────────────────────
  /**
   * 在掌子面上构建爆破钻孔布孔图案。
   * 若设置了 this.blastHoleDesign（数据库炮孔设计数据），则动态渲染；
   * 否则回退到硬编码典型布孔（中央菱形掏槽 + 2 圈辅助 + 周边孔）。
   */
  _buildBlastHoles(yaw, faceOffset) {
    this._disposeGroup(this.blastHolesGroup)
    this.blastHolesGroup = null

    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight
    const cy0 = totalH * 0.5 // 掌子面中心高度

    // 1. 收集孔位（数据库模式 / 回退模式）
    const holes = this._collectBlastHoles(cy0, W, Hw, R, totalH)

    // 2. 构建 mesh + 孔位标注
    const group = this._buildHoleMeshes(holes)

    // 3. 整体定位到掌子面位置
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = true
    this.scene.add(group)
    this.blastHolesGroup = group

    // 4. 保存炮孔布置数据（供 UI 绘制 2D 布置图与统计）
    this._saveBlastHolePattern(holes, W, Hw, R, totalH)

    // 5. 构建专业标注（掘进深度、断面尺寸、孔型分区标签）
    this._buildAnnotations(yaw, faceOffset)
  }

  // ─── 孔位收集：按数据源分发 ──────────────────────────
  _collectBlastHoles(cy0, W, Hw, R, totalH) {
    if (this.blastHoleDesign && this.blastHoleDesign.length > 0) {
      return this._collectDesignHoles(cy0)
    }
    return this._collectFallbackHoles(cy0, W, Hw, R)
  }

  // ─── 数据库模式：从 blastHoleDesign 动态生成孔位 ──────
  _collectDesignHoles(cy0) {
    const defaultDepth = Number(this.designParams?.holeDepth) || 2.5
    const defaultDiameter = Number(this.designParams?.holeDiameter) || 0.04
    const holes = []
    for (const h of this.blastHoleDesign) {
      const type = (h.holeType || 'production').toLowerCase()
      let mappedType = 'auxiliary'
      if (type === 'cut' || type === 'easing') mappedType = 'cut'
      else if (type === 'perimeter') mappedType = 'perimeter'
      const isEmpty = !!h.isEmptyHole
      const depth = Math.max(0.1, Number(h.depth) || defaultDepth)
      const realDia = Number(h.diameter) || defaultDiameter
      const visRadius = Math.max(0.08, realDia * 4) // 视觉放大 4 倍
      holes.push({
        x: Number(h.posX) || 0,
        y: Number(h.posY) || cy0,
        type: mappedType,
        isEmpty,
        depth,
        visRadius,
        inclination: Number(h.inclinationAngle ?? h.inclination) || 0,
        azimuth: Number(h.inclinationAzimuth ?? h.azimuth) || 0,
        chargeKg: Number(h.chargeKg) || 0,
        chargeLength: Number(h.chargeLength) || 0,
        explosiveType: h.explosiveType || 'emulsion',
        detonatorSeries: Number(h.detonatorSeries) || 1,
        delayMs: Number(h.delayMs) || 0,
        id: h.id
      })
    }
    return holes
  }

  // ─── 回退模式：硬编码典型布孔（菱形掏槽 + 辅助 + 周边）
  _collectFallbackHoles(cy0, W, Hw, R) {
    const cutR = 1.0
    const holeDepth = Number(this.designParams?.holeDepth) || 2.5
    const realDia = Number(this.designParams?.holeDiameter) || 0.04
    const visRadius = Math.max(0.08, realDia * 4)
    const emptyVisRadius = visRadius * 1.6
    const holes = []

    // 中心空孔
    holes.push({
      x: 0, y: cy0, type: 'cut', isEmpty: true,
      depth: holeDepth, visRadius: emptyVisRadius,
      inclination: 0, azimuth: 0,
      chargeKg: 0, chargeLength: 0, explosiveType: 'emulsion',
      detonatorSeries: 1, delayMs: 0, id: 'CUT-EMPTY'
    })
    // 菱形 4 孔装药掏槽
    const cutPos = [[cutR, cy0], [-cutR, cy0], [0, cy0 + cutR], [0, cy0 - cutR]]
    cutPos.forEach((p, i) => {
      holes.push({
        x: p[0], y: p[1], type: 'cut', isEmpty: false,
        depth: holeDepth, visRadius,
        inclination: 0, azimuth: 0,
        chargeKg: holeDepth * 0.8 * 1.2, chargeLength: holeDepth * 0.8,
        explosiveType: 'emulsion', detonatorSeries: i + 2,
        delayMs: (i + 2) * 100, id: `CUT-${i + 1}`
      })
    })
    // 辅助孔 2 圈
    const helperRings = [{ r: 2.6, n: 8 }, { r: 4.2, n: 12 }]
    let auxSeries = 6
    helperRings.forEach(({ r, n }) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.cos(a) * r
        const y = cy0 + Math.sin(a) * r
        if (this._isInsideTunnelSection(x, y, W, Hw, R)) {
          holes.push({
            x, y, type: 'auxiliary', isEmpty: false,
            depth: holeDepth, visRadius,
            inclination: 0, azimuth: 0,
            chargeKg: holeDepth * 0.7 * 1.0, chargeLength: holeDepth * 0.7,
            explosiveType: 'emulsion', detonatorSeries: auxSeries,
            delayMs: auxSeries * 100, id: `AUX-${auxSeries}`
          })
          auxSeries = (auxSeries % 20) + 1
        }
      }
    })
    // 周边孔：沿马蹄形轮廓
    const perimSpacing = Number(this.designParams?.perimeterSpacing) || 1.2
    let perimSeries = auxSeries
    for (let y = 1.0; y <= Hw - 0.3; y += perimSpacing) {
      for (const x of [-W / 2 + 0.35, W / 2 - 0.35]) {
        holes.push({
          x, y, type: 'perimeter', isEmpty: false,
          depth: holeDepth, visRadius,
          inclination: 3, azimuth: x > 0 ? 90 : -90,
          chargeKg: holeDepth * 0.6 * 0.5, chargeLength: holeDepth * 0.6,
          explosiveType: 'emulsion', detonatorSeries: perimSeries,
          delayMs: perimSeries * 100, id: `PER-W-${perimSeries}`
        })
        perimSeries = (perimSeries % 20) + 1
      }
    }
    const archN = Math.max(8, Math.floor((Math.PI * R) / perimSpacing))
    for (let i = 1; i < archN; i++) {
      const a = Math.PI - (i / archN) * Math.PI
      const x = Math.cos(a) * R
      const y = Hw + Math.sin(a) * R
      holes.push({
        x, y, type: 'perimeter', isEmpty: false,
        depth: holeDepth, visRadius,
        inclination: 3, azimuth: Math.atan2(x, y - Hw) * 180 / Math.PI,
        chargeKg: holeDepth * 0.6 * 0.5, chargeLength: holeDepth * 0.6,
        explosiveType: 'emulsion', detonatorSeries: perimSeries,
        delayMs: perimSeries * 100, id: `PER-A-${perimSeries}`
      })
      perimSeries = (perimSeries % 20) + 1
    }
    holes.push({
      x: -W / 2 + 0.4, y: 0.5, type: 'perimeter', isEmpty: false,
      depth: holeDepth, visRadius, inclination: 5, azimuth: -90,
      chargeKg: holeDepth * 0.7 * 0.5, chargeLength: holeDepth * 0.7,
      explosiveType: 'emulsion', detonatorSeries: perimSeries,
      delayMs: perimSeries * 100, id: 'PER-BL'
    })
    holes.push({
      x: W / 2 - 0.4, y: 0.5, type: 'perimeter', isEmpty: false,
      depth: holeDepth, visRadius, inclination: 5, azimuth: 90,
      chargeKg: holeDepth * 0.7 * 0.5, chargeLength: holeDepth * 0.7,
      explosiveType: 'emulsion', detonatorSeries: perimSeries,
      delayMs: perimSeries * 100, id: 'PER-BR'
    })
    return holes
  }

  // ─── 构建钻孔几何体（按类型分组共享材质/几何，性能优化）──
  _buildHoleMeshes(holes) {
    const group = new THREE.Group()
    const faceThickness = 2
    const frontZ = faceThickness / 2 + 0.02 // 略凸出掌子面前表面

    // 按类型 + visRadius 聚合，减少几何体实例数
    const geoCache = new Map()
    const matCache = new Map()
    const getGeo = (visRadius, depth) => {
      const key = `${visRadius.toFixed(3)}_${depth.toFixed(3)}`
      if (!geoCache.has(key)) {
        const g = new THREE.CylinderGeometry(visRadius, visRadius, depth, 12)
        g.rotateX(Math.PI / 2) // Y → Z 轴，向 -Z 延伸
        geoCache.set(key, g)
      }
      return geoCache.get(key)
    }
    const getMat = (type, isEmpty) => {
      const key = `${type}_${isEmpty ? 'e' : 'f'}`
      if (!matCache.has(key)) {
        const color = isEmpty ? EMPTY_HOLE_COLOR : (HOLE_TYPE_COLORS[type] ?? 0xfeca57)
        const m = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.7,
          metalness: 0.1,
          emissive: isEmpty ? 0x222222 : (color & 0x222222), // 空孔弱自发光
          emissiveIntensity: isEmpty ? 0.2 : 0.1,
          flatShading: true
        })
        matCache.set(key, m)
      }
      return matCache.get(key)
    }

    holes.forEach(h => {
      const geo = getGeo(h.visRadius, h.depth)
      const mat = getMat(h.type, h.isEmpty)
      const mesh = new THREE.Mesh(geo, mat)
      // 位置：圆柱中心位于 frontZ - depth/2，使前端贴齐掌子面、向岩体内延伸
      mesh.position.set(h.x, h.y, frontZ - h.depth / 2)

      // 倾斜渲染
      if (h.inclination && h.inclination > 0.1) {
        const incRad = (h.inclination * Math.PI) / 180
        const aziRad = (h.azimuth * Math.PI) / 180
        mesh.rotation.set(
          -Math.sin(aziRad) * incRad,
          Math.cos(aziRad) * incRad,
          0,
          'XYZ'
        )
      }

      // 孔位标注：在孔口附近显示编号 + 段别 + 装药量（小尺寸 Sprite）
      if (holes.length <= 60 && h.id) {
        const labelText = `${h.id} · S${h.detonatorSeries}`
        const chargeText = h.isEmpty ? '(空孔)' : `${h.chargeKg.toFixed(1)}kg`
        const labelColor = h.isEmpty ? '#cccccc'
          : '#' + (HOLE_TYPE_COLORS[h.type] ?? 0xfeca57).toString(16).padStart(6, '0')
        const sprite = this._createTextSprite(`${labelText}\n${chargeText}`, labelColor, 18)
        if (sprite) {
          sprite.position.set(h.x, h.y + 0.4, frontZ + 0.05)
          sprite.scale.set(1.5, 0.6, 1)
          group.add(sprite)
        }
      }

      group.add(mesh)
    })
    return group
  }

  // ─── 保存炮孔布置数据（供 UI 绘制 2D 布置图与统计）──
  _saveBlastHolePattern(holes, W, Hw, R, totalH) {
    const cutHoles = holes.filter(h => h.type === 'cut')
    const perimHoles = holes.filter(h => h.type === 'perimeter')
    const auxHoles = holes.filter(h => h.type === 'auxiliary')
    this.blastHolePattern = {
      section: { W, Hw, R, totalH },
      holes: holes.map(h => ({
        x: h.x,
        y: h.y,
        isEmpty: h.isEmpty,
        type: h.type,
        depth: h.depth,
        inclination: h.inclination,
        azimuth: h.azimuth,
        chargeKg: h.chargeKg,
        chargeLength: h.chargeLength,
        explosiveType: h.explosiveType,
        detonatorSeries: h.detonatorSeries,
        delayMs: h.delayMs,
        id: h.id
      })),
      counts: {
        cut: cutHoles.length,
        auxiliary: auxHoles.length,
        perimeter: perimHoles.length,
        total: holes.length,
        empty: holes.filter(h => h.isEmpty).length
      }
    }
  }

  // ─── 专业爆破元素 3D 标注 ─────────────────────────────
  _buildAnnotations(yaw, faceOffset) {
    // 独立清理旧标注组（避免重复调用时累积）
    this._disposeGroup(this.annotationsGroup)
    this.annotationsGroup = null

    const group = new THREE.Group()
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    const W = this.tunnelWidth
    const Hw = this.tunnelWallHeight
    const R = this.tunnelArchRadius
    const totalH = this.tunnelHeight

    // 掘进深度标注（保留）
    const holeDepth = Number(this.designParams?.holeDepth) || 2.5
    const utilization = Number(this.designParams?.utilization) || 0.85
    const advanceDepth = Number(this.designParams?.advanceLength) || (holeDepth * utilization)
    const advanceLabel = this._createTextSprite(
      `掘进进尺: ${advanceDepth.toFixed(2)} m  (孔深${holeDepth.toFixed(1)}m × 利用率${(utilization * 100).toFixed(0)}%)`,
      '#ffd166',
      32
    )
    advanceLabel.position.set(W * 0.5 + 1.5, totalH - 1, 0.1)
    group.add(advanceLabel)

    // 断面尺寸标注（保留）
    const sectionArea = W * Hw + (Math.PI * R * R) / 2
    const shapeLabel = this.tunnelSection?.shape || 'horseshoe'
    const shapeCN = shapeLabel === 'horseshoe' ? '马蹄形'
      : shapeLabel === 'circular' ? '圆形'
        : shapeLabel === 'rectangular' ? '矩形'
          : '拱形'
    const sizeLabel = this._createTextSprite(
      `断面: ${shapeCN} ${W}m × ${totalH.toFixed(1)}m  (A=${sectionArea.toFixed(1)}m²)`,
      '#4fc3f7',
      28
    )
    sizeLabel.position.set(-W * 0.5 - 1.5, totalH - 1, 0.1)
    group.add(sizeLabel)

    // 整体定位到掌子面前表面
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = this.layerVisibility.annotations !== false
    this.scene.add(group)
    this.annotationsGroup = group
  }

  // ─── 文字 Sprite 创建 ────────────────────────────────
  /**
   * 创建文字 Sprite（Canvas 纹理，始终面向相机）
   * @param {string} text - 文字内容
   * @param {string} color - 文字颜色（CSS）
   * @param {number} fontSize - 字号
   * @returns {THREE.Sprite}
   */
  _createTextSprite(text, color = '#ffffff', fontSize = 24) {
    const padding = 12
    const supersample = 4 // 4x 超采样保证文字高清锐利
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const logicalFont = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
    ctx.font = logicalFont
    const metrics = ctx.measureText(text)
    const logicalW = Math.ceil(metrics.width) + padding * 2
    const logicalH = fontSize + padding * 2
    canvas.width = logicalW * supersample
    canvas.height = logicalH * supersample
    const c2 = canvas.getContext('2d')
    c2.scale(supersample, supersample)
    c2.font = logicalFont
    c2.fillStyle = 'rgba(0, 0, 0, 0.55)'
    c2.fillRect(0, 0, logicalW, logicalH)
    c2.strokeStyle = color
    c2.lineWidth = 2
    c2.strokeRect(1, 1, logicalW - 2, logicalH - 2)
    c2.fillStyle = color
    c2.textBaseline = 'middle'
    c2.fillText(text, padding, logicalH / 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    })
    const sprite = new THREE.Sprite(material)
    // 缩放：使用逻辑尺寸（非超采样物理尺寸）映射到 3D 场景
    const scale = 0.035
    sprite.scale.set(logicalW * scale, logicalH * scale, 1)
    return sprite
  }

  // ─── 爆破漏斗几何 ────────────────────────────────────
  /**
   * 构建爆破漏斗 3D 几何（抛物面凹陷碗状）
   */
  _buildCraterGeometry(radius, depth, segments = 32) {
    const geo = new THREE.BufferGeometry()
    const r = Math.max(0.5, radius)
    const d = Math.max(0.5, depth)
    const verts = []; const idx = []
    // 开口环
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      verts.push(Math.cos(a) * r, Math.sin(a) * r, 0)
    }
    // 抛物面分层
    const rings = 8
    for (let ring = 1; ring <= rings; ring++) {
      const t = ring / rings
      const z = d * t * t
      const ringR = r * (1 - t * 0.82)
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2
        verts.push(Math.cos(a) * ringR, Math.sin(a) * ringR, z)
      }
    }
    // 底部尖点
    verts.push(0, 0, d * 1.05)
    const bottomIdx = verts.length / 3 - 1
    for (let ring = 0; ring < rings; ring++) {
      for (let i = 0; i < segments; i++) {
        const a = ring * (segments + 1) + i, b = a + 1, c = a + (segments + 1), e = c + 1
        idx.push(a, b, c, b, e, c)
      }
    }
    for (let i = 0; i < segments; i++) {
      const a = rings * (segments + 1) + i
      idx.push(a, a + 1, bottomIdx)
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    return geo
  }

  // ─── 断面内判断 ──────────────────────────────────────
  _isInsideTunnelSection(x, y, W, Hw, R) {
    if (Math.abs(x) > W / 2 - 0.2) return false
    if (y < 0.2) return false
    if (y <= Hw) return true
    const dx = x
    const dy = y - Hw
    return dx * dx + dy * dy <= (R - 0.2) * (R - 0.2)
  }

  // ─── 爆破触发（切换掌子面可见性） ────────────────────
  triggerBlast() {
    if (this.faceMesh) this.faceMesh.visible = false
    if (this.faceDamagedMesh) this.faceDamagedMesh.visible = this.layerVisibility.face !== false
    if (this.craterMesh) this.craterMesh.visible = this.layerVisibility.face !== false
    if (this.blastHolesGroup) this.blastHolesGroup.visible = false
  }

  // ─── 图层可见性应用 ──────────────────────────────────
  /**
   * 将指定图层的可见性应用到对应 Three.js 对象
   * @param {string} layer - 图层名
   * @param {boolean} visible - 是否可见
   * @param {boolean} blastTriggered - 爆破是否已触发
   */
  applyLayerVisibility(layer, visible, blastTriggered) {
    switch (layer) {
      case 'tunnel':
        if (this.tunnelShellMesh) this.tunnelShellMesh.visible = visible
        break
      case 'bench':
        if (this.benchMesh) this.benchMesh.visible = visible
        break
      case 'face':
        if (this.faceMesh) this.faceMesh.visible = visible && !blastTriggered
        if (this.faceDamagedMesh) this.faceDamagedMesh.visible = visible && blastTriggered
        break
      case 'blastHoles':
        if (this.blastHolesGroup) {
          this.blastHolesGroup.visible = visible && !blastTriggered
        }
        break
      case 'annotations':
        if (this.annotationsGroup) this.annotationsGroup.visible = visible
        break
    }
  }

  // ─── 隧道断面参数更新 ────────────────────────────────
  /**
   * 更新隧道断面参数（由主渲染器 setTunnelSection 调用）
   * @param {Object} section - 断面参数
   */
  setTunnelSection(section) {
    const next = { ...this.tunnelSection, ...section }
    next.width = Math.max(2, Number(next.width) || this.tunnelSection.width)
    next.wallHeight = Math.max(1, Number(next.wallHeight) || this.tunnelSection.wallHeight)
    next.archRadius = Math.max(1, Number(next.archRadius) || this.tunnelSection.archRadius)
    const validShapes = ['horseshoe', 'circular', 'rectangular']
    if (!validShapes.includes(next.shape)) next.shape = 'horseshoe'
    this.tunnelSection = next
    this.tunnelWidth = next.width
    this.tunnelWallHeight = next.wallHeight
    this.tunnelArchRadius = next.archRadius
    this.tunnelHeight =
      next.shape === 'circular' ? next.archRadius * 2
        : next.shape === 'rectangular' ? next.wallHeight
          : next.wallHeight + next.archRadius
  }

  // ─── 清理场景网格 ────────────────────────────────────
  clear() {
    this._cleanupBenchGeometry()
    // 清理岩石纹理
    if (this.rockTexture) {
      this.rockTexture.dispose()
      this.rockTexture = null
    }
    this.fireLight.intensity = 0
  }

  // ─── 资源释放 ────────────────────────────────────────
  dispose() {
    this.clear()
  }
}
