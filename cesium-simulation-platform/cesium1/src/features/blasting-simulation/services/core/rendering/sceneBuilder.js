/**
 * 场景构建器
 *
 * 负责场景光照、隧道/掌子面/台阶网格、爆破钻孔、标注等场景元素的构建与管理。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { creaseNormals, removeTrianglesOnPlane, weldPositions } from './geometrySmoothing.js'
// 剖面剖切 CSG 算法模块：剖切相关公共 API 的实现委托到 SectionCutter
import { SectionCutter } from './sectionCutter.js'
// 断面几何判定：与 tunnelDesign 布孔过滤共用同一实现（单源）
import { isInsideSection } from '../computation/sectionShape.js'
// mulberry32（漏斗形状可复现 RNG）：单源在 utils/rng.js
import { mulberry32 } from '../utils/rng.js'
// 色阶与归一化映射：与图例（面板）单源共享
import {
  sampleScaleColor,
  PPV_COLOR_STOPS_LINEAR,
  STRESS_COLOR_STOPS_LINEAR,
  PPV_LUT_MAX_CMPS,
  STRESS_LUT_MAX_MPA
} from './vibrationColorScales.js'
// 岩体表面振动场着色 shader（外置 .glsl 源码，?raw 原文导入）
import benchFieldVertSrc from './benchField.vert.glsl?raw'
import benchFieldFragSrc from './benchField.frag.glsl?raw'

// ─── 表面抛光总开关 ────────────────────────────────────
// 几何焊接 + 折痕法线平滑：消除热力图在"纸片拼接/接缝"处的断档（详见 geometrySmoothing.js）。
// 置 false 可整体回滚到旧 flat 法线拼接形态（便于 A/B 目检）。
const ENABLE_SURFACE_POLISH = true

/** 折痕平滑角：连续曲面（夹角<此值）合并平滑，锐棱保留 */
const POLISH_CREASE_DEG = 45

/** 岩体/掌子面统一岩色：消除共享轮廓两侧底色深浅台阶造成的"拼接线" */
const ROCK_TINT = 0xa2907d

// ─── 默认光照配置（可由 config.lighting 覆盖） ──────────
const DEFAULT_LIGHTING = {
  ambient: { color: 0xb0b8c0, intensity: 2.5 },
  sun: { color: 0xffffff, intensity: 2.2, position: [50, 80, 30] },
  hemisphere: { sky: 0xaaccff, ground: 0x998866, intensity: 1.5 },
  tunnelLight: {
    color: 0xffeecc,
    intensity: 3.0,
    distance: 180,
    decay: 1.5,
    position: [0, 8, -10]
  },
  tunnelLight2: {
    color: 0xfff4dd,
    intensity: 2.5,
    distance: 180,
    decay: 1.5,
    position: [0, 6, -30]
  },
  fireLight: { color: 0xff6600, intensity: 0, distance: 500, decay: 2 }
}

// ─── 爆破后掌子面破碎腔（掏槽+辅助孔区域）比例 ─────────
// 依据井下矿/隧道掌子面爆破实测文献（见文献调研）：
// 全断面爆破后掏槽孔+辅助孔将断面绝大部分破碎抛出，周边孔（轮廓孔）仅负责
// 轮廓控制，留下的超挖控制岩圈仅约 7~25cm（优化案例 7.6~8.1cm，传统 25±8cm），
// 围岩损伤带约 2.4m。因此中央破碎腔应覆盖断面约 97%，
// 四周只保留约 1.5% 宽的极薄光爆岩圈，呈现"整个掌子面整体掀开"的真实爆破形态。
// 注意：破碎腔孔洞必须与断面同形（缩小马蹄形）且整体位于断面内部，
// 否则 ExtrudeGeometry 在孔洞越出断面的边界交叉处会三角化出尖刺（掌子面畸形）。
const CRATER_SCALE = 0.97

// 爆破后开挖空腔内壁的漏斗收口比例：口部满幅(1)，沿进尺深度线性收敛到该比例，
// 使空腔由"等截面直柱"变为向内收口的漏斗形（无需额外漏斗模型，岩体本身水密）。
const CAVITY_TAPER = 0.75

// ─── 炮孔类型颜色编码 ──────────────────────────────────
const HOLE_TYPE_COLORS = {
  cut: 0xff6b6b,
  easing: 0xff6b6b, // easing 等同 cut
  auxiliary: 0xfeca57,
  production: 0xfeca57, // production 默认归入辅助
  perimeter: 0x1dd1a1
}
const EMPTY_HOLE_COLOR = 0xffffff

// ─── 岩体表面振动场着色（应力/损伤/PPV 直接渲染在岩体上）──────
// 不再使用 raymarching 体积盒子（避免掌子面前方"红色方块"），
// 改为在 benchMesh 的 ShaderMaterial 中逐片元按世界坐标采样 3D 场纹理着色的方式。
// 坐标换算：世界坐标 P → grid 局部 (gx,gy,gz) = ((P-center)·right, ·up, ·forward)
// DAMAGE 档位由后端/本地分类场写入 3D 纹理，shader 只负责离散取色，不再重复实现阈值算法。
// shader 源码外置为 .glsl（编辑器高亮/独立评审）。
const BENCH_FIELD_VERTEX_SHADER = benchFieldVertSrc
const BENCH_FIELD_FRAGMENT_SHADER = benchFieldFragSrc

/** 默认场着色参数（无数据时的占位） */
const BENCH_FIELD_DEFAULTS = {
  displayMode: 0,
  fieldWeight: 0.0,
  ppvRefMps: PPV_LUT_MAX_CMPS / 100,
  stressRefMPa: STRESS_LUT_MAX_MPA,
  thresholdMps: 0,
  stressVisiblePa: 0
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
    // 岩体总深（m）：>0 时 _buildRockBodyMesh 由它反解生效 benchLength（生产路径 20m）
    this.rockTotalDepth = Number(config.rockTotalDepth) > 0 ? Number(config.rockTotalDepth) : null
    this.tunnelSection = config.tunnelSection

    // 光照配置（支持外部覆盖，默认值经调校保证隧道内部可见度）
    this.lighting = { ...DEFAULT_LIGHTING, ...(config.lighting || {}) }
    // 漏斗形状随机种子（保证可复现，便于调试与回归测试）
    this._rng = mulberry32(config.craterSeed ?? 12345)
    // 表面抛光开关（构造层级默认开，外部可用 config.surfacePolish 关闭做 A/B）
    this.surfacePolish = ENABLE_SURFACE_POLISH && config.surfacePolish !== false
    // 剖面裁剪的"场景级请求"：剖切是直接改 benchMesh.geometry 的副作用，而爆破状态机
    // 会在起爆/回卷/seek 时把 geometry 换回 _rockGeoPre/_rockGeoPost。为让剖面不随拖动
    // 丢失，把"剖切请求"存这里，在 _setRockGeometry 换基时对同一平面重新剖切。
    this._sectionEnabled = false
    this._sectionAxis = 0
    this._sectionPos = null // 已解析的平面局部坐标（沿轴），换基后原样重切
    // 剖切结果缓存：键=基础几何对象（pre/post），值={axis,pos,geo}。
    // 播放时间轴在 pre/post 间互换几何时直接复用，避免每次对整块岩体重算 CSG 导致卡顿。
    this._sectionCache = new Map()
    // 剖面剖切 CSG 算法模块（sectionCutter.js）：剖切公共 API 薄委托到此处
    this._sectionCutter = new SectionCutter(this)

    // 设计数据（由主渲染器注入）
    this.blastHoleDesign = null
    this.designParams = null
    this.blastEffect = null
    this.blastHolePattern = null

    // 场景网格（由 SceneBuilder 创建和管理）
    this.benchMesh = null
    this.faceMesh = null
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

    // ── 岩面采样网格（动态满量程统计用，见 getSurfaceSampleGrid）──
    this._benchGeoVersion = 0 // 岩体几何版本（build / 爆后切换时 +1，驱动缓存失效）
    this._surfaceSampleCache = null // getSurfaceSampleGrid 版本缓存 { version, mesh, frameKey, data }

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
    const hemiLight = new THREE.HemisphereLight(
      L.hemisphere.sky,
      L.hemisphere.ground,
      L.hemisphere.intensity
    )
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
   * 构建马蹄形断面 Shape（直墙 + 半圆拱），可选中央爆破漏斗洞口。
   * 该中央洞口即"掏槽+辅助孔"破碎腔：向导坑底部运行时只有一个居中的深凹腔，
   * 四周保留一圈完整围岩（光面爆破轮廓），与真实浅埋/掏槽爆破一致。
   * @param {boolean} withCrater - 是否包含爆破漏斗洞口
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @param {number} totalH - 隧道总高
   * @returns {THREE.Shape}
   */
  _createTunnelShape(withCrater, W, Hw, R, totalH, craterPtsArr) {
    const shape = new THREE.Shape()
    shape.moveTo(-W / 2, 0)
    shape.lineTo(-W / 2, Hw)
    // 半圆拱：从左侧经顶部到右侧（顺时针扫过 π→0）
    shape.absarc(0, Hw, R, Math.PI, 0, true)
    shape.lineTo(W / 2, 0)
    shape.closePath()

    if (withCrater) {
      // 真实爆破掌子面：中央深破碎抛出 + 四周围岩圈残留（轮廓孔光面爆破痕迹）
      // 1) 中央破碎腔（掏槽+辅助孔区域，被抛掷成深凹腔）。
      //    与断面同形的缩小马蹄形，仅留约 1.5% 宽的极薄周边岩圈
      //    （对应文献中 7~25cm 超挖控制区），接近"整个掌子面整体掀开"的真实爆破形态。
      // 注意：craterPtsArr 必须由调用方传入（与 3D 漏斗共用同一组点），
      // 不能在此处再调 _computeCraterPoints —— RNG 有状态，重复调用会产生不同轮廓，
      // 导致掌子面孔洞与破碎腔开口错位（畸形）。
      const crater = new THREE.Path()
      const pts = craterPtsArr || this._computeCraterPoints(W, Hw, R)
      pts.forEach((p, i) => {
        if (i === 0) crater.moveTo(p.x, p.y)
        else crater.lineTo(p.x, p.y)
      })
      crater.closePath()
      shape.holes.push(crater)
    }
    return shape
  }

  // ─── 围岩加厚（掌子面前方待爆岩体的横断面外扩） ────────
  /**
   * 围岩厚度系数：7 × 巷道断面外廓最大半径。
   * 马蹄形取 max(半宽, 拱半径)；圆形同上（半宽=拱半径）；矩形取断面半对角线。
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @returns {number} 围岩加厚厚度 t（米）
   */
  _computeRockThickness(W, Hw, R) {
    const halfW = W / 2
    let rMax = Math.max(halfW, R)
    if (this.tunnelSection?.shape === 'rectangular') {
      rMax = Math.hypot(halfW, Hw / 2)
    }
    return Math.max(1, 7 * rMax)
  }

  /**
   * 由开挖轮廓各边向外扩 t 构建待爆岩体横断面：**矩形实体块**（立方体状）。
   * 底板下延至 -t、两侧墙外扩 t、拱顶向上加高总量 Hw+R 后再加 t；
   * 断面为完整矩形（x∈[-W/2-t, W/2+t]，y∈[-t, Hw+R+t]），巷道断面位于其中。
   * 待爆岩体即为一个矩形/立方体状的待开挖岩块，适合观察球形应力波在块内扩散。
   * @returns {THREE.Shape}
   */
  _buildInflatedRockShape(W, Hw, R, t) {
    const w2 = W / 2 + t
    const top = Hw + R + t
    const shape = new THREE.Shape()
    shape.moveTo(-w2, -t)
    shape.lineTo(w2, -t)
    shape.lineTo(w2, top)
    shape.lineTo(-w2, top)
    shape.closePath()
    return shape
  }

  /**
   * 围岩环横断面：外扩轮廓为外边界、开挖轮廓为内洞。
   * 用于爆破后待爆循环段：核心开挖空腔贯通、四周围岩环保留。
   * @returns {THREE.Shape}
   */
  _buildRockRingShape(W, Hw, R, t, tunnelShape) {
    const ring = this._buildInflatedRockShape(W, Hw, R, t)
    ring.holes.push(tunnelShape)
    return ring
  }

  /**
   * 计算掌子面中央破碎腔（掏槽+辅助孔区域）的轮廓点。
   * 破碎腔纵向居中、下缘贴底（水沟线），边缘带锯齿噪声，轮廓自然不规则。
   * 掌子面洞口（_createTunnelShape）与 3D 破碎腔漏斗（_buildFaceDamagedMesh）
   * 共用同一组轮廓点，保证开口与深腔严格贴合。
   * @param {number} W - 隧道宽度
   * @param {number} Hw - 直墙高度
   * @param {number} R - 拱部半径
   * @returns {Array<{x:number,y:number}>}
   */
  _computeCraterPoints(W, Hw, R) {
    // 与隧道断面同形的缩小马蹄形破碎腔轮廓。
    // 关键：孔洞必须整体位于断面内部（沿断面质心缩放），
    // 否则 ExtrudeGeometry 在孔洞越出断面的边界交叉处会三角化出尖刺（掌子面畸形）。
    const s = CRATER_SCALE
    const rectArea = W * Hw
    const archArea = (Math.PI * R * R) / 2
    const totalArea = rectArea + archArea
    const hcy = (rectArea * (Hw * 0.5) + archArea * (Hw + (4 * R) / (3 * Math.PI))) / totalArea
    const halfW = (W / 2) * s
    const rectBottom = hcy * (1 - s)
    const rectTop = Hw * s + hcy * (1 - s)
    const archR = R * s
    const archCY = rectTop

    // 边缘锯齿噪声（小幅度，保证不越出断面，周边岩圈始终存在）
    let accJag = 0
    for (let k = 0; k < 8; k++) accJag += this._rng()
    const baseJag = (accJag / 8 - 0.5) * 0.03
    const pts = []
    const wallN = 6
    const archN = 24
    // 左墙（自下而上）
    for (let i = 0; i <= wallN; i++) {
      const t = i / wallN
      const y = rectBottom + (rectTop - rectBottom) * t
      const nz = (this._rng() - 0.5) * 0.05 + baseJag
      pts.push({ x: -halfW + nz, y })
    }
    // 拱顶（左→右，经顶部）
    for (let i = 0; i <= archN; i++) {
      const a = Math.PI - (i / archN) * Math.PI
      const nz = (this._rng() - 0.5) * 0.05 + baseJag
      pts.push({
        x: Math.cos(a) * archR + nz,
        y: archCY + Math.sin(a) * archR
      })
    }
    // 右墙（自上而下）
    for (let i = 0; i <= wallN; i++) {
      const t = i / wallN
      const y = rectTop - (rectTop - rectBottom) * t
      const nz = (this._rng() - 0.5) * 0.05 + baseJag
      pts.push({ x: halfW + nz, y })
    }
    return pts
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
    // 岩面采样网格缓存：随岩体重建一并失效（重建后重新采样）
    this._surfaceSampleCache = null
    // 复位剖切状态与临时件（重建时旧切片/封口/拾取标记一并清理，避免状态残留）
    this._sectionEnabled = false
    this._sectionAxis = 0
    this._sectionPos = null
    if (this._sliceCutGeo) {
      if (this._sliceCutGeo.dispose) this._sliceCutGeo.dispose()
      this._sliceCutGeo = null
    }
    this._slicePristineGeo = null
    for (const c of this._sectionCache.values()) {
      if (c.geo && c.geo.dispose) c.geo.dispose()
    }
    this._sectionCache.clear()
    for (const key of ['_pickPointMarker', '_sectionMarkerGroup']) {
      const g = this[key]
      if (g) {
        if (g.parent) g.parent.remove(g)
        g.traverse(o => {
          if (o.geometry?.dispose) o.geometry.dispose()
          if (o.material?.dispose) o.material.dispose()
        })
        this[key] = null
      }
    }
    this._sectionFill = null
    this._sectionSphere = null
    this._lastCutAxis = null
    this._lastCutPos = null
    this._sectionBox = null
    this._sectionRegions = null
    this._sectionLastAxis = null

    const disposeSingle = mesh => {
      if (!mesh) return
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    disposeSingle(this.benchMesh)
    // 剖面封口片：随岩体一同释放，避免残留空心腔体
    disposeSingle(this._sectionCapMesh)
    this._sectionCapMesh = null
    // 岩体前后两套几何（整段实心/退切实心）独立释放，避免泄漏
    if (this._rockGeoPre) {
      this._rockGeoPre.dispose()
      this._rockGeoPre = null
    }
    if (this._rockGeoPost) {
      this._rockGeoPost.dispose()
      this._rockGeoPost = null
    }
    this.benchMesh = null
    disposeSingle(this.faceMesh)
    this.faceMesh = null
    // 场着色材质释放：bench 与 face 共用同一套占位纹理/ LUT，统一在此清理一次
    this._benchFieldMaterial = null
    this._faceFieldMaterial = null
    if (this._fieldDummyTexture) {
      this._fieldDummyTexture.dispose()
      this._fieldDummyTexture = null
    }
    if (this._fieldPpvLut) {
      this._fieldPpvLut.dispose()
      this._fieldPpvLut = null
    }
    if (this._fieldStressLut) {
      this._fieldStressLut.dispose()
      this._fieldStressLut = null
    }
    disposeSingle(this.tunnelShellMesh)
    this.tunnelShellMesh = null
    disposeSingle(this.craterMesh)
    this.craterMesh = null
    disposeSingle(this.excavatedTubeMesh)
    this.excavatedTubeMesh = null
    this._disposeGroup(this.blastHolesGroup)
    this.blastHolesGroup = null
    this._disposeGroup(this.annotationsGroup)
    this.annotationsGroup = null
  }

  // ─── 主构建入口 ───────────────────────────────────────
  /**
   * 构建隧道掌子面与岩体几何体。
   * 掌子面为马蹄形（直墙 + 半圆拱）垂直平面，垂直于地面、法线沿爆破方向。
   *
   * 采用"单循环进尺"模型以贴合真实爆破（起爆后岩体不消失，而是新挖出一段空腔）：
   * - benchMesh：待爆岩体（实心马蹄形挤出），前缘推进到 faceOffset+roundDepth——
   *   即爆破后新掌子面位置，始终存在，作为外层围岩/前方未开挖岩体
   * - frontPlugMesh：爆破前待爆的那一个循环（faceOffset → faceOffset+roundDepth 的实心段），
   *   爆破后隐藏（该循环岩体被抛掷），露出与之同体的开挖空腔
   * - excavatedTubeMesh：与 frontPlugMesh 同区间的"开挖空腔壁"（空心马蹄环），
   *   爆破后显示，呈现刚开挖出的一段岩壁空腔；爆破前隐藏
   * - faceMesh：完整掌子面（爆破前可见）
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
    // 单循环进尺 = 孔深 × 炮孔利用率（文献进尺，区别于孔深本身）：爆破后新掌子面向
    // 前推进该距离。切勿再写成"= 炮孔深度"——否则每次爆破视觉进尺被高估
    // （例如孔深 3.0 × 利用率 0.85 = 2.55m，而孔深 3.0 全进则与文献不符）。
    const roundDepth = Math.max(
      0.6,
      Number(this.designParams?.advanceLength) ||
      (Number(this.designParams?.holeDepth) || 2.5) *
      (Number(this.designParams?.utilization) || 0.85)
    )

    // 洞身截断几何（爆破振动场用）：空腔 = 自爆心沿洞轴向 roundDepth 长的马蹄柱，
    // 半径取半幅宽做圆柱近似，用于"爆心→片元"视线遮挡以打破纯径向同心球。
    this._holeGeom = {
      radius: Math.max(0.5, W / 2),
      len: Math.max(0.3, roundDepth),
      // 横向(垂直于隧道轴向)衰减系数：旧值 0.55 会把洞顶/洞底等横向围岩应力压得过低，
      // 截面上只剩沿轴向的高应力带、呈"漏斗形"。抬高到 0.95 后上/下围岩与前向几乎等强，
      // "上下应力较高"真实呈现，仅保留极轻微轴向主向(避免退化回纯同心球)。
      lateralAttn: 0.95
    }

    // 缓存无漏斗断面 Shape（bench/shell/face 共用，避免重复构建 3 次）
    const tunnelShape = this._createTunnelShape(false, W, Hw, R, totalH)
    // 围岩加厚：掌子面前方待爆岩体横断面在开挖轮廓基础上向外扩 7×巷道最大半径
    // （开挖轮廓/爆破腔/隧道壳保持原断面不变，只加厚未开挖岩体的外廓）
    const rockThickness = this._computeRockThickness(W, Hw, R)
    const rockShape = this._buildInflatedRockShape(W, Hw, R, rockThickness)
    const ctx = {
      W,
      Hw,
      R,
      totalH,
      yaw,
      faceOffset,
      roundDepth,
      cx,
      cy,
      cz,
      dir,
      tunnelShape,
      rockShape,
      rockThickness
    }

    // 材质
    const benchMat = new THREE.MeshStandardMaterial({
      color: ROCK_TINT,
      map: this.rockTexture,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide
    })
    const faceMat = new THREE.MeshStandardMaterial({
      color: ROCK_TINT,
      map: this.rockTexture,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide
    })

    // 掌子面前方未开挖岩体 = 单一连续实心体（待爆段与后方岩体合并为一个整体），
    // 爆破后仅整体退到新掌子面（切出需爆破的空腔段），无缝拼接。
    this._buildRockBodyMesh({ ...ctx, benchMat })
    // 掌子面后方的已开挖段：由半透明空心隧道壳（tunnelShellMesh）表示，
    // 开口端对齐掌子面（faceOffset），无前端实体 cap，确保掌子面/岩体不被遮挡。
    this._buildTunnelShell(ctx)
    this._buildFaceMesh({ ...ctx, faceMat })
    // 依赖 _buildFaceMesh 生成的 _faceFieldMaterial/faceMesh.position：
    // 创建爆破后的损伤掌子面（含洞口）+ 3D 掏槽漏斗（craterMesh）
    this._buildFaceDamagedMesh(ctx)
    this._buildExcavatedTube(ctx)
    this._buildBlastHoles(yaw, faceOffset)
    // 岩体几何就绪：版本 +1 驱动采样网格缓存失效（清掉旧缓存）
    this._surfaceSampleCache = null
    this._benchGeoVersion++
  }

  // ─── 开挖空腔壁（爆破后待爆循环变成的一段岩壁空腔） ──
  /**
   * 开挖空腔的岩壁（空心马蹄环侧壁），覆盖 faceOffset → faceOffset+roundDepth。
   * 与 frontPlugMesh 同区间、不同状态：
   * - 爆破前：hidden（该区间是实心 frontPlugMesh 填充）
   * - 爆破后：visible（frontPlugMesh 隐藏后，此半透明环提示刚开挖的一段空腔范围）
   * 复用 _buildOpenTubeGeometry（与已开挖段隧道内壁同构，几何稳定可靠）。
   */
  _buildExcavatedTube(ctx) {
    const { roundDepth } = ctx
    const tubeGeo = this._buildOpenTubeGeometry(ctx.tunnelShape, roundDepth, 96)
    // 开挖空腔壁与已开挖段隧道内壁保持一致：半透明（不写深度、不遮挡后方岩体），
    // 恢复"已开挖部分透明"的观感——新爆出的这段空腔不再是实心环壁，
    // 从隧道内部隔空仍能透视到其后方的实体岩体/新掌子面。
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x9c7c58,
      map: this.rockTexture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0.05
    })
    this.excavatedTubeMesh = new THREE.Mesh(tubeGeo, tubeMat)
    // 开口管近端(local z=0)对齐新掌子面(faceOffset+roundDepth)，向 -forward 覆盖一个循环
    this.excavatedTubeMesh.position.set(
      ctx.cx + ctx.dir.x * (ctx.faceOffset + roundDepth),
      ctx.cz,
      ctx.cy + ctx.dir.z * (ctx.faceOffset + roundDepth)
    )
    this.excavatedTubeMesh.rotation.y = ctx.yaw
    this.excavatedTubeMesh.castShadow = true
    this.excavatedTubeMesh.receiveShadow = true
    this.excavatedTubeMesh.visible = false
    this.scene.add(this.excavatedTubeMesh)
  }

  // ─── 掌子面前方未开挖岩体（单一连续实心体） ──────────
  /**
   * 待爆段（faceOffset → faceOffset+roundDepth）与后方岩体（更远）合并为
   * **一个连续的实心马蹄形体** rockBody，不再拆分成 frontPlug/bench 两个 mesh。
   * - 爆破前：整体实心（_rockGeoPre），与掌子面（faceMesh）共面封端；
   * - 爆破后：整体退到新掌子面（_rockGeoPost = 切掉待爆段的连续实心）。
   *   待爆段空腔壁由 excavatedTubeMesh、漏斗 craterMesh、破损掌子面
   *   faceDamagedMesh 覆盖，三者的接触环在 faceOffset+roundDepth 处与
   *   rockBody 新掌子面严格共面，实现无缝拼接（不再有 frontPlug/bench 缝合面）。
   * @param {Object} ctx - 构建上下文（含 tunnelShape/faceOffset/roundDepth/...）
   */
  _taperRockCavity(ringGeo, p) {
    const pos = ringGeo.attributes.position.array
    const { roundDepth, W, Hw, R, centerX, centerY, taper } = p
    const half = W / 2
    const eps = 0.06
    const atTunnelWall = (x, y) => {
      const wallX = Math.abs(Math.abs(x) - half) < eps && y >= -eps && y <= Hw + eps
      const floor = Math.abs(y) < eps && x >= -half - eps && x <= half + eps
      let arch = false
      if (y >= Hw - eps && y <= Hw + R + eps) {
        const dy = y - Hw
        arch = x >= -R - eps && x <= R + eps && Math.abs(Math.hypot(x, dy) - R) < eps
      }
      return wallX || floor || arch
    }
    for (let i = 0; i < pos.length; i += 3) {
      const z = pos[i + 2]
      if (z <= 1e-6) continue
      const x = pos[i]
      const y = pos[i + 1]
      if (!atTunnelWall(x, y)) continue
      const t = Math.min(z, roundDepth) / roundDepth
      const f = 1 - (1 - taper) * t
      pos[i] = centerX + (x - centerX) * f
      pos[i + 1] = centerY + (y - centerY) * f
    }
    if (ringGeo.attributes.position) ringGeo.attributes.position.needsUpdate = true
  }

  _scaleGeometryXY(geo, centerX, centerY, s) {
    const pos = geo.attributes.position.array
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = centerX + (pos[i] - centerX) * s
      pos[i + 1] = centerY + (pos[i + 1] - centerY) * s
    }
    if (geo.attributes.position) geo.attributes.position.needsUpdate = true
  }

  _buildRockBodyMesh(ctx) {
    const roundDepth = ctx.roundDepth
    // 【岩体总深】优先用配置的 rockTotalDepth（生产路径传 20m：原 80m 远场无有效观感，
    // 且顶点数成倍增加拖慢岩面瞬时场采样）；未配置时按 进尺+benchLength 的原口径
    // （几何测试用 benchLength=40 断言深度，须保持可控）。
    // 生效 benchLength 由目标总深反解，保证爆后实心段 [roundDepth, D] 与总深一致。
    let benchLength = this.benchLength
    const totalDepth = Number(this.rockTotalDepth)
    if (Number.isFinite(totalDepth) && totalDepth > roundDepth + 1) {
      benchLength = Math.max(1, totalDepth - roundDepth)
    }
    this.benchLength = benchLength
    const D = roundDepth + benchLength
    this._rockRoundDepth = roundDepth

    const extrudeOpts = { bevelEnabled: false, steps: 48, curveSegments: 64 }

    // 爆破前几何：整段连续实心 [0, D]，横断面 = 开挖轮廓 + 围岩加厚外扩
    // （steps/curveSegments 加密保证场色带平滑）
    this._rockGeoPre = new THREE.ExtrudeGeometry(ctx.rockShape || ctx.tunnelShape, {
      ...extrudeOpts,
      depth: D
    })

    // 爆破后几何：仅保留新掌子面 (roundDepth) 之后的连续实心；
    // 待爆循环段 [0, roundDepth] 的核心开挖空腔贯通、四周围岩环保留，
    // 与实心段无缝合并为一个几何体（避免周围岩体在爆破段出现空洞缺失）。
    // 该实心段前缘即为**进尺爆破后的新掌子面**（实体岩面），与正常进尺一致——
    // 不能把空腔那侧做通成纯环，否则尽头没有掌子面、看起来不像正常进尺。
    if (ctx.rockShape && ctx.tunnelShape) {
      const ringShape = this._buildRockRingShape(
        ctx.W,
        ctx.Hw,
        ctx.R,
        ctx.rockThickness,
        ctx.tunnelShape
      )
      // 待爆循环段 [0, roundDepth] 周围岩体 = 环形挡圈（washer，外轮廓带隧道孔洞）。
      // 保留前端盖（z=0 岩面 / 隧道口围岩环）；剔除 z=roundDepth 后端盖。
      // 【根因修正】该"环形截面"是后方实心岩体的**内部交界面**（围岩环区域材料
      // 两侧都是岩体），旧实现在那里摊了一张横跨整个断面的"新掌子面平盘"（环形
      // 薄盘+中心薄盘），把实体岩内部分出非流形立缝面 → 剖切/热力图成缝成洞。
      // 正确拓扑下该处只保留"空腔底"（隧道轮廓中心盘，见下），围岩环区域不建面。
      let ringWall = new THREE.ExtrudeGeometry(ringShape, {
        ...extrudeOpts,
        depth: roundDepth
      })
      // 【漏斗化】把开挖空腔内壁由"等截面圆柱"改为随进尺深度向内收口的漏斗：
      // 内壁顶点在 z∈(0, roundDepth] 内沿腔心线性缩放 (1 → CAVITY_TAPER)，外壁不变。
      // 端面中心盘按同一比例同步收口（见下），保证腔口满、腔尖收口到掌子面，
      // 且仅内壁 XY 等比缩放，绕序/邻接不变 → 天然保持水密。无需额外漏斗模型。
      {
        const rectArea = ctx.W * ctx.Hw
        const archArea = (Math.PI * ctx.R * ctx.R) / 2
        const totalArea = rectArea + archArea
        const cavityCenterY =
          (rectArea * (ctx.Hw * 0.5) + archArea * (ctx.Hw + (4 * ctx.R) / (3 * Math.PI))) /
          totalArea
        this._taperRockCavity(ringWall, {
          roundDepth,
          W: ctx.W,
          Hw: ctx.Hw,
          R: ctx.R,
          centerX: 0,
          centerY: cavityCenterY,
          taper: CAVITY_TAPER
        })
      }
      ringWall = removeTrianglesOnPlane(ringWall, 2, roundDepth, 1)
      ringWall = removeTrianglesOnPlane(ringWall, 2, roundDepth, -1)

      // 后方岩体 = 实心 rockShape 段 [roundDepth, D]；剔除朝腔面的前端盖，
      // 其露出的整个截面由两块薄盘补齐（见下）。
      let coreSolid = new THREE.ExtrudeGeometry(ctx.rockShape, {
        ...extrudeOpts,
        depth: benchLength
      })
      coreSolid = removeTrianglesOnPlane(coreSolid, 2, 0, 1)
      coreSolid = removeTrianglesOnPlane(coreSolid, 2, 0, -1)
      coreSolid.translate(0, 0, roundDepth)

      // 空腔底（= 进尺爆破后的新掌子面中央）= 恰好一张隧道轮廓中心盘（tunnelShape）。
      // 法线统一朝 -z（面向空腔/隧道口）。它封住环形挡圈内壁末端（隧道轮廓），
      // 并盖在后方实心岩体的矩形开口中央（该处才是真正的岩体-空腔分界面）。
      // 只此一张盘，围岩环区域不建盘——那里是实心界面（后方 coreSolid 已提供材料）。
      // ShapeGeometry 默认 CCW(法线+z)，反转三角形绕序成 CW → 法线 +z 变 -z，
      // 从空腔侧可见（creaseNormals 会沿此绕序重算法线，故必须在此阶段就倒好绕序）。
      const makeFacePlate = shape => {
        const disc = new THREE.ShapeGeometry(shape, 64)
        const di = disc.index
        if (di) {
          const da = di.array
          for (let i = 0; i < da.length; i += 3) {
            const t = da[i + 1]
            da[i + 1] = da[i + 2]
            da[i + 2] = t
          }
          di.needsUpdate = true
        } else {
          const pp = disc.attributes.position.array
          const pn = disc.attributes.normal
          const na = pn ? pn.array : null
          const pu = disc.attributes.uv
          const ua = pu ? pu.array : null
          for (let i = 0; i < pp.length / 3; i += 3) {
            for (let k = 0; k < 3; k++) {
              const t = pp[(i + 1) * 3 + k]
              pp[(i + 1) * 3 + k] = pp[(i + 2) * 3 + k]
              pp[(i + 2) * 3 + k] = t
              if (na) {
                const tn = na[(i + 1) * 3 + k]
                na[(i + 1) * 3 + k] = na[(i + 2) * 3 + k]
                na[(i + 2) * 3 + k] = tn
              }
              if (ua) {
                const tu = ua[(i + 1) * 2 + k]
                ua[(i + 1) * 2 + k] = ua[(i + 2) * 2 + k]
                ua[(i + 2) * 2 + k] = tu
              }
            }
          }
        }
        disc.translate(0, 0, roundDepth)
        return disc
      }
      const centerDisc = makeFacePlate(ctx.tunnelShape)
      // 端面收口：中心盘与漏斗内壁尖部按同一比例同步缩小，密封腔尖（水密桥接）。
      {
        const rectArea = ctx.W * ctx.Hw
        const archArea = (Math.PI * ctx.R * ctx.R) / 2
        const totalArea = rectArea + archArea
        const cavityCenterY =
          (rectArea * (ctx.Hw * 0.5) + archArea * (ctx.Hw + (4 * ctx.R) / (3 * Math.PI))) /
          totalArea
        this._scaleGeometryXY(centerDisc, 0, cavityCenterY, CAVITY_TAPER)
      }

      // mergeGeometries 要求各片 indexed 状态统一且均带 normal：
      // removeTrianglesOnPlane 输出 indexed 且缺 normal；ShapeGeometry 输出带索引的
      // 多片（groups）几何。这里统一“非索引化 + 补法线”，确保可合并且水密。
      const normalizePiece = geo => {
        if (geo.index) {
          const ni = geo.toNonIndexed()
          geo.dispose()
          geo = ni
        }
        if (!geo.attributes.normal) geo.computeVertexNormals()
        return geo
      }
      ringWall = normalizePiece(ringWall)
      coreSolid = normalizePiece(coreSolid)
      const center = normalizePiece(centerDisc)
      const merged = mergeGeometries([ringWall, coreSolid, center])
      this._rockGeoPost = merged || coreSolid
      // 兜底：把空腔底平面（z=roundDepth）上朝内(+z)的三角统一翻转为朝 -z。
      // ShapeGeometry 反转绕序已在各片内部是 -z，此步骤做最终强制约简，
      // 保证从空腔/隧道口侧看去空腔底（新掌子面）无背向三角。
      this._forcePlaneOrientation(this._rockGeoPost, 2, roundDepth, -1)
      // mergeGeometries 只做顶点拼接、不会把位置重合的顶点合并为同一份。若不做焊接，
      // 环形挡墙内壁末端与空腔底中心盘、以及挡墙外壁与实心段外壁相接处会残留
      // "位置相同但索引不同"的重复边界 → 剖切时截面边界非流形，封口环碎裂、
      // 剖切截面露大洞。这里把整个合并体按空间位置焊回单一顶点，使剖切边界呈
      // 流形、封口完整密闭。
      this._rockGeoPost = weldPositions(this._rockGeoPost, 1e-4)
      ringWall.dispose()
      center.dispose()
      if (merged) coreSolid.dispose()
    } else {
      // 回退（无围岩外扩）：与旧行为一致，退切后的整段实心
      this._rockGeoPost = new THREE.ExtrudeGeometry(ctx.tunnelShape, {
        ...extrudeOpts,
        depth: benchLength
      })
      this._rockGeoPost.translate(0, 0, roundDepth)
    }

    // 表面抛光：对 pre/post 各做折痕法线平滑（内部按位置归并重复顶点、平滑区共享顶点
    // 取面积加权法线、硬棱保留，见 geometrySmoothing.js）。产物覆盖回引用，保证
    // _setRockGeometry / _restoreSectionGeometry 对象引用互换语义。
    // 注意：**不得**对 post 做 removeTrianglesOnPlane(+z 内部盖面) —— 该剔除会把
    // z=roundDepth 内壁开口 131 条边，破坏水密，剖切切到即成大缺口（creaseNormals
    // 本身保持水密，见 _probe：raw0 / crease0 / rm131）。内部 +z/-z 共面盖面虽在，
    // 但 crease 已把它们按法线分组、且对内不可见，不再做额外剔除。
    if (this.surfacePolish) {
      const preRaw = this._rockGeoPre
      const postRaw = this._rockGeoPost
      this._rockGeoPre = creaseNormals(preRaw, POLISH_CREASE_DEG)
      this._rockGeoPost = creaseNormals(postRaw, POLISH_CREASE_DEG)
      preRaw.dispose()
      postRaw.dispose()
    }

    // 与 faceMesh 共用同一套场 LUT/纹理，保证岩体表面应力/PPV/损伤色带连续。
    // 未爆破的岩体为**完全不透明**实体：应力/PPV/损伤场直接着色在其表面。
    // 【不透明】transparent:false → 走不透明渲染通道（深度写入 + 深度测试），
    // 侧面/顶面/背面都不会透出内部几何。原 transparent:true 配合 DoubleSide
    // 会因片元混合与排序问题让非正面的岩面看起来"半透明"。
    this._benchFieldMaterial = this._createFieldMaterial(ctx.benchMat, {
      opacity: 1,
      transparent: false,
      depthWrite: true
    })
    this.benchMesh = new THREE.Mesh(this._rockGeoPre, this._benchFieldMaterial)
    // 岩体前缘 = 掌子面（faceOffset），向 +forward 深入；爆破后整体退到新掌子面。
    // 几何底为局部 z=0（掌子面端）、向 +z 挤出 D，故网格原点即置于 faceOffset，
    // 使岩体世界覆盖 [faceOffset, faceOffset+D]，与隧道壳/掌子面严格相接。
    this.benchMesh.position.set(
      ctx.cx + ctx.dir.x * ctx.faceOffset,
      ctx.cz,
      ctx.cy + ctx.dir.z * ctx.faceOffset
    )
    this.benchMesh.rotation.y = ctx.yaw
    this.benchMesh.castShadow = true
    this.benchMesh.receiveShadow = true
    this.scene.add(this.benchMesh)
    // 岩体轮廓线（边缘高亮）：暗背景/热力图满铺时仍能看清岩体轮廓
    // 岩体为大块实体，外框线用较低透明度（细淡），避免"红色方体框"式突兀
    this._attachRockOutline(this.benchMesh, 0.9)
  }

  /**
   * 导出岩面采样网格（grid 局部系）：blastingManager 据此计算全岩体场边界与岩面采样。
   *
   * 换算：世界坐标 → grid 局部，用 (right,up,forward) 正交基投影（与片元着色器同口径）。
   * 调用方可传入权威坐标系：首个场帧到达前，shader uniforms 仍是占位默认值，不能用于
   * 计算 WebSocket 场边界，否则例如默认 faceDirection=-Z 时 forward 会反号，场 bounds
   * 与后续 shader 采样坐标相反，造成岩面大面积/全部落在 insideFieldBounds 之外。
   * 法线同样按 basis 转世界（grid 基含 (0,0,-1)，直接当世界法线会反号）。
   *
   * 【自适应细分（关键）】CSG 合并/焊接后的岩体几何顶点极稀疏——实测整块岩体只有
   * 约 400 个顶点且几乎全落在箱体角点，直接在这些顶点上采场值无法代表连续岩面的
   * 场值分布。故按最长边二分细分每个三角形（位置/法线线性插值，二分保持形状），
   * 把采样间隔加密到 ≈MAX_EDGE，使满量程统计能贴合真实场分布。
   * 版本号驱动缓存：几何/爆后状态变化时重新采样。
   * @returns {{positions:Float32Array, normals:Float32Array|null, index:Uint32Array|null,
   *            version:number}|null}
   */
  getSurfaceSampleGrid(frame = null) {
    const mesh = this.benchMesh
    const u = this._benchFieldMaterial?.uniforms
    if (!mesh?.geometry || !u?.uCenter) return null
    // bounds 可能在 PPV 首帧之前计算，此时 shader uniforms 还是占位默认值。
    // 有权威坐标系时必须优先用它，保证 bounds 与随后注入 shader 的真实基向量一致。
    const c = frame?.center ?? u.uCenter.value
    const right = frame?.right ?? u.uRight.value
    const up = frame?.up ?? u.uUp.value
    const forward = frame?.forward ?? u.uForward.value
    const frameKey = [c, right, up, forward]
      .map(v => [v.x, v.y, v.z].map(n => Number(n).toPrecision(12)).join(','))
      .join('|')
    const cache = this._surfaceSampleCache
    if (
      cache &&
      cache.version === this._benchGeoVersion &&
      cache.mesh === mesh &&
      cache.frameKey === frameKey
    )
      return cache.data
    mesh.updateWorldMatrix(true, false)
    const src = mesh.geometry.attributes.position
    const nrmAttr = mesh.geometry.attributes.normal
    const idxAttr = mesh.geometry.index
    const v = new THREE.Vector3()
    // 源顶点 → grid 局部（位置）+ 世界法线
    const nvCount = src.count
    const gp = new Float32Array(nvCount * 3)
    const gn = nrmAttr ? new Float32Array(nvCount * 3) : null
    for (let i = 0; i < nvCount; i++) {
      v.set(src.getX(i), src.getY(i), src.getZ(i)).applyMatrix4(mesh.matrixWorld)
      const rx = v.x - c.x
      const ry = v.y - c.y
      const rz = v.z - c.z
      gp[i * 3] = rx * right.x + ry * right.y + rz * right.z
      gp[i * 3 + 1] = rx * up.x + ry * up.y + rz * up.z
      gp[i * 3 + 2] = rx * forward.x + ry * forward.y + rz * forward.z
      if (gn && nrmAttr) {
        const nx = nrmAttr.getX(i)
        const ny = nrmAttr.getY(i)
        const nz = nrmAttr.getZ(i)
        gn[i * 3] = nx * right.x + ny * up.x + nz * forward.x
        gn[i * 3 + 1] = nx * right.y + ny * up.y + nz * forward.y
        gn[i * 3 + 2] = nx * right.z + ny * up.z + nz * forward.z
      }
    }
    // ─── 最长边二分细分 ───
    const MAX_EDGE = 3.0 // 采样间隔上限(m)：越密统计越贴合场分布，但逐帧代价越高
    const MAX_POINTS = 20000 // 采样点上限（逐帧瞬时场计算 O(N·S)，需封顶）
    const maxEdgeSq = MAX_EDGE * MAX_EDGE
    const pos = []
    const nor = gn ? [] : null
    const ind = []
    const triCount = idxAttr ? Math.floor(idxAttr.array.length / 3) : Math.floor(nvCount / 3)
    const iA = idxAttr ? idxAttr.array : null
    const getV = i => [
      gp[i * 3],
      gp[i * 3 + 1],
      gp[i * 3 + 2],
      gn ? gn[i * 3] : 0,
      gn ? gn[i * 3 + 1] : 0,
      gn ? gn[i * 3 + 2] : 0
    ]
    const d2 = (a, b) => {
      const dx = a[0] - b[0]
      const dy = a[1] - b[1]
      const dz = a[2] - b[2]
      return dx * dx + dy * dy + dz * dz
    }
    const mid = (a, b) => {
      const m = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5, 0, 0, 0]
      if (gn) {
        let nx = a[3] + b[3]
        let ny = a[4] + b[4]
        let nz = a[5] + b[5]
        const len = Math.hypot(nx, ny, nz) || 1
        nx /= len
        ny /= len
        nz /= len
        m[3] = nx
        m[4] = ny
        m[5] = nz
      }
      return m
    }
    const emit = (a, b, c2) => {
      const base = pos.length / 3
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c2[0], c2[1], c2[2])
      if (nor) nor.push(a[3], a[4], a[5], b[3], b[4], b[5], c2[3], c2[4], c2[5])
      ind.push(base, base + 1, base + 2)
    }
    const subdivide = (a, b, c2, depth) => {
      const ab = d2(a, b)
      const bc = d2(b, c2)
      const ca = d2(c2, a)
      const maxd = Math.max(ab, bc, ca)
      if (maxd <= maxEdgeSq || depth >= 6 || pos.length / 3 + 3 > MAX_POINTS) {
        emit(a, b, c2)
        return
      }
      if (maxd === ab) {
        const m = mid(a, b)
        subdivide(a, m, c2, depth + 1)
        subdivide(m, b, c2, depth + 1)
      } else if (maxd === bc) {
        const m = mid(b, c2)
        subdivide(b, m, a, depth + 1)
        subdivide(m, c2, a, depth + 1)
      } else {
        const m = mid(c2, a)
        subdivide(c2, m, b, depth + 1)
        subdivide(m, a, b, depth + 1)
      }
    }
    for (let t = 0; t < triCount && pos.length / 3 < MAX_POINTS; t++) {
      const i0 = iA ? iA[t * 3] : t * 3
      const i1 = iA ? iA[t * 3 + 1] : t * 3 + 1
      const i2 = iA ? iA[t * 3 + 2] : t * 3 + 2
      subdivide(getV(i0), getV(i1), getV(i2), 0)
    }
    const positions = new Float32Array(pos)
    const normals = nor ? new Float32Array(nor) : null
    const index = new Uint32Array(ind)
    const data = { positions, normals, index, version: this._benchGeoVersion }
    this._surfaceSampleCache = { version: this._benchGeoVersion, mesh, frameKey, data }
    return data
  }

  /**
   * 切换掌子面前方岩体的几何形态（爆破前=整段实心；爆破后=退到新掌子面）。
   * 复用预构建的 _rockGeoPre/_rockGeoPost，不做重复三角化，保证与漏斗/空腔壁
   * 接触面严格共面。
   * @param {boolean} triggered - true=已爆破（使用退切后的实心体）
   */
  _setRockGeometry(triggered) {
    const mesh = this.benchMesh
    if (!mesh) return
    const next = triggered ? this._rockGeoPost : this._rockGeoPre
    if (!next) return
    // 剖面处于激活态时：换到新的基础几何后对同一平面重新剖切（命中缓存则复用，
    // 避免播放时间轴起爆/回卷/seek 反复整块 CSG 重算导致的卡顿）。
    if (this._sectionEnabled && this._sectionPos != null && mesh.geometry !== next) {
      this._sectionCutter._cutBaseGeometry(next)
      // 同步切面轮廓标记（pre/post 截面轮廓不同，需按当前基础几何刷新）
      if (this._sectionMarkerGroup) this._sectionCutter._updateSectionMarker(this._sectionAxis)
      this._attachRockOutline(mesh, 0.9, 91)
      this._benchGeoVersion++ // pre/post 几何互换 → 采样网格缓存需失效
      return
    }
    if (mesh.geometry !== next) {
      mesh.geometry = next
      // 几何切换后同步轮廓线（pre/post 外廓不同，避免显示陈旧的外形轮廓）
      this._attachRockOutline(mesh)
      this._benchGeoVersion++ // pre/post 几何互换 → 采样网格缓存需失效
    }
  }

  /**
   * 在网格外轮廓上贴一圈高亮轮廓线（EdgesGeometry + LineSegments），
   * 使岩体在暗背景巷道或振动场热力图满铺时仍能看出清晰轮廓。
   * 轮廓线作为网格子节点，随父网格隐藏/显隐；几何替换时调用本方法重建。
   * @param {THREE.Mesh} mesh - 目标网格（岩体 / 掌子面）
   * @param {number} [opacity=0.9] - 轮廓线透明度（岩体大块实体用低值细淡，掌子面断面用高值清晰）
   */
  /**
   * 过滤掉长度小于「源几何包围盒对角线 3%」的轮廓线段。
   *
   * 岩体外轮廓棱边都是十米级；几何合并/焊接后在平面处留下的内部折痕普遍只有
   * 亚米~米级。不滤掉的话，爆后岩体正面会被 700 多条短折边铺满（实测 750 段总数
   * 中 736 段 <2m、141 段落在正面平面上），观感就是"岩面上有一片短横线/斜纹"。
   * 用相对阈值而非固定值：掌子面等小几何（对角线约 23m）的断面轮廓仍能保留。
   * @param {THREE.BufferGeometry} edges - EdgesGeometry 产物（position 属性，每 2 点一段）
   * @param {THREE.BufferGeometry} sourceGeo - 源几何（用于取包围盒尺度）
   */
  _filterShortEdges(edges, sourceGeo) {
    const p = edges.attributes?.position?.array
    if (!p || !p.length) return edges
    sourceGeo.computeBoundingBox()
    const bb = sourceGeo.boundingBox
    if (!bb) return edges
    const minLen = bb.max.distanceTo(bb.min) * 0.03
    if (!(minLen > 0)) return edges
    const keep = []
    for (let i = 0; i < p.length; i += 6) {
      const len = Math.hypot(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2])
      if (len >= minLen) keep.push(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5])
    }
    if (keep.length === p.length) return edges
    const out = new THREE.BufferGeometry()
    out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3))
    edges.dispose()
    return out
  }

  _attachRockOutline(mesh, opacity = 0.9, angleDeg = 20) {
    if (!mesh || !mesh.geometry) return
    // 清除已挂载的旧轮廓（LineSegments：仅几何 + 材质，内联释放）
    if (mesh.userData?.__outlineLine) {
      const old = mesh.userData.__outlineLine
      mesh.remove(old)
      if (old.geometry) old.geometry.dispose()
      if (old.material) old.material.dispose()
      mesh.userData.__outlineLine = null
    }
    // 阈值角：只保留二面角大于 angleDeg 的锐利折边/外轮廓，不显示平面内部的细分边。
    // 剖切后抬到 >90° 可滤掉断面与侧壁的直角折边，避免切面边缘多出一圈冷白线。
    let edges = new THREE.EdgesGeometry(mesh.geometry, angleDeg)
    // 【短边过滤】爆后岩体几何（环壁 + 实心段 + 空腔底 合并焊接而成）在 20° 阈值下
    // 产出 750 段折边，其中 736 段短于 2m、141 段就落在岩体正面平面上——它们不是轮廓，
    // 而是合并/焊接处三角化留下的内部折痕，画出来就是岩面上的一片密集短横线/斜纹
    // （实测爆破前只有 200 段 / 8 条长边，爆后骤增到 750 段）。岩体真实轮廓棱边全在
    // 十米级，故按几何包围盒尺度取阈值，只保留真正的轮廓边。
    edges = this._filterShortEdges(edges, mesh.geometry)
    // 剖切激活时：切面本身是平直平面，其 ear-clipping 三角剖分会产生共面(≈0°/180°)
    // 的伪折痕边，EdgesGeometry 会把它们渲染成切面上的一堆三角线。把"两个端点都落在
    // 剖切平面"上的边整体剔除，只保留岩体向切面以外延伸的真实外轮廓锐利折边。
    if (this._lastCutAxis != null && Number.isFinite(Number(this._lastCutPos))) {
      edges = this._filterEdgesOnPlane(edges, this._lastCutAxis, Number(this._lastCutPos))
    }
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, // 亮白描边：暗背景/热力任意底色上都能看清轮廓（原冷白 0xbfe0ff 偏暗）
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false
    })
    const line = new THREE.LineSegments(edges, mat)
    line.renderOrder = 999 // 始终压在最上层，保证轮廓不被热力图盖住
    line.frustumCulled = false
    mesh.add(line)
    mesh.userData.__outlineLine = line
  }

  /** 过滤掉"两个端点都落在某个剖切平面(轴坐标==cutPos)上"的线段，返回新几何。
   *  用于把切面内部的三角剖分线从轮廓 EdgesGeometry 中剔除，保留岩体真实外轮廓。 */
  _filterEdgesOnPlane(edgesGeo, axis, cutPos) {
    const attr = edgesGeo.attributes.position
    const arr = attr.array
    const keep = []
    const TOL = 1e-3
    for (let i = 0; i < attr.count; i += 2) {
      const a = arr[i * 3 + axis]
      const b = arr[(i + 1) * 3 + axis]
      if (Math.abs(a - cutPos) < TOL && Math.abs(b - cutPos) < TOL) continue
      const o = i * 3
      keep.push(arr[o], arr[o + 1], arr[o + 2], arr[o + 3], arr[o + 4], arr[o + 5])
    }
    const out = new THREE.BufferGeometry()
    out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3))
    if (keep.length) out.computeBoundingSphere()
    edgesGeo.dispose()
    return out
  }

  /**
   * 强制某坐标平面上的共面三角朝向指定法线方向：把朝反方向的三角形反转绕序。
   * 用于保证新掌子面（z=roundDepth）整面统一朝外（面向空腔/隧道口），
   * 避免 merge+creaseNormals 偶发的背向三角在新掌子面上形成被剔除的“黑洞”。
   * @param {THREE.BufferGeometry} geo
   * @param {0|1|2} axis 平面法线轴
   * @param {number} value 平面坐标值
   * @param {1|-1} preferSign 期望的该轴法线符号（-1=朝负向）
   * @param {number} [tol=0.03] 判定“位于平面”的容差（米）
   */
  _forcePlaneOrientation(geo, axis, value, preferSign, tol = 0.03) {
    const posAttr = geo.attributes.position
    if (!posAttr) return geo
    const p = posAttr.array
    const uvAttr = geo.attributes.uv
    const uvA = uvAttr ? uvAttr.array : null
    const idx = geo.index
    const P = posAttr.count
    const triCount = idx ? idx.array.length / 3 : P / 3
    const at = (i, k) => p[i * 3 + k]
    let changed = false

    const flipTri = (a, b, c) => {
      // 交换 b、c 顶点 → 反转绕序（面法线取反）
      const swapV = (x, y) => {
        for (let k = 0; k < 3; k++) {
          const t = p[x * 3 + k]
          p[x * 3 + k] = p[y * 3 + k]
          p[y * 3 + k] = t
        }
        if (uvA) {
          for (let k = 0; k < 2; k++) {
            const t = uvA[x * 2 + k]
            uvA[x * 2 + k] = uvA[y * 2 + k]
            uvA[y * 2 + k] = t
          }
        }
      }
      swapV(b, c)
    }

    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.array[t * 3] : t * 3
      const b = idx ? idx.array[t * 3 + 1] : t * 3 + 1
      const c = idx ? idx.array[t * 3 + 2] : t * 3 + 2
      if (
        Math.abs(at(a, axis) - value) > tol ||
        Math.abs(at(b, axis) - value) > tol ||
        Math.abs(at(c, axis) - value) > tol
      )
        continue
      // 面法线沿 axis 分量（(B-A)×(C-A)）
      let comp
      if (axis === 0) {
        comp =
          (at(b, 1) - at(a, 1)) * (at(c, 2) - at(a, 2)) -
          (at(b, 2) - at(a, 2)) * (at(c, 1) - at(a, 1))
      } else if (axis === 1) {
        comp =
          (at(b, 2) - at(a, 2)) * (at(c, 0) - at(a, 0)) -
          (at(b, 0) - at(a, 0)) * (at(c, 2) - at(a, 2))
      } else {
        comp =
          (at(b, 0) - at(a, 0)) * (at(c, 1) - at(a, 1)) -
          (at(b, 1) - at(a, 1)) * (at(c, 0) - at(a, 0))
      }
      const sign = comp > 0 ? 1 : comp < 0 ? -1 : 0
      if (sign !== preferSign && sign !== 0) {
        if (idx) {
          const tmp = idx.array[t * 3 + 1]
          idx.array[t * 3 + 1] = idx.array[t * 3 + 2]
          idx.array[t * 3 + 2] = tmp
        } else {
          flipTri(a, b, c)
        }
        changed = true
      }
    }
    posAttr.needsUpdate = true
    if (uvAttr) uvAttr.needsUpdate = true
    if (changed && geo.attributes.normal) {
      // 反转绕序后法线属性已失效：重算（若非 indexed 视觉上直接生效；
      // 若 indexed 且后续不走 creaseNormals，也需要正确法线）
      geo.computeVertexNormals()
    }
    return geo
  }

  /**
   * 构建振动场表面着色材质（ShaderMaterial）。
   * 以指定岩石纹理为底色，叠加应力/损伤/PPV 场颜色。
   * 初始无场数据时纯显示岩色（uFieldWeight=0）。
   * 岩体（bench）与掌子面（face/damaged）共用同一套 LUT 与占位纹理。
   * @param {THREE.MeshStandardMaterial} baseMat - 原始岩石材质（提供纹理与基础色）
   * @param {Object} [opts] - 材质选项
   * @param {number} [opts.opacity=1] - 全局透明度（<1 时半透明，隧道内壁用）
   * @param {boolean} [opts.transparent] - 是否开启透明混合（默认 opacity<1 时开启）
   * @param {boolean} [opts.depthWrite=true] - 是否写入深度（半透明面设为 false 以免遮挡后方岩体）
   * @returns {THREE.ShaderMaterial}
   */
  /**
   * 由色带停靠点生成 1D 渐变 LUT（256×1，线性插值）。
   * 与图例（vibrationColorScales）同源 → 两者颜色严格一致。
   * @param {Array} stops - [[v,[r,g,b]], …]（v 与 max 同单位）
   * @param {number} max - 满刻度
   */
  _buildScaleLutTexture(stops, max) {
    const N = 256
    const data = new Uint8Array(N * 4)
    for (let i = 0; i < N; i++) {
      const v = (i / (N - 1)) * max
      const rgb = sampleScaleColor(stops, v)
      data[i * 4] = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255)
      data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255)
      data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255)
      data[i * 4 + 3] = 255
    }
    const tex = new THREE.DataTexture(data, N, 1)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    return tex
  }

  _createFieldMaterial(baseMat, opts = {}) {
    const opacity = opts.opacity ?? 1
    const transparent = opts.transparent ?? opacity < 1
    const depthWrite = opts.depthWrite ?? true
    // 占位 3D 纹理（无场数据时避免 sampler3D 未绑定）
    if (!this._fieldDummyTexture) {
      const dummy = new THREE.Data3DTexture(new Float32Array(1), 1, 1, 1)
      dummy.format = THREE.RedFormat
      dummy.type = THREE.FloatType
      dummy.needsUpdate = true
      this._fieldDummyTexture = dummy
    }
    // 1D LUT：**直接用色带停靠点生成渐变表**（而非纯黑占位）。
    // 【关键】旧实现用 1×1 纯黑占位纹理：场图层一开、而场数据帧尚未到达时
    // （预计算/首帧之前），片元采样 LUT 得到纯黑 → 整块岩体变全黑，而不是色带低值色。
    // 这里始终提供正确的渐变 LUT（低端=蓝、高端=红），与图例同源。
    if (!this._fieldPpvLut) {
      this._fieldPpvLut = this._buildScaleLutTexture(PPV_COLOR_STOPS_LINEAR, PPV_LUT_MAX_CMPS)
    }
    if (!this._fieldStressLut) {
      this._fieldStressLut = this._buildScaleLutTexture(
        STRESS_COLOR_STOPS_LINEAR,
        STRESS_LUT_MAX_MPA
      )
    }
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uRockMap: { value: baseMat?.map || createRockTexture() },
        uPpvTexture: { value: this._fieldDummyTexture },
        uStressTexture: { value: this._fieldDummyTexture },
        uDamageTexture: { value: this._fieldDummyTexture },
        uPpvLut: { value: this._fieldPpvLut },
        uStressLut: { value: this._fieldStressLut },
        uBoundsMin: { value: new THREE.Vector3(0, 0, 0) },
        uBoundsMax: { value: new THREE.Vector3(1, 1, 1) },
        uGridSize: { value: new THREE.Vector3(32, 32, 64) },
        uGridSampleMode: { value: 0 }, // 0=voxel centers, 1=endpoint nodes
        uPpvReady: { value: 0 },
        uStressReady: { value: 0 },
        uDamageReady: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uRight: { value: new THREE.Vector3(1, 0, 0) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uForward: { value: new THREE.Vector3(0, 0, 1) },
        uDisplayMode: { value: BENCH_FIELD_DEFAULTS.displayMode },
        uFieldWeight: { value: BENCH_FIELD_DEFAULTS.fieldWeight },
        uWhiteModel: { value: 0 }, // 默认关闭白模：保留岩石纹理底，场色叠在岩色上
        uPpvRefMps: { value: BENCH_FIELD_DEFAULTS.ppvRefMps },
        uStressRefMPa: { value: BENCH_FIELD_DEFAULTS.stressRefMPa },
        uThresholdMps: { value: BENCH_FIELD_DEFAULTS.thresholdMps },
        uStressVisiblePa: { value: BENCH_FIELD_DEFAULTS.stressVisiblePa },
        uRockColor: { value: new THREE.Color(baseMat?.color || 0xb8946e) },
        // 方向光（世界空间，归一化）：上右前，模拟隧道内主照明方向
        uSunDir: { value: new THREE.Vector3(0.55, 0.75, 0.45).normalize() },
        uGlobalOpacity: { value: opacity },
        uSectionEnabled: { value: 0 },
        uSectionNWorld: { value: new THREE.Vector3(1, 0, 0) },
        uSectionCWorld: { value: 0 },
        uSectionAxis: { value: 0 },
        uSectionPos: { value: 0 },
        // ── 解析外推波场 uniforms（PPV/应力模式的岩面解析显示分支）──
        // 【注】shader（benchField.frag.glsl）声明了完整解析分支：uSimTime/uSadoskyK/
        // uChargeKg/uSourceCount… 由 setFieldSimTime/applyFieldPhysics 注入。
        // 历史缺陷：材质 uniforms 曾整组缺失 → three.js 默认 0 值 → uSadoskyK=0
        // 使解析波振幅恒 0，PPV/应力两模式全黑（uSimTime 亦无更新路径）。
        uSimTime: { value: 0 },
        uSadoskyK: { value: 0 },
        uSadoskyAlpha: { value: 1.5 },
        uSadoskyBeta: { value: 0.012 },
        uPpvVisualBeta: { value: 0 },
        uVisualCp: { value: 5 },
        uDisplayDecay: { value: 7 },
        uArrivalRise: { value: 0.12 },
        uCarrierHz: { value: 0 },
        uChargeKg: { value: 0 },
        uStressFactor: { value: 0 },
        uBlastOrigin: { value: new THREE.Vector3() },
        uSourceCount: { value: 0 },
        uSourcePosQ: {
          value: Array.from({ length: 96 }, () => new THREE.Vector4())
        },
        uSourceDelay: { value: new Float32Array(96) },
        uReflectOn: { value: 0 },
        uReflectCoeff: { value: 0.85 },
        uFaceZ: { value: 3 },
        uHoleRadius: { value: 0 },
        uHoleLen: { value: 0 },
        uLateralAttn: { value: 0.75 },
        // 动态满量程系数初值 1（中性）：实际值由 manager._updateFieldAutoScale 每帧
        // 反解下发（经 applyFieldPhysics 的 normAutoScale 注入）。不可为 0——
        // 0 会使 iVal=clamp(×0)=0，PPV/应力热力图整片深蓝无梯度。
        uNormAutoScale: { value: 1 }
      },
      vertexShader: BENCH_FIELD_VERTEX_SHADER,
      fragmentShader: BENCH_FIELD_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      transparent,
      opacity,
      depthWrite
    })
  }

  /** 所有应用了振动场着色的材质（岩体 + 掌子面 + 损伤掌子面 + 已开挖段围岩） */
  _fieldMaterials() {
    const mats = [this._benchFieldMaterial, this._faceFieldMaterial]
    // 已开挖段隧道围岩若使用独立的场着色材质（未与岩体共用），同样纳入同步
    const shell = this.tunnelShellMesh?.material
    if (shell && shell !== this._benchFieldMaterial && shell.uniforms?.uFieldWeight) {
      mats.push(shell)
    }
    return mats.filter(Boolean)
  }

  /**
   * 注入振动场数据纹理与坐标基向量（由 threeBlastingRenderer 在 initVibrationField 时调用）
   * @param {Object} data - BlastVibrationFieldRenderer.getFieldData() 的返回值（伪子集）
   */
  setBenchFieldData(data) {
    const mats = this._fieldMaterials()
    if (!mats.length) return
    for (const m of mats) {
      const u = m.uniforms
      if (data) {
        if (data.stressTexture) u.uStressTexture.value = data.stressTexture
        if (data.damageTexture) u.uDamageTexture.value = data.damageTexture
        if (data.ppvTexture) u.uPpvTexture.value = data.ppvTexture
        if (data.lutTexture) u.uPpvLut.value = data.lutTexture
        if (data.stressLutTexture) u.uStressLut.value = data.stressLutTexture
        if (data.boundsMin) u.uBoundsMin.value.set(...data.boundsMin)
        if (data.boundsMax) u.uBoundsMax.value.set(...data.boundsMax)
        if (data.gridShape) u.uGridSize.value.set(...data.gridShape.slice(0, 3), 1)
        u.uGridSampleMode.value = data.gridSampleMode === 'nodes' ? 1 : 0
        u.uPpvReady.value = data.hasPpv ? 1 : 0
        u.uStressReady.value = data.hasStress ? 1 : 0
        u.uDamageReady.value = data.hasDamage ? 1 : 0
        if (data.center) u.uCenter.value.copy(data.center)
        if (data.right) u.uRight.value.copy(data.right)
        if (data.up) u.uUp.value.copy(data.up)
        if (data.forward) u.uForward.value.copy(data.forward)
        if (data.ppvRefMps != null) u.uPpvRefMps.value = data.ppvRefMps
        if (data.stressRefMPa != null) u.uStressRefMPa.value = data.stressRefMPa
        if (data.thresholdMps != null) u.uThresholdMps.value = data.thresholdMps
        if (data.stressVisiblePa != null) u.uStressVisiblePa.value = data.stressVisiblePa
      } else {
        // 无数据：恢复占位纹理与默认坐标
        u.uStressTexture.value = this._fieldDummyTexture
        u.uDamageTexture.value = this._fieldDummyTexture
        u.uPpvTexture.value = this._fieldDummyTexture
        u.uPpvReady.value = 0
        u.uStressReady.value = 0
        u.uDamageReady.value = 0
      }
    }
    // 【仅开发环境诊断】暴露首材质的关键 uniform 真值，供控制台核查
    // 热力图不可见时的门控状态（uPpvReady/uFieldWeight/uBounds/坐标基）。
    if (import.meta.env?.DEV && mats.length) {
      const u = mats[0].uniforms
      window.__benchFieldDebug = {
        uPpvReady: u.uPpvReady.value,
        uStressReady: u.uStressReady.value,
        uDamageReady: u.uDamageReady.value,
        uFieldWeight: u.uFieldWeight.value,
        uDisplayMode: u.uDisplayMode.value,
        uWhiteModel: u.uWhiteModel.value,
        uBoundsMin: u.uBoundsMin.value.toArray(),
        uBoundsMax: u.uBoundsMax.value.toArray(),
        uGridSize: u.uGridSize.value.toArray(),
        uGridSampleMode: u.uGridSampleMode.value,
        uCenter: u.uCenter.value.toArray(),
        uForward: u.uForward.value.toArray(),
        uPpvRefMps: u.uPpvRefMps.value,
        uThresholdMps: u.uThresholdMps.value,
        // 解析外推分支的驱动 uniforms（PPV/应力岩面着色完全由这些值决定，
        // 任一为 0 都会令振幅恒 0 → 整片深蓝无波动）
        uSadoskyK: u.uSadoskyK.value,
        uSadoskyAlpha: u.uSadoskyAlpha.value,
        uChargeKg: u.uChargeKg.value,
        uSourceCount: u.uSourceCount.value,
        uSimTime: u.uSimTime.value,
        uVisualCp: u.uVisualCp.value,
        uDisplayDecay: u.uDisplayDecay.value,
        uNormAutoScale: u.uNormAutoScale.value,
        benchMeshVisible: this.benchMesh?.visible,
        benchMeshInScene: !!this.benchMesh?.parent
      }
    }
  }

  /** 切换岩体/掌子面振动场显示模式（0=PPV, 1=STRESS, 2=DAMAGE） */
  setBenchFieldDisplayMode(mode) {
    const v = Number(mode) || 0
    for (const m of this._fieldMaterials()) m.uniforms.uDisplayMode.value = v
  }

  /**
   * 每帧推进解析外推波场的模拟时间（PPV/应力模式的岩面解析显示）。
   * threeBlastingRenderer.update() 每帧以播放时钟调用；uSimTime 驱动 shader 内
   * gap = uSimTime − arrival 的波包展开（缺失时 uSimTime 恒 0 → PPV/应力全黑）。
   */
  setFieldSimTime(t) {
    const v = Number(t) || 0
    for (const m of this._fieldMaterials()) {
      if (m.uniforms?.uSimTime) m.uniforms.uSimTime.value = v
    }
  }

  /**
   * 注入解析外推波场物理参数（manager._pushFieldPhysics → renderer.setFieldPhysics → 此处落 uniform）：
   * 萨道夫斯基 K/α/β、装药量、可视化波速、显示衰减、载波、反射、应力换算系数、爆心与多装药源。
   * 多源写入 uSourcePosQ（xyz=grid 局部坐标，w=源强度系数 K·q^(α/3)·0.01，片元内免每源一次 pow）
   * 与 uSourceDelay（按延时升序）；uSourceCount=0 时 shader 退化为 uBlastOrigin+uChargeKg 单源。
   */
  applyFieldPhysics(params = {}) {
    const nu = Number.isFinite(Number(params.nu)) ? Number(params.nu) : 0.25
    const rho = Number(params.rho) || 2650
    const cp = Number(params.cp) || 4500
    // 【未提供不覆盖】部分调用方只传个别字段（如 initVibrationField 只传 origin），
    // 未提供的键必须保留材质上的现值——旧实现用 `Number(x)||默认` 兜底，会把已下发
    // 的 K/药量/波速整组重置为缺省值（uSadoskyK=0 → 解析波振幅恒 0 → 整片深蓝）。
    // 判断依据是 `params[key] !== undefined`（显式传 0 仍生效）。
    const has = key => params[key] !== undefined
    const kVal = has('k') ? Number(params.k) || 0 : null
    const alphaVal = has('alpha') ? Number(params.alpha) || 1.5 : null
    const mats = this._fieldMaterials()
    for (const m of mats) {
      const u = m.uniforms
      if (!u) continue
      if (u.uSadoskyK && kVal !== null) u.uSadoskyK.value = kVal
      if (u.uSadoskyAlpha && alphaVal !== null) u.uSadoskyAlpha.value = alphaVal
      if (u.uSadoskyBeta && has('beta'))
        u.uSadoskyBeta.value = Number(params.beta) || 0.012
      if (u.uPpvVisualBeta && has('ppvVisualBeta'))
        u.uPpvVisualBeta.value = Number(params.ppvVisualBeta) || 0
      if (u.uChargeKg && has('chargeKg')) u.uChargeKg.value = Number(params.chargeKg) || 0
      if (u.uVisualCp && has('visualCp')) u.uVisualCp.value = Number(params.visualCp) || 5
      if (u.uDisplayDecay && has('displayDecay'))
        u.uDisplayDecay.value = Number(params.displayDecay) || 7
      if (u.uArrivalRise && has('arrivalRise'))
        u.uArrivalRise.value = Number(params.arrivalRise) || 0.12
      if (u.uCarrierHz && has('carrierHz')) u.uCarrierHz.value = Number(params.carrierHz) || 0
      if (u.uReflectOn && has('reflectOn')) u.uReflectOn.value = params.reflectOn ? 1 : 0
      if (u.uReflectCoeff && has('reflectCoeff'))
        u.uReflectCoeff.value = Number(params.reflectCoeff) || 0.85
      if (u.uFaceZ && has('faceZ')) u.uFaceZ.value = Number(params.faceZ) || 0
      if (u.uLateralAttn && has('lateralAttn'))
        u.uLateralAttn.value = Number(params.lateralAttn) || 0.75
      if (u.uStressFactor && (has('rho') || has('nu') || has('cp')))
        u.uStressFactor.value = (rho * cp) / (1 - nu)
      if (
        u.uNormAutoScale &&
        has('normAutoScale') &&
        Number.isFinite(Number(params.normAutoScale))
      ) {
        // 动态满量程系数（manager._updateFieldAutoScale 按当前瞬时场反解，钳在 [0.02,80]）。
        // 缺失该注入时 uniform 恒为材质初始 0 → iVal=clamp(×0)=0 → PPV/应力热力图
        // 整片深蓝、无任何波动梯度（2026-10-15 实测定位的回归根因）。
        u.uNormAutoScale.value = Math.max(0.02, Math.min(80, Number(params.normAutoScale)))
      }
      if (u.uBlastOrigin && Array.isArray(params.origin)) {
        u.uBlastOrigin.value.set(
          Number(params.origin[0]) || 0,
          Number(params.origin[1]) || 0,
          Number(params.origin[2]) || 0
        )
      }
    }
    // 多装药源 → uSourcePosQ/uSourceDelay/uSourceCount（须在 K/α 注入后调用，w 依赖 K/α）。
    // sources 未提供时不覆盖（保留已注入的源列表），与上方"未提供不覆盖"一致。
    if (!Array.isArray(params.sources)) return
    const list = params.sources
      .filter(s => Number(s?.fieldChargeKg ?? s?.chargeKg) > 0)
      .sort((a, b) => (Number(a.delayMs) || 0) - (Number(b.delayMs) || 0))
    for (const m of mats) {
      const u = m.uniforms
      if (!u?.uSourcePosQ || !u.uSourceDelay || u.uSourceCount == null) continue
      const arr = u.uSourcePosQ.value
      const delays = u.uSourceDelay.value
      // 源强度系数依赖 K/α：未随 sources 提供时取材质现值（_pushFieldPhysics 总是成对下发）
      const kw = kVal !== null ? kVal : Number(u.uSadoskyK?.value) || 0
      const aw = alphaVal !== null ? alphaVal : Number(u.uSadoskyAlpha?.value) || 1.5
      const n = Math.min(list.length, arr.length)
      for (let i = 0; i < arr.length; i++) {
        if (i < n) {
          const s = list[i]
          const q = Number(s.fieldChargeKg ?? s.chargeKg) || 0
          // 源强度系数 K·q^(α/3)·0.01（cm/s 口径，与解析场同式）
          arr[i].set(
            Number(s.x) || 0,
            Number(s.y) || 0,
            Number(s.z) || 0,
            kw * Math.pow(q, aw / 3) * 0.01
          )
          delays[i] = (Number(s.delayMs) || 0) / 1000
        } else {
          arr[i].set(0, 0, 0, 0)
          delays[i] = 0
        }
      }
      u.uSourceCount.value = n
    }
  }

  /** 设置岩体/掌子面振动场着色权重（0~1），0=关闭只显示岩色 */
  setBenchFieldWeight(weight) {
    const v = Math.max(0, Math.min(1, Number(weight) || 0))
    for (const m of this._fieldMaterials()) m.uniforms.uFieldWeight.value = v
  }

  /** 设置岩体/掌子面底材是否"白模"：true=场图层开启时切白模底，false=保留岩石纹理底 */
  setFieldWhiteModel(enabled) {
    const v = enabled ? 1 : 0
    for (const m of this._fieldMaterials()) m.uniforms.uWhiteModel.value = v
  }

  /**
   * 设置爆破场景对象的透明度（供外部工具／面板在爆破模式下控制）。
   * @param {'rock'|'tunnel'} which - 'rock'=未爆破岩体(掌子面)，'tunnel'=已开挖巷道(隧道壳/空腔)
   * @param {number} opacity - 0..1，1=完全不透明
   */
  setObjectOpacity(which, opacity) {
    const o = Number(opacity)
    const v = Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1
    if (which === 'rock') {
      for (const m of this._fieldMaterials()) {
        if (!m.uniforms?.uGlobalOpacity) continue
        m.uniforms.uGlobalOpacity.value = v
        m.transparent = true
        m.depthWrite = v >= 0.999
        m.needsUpdate = true
      }
    } else if (which === 'tunnel') {
      for (const mesh of [this.tunnelShellMesh, this.excavatedTubeMesh]) {
        if (!mesh?.material) continue
        mesh.material.transparent = true
        mesh.material.opacity = v
        mesh.material.needsUpdate = true
      }
    }
  }

  /** 读取爆破场景对象的当前透明度（默认：岩体不透明、巷道透明）。 */
  getObjectOpacity(which) {
    if (which === 'rock') {
      const m = this._benchFieldMaterial
      return m?.uniforms?.uGlobalOpacity ? m.uniforms.uGlobalOpacity.value : 1
    }
    if (which === 'tunnel') {
      return this.tunnelShellMesh?.material?.opacity ?? 0.38
    }
    return 1
  }

  /**
   * 设置岩体剖面裁剪（爆破模式下观察内部）。
   * @param {number} [enabled] 0 关 / 1 开
   * @param {number} [axis] 0=X 1=Y 2=Z（基于场景 rel 坐标）
   * @param {number} [pos] 裁剪平面沿轴位置
   *
   * 切割策略：岩体（bench）用几何真剖切（CSG）保证截面实心封口；
   * 其余全部模型（掌子面/漏斗/隧道壳/开挖管/围岩环等）用**同一世界空间平面**
   * 统一施加材质级裁剪，与岩体剖切面对齐，实现"全部模型一同切割"而非只切岩体。
   */
  setSectionPlane({ enabled = 0, axis = 0, pos = 0 } = {}) {
    return this._sectionCutter.setSectionPlane({ enabled, axis, pos })
  }

  /**
   * 几何真剖切（CSG，axis-aligned 平面）：实现已整体迁至 SectionCutter._applySectionCut
   * （sectionCutter.js）。剖切保护网测试（sectionCoverage / rockBodySectionCut 等）
   * 直接以 sb._applySectionCut(...) 调用，故保留此一行兼容委托。
   * @param {number} axis 0=X 1=Y 2=Z（局部坐标轴）
   * @param {number} pos 归一化比例 [0,1]：0=包围盒一端，1=另一端，0.5=居中
   */
  _applySectionCut(axis, pos) {
    return this._sectionCutter._applySectionCut(axis, pos)
  }

  // ─── 拾取式剖切（爆破模式）──────────────────────────
  /** 返回可被射线拾取的岩体网格列表 */
  getRockMeshes() {
    const list = []
    if (this.benchMesh) list.push(this.benchMesh)
    return list
  }

  /**
   * 拾取式剖切：给定岩体上的一个局部点与切割轴，构造过该点、法线沿该轴的
   * 剖切面，生成实体封口断面，并在切面上绘制轮廓轮廓标记（半透明面 + 边界线 + 中心点）。
   * @param {number} axis 0=X 1=Y 2=Z
   * @param {Object} point {x,y,z} 岩体局部坐标
   */
  setSectionPick(axis, point = {}) {
    return this._sectionCutter.setSectionPick(axis, point)
  }

  /**
   * 显示/隐藏拾取点标记：在岩体表面拾取一点后、选择切割轴前给出视觉反馈，
   * 让用户明确"切割面将过这个点"。point 传 null 或非法值时隐藏。
   * @param {{x,y,z}|null} point 岩体局部坐标
   */
  setPickPointMarker(point = null) {
    return this._sectionCutter.setPickPointMarker(point)
  }

  /** 清除拾取式剖切：移除轮廓标记并还原完整岩体 */
  clearSectionPick() {
    return this._sectionCutter.clearSectionPick()
  }

  getSectionPlane() {
    return this._sectionCutter.getSectionPlane()
  }

  // ─── 开口隧道内壁几何（两端无 cap 面） ────────────────
  /**
   * 由断面 Shape 轮廓构建开口管状几何（两端开口，无 cap 面）。
   * 相比 ExtrudeGeometry：ExtrudeGeometry 会在两端生成实心 cap 面，
   * 前端 cap 面正好挡住掌子面/岩体，导致"隧道外壁与掌子面重叠部分看不到"。
   * 开口管保证掌子面及后方岩体始终可见，且不产生共面 z-fighting。
   * @param {THREE.Shape} shape - 马蹄形断面（外层轮廓）
   * @param {number} depth - 管长（>0）
   * @param {number} segments - 轮廓采样点数
   * @returns {THREE.BufferGeometry}
   */
  _buildOpenTubeGeometry(shape, depth, segments = 96) {
    const pts = shape.getPoints(segments)
    const n = pts.length
    const positions = new Float32Array(n * 2 * 3)
    const uvs = new Float32Array(n * 2 * 2)
    const nearZ = 0
    const farZ = -depth
    for (let i = 0; i < n; i++) {
      // 轮廓弧长比例作 u、管深比例作 v：供振动场着色材质的岩石纹理/uRockMap 采样
      const u = n > 1 ? i / (n - 1) : 0
      positions[i * 6 + 0] = pts[i].x
      positions[i * 6 + 1] = pts[i].y
      positions[i * 6 + 2] = nearZ
      positions[i * 6 + 3] = pts[i].x
      positions[i * 6 + 4] = pts[i].y
      positions[i * 6 + 5] = farZ
      uvs[i * 4 + 0] = u
      uvs[i * 4 + 1] = 0
      uvs[i * 4 + 2] = u
      uvs[i * 4 + 3] = 1
    }
    const indices = []
    for (let i = 0; i < n; i++) {
      const a = i
      const b = (i + 1) % n
      const na = a * 2
      const fa = a * 2 + 1
      const nb = b * 2
      const fb = b * 2 + 1
      indices.push(na, fa, nb, fa, fb, nb)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    return geo
  }

  // ─── 已开挖段隧道（空心透明轮廓，示意已开挖） ──
  _buildTunnelShell(ctx) {
    const shellLength = 80 // 隧道轮廓长度(m)，覆盖相机视野
    // 已开挖巷道为透明空心轮廓：表示已被开挖，不与未爆破岩体抢视觉。
    // 不参与应力场着色（隧道空腔内部不渲染场色带）——应力场在掌子面前方未爆破岩体内传播。
    const shellGeo = this._buildOpenTubeGeometry(ctx.tunnelShape, shellLength, 96)
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x6a6560,
      map: this.rockTexture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0.05
    })
    this.tunnelShellMesh = new THREE.Mesh(shellGeo, tubeMat)
    // 前端开口位于掌子面处（faceOffset），向 -forward 延伸
    this.tunnelShellMesh.position.set(
      ctx.cx + ctx.dir.x * ctx.faceOffset,
      ctx.cz,
      ctx.cy + ctx.dir.z * ctx.faceOffset
    )
    this.tunnelShellMesh.rotation.y = ctx.yaw
    this.tunnelShellMesh.receiveShadow = true
    this.scene.add(this.tunnelShellMesh)
  }

  // ─── 完整掌子面（薄板马蹄形，爆破前可见） ────────────
  _buildFaceMesh(ctx) {
    // 掌子面仅作"贴合岩体前缘的薄板盖"，而非 2m 厚墩：厚墩会向已开挖洞身凸出
    // 1m、又向岩体内嵌 1m，导致掌子面与岩体明显"不贴合"。此处改为前表面与
    // 岩体前缘(faceOffset)齐平（+0.02 防共面 z-fighting），仅伸向岩体内薄薄一层。
    // 注意：几何以中心定位（板厚 0.1 → 前/后各偏 0.05），故前缘居中于 faceOffset+0.02：
    //   前表面 ≈ faceOffset+0.07（仅 7cm 微凸防 z-fight），后表面 ≈ faceOffset-0.03，
    //   既不会凸出大台阶、也不会反向堵住已开挖洞身。
    const faceThickness = 0.1
    const faceCapProud = 0.02
    let faceGeo = new THREE.ExtrudeGeometry(ctx.tunnelShape, {
      depth: faceThickness,
      bevelEnabled: false
    })
    faceGeo.translate(0, 0, -faceThickness / 2)
    // 表面抛光：折痕法线平滑（薄板拱厚棱侧壁 flat→随拱平滑，轮廓仍硬）
    if (this.surfacePolish) {
      const polished = creaseNormals(faceGeo, POLISH_CREASE_DEG)
      faceGeo.dispose()
      faceGeo = polished
    }
    // 掌子面同样使用振动场着色材质，使爆破前后掌子面上都显示 PPV/应力/损伤色带
    this._faceFieldMaterial = this._createFieldMaterial(ctx.faceMat)
    this.faceMesh = new THREE.Mesh(faceGeo, this._faceFieldMaterial)
    // 前缘贴齐岩体前缘：faceOffset + faceCapProud（不再 + faceThickness/2）
    const fFront = ctx.faceOffset + faceCapProud
    this.faceMesh.position.set(ctx.cx + ctx.dir.x * fFront, ctx.cz, ctx.cy + ctx.dir.z * fFront)
    this.faceMesh.rotation.y = ctx.yaw
    this.faceMesh.castShadow = true
    this.faceMesh.receiveShadow = true
    this.faceMesh.visible = true
    this.scene.add(this.faceMesh)
    // 掌子面轮廓线：马蹄形断面边缘高亮，暗背景下清晰可辨
    this._attachRockOutline(this.faceMesh)
  }

  // ─── 损伤掌子面 + 3D 爆破漏斗（爆破后可见） ──────────
  _buildFaceDamagedMesh(ctx) {
    // 爆破前后只保留一个"完整掌子面"（faceMesh）。不再另建带洞的"损伤掌子面"薄板：
    // 旧实现额外一张破损薄板与 3D 漏斗/岩体多层面共面，Z-fighting 在截图上呈
    // "两层面/整体发黑"。爆破后掌子面消失，破坏形态由 3D 爆破漏斗 + 岩体后退表达。
    // 先计算破碎腔轮廓：3D 漏斗开口沿用同一组点，保证开口与深腔严贴合
    // （RNG 有状态，不能分别调用 _computeCraterPoints）
    const craterPtsArr = this._computeCraterPoints(ctx.W, ctx.Hw, ctx.R)

    // ── 3D 爆破漏斗（掏槽破碎深腔，与掌子面破碎腔尺寸严格一致） ──
    // 开口贴合掌子面破碎腔轮廓（_computeCraterPoints 同一组点），沿进尺方向
    // 收敛成马蹄形深腔；深度与单循环进尺（roundDepth）匹配，避免圆形漏斗
    // 与马蹄形断面错位、以及过浅/过深失真。
    // 深度约束：几何层漏斗最深处 = 开口偏移 + 1.02×depth（见 _buildCraterGeometry
    // 的底部收口 bottomZ=d*1.02），必须止于岩体前缘（新掌子面 faceOffset+roundDepth）
    // 之前并留出 clearance。否则漏斗收口底体会嵌进后方岩体的前方面产生穿模。
    const CRATER_MOUTH_OFFSET = 0.15
    const CRATER_TAIL_CLEAR = 0.15
    const craterDepth = Math.max(
      0.5,
      (ctx.roundDepth - CRATER_MOUTH_OFFSET - CRATER_TAIL_CLEAR) / 1.02
    )
    let craterGeo = this._buildCraterGeometry(craterPtsArr, craterDepth)
    // 表面抛光：折痕法线平滑（漏斗收敛壁光照连续，口/底环仍锐利）
    if (this.surfacePolish) {
      const polished = creaseNormals(craterGeo, POLISH_CREASE_DEG)
      craterGeo.dispose()
      craterGeo = polished
    }
    // 复用掌子面振动场着色材质（_faceFieldMaterial）：让爆破漏斗壁同样显示
    // PPV/应力/损伤场色，彻底替换原先的纯黑 void 材质，与周围岩体/掌子面
    // 的场色拼接一致（不再"无着色/拼接突兀"）。
    this.craterMesh = new THREE.Mesh(craterGeo, this._faceFieldMaterial)
    // 漏斗几何已在隧道局部坐标系（y=高度，z=向岩体纵深），
    // 定位与掌子面一致即可，无需再叠加断面质心高度 hcy
    this.craterMesh.position.set(
      ctx.cx + ctx.dir.x * (ctx.faceOffset + CRATER_MOUTH_OFFSET),
      ctx.cz,
      ctx.cy + ctx.dir.z * (ctx.faceOffset + CRATER_MOUTH_OFFSET)
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
  _collectBlastHoles(cy0, W, Hw, R, _totalH) {
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
      // 视觉半径按真实孔径缩放（40mm 药卷 → 半径~2cm），不再×3 放大：炮孔细钉、
      // 互不重叠，掌子面上清晰呈现布孔图案（截面 4.7m 宽可容纳 43 孔不会糊成一团）。
      const visRadius = Math.max(0.025, realDia * 1.2)
      const x = Number(h.posX) || 0
      const y = Number(h.posY) || cy0
      // 运行时断面钳制：孔口坐标必须落在掌子面马蹄形轮廓内侧，否则丢弃，
      // 防止任何来源（设计/数据库）的越界孔显示在洞周/底板之外。
      if (!this._insideFaceProfile(x, y)) continue
      holes.push({
        x,
        y,
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

  // 孔口是否落在掌子面马蹄形断面轮廓内侧（基准：底板 y=0，直墙高 Hw，拱半 R）
  // 判定单源：core/computation/sectionShape.js（与 tunnelDesign 布孔过滤同一实现）
  _insideFaceProfile(x, y) {
    return isInsideSection(
      {
        width: this.tunnelWidth,
        wallHeight: this.tunnelWallHeight,
        archRadius: this.tunnelArchRadius
      },
      x,
      y,
      0,
      1e-4
    )
  }

  // ─── 回退模式：硬编码典型布孔（菱形掏槽 + 辅助 + 周边）
  _collectFallbackHoles(cy0, W, Hw, R) {
    // ─ 参数化：B/S/q/cutPattern 从 designParams/kcoParams 读取 ─
    const B = Math.max(0.3, Number(this.designParams?.burden) || Number(this.kcoParams?.B) || 1.5)
    const S = Math.max(0.3, Number(this.designParams?.spacing) || Number(this.kcoParams?.S) || 2.0)
    const q = Math.max(0.05, Number(this.kcoParams?.q) || 0.8)
    const cutPattern = this.designParams?.cutPattern || 'wedge'
    const holeDepth = Math.max(0.5, Number(this.designParams?.holeDepth) || 2.5)
    const realDia = Number(this.designParams?.holeDiameter) || 0.04
    const visRadius = Math.max(0.025, realDia * 1.2) // 与 _collectDesignHoles 一致：按真实孔径细钉
    const emptyVisRadius = visRadius * 1.3
    const totalH = this.tunnelHeight

    // 单孔药量 = q × B × S × holeDepth × 孔型系数
    const chargeKg = factor => q * B * S * holeDepth * factor

    const holes = []
    let series = 1
    const nextSeries = () => {
      series = (series % 20) + 1
      return series
    }

    // ─ 1. 掏槽孔（按 cutPattern 分发） ─
    const cutR = B * 0.6 // 抵抗线驱动，替代硬编码 1.0
    // 中心空孔（所有掏槽形式共用）
    holes.push({
      x: 0,
      y: cy0,
      type: 'cut',
      isEmpty: true,
      depth: holeDepth,
      visRadius: emptyVisRadius,
      inclination: 0,
      azimuth: 0,
      chargeKg: 0,
      chargeLength: 0,
      explosiveType: 'emulsion',
      detonatorSeries: 1,
      delayMs: 0,
      id: 'CUT-EMPTY'
    })

    if (cutPattern === 'spiral') {
      // 螺旋掏槽：4 孔螺旋递进，半径从 B×0.4 到 B×0.7
      const spiralSteps = 4
      for (let i = 0; i < spiralSteps; i++) {
        const r = B * (0.4 + 0.1 * i)
        const a = (i / spiralSteps) * Math.PI * 2
        holes.push({
          x: Math.cos(a) * r,
          y: cy0 + Math.sin(a) * r,
          type: 'cut',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 0,
          azimuth: 0,
          chargeKg: chargeKg(1.2),
          chargeLength: holeDepth * 0.8,
          explosiveType: 'emulsion',
          detonatorSeries: nextSeries(),
          delayMs: 50 * (i + 1),
          id: `CUT-S${i + 1}`
        })
      }
    } else if (cutPattern === 'wedge') {
      // 楔形掏槽（Da Balai 文献模式）：2~3 排斜孔 V 形开口，角度 70→60°
      // 掏槽孔分"初始(primary) + 辅助(secondary)"两批，消除耦合延时 Δt（文献最优 4~8ms，
      // 现场取 Δt=4ms），且**初始掏槽孔减量装药**（微差延迟爆破减振机理的核心）：
      //   primary 减量 0.7× 先起爆 → 生成初始爆破自由面；
      //   secondary 1.0× 延时 Δt 后起爆 → 朝自由面充分破碎、降低围岩约束。
      // 各孔日期延时而分布在 0~Δt 内（2ms 步进），使掏出孔组应力波在孔底汇拢处
      // 相长干涉、错相位处相消 → 应力场呈多源干涉斑块，而非单一同心圆。
      const wedgeN = 3
      // 延时方案：孔内微差按 [0, 2, 4] ms 递进（secondary 落在文献最优延时窗 4ms）
      const wedgeCutDelayMs = [0, 2, 4]
      // 装药系数：初始孔减量(0.7×未爆抛)，随批次接近完整(1.0×)
      const wedgeChargeFactor = [0.7, 0.85, 1.0]
      for (let i = 0; i < wedgeN; i++) {
        const offset = B * (0.5 + 0.15 * i)
        for (const side of [-1, 1]) {
          holes.push({
            x: side * offset,
            y: cy0,
            type: 'cut',
            isEmpty: false,
            depth: holeDepth,
            visRadius,
            // 倾角 = 偏离孔轴法向(垂直掌子面)的小角，使孔底在洞深处向隧洞中心汇拢：
            //   之前用 70°~74° 接近平行掌子面，孔底竖向偏移过大导致装药"出掌子面"。
            //   改为按 offset/depth 换算的向心角（首排更陡向核心）。
            inclination: i === 0 ? 18 : [17, 21, 26][i],
            // 方位：右孔朝 -x、左孔朝 +x 内倾，形成 V 形楔形掏槽；勿用 ±90（右孔朝上/左孔朝下散开）。
            azimuth: side > 0 ? 180 : 0,
            chargeKg: chargeKg(wedgeChargeFactor[i] * 1.2),
            chargeLength: holeDepth * 0.8,
            explosiveType: 'emulsion',
            detonatorSeries: nextSeries(),
            delayMs: wedgeCutDelayMs[i],
            id: `CUT-W${i + 1}-${side > 0 ? 'R' : 'L'}`
          })
        }
      }
    } else {
      // 菱形掏槽（默认）：4 孔 + 1 空孔
      const cutPos = [
        [cutR, cy0],
        [-cutR, cy0],
        [0, cy0 + cutR],
        [0, cy0 - cutR]
      ]
      cutPos.forEach((p, i) => {
        holes.push({
          x: p[0],
          y: p[1],
          type: 'cut',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 0,
          azimuth: 0,
          chargeKg: chargeKg(1.2),
          chargeLength: holeDepth * 0.8,
          explosiveType: 'emulsion',
          detonatorSeries: nextSeries(),
          delayMs: 100 * (i + 2),
          id: `CUT-${i + 1}`
        })
      })
    }

    // ─ 2. 辅助孔（圈数/半径/孔数由 B/S/断面驱动） ─
    const cutZone = 2 * cutR
    const maxR = Math.min(W, totalH) * 0.45
    const ringCount = Math.max(1, Math.ceil((maxR - cutZone) / (2 * B)))
    for (let ring = 1; ring <= ringCount; ring++) {
      const r = cutZone + 2 * B * ring
      if (r > maxR) break
      const n = Math.max(6, Math.floor((2 * Math.PI * r) / S))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const x = Math.cos(a) * r
        const y = cy0 + Math.sin(a) * r
        if (this._isInsideTunnelSection(x, y, W, Hw, R)) {
          holes.push({
            x,
            y,
            type: 'auxiliary',
            isEmpty: false,
            depth: holeDepth,
            visRadius,
            inclination: 0,
            azimuth: 0,
            chargeKg: chargeKg(1.0),
            chargeLength: holeDepth * 0.7,
            explosiveType: 'emulsion',
            detonatorSeries: nextSeries(),
            delayMs: series * 100,
            id: `AUX-${ring}-${i}`
          })
        }
      }
    }
    // ─ 3. 周边孔（间距 = 0.8 × S，光面爆破经验） ─
    const perimSpacing =
      Number(this.designParams?.perimeterSpacing) > 0
        ? Number(this.designParams.perimeterSpacing)
        : 0.8 * S
    let perimSeries = series
    for (let y = 1.0; y <= Hw - 0.3; y += perimSpacing) {
      for (const x of [-W / 2 + 0.35, W / 2 - 0.35]) {
        holes.push({
          x,
          y,
          type: 'perimeter',
          isEmpty: false,
          depth: holeDepth,
          visRadius,
          inclination: 3,
          azimuth: x > 0 ? 90 : -90,
          chargeKg: chargeKg(0.5),
          chargeLength: holeDepth * 0.6,
          explosiveType: 'emulsion',
          detonatorSeries: perimSeries,
          delayMs: perimSeries * 100,
          id: `PER-W-${perimSeries}`
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
        x,
        y,
        type: 'perimeter',
        isEmpty: false,
        depth: holeDepth,
        visRadius,
        inclination: 3,
        azimuth: (Math.atan2(x, y - Hw) * 180) / Math.PI,
        chargeKg: chargeKg(0.5),
        chargeLength: holeDepth * 0.6,
        explosiveType: 'emulsion',
        detonatorSeries: perimSeries,
        delayMs: perimSeries * 100,
        id: `PER-A-${perimSeries}`
      })
      perimSeries = (perimSeries % 20) + 1
    }
    holes.push({
      x: -W / 2 + 0.4,
      y: 0.5,
      type: 'perimeter',
      isEmpty: false,
      depth: holeDepth,
      visRadius,
      inclination: 5,
      azimuth: -90,
      chargeKg: chargeKg(0.5),
      chargeLength: holeDepth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: perimSeries,
      delayMs: perimSeries * 100,
      id: 'PER-BL'
    })
    holes.push({
      x: W / 2 - 0.4,
      y: 0.5,
      type: 'perimeter',
      isEmpty: false,
      depth: holeDepth,
      visRadius,
      inclination: 5,
      azimuth: 90,
      chargeKg: chargeKg(0.5),
      chargeLength: holeDepth * 0.7,
      explosiveType: 'emulsion',
      detonatorSeries: perimSeries,
      delayMs: perimSeries * 100,
      id: 'PER-BR'
    })
    return holes
  }

  // ─── 构建钻孔几何体（按类型分组共享材质/几何，性能优化）──
  _buildHoleMeshes(holes) {
    const group = new THREE.Group()
    // 孔口（圆柱孔眼的下端面）钉在掌子面、孔身向岩体(+z, 即爆破前向)深入。
    // 旧实现以前表面 frontZ=faceThickness/2+0.02 为基准、向 -Z(隧道内)延伸，导致
    // 钻孔/装药大量"出掌子面"（凸进已开挖洞身、朝相机），孔底反落隧道一侧。
    // 现改为轴向 +Z、整根孔落在岩体内；且 mouthZ 取接近 0 的负值(略朝隧道内侧凸出)，
    // 使孔口圆环浮现在掌子面表面可见——之前 0.05 埋在掌子面薄板(前表面约 0.07)之后，
    // 口部被不透明板挡住而"看不出炮孔布局"。
    const mouthZ = -0.03

    // 按类型 + visRadius 聚合，减少几何体实例数
    const geoCache = new Map()
    const matCache = new Map()
    const getGeo = (visRadius, depth) => {
      const key = `${visRadius.toFixed(3)}_${depth.toFixed(3)}`
      if (!geoCache.has(key)) {
        const g = new THREE.CylinderGeometry(visRadius, visRadius, depth, 12)
        g.rotateX(Math.PI / 2) // Y → +Z 轴向
        g.translate(0, 0, depth / 2) // 孔口(下端)置于局部 0，孔身覆盖 [0, depth] 全在岩体内
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
          emissive: isEmpty ? 0x222222 : color & 0x222222, // 空孔弱自发光
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
      // 以孔口为旋转支点：先绕局部原点(=孔口)施加倾角/方位，使孔身以正确的空间姿态向
      // 岩体深入；再平移使孔口落在掌子面 collarZ。因几何孔口位于局部原点，旋转后孔口
      // 仍保持在掌子面上，不会因倾斜而离开掌子面。
      if (h.inclination && h.inclination > 0.1) {
        const incRad = (h.inclination * Math.PI) / 180
        const aziRad = (h.azimuth * Math.PI) / 180
        mesh.rotation.set(-Math.sin(aziRad) * incRad, Math.cos(aziRad) * incRad, 0, 'XYZ')
      }
      mesh.position.set(h.x, h.y, mouthZ)

      // 孔位标注已移除：模型上不再显示每孔编号/段别/装药量标签，仅保留孔位圆柱。
      // 另在每孔口内侧加一张类型色圆盘（法线指向隧道内侧/相机），使掌子面上的布孔
      // 图案在任何视角都清晰可读，避免仅靠埋在岩体内的薄圆柱难以辨认。
      const capKey = `cap_${h.visRadius.toFixed(3)}`
      if (!geoCache.has(capKey)) {
        // 口部圆盘仅略大于孔口（1.1×），避免相邻孔圆盘相互挤压成团、掩盖布孔间距
        const disc = new THREE.CircleGeometry(h.visRadius * 1.1, 20)
        disc.rotateX(Math.PI) // XY 平面 → 法线指向 -z（朝隧道内侧/相机）
        geoCache.set(capKey, disc)
      }
      const capDisc = new THREE.Mesh(geoCache.get(capKey), mat)
      capDisc.position.set(h.x, h.y, mouthZ - 0.001)
      group.add(mesh, capDisc)
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
    const advanceDepth = Number(this.designParams?.advanceLength) || holeDepth * utilization
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
    const shapeCN =
      shapeLabel === 'horseshoe'
        ? '马蹄形'
        : shapeLabel === 'circular'
          ? '圆形'
          : shapeLabel === 'rectangular'
            ? '矩形'
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
   * 构建爆破漏斗 3D 几何（贴合掌子面破碎腔轮廓的收敛深腔）
   * @param {Array<{x:number,y:number}>} pts - 掌子面破碎腔开口轮廓点（隧道局部坐标，y=高度）
   * @param {number} depth - 腔深(m)
   */
  _buildCraterGeometry(pts, depth) {
    const geo = new THREE.BufferGeometry()
    const n = pts.length
    const d = Math.max(0.5, depth)
    const verts = []
    const uvs = [] // 漏斗共享场着色材质需要 uv（此前缺失→岩石纹理恒取 (0,0) 单色块）
    const idx = []
    const pushV = (x, y, z, u, v) => {
      verts.push(x, y, z)
      uvs.push(u, v)
    }
    // 开口环（与掌子面破碎腔轮廓严格一致）；u 沿轮廓、v 沿腔深
    for (let j = 0; j < n; j++) {
      const p = pts[j]
      pushV(p.x, p.y, 0, j / n, 0)
    }
    // 轮廓包围盒中心作为收敛基准
    const cx = pts.reduce((s, p) => s + p.x, 0) / n
    const cy = pts.reduce((s, p) => s + p.y, 0) / n
    // 收敛分层：逐层向中心缓收并沿 z 下沉，形成马蹄形深腔。
    // 全断面爆破后的空腔接近等断面（仅轻微收敛），避免过度收成"钻孔尖锥"
    // 表面抛光开启时提高细分，消漏斗"折纸"多面体感
    const rings = this.surfacePolish ? 18 : 8
    for (let ring = 1; ring <= rings; ring++) {
      const t = ring / rings
      const z = d * t * t
      const s = 1 - t * 0.35
      for (let j = 0; j < n; j++) {
        const p = pts[j]
        pushV(cx + (p.x - cx) * s, cy + (p.y - cy) * s, z, j / n, t)
      }
    }
    // 底部收口（保留较大开口而非尖点，避免"钻孔腔"观感）
    const bottomScale = 0.55
    const bottomZ = d * 1.02
    for (let j = 0; j < n; j++) {
      const p = pts[j]
      pushV(cx + (p.x - cx) * bottomScale, cy + (p.y - cy) * bottomScale, bottomZ, j / n, 1)
    }
    const bottomBase = verts.length / 3 - n
    for (let ring = 0; ring < rings; ring++) {
      for (let i = 0; i < n; i++) {
        const a = ring * n + i
        const b = ring * n + ((i + 1) % n)
        const c = a + n
        // 注意：i=n-1 时 (i+1)%n=0，e 必须回到下一环首点，不能写成 c+((i+1)%n)（会 e==c 产生退化三角形）
        const e = (ring + 1) * n + ((i + 1) % n)
        idx.push(a, b, c, b, e, c)
      }
    }
    // 底部收口面：连接最后一层收缩环与底部小环
    for (let i = 0; i < n; i++) {
      const a = rings * n + i
      const b = rings * n + ((i + 1) % n)
      const c = bottomBase + i
      const e = bottomBase + ((i + 1) % n)
      idx.push(a, b, c, b, e, c)
    }
    // 不再给漏斗底部加"平面封底盖"：封底会与后方岩体新掌子面（faceOffset+roundDepth）
    // 形成两个平行面，爆破后从洞内看呈"双层面/整体发黑"。改为开放漏斗 → 后端直接
    // 露出后方岩体新掌子面作为腔内底面，沿进尺方向只有一个面、且深腔贯通感更真实。
    // （凹马蹄底部小环直接省略三角化即可；三个以上顶点若留空，用凹轮廓耳切也无法
    // 无歧义封底，故此处不生成封底三角形。）
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    return geo
  }

  // ─── 断面内判断 ──────────────────────────────────────
  // 回退布孔用断面内判断：与 isInsideSection 同语义，0.2m 内缩防孔贴洞周/底板
  _isInsideTunnelSection(x, y, W, Hw, R) {
    return isInsideSection({ width: W, wallHeight: Hw, archRadius: R }, x, y, 0.2)
  }

  // ─── 爆破触发（切换掌子面可见性） ────────────────────
  triggerBlast() {
    this.applyBlastState(true)
  }

  /**
   * 统一应用爆破前后掌子面/待爆岩体的可见状态。
   * @param {boolean} triggered - true=已爆破（待爆循环变成开挖空腔、新掌子面前移；
   *                              外层围岩始终保留）；false=未爆破（完整掌子面+待爆循环）
   */
  applyBlastState(triggered) {
    const showFace = this.layerVisibility.face !== false
    // 外层围岩/掌子面前方岩体始终存在；爆破后整体退到新掌子面（无缝拼接）
    if (this.benchMesh) {
      this.benchMesh.visible = true
      this._setRockGeometry(triggered)
    }
    // 爆破后：待爆段变为开挖空腔壁（覆盖层），其接触环与岩体新掌子面共面
    // 【根因修正】岩体 _rockGeoPost 已自带水密的开挖空腔（空心孔洞）＋ 新掌子面端面。
    // ① 爆破漏斗(inner funnel)是一张比空腔更小、底敞开的独立壳 → 间隙/漏洞，弃用，始终隐藏。
    // ② 开挖空腔透明圆管(excavatedTube)是一张与岩体空腔壁完全重叠的"开口端压在掌子面上"
    //    的重复管壁，把它盖在端面上会让空腔退化成"没底/没掌子面的柱体"。同弃用，始终隐藏。
    // 由此爆破后只由岩体自身呈现"正常进尺（空心孔洞收口到端面）+ 清晰端面掌子面"。
    if (this.excavatedTubeMesh) this.excavatedTubeMesh.visible = false
    if (this.faceMesh) this.faceMesh.visible = !triggered && showFace
    if (this.craterMesh) this.craterMesh.visible = false
    if (this.blastHolesGroup) this.blastHolesGroup.visible = !triggered
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
        // 层开关控制外层岩体；爆破后岩体退到新掌子面，空腔壁跟随爆破状态切换
        if (this.benchMesh) {
          this.benchMesh.visible = visible
          this._setRockGeometry(blastTriggered)
        }
        // 开挖空腔透明圆管与岩体空腔壁完全重叠（开口端压在掌子面上），弃用，始终隐藏
        if (this.excavatedTubeMesh) this.excavatedTubeMesh.visible = false
        break
      case 'face':
        if (this.faceMesh) this.faceMesh.visible = visible && !blastTriggered
        // 爆破漏斗内壳已弃用（与岩体空腔间隙/漏洞的根因），始终隐藏
        if (this.craterMesh) this.craterMesh.visible = false
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

  /**
   * 控制待爆岩体表面振动场着色强度（兼容旧接口名）。
   *
   * 旧实现通过把岩体半透明化来"透显"掌子面前方体积盒（raymarching 云图），
   * 现已改为直接把应力/损伤/PPV 场渲染在岩体表面（benchMesh ShaderMaterial），
   * 故不再需要半透明。此处改为控制表面场的着色权重：
   *   semi=true  → 岩体表面按场数据着色（场强度由各像素场值决定）
   *   semi=false → 只显示岩石本色
   * @param {boolean} semi - true=显示岩体表面场着色；false=仅岩石本色
   */
  setRockSemiTransparent(semi) {
    const on = !!semi
    if (this._rockSemiTransparent === on) return
    this._rockSemiTransparent = on
    // 保持适中权重（0.62），既呈现应力/损伤/PPV 场色，又保留岩石纹理细节，
    // 避免场色完全覆盖岩面导致看不出模型细节。
    this.setBenchFieldWeight(on ? 0.62 : 0.0)
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
      next.shape === 'circular'
        ? next.archRadius * 2
        : next.shape === 'rectangular'
          ? next.wallHeight
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
