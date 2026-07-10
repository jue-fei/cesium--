/**
 * 场景构建器
 *
 * 负责场景光照、隧道/掌子面/台阶网格、爆破钻孔、标注等场景元素的构建与管理。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'

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

    // 渐进破裂动画状态
    this.fracturing = false
    this.fractureStartTime = 0
    this.fractureDuration = 0

    this._setupLights()
  }

  // ─── 光照 ─────────────────────────────────────────────
  _setupLights() {
    // 环境光（大幅增强，暗部细节清晰可见）
    const ambient = new THREE.AmbientLight(0xb0b8c0, 2.5)
    this.scene.add(ambient)

    // 方向光（模拟太阳光）
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.2)
    this.sunLight.position.set(50, 80, 30)
    this.scene.add(this.sunLight)

    // 半球光（天空-地面）
    const hemiLight = new THREE.HemisphereLight(0xaaccff, 0x998866, 1.5)
    this.scene.add(hemiLight)

    // 隧道内部补光 #1（掌子面附近，模拟施工照明）
    this.tunnelLight = new THREE.PointLight(0xffeecc, 3.0, 180, 1.5)
    this.tunnelLight.position.set(0, 8, -10)
    this.scene.add(this.tunnelLight)

    // 隧道内部补光 #2（相机后方，向前照射掌子面+碎石）
    this.tunnelLight2 = new THREE.PointLight(0xfff4dd, 2.5, 180, 1.5)
    this.tunnelLight2.position.set(0, 6, -30)
    this.scene.add(this.tunnelLight2)

    // 爆心点光源（动态火光）
    this.fireLight = new THREE.PointLight(0xff6600, 0, 500, 2)
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
      const craterCY = totalH * 0.45
      // 中央破碎区约占断面 80-85%（扩大破碎范围，仅保留窄围岩圈）
      const craterW = W * 0.82
      const craterH = totalH * 0.80
      const craterPts = 24
      for (let i = 0; i < craterPts; i++) {
        const a = (i / craterPts) * Math.PI * 2
        const jag1 = Math.sin(i * 1.4 + 0.5) * 0.12
        const jag2 = Math.sin(i * 4.1 + 1.8) * 0.05
        const jag3 = Math.sin(i * 8.3 + 0.3) * 0.03
        const noise = (((i * 37 + i * i * 11) % 100) / 100 - 0.5) * 0.08
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
          const r = pr * (0.6 + Math.random() * 0.5)
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

  // ─── 清理旧场景网格 ──────────────────────────────────
  _cleanupBenchGeometry() {
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
    if (this.tunnelShellMesh) {
      this.scene.remove(this.tunnelShellMesh)
      this.tunnelShellMesh.geometry.dispose()
      this.tunnelShellMesh.material.dispose()
      this.tunnelShellMesh = null
    }
    if (this.craterMesh) {
      this.scene.remove(this.craterMesh)
      this.craterMesh.geometry.dispose()
      this.craterMesh.material.dispose()
      this.craterMesh = null
    }
    if (this.blastHolesGroup) {
      this.scene.remove(this.blastHolesGroup)
      this.blastHolesGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      })
      this.blastHolesGroup = null
    }
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

    this._buildBenchMesh({ W, Hw, R, totalH, benchMat, yaw, faceOffset, cx, cy, cz, dir })
    this._buildTunnelShell({ W, Hw, R, totalH, yaw, faceOffset, cx, cy, cz, dir })
    this._buildFaceMesh({ W, Hw, R, totalH, faceMat, yaw, faceOffset, cx, cy, cz, dir })
    this._buildFaceDamagedMesh({ W, Hw, R, totalH, faceMat, yaw, faceOffset, cx, cy, cz, dir })
    this._buildBlastHoles(yaw, faceOffset)
  }

  // ─── 岩体（马蹄形挤出，掌子面前方待爆岩体） ──────────
  _buildBenchMesh(ctx) {
    const benchDepth = this.benchLength
    const benchGeo = new THREE.ExtrudeGeometry(
      this._createTunnelShape(false, ctx.W, ctx.Hw, ctx.R, ctx.totalH),
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
      this._createTunnelShape(false, ctx.W, ctx.Hw, ctx.R, ctx.totalH),
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
      this._createTunnelShape(false, ctx.W, ctx.Hw, ctx.R, ctx.totalH),
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
    const craterDepth = Math.max(8, Math.min(ctx.totalH * 0.85, 16))
    const craterRadius = Math.min(ctx.W, ctx.totalH) * 0.65
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

  // ─── 爆破钻孔 ────────────────────────────────────────
  /**
   * 在掌子面上构建爆破钻孔布孔图案。
   * 若设置了 this.blastHoleDesign（数据库炮孔设计数据），则动态渲染；
   * 否则回退到硬编码典型布孔（中央菱形掏槽 + 2 圈辅助 + 周边孔）。
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
    const cy0 = totalH * 0.5 // 掌子面中心高度

    // ── 颜色编码（按 holeType）──
    // 掏槽孔：红 0xff6b6b，辅助孔：黄 0xfeca57，周边孔：绿 0x1dd1a1，空孔：白 0xffffff
    const TYPE_COLORS = {
      cut: 0xff6b6b,
      easing: 0xff6b6b,      // easing 等同 cut
      auxiliary: 0xfeca57,
      production: 0xfeca57,  // production 默认归入辅助
      perimeter: 0x1dd1a1
    }
    const EMPTY_COLOR = 0xffffff

    // 收集最终孔位
    const holes = []

    if (this.blastHoleDesign && this.blastHoleDesign.length > 0) {
      // ── 数据库模式：从 dataset.design.holes 动态生成 ──
      const defaultDepth = Number(this.designParams?.holeDepth) || 2.5
      const defaultDiameter = Number(this.designParams?.holeDiameter) || 0.04
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
    } else {
      // ── 回退模式：硬编码典型布孔 ──
      const cutR = 1.0
      const holeDepth = Number(this.designParams?.holeDepth) || 2.5
      const realDia = Number(this.designParams?.holeDiameter) || 0.04
      const visRadius = Math.max(0.08, realDia * 4)
      const emptyVisRadius = visRadius * 1.6
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
    }

    // ── 构建钻孔几何体（按类型分组共享材质/几何，性能优化）──
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
        const color = isEmpty ? EMPTY_COLOR : (TYPE_COLORS[type] ?? 0xfeca57)
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

      group.add(mesh)
    })

    // 整体定位到掌子面位置
    const cx = this.center.x
    const cy = this.center.y
    const cz = this.center.z
    const dir = this.faceDirection
    group.position.set(cx + dir.x * faceOffset, cz, cy + dir.z * faceOffset)
    group.rotation.y = yaw
    group.visible = true
    this.scene.add(group)
    this.blastHolesGroup = group

    // ── 保存炮孔布置数据（供 UI 绘制 2D 布置图与统计）──
    const cutHoles = holes.filter(h => h.type === 'cut')
    const perimHoles = holes.filter(h => h.type === 'perimeter')
    const auxHoles = holes.filter(h => h.type === 'auxiliary')
    this.blastHolePattern = {
      section: { W, Hw, R, totalH: totalH },
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

    // 构建专业标注（掘进深度、断面尺寸、孔型分区标签）
    this._buildAnnotations(yaw, faceOffset)
  }

  // ─── 专业爆破元素 3D 标注 ─────────────────────────────
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

    // 掘进深度标注（仅保留核心信息）
    const holeDepth = Number(this.designParams?.holeDepth) || 2.5
    const utilization = Number(this.designParams?.utilization) || 0.85
    const advanceDepth = Number(this.designParams?.advanceLength) || (holeDepth * utilization)
    const advanceLabel = this._createTextSprite(
      `掘进进尺: ${advanceDepth.toFixed(2)} m`,
      '#ffd166',
      18
    )
    advanceLabel.position.set(W * 0.5 + 1.0, totalH - 0.5, 0.1)
    group.add(advanceLabel)

    // 断面尺寸标注（仅保留核心信息）
    const sectionArea = W * Hw + (Math.PI * R * R) / 2
    const shapeLabel = this.tunnelSection?.shape || 'horseshoe'
    const shapeCN = shapeLabel === 'horseshoe' ? '马蹄形'
      : shapeLabel === 'circular' ? '圆形'
        : shapeLabel === 'rectangular' ? '矩形'
          : '拱形'
    const sizeLabel = this._createTextSprite(
      `断面: ${shapeCN} ${W}m×${totalH.toFixed(1)}m (A=${sectionArea.toFixed(1)}m²)`,
      '#4fc3f7',
      16
    )
    sizeLabel.position.set(-W * 0.5 - 1.0, totalH - 0.5, 0.1)
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
    const supersample = 6 // 6x 超采样保证文字高清锐利
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
    // 深色半透明背景（提高可读性）
    c2.fillStyle = 'rgba(0, 0, 0, 0.7)'
    c2.fillRect(0, 0, logicalW, logicalH)
    c2.strokeStyle = color
    c2.lineWidth = 2
    c2.strokeRect(1, 1, logicalW - 2, logicalH - 2)
    // 文字颜色降亮至 #d0d0d0 以下 Bloom 阈值(0.85)，避免白光过曝闪烁
    // 原 #ffffff(1.0) 被 Bloom 放大后过曝发糊，降至 #c8c8c8(0.78) 可保持清晰
    const dimColor = color === '#ffffff' ? '#c8c8c8' : color
    c2.fillStyle = dimColor
    c2.textBaseline = 'middle'
    c2.fillText(text, padding, logicalH / 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,   // 关闭深度测试：标注始终可见，不被碎片/隧道壁遮挡
      depthWrite: false
    })
    const sprite = new THREE.Sprite(material)
    // 缩放：使用逻辑尺寸（非超采样物理尺寸）映射到 3D 场景
    const scale = 0.035
    sprite.scale.set(logicalW * scale, logicalH * scale, 1)
    // 渲染顺序：确保 sprite 在透明物体之后渲染
    sprite.renderOrder = 999
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

  // ─── 渐进破裂动画（替代瞬时切换） ────────────────────
  /**
   * 触发掌子面渐进破裂：完整面碎裂塌落 + 损伤面/漏斗渐显
   * @param {number} duration - 破裂动画时长（秒），默认 0.5
   */
  triggerBlastProgressive(duration = 0.5) {
    this.fractureDuration = duration
    this.fracturing = true

    const faceVisible = this.layerVisibility.face !== false

    // 完整掌子面：开始碎裂渐隐
    if (this.faceMesh) {
      this.faceMesh.material.transparent = true
      this.faceMesh.material.opacity = 1.0
      this.faceMesh.material.needsUpdate = true
      // 保存初始位置，用于碎裂位移
      this._faceMeshInitPos = this.faceMesh.position.clone()
      // 掌子面法线方向（用于塌落位移）
      const fd = this.faceDirection || { x: 0, y: 0, z: 1 }
      this._faceNormalDir = { x: fd.x || 0, y: fd.y || 0, z: fd.z || 1 }
    }

    // 损伤掌子面：开始渐显
    if (this.faceDamagedMesh) {
      this.faceDamagedMesh.material.transparent = true
      this.faceDamagedMesh.material.opacity = 0.0
      this.faceDamagedMesh.material.needsUpdate = true
      this.faceDamagedMesh.visible = faceVisible
    }

    // 3D 漏斗：开始渐显
    if (this.craterMesh) {
      this.craterMesh.material.transparent = true
      this.craterMesh.material.opacity = 0.0
      this.craterMesh.material.needsUpdate = true
      this.craterMesh.visible = faceVisible
    }

    // 钻孔立即隐藏（已被引爆）
    if (this.blastHolesGroup) this.blastHolesGroup.visible = false
  }

  /**
   * 更新破裂动画进度（由渲染循环每帧调用）
   * 实现三阶段碎裂效果：振动 → 位移塌落 → 碎裂消失
   * @param {number} elapsed - 自爆破触发以来的时间（秒）
   */
  updateFracture(elapsed) {
    if (!this.fracturing) return

    const t = Math.min(1, Math.max(0, elapsed / this.fractureDuration))

    // 非线性曲线：前 30% 缓慢（振动蓄力），后 70% 快速碎裂
    const fractureT = t < 0.3 ? t * 0.3 : 0.09 + (t - 0.3) * 1.3
    const clampedT = Math.min(1, Math.max(0, fractureT))

    if (this.faceMesh) {
      // 透明度：非线性渐隐（碎裂感更强）
      this.faceMesh.material.opacity = Math.max(0, 1 - clampedT * 1.2)

      // 碎裂位移：向爆破方向（岩体内部）微小位移 + 高频振动
      if (this._faceMeshInitPos) {
        const dir = this._faceNormalDir || { x: 0, y: 0, z: 1 }
        // 位移：0→0.5m 向岩体内部塌落
        const collapse = clampedT * 0.5
        // 振动：高频抖动模拟碎裂震动，振幅随 t 衰减
        const vibrationAmp = (1 - clampedT) * 0.08
        const vibration = Math.sin(elapsed * 80) * vibrationAmp
        this.faceMesh.position.x = this._faceMeshInitPos.x + dir.x * collapse + vibration
        this.faceMesh.position.y = this._faceMeshInitPos.y + dir.y * collapse + vibration * 0.5
        this.faceMesh.position.z = this._faceMeshInitPos.z + dir.z * collapse
      }
    }
    if (this.faceDamagedMesh) {
      this.faceDamagedMesh.material.opacity = clampedT
    }
    if (this.craterMesh) {
      this.craterMesh.material.opacity = clampedT
    }

    // 破裂完成
    if (t >= 1) {
      if (this.faceMesh) {
        this.faceMesh.visible = false
        // 恢复初始位置
        if (this._faceMeshInitPos) {
          this.faceMesh.position.copy(this._faceMeshInitPos)
        }
      }
      this.fracturing = false
    }
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
        if (this.faceMesh) {
          if (this.fracturing) {
            // 渐进破裂中：保持当前可见性（由 updateFracture 控制 opacity）
            this.faceMesh.visible = visible
          } else {
            this.faceMesh.visible = visible && !blastTriggered
          }
        }
        if (this.faceDamagedMesh) {
          this.faceDamagedMesh.visible = visible && (blastTriggered || this.fracturing)
        }
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
