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
 *
 * 模块拆分：
 *  - SceneBuilder：场景光照、隧道/掌子面/岩体/钻孔/标注等场景元素
 *  - FragmentRenderer：碎片 InstancedMesh 的创建、更新与释放
 *  - rockGeometryFactory：岩石几何体池
 *  - BlastEffectManager：粒子特效（火焰/烟雾/火花/冲击波/粉尘）
 *  - BlastPhysicsEngineWorker：碎片物理引擎（Web Worker）
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { BlastPhysicsEngineWorker } from '../computation/blastPhysicsEngineWorker.js'
import { generateFragmentSpecs } from './fragmentSpecGenerator.js'
import { BlastEffectManager } from './blastEffectManager.js'
import { KCO_SOURCE_MODE, calculateKCOParams } from '../computation/kcoModelCore.js'
import { createRockGeometryPool, getRockVariantHalfExtents } from './rockGeometryFactory.js'
import {
  SceneBuilder,
  createFireTexture,
  createSmokeTexture,
  createSparkTexture
} from './sceneBuilder.js'
import { FragmentRenderer } from './fragmentRenderer.js'
import { BlastVibrationFieldRenderer } from './blastVibrationFieldRenderer.js'
import { VibrationParticleRenderer } from './vibrationParticleRenderer.js'
import { MuckPileOutlineRenderer } from './muckPileOutlineRenderer.js'
import {
  DEFAULT_TUNNEL_WIDTH,
  DEFAULT_TUNNEL_WALL_HEIGHT,
  DEFAULT_TUNNEL_ARCH_RADIUS,
  calcHorseshoeArea,
  SETTLE_REST_MASS_RATIO,
  HOLD_AFTER_SETTLED
} from '../blastDefaults.js'

// ─── 粒子类型常量 ──────────────────────────────────────
export const THREE_PARTICLE_TYPES = {
  FIRE: 'fire',
  SMOKE: 'smoke',
  SPARK: 'spark',
  FRAGMENT: 'fragment',
  SHOCK_WAVE: 'shock_wave',
  DUST: 'dust'
}

// 掌子面(岩体边缘)到隧道中心的轴向距离(m)：与 initBlast 中 faceCenter = center + forward*3 保持一致
const FACEOFFSET_FROM_TUNNEL_CENTER = 3.0

// 静止比连续达标帧数：静止比存在 ~1e-4 抖动（碎片被安息角判定解除支撑后重新
// 滚动），单帧穿越阈值可能是尖峰 → 要求连续若干帧达标才锁定抛掷结束时刻。
// 值与 Worker 侧 SETTLE_CONFIRM_STEPS 一致（3 步 × 0.05s = 0.15s）。
const SETTLE_CONFIRM_FRAMES = 3

// ─── 主渲染器 ─────────────────────────────────────────
// 注：旧 BlastParticle 类（含已知 bug 的 1-k·v²·dt 阻力公式）已删除，
// 碎片物理模拟改由独立的 BlastPhysicsEngine（core/computation/blastPhysicsEngine.js）处理
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
    this.renderer.setClearColor(0x000000, 1)
    // 开启本地裁剪：让隧道壳/开挖管等 MeshStandard 材质随世界平面一同被切割
    // （与岩体几何剖切同一世界平面，实现"全部模型一同切割"而非只切岩体）。
    this.renderer.localClippingEnabled = true
    this.scene.background = new THREE.Color(0x000000)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    // bloom 是最大 GPU 负担（5-8 个全分辨率 pass），默认关闭以避免连续旋转时卡死。
    // 需要火光泛光效果时可通过 setBloomEnabled 手动开启。
    this.bloomEnabled = false
    this._initBloomComposer()
    this.container.appendChild(this.renderer.domElement)

    // WebGL 上下文丢失/恢复处理。
    // 连续旋转 + 振动场 raymarch 等重渲染可能触发 GPU 过载（Windows TDR 驱动重置），
    // 导致 WebGLRenderer 抛出 "Context Lost"。若不处理，渲染循环会继续调用失效的
    // GL 命令，浏览器标签页卡死且无法自行恢复。
    // 丢失时 preventDefault 允许浏览器尝试恢复，并暂停渲染/计算；恢复后 three.js
    // 会自动重建已销毁的 GL 资源（程序/纹理/缓冲），只需续跑渲染循环。
    this._ctxLost = false
    this._ctxRestoredAt = 0 // 最近一次上下文恢复的时间戳（用于恢复后的降温宽限期）
    this._ctxLossCount = 0 // 连续 Context Lost 次数（≥3 后禁用振动场体积渲染兜底）
    const canvas = this.renderer.domElement
    this._onCtxLost = e => {
      e.preventDefault() // 允许浏览器尝试恢复上下文
      this._ctxLost = true
      this._ctxLossCount++
      this.stopRenderLoop()
      this._cancelSeek()
      console.warn('[ThreeBlastingRenderer] WebGL 上下文丢失，已暂停渲染，等待恢复')
    }
    this._onCtxRestored = () => {
      this._ctxLost = false
      this._ctxRestoredAt = performance.now()
      this.startRenderLoop()
      console.warn('[ThreeBlastingRenderer] WebGL 上下文已恢复，继续渲染')
    }
    canvas.addEventListener('webglcontextlost', this._onCtxLost)
    canvas.addEventListener('webglcontextrestored', this._onCtxRestored)

    // 纹理
    this.textures = {
      fire: createFireTexture(),
      smoke: createSmokeTexture(),
      spark: createSparkTexture()
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
    // 应力/损伤场爆心（网格局部坐标，缺省网格原点）；由 blastingManager 注入掏槽孔质心
    this._blastOrigin = new THREE.Vector3(0, 0, 0)
    this.chargeKg = 100
    this.active = false
    // 粒子模拟时间（秒），由时间轴驱动
    this.simTime = 0
    // seek 期间的时间锁：跳变快进中播放时钟与 WS 时间轴脱节，锁住 _advanceFieldSimTime
    // 对 WS 场帧时间的"只进不退"信任（旧时间轴尾帧 t 仍超前新 simTime，会把
    // uSimTime 顶在未来并永久卡住——回跳 seek 后解析外推波前/波环与热力图脱节的根因）
    this._fieldTimeLocked = false
    // 爆破触发标志（掌子面损伤演化：爆破前掌子面完整，触发后碎石化飞出）
    this.blastTriggered = false
    this.blastTriggerTime = 0.1 // 起爆时刻（秒）
    // 保存最近一次 initBlast 参数，用于时间轴跳变时重建粒子
    this._lastBlastParams = null

    // 预分配 scratch 对象（syncCamera 每帧调用，避免 new 导致 GC 压力）
    this._camScratch = {
      forward: new THREE.Vector3(),
      cameraZ: new THREE.Vector3(),
      cameraX: new THREE.Vector3(),
      cameraY: new THREE.Vector3(),
      rotationMatrix: new THREE.Matrix4()
    }

    // 独立 Three.js 模式（不依赖 Cesium）
    this._standalone = false
    this._orbitControls = null
    this._renderLoopRaf = null

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
      // 爆破钻孔图层默认可见：仅显示孔位圆柱（每孔文字标签已移除），便于核对布孔
      blastHoles: true,
      // 专业标注（掘进深度/断面尺寸/孔型分区标签等）默认关闭，用户需要时在 UI 打开
      annotations: false,
      // 泛光光斑总开关：一键隐藏所有辉光类粒子（火花/火球/冲击波/落地火星）
      glow: true,
      // PPV 振动场体积（实时推送的动态热力图）
      // 默认关闭：默认模式只显示原始爆破动画（火球/烟雾/碎片/冲击波），
      // 不叠加应力/损伤/PPV 热力图；用户需要时通过图层开关开启。
      vibrationField: false,
      // 振动波传播粒子特效：与振动场热力图层解耦，独立开关（默认跟随爆破动画显示）
      vibrationParticles: true
    }

    // 掌子面/台阶几何参数（爆破方向参考）
    // 默认朝 -Z 方向（北）：与 BlastingManager.flyToCenter 中 heading=0（正北）的相机视线一致，
    // 保证初始视角直面掌子面。Cesium ENU 北 ↔ three.js -Z（见 cesiumThreeBridge 坐标映射）。
    this.faceDirection = new THREE.Vector3(0, 0, -1)
    this.facePosition = new THREE.Vector3(0, 0, 0) // 掌子面位置
    this.benchLength = 80 // 岩体深度(m)，增厚确保远距离仍为实心

    // 隧道断面参数（马蹄形：直墙 + 半圆拱，垂直于地面）
    // 尺寸放大至真实隧道规模，与碎片/烟雾比例协调
    this.tunnelWidth = DEFAULT_TUNNEL_WIDTH
    this.tunnelWallHeight = DEFAULT_TUNNEL_WALL_HEIGHT
    this.tunnelArchRadius = DEFAULT_TUNNEL_ARCH_RADIUS
    this.tunnelHeight = this.tunnelWallHeight + this.tunnelArchRadius
    // T-02：参数化隧道断面（用于 setTunnelSection + fragmentSpecGenerator）
    this.tunnelSection = {
      width: this.tunnelWidth,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      shape: 'horseshoe'
    }
    // 兼容旧字段：碎片散布范围沿用隧道断面尺寸
    this.benchHeight = this.tunnelHeight
    this.benchWidth = this.tunnelWidth

    // 3D 岩石碎片几何体池
    this.rockGeometries = createRockGeometryPool()

    // 撞击飞溅粒子池（落地时激活）
    this.impactDustPool = []
    this.impactSparkPool = []
    this.impactChipPool = []

    // ── 子模块 ──
    this._sceneBuilder = new SceneBuilder(this.scene, {
      center: this.center,
      faceDirection: this.faceDirection,
      layerVisibility: this.layerVisibility,
      tunnelWidth: this.tunnelWidth,
      tunnelWallHeight: this.tunnelWallHeight,
      tunnelArchRadius: this.tunnelArchRadius,
      tunnelHeight: this.tunnelHeight,
      benchLength: this.benchLength,
      tunnelSection: this.tunnelSection
    })
    // 等值线 LineMaterial 需要视口分辨率换算像素线宽（材质在折线下发时才创建，
    // 故以回调形式提供最新尺寸，避免创建时刻与 resize 时刻错开）
    this._sceneBuilder.rendererSizeProvider = () => {
      const s = new THREE.Vector2()
      this.renderer.getSize(s)
      return { w: s.x, h: s.y }
    }

    this._physicsEngine = new BlastPhysicsEngineWorker()
    // 将 15 种碎片几何体的顶点数据注入物理引擎（供 Rapier 凸包碰撞体使用）
    // 提取 position attribute 的 Float32Array，复制以避免 Worker 结构化克隆影响主线程渲染
    {
      const verts = this.rockGeometries.map(geo => {
        const arr = geo.attributes.position.array
        return arr instanceof Float32Array ? arr.slice() : new Float32Array(arr)
      })
      this._physicsEngine.setGeometryVertices(verts)
    }
    this._fragmentRenderer = new FragmentRenderer(
      this.scene,
      this.rockGeometries,
      this._physicsEngine,
      this.layerVisibility
    )
    this._effectManager = new BlastEffectManager(this.scene, this.renderer)
    // PPV 振动场体积渲染器（Data3DTexture + GLSL raymarching）
    // 在收到首个 PPV 二进制帧时按需 init，故此处仅创建实例
    this._vibrationFieldRenderer = new BlastVibrationFieldRenderer(this.scene)
    // 振动波传播粒子特效（波前扩散可视化）
    this._vibrationParticles = new VibrationParticleRenderer(this.scene)
    this._fragmentSpecs = null
    this._lastSpecGenParams = null
    this._fragmentStats = null

    // ── 关键帧回放 / 实测时长 ──
    // 回放模式下落地事件的消费游标（用于在回放中逐帧触发撞击扬尘）
    this._replayLandCursor = 0
    // 回放模式激活标志：直播→回放首次切换时对齐落地游标，避免撞击扬尘一次性爆喷
    this._replayModeActive = false
    // 实测时长（抛掷结束 + HOLD_AFTER_SETTLED）：直播期间渐进记录，
    // 回放就绪后由烘焙时长覆盖
    this._observedDurationS = null
    // 抛掷结束时刻（用于计算 +HOLD_AFTER_SETTLED 保持）
    this._landAllAt = null
    // 静止比连续达标帧数（抗 ~1e-4 抖动尖峰，与 Worker 侧 SETTLE_CONFIRM_STEPS 同口径）
    this._settleConfirmFrames = 0

    // 爆堆轮廓渲染器（三维轮廓包络 + 安息角标注）
    // 通过 getBodyStates 读取存活碎片世界坐标，默认关闭，由 UI 按钮手动开启
    this._muckPileOutline = new MuckPileOutlineRenderer(
      this.scene,
      () => this._physicsEngine?.getBodyStates?.() || []
    )
    this._muckPileEnabled = false

    // 窗口大小调整
    this._resizeHandler = () => this.resize()
    window.addEventListener('resize', this._resizeHandler)

    // 初始化尺寸：同步 renderer/camera/bloomComposer 三者，修复初始渲染不高清 bug
    this.resize()

    // 调试钩子：把渲染器暴露到 window，便于在控制台检查振动场状态
    if (typeof window !== 'undefined') {
      window.__blastingRenderer = this
    }
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
   * 设置爆心位置（three.js 局部坐标，单位：米）
   */
  setCenter(x, y, z) {
    this.center.set(x, y, z)
    // 火光位于掌子面处（爆心 + faceDirection*3）
    this._sceneBuilder.fireLight.position.copy(this.center).addScaledVector(this.faceDirection, 3)
  }

  /**
   * 设置应力/损伤场爆心（隧道局部坐标，单位：米）
   * 由 blastingManager 注入"掏槽孔组质心"：应力波/损伤从实际爆破位置（掌子面）扩散。
   * @param {number[]|THREE.Vector3} origin - [x, y, z]
   */
  setBlastOrigin(origin) {
    if (!origin) return
    if (Array.isArray(origin)) {
      this._blastOrigin.set(Number(origin[0]) || 0, Number(origin[1]) || 0, Number(origin[2]) || 0)
    } else {
      this._blastOrigin.copy(origin)
    }
  }

  /** 掌子面（岩体边缘）距隧道中心的轴向距离(m)，供外部计算爆心 z 坐标使用 */
  get faceOffset() {
    return FACEOFFSET_FROM_TUNNEL_CENTER
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

    // 性能模式：设置碎片间碰撞开关
    if (params.enableInterCollision !== undefined && this._physicsEngine?.setEnableInterCollision) {
      this._physicsEngine.setEnableInterCollision(params.enableInterCollision)
    }

    // 设置爆破方向（如果提供了掌子面方向）
    if (params.faceDirection) {
      this.setFaceDirection(params.faceDirection.x, params.faceDirection.y, params.faceDirection.z)
    }

    const dir = this.faceDirection.clone()
    // 投影到水平面（去除垂直分量）并归一化，保证 right 水平、forward 有限；
    // 与 _computeTunnelBasis 一致——面方向平行于 up 时 cross 会得零向量，
    // normalize 得 NaN，进而污染爆堆包裹壳几何（computeBoundingSphere 报 NaN）。
    dir.y = 0
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
    dir.normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    // 配置爆堆轮廓渲染器局部基：轴向 forward、侧向 right、竖直 up、爆堆中心、
    // 底板高度、掌子面轴向距离（裁掉穿模进未爆破岩体的碎片，否则包裹壳
    // 会被撑进岩体内部、贴不住真实爆堆）
    this._muckPileOutline?.configure?.({
      forward,
      right,
      up,
      center: this.center,
      floorY: this.center.y,
      faceOffset: FACEOFFSET_FROM_TUNNEL_CENTER,
      // 隧道断面参数：剔除"卡在隧道外"的碎石，不参与爆堆轮廓
      section: {
        width: this.tunnelWidth,
        wallHeight: this.tunnelWallHeight,
        archRadius: this.tunnelArchRadius,
        shape: this.tunnelSection.shape
      }
    })

    // 构建掌子面/台阶几何体
    this._sceneBuilder.buildBenchGeometry()
    const faceCenter = new THREE.Vector3().copy(this.center).addScaledVector(forward, 3)

    // 同步隧道内部补光
    this._sceneBuilder.updateTunnelLights(this.center, this.faceDirection, this.tunnelHeight)

    // 隧道截面边界（用于物理引擎碰撞检测）
    this._tunnelBounds = {
      right: right.clone(),
      forward: forward.clone(),
      center: this.center.clone(),
      halfWidth: this.tunnelWidth / 2,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      floorY: this.center.y
    }

    // ── 1. KCO 模型计算 ──
    const throwDir = forward.clone().negate()
    const kcoInput = {
      Q: chargeKg,
      sourceMode: params.kcoParams?.sourceMode || KCO_SOURCE_MODE.DESIGN,
      ...(params.kcoParams || {})
    }
    const kco = calculateKCOParams(kcoInput)

    // ── 2. 爆破粒子特效 ──
    this._lastEffectParams = {
      chargeKg,
      center: { x: faceCenter.x, y: faceCenter.y, z: faceCenter.z },
      throwDir: { x: throwDir.x, y: throwDir.y, z: throwDir.z },
      right: { x: right.x, y: right.y, z: right.z },
      up: { x: up.x, y: up.y, z: up.z },
      tunnelSection: {
        width: this.tunnelWidth,
        wallHeight: this.tunnelWallHeight,
        archRadius: this.tunnelArchRadius,
        shape: this.tunnelSection.shape
      },
      kcoOutput: { A: kco.A },
      // 主爆破粒子（火球/火花/烟雾/粉尘/冲击波）从起爆时刻开始涌现，
      // 出生前不老化、不渲染（配合 BlastEffectManager 的 bornAt 门控）
      triggerTime: this.blastTriggerTime
    }
    this._effectManager.init(this._lastEffectParams)
    // 初始化后立即同步当前图层可见性（确保撞击扬尘等跟随用户之前的开关状态）
    for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
      this._effectManager.setVisible(layer, this.layerVisibility[layer] !== false)
    }

    // ── 3. KCO 碎片规格生成 ──
    const faceDesc = {
      cx: faceCenter.x,
      cy: faceCenter.y,
      cz: faceCenter.z,
      nx: dir.x,
      ny: dir.y,
      nz: dir.z,
      rx: right.x,
      ry: right.y,
      rz: right.z,
      ux: up.x,
      uy: up.y,
      uz: up.z,
      width: this.tunnelWidth,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      shape: this.tunnelSection.shape
    }
    // 准备炮孔设计数据（供碎片规格生成器按孔分配碎片、驱动初速与延迟起爆）
    const holeSpecs = this._buildHoleSpecsForFragmentGen()

    const {
      specs,
      positions,
      velocities,
      stats: generationStats
    } = generateFragmentSpecs({
      kco,
      face: faceDesc,
      chargeKg,
      targetCount: params.fragmentCountTarget || chargeKg * 1.5,
      countLimit: params.fragmentCountRenderLimit || 1000,
      holes: holeSpecs,
      metrics: params.generationMetrics || {},
      randomSeed: params.randomSeed
    })
    this._fragmentSpecs = specs
    // 爆堆轮廓逐碎片渲染包围盒半轴（变体 AABB 半轴 × dispSize），
    // 轮廓渲染器据此 + 四元数做精确投影，壳面紧贴可见碎石
    const variantHalfExtents = getRockVariantHalfExtents()
    this._muckPileOutline?.setFragmentExtents?.(
      specs.map(s => {
        const e = variantHalfExtents[s.variantIndex] || [0.6, 0.6, 0.6]
        // variant + size 供包裹壳做"真实投影轮廓"掩码（见 muckPileOutlineRenderer）
        return {
          hx: e[0] * s.dispSize,
          hy: e[1] * s.dispSize,
          hz: e[2] * s.dispSize,
          variant: s.variantIndex,
          size: s.dispSize
        }
      })
    )
    this._fragmentStats = {
      fragmentCountTarget:
        generationStats?.fragmentCountTarget ??
        Math.max(40, Math.floor(params.fragmentCountTarget || chargeKg * 1.5)),
      fragmentCountGenerated: specs.length,
      fragmentCountRenderLimit: Math.max(40, Number(params.fragmentCountRenderLimit) || 1000),
      chargeKg,
      explosiveType:
        params.kcoParams?.explosiveType || params.generationMetrics?.explosiveType || 'emulsion',
      rockDensityKgM3: Number(params.generationMetrics?.rockDensityKgM3) || null,
      kcoSourceMode: kco.sourceMode,
      x50Applied: kco.x50,
      nApplied: kco.n,
      x80Applied: kco.x80,
      xmaxApplied: kco.xmax,
      bApplied: kco.b,
      x50Computed: kco.computedX50,
      nComputed: kco.computedN,
      fragmentMassTargetKg: generationStats?.fragmentMassTargetKg ?? null,
      fragmentMassGeneratedKg: generationStats?.fragmentMassGeneratedKg ?? null,
      fragmentMassBlastedKg: generationStats?.fragmentMassBlastedKg ?? null,
      fragmentMassCoverage: generationStats?.fragmentMassCoverage ?? null,
      bulkFactor: generationStats?.bulkFactor ?? null,
      volumeRestoreScale: generationStats?.volumeRestoreScale ?? null,
      representativeVolumeM3: generationStats?.representativeVolumeM3 ?? null,
      representativeMassKg: generationStats?.representativeMassKg ?? null,
      blastVolumeM3: generationStats?.blastVolumeM3 ?? null,
      estimatedMeanMassKg: generationStats?.estimatedMeanMassKg ?? null,
      velocityMean: generationStats?.velocityMean ?? null,
      velocityP95: generationStats?.velocityP95 ?? null,
      throwDistancePredictedAvg: generationStats?.throwDistancePredictedAvg ?? null,
      throwDistancePredictedMax: generationStats?.throwDistancePredictedMax ?? null,
      throwDistanceTargetAvg: generationStats?.throwDistanceTargetAvg ?? null,
      throwDistanceTargetMax: generationStats?.throwDistanceTargetMax ?? null,
      velocityScaleApplied: generationStats?.velocityScaleApplied ?? 1,
      sizeHistogramGenerated: generationStats?.sizeHistogramGenerated ?? null,
      sizeHistogramTarget: generationStats?.sizeHistogramTarget ?? null,
      sizeKLDivergence: generationStats?.sizeKLDivergence ?? null,
      velocityHistogramGenerated: generationStats?.velocityHistogramGenerated ?? null
    }
    // 保存碎片初始数据，供 seekTo 异步快进时重新 init Worker
    this._lastFragmentData = { specs, positions, velocities }
    // 保存物理边界，供 seekToAsync 使用
    this._lastPhysicsBounds = {
      centerX: this.center.x,
      centerY: this.center.y,
      centerZ: this.center.z,
      rightX: right.x,
      rightY: right.y,
      rightZ: right.z,
      forwardX: forward.x,
      forwardY: forward.y,
      forwardZ: forward.z,
      halfWidth: this.tunnelWidth / 2,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      floorY: this.center.y,
      faceOffset: FACEOFFSET_FROM_TUNNEL_CENTER, // 掌子面到隧道中心的轴向距离(m)
      shape: this.tunnelSection.shape
    }

    // ── 4. 物理引擎初始化 ──
    this._physicsEngine.reset()
    this._physicsEngine.setTunnelBounds({
      centerX: this.center.x,
      centerY: this.center.y,
      centerZ: this.center.z,
      rightX: right.x,
      rightY: right.y,
      rightZ: right.z,
      forwardX: forward.x,
      forwardY: forward.y,
      forwardZ: forward.z,
      halfWidth: this.tunnelWidth / 2,
      wallHeight: this.tunnelWallHeight,
      archRadius: this.tunnelArchRadius,
      floorY: this.center.y,
      faceOffset: FACEOFFSET_FROM_TUNNEL_CENTER,
      shape: this.tunnelSection.shape
    })
    this._physicsEngine.onBodyLanded = (body, impactSpeed) => {
      this._effectManager.spawnImpactDebris(
        { x: body.posX, y: body.posY, z: body.posZ },
        impactSpeed
      )
    }
    this._physicsEngine.init(specs, positions, velocities, {
      randomSeed: params.randomSeed,
      blastTriggerTime: this.blastTriggerTime
    })

    // ── 5. 碎片 InstancedMesh ──
    this._fragmentRenderer.buildFragmentMesh(specs)
    // 按隧道断面隐藏"卡在隧道外/拱顶尖角伸出"的实例（口径与爆堆轮廓一致）
    this._fragmentRenderer.setSectionBounds(this._lastPhysicsBounds)
    this._fragmentRenderer.setExtentTable(variantHalfExtents)

    // ── 6. 缓存参数 ──
    this._lastSpecGenParams = { kco, face: faceDesc, chargeKg, fragmentCount: specs.length }

    console.log('[ThreeBlastingRenderer] initBlast (新架构)', {
      specs: specs.length,
      kco: {
        Q: chargeKg,
        A: kco.A.toFixed(3),
        x50: kco.x50.toFixed(3),
        xmax: kco.xmax.toFixed(3),
        n: kco.n.toFixed(3),
        b: kco.b.toFixed(3)
      }
    })

    // ── 7. 爆破前状态 ──
    this.blastTriggered = false
    // 重置实测时长状态（新一次爆破重新观测）
    this._observedDurationS = null
    this._landAllAt = null
    this._settleConfirmFrames = 0
    this._replayLandCursor = 0
    this._replayModeActive = false
    this._fragmentRenderer.updateFragmentMesh()
    this.active = true
  }

  /**
   * 更新粒子模拟（新架构：物理引擎 + 特效管理器）
   */
  update(dt) {
    if (!this.active) return
    if (dt <= 0) return
    // 正常播放帧解除 seek 时间锁：恢复对 WS 场帧时间的单调信任（被动大屏模式依赖）
    this._fieldTimeLocked = false
    this.simTime += dt
    // 每帧同步模拟时间到岩体场着色材质：驱动场盒外萨道夫斯基外推的波环随
    // 播放时钟平滑扩散（不受场纹理节流 0.2s 的影响），与外推传播动画连贯。
    if (!this.vibrationFieldDisabled) {
      this._sceneBuilder?.setFieldSimTime?.(this.simTime)
      // 等值线波前门控同一时钟驱动：t≥arrival 的段随播放逐段浮现（Line2 arrival 属性）
      this._sceneBuilder?.setContourTime?.(this.simTime)
    }

    // 爆破触发
    if (!this.blastTriggered && this.simTime >= this.blastTriggerTime) {
      this._triggerBlast()
    }

    // 物理推进：关键帧回放就绪 → 从预烘焙关键帧采样（倍速/循环即时响应，
    // 不再受 Worker 逐 step 求解吞吐限制）；否则直播 step 并实测落地时长。
    if (this._physicsEngine.isReplayReady?.()) {
      const firstReplaySwitch = !this._replayModeActive
      this._replayModeActive = true
      this._physicsEngine.applyReplayAtTime(this.simTime)
      // 直播→回放中途切换：跳过切换时刻之前已落地的碎片（避免撞击扬尘一次性爆喷）
      if (firstReplaySwitch) this._replayLandCursor = this.simTime
      this._consumeReplayLandings()
    } else {
      this._replayModeActive = false
      this._physicsEngine.step(dt)
      this._updateObservedDuration()
    }

    // 特效更新（携带模拟时间：粒子 from 出生时刻起算，未出生不渲染）
    this._effectManager.update(dt, this.simTime)

    // 火光同步（加 NaN 守卫，防止 fireIntensity 异常导致 intensity 永久 NaN）
    const fireLight = this._sceneBuilder.fireLight
    const fireIntensity = this._effectManager.getFireLightIntensity()
    if (Number.isFinite(fireIntensity)) {
      fireLight.intensity += (fireIntensity - fireLight.intensity) * 0.6
      if (fireLight.intensity < 0.01) fireLight.intensity = 0
    } else if (!Number.isFinite(fireLight.intensity)) {
      fireLight.intensity = 0
    }

    // 碎片 InstancedMesh 同步
    this._fragmentRenderer.updateFragmentMesh()

    // 独立模式下由 RAF 渲染循环负责渲染，此处跳过
    if (!this._standalone) this.renderFrame()
  }

  _triggerBlast() {
    this.blastTriggered = true
    this._sceneBuilder.triggerBlast()
    // 岩体不消失：真实爆破中掌子面后方的岩体仍然存在，仅表层破碎抛出。
    // 回放模式直接采样关键帧（碎片动画由烘焙数据驱动），无需激活直播物理。
    if (!this._physicsEngine?.isReplayReady?.()) {
      this._physicsEngine.activateAll()
    }
  }

  /** 回放总时长（全部落地 + 保持 3s，秒）；回放未就绪返回 null */
  getReplayDurationS() {
    return this._physicsEngine?.getReplayDurationS?.() ?? null
  }

  /**
   * 全速预计算进度：{ active: boolean, pct: 0-100 }（供 UI 显示"物理预计算中 x%"）。
   * Worker 预计算期间由 blastPhysicsEngineWorker 缓存进度，经本方法透传给主线程。
   */
  getReplayProgress() {
    return this._physicsEngine?.getReplayProgress?.() ?? { active: false, pct: 0 }
  }

  /** 直播期间实测的总时长（全部落地 + 保持 3s，秒）；尚未达成返回 null */
  getObservedDurationS() {
    return this._observedDurationS ?? null
  }

  /**
   * 当前动画进度条应有的总时长（秒）：
   *  - 回放（预计算）就绪 → 录制时长（全部落地 + 3s，精确、固定）；
   *  - 未就绪（仅 Worker 降级/同步引擎直播模式）→ 直播实测时长（全落地+3s）；
   *  - 均无 → null（回退数据库默认时长）。
   * 注意：时长只取自"物理实际完成的落地+3s"，绝不随播放时钟膨胀，
   * 避免出现"进度条虚长、尾段空白浪费"。
   * @returns {number|null}
   */
  getSimulationDurationS() {
    const replay = this._physicsEngine?.getReplayDurationS?.()
    if (replay) return replay
    return this._observedDurationS ?? null
  }

  /**
   * 实测"全部落地 + 3s 保持"时长（直播模式，回放就绪后不再需要）。
   * 全部（98%+）碎片进入 landed 的时刻 T 一旦确定，立即给出
   * 总时长 = T + 3s（保持 3 秒由进度条长度兑现）。立即输出而非等 3 秒后
   * 再输出，避免进度条在保持期内回卷循环（isLooping 默认开启）把状态重置，
   * 导致"碎片还在飞、进度条已到底"一直无法收敛。
   */
  _updateObservedDuration() {
    if (!this.active) return
    if (this._physicsEngine?.isReplayReady?.()) return
    if (!this.blastTriggered) return
    const total = this._fragmentSpecs ? this._fragmentSpecs.length : 0
    if (!total) return
    // 抛掷结束判据：质量加权静止比 ≥ SETTLE_REST_MASS_RATIO（爆堆成形）。
    // 与 Worker 烘焙侧（blastPhysicsWorker.recordStepIfNeeded）同源同值：
    // 旧口径"99% 碎片计数 FLAG_LANDED"存在平台期（约 0.7% 的边角石永不置位），
    // 判据可能永不达成 → 时间条被硬上限拖长、远超真实抛掷过程。
    // 静止比存在 ~1e-4 抖动（安息角判定会解除/恢复支撑）→ 需连续若干帧达标。
    const restRatio = this._physicsEngine?.restMassRatio ?? 0
    if (restRatio >= SETTLE_REST_MASS_RATIO) this._settleConfirmFrames++
    else this._settleConfirmFrames = 0
    if (this._settleConfirmFrames >= SETTLE_CONFIRM_FRAMES && this._landAllAt == null) {
      this._landAllAt = this.simTime
      this._observedDurationS = this.simTime + HOLD_AFTER_SETTLED
    }
  }

  /**
   * 消费回放模式下的碎片落地事件（撞击扬尘特效）。
   * 落地事件由 Worker 预烘焙时记录，布局 [t,x,y,z,speed]；
   * 只触发"上次游标之后、当前时刻之前"新落地的碎片，且不重复。
   */
  _consumeReplayLandings() {
    const landings = this._physicsEngine?.getReplayLandings?.()
    if (!landings || landings.length === 0) return
    const cursor = this._replayLandCursor
    if (this.simTime <= cursor) return
    const n = landings.length / 5
    let maxT = cursor
    for (let i = 0; i < n; i++) {
      const t = landings[i * 5]
      if (t > cursor && t <= this.simTime) {
        this._effectManager.spawnImpactDebris(
          { x: landings[i * 5 + 1], y: landings[i * 5 + 2], z: landings[i * 5 + 3] },
          landings[i * 5 + 4]
        )
        if (t > maxT) maxT = t
      }
    }
    this._replayLandCursor = Math.max(this.simTime, maxT)
  }

  renderFrame() {
    // 上下文丢失期间禁止任何 GL 调用，否则驱动在恢复前会阻塞主线程导致标签页卡死
    if (this._ctxLost) return

    // 帧级渲染节流：防止 RAF 循环与播放定时器双重渲染
    const now = performance.now()
    if (this._lastRenderMs && now - this._lastRenderMs < 14) return
    this._lastRenderMs = now

    // 爆堆轮廓按墙钟节流重建（碎片落地堆积时跟踪最丰富帧，仅对存活碎片采样）
    this._muckPileOutline?.update?.()

    // 相机移动检测：OrbitControls change 事件更新 _lastCameraSyncMs
    // 移动期间跳过 bloom（5-8 GPU pass），将单帧渲染耗时从 50-200ms 降至 5-15ms
    const cameraActive = this._lastCameraSyncMs && now - this._lastCameraSyncMs < 150

    // 振动场已改为直接在岩体表面着色（benchMesh ShaderMaterial），
    // 不再进行 raymarching 体积渲染，因此无需相机移动/上下文宽限的额外隐藏逻辑。
    // 每帧联动岩体表面场着色强度（状态守卫：仅首次进入/退出时真正修改 uniform）
    this._applyVibrationOcclusion()

    if (this.bloomEnabled && this.bloomComposer && !cameraActive) {
      this.bloomComposer.render()
    } else {
      this.renderer.render(this.scene, this.camera)
    }
  }

  _initBloomComposer() {
    this.bloomComposer = new EffectComposer(this.renderer)
    this.bloomComposer.setPixelRatio(this.renderer.getPixelRatio())
    const renderPass = new RenderPass(this.scene, this.camera)
    this.bloomComposer.addPass(renderPass)
    // 使用容器尺寸初始化 BloomPass，避免初始渲染分辨率错误（高清 bug 根因）
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.4, 0.85)
    this.bloomComposer.addPass(this.bloomPass)
    const outputPass = new OutputPass()
    this.bloomComposer.addPass(outputPass)
  }

  resize() {
    const width = this.container.clientWidth || window.innerWidth
    const height = this.container.clientHeight || window.innerHeight
    this._applySize(width, height)
  }

  /**
   * 显式指定尺寸进行 resize（供 CesiumThreeBridge 用 Cesium canvas 尺寸同步）
   * 同步 renderer / camera.aspect / bloomComposer 三者，避免任一遗漏导致模糊或错位
   * @param {number} width
   * @param {number} height
   */
  resizeTo(width, height) {
    const w = Math.max(1, width || 0)
    const h = Math.max(1, height || 0)
    this._applySize(w, h)
  }

  _applySize(width, height) {
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (this.bloomComposer) {
      this.bloomComposer.setSize(width, height)
      // 同步 pixelRatio，防止 EffectComposer 渲染目标分辨率与 renderer 不一致导致模糊
      this.bloomComposer.setPixelRatio(this.renderer.getPixelRatio())
    }
    // 等值线 LineMaterial 像素线宽依赖视口分辨率，随 resize 同步
    this._sceneBuilder?.setContourResolution?.(width, height)
  }

  /**
   * 将粒子系统定位到指定模拟时间（与时间轴同步）。
   * - 时间轴正常推进：增量更新粒子
   * - 时间轴暂停（targetTime ≈ simTime）：不更新，粒子静止
   * - 时间轴跳变（回退或大跨度前进）：异步重建并快进到 targetTime
   *
   * Web Worker 化后，跳变快进在 Worker 线程执行，主线程 UI 不卡顿。
   * 主线程同步快进特效（_effectManager），Worker 后台快进物理引擎，
   * Worker 完成后通过回调更新碎片 InstancedMesh。
   * @param {number} targetTime - 目标模拟时间（秒）
   */
  seekTo(targetTime) {
    if (!this.active) return
    const t = Math.max(0, Number(targetTime) || 0)
    const delta = t - this.simTime

    // 暂停或静止：不推进
    if (Math.abs(delta) < 0.001) return

    // 回到起点（循环重播）：同步重置，不走异步 Worker 快进。
    // 异步快进与主线程后续 update() 推进存在竞态——Worker 完成时主线程
    // simTime 已推进到爆破触发点后，碎片位置与掌子面/特效状态不一致，
    // 表现为"进度条重新循环但动画没有重播"。
    if (t === 0 && delta < 0) {
      this._resetToStart()
      return
    }

    // 回退或大跨度前进（>0.5s，相当于跳变）：异步重建并快进
    if (delta < 0 || delta > 0.5) {
      this._asyncSeekTo(t)
      return
    }

    // 正常增量推进
    this.update(delta)
  }

  /**
   * 同步重置到起爆前初始状态（循环重播回到 t=0 时调用）。
   * 不走异步 Worker 快进：targetTime=0 时快进 0 步无意义，且避免
   * 异步快进与主线程 update() 推进的竞态导致动画状态不一致。
   */
  _resetToStart() {
    if (!this._lastBlastParams) {
      console.warn('[BlastSim] _resetToStart 跳过：无 _lastBlastParams')
      return
    }
    if (!this._lastFragmentData) {
      console.warn('[BlastSim] _resetToStart 跳过：无 _lastFragmentData')
      return
    }
    this.simTime = 0
    this._fieldTimeLocked = true
    this._sceneBuilder?.setContourTime?.(0) // 等值线门控时间同步归零（防重播瞬间残留整幅旧线）
    this._sceneBuilder?.setFieldSimTime?.(0) // uSimTime 同步归零（解析外推波前门控重放）
    // 特效重置到 t=0
    if (this._lastEffectParams) {
      this._effectManager.clear()
      this._effectManager.init(this._lastEffectParams)
      for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
        this._effectManager.setVisible(layer, this.layerVisibility[layer] !== false)
      }
    }
    // 掌子面恢复未爆破状态
    this.blastTriggered = false
    this._sceneBuilder.applyBlastState(false)
    this._landAllAt = null

    // 回放模式：直接从预烘焙关键帧采样 t=0，瞬时完成、无竞态
    if (this._physicsEngine?.isReplayReady?.()) {
      this._physicsEngine.applyReplayAtTime(0)
      this._replayLandCursor = 0
      this._replayModeActive = true
      this._fragmentRenderer.updateFragmentMesh()
      this.renderFrame()
      this._fieldTimeLocked = false
      console.log('[BlastSim] 循环重播已重置（回放模式）', {
        replayDuration: this._physicsEngine.getReplayDurationS?.()
      })
      return
    }

    // 物理引擎原位重置到初始状态：复用已有刚体/凸包，仅重设位置与速度，
    // 避免 reset+init 重建数千凸包造成的长时间无物理状态（碎石不抛掷）
    const { specs, positions, velocities } = this._lastFragmentData
    this._physicsEngine.resetToInitial(specs, positions, velocities)
    this._physicsEngine.beginStepRecovery()
    // 立即用初始位置渲染碎片（不等 Worker 推送，避免一帧旧位置闪烁）
    this._fragmentRenderer.applyInitialPositions(positions)
    this.renderFrame()
    console.log('[BlastSim] 循环重播已重置', { fragmentCount: positions.length })
  }

  /**
   * 异步重建粒子系统并快进到指定时间（用于时间轴跳变）。
   *
   * 主线程：重建特效 + 同步快进 _effectManager 到 targetTime
   * Worker：后台 init + 循环 step 到 targetTime，完成后推送最终 bodyStates
   *
   * 快进期间碎片 InstancedMesh 暂不更新（Worker 未返回最终状态），
   * Worker 完成后立即渲染正确位置。
   */
  _asyncSeekTo(targetTime) {
    if (!this._lastBlastParams) return
    // 防止重复触发（用户连续拖动时间轴）。
    // _seekBlocked 覆盖 RAF 特效快进阶段；seekInProgress 覆盖 Worker 物理快进阶段。
    if (this._physicsEngine.seekInProgress || this._seekBlocked) return

    // 超时保护：RAF 回调或 Worker 回调丢失时，阻塞标志会永久阻塞后续 seekTo。
    // 与旧逻辑（在 _asyncSeekTo 开头起 3s 计时的 watchdog）不同：
    //  - RAF 特效快进阶段用较短 watchdog（该阶段主线程可控，正常 <1s 完成）；
    //  - Worker 物理快进阶段才真正消耗物理求解时间（Rapier 200+ 碎片 + 碎片间碰撞
    //    可能需数秒），watchdog 从 Worker 真正开始时起算并放宽到 10s，
    //    避免"合法但较慢的 seek"被误判超时而强制清除，进而反复重进 _asyncSeekTo。
    this._startSeekWatchdog('effect', 8000)

    // 不调用 initBlast（避免 clear 清除碎片 InstancedMesh 导致快进期间碎片消失）。
    // 只重置特效到 t=0 并快进，碎片保持当前位置，Worker 快进完成后更新到目标位置。
    this.simTime = 0
    // uSimTime 与播放时钟同步归零（此前只重置等值线时钟）：回跳 seek 后解析外推
    // 波前门控 gap = uSimTime - arrival 若仍用 seek 前的旧时间，波环位置/时变衰减
    // 与目标时刻的场纹理脱节。锁住 WS 尾帧的时间信任，uSimTime 由下方快进 tick
    // 逐帧推进到目标时刻。
    this._fieldTimeLocked = true
    this._sceneBuilder?.setContourTime?.(0) // 等值线门控时间同步归零
    this._sceneBuilder?.setFieldSimTime?.(0)
    if (this._lastEffectParams) {
      this._effectManager.clear()
      this._effectManager.init(this._lastEffectParams)
      for (const layer of ['fire', 'smoke', 'spark', 'dust', 'shock_wave']) {
        this._effectManager.setVisible(layer, this.layerVisibility[layer] !== false)
      }
    }

    // 按目标时刻同步掌子面/待爆岩体可见状态：
    // 回退到起爆前应恢复完整掌子面+待爆岩体；跳过起爆点后应显示破碎掌子面+掏槽腔
    const blastJustTriggered = targetTime >= this.blastTriggerTime
    this.blastTriggered = blastJustTriggered
    this._sceneBuilder.applyBlastState(blastJustTriggered)

    // 主线程分块快进特效到 targetTime（requestAnimationFrame，避免长循环阻塞主线程）。
    // 特效不含物理，单步 0.05s；每帧最多执行 STEPS_PER_FRAME 步（约 16ms 工作量），
    // 剩余步骤在下一帧 requestAnimationFrame 回调中继续，完成后移交 Worker 物理快进。
    const fireLight = this._sceneBuilder.fireLight
    const step = 0.05
    let remaining = Math.max(0, targetTime)
    const maxSteps = 800
    let stepCount = 0
    const STEPS_PER_FRAME = 16

    // 标记 RAF 阶段进行中，阻止此期间再次进入 _asyncSeekTo
    this._seekBlocked = true

    // 特效快进完成后启动 Worker 物理快进（保留原有 seekToAsync 调用与回调）。
    // 回放模式：跳过 Worker 重建/快进，直接采样预烘焙关键帧（瞬时完成、任意倍速）。
    const startWorkerSeek = () => {
      this._seekBlocked = false
      if (this._physicsEngine?.isReplayReady?.()) {
        this._clearSeekWatchdog()
        this.simTime = targetTime
        this._sceneBuilder?.setContourTime?.(targetTime) // 等值线门控时间随 seek 跳变
        // uSimTime 随 seek 跳变对齐（回放分支无快进 tick，需显式同步），
        // 同步后解锁恢复 WS 场帧时间的单调信任
        this._sceneBuilder?.setFieldSimTime?.(targetTime)
        this._fieldTimeLocked = false
        this._physicsEngine.applyReplayAtTime(targetTime)
        this._replayLandCursor = targetTime
        this._fragmentRenderer.updateFragmentMesh()
        this.renderFrame()
        return
      }
      // Worker 物理求解阶段单独起 watchdog（放宽到 10s，从真正开始时起算）
      this._startSeekWatchdog('physics', 10000)
      // Worker 异步快进物理引擎（后台 init + 循环 step）
      const { specs, positions, velocities } = this._lastFragmentData
      const bounds = this._lastPhysicsBounds
      this._physicsEngine.seekToAsync(targetTime, specs, positions, velocities, bounds, () => {
        // Worker 完成：清除 watchdog 并渲染一帧
        this._clearSeekWatchdog()
        // uSimTime 对齐目标时刻后解锁（快进 tick 已把播放时钟推进到 targetTime）
        this._sceneBuilder?.setFieldSimTime?.(this.simTime)
        this._fieldTimeLocked = false
        this._fragmentRenderer.updateFragmentMesh()
        this.renderFrame()
      })
    }

    const tick = () => {
      this._seekRafId = null
      // 每帧最多执行 STEPS_PER_FRAME 步，避免单帧工作量过大阻塞主线程
      let frameSteps = 0
      while (remaining > 0 && stepCount < maxSteps && frameSteps < STEPS_PER_FRAME) {
        const dt = Math.min(step, remaining)
        this.simTime += dt
        this._effectManager.update(dt, this.simTime)
        // 火光同步（加 NaN 守卫，与 update 方法一致）
        const fireIntensity = this._effectManager.getFireLightIntensity()
        if (Number.isFinite(fireIntensity)) {
          fireLight.intensity += (fireIntensity - fireLight.intensity) * 0.6
          if (fireLight.intensity < 0.01) fireLight.intensity = 0
        }
        remaining -= dt
        stepCount++
        frameSteps++
      }
      // uSimTime 跟随快进播放时钟（每 tick 一次即可）：解析外推波环/波前门控
      // 与场纹理同步重放，而非停留在 seek 前的旧时刻
      this._sceneBuilder?.setFieldSimTime?.(this.simTime)

      if (remaining > 0 && stepCount < maxSteps) {
        // 还有剩余步骤，下一帧继续
        this._seekRafId = requestAnimationFrame(tick)
      } else {
        // 全部完成（或达到步数上限），启动 Worker 物理快进
        startWorkerSeek()
      }
    }

    this._seekRafId = requestAnimationFrame(tick)
  }

  /**
   * 启动 seekTo 超时 watchdog。
   * 仅在 RAF/Worker 回调真正丢失时兜底强制清除阻塞标志，避免永久卡住后续 seek。
   * @param {'effect'|'physics'} kind - 当前阶段（仅用于日志）
   * @param {number} ms - 超时时长（毫秒）
   */
  _startSeekWatchdog(kind, ms) {
    this._clearSeekWatchdog()
    this._seekTimeout = setTimeout(() => {
      this._seekTimeout = null
      if (this._seekRafId) {
        cancelAnimationFrame(this._seekRafId)
        this._seekRafId = null
      }
      this._seekBlocked = false
      // 解除 seek 时间锁（uSimTime 停在归零值，锁死会让解析场波前永久全关）
      this._fieldTimeLocked = false
      if (this._physicsEngine && this._physicsEngine.seekInProgress) {
        console.warn(`[ThreeBlastingRenderer] seekTo(${kind}) 超时，强制清除阻塞标志`)
        this._physicsEngine.seekInProgress = false
      }
    }, ms)
  }

  _clearSeekWatchdog() {
    if (this._seekTimeout) {
      clearTimeout(this._seekTimeout)
      this._seekTimeout = null
    }
  }

  /** 取消进行中的 seek（上下文丢失等紧急场景），清理所有阻塞标志与定时器 */
  _cancelSeek() {
    this._clearSeekWatchdog()
    if (this._seekRafId) {
      cancelAnimationFrame(this._seekRafId)
      this._seekRafId = null
    }
    this._seekBlocked = false
    this._fieldTimeLocked = false
    if (this._physicsEngine) this._physicsEngine.seekInProgress = false
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
    this._lastCameraSyncMs = performance.now()
    this.camera.fov = fov
    this.camera.aspect = aspect
    this.camera.near = near
    this.camera.far = far
    this.camera.position.copy(position)
    this.camera.up.copy(up)

    // 使用方向/上方向直接构造相机姿态，避免大坐标下 lookAt 的精度损失。
    // 复用预分配 scratch 对象，避免每帧 new 导致 GC 压力
    const s = this._camScratch
    s.forward.copy(direction).normalize()
    s.cameraZ.copy(s.forward).negate()
    s.cameraX.crossVectors(up, s.cameraZ).normalize()
    s.cameraY.crossVectors(s.cameraZ, s.cameraX).normalize()
    s.rotationMatrix.makeBasis(s.cameraX, s.cameraY, s.cameraZ)
    this.camera.quaternion.setFromRotationMatrix(s.rotationMatrix)
    this.camera.updateMatrixWorld(true)
    this.camera.updateProjectionMatrix()
  }

  setBloomEnabled(enabled) {
    this.bloomEnabled = !!enabled
  }

  /**
   * 开启"点选拾取振动场"：单击时沿鼠标射线取与 PPV 场包围盒的交点，
   * 用振动场渲染器在世界坐标处采样 PPV/应力/损伤并回调。
   *
   * 设计要点：
   *  - 不依赖实体 mesh 命中（振动场直接着在岩体表面、可透明），改用 Box3
   *    与射线求交获得"该像素对应空间点"，最通用。
   *  - 用 pointerdown/pointerup 位移阈值区分"点击拾取"与"拖拽平移"，
   *    避免与 OrbitControls 左键平移冲突。
   *  - 纯增量：不改动渲染/相机/物理逻辑，仅在 canvas 上挂监听。
   *
   * @param {Function} handler - (sample|null) => void；sample 来自 sampleAtWorldPoint()
   * @param {Object} [opts]
   * @param {number} [opts.maxDragPx=4] - 判定为"点击"的最大拖拽位移(px)
   * @returns {Function} 用于关闭拾取的 detach 函数
   */
  enablePointPick(handler, opts = {}) {
    const maxDragPx = opts.maxDragPx ?? 4
    if (this._pickDetach) this._pickDetach()
    const canvas = this.renderer.domElement
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const _p0 = { x: 0, y: 0 }
    let down = false

    const box = () => {
      const fd = this._vibrationFieldRenderer?.getFieldData?.()
      if (!fd?.boundsMin || !fd?.boundsMax || !fd?.center) return null
      const { boundsMin, boundsMax } = fd
      return new THREE.Box3(
        new THREE.Vector3(boundsMin[0], boundsMin[1], boundsMin[2]).add(fd.center),
        new THREE.Vector3(boundsMax[0], boundsMax[1], boundsMax[2]).add(fd.center)
      )
    }

    const onDown = e => {
      down = true
      _p0.x = e.clientX
      _p0.y = e.clientY
    }
    const onUp = e => {
      if (!down) return
      down = false
      const dx = e.clientX - _p0.x
      const dy = e.clientY - _p0.y
      if (Math.hypot(dx, dy) > maxDragPx) return // 是拖拽，非点击
      const rect = canvas.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1)
      )
      raycaster.setFromCamera(ndc, this.camera)
      const b = box()
      if (!b) {
        handler(null)
        return
      }
      const hit = new THREE.Vector3()
      if (!raycaster.ray.intersectBox(b, hit)) {
        handler(null)
        return
      }
      const sample = this._vibrationFieldRenderer?.sampleAtWorldPoint?.(hit)
      handler(sample || null)
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)

    this._pickDetach = () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      this._pickDetach = null
    }
    return this._pickDetach
  }

  /** 关闭点选拾取 */
  disablePointPick() {
    if (this._pickDetach) this._pickDetach()
  }

  /**
   * 启动独立 Three.js 模式：不依赖 Cesium，使用 OrbitControls + RAF 渲染循环。
   * 相机由用户通过鼠标直接操控 Three.js 画布，不再每帧同步 Cesium 相机。
   */
  startStandaloneMode() {
    this._standalone = true
    // 确保画布尺寸正确（不再由 Cesium preRender 的 _syncCamera 调用 resizeTo）
    this.resize()
    if (!this._orbitControls) {
      this._orbitControls = new OrbitControls(this.camera, this.renderer.domElement)
      this._orbitControls.enableDamping = true
      this._orbitControls.dampingFactor = 0.08
      this._orbitControls.maxDistance = 300
      this._orbitControls.minDistance = 2
      this._orbitControls.target.copy(this.center)
      // 鼠标映射与非爆破模式（Cesium 相机）保持一致：
      // 左键 → 平移（拖拽模型前后左右），中键 → 旋转视角，右键/滚轮 → 缩放
      this._orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.DOLLY
      }
      // 触摸手势：单指平移，双指缩放旋转
      this._orbitControls.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_ROTATE
      }
      // OrbitControls change 事件 → 更新 _lastCameraSyncMs，
      // 使 renderFrame 中的相机移动检测生效（跳过 bloom）
      this._orbitControls.addEventListener('change', () => {
        this._lastCameraSyncMs = performance.now()
      })
    }
    this.startRenderLoop()
  }

  stopStandaloneMode() {
    this._standalone = false
    this.stopRenderLoop()
  }

  startRenderLoop() {
    if (this._renderLoopRaf) return
    const loop = () => {
      this._renderLoopRaf = requestAnimationFrame(loop)
      try {
        if (this._orbitControls) this._orbitControls.update()
        this.renderFrame()
      } catch (err) {
        // 任何组件抛异常都不能中断渲染循环，否则画面冻结且日志丢失
        console.error('[ThreeBlastingRenderer] 渲染帧异常已捕获:', err)
      }
    }
    this._renderLoopRaf = requestAnimationFrame(loop)
  }

  stopRenderLoop() {
    if (this._renderLoopRaf) {
      cancelAnimationFrame(this._renderLoopRaf)
      this._renderLoopRaf = null
    }
  }

  /**
   * 直接设置相机位置和朝向（跳转，非飞行）
   * @param {THREE.Vector3|number[]} position - 相机位置
   * @param {THREE.Vector3|number[]} target - 观察目标点
   */
  setCameraView(position, target) {
    this.camera.position.set(
      position.x ?? position[0],
      position.y ?? position[1],
      position.z ?? position[2]
    )
    const tx = target.x ?? target[0]
    const ty = target.y ?? target[1]
    const tz = target.z ?? target[2]
    this.camera.lookAt(tx, ty, tz)
    if (this._orbitControls) {
      this._orbitControls.target.set(tx, ty, tz)
      this._orbitControls.update()
    }
  }

  /**
   * 根据隧道尺寸和面方向计算并设置相机视角（跳转到隧道内部，面朝掌子面）
   * 使用 THREE.Vector3.crossVectors 确保方向正确
   */
  setupCameraView(tunnelLength, wallHeight) {
    const cameraDist = tunnelLength > 0 ? tunnelLength * 0.7 : 55
    const eyeHeight = wallHeight > 0 ? wallHeight : 6

    const dir = this.faceDirection.clone().normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    // 相机位置：center - forward * cameraDist + up * eyeHeight（隧道内部，掌子面后方）
    const pos = new THREE.Vector3()
      .copy(this.center)
      .addScaledVector(forward, -cameraDist)
      .addScaledVector(up, eyeHeight)
    // 观察目标：掌子面中心 = center + forward * 3
    const target = new THREE.Vector3().copy(this.center).addScaledVector(forward, 3)

    this.setCameraView(pos, target)
  }

  /**
   * 切换爆破三维观察视角预设：
   *  - 'interior'：隧道内部视角（掌子面后方，面朝掌子面，默认）
   *  - 'exterior'：外部测区视角（抬高、后移并略带侧偏，框住掌子面与抛掷/爆堆范围）
   * @param {string} mode - 'interior' | 'exterior'
   * @param {Object} [opts] - { tunnelLength, wallHeight }，缺省取隧道当前断面
   */
  setCameraViewMode(mode, opts = {}) {
    const tunnelLength = Number(opts.tunnelLength) > 0 ? Number(opts.tunnelLength) : 0
    const wallHeight =
      Number(opts.wallHeight) > 0 ? Number(opts.wallHeight) : this.tunnelWallHeight || 0
    const cameraDist = tunnelLength > 0 ? tunnelLength * 0.7 : 55
    const eyeHeight = wallHeight > 0 ? wallHeight : 6

    const dir = this.faceDirection.clone().normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    let pos
    let target
    if (mode === 'exterior') {
      // 外部测区视角：后退更远、抬高更高、略带侧偏，能整体看到掌子面、
      // 抛掷方向与爆堆形成区域
      pos = new THREE.Vector3()
        .copy(this.center)
        .addScaledVector(forward, -cameraDist * 1.6)
        .addScaledVector(up, eyeHeight * 2.7)
        .addScaledVector(right, -cameraDist * 0.38)
      target = new THREE.Vector3().copy(this.center).addScaledVector(forward, 16)
    } else {
      // 隧道内部视角：掌子面后方，面朝掌子面（默认）
      pos = new THREE.Vector3()
        .copy(this.center)
        .addScaledVector(forward, -cameraDist)
        .addScaledVector(up, eyeHeight)
      target = new THREE.Vector3().copy(this.center).addScaledVector(forward, 3)
    }

    this.setCameraView(pos, target)
  }

  /**
   * 高亮 physSize 在 [minSize, maxSize] 范围内的碎片
   * @param {number} minSize - 物理尺寸下限（米）
   * @param {number} maxSize - 物理尺寸上限（米）
   */
  highlightFragmentsBySize(minSize, maxSize) {
    this._fragmentRenderer.highlightBySizeRange(minSize, maxSize)
  }

  /** 清除碎片高亮，恢复原始颜色 */
  clearFragmentHighlight() {
    this._fragmentRenderer.clearHighlight()
  }

  /**
   * 获取块度分布统计：
   *  - 从 fragmentRenderer.fragmentMeshes 的 userData.specs 收集所有 spec.physSize
   *  - 按块度区间分组（0-0.1m, 0.1-0.3m, 0.3-0.5m, 0.5-1.0m, 1.0m+）
   *  - 计算 x50/x80/xmax 等特征尺寸
   * @returns {{ buckets: Array, total: number, x50: number|null, x80: number|null, xmax: number|null } | null}
   */
  getFragmentDistribution() {
    const meshes = this._fragmentRenderer?.fragmentMeshes
    if (!Array.isArray(meshes) || meshes.length === 0) return null

    const sizes = []
    for (const mesh of meshes) {
      const group = mesh.userData?.specs
      if (!Array.isArray(group)) continue
      for (const entry of group) {
        // 块度统计使用真实 KCO 粒径（体积还原前采样值），保持级配真实可比
        const physSize = Number(entry?.spec?.physSizeTrue || entry?.spec?.physSize)
        if (Number.isFinite(physSize) && physSize > 0) sizes.push(physSize)
      }
    }
    if (sizes.length === 0) return null

    // 块度区间定义（单位：米）
    const bucketDefs = [
      { min: 0, max: 0.1, label: '0 - 0.1 m' },
      { min: 0.1, max: 0.3, label: '0.1 - 0.3 m' },
      { min: 0.3, max: 0.5, label: '0.3 - 0.5 m' },
      { min: 0.5, max: 1.0, label: '0.5 - 1.0 m' },
      { min: 1.0, max: Infinity, label: '1.0 m+' }
    ]
    const total = sizes.length
    const buckets = bucketDefs.map(def => {
      // 上界开放、下界闭，避免边界重复计数（1.0 m+ 区间下界闭）
      const count = sizes.filter(
        s => s >= def.min && (def.max === Infinity ? true : s < def.max)
      ).length
      return {
        min: def.min,
        max: def.max === Infinity ? null : def.max,
        label: def.label,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0
      }
    })

    // 特征尺寸：将 physSize 升序排列后按分位数计算
    const sorted = [...sizes].sort((a, b) => a - b)
    const percentile = p => {
      if (sorted.length === 0) return null
      const idx = (p / 100) * (sorted.length - 1)
      const lo = Math.floor(idx)
      const hi = Math.ceil(idx)
      if (lo === hi) return sorted[lo]
      // 线性插值
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
    }
    return {
      buckets,
      total,
      x50: percentile(50),
      x80: percentile(80),
      xmax: sorted[sorted.length - 1] ?? null
    }
  }

  setBloomParams(params = {}) {
    if (!this.bloomPass) return
    if (params.strength != null) this.bloomPass.strength = Math.max(0, Number(params.strength))
    if (params.radius != null) this.bloomPass.radius = Math.max(0, Number(params.radius))
    if (params.threshold != null)
      this.bloomPass.threshold = Math.max(0, Math.min(1, Number(params.threshold)))
  }

  clear() {
    for (const key of Object.keys(this.particleGroups)) {
      if (this.particleGroups[key]) {
        this.scene.remove(this.particleGroups[key])
        this.particleGroups[key].geometry?.dispose()
        this.particleGroups[key].material?.dispose()
        this.particleGroups[key] = null
      }
    }
    // 清理碎片
    this._fragmentRenderer.clear()
    // 清理场景网格（掌子面/岩体/隧道/钻孔/标注）
    this._sceneBuilder.clear()
    this.active = false
    this.simTime = 0
    this.blastTriggered = false
    // 清理新架构模块
    this._physicsEngine.reset()
    this._effectManager.clear()
    // 清理振动场体积（释放 3D 纹理与 mesh，保留渲染器实例与 LUT 供下次重建）
    this._vibrationFieldRenderer?.disposeMesh()
    // 恢复待爆岩体不透明（振动场体积已清空，半透明透显无意义）
    this._sceneBuilder?.setRockSemiTransparent?.(false)
    // 清空振动波粒子
    this._vibrationParticles?.clear()
    this._fragmentSpecs = null
    this._lastSpecGenParams = null
    this._fragmentStats = null
    // 重置爆堆轮廓
    this._muckPileOutline?.clear?.()
  }

  dispose() {
    this.stopRenderLoop()
    this._clearSeekWatchdog()
    if (this._orbitControls) {
      this._orbitControls.dispose()
      this._orbitControls = null
    }
    this.clear()
    window.removeEventListener('resize', this._resizeHandler)
    // 移除上下文丢失/恢复监听，避免已销毁的渲染器响应事件
    const canvas = this.renderer.domElement
    canvas.removeEventListener('webglcontextlost', this._onCtxLost)
    canvas.removeEventListener('webglcontextrestored', this._onCtxRestored)
    Object.values(this.textures).forEach(tex => tex.dispose())
    this._fragmentRenderer.dispose()
    this.rockGeometries.forEach(g => g.dispose())
    this.rockGeometries = []
    this._sceneBuilder.dispose()
    this._effectManager.dispose()
    // 完全释放振动场渲染器（含 LUT 纹理）
    this._vibrationFieldRenderer?.dispose()
    // 释放振动波粒子
    this._vibrationParticles?.dispose()
    // 释放 Worker 资源，避免内存泄漏
    this._physicsEngine.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }

  getStats() {
    const generated =
      this._fragmentStats?.fragmentCountGenerated ?? this._physicsEngine.bodies.length
    return {
      total: this._physicsEngine.bodies.length,
      alive: this._physicsEngine.aliveFragmentCount,
      landed: this._physicsEngine.landedFragmentCount,
      chargeKg: this._fragmentStats?.chargeKg ?? this.chargeKg,
      explosiveType: this._fragmentStats?.explosiveType ?? null,
      rockDensityKgM3: this._fragmentStats?.rockDensityKgM3 ?? null,
      fragmentCountTarget: this._fragmentStats?.fragmentCountTarget ?? generated,
      fragmentCountGenerated: generated,
      fragmentCountRendered: this._physicsEngine.bodies.length,
      fragmentCountRenderLimit: this._fragmentStats?.fragmentCountRenderLimit ?? generated,
      kcoSourceMode: this._fragmentStats?.kcoSourceMode ?? KCO_SOURCE_MODE.DESIGN,
      x50Applied: this._fragmentStats?.x50Applied ?? null,
      nApplied: this._fragmentStats?.nApplied ?? null,
      x80Applied: this._fragmentStats?.x80Applied ?? null,
      xmaxApplied: this._fragmentStats?.xmaxApplied ?? null,
      bApplied: this._fragmentStats?.bApplied ?? null,
      x50Computed: this._fragmentStats?.x50Computed ?? null,
      nComputed: this._fragmentStats?.nComputed ?? null,
      fragmentMassTargetKg: this._fragmentStats?.fragmentMassTargetKg ?? null,
      fragmentMassGeneratedKg: this._fragmentStats?.fragmentMassGeneratedKg ?? null,
      fragmentMassBlastedKg: this._fragmentStats?.fragmentMassBlastedKg ?? null,
      fragmentMassCoverage: this._fragmentStats?.fragmentMassCoverage ?? null,
      blastVolumeM3: this._fragmentStats?.blastVolumeM3 ?? null,
      estimatedMeanMassKg: this._fragmentStats?.estimatedMeanMassKg ?? null,
      velocityMean: this._fragmentStats?.velocityMean ?? null,
      velocityP95: this._fragmentStats?.velocityP95 ?? null,
      throwDistancePredictedAvg: this._fragmentStats?.throwDistancePredictedAvg ?? null,
      throwDistancePredictedMax: this._fragmentStats?.throwDistancePredictedMax ?? null,
      throwDistanceTargetAvg: this._fragmentStats?.throwDistanceTargetAvg ?? null,
      throwDistanceTargetMax: this._fragmentStats?.throwDistanceTargetMax ?? null,
      velocityScaleApplied: this._fragmentStats?.velocityScaleApplied ?? 1,
      sizeHistogramGenerated: this._fragmentStats?.sizeHistogramGenerated ?? null,
      sizeHistogramTarget: this._fragmentStats?.sizeHistogramTarget ?? null,
      sizeKLDivergence: this._fragmentStats?.sizeKLDivergence ?? null,
      velocityHistogramGenerated: this._fragmentStats?.velocityHistogramGenerated ?? null,
      energyStats: this._physicsEngine?.getEnergyStats?.() ?? null
    }
  }

  setTunnelSection(section = {}) {
    if (!section || typeof section !== 'object') return
    // 同步更新 SceneBuilder 中的隧道参数
    this._sceneBuilder.setTunnelSection(section)
    // 同步本地隧道参数
    this.tunnelSection = this._sceneBuilder.tunnelSection
    this.tunnelWidth = this._sceneBuilder.tunnelWidth
    this.tunnelWallHeight = this._sceneBuilder.tunnelWallHeight
    this.tunnelArchRadius = this._sceneBuilder.tunnelArchRadius
    this.tunnelHeight = this._sceneBuilder.tunnelHeight
    this.benchHeight = this.tunnelHeight
    this.benchWidth = this.tunnelWidth
    this.benchLength = this._sceneBuilder.benchLength
    if (this.facePosition) this._sceneBuilder.buildBenchGeometry()
  }

  /**
   * 注入数据库炮孔设计数据与其他爆破设计参数
   * 调用后 _buildBlastHoles 将优先使用数据库数据动态渲染钻孔布局
   * @param {Array} holes - 数据库炮孔设计数组（来自 dataset.design.holes）
   * @param {Object} [designParams] - 其他爆破设计参数（来自 dataset.design.designParams）
   */
  setBlastHoleDesign(holes, designParams = null) {
    this._sceneBuilder.blastHoleDesign = Array.isArray(holes) ? holes : null
    if (designParams && typeof designParams === 'object') {
      this._sceneBuilder.designParams = designParams
    }
  }

  /** 清除数据库炮孔设计数据，回退到硬编码布局 */
  clearBlastHoleDesign() {
    this._sceneBuilder.blastHoleDesign = null
    this._sceneBuilder.designParams = null
  }

  /**
   * 构建用于碎片规格生成器的炮孔数据
   * 从 blastHoleDesign 提取 posX/posY/chargeKg/delayMs/isEmptyHole/holeType，
   * 转换为 fragmentSpecGenerator 需要的 {x, y, chargeKg, delayMs, isEmpty, holeType} 格式
   * @returns {Array<Object>|null}
   */
  _buildHoleSpecsForFragmentGen() {
    const blastHoleDesign = this._sceneBuilder.blastHoleDesign
    if (!Array.isArray(blastHoleDesign) || blastHoleDesign.length === 0) {
      return null
    }
    return blastHoleDesign.map(h => {
      // 孔型映射：与 sceneBuilder._collectDesignHoles 一致
      const rawType = (h.holeType || 'production').toLowerCase()
      let holeType = 'auxiliary'
      if (h.isEmptyHole) holeType = 'empty'
      else if (rawType === 'cut' || rawType === 'easing') holeType = 'cut'
      else if (rawType === 'perimeter') holeType = 'perimeter'
      return {
        x: Number(h.posX) || 0,
        y: Number(h.posY) || 0,
        chargeKg: Number(h.chargeKg) || 0,
        delayMs: Number(h.delayMs) || 0,
        isEmpty: !!h.isEmptyHole,
        holeType
      }
    })
  }

  /**
   * 注入爆破效果数据（表2：超欠挖/爆破漏斗/最大抛掷距离/半孔率等）
   * 存储后可在渲染时用于：漏斗坑可视化（craterDepth/craterRadius）、
   * 周边孔半孔率标注（halfHoleRatio）、碎块尺寸（fragmentX50）等
   * @param {Object} effect - 来自 dataset.design.blastEffect
   */
  setBlastEffect(effect) {
    this._sceneBuilder.blastEffect = effect || null
  }

  // ─── PPV 振动场（实时推送的动态热力图）──────────────────────

  /**
   * 计算隧道局部基向量 (right, up, forward)
   * 与 initBlast 中一致：forward = faceDirection 投影到水平面后归一化
   * @returns {{right: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3}}
   */
  _computeTunnelBasis() {
    const up = new THREE.Vector3(0, 1, 0)
    const dir = this.faceDirection.clone()
    // 投影到水平面（去除垂直分量），保证 right 水平
    dir.y = 0
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1)
    dir.normalize()
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()
    return { right, up, forward }
  }

  /**
   * 初始化（或重建）PPV 振动场体积。
   * 由 useBlasting 在收到首个 PPV 二进制帧时调用，
   * 使用当前爆心与隧道朝向定位 box。
   * @param {Object} cfg
   * @param {number[]} cfg.gridShape - [nx, ny, nz]
   * @param {number[]} cfg.boundsMin - [x,y,z]
   * @param {number[]} cfg.boundsMax - [x,y,z]
   */
  initVibrationField(cfg) {
    if (!this._vibrationFieldRenderer) return
    const { right, up, forward } = this._computeTunnelBasis()
    const origin = cfg?.origin ?? this._blastOrigin
    this._vibrationFieldRenderer.init({
      gridShape: cfg.gridShape,
      boundsMin: cfg.boundsMin,
      boundsMax: cfg.boundsMax,
      center: this.center,
      right,
      up,
      forward,
      origin
    })
    // 将振动场数据纹理/坐标基注入岩体表面着色材质（应力/损伤/PPV 直接渲染在岩体上）
    this._applyVibrationFieldToBench()
    // 波场可达半径（= 爆心 → 岩体几何最远顶点）回传给 manager：
    // 本地模拟器/后端包络必须取同一半径，否则本地兜底接管时会在岩体中部截断
    const rInfluence = this._sceneBuilder?.influenceRadius ?? 0
    if (Number(rInfluence) > 0) this.onInfluenceRadiusMeasured?.(Number(rInfluence))
    // 点选查询的遮挡/轴向延展修正与 shader 同口径：getter 保证岩体重建后取最新洞身参数
    this._vibrationFieldRenderer?.setHoleGeomProvider?.(() => this._sceneBuilder?._holeGeom || null)
    // 同步场盒外解析外推（萨道夫斯基）的物理参数与初始时间
    this._applyFieldPhysics()
    // 解析外推的波源随爆心注入（掏槽孔质心），保证盒外波前与盒内纹理同源
    this._sceneBuilder?.applyFieldPhysics?.({
      origin: Array.isArray(origin) ? origin : [origin.x, origin.y, origin.z]
    })
    this._sceneBuilder?.setFieldSimTime?.(this.simTime ?? 0)
    // 同步初始化振动波粒子特效（使用相同的坐标系基；显隐由独立图层 vibrationParticles 控制）
    this._vibrationParticles.init({
      center: this.center,
      right,
      up,
      forward,
      section: {
        width: this.tunnelWidth,
        wallHeight: this.tunnelWallHeight,
        archRadius: this.tunnelArchRadius,
        shape: this.tunnelSection.shape
      }
    })
    this._vibrationParticles.setVisible(this.layerVisibility.vibrationParticles !== false)
    // 同步当前图层可见性
    this._vibrationFieldRenderer.setVisible(this.layerVisibility.vibrationField !== false)
    // 联动岩体表面场着色强度
    this._applyVibrationOcclusion()
  }

  /**
   * 将振动场数据纹理/坐标基注入岩体表面着色材质。
   * 数据由 BlastVibrationFieldRenderer 持有，这里转发给 SceneBuilder 的 benchMesh 材质。
   */
  _applyVibrationFieldToBench() {
    if (!this._sceneBuilder?.setBenchFieldData) return
    const data = this._vibrationFieldRenderer?.getFieldData?.()
    if (data) this._sceneBuilder.setBenchFieldData(data)
  }

  /**
   * 根据振动场图层的开关状态，联动岩体表面场着色强度。
   * 开启且已有场数据时 → 岩体表面按场数据着色；
   * 关闭或数据被清空 → 岩体恢复岩石本色。
   */
  _applyVibrationOcclusion() {
    const on =
      this.layerVisibility?.vibrationField !== false && !!this._vibrationFieldRenderer?.hasAnyField
    this._sceneBuilder?.setRockSemiTransparent?.(on)
  }

  /**
   * 更新振动波传播粒子（每帧由本地模拟器驱动）
   * @param {Array} particles - VibrationParticleSystem 的活跃粒子
   */
  updateVibrationParticles(particles) {
    this._vibrationParticles?.update(particles || [])
  }

  /** 清空振动波粒子 */
  clearVibrationParticles() {
    this._vibrationParticles?.clear()
  }

  /**
   * 岩体热力图解析外推的时间源统一推进（防回退防闪烁）。
   *
   * 热力图（岩面片元着色器的解析外推）的时间由本地播放时钟平滑驱动：
   * renderer.update() 每帧写 uSimTime = this.simTime，单调推进且支持循环归零重放。
   * WS 场帧按 ~0.1s 推送、到达常滞后于本地播放时钟（倍速时更甚）；若其 t 直接覆盖，
   * uSimTime 会回退 → 波前 gap<0、front 过渡项归零 → 整片明灭 / 亮环跳闪
   * （多源延时场景对时间更敏感，表现最明显）。
   *
   * 处理：仅当帧时间超前本地时钟时才前推 uSimTime。这样
   *  - 正常播放：本地时钟领先 → WS 迟到帧被忽略，时间单调；
   *  - 被动大屏/本地时钟未推进：WS t 始终超前 simTime → 热力图仍由 WS 帧驱动；
   *  - 循环/回跳归零：本地时钟归零后自己重写，热力图正常重播。
   * @param {number} t - 场帧的模拟时间(s)
   */
  _advanceFieldSimTime(t) {
    if (this._fieldTimeLocked) return
    if (t > this.simTime) this._sceneBuilder?.setFieldSimTime?.(t)
  }

  /**
   * 更新 PPV 场数据（每个二进制帧调用）
   * @param {Float32Array} ppv
   * @param {number} t
   * @param {number} frame
   */
  updateVibrationField(ppv, t, frame) {
    this._vibrationFieldRenderer?.updateField(ppv, t, frame)
    this._advanceFieldSimTime(t)
  }

  /** 更新 σ_vm 应力场（每个 STRESS 二进制帧调用） */
  updateStressField(sigmaVm, t, frame) {
    this._vibrationFieldRenderer?.updateStressField(sigmaVm, t, frame)
    this._advanceFieldSimTime(t)
  }

  /** 更新损伤分区场（每个 DAMAGE 二进制帧调用） */
  updateDamageField(zones, t, frame) {
    this._vibrationFieldRenderer?.updateDamageField(zones, t, frame)
    this._advanceFieldSimTime(t)
  }

  /**
   * 【Seek 清屏】把 PPV/应力/损伤三张 3D 场纹理全部清零并强制重传。
   *
   * 拖动进度条后"糊成色块"的直接来源：GPU 里仍驻留着 seek 前的场数据
   * （尤其是峰值/损伤这类"未来帧最大值"，以及应力纹理的旧时刻切片），
   * 新帧到达前着色器读到的是新旧混合内容。清零后在新帧落地前不再显示
   * 任何残留，等价于"Seek 期间阻塞着色器读取旧数据"。
   */
  clearFieldTextures() {
    this._vibrationFieldRenderer?.clearFieldTextures?.()
  }

  /**
   * 注入场盒外解析外推（萨道夫斯基）的物理参数，并应用到岩体表面着色材质。
   * @param {Object} params - { chargeKg, k, alpha, beta, visualCp, rho, cp, nu }
   */
  setFieldPhysics(params) {
    this._fieldPhysicsParams = { ...(this._fieldPhysicsParams || {}), ...params }
    this._applyFieldPhysics()
  }

  /** 将缓存的场物理参数下发到 SceneBuilder（采样一致性） */
  _applyFieldPhysics() {
    if (!this._fieldPhysicsParams) return
    this._sceneBuilder?.applyFieldPhysics?.(this._fieldPhysicsParams)
  }

  /** 切换振动场显示模式（ppv/stress/damage） */
  setVibrationDisplayMode(mode) {
    this._vibrationFieldRenderer?.setDisplayMode(mode)
    // 同步岩体表面着色模式
    const m = this._vibrationFieldRenderer?.displayModeValue
    if (m != null) this._sceneBuilder?.setBenchFieldDisplayMode?.(m)
  }

  /** 切换振动场底材"白模"：true=场图层开启时切白模底，false=保留岩石纹理底 */
  setBenchWhiteModel(enabled) {
    this._sceneBuilder?.setFieldWhiteModel?.(!!enabled)
  }

  /** 开关振动场等力线（等值线）叠加显示 */
  setIsoLine(enabled) {
    this._sceneBuilder?.setIsoLine?.(!enabled ? { on: false } : { on: true })
  }

  /** 设置等值线样式（线宽 px / 统一颜色；color=null 恢复按级别取色） */
  setIsoLineStyle({ width, color } = {}) {
    this._sceneBuilder?.setIsoLine?.({ width, color })
  }

  /**
   * 设置干涉载波频率（视觉 Hz）：瞬时质点速度 × cos(2πf·gap) 形成多孔延时
   * 干涉波纹。0=关闭（单调包络叠加）。范围 0~48 Hz。
   */
  setCarrierHz(hz) {
    this._sceneBuilder?.setCarrierHz?.(hz)
  }

  /** 设置色彩映射标尺：0=线性，1=对数（默认；适应 PPV/应力幂律衰减） */
  setNormMode(mode) {
    this._sceneBuilder?.setNormMode?.(mode)
  }

  /** 设置半透明渲染（1=场色上限 0.55 露出岩底，0=实色 0.85） */
  setFieldTranslucent(on) {
    this._sceneBuilder?.setFieldTranslucent?.(!!on)
  }

  /** 下发矢量箭头场（P1-6：波传播方向可视化；数据来自 blastingManager 逐帧计算） */
  setVectorField(data) {
    this._sceneBuilder?.setVectorField?.(data || null)
  }

  /** 清空/隐藏矢量箭头场 */
  clearVectorField() {
    this._sceneBuilder?.clearVectorField?.()
  }

  /**
   * 导出岩面顶点集（grid 局部系）+ 洞身整形参数，供等值线峰值场计算。
   * 含版本号（几何 build/爆后切换/剖切时自增），调用方据此判断是否重提取。
   */
  getContourSurface() {
    return this._sceneBuilder?.getContourSurface?.() ?? null
  }

  /** 波场可达半径（= 爆心 → 岩体几何最远顶点，m；0=岩体尚未构建） */
  getInfluenceRadius() {
    return this._sceneBuilder?.influenceRadius ?? 0
  }

  /** 下发等值线折线组（contourExtractor 输出）构建 Line2 渲染组 */
  setContourPolylines(data) {
    this._sceneBuilder?.setContourPolylines?.(data)
  }

  /** 当前热力图渲染参数（displayMode/normMode/满刻度，等值线级别计算同口径） */
  getFieldRenderParams() {
    return this._sceneBuilder?.getFieldRenderParams?.() ?? null
  }

  /** 当前是否已有可渲染的振动场（三场中任意一场有数据即视为已初始化） */
  hasVibrationField() {
    return !!this._vibrationFieldRenderer?.hasAnyField
  }

  /** 振动场元信息（供 UI 显示当前场时间/帧/网格） */
  getVibrationFieldInfo() {
    return this._vibrationFieldRenderer?.getFieldInfo?.() ?? null
  }

  /** 设置爆破场景对象透明度（供爆破模式下外部工具/面板控制） */
  setSceneObjectOpacity(which, opacity) {
    this._sceneBuilder?.setObjectOpacity?.(which, opacity)
  }

  /** 读取爆破场景对象透明度 */
  getSceneObjectOpacity(which) {
    return this._sceneBuilder?.getObjectOpacity?.(which) ?? null
  }

  /** 设置岩体剖面裁剪（爆破模式下观察内部） */
  setSceneSection(plane) {
    this._sceneBuilder?.setSectionPlane?.(plane)
  }

  /** 读取当前岩体剖面裁剪 */
  getSceneSection() {
    return this._sceneBuilder?.getSectionPlane?.() ?? { enabled: 0, axis: 0, pos: 0 }
  }

  /**
   * 拾取式剖切：在岩体表面拾取一点后，沿所选轴切出过该点的平面。
   * @param {number} axis 0=X 1=Y 2=Z
   * @param {{x,y,z}} point 岩体局部坐标
   */
  setSceneSectionPick(axis, point) {
    return this._sceneBuilder?.setSectionPick?.(axis, point) ?? { enabled: 0 }
  }

  /** 显示/隐藏拾取点标记（选轴前给出视觉反馈） */
  setScenePickPointMarker(point) {
    this._sceneBuilder?.setPickPointMarker?.(point)
  }

  /** 绘制监测点（测点）持久标记：维护岩体上已放置测点的粉球+光晕 */
  setMonitorPointMarkers(points) {
    this._sceneBuilder?.setMonitorPointMarkers?.(points)
  }

  /** 清除拾取式剖切（还原完整岩体并移除轮廓标记） */
  clearSceneSectionPick() {
    this._sceneBuilder?.clearSectionPick?.()
  }

  /**
   * 在爆破场景中对真实岩体网格做射线拾取，返回命中的岩体局部坐标点。
   * @param {(local:{x,y,z}|null)=>void} handler
   * @param {Object} [opts]
   * @param {number} [opts.maxDragPx=4] - 判定为"点击"的最大拖拽位移(px)
   * @returns {Function} detach 函数（用于停止拾取）
   */
  pickRockPoint(handler, opts = {}) {
    const maxDragPx = opts.maxDragPx ?? 4
    if (this._pickDetach) this._pickDetach()
    const sceneBuilder = this._sceneBuilder
    const canvas = this.renderer?.domElement
    if (!canvas || !sceneBuilder) {
      handler(null)
      return () => {}
    }
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const _p0 = { x: 0, y: 0 }
    let down = false

    const onDown = e => {
      down = true
      _p0.x = e.clientX
      _p0.y = e.clientY
    }
    const onUp = e => {
      if (!down) return
      down = false
      const dx = e.clientX - _p0.x
      const dy = e.clientY - _p0.y
      if (Math.hypot(dx, dy) > maxDragPx) return
      const rect = canvas.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1)
      )
      raycaster.setFromCamera(ndc, this.camera)
      const meshes = sceneBuilder.getRockMeshes?.() || []
      for (const m of meshes) {
        if (!m.visible) continue
        const hit = raycaster.intersectObject(m, false)[0]
        if (!hit) continue
        // 世界命中点 → 岩体局部坐标（几何剖切基于局部坐标）
        const local = m.worldToLocal(hit.point.clone())
        handler({ x: local.x, y: local.y, z: local.z, world: hit.point })
        return
      }
      handler(null)
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)

    this._pickDetach = () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      this._pickDetach = null
    }
    return this._pickDetach
  }

  /** 设置振动场 raymarching 步数（性能/精度权衡） */
  setVibrationFieldRaySteps(n) {
    this._vibrationFieldRenderer?.setRaySteps(n)
  }

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
    // 粒子图层：委托给 BlastEffectManager
    if (['fire', 'smoke', 'spark', 'dust', 'shock_wave'].includes(layer)) {
      this._effectManager.setVisible(layer, visible)
    }
    // 泛光光斑总开关：统一管控火花/火球/冲击波等辉光类粒子的显隐
    if (layer === 'glow') {
      this._effectManager.setGlowVisible(visible)
    }
    // 振动波传播粒子特效：独立于振动场热力图，单独开关
    if (layer === 'vibrationParticles') {
      this._vibrationParticles?.setVisible(visible)
    }
    // 碎片图层：委托给 FragmentRenderer
    if (layer === 'fragment') {
      this._fragmentRenderer.applyLayerVisibility(visible)
    }
    // 场景网格图层：委托给 SceneBuilder
    if (['tunnel', 'bench', 'face', 'blastHoles', 'annotations'].includes(layer)) {
      this._sceneBuilder.applyLayerVisibility(layer, visible, this.blastTriggered)
    }
    // PPV 振动场图层（仅热力图，不含波前粒子特效——粒子特效由 vibrationParticles 独立控制）
    if (layer === 'vibrationField') {
      this._vibrationFieldRenderer?.setVisible(visible)
      // 联动待爆岩体半透明度，透显应力/损伤云图
      this._applyVibrationOcclusion()
    }
  }

  /** 获取当前所有图层可见性状态（供 UI 回显） */
  getLayerVisibility() {
    return { ...this.layerVisibility }
  }

  // ─── 爆堆轮廓（三维包络 + 安息角标注）────────────────────

  /** 开启/关闭爆堆轮廓渲染 */
  setMuckPileOutlineEnabled(enabled) {
    this._muckPileEnabled = !!enabled
    this._muckPileOutline?.setEnabled?.(this._muckPileEnabled)
  }

  /** 当前爆堆轮廓是否可见 */
  getMuckPileOutlineEnabled() {
    return !!this._muckPileOutline?.visible
  }

  /** 爆堆测量值（安息角/堆高/堆宽/堆长），供 UI 回读 */
  getMuckPileMeasure() {
    return this._muckPileOutline?.measure ?? null
  }

  /**
   * 获取爆破设计数据（供 UI 展示炮孔布置图与统计）
   * @returns {object|null} 包含炮孔布置、统计、装药参数等
   */
  getBlastDesign() {
    const blastHolePattern = this._sceneBuilder.blastHolePattern
    if (!blastHolePattern) return null
    const p = blastHolePattern
    const dp = this._sceneBuilder.designParams || {}
    const W = p.section.W
    const Hw = p.section.Hw
    const R = p.section.R
    const totalH = p.section.totalH
    const sectionArea = calcHorseshoeArea(W, Hw, R)
    const holeDepth = Number(dp.holeDepth) || 2.5
    const utilization = Number(dp.utilization) || 0.85
    const advanceDepth = Number(dp.advanceLength) || holeDepth * utilization
    const volumePerRound = sectionArea * advanceDepth // 单循环爆破方量(m³)
    const chargeDensityCut = Number(dp.chargeDensityCut) || 1.2
    const chargeDensityAux = Number(dp.chargeDensityAux) || 1.0
    const chargeDensityPerim = Number(dp.chargeDensityPerim) || 0.7
    const cutCharge = p.counts.cut * holeDepth * chargeDensityCut
    const auxCharge = p.counts.auxiliary * holeDepth * chargeDensityAux
    const perimCharge = p.counts.perimeter * holeDepth * chargeDensityPerim
    const totalCharge = cutCharge + auxCharge + perimCharge
    const specificCharge = totalCharge / volumePerRound // 炸药单耗 kg/m³
    return {
      section: { W, Hw, R, totalH, area: sectionArea },
      holeDepth,
      utilization,
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
