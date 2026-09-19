/**
 * 场景构建器
 *
 * 负责场景光照、隧道/掌子面/台阶网格、爆破钻孔、标注等场景元素的构建与管理。
 * 从 threeBlastingRenderer.js 中提取，遵循单一职责原则。
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import {
  creaseNormals,
  removeTrianglesOnPlane,
  sealPlaneOpenBoundaries,
  weldPositions
} from './geometrySmoothing.js'
// 断面几何判定：与 tunnelDesign 布孔过滤共用同一实现（单源）
import { isInsideSection } from '../computation/sectionShape.js'
// mulberry32（漏斗形状可复现 RNG）：单源在 utils/rng.js
import { mulberry32 } from '../utils/rng.js'
// 程序化 Canvas 纹理工厂（火/烟/火星/岩面）：拆分至 textureFactories.js。
// 本类 import 供材质创建使用，并原样 re-export 保持既有外部导入路径（threeBlastingRenderer）不变。
import {
  createFireTexture,
  createSmokeTexture,
  createSparkTexture,
  createRockTexture
} from './textureFactories.js'
export { createFireTexture, createSmokeTexture, createSparkTexture, createRockTexture }
// 回退布孔设计数据生成（菱形掏槽+辅助+周边）：外移至 computation/fallbackHoleLayout.js，
// 本类仅保留一行适配调用（designParams/kcoParams/tunnelHeight 由调用侧组装为纯函数入参）。
import { buildFallbackHoles } from '../computation/fallbackHoleLayout.js'
import {
  PPV_COLOR_STOPS_LINEAR,
  STRESS_COLOR_STOPS_LINEAR,
  DAMAGE_ZONES,
  buildDamageLutData,
  NORM_FLOOR,
  NORM_LOG_SPAN,
  KNEE_WARP_A,
  KNEE_WARP_B,
  glslNum,
  INDUSTRIAL_BANDS_DEFAULT,
  industrialBandCount,
  industrialContourColor,
  buildIndustrialLutGradient,
  LUT_TEXELS
} from './vibrationColorScales.js'
// 剖面剖切算法（CSG 剪切/截面环提取/区域三角化/剖面填充）：拆分至 sectionCutter.js，
// 本类仅保留公共入口一行委托；剖切状态仍挂本类，由 SectionCutter 经 sb 直读直写。
import { SectionCutter } from './sectionCutter.js'
// 岩面场着色器 GLSL 主体（?raw 原文导入；组装与逐字符等价性见下方 BENCH_FIELD_* 注释）
import benchFieldVertSrc from './benchField.vert.glsl?raw'
import benchFieldFragSrc from './benchField.frag.glsl?raw'

// 着色器字面量：归一化标尺与膝形压缩拐点全部由 vibrationColorScales.js 单源注入，
// 避免 GLSL 里再出现一份手写常量（图例/等值线/热力图四处漂移的历史根因）。
//
// 用 #define 前导串 + 字符串拼接注入（不用模板插值）：模板插值会与着色器本体
// 混在一起，宏前导更易核对，也不受构建链对 ${} 的处理差异影响。
const SH_NORM_MACROS =
  '#define NORM_FLOOR ' +
  glslNum(NORM_FLOOR) +
  '\n#define NORM_LOG_SPAN ' +
  glslNum(NORM_LOG_SPAN) +
  '\n#define KNEE_A ' +
  glslNum(KNEE_WARP_A) +
  '\n#define KNEE_B ' +
  glslNum(KNEE_WARP_B) +
  '\n'

// ─── 等值线级别取色辅助（与热力图 LUT 同口径）──────────
// 线性工作色空间白色：setRGB(..., SRGBColorSpace) 已转到线性域，lerp 目标同为线性白
const _WHITE = new THREE.Color(1, 1, 1)

// 复用 Matrix3 临时量（getContourSurface 法线换算，避免每次调用分配）
const _mat3 = new THREE.Matrix3()

/**
 * 在色阶 [v, [r,g,b]]（线性域，v 升序）上按标量值线性插值取色。
 * 与 GPU 侧 LUT 纹理（v 归一化到 [0,1] 纹理坐标）等价：CPU 传 v、GPU 传 v/max。
 */
function _sampleStops(stops, v) {
  const n = stops.length
  if (n === 0) return [0, 0, 0]
  if (v <= stops[0][0]) return stops[0][1]
  for (let i = 1; i < n; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1]
      const [v1, c1] = stops[i]
      const t = v1 - v0 > 1e-9 ? (v - v0) / (v1 - v0) : 0
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return stops[n - 1][1]
}

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
//          → 纹理坐标 uvw = (g - boundsMin) / (boundsMax - boundsMin)
/** 岩石底纹 UV 缩放（= 100m 一格；见顶点着色器内注释，1.0 即"1 米一格"会摩尔纹） */
const ROCK_UV_SCALE_NUM = 0.01

// 岩体表面振动场着色器：GLSL 主体外移至 benchField.vert.glsl / benchField.frag.glsl
//（?raw 原文导入）。组装保持与外移前逐字符等价：
// - 顶点：.glsl 内保留唯一插值占位 ${ROCK_UV_SCALE_NUM}，此处以现有常量替换
//  （保留胶水拼接；若前置 #define 会引入额外行、破坏"拆分前后逐字符等价"）。
// - 片元：SH_NORM_MACROS（JS 单源宏前导，含 NORM_FLOOR/NORM_LOG_SPAN/KNEE_A/KNEE_B）
//  拼在最前 + 纯 GLSL 主体，拼接顺序与外移前一致（宏在 precision 之前亦合法）。
// 注：损伤阈值 20/50/100/200 cm/s 在片元主体内为字面常量（注释指明与后端
//  DAMAGE_THRESHOLDS_CMPS 同口径），GLSL 内不存在 ${DAMAGE_THRESHOLDS_CMPS[]} 插值，
//  故无需 DAMAGE_T0..3 宏注入。
const BENCH_FIELD_VERTEX_SHADER = benchFieldVertSrc.replace(
  '${ROCK_UV_SCALE_NUM}',
  String(ROCK_UV_SCALE_NUM)
)
const BENCH_FIELD_FRAGMENT_SHADER = SH_NORM_MACROS + benchFieldFragSrc

/** 场图层淡入时长(ms)：开关热力图时的平滑过渡，替代此前的硬切 */
export const FIELD_FADE_MS = 320

/** 默认场着色参数（无数据时的占位） */
const BENCH_FIELD_DEFAULTS = {
  displayMode: 0,
  fieldWeight: 0.0,
  ppvRefMps: 0.15,
  stressRefMPa: 30.0,
  chargeKg: 100,
  sadoskyK: 30,
  sadoskyAlpha: 1.5,
  sadoskyBeta: 0.02,
  ppvVisualBeta: 0.8, // PPV 可视化时变衰减(1/s)：波峰回落实时速度（见 computePpvField3d）
  visualCp: 35,
  // 波包子波载波频率(Hz)：空间波长 λ=visualCp/f。
  // 默认关闭（0=纯包络）：正面近距离/掠射角下，即使 2Hz 也会把多源相位
  // 叠加投影成规则斜纹。需要观察行波环时，用户仍可在面板手动开启。
  carrierHz: 0,
  // 波前起跳沿(s)：见 uArrivalRise 注释。
  // 数值依据（46 源实测，相邻 0.04m 的 iVal 跳变）：0 → 最大 13 级色阶；
  // 0.05 → 5.1 级；0.15 → 3.8 级。74 源时还会更密，故默认取较大的 0.25。
  // 代价：起跳沿 × 35 m/s = 视觉上的波前带宽，过大会把行波环糊掉。
  arrivalRise: 0.25,
  // 峰值方法：1=时域错峰叠加（默认，杨年华 2012 时域叠加口径，与后端
  // peak_ppv_envelope_multi peak_method='history' 同口径）；0=全源同时叠加保守上界
  peakHistory: 1,
  // ρ·c_p/(1−μ_d)，默认 ρ=2650, c_p=4500, μ_d=0.8ν=0.2 → 2650×4500/0.8=1.49e7
  // （σ_vm=ρ·c_p·v/(1−μ_d)，径向压+切向拉，动态泊松比见 computeStressFieldFromPpv；
  //   与 blastingManager 应力量程/后端 stress_field_from_ppv dynamic_poisson 同口径）
  stressFactor: 1.49e7
}

/** HSV → RGB（0..1），矢量箭头场按模长取色用 */
function _hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0:
      return [v, t, p]
    case 1:
      return [q, v, p]
    case 2:
      return [p, v, t]
    case 3:
      return [p, q, v]
    case 4:
      return [t, p, v]
    default:
      return [v, p, q]
  }
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
    // 表面抛光开关（构造层级默认开，外部可用 config.surfacePolish 关闭做 A/B）
    this.surfacePolish = ENABLE_SURFACE_POLISH && config.surfacePolish !== false
    // 剖面裁剪的"场景级请求"：剖切是直接改 benchMesh.geometry 的副作用，而爆破状态机
    // 会在起爆/回卷/seek 时把 geometry 换回 _rockGeoPre/_rockGeoPost。为让剖面不随拖动
    // 丢失，把"剖切请求"存这里，在 _setRockGeometry 换基时对同一平面重新剖切。
    this._sectionEnabled = false
    this._sectionAxis = 0
    this._sectionPos = null // 已解析的平面局部坐标（沿轴），换基后原样重切
    // 自动量程标记：applyFieldPhysics 注入代表性峰值后置 true，
    // setBenchFieldData 不再用固定上限覆盖（避免解析场全场饱和度）
    this._autoRefApplied = false
    // 场图层淡入状态（updateFieldFade 每帧推进；见 setFieldWeightTarget）
    this._rockSemiTransparent = false
    this._fieldWeightNow = 0
    this._fieldWeightTarget = 0
    this._fieldFadeT0 = null
    this._fieldFadeFrom = 0
    // 剖切结果缓存：键=基础几何对象（pre/post），值={axis,pos,geo}。
    // 播放时间轴在 pre/post 间互换几何时直接复用，避免每次对整块岩体重算 CSG 导致卡顿。
    this._sectionCache = new Map()

    // 剖面剖切算法组（SectionCutter，sectionCutter.js）：剖切状态（_sectionEnabled/
    // _sectionPos/_sectionCache/_sliceCutGeo 等）仍挂本类，算法经 sb 引用直读直写
    this._sectionCutter = new SectionCutter(this)

    // ── MS 等值线（Line2 渲染组）───────────────────────────
    // 几何由 blastingManager 调 contourExtractor 在峰值场上提取后经
    // setContourPolylines 下发；本类只负责构建/样式/波前门控与显隐。
    this._contourGroup = null // THREE.Group（挂 scene，含 LineSegments2）
    this._contourMesh = null // LineSegments2（全部级别合一实例）
    this._contourMaterial = null // LineMaterial（像素线宽 + onBeforeCompile 注入 arrival 门控）
    this._contourInput = null // 最近一次下发的 { polylines, displayMode, normMode, refs }（样式变更时重建）
    this._contourArrUniform = { value: 1e9 } // 波前门控时间(s)：t < arrival 的段透明
    this._contourFadeUniform = { value: 0.1 } // 门控淡入宽度(s)
    this._contourFieldOn = false // 热力图图层开启（uFieldWeight>0）才显示等值线
    // 等力线默认关闭：几何等值线是叠加层，不属于热力场本身；在正面近视角
    // 会把三角网格/等值线段放大成规则斜纹。用户仍可通过面板手动开启。
    this._isoLineOn = false // 等值线开关（面板 toggle-iso-line）
    this._isoLineWidth = 2.0 // 像素线宽
    this._isoLineColor = null // null=按级别取 LUT 色（提亮）；指定 CSS 色则全线统一
    this._benchGeoVersion = 0 // 岩体几何版本（build/爆后切换/剖切时 +1，驱动 manager 重提取）
    this._contourSurfaceCache = null // getContourSurface 版本缓存 {version, mesh, data}

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
    // 等值线渲染组：随岩体一并清空（新事件由 blastingManager 重新下发折线）
    if (this._contourMesh) {
      this._contourGroup?.remove(this._contourMesh)
      this._contourMesh.geometry.dispose()
      this._contourMesh = null
    }
    if (this._contourMaterial) {
      this._contourMaterial.dispose()
      this._contourMaterial = null
    }
    if (this._contourGroup) {
      this.scene.remove(this._contourGroup)
      this._contourGroup = null
    }
    this._contourInput = null
    this._contourFieldOn = false
    this._contourSurfaceCache = null // 顶点导出缓存随岩体一并失效
    if (this._vectorFieldGroup) {
      this.scene.remove(this._vectorFieldGroup)
      this._vectorFieldGroup.traverse(o => {
        if (o.geometry?.dispose) o.geometry.dispose()
        if (o.material?.dispose) o.material.dispose()
      })
      this._vectorFieldGroup = null
      this._vectorFieldMesh = null
    }
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
    // 场着色材质释放：bench 与 face 共用的 LUT 统一在此清理一次
    this._benchFieldMaterial = null
    this._faceFieldMaterial = null
    if (this._fieldPpvLut) {
      this._fieldPpvLut.dispose()
      this._fieldPpvLut = null
    }
    if (this._fieldStressLut) {
      this._fieldStressLut.dispose()
      this._fieldStressLut = null
    }
    if (this._fieldDamageLut) {
      this._fieldDamageLut.dispose()
      this._fieldDamageLut = null
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
    // 岩体几何就绪：版本 +1 驱动 blastingManager 重新提取等值线峰值场
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
    const benchLength = this.benchLength
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
    // 未爆破的岩体为不透明实体：应力/PPV/损伤场直接着色在其表面（不穿透显内腔）。
    this._benchFieldMaterial = this._createFieldMaterial(ctx.benchMat, {
      opacity: 1,
      transparent: true,
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
    this._attachRockOutline(this.benchMesh, 0.55)
    // 波场可达半径 = 爆心 → 岩体几何最远顶点（波一直衰减到模型边界，不中途截断）
    this._syncInfluenceRadius()
  }

  /**
   * 按"爆心 → 岩体几何包围盒最远顶点"实测波场可达半径并下发给场材质。
   * 语义：波在岩体内按 r^-α·e^(-βt) 连续衰减，到岩体几何边界时已不足可见下限
   * → 表面观感就是"传播到模型边界即消失"；一阶解析模型无反射/衍射，不产生回波。
   * 取包围盒顶点而非三角面顶点：保证覆盖整块岩体且略有余量，内切角处不被切掉。
   */
  _syncInfluenceRadius() {
    const mesh = this.benchMesh
    if (!mesh) return
    mesh.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(mesh)
    if (box.isEmpty()) return
    const c = this._benchFieldMaterial?.uniforms?.uCenter?.value
    const ox = c ? c.x : 0
    const oy = c ? c.y : 0
    const oz = c ? c.z : 0
    let rMax = 0
    for (const sx of [box.min.x, box.max.x]) {
      for (const sy of [box.min.y, box.max.y]) {
        for (const sz of [box.min.z, box.max.z]) {
          const dx = sx - ox
          const dy = sy - oy
          const dz = sz - oz
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (r > rMax) rMax = r
        }
      }
    }
    if (!(rMax > 0)) return
    this._influenceRadius = rMax
    for (const m of this._fieldMaterials()) {
      if (m.uniforms.uInfluenceRadius) m.uniforms.uInfluenceRadius.value = rMax
    }
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
      this._benchGeoVersion++ // pre/post 几何互换 → 等值线需重提取
      return
    }
    if (mesh.geometry !== next) {
      mesh.geometry = next
      // 几何切换后同步轮廓线（pre/post 外廓不同，避免显示陈旧的外形轮廓）
      this._attachRockOutline(mesh)
      this._benchGeoVersion++ // pre/post 几何互换 → 等值线需重提取
    }
  }

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

  /**
   * 在网格外轮廓上贴一圈高亮轮廓线（EdgesGeometry + LineSegments），
   * 使岩体在暗背景巷道或振动场热力图满铺时仍能看出清晰轮廓。
   * 轮廓线作为网格子节点，随父网格隐藏/显隐；几何替换时调用本方法重建。
   * @param {THREE.Mesh} mesh - 目标网格（岩体 / 掌子面）
   * @param {number} [opacity=0.9] - 轮廓线透明度（岩体大块实体用低值细淡，掌子面断面用高值清晰）
   */
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
    // （实测爆破前只有 200 段 / 8 条长边，爆后骤增到 750 段，正是用户在正面看到的）。
    // 岩体真实轮廓棱边全在十米级，故按几何包围盒尺度取阈值，只保留真正的轮廓边。
    edges = this._filterShortEdges(edges, mesh.geometry)
    // 剖切激活时：切面本身是平直平面，其 ear-clipping 三角剖分会产生共面(≈0°/180°)
    // 的伪折痕边，EdgesGeometry 会把它们渲染成切面上的一堆三角线。把"两个端点都落在
    // 剖切平面"上的边整体剔除，只保留岩体向切面以外延伸的真实外轮廓锐利折边。
    if (this._lastCutAxis != null && Number.isFinite(Number(this._lastCutPos))) {
      edges = this._filterEdgesOnPlane(edges, this._lastCutAxis, Number(this._lastCutPos))
    }
    const mat = new THREE.LineBasicMaterial({
      color: 0xbfe0ff, // 冷白描边，暗背景下醒目且与热力暖色区分
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
  _createFieldMaterial(baseMat, opts = {}) {
    const opacity = opts.opacity ?? 1
    const transparent = opts.transparent ?? opacity < 1
    const depthWrite = opts.depthWrite ?? true
    // 工业离散色带 LUT（N 档 Jet，档内纯色）：PPV 与应力共用同一色带与档数，
    // 档数可经 setFieldNormBands 重建（与 UI 等值线密度同源）
    // 【宽度固定 256 texel】色带铺满 256 个 texel 的光滑渐变表（见
    // vibrationColorScales.buildIndustrialLutGradient 注释：只有 N 个 texel 时，
    // 连续 norm 采样会把同一 texel 拉伸成屏幕上的竖向条纹）。档数记在 userData，
    // 纹理宽度不再等于档数，守卫不能再用 width 比对。
    if (!this._fieldPpvLut || this._fieldPpvLut.userData?.bands !== this._fieldNormBands) {
      this._fieldNormBands = industrialBandCount(this._fieldNormBands)
      this._fieldPpvLut?.dispose()
      this._fieldPpvLut = new THREE.DataTexture(
        buildIndustrialLutGradient(this._fieldNormBands),
        LUT_TEXELS,
        1,
        THREE.RGBAFormat
      )
      this._fieldPpvLut.userData.bands = this._fieldNormBands
      // 线性过滤：连续 norm 采样时在相邻 texel 之间插值 → 平滑色阶（Nearest 会出硬边）
      this._fieldPpvLut.minFilter = THREE.LinearFilter
      this._fieldPpvLut.magFilter = THREE.LinearFilter
      this._fieldPpvLut.wrapS = THREE.ClampToEdgeWrapping
      this._fieldPpvLut.needsUpdate = true
    }
    if (!this._fieldStressLut || this._fieldStressLut.userData?.bands !== this._fieldNormBands) {
      this._fieldStressLut?.dispose()
      this._fieldStressLut = new THREE.DataTexture(
        buildIndustrialLutGradient(this._fieldNormBands),
        LUT_TEXELS,
        1,
        THREE.RGBAFormat
      )
      this._fieldStressLut.userData.bands = this._fieldNormBands
      this._fieldStressLut.minFilter = THREE.LinearFilter
      this._fieldStressLut.magFilter = THREE.LinearFilter
      this._fieldStressLut.wrapS = THREE.ClampToEdgeWrapping
      this._fieldStressLut.needsUpdate = true
    }
    // 损伤五色 LUT（静态，由 vibrationColorScales.DAMAGE_ZONES 单源生成）
    if (!this._fieldDamageLut) {
      this._fieldDamageLut = new THREE.DataTexture(buildDamageLutData(), 5, 1, THREE.RGBAFormat)
      // 线性取色：损伤五色 LUT 按 (zone+0.5)/5 采样，Linear 过滤在相邻分区色间插值
      // Linear 过滤在相邻分区色间插值 → 损伤边界平滑过渡（无硬色带/方块）
      this._fieldDamageLut.minFilter = THREE.LinearFilter
      this._fieldDamageLut.magFilter = THREE.LinearFilter
      this._fieldDamageLut.wrapS = THREE.ClampToEdgeWrapping
      this._fieldDamageLut.needsUpdate = true
    }
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uRockMap: { value: baseMat?.map || createRockTexture() },
        uPpvLut: { value: this._fieldPpvLut },
        uStressLut: { value: this._fieldStressLut },
        uDamageLut: { value: this._fieldDamageLut },
        uBoundsMin: { value: new THREE.Vector3(0, 0, 0) },
        uBoundsMax: { value: new THREE.Vector3(1, 1, 1) },
        uCenter: { value: new THREE.Vector3() },
        uBlastOrigin: { value: new THREE.Vector3(0, 0, 0) },
        // 多装药源（各炮孔装药段）：与片段着色器 MAX_SOURCES=96 对齐。
        // uSourceCount=0 时片段着色器退化为单一 uBlastOrigin 源（同心圆退化分支）。
        uSourceCount: { value: 0 },
        uSourcePosQ: { value: Array.from({ length: 96 }, () => new THREE.Vector4(0, 0, 0, 0)) },
        uSourceDelay: { value: new Array(96).fill(0) },
        // 峰值方法：1=时域错峰叠加（默认）；0=全源同时叠加保守上界
        uPeakHistory: { value: BENCH_FIELD_DEFAULTS.peakHistory },
        uRight: { value: new THREE.Vector3(1, 0, 0) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uForward: { value: new THREE.Vector3(0, 0, 1) },
        uDisplayMode: { value: BENCH_FIELD_DEFAULTS.displayMode },
        uFieldWeight: { value: BENCH_FIELD_DEFAULTS.fieldWeight },
        uWhiteModel: { value: 0 }, // 默认关闭白模：保留岩石纹理底，场色叠在岩色上
        uPpvRefMps: { value: BENCH_FIELD_DEFAULTS.ppvRefMps },
        uStressRefMPa: { value: BENCH_FIELD_DEFAULTS.stressRefMPa },
        // 显示侧动态满量程（P99.9 展开因子）：lin*=S 使当前场实际分布铺满色域，
        // 避免固定满刻度锚在近场峰值时全场塌缩成低端深蓝。S>1 为展开（ref 相对
        // P99.9 过大）；1=基准满刻度。由 blastingManager 从峰值场 P99.9 反解并
        // 经 applyFieldPhysics.normAutoScale 下发；若缺失必须为 1，否则 lin*=0 全黑。
        uNormAutoScale: { value: 1 },
        // 场盒外解析外推（萨道夫斯基）用参数，默认与后端/本地模拟器缺省一致
        uChargeKg: { value: BENCH_FIELD_DEFAULTS.chargeKg },
        uSadoskyK: { value: BENCH_FIELD_DEFAULTS.sadoskyK },
        uSadoskyAlpha: { value: BENCH_FIELD_DEFAULTS.sadoskyAlpha },
        uSadoskyBeta: { value: BENCH_FIELD_DEFAULTS.sadoskyBeta },
        uPpvVisualBeta: { value: BENCH_FIELD_DEFAULTS.ppvVisualBeta },
        uArrivalRise: { value: BENCH_FIELD_DEFAULTS.arrivalRise },
        // 波动相位载波（视觉 Hz，默认关闭）：瞬时质点速度 v(t)=A·e^-βt·sin(2πf·t)
        // 是真实衰减振荡波形，多源相位差（各炮孔延期差+路径差）转化为相长/相消干涉纹。
        // 0=关闭并退化为单调包络（场值=非相干包络），避免正面近距离出现规则纹路。
        // 用户可通过面板手动开启行波脉冲环。
        uCarrierHz: { value: BENCH_FIELD_DEFAULTS.carrierHz },
        // 色彩映射标尺：1=对数（默认，适应幂律衰减），0=线性
        uNormMode: { value: 1 },
        uVisualCp: { value: BENCH_FIELD_DEFAULTS.visualCp },
        uSimTime: { value: 0 },
        // 掌子面自由面反射（镜象源法）：默认开（自由面近全反射，系数 0.85），
        // 反射面 z=掌子面（faceOffset，grid 局部系），由 applyFieldPhysics 下发
        uFaceZ: { value: 3 },
        uReflectOn: { value: 1 },
        uReflectCoeff: { value: 0.85 },
        uFieldTranslucent: { value: 0 }, // 半透明渲染（0=实色 0.85，1=半透明 0.55）
        uTunnelFloorY: { value: 0 }, // 隧道底板 y（grid 局部系）
        uTunnelArchH: { value: 6 }, // 直墙高 Hw（拱冠圆心位于 floorY+Hw）
        uFaceBoostCoeff: { value: 0 }, // 轮廓自由面放大（0=关）
        uFaceBoostLambda: { value: 1.2 }, // 自由面放大空间衰减长度(m)
        // 洞身截断 & 轴向延展默认占位(被 setBenchFieldData / buildBenchGeometry 覆盖)
        uHoleRadius: { value: 9 },
        uHoleLen: { value: 2.5 },
        uLateralAttn: { value: 0.95 },
        // P0-2 解析场包络 & P0-1 损伤软边缘（可调滑块下发，与后端 influenceRadius /
        // damageMaxRadius 同口径）：超 influenceRadius 强度线性归零 → 场紧贴掌子面；
        // 距爆源超 (damageMaxRadius−falloff) 损伤等级平滑衰减到 0（非硬切一刀切）。
        // 包络默认 15m：断面尺度下 30m 会让应力场铺满整个断面、失去近场聚焦
        // （UI 滑块可调，与 blastingManager._vibInfluenceRadius 同默认）
        uInfluenceRadius: { value: this._influenceRadius || 60 }, // 实测可达半径（缺省 60）
        uInfluenceFade: { value: 4 },
        uDamageMaxRadius: { value: 7 },
        uDamageFalloff: { value: 2 },
        uStressFactor: { value: BENCH_FIELD_DEFAULTS.stressFactor },
        // 应力近场几何修正（见 localVibrationSimulator 的 NEAR_FIELD_* 注释）：
        // 缺省 0=关，由 applyFieldPhysics 按装药量反算的 r_nf 下发
        uStressNfR: { value: 0 },
        uStressNfA: { value: 0 },
        // 工业风格：14 档离散 Jet 色阶 + 硬边/不透明/白模底（默认开启）
        uNormBands: { value: INDUSTRIAL_BANDS_DEFAULT },
        // 零场抬亮强度（归一化色阶分数）：0=关。0.05 → 零场落到色阶 5% 处（浅蓝），
        // 远离 Jet 0 档（≈纯黑），消除死黑麻点。
        uZeroLift: { value: 0.05 },
        uIndustrialStyle: { value: 1 },
        uRockColor: { value: new THREE.Color(baseMat?.color || 0xb8946e) },
        // 方向光（世界空间，归一化）：上右前，模拟隧道内主照明方向
        uSunDir: { value: new THREE.Vector3(0.55, 0.75, 0.45).normalize() },
        uGlobalOpacity: { value: opacity },
        uSectionEnabled: { value: 0 },
        uSectionNWorld: { value: new THREE.Vector3(1, 0, 0) },
        uSectionCWorld: { value: 0 },
        uSectionAxis: { value: 0 },
        uSectionPos: { value: 0 }
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
   * 控制振动场等值线显示与样式。
   * 等值线已改为几何渲染（contourExtractor 峰值场提取 + Line2 渲染组）：
   *   - on：显隐开关（面板 toggle-iso-line）；
   *   - width：像素线宽（0.5~8）；
   *   - color：null/缺省=按级别取热力图 LUT 色（向白提亮，级别可辨）；
   *            传入 CSS 色则所有级别统一色。
   * 密度（级别数）由 blastingManager 的 computeContourLevels 决定，不在此设置。
   */
  setIsoLine({ on = true, width, color } = {}) {
    this._isoLineOn = !!on
    if (width != null) this._isoLineWidth = Math.max(0.5, Math.min(8, Number(width) || 2))
    if (color !== undefined) this._isoLineColor = color || null
    if (this._contourMaterial) this._contourMaterial.linewidth = this._isoLineWidth
    this._updateContourVisibility()
    // 样式变更（颜色）需重算实例色数组 → 基于最近输入整体重建（几何不变，代价小）
    if ((color !== undefined || width != null) && this._contourInput) this._buildContourMesh()
  }

  /** 等值线组显隐 = 面板开关 ∧ 热力图图层开启 */
  _updateContourVisibility() {
    if (this._contourGroup) this._contourGroup.visible = this._isoLineOn && this._contourFieldOn
  }

  /**
   * 设置干涉载波频率（视觉 Hz）：瞬时质点速度 × cos(2πf·gap) 形成多孔延时
   * 干涉波纹（相位差=延期差+路径差）。0=关闭退化为单调包络叠加。
   */
  setCarrierHz(hz) {
    const v = Math.max(0, Math.min(48, Number(hz) || 0))
    for (const m of this._fieldMaterials()) m.uniforms.uCarrierHz.value = v
  }

  /** 设置色彩映射标尺：0=线性，1=对数（默认，适应 PPV/应力幂律衰减） */
  setNormMode(mode) {
    const v = Number(mode) > 0 ? 1 : 0
    for (const m of this._fieldMaterials()) m.uniforms.uNormMode.value = v
  }

  /** 设置半透明渲染（1=场色上限 0.55 露出岩底，0=实色 0.85） */
  setFieldTranslucent(on) {
    const v = on ? 1 : 0
    for (const m of this._fieldMaterials()) m.uniforms.uFieldTranslucent.value = v
  }

  /**
   * 设置隧道轮廓自由面（SDF 放大）参数。
   * @param {Object} p - { coeff, lambda, floorY, archH }（缺省项保持现状）
   */
  setTunnelFace(p = {}) {
    for (const m of this._fieldMaterials()) {
      const u = m.uniforms
      if (Number.isFinite(Number(p.coeff))) u.uFaceBoostCoeff.value = Number(p.coeff)
      if (Number.isFinite(Number(p.lambda)) && p.lambda > 0)
        u.uFaceBoostLambda.value = Number(p.lambda)
      if (Number.isFinite(Number(p.floorY))) u.uTunnelFloorY.value = Number(p.floorY)
      if (Number.isFinite(Number(p.archH)) && p.archH > 0) u.uTunnelArchH.value = Number(p.archH)
    }
  }

  // ─── 矢量箭头场（P1-6：展示波传播方向）──────────────────
  // LineSegments 线箭头：每个箭头 = 轴杆(2 顶点) + 头部左右两条短线(4 顶点)。
  // 数据来自 blastingManager（与热图同一多源模型逐帧计算），只做几何装配。
  /**
   * 下发矢量箭头场数据并装配渲染组。
   * @param {Object|null} data - { origin: Float32Array(N*3 grid 局部), dir: Float32Array(N*3),
   *                              scale: Float32Array(N) 单位长度因子（模长/参考，0~1）}
   *                             null = 清空隐藏
   */
  setVectorField(data) {
    if (!data) {
      if (this._vectorFieldGroup) this._vectorFieldGroup.visible = false
      return
    }
    if (!this._vectorFieldGroup) {
      this._vectorFieldGroup = new THREE.Group()
      this._vectorFieldGroup.name = 'vibrationVectorField'
      this.scene.add(this._vectorFieldGroup)
    }
    this._vectorFieldGroup.visible = true
    this._buildVectorFieldMesh(data)
  }

  _buildVectorFieldMesh(data) {
    const { origin, dir, scale } = data
    if (!origin || !dir || !scale) return
    const n = origin.length / 3
    if (n === 0) return
    const u = this._benchFieldMaterial?.uniforms
    if (!u) return
    const c = u.uCenter.value
    const r = u.uRight.value
    const up = u.uUp.value
    const f = u.uForward.value
    // 预分配可复用几何（容量 512 箭头，避免每帧 new BufferGeometry / GPU 重传）
    this._ensureVectorFieldGeometry(Math.max(n, 512))
    const verts = this._vectorFieldPosAttr.array
    const cols = this._vectorFieldColAttr.array
    const maxN = this._vectorFieldCapacity
    for (let i = 0; i < n && i < maxN; i++) {
      const lx = origin[i * 3],
        ly = origin[i * 3 + 1],
        lz = origin[i * 3 + 2]
      const dx = dir[i * 3],
        dy = dir[i * 3 + 1],
        dz = dir[i * 3 + 2]
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6
      const s = Math.max(0.06, Math.min(1, Number(scale[i]) || 0))
      const len = 0.35 + s * 1.4 // 0.4~1.75m
      const ux = dx / dl,
        uy = dy / dl,
        uz = dz / dl
      // 原点与终点（grid 局部 → 世界：正交基投影）
      const px = c.x + lx * r.x + ly * up.x + lz * f.x
      const py = c.y + lx * r.y + ly * up.y + lz * f.y
      const pz = c.z + lx * r.z + ly * up.z + lz * f.z
      const qx = px + len * (ux * r.x + uy * up.x + uz * f.x)
      const qy = py + len * (ux * r.y + uy * up.y + uz * f.y)
      const qz = pz + len * (ux * r.z + uy * up.z + uz * f.z)
      // 颜色：按模长映射 HSV 青→品红（0 低 → 1 高）
      const hue = 0.55 - s * 0.45
      const col = _hsvToRgb(hue, 0.85, 0.95)
      const base = i * 18
      verts[base] = px
      verts[base + 1] = py
      verts[base + 2] = pz
      verts[base + 3] = qx
      verts[base + 4] = qy
      verts[base + 5] = qz
      // 头部：垂直于箭杆的侧向（局部叉积，正交基下与世界等价）
      let crossX = uy * 1 - uz * 0,
        crossY = uz * 0 - ux * 1,
        crossZ = ux * 0 - uy * 0
      const cl = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ)
      if (cl < 1e-3) {
        crossX = 1
        crossY = 0
        crossZ = 0
      } else {
        crossX /= cl
        crossY /= cl
        crossZ /= cl
      }
      const hw = 0.22
      const hb = 0.55
      const mx = qx - len * hb * ux - hw * crossX
      const my = qy - len * hb * uy - hw * crossY
      const mz = qz - len * hb * uz - hw * crossZ
      const nx2 = qx - len * hb * ux + hw * crossX
      const ny2 = qy - len * hb * uy + hw * crossY
      const nz2 = qz - len * hb * uz + hw * crossZ
      verts[base + 6] = qx
      verts[base + 7] = qy
      verts[base + 8] = qz
      verts[base + 9] = mx
      verts[base + 10] = my
      verts[base + 11] = mz
      verts[base + 12] = qx
      verts[base + 13] = qy
      verts[base + 14] = qz
      verts[base + 15] = nx2
      verts[base + 16] = ny2
      verts[base + 17] = nz2
      for (let k = 0; k < 6; k++) {
        cols[base + k * 3] = col[0]
        cols[base + k * 3 + 1] = col[1]
        cols[base + k * 3 + 2] = col[2]
      }
    }
    this._vectorFieldGeometry.setDrawRange(0, n * 6)
    this._vectorFieldPosAttr.needsUpdate = true
    this._vectorFieldColAttr.needsUpdate = true
    this._vectorFieldMesh.frustumCulled = false
    this._vectorFieldGroup.visible = true
  }

  /** 确保矢量箭头 LineSegments 几何存在且有足够容量（复用属性缓冲） */
  _ensureVectorFieldGeometry(capacity) {
    if (this._vectorFieldMesh && this._vectorFieldCapacity >= capacity) return
    if (this._vectorFieldMesh) {
      this._vectorFieldGroup.remove(this._vectorFieldMesh)
      this._vectorFieldMesh.geometry.dispose()
      this._vectorFieldMesh.material.dispose()
      this._vectorFieldMesh = null
    }
    this._vectorFieldCapacity = capacity
    const verts = new Float32Array(capacity * 18) // 每箭头 6 顶点 ×3
    const cols = new Float32Array(capacity * 18)
    const geo = new THREE.BufferGeometry()
    this._vectorFieldPosAttr = new THREE.BufferAttribute(verts, 3).setUsage(THREE.DynamicDrawUsage)
    this._vectorFieldColAttr = new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this._vectorFieldPosAttr)
    geo.setAttribute('color', this._vectorFieldColAttr)
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false
    })
    this._vectorFieldGeometry = geo
    this._vectorFieldMesh = new THREE.LineSegments(geo, mat)
    this._vectorFieldGroup.add(this._vectorFieldMesh)
  }

  /** 清空/隐藏矢量箭头场渲染组 */
  clearVectorField() {
    if (this._vectorFieldGroup) this._vectorFieldGroup.visible = false
  }

  // ─── MS 等值线渲染组（Line2）────────────────────────────

  /**
   * 下发等值线折线组（contourExtractor 输出，grid 局部系）并构建 Line2 渲染组。
   * @param {Object} data
   * @param {Array} data.polylines - [{ positions: Float32Array(grid 局部 m),
   *        normals: Float32Array|null, arrival: Float32Array|null, closed, level }]
   * @param {number} [data.displayMode=0] - 0=PPV 1=STRESS 2=DAMAGE（决定级别取色）
   * @param {number} [data.normMode=1] - 0=线性 1=对数（与热力图标尺一致）
   * @param {number} [data.ppvRefMps] - PPV 满刻度(m/s)
   * @param {number} [data.stressRefMPa] - 应力满刻度(MPa)
   * @param {number} [data.stressFactor] - ρ·c_p/(1−ν)（Pa per m/s）
   */
  setContourPolylines(data) {
    this._contourInput = data || null
    this._buildContourMesh()
  }

  /** 由 _contourInput 重建 LineSegments2（下发/样式变更时调用） */
  _buildContourMesh() {
    // 清理旧实例（几何与材质都属一次性，重建代价在 ms 级）
    if (this._contourMesh) {
      this._contourGroup?.remove(this._contourMesh)
      this._contourMesh.geometry.dispose()
      this._contourMesh = null
    }
    if (this._contourMaterial) {
      this._contourMaterial.dispose()
      this._contourMaterial = null
    }
    const data = this._contourInput
    const polylines = data?.polylines
    const u = this._benchFieldMaterial?.uniforms
    if (!Array.isArray(polylines) || polylines.length === 0 || !u) {
      this._updateContourVisibility()
      return
    }
    const center = u.uCenter.value
    const right = u.uRight.value
    const up = u.uUp.value
    const forward = u.uForward.value

    // —— 级别取色：与热力图 LUT 同源（vibrationColorScales 单源真相）——
    // level 为峰值 PPV(m/s)；按显示模式换算到色阶坐标后取色，再向白提亮
    // （mix 0.62）保证在深蓝→亮红各色带上均清晰可辨、级别间仍有区分度。
    const displayMode = Number(data.displayMode) || 0
    const normMode = Number(data.normMode) > 0 ? 1 : 0
    const ppvRefMps = Number(data.ppvRefMps) > 0 ? Number(data.ppvRefMps) : 0.15
    const stressRefMPa = Number(data.stressRefMPa) > 0 ? Number(data.stressRefMPa) : 30
    const stressFactor = Number(data.stressFactor) > 0 ? Number(data.stressFactor) : 1.59e7
    const levelColor = new THREE.Color()
    const levelCache = new Map()
    const getLevelColor = level => {
      const key = level.toFixed(6)
      let c = levelCache.get(key)
      if (c) return c
      if (this._isoLineColor) {
        c = new THREE.Color(this._isoLineColor)
      } else if (displayMode === 2) {
        // 损伤模式：级别即分区阈值 → 取对应分区色并提亮
        const cmps = level * 100
        // 级别即分区边界（computeContourLevels 损伤档 = 20/50/100/200 cm/s），
        // 映射到对应分区色；须与后端/localVibrationSimulator/shader 阈值一致。
        const zone = cmps < 20 ? 1 : cmps < 50 ? 2 : cmps < 100 ? 3 : 4
        const z = DAMAGE_ZONES[zone]
        c = new THREE.Color().setRGB(z.linear[0], z.linear[1], z.linear[2], THREE.SRGBColorSpace)
        c.lerp(_WHITE, 0.55)
      } else {
        let lin
        if (displayMode === 1) {
          lin = (level * stressFactor) / 1.0e6 / stressRefMPa
        } else {
          lin = level / ppvRefMps
        }
        const norm0 = normMode
          ? Math.min(
              1,
              Math.max(0, Math.log2(Math.max(lin, NORM_FLOOR) / NORM_FLOOR) / NORM_LOG_SPAN)
            )
          : Math.min(1, Math.max(0, lin))
        // 【工业风格】等值线 = 色阶边界 → 黑/白实线（按所在色档亮度二选一），
        // 不再做"向白提亮 0.72"的柔和混色；线即几何硬边。
        // 级别值由 computeContourLevels 按同一归一化公式给出（floor=NORM_FLOOR·满刻度），
        // 因此 level → norm → 档号 k=round(norm·N) 与热力图色档严格对齐。
        if (this._fieldIndustrialStyle !== 0) {
          const bands = industrialBandCount(this._fieldNormBands)
          const bandIdx = Math.min(bands - 1, Math.max(0, Math.round(norm0 * bands)))
          c = new THREE.Color(industrialContourColor(bandIdx, bands))
        } else {
          // 与 shader 高光膝形压缩同口径（保证线与色带边界对齐）：
          // norm = mix(norm, 1 - (1-norm)^1.35, smoothstep(KNEE_WARP_A, KNEE_WARP_B, norm))
          const knee = THREE.MathUtils.smoothstep(norm0, KNEE_WARP_A, KNEE_WARP_B)
          const norm = norm0 + (1.0 - Math.pow(1.0 - norm0, 1.35) - norm0) * knee
          const stops = displayMode === 1 ? STRESS_COLOR_STOPS_LINEAR : PPV_COLOR_STOPS_LINEAR
          const max =
            displayMode === 1
              ? STRESS_COLOR_STOPS_LINEAR[stops.length - 1][0]
              : PPV_COLOR_STOPS_LINEAR[stops.length - 1][0]
          const rgb = _sampleStops(stops, norm * max)
          // 高对比度取色：向白提亮 0.72（比热力图底色更亮，浅蓝→白→亮红各带上清晰可辨）
          c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
          c.lerp(_WHITE, 0.72)
        }
      }
      levelCache.set(key, c)
      return c
    }

    // —— 展开折线 → 实例段（pos/col/arrival 各 2 端点）——
    // grid 局部 → 世界：P = center + g·basis；节点沿法线外推 offset 防 z-fighting。
    // 【可见性修复】0.05m 偏移在长行程深度缓冲下会被岩面吃掉导致线不可见：
    // 加大到 0.15m + depthTest 关闭，等值线作为叠加层始终画在热力图之上。
    const NORMAL_OFFSET = 0.15
    let nSeg = 0
    for (const pl of polylines) {
      const m = pl.positions.length / 3
      if (m >= 2) nSeg += m - 1 + (pl.closed ? 1 : 0)
    }
    if (nSeg === 0) {
      this._updateContourVisibility()
      return
    }
    const segPos = new Float32Array(nSeg * 6)
    const segCol = new Float32Array(nSeg * 6)
    const segArrStart = new Float32Array(nSeg)
    const segArrEnd = new Float32Array(nSeg)
    let si = 0
    const putPoint = (pl, i, out, o3) => {
      const gx = pl.positions[i * 3]
      const gy = pl.positions[i * 3 + 1]
      const gz = pl.positions[i * 3 + 2]
      let dx = 0
      let dy = 0
      let dz = 0
      if (pl.normals) {
        dx = pl.normals[i * 3] * NORMAL_OFFSET
        dy = pl.normals[i * 3 + 1] * NORMAL_OFFSET
        dz = pl.normals[i * 3 + 2] * NORMAL_OFFSET
      }
      const x = gx + dx
      const y = gy + dy
      const z = gz + dz
      out[o3 + 0] = center.x + x * right.x + y * up.x + z * forward.x
      out[o3 + 1] = center.y + x * right.y + y * up.y + z * forward.y
      out[o3 + 2] = center.z + x * right.z + y * up.z + z * forward.z
    }
    for (const pl of polylines) {
      const m = pl.positions.length / 3
      if (m < 2) continue
      const col = getLevelColor(pl.level)
      const hasArr = !!pl.arrival
      const last = m - 1
      for (let i = 0; i < last; i++) {
        putPoint(pl, i, segPos, si * 6)
        putPoint(pl, i + 1, segPos, si * 6 + 3)
        segCol[si * 6 + 0] = col.r
        segCol[si * 6 + 1] = col.g
        segCol[si * 6 + 2] = col.b
        segCol[si * 6 + 3] = col.r
        segCol[si * 6 + 4] = col.g
        segCol[si * 6 + 5] = col.b
        segArrStart[si] = hasArr ? pl.arrival[i] : 0
        segArrEnd[si] = hasArr ? pl.arrival[i + 1] : 0
        si++
      }
      if (pl.closed) {
        putPoint(pl, last, segPos, si * 6)
        putPoint(pl, 0, segPos, si * 6 + 3)
        segCol[si * 6 + 0] = col.r
        segCol[si * 6 + 1] = col.g
        segCol[si * 6 + 2] = col.b
        segCol[si * 6 + 3] = col.r
        segCol[si * 6 + 4] = col.g
        segCol[si * 6 + 5] = col.b
        segArrStart[si] = hasArr ? pl.arrival[last] : 0
        segArrEnd[si] = hasArr ? pl.arrival[0] : 0
        si++
      }
    }

    // —— 几何 + 材质 ——
    const geo = new LineSegmentsGeometry()
    geo.setPositions(segPos)
    geo.setColors(segCol)
    // 波前到达时刻（每实例两端点各一 float，InstancedBufferAttribute）：
    // 注入 LineMaterial 着色器做门控淡入（与 instanceColorStart/End 同一实例化模式）
    geo.setAttribute('instanceArrStart', new THREE.InstancedBufferAttribute(segArrStart, 1))
    geo.setAttribute('instanceArrEnd', new THREE.InstancedBufferAttribute(segArrEnd, 1))
    const mat = new LineMaterial({
      color: 0xffffff,
      linewidth: this._isoLineWidth,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      // 可见性修复：关闭深度测试 → 等值线不会被岩面/地形深度遮挡，始终叠加在热图上
      depthTest: false,
      depthWrite: false
    })
    // LineMaterial 需要屏幕分辨率（像素线宽换算）；初始取一次，resize 时同步。
    const el = this.rendererSizeProvider?.() || null
    if (el && el.w > 0) mat.resolution.set(el.w, el.h)
    // 注入 arrival 门控：alpha *= smoothstep(arr-fade, arr+fade, uArrTime)
    const arrU = this._contourArrUniform
    const fadeU = this._contourFadeUniform
    mat.onBeforeCompile = shader => {
      shader.uniforms.uArrTime = arrU
      shader.uniforms.uArrFade = fadeU
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <fog_pars_vertex>',
          `#include <fog_pars_vertex>
attribute float instanceArrStart;
attribute float instanceArrEnd;
varying float vArrival;`
        )
        .replace(
          'float aspect = resolution.x / resolution.y;',
          `vArrival = ( position.y < 0.5 ) ? instanceArrStart : instanceArrEnd;
				float aspect = resolution.x / resolution.y;`
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <clipping_planes_pars_fragment>',
          `#include <clipping_planes_pars_fragment>
varying float vArrival;
uniform float uArrTime;
uniform float uArrFade;`
        )
        .replace(
          'float alpha = opacity;',
          'float alpha = opacity * smoothstep( vArrival - uArrFade, vArrival + uArrFade, uArrTime );'
        )
    }
    this._contourMaterial = mat

    const mesh = new LineSegments2(geo, mat)
    mesh.frustumCulled = false // 岩体大范围分布，实例段包围球逐段剔除得不偿失
    mesh.renderOrder = 60 // 高于岩体热力图（默认 0），低于外轮廓描边（999）
    if (!this._contourGroup) {
      this._contourGroup = new THREE.Group()
      this._contourGroup.name = 'contourLines'
      this.scene.add(this._contourGroup)
    }
    this._contourGroup.add(mesh)
    this._contourMesh = mesh
    this._updateContourVisibility()
  }

  /** 推进等值线波前门控时间（t 为模拟秒；t≥arrival 的段淡入） */
  setContourTime(t) {
    this._contourArrUniform.value = Number(t) || 0
  }

  /** 同步 LineMaterial 屏幕分辨率（渲染器 resize 时调用，像素线宽依赖） */
  setContourResolution(w, h) {
    if (this._contourMaterial && Number(w) > 0 && Number(h) > 0) {
      this._contourMaterial.resolution.set(Number(w), Number(h))
    }
  }

  /**
   * 导出岩面（benchMesh）顶点集到 grid 局部系，供等值线峰值场计算。
   * 坐标换算与热力图片元着色器完全一致：g = ((P−uCenter)·right, ·up, ·forward)，
   * 保证 Worker 侧 computeSurfacePeakField 与 GPU 解析场同源同帧。
   * @returns {{positions: Float32Array, normals: Float32Array|null, index: Uint32Array|null,
   *           version: number, shaping: {holeRadius:number, holeLen:number,
   *           lateralAttn:number, origin:number[]}} | null}
   */
  getContourSurface() {
    const mesh = this.benchMesh
    const u = this._benchFieldMaterial?.uniforms
    if (!mesh || !mesh.geometry || !u) return null
    // 版本缓存：几何未变（_benchGeoVersion 未自增）直接复用上次导出——
    // 调用方（blastingManager）每播放 tick 都会查询指纹，逐次全量导出
    // N×3 顶点（岩体数万顶点）会造成每帧数百 KB 分配的 GC 压力。
    const cache = this._contourSurfaceCache
    if (cache && cache.version === this._benchGeoVersion && cache.mesh === mesh) {
      return cache.data
    }
    const geo = mesh.geometry
    const posAttr = geo.attributes.position
    if (!posAttr) return null
    const center = u.uCenter.value
    const right = u.uRight.value
    const up = u.uUp.value
    const forward = u.uForward.value
    mesh.updateWorldMatrix(true, false)
    const m = mesh.matrixWorld
    const nrmAttr = geo.attributes.normal
    const n = posAttr.count
    const positions = new Float32Array(n * 3)
    const normals = nrmAttr ? new Float32Array(n * 3) : null
    const p = new THREE.Vector3()
    const nm = _mat3.getNormalMatrix(m)
    const nv = new THREE.Vector3()
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(posAttr, i).applyMatrix4(m)
      const rx = p.x - center.x
      const ry = p.y - center.y
      const rz = p.z - center.z
      positions[i * 3 + 0] = rx * right.x + ry * right.y + rz * right.z
      positions[i * 3 + 1] = rx * up.x + ry * up.y + rz * up.z
      positions[i * 3 + 2] = rx * forward.x + ry * forward.y + rz * forward.z
      if (normals) {
        nv.fromBufferAttribute(nrmAttr, i).applyMatrix3(nm).normalize()
        normals[i * 3 + 0] = nv.x * right.x + nv.y * right.y + nv.z * right.z
        normals[i * 3 + 1] = nv.x * up.x + nv.y * up.y + nv.z * up.z
        normals[i * 3 + 2] = nv.x * forward.x + nv.y * forward.y + nv.z * forward.z
      }
    }
    const index = geo.index
      ? geo.index.array instanceof Uint32Array
        ? geo.index.array
        : new Uint32Array(geo.index.array)
      : null
    const data = {
      positions,
      normals,
      index,
      version: this._benchGeoVersion,
      shaping: {
        holeRadius: u.uHoleRadius.value,
        holeLen: u.uHoleLen.value,
        lateralAttn: u.uLateralAttn.value,
        origin: u.uBlastOrigin.value.toArray()
      }
    }
    this._contourSurfaceCache = { version: this._benchGeoVersion, mesh, data }
    return data
  }

  /**
   * 读取当前热力图渲染参数（等值线级别计算与级别取色需与画面完全同口径）。
   * @returns {{displayMode:number, ppvRefMps:number, stressRefMPa:number,
   *           stressFactor:number, normMode:number} | null}
   */
  getFieldRenderParams() {
    const u = this._benchFieldMaterial?.uniforms
    if (!u) return null
    return {
      displayMode: u.uDisplayMode.value,
      normMode: u.uNormMode.value,
      ppvRefMps: u.uPpvRefMps.value,
      stressRefMPa: u.uStressRefMPa.value,
      stressFactor: u.uStressFactor.value
    }
  }

  /** 当前岩体几何版本（ blastingManager 据此判断等值线是否需要重提取） */
  get benchGeoVersion() {
    return this._benchGeoVersion
  }

  /** 波场可达半径（= 爆心 → 岩体几何最远顶点，由 _syncInfluenceRadius 实测） */
  get influenceRadius() {
    return this._influenceRadius || 0
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
        // 【工业离散色带】PPV/应力 LUT 统一用本类按 uNormBands 生成的 N 档离散 Jet LUT
        // （档内纯色），保证屏幕色阶 == 图例色块 == 等值线边界三处一致。
        if (data.boundsMin) u.uBoundsMin.value.set(...data.boundsMin)
        if (data.boundsMax) u.uBoundsMax.value.set(...data.boundsMax)
        if (data.center) u.uCenter.value.copy(data.center)
        if (data.blastOrigin) {
          const o = Array.isArray(data.blastOrigin)
            ? data.blastOrigin
            : [data.blastOrigin.x, data.blastOrigin.y, data.blastOrigin.z]
          u.uBlastOrigin.value.set(Number(o[0]) || 0, Number(o[1]) || 0, Number(o[2]) || 0)
        }
        if (data.right) u.uRight.value.copy(data.right)
        if (data.up) u.uUp.value.copy(data.up)
        if (data.forward) u.uForward.value.copy(data.forward)
        // 洞身截断 & 轴向延展：以当前构建的隧道洞身几何刷新(爆心→片元遮挡判定所需)
        if (this._holeGeom) {
          u.uHoleRadius.value = this._holeGeom.radius
          u.uHoleLen.value = this._holeGeom.len
          u.uLateralAttn.value = this._holeGeom.lateralAttn
        }
        if (data.ppvRefMps != null && !this._autoRefApplied) u.uPpvRefMps.value = data.ppvRefMps
        if (data.stressRefMPa != null && !this._autoRefApplied)
          u.uStressRefMPa.value = data.stressRefMPa
      }
    }
  }

  /** 切换岩体/掌子面振动场显示模式（0=PPV, 1=STRESS, 2=DAMAGE） */
  setBenchFieldDisplayMode(mode) {
    const v = Number(mode) || 0
    for (const m of this._fieldMaterials()) m.uniforms.uDisplayMode.value = v
  }

  /** 设置岩体/掌子面振动场着色权重（0~1），0=关闭只显示岩色 */
  setBenchFieldWeight(weight) {
    const v = Math.max(0, Math.min(1, Number(weight) || 0))
    for (const m of this._fieldMaterials()) m.uniforms.uFieldWeight.value = v
    // 等值线显隐与热力图图层联动：场图层关闭（权重≈0）时等值线一并隐藏
    this._contourFieldOn = v > 0.01
    this._updateContourVisibility()
  }

  /**
   * 设置场图层目标权重并启动平滑淡入/淡出（由 updateFieldFade 按墙钟推进）。
   * 替代原来的"0.62 硬切"：开关热力图时画面连续变化，不出现"点了没反应、
   * 随后整片突然变色"的观感。
   * @param {number} weight - 目标权重（0=关；0.62=开）
   */
  setFieldWeightTarget(weight) {
    this._fieldWeightTarget = Math.max(0, Math.min(1, Number(weight) || 0))
    if (this._fieldFadeT0 == null) {
      this._fieldFadeT0 = performance.now()
      this._fieldFadeFrom = this._fieldWeightNow ?? 0
    }
  }

  /**
   * 用墙钟时间推进场权重淡入/淡出（由渲染循环每帧调用，与 dt 解耦）。
   * 时间驱动：渲染暂停时过渡按真实时间自然走完，恢复后不会停在半途。
   */
  updateFieldFade() {
    if (this._fieldFadeT0 == null) return
    const target = this._fieldWeightTarget ?? 0
    const k = Math.min(1, (performance.now() - this._fieldFadeT0) / FIELD_FADE_MS)
    const e = k * k * (3 - 2 * k)
    const v = this._fieldFadeFrom + (target - this._fieldFadeFrom) * e
    this._fieldWeightNow = v
    for (const m of this._fieldMaterials()) m.uniforms.uFieldWeight.value = v
    this._contourFieldOn = v > 0.01
    this._updateContourVisibility()
    if (k >= 1) this._fieldFadeT0 = null
  }

  /** 设置岩体/掌子面底材是否"白模"：true=场图层开启时切白模底，false=保留岩石纹理底 */
  setFieldWhiteModel(enabled) {
    const v = enabled ? 1 : 0
    for (const m of this._fieldMaterials()) m.uniforms.uWhiteModel.value = v
  }

  /** 同步模拟时间到场材质（驱动场盒外的萨道夫斯基波前外推逐帧传播） */
  setFieldSimTime(t) {
    const v = Number(t) || 0
    for (const m of this._fieldMaterials()) m.uniforms.uSimTime.value = v
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
   * 算法组已拆分至 SectionCutter（sectionCutter.js）：此处保留公共入口一行委托，
   * 签名/返回值与拆分前一致。
   * @param {number} [enabled] 0 关 / 1 开
   * @param {number} [axis] 0=X 1=Y 2=Z（基于场景 rel 坐标）
   * @param {number} [pos] 裁剪平面沿轴位置
   */
  setSectionPlane({ enabled = 0, axis = 0, pos = 0 } = {}) {
    return this._sectionCutter.setSectionPlane({ enabled, axis, pos })
  }

  /** 返回可被射线拾取的岩体网格列表 */
  getRockMeshes() {
    const list = []
    if (this.benchMesh) list.push(this.benchMesh)
    return list
  }

  /**
   * 拾取式剖切：给定岩体上的一个局部点与切割轴，构造过该点、法线沿该轴的
   * 剖切面，生成实体封口断面，并在切面上绘制轮廓标记。算法委托 SectionCutter。
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

  /**
   * 绘制监测点（测点）持久标记：在岩体局部系叠加小粉球(+光晕)标注已放置测点位置。
   * @param {Array<{x:number,y:number,z:number}|null>} points 全部监测点局部坐标
   */
  setMonitorPointMarkers(points = []) {
    const mesh = this.benchMesh
    if (!mesh) return
    if (this._monitorMarkerGroup) {
      const parent = this._monitorMarkerGroup.parent
      if (parent) parent.remove(this._monitorMarkerGroup)
      this._monitorMarkerGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      })
      this._monitorMarkerGroup = null
    }
    if (!Array.isArray(points) || !points.length) return
    const mat = new THREE.MeshBasicMaterial({ color: 0xf7768e })
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xf7768e,
      transparent: true,
      opacity: 0.3,
      depthWrite: false
    })
    const group = new THREE.Group()
    for (const p of points) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
      const g = new THREE.Group()
      g.position.set(p.x, p.y, p.z)
      g.add(
        new THREE.Mesh(new THREE.SphereGeometry(0.35, 14, 10), mat),
        new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10), haloMat)
      )
      group.add(g)
    }
    group.renderOrder = 100
    mesh.add(group)
    this._monitorMarkerGroup = group
  }

  /**
   * 兼容壳：几何真剖切（CSG）算法已整体迁出至 SectionCutter._applySectionCut，
   * 本方法仅保留一行委托——__tests__/sectionCoverage.test.js、
   * __tests__/rockBodySectionCut.test.js 与 __debug__ 诊断脚本直调
   * sb._applySectionCut(axis, pos)，故签名保持不变。
   * @param {number} axis 0=X 1=Y 2=Z（局部坐标轴）
   * @param {number} pos 沿轴局部坐标（越界自动钳制到包围盒内）
   */
  _applySectionCut(axis, pos) {
    return this._sectionCutter._applySectionCut(axis, pos)
  }

  /** 清除拾取式剖切：移除轮廓标记并还原完整岩体（委托 SectionCutter）。 */
  clearSectionPick() {
    return this._sectionCutter.clearSectionPick()
  }

  /** 读取当前剖切平面状态 {enabled,axis,pos}（委托 SectionCutter）。 */
  getSectionPlane() {
    return this._sectionCutter.getSectionPlane()
  }

  /**
   * 注入场盒外解析外推（萨道夫斯基）的物理参数，使外圈岩体着色与网格内
   * 同一物理模型的 PPV/应力/损伤分布及传播曲线一致。
   * @param {Object} p - { chargeKg, K, alpha, beta, visualCp, rho, cp, nu, ppvRefMps, stressRefMPa }
   */
  /**
   * 设置工业离散色阶档数（12~16）：重建 N 档 Jet LUT 并同步 uNormBands。
   * 档数与等值线密度（useBlasting.contourDensity）同源——等值线画在色阶边界上，
   * 图例区间列表也按同一 N 反解，三处必须一致。
   */
  setFieldNormBands(n) {
    const bands = industrialBandCount(n)
    if (this._fieldNormBands === bands && this._fieldPpvLut && this._fieldStressLut) return
    this._fieldNormBands = bands
    this._fieldPpvLut?.dispose()
    this._fieldStressLut?.dispose()
    this._fieldPpvLut = new THREE.DataTexture(
      buildIndustrialLutGradient(bands),
      LUT_TEXELS,
      1,
      THREE.RGBAFormat
    )
    this._fieldPpvLut.userData.bands = bands
    // 线性过滤：连续 norm 采样离散 LUT 时在相邻 Jet 色之间插值 → 平滑色阶
    // （与初始创建路径同口径；漏设则拖"等值线密度"滑块后色带硬边/细线伪影复发）
    this._fieldPpvLut.minFilter = THREE.LinearFilter
    this._fieldPpvLut.magFilter = THREE.LinearFilter
    this._fieldPpvLut.wrapS = THREE.ClampToEdgeWrapping
    this._fieldPpvLut.needsUpdate = true
    this._fieldStressLut = new THREE.DataTexture(
      buildIndustrialLutGradient(bands),
      LUT_TEXELS,
      1,
      THREE.RGBAFormat
    )
    this._fieldStressLut.userData.bands = bands
    this._fieldStressLut.minFilter = THREE.LinearFilter
    this._fieldStressLut.magFilter = THREE.LinearFilter
    this._fieldStressLut.wrapS = THREE.ClampToEdgeWrapping
    this._fieldStressLut.needsUpdate = true
    for (const m of this._fieldMaterials()) {
      m.uniforms.uNormBands.value = bands
      m.uniforms.uPpvLut.value = this._fieldPpvLut
      m.uniforms.uStressLut.value = this._fieldStressLut
    }
  }

  /**
   * 工业风格总开关（1=开启）。开启后：离散色阶 + 黑白等值线硬边 + 场完全不透明
   * + 白模底材（隐藏岩石纹理）。0 = 回退到原平滑渐变观感。
   */
  setFieldIndustrialStyle(on) {
    this._fieldIndustrialStyle = on ? 1 : 0
    for (const m of this._fieldMaterials()) {
      m.uniforms.uIndustrialStyle.value = this._fieldIndustrialStyle
    }
  }

  applyFieldPhysics(p = {}) {
    for (const m of this._fieldMaterials()) {
      const u = m.uniforms
      if (Number.isFinite(Number(p.chargeKg)) && p.chargeKg > 0)
        u.uChargeKg.value = Number(p.chargeKg)
      if (Number.isFinite(Number(p.k)) && p.k > 0) u.uSadoskyK.value = Number(p.k)
      if (Number.isFinite(Number(p.alpha)) && p.alpha > 0) u.uSadoskyAlpha.value = Number(p.alpha)
      if (Number.isFinite(Number(p.beta)) && p.beta > 0) u.uSadoskyBeta.value = Number(p.beta)
      // 自动量程缩放：色标上限跟随岩体近场代表性峰值，避免解析场(~10 m/s)远超
      // 固定上限(15 cm/s)导致全场饱和成单一品红。传入即为"满刻度值"，图例同步。
      if (Number.isFinite(Number(p.ppvRefMps)) && Number(p.ppvRefMps) > 0) {
        u.uPpvRefMps.value = Number(p.ppvRefMps)
        this._autoRefApplied = true
      }
      if (Number.isFinite(Number(p.stressRefMPa)) && Number(p.stressRefMPa) > 0) {
        u.uStressRefMPa.value = Number(p.stressRefMPa)
        this._autoRefApplied = true
      }
      // 显示侧动态满量程展开因子（峰值场 P99.9 反解，随事件固定）；S∈[1,~80]
      // 不随帧漂移，保证图例/等值线级别在整场播放期间与色标稳定对齐。
      if (Number.isFinite(Number(p.normAutoScale)) && Number(p.normAutoScale) >= 1) {
        u.uNormAutoScale.value = Number(p.normAutoScale)
      }
      if (Number.isFinite(Number(p.visualCp)) && p.visualCp > 0)
        u.uVisualCp.value = Number(p.visualCp)
      // 波包子波载波频率（Hz，0=关）：控制热力图干涉条纹疏密。
      // 【曾有缺口】面板滑块经 manager→renderer.setFieldPhysics({carrierHz}) 下发，
      // 但 applyFieldPhysics 若漏了这一段，参数会被静默丢弃——表现为"滑动滑块
      // 热力图完全没反应"。此处为唯一落地点，勿删。
      if (Number.isFinite(Number(p.carrierHz)) && Number(p.carrierHz) >= 0)
        u.uCarrierHz.value = Number(p.carrierHz)
      // 波场可达半径由岩体几何实测（_syncInfluenceRadius），不再接受外部覆盖——
      // 旧"传播包络半径"滑块 3~30m 会在岩体中部形成一圈能量断崖（用户实测
      // "热力扩散被限制在某范围外不传播"），已移除。
      // P0-1 损伤硬上限（UI 滑块/setFieldPhysics 下发，与后端 damageMaxRadius 同口径）
      if (Number.isFinite(Number(p.damageMaxRadius)) && Number(p.damageMaxRadius) > 0)
        u.uDamageMaxRadius.value = Number(p.damageMaxRadius)
      if (Number.isFinite(Number(p.damageFalloff)) && Number(p.damageFalloff) > 0)
        u.uDamageFalloff.value = Number(p.damageFalloff)
      // 掌子面自由面反射（镜象源法）：反射面 = 掌子面轴向位置（grid 局部系），
      // 与 CPU computeMultiSource*（sim.params.reflections）同一物理口径。
      if (Number.isFinite(Number(p.faceZ))) u.uFaceZ.value = Number(p.faceZ)
      if (p.reflectOn !== undefined) u.uReflectOn.value = p.reflectOn ? 1 : 0
      if (Number.isFinite(Number(p.reflectCoeff))) u.uReflectCoeff.value = Number(p.reflectCoeff)
      // 半透明渲染（1=场色上限 0.55 露出岩底）
      if (Number.isFinite(Number(p.translucent))) u.uFieldTranslucent.value = p.translucent ? 1 : 0
      // 隧道马蹄形轮廓自由面（SDF 放大）：floorY/archH/coeff/lambda 一并下发（coeff=0 关）
      if (Number.isFinite(Number(p.faceBoostCoeff)))
        u.uFaceBoostCoeff.value = Number(p.faceBoostCoeff)
      if (Number.isFinite(Number(p.faceBoostLambda)) && Number(p.faceBoostLambda) > 0)
        u.uFaceBoostLambda.value = Number(p.faceBoostLambda)
      if (Number.isFinite(Number(p.tunnelFloorY))) u.uTunnelFloorY.value = Number(p.tunnelFloorY)
      if (Number.isFinite(Number(p.tunnelArchH)) && Number(p.tunnelArchH) > 0)
        u.uTunnelArchH.value = Number(p.tunnelArchH)
      // 爆源 grid 局部坐标（掏槽孔质心）：解析外推波环/波前以该点为心
      if (p.origin) {
        const o = Array.isArray(p.origin) ? p.origin : [p.origin.x, p.origin.y, p.origin.z]
        u.uBlastOrigin.value.set(Number(o[0]) || 0, Number(o[1]) || 0, Number(o[2]) || 0)
      }
      if (Number(p.rho) > 0 && Number(p.cp) > 0 && Number.isFinite(Number(p.nu))) {
        const nu = Math.max(0, Math.min(0.49, Number(p.nu)))
        // 应力幅值系数 ρ·c_p/(1−ν)：σ_vm = ρ·c_p·v/(1−ν)·F(r)（径向压+切向拉，见
        // stress_field_from_ppv / computeStressFieldFromPpv），旧值 ρ·c_p·|1−ν/(1−ν)|
        // 为弹性一维应变近似，未体现切向拉应力主导的爆破破坏机制。
        u.uStressFactor.value = Number(p.rho) * Number(p.cp) * (1 / (1 - nu))
      }
      // 应力近场几何修正 F(r)=1+A·(r_nf/r)²：让应力场与瞬时振速场空间结构不同
      // （否则 σ 只是 v 的常数倍，两模式同一张图）。r_nf 由 blastingManager 按
      // 装药量反算下发（见 localVibrationSimulator.NEAR_FIELD_*）。
      if (Number.isFinite(Number(p.stressNearFieldR)) && Number(p.stressNearFieldR) > 0) {
        u.uStressNfR.value = Number(p.stressNearFieldR)
        u.uStressNfA.value = Number(p.stressNearFieldGain) > 0 ? Number(p.stressNearFieldGain) : 2.0
      } else if (p.stressNearFieldR === 0) {
        // 显式关闭
        u.uStressNfR.value = 0
        u.uStressNfA.value = 0
      }
      // 工业风格：离散色阶档数（与等值线密度同源）与总开关
      if (Number.isFinite(Number(p.normBands)) && Number(p.normBands) > 0) {
        this.setFieldNormBands(Number(p.normBands))
        u.uNormBands.value = industrialBandCount(Number(p.normBands))
      }
      if (p.industrialStyle !== undefined) {
        this._fieldIndustrialStyle = p.industrialStyle ? 1 : 0
        u.uIndustrialStyle.value = this._fieldIndustrialStyle
      }
      // 多装药源：将各炮孔装药段写入 uniform 数组（与 GLSL MAX_SOURCES=96 对齐）。
      // 片段着色器据此做各源矢量叠加，驱动非同心圆干涉波场；源数>0 即脱离单源同心圆退化分支。
      // 取前 96 个：覆盖全部布孔（昆阳 43、南山 69 孔全量，不丢延时段）；超出的极端
      // 设计按装药量降序保留主源，避免静默丢源导致场能量/波系缺失。
      if (Array.isArray(p.sources)) {
        const list =
          p.sources.length > 96
            ? [...p.sources]
                .sort((a, b) => (Number(b?.chargeKg) || 0) - (Number(a?.chargeKg) || 0))
                .slice(0, 96)
            : p.sources
        // 时域错峰叠加峰值（uPeakHistory=1）要求按延时升序遍历源（与后端
        // peak_ppv_envelope_multi peak_method='history' 同口径：延时序增量累加
        // B += A·e^(+D·arr)·û，逐源候选 e^(−D·arr)·|B|）。稳定排序：同延时段保持原序。
        const ordered = [...list].sort(
          (a, b) => (Number(a?.delayMs) || 0) - (Number(b?.delayMs) || 0)
        )
        u.uSourceCount.value = ordered.length
        // 源强度系数预计算：w = K·q^(α/3)·0.01（K/α 取同步后的 uniform 值，与
        // shader 单源分支/本地模拟器 sadoskyPpv 同口径），片元内免 96 次幂运算
        const K = Number(u.uSadoskyK.value) || 0
        const alp = Number(u.uSadoskyAlpha.value) || 0
        for (let i = 0; i < 96; i++) {
          const s = ordered[i]
          if (s) {
            const q = Number(s.chargeKg) || 0
            u.uSourcePosQ.value[i].set(
              Number(s.x) || 0,
              Number(s.y) || 0,
              Number(s.z) || 0,
              K * Math.pow(q, alp / 3) * 0.01
            )
            u.uSourceDelay.value[i] = (Number(s.delayMs) || 0) / 1000 // ms → s（与 uSimTime 秒同单位）
          } else {
            u.uSourcePosQ.value[i].set(0, 0, 0, 0)
            u.uSourceDelay.value[i] = 0
          }
        }
      }
    }
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

  // ─── 回退模式：硬编码典型布孔（菱形掏槽 + 辅助 + 周边）──
  // 布孔设计数据生成已外移至 computation/fallbackHoleLayout.js（buildFallbackHoles 纯函数），
  // 此处仅做参数组装适配：designParams/kcoParams/tunnelHeight 由本类读取后传入。
  _collectFallbackHoles(cy0, W, Hw, R) {
    return buildFallbackHoles({
      W,
      Hw,
      R,
      totalH: this.tunnelHeight,
      cy0,
      designParams: this.designParams,
      kcoParams: this.kcoParams
    })
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
  // _isInsideTunnelSection 已随回退布孔设计外移至 computation/fallbackHoleLayout.js；
  // 掌子面轮廓过滤仍用下方 _insideFaceProfile（isInsideSection，margin=0）。

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
    // 【淡入】经墙钟缓动过渡（FIELD_FADE_MS），不再硬切——开关热力图时画面连续变化。
    this.setFieldWeightTarget(on ? 0.62 : 0.0)
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
