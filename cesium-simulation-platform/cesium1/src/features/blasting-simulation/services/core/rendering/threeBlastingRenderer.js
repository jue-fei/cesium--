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
 *
 * 组合控制器（本类作为门面 facade 保留全部对外公共 API，方法体一行委托）：
 *  - BlastInitController：initBlast 粒子/碎片初始化流程
 *  - SeekController：时间轴 seek/跳变/watchdog
 *  - PointPicker：点选拾取（PPV 场/岩体射线命中）与拾取点/测点标记
 *  - VibrationFieldPipeline：振动场纹理管道与场渲染样式转发
 *  - CameraViewController：相机同步/视角预设/resize/独立模式渲染循环
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { BlastPhysicsEngineWorker } from '../computation/blastPhysicsEngineWorker.js'
import { BlastEffectManager } from './blastEffectManager.js'
import { KCO_SOURCE_MODE } from '../computation/kcoModelCore.js'
import { createRockGeometryPool } from './rockGeometryFactory.js'
import { BlastInitController } from './blastInitController.js'
import { SeekController } from './seekController.js'
import { PointPicker } from './pointPicker.js'
import { VibrationFieldPipeline } from './vibrationFieldPipeline.js'
import { CameraViewController } from './cameraViewController.js'
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
      this._seekController._cancelSeek()
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
    // 本地场时钟最后活跃时刻（ms）：update() 每帧刷新；_advanceFieldSimTime 据此在
    // 活动播放期间忽略 WS 场帧的超前时间推进（防波前横跳），被动大屏仍由 WS 驱动
    this._lastLocalFieldClockMs = null
    this._wsAheadWarned = false
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
    // mesh 图层：tunnel/bench/face/blastHoles/annotations
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

    // ── 职责域控制器（组合模式）：各控制器仅持有门面引用（this.r），
    // 仿真状态仍全部保存在门面实例上；控制器之间互不引用，仅经门面协作 ──
    this._initController = new BlastInitController(this)
    this._seekController = new SeekController(this)
    this._pointPicker = new PointPicker(this)
    this._fieldPipeline = new VibrationFieldPipeline(this)
    this._cameraView = new CameraViewController(this)

    // 窗口大小调整
    this._resizeHandler = () => this.resize()
    window.addEventListener('resize', this._resizeHandler)

    // 初始化尺寸：同步 renderer/camera/bloomComposer 三者，修复初始渲染不高清 bug
    this.resize()

    // 调试钩子已移除
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
    this._initController.initBlast(params)
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
    this._fieldPipeline._applyVibrationOcclusion()

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
    this._cameraView.resize()
  }

  /**
   * 显式指定尺寸进行 resize（供 CesiumThreeBridge 用 Cesium canvas 尺寸同步）
   * 同步 renderer / camera.aspect / bloomComposer 三者，避免任一遗漏导致模糊或错位
   * @param {number} width
   * @param {number} height
   */
  resizeTo(width, height) {
    this._cameraView.resizeTo(width, height)
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
    this._seekController.seekTo(targetTime)
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
    this._cameraView.syncCamera(position, direction, up, fov, aspect, near, far)
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
    this._pointPicker.enablePointPick(handler, opts)
  }

  /** 关闭点选拾取 */
  disablePointPick() {
    this._pointPicker.disablePointPick()
  }

  /**
   * 启动独立 Three.js 模式：不依赖 Cesium，使用 OrbitControls + RAF 渲染循环。
   * 相机由用户通过鼠标直接操控 Three.js 画布，不再每帧同步 Cesium 相机。
   */
  startStandaloneMode() {
    this._cameraView.startStandaloneMode()
  }

  stopStandaloneMode() {
    this._cameraView.stopStandaloneMode()
  }

  startRenderLoop() {
    this._cameraView.startRenderLoop()
  }

  stopRenderLoop() {
    this._cameraView.stopRenderLoop()
  }

  /**
   * 直接设置相机位置和朝向（跳转，非飞行）
   * @param {THREE.Vector3|number[]} position - 相机位置
   * @param {THREE.Vector3|number[]} target - 观察目标点
   */
  setCameraView(position, target) {
    this._cameraView.setCameraView(position, target)
  }

  /**
   * 根据隧道尺寸和面方向计算并设置相机视角（跳转到隧道内部，面朝掌子面）
   * 使用 THREE.Vector3.crossVectors 确保方向正确
   */
  setupCameraView(tunnelLength, wallHeight) {
    this._cameraView.setupCameraView(tunnelLength, wallHeight)
  }

  /**
   * 切换爆破三维观察视角预设：
   *  - 'interior'：隧道内部视角（掌子面后方，面朝掌子面，默认）
   *  - 'exterior'：外部测区视角（抬高、后移并略带侧偏，框住掌子面与抛掷/爆堆范围）
   * @param {string} mode - 'interior' | 'exterior'
   * @param {Object} [opts] - { tunnelLength, wallHeight }，缺省取隧道当前断面
   */
  setCameraViewMode(mode, opts = {}) {
    this._cameraView.setCameraViewMode(mode, opts)
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
    this._seekController._clearSeekWatchdog()
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
   * 注入爆破效果数据（表2：超欠挖/爆破漏斗/最大抛掷距离/半孔率等）
   * 存储后可在渲染时用于：漏斗坑可视化（craterDepth/craterRadius）、
   * 周边孔半孔率标注（halfHoleRatio）、碎块尺寸（fragmentX50）等
   * @param {Object} effect - 来自 dataset.design.blastEffect
   */
  setBlastEffect(effect) {
    this._sceneBuilder.blastEffect = effect || null
  }

  // ─── PPV 振动场（实时推送的动态热力图）：委托 VibrationFieldPipeline ──

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
    this._fieldPipeline.initVibrationField(cfg)
  }

  /**
   * 更新振动波传播粒子（每帧由本地模拟器驱动）
   * @param {Array} particles - VibrationParticleSystem 的活跃粒子
   */
  updateVibrationParticles(particles) {
    this._fieldPipeline.updateVibrationParticles(particles)
  }

  /** 清空振动波粒子 */
  clearVibrationParticles() {
    this._fieldPipeline.clearVibrationParticles()
  }

  /**
   * 更新 PPV 场数据（每个二进制帧调用）
   * @param {Float32Array} ppv
   * @param {number} t
   * @param {number} frame
   */
  updateVibrationField(ppv, t, frame) {
    this._fieldPipeline.updateVibrationField(ppv, t, frame)
  }

  /** 更新 σ_vm 应力场（每个 STRESS 二进制帧调用） */
  updateStressField(sigmaVm, t, frame) {
    this._fieldPipeline.updateStressField(sigmaVm, t, frame)
  }

  /** 更新损伤分区场（每个 DAMAGE 二进制帧调用） */
  updateDamageField(zones, t, frame) {
    this._fieldPipeline.updateDamageField(zones, t, frame)
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
    this._fieldPipeline.clearFieldTextures()
  }

  /**
   * 注入场盒外解析外推（萨道夫斯基）的物理参数，并应用到岩体表面着色材质。
   * @param {Object} params - { chargeKg, k, alpha, beta, visualCp, rho, cp, nu }
   */
  setFieldPhysics(params) {
    this._fieldPipeline.setFieldPhysics(params)
  }

  /** 切换振动场显示模式（ppv/stress/damage） */
  setVibrationDisplayMode(mode) {
    this._fieldPipeline.setVibrationDisplayMode(mode)
  }

  /** 切换振动场底材"白模"：true=场图层开启时切白模底，false=保留岩石纹理底 */
  setBenchWhiteModel(enabled) {
    this._fieldPipeline.setBenchWhiteModel(enabled)
  }

  /** 开关振动场等力线（等值线）叠加显示 */
  setIsoLine(enabled) {
    this._fieldPipeline.setIsoLine(enabled)
  }

  /** 设置等值线样式（线宽 px / 统一颜色；color=null 恢复按级别取色） */
  setIsoLineStyle({ width, color } = {}) {
    this._fieldPipeline.setIsoLineStyle({ width, color })
  }

  /** 设置色彩映射标尺：0=线性，1=对数（默认；适应 PPV/应力幂律衰减） */
  setNormMode(mode) {
    this._fieldPipeline.setNormMode(mode)
  }

  /** 设置半透明渲染（1=场色上限 0.55 露出岩底，0=实色 0.85） */
  setFieldTranslucent(on) {
    this._fieldPipeline.setFieldTranslucent(on)
  }

  /** 下发矢量箭头场（P1-6：波传播方向可视化；数据来自 blastingManager 逐帧计算） */
  setVectorField(data) {
    this._fieldPipeline.setVectorField(data)
  }

  /** 清空/隐藏矢量箭头场 */
  clearVectorField() {
    this._fieldPipeline.clearVectorField()
  }

  /**
   * 导出岩面顶点集（grid 局部系）+ 洞身整形参数，供等值线峰值场计算。
   * 含版本号（几何 build/爆后切换/剖切时自增），调用方据此判断是否重提取。
   */
  getContourSurface() {
    return this._fieldPipeline.getContourSurface()
  }

  /** 波场可达半径（= 爆心 → 岩体几何最远顶点，m；0=岩体尚未构建） */
  getInfluenceRadius() {
    return this._fieldPipeline.getInfluenceRadius()
  }

  /** 下发等值线折线组（contourExtractor 输出）构建 Line2 渲染组 */
  setContourPolylines(data) {
    this._fieldPipeline.setContourPolylines(data)
  }

  /** 当前热力图渲染参数（displayMode/normMode/满刻度，等值线级别计算同口径） */
  getFieldRenderParams() {
    return this._fieldPipeline.getFieldRenderParams()
  }

  /** 当前是否已有可渲染的振动场（三场中任意一场有数据即视为已初始化） */
  hasVibrationField() {
    return this._fieldPipeline.hasVibrationField()
  }

  /** 振动场元信息（供 UI 显示当前场时间/帧/网格） */
  getVibrationFieldInfo() {
    return this._fieldPipeline.getVibrationFieldInfo()
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
    return this._pointPicker.setSceneSectionPick(axis, point)
  }

  /** 显示/隐藏拾取点标记（选轴前给出视觉反馈） */
  setScenePickPointMarker(point) {
    this._pointPicker.setScenePickPointMarker(point)
  }

  /** 绘制监测点（测点）持久标记：维护岩体上已放置测点的粉球+光晕 */
  setMonitorPointMarkers(points) {
    this._pointPicker.setMonitorPointMarkers(points)
  }

  /** 清除拾取式剖切（还原完整岩体并移除轮廓标记） */
  clearSceneSectionPick() {
    this._pointPicker.clearSceneSectionPick()
  }

  /**
   * 在爆破场景中对真实岩体网格做射线拾取，返回命中的岩体局部坐标点。
   * @param {(local:{x,y,z}|null)=>void} handler
   * @param {Object} [opts]
   * @param {number} [opts.maxDragPx=4] - 判定为"点击"的最大拖拽位移(px)
   * @returns {Function} detach 函数（用于停止拾取）
   */
  pickRockPoint(handler, opts = {}) {
    return this._pointPicker.pickRockPoint(handler, opts)
  }

  /** 设置振动场 raymarching 步数（性能/精度权衡） */
  setVibrationFieldRaySteps(n) {
    this._fieldPipeline.setVibrationFieldRaySteps(n)
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
      this._fieldPipeline._applyVibrationOcclusion()
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
