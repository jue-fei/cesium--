import * as Cesium from 'cesium'
import { CesiumThreeBridge } from './core/rendering/cesiumThreeBridge.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'
import {
  LocalVibrationSimulator,
  VibrationParticleSystem,
  VibrationComputeClient,
  buildChargeSources,
  resolveChargePosition
} from './core/computation/localVibrationSimulator.js'
import { buildNanshanTunnelDesign } from './core/computation/nanshanTunnelDesign.js'
import {
  DEFAULT_TUNNEL_WIDTH,
  DEFAULT_TUNNEL_WALL_HEIGHT,
  DEFAULT_TUNNEL_ARCH_RADIUS,
  DEFAULT_FRAGMENT_RENDER_LIMIT,
  calcTunnelArea
} from './core/blastDefaults.js'

/**
 * 将 { lon, lat, height } 形式的位置转换为 Cesium.Cartesian3
 * @param {Object} position
 * @returns {Cesium.Cartesian3}
 */
function toCartesian(position) {
  return Cesium.Cartesian3.fromDegrees(
    Number(position?.lon || 0),
    Number(position?.lat || 0),
    Number(position?.height || 0)
  )
}

function getSectionArea(design = {}) {
  const shape = design.tunnelShape || 'horseshoe'
  const width = Math.max(2, Number(design.tunnelWidth) || DEFAULT_TUNNEL_WIDTH)
  const wallHeight = Math.max(1, Number(design.tunnelWallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT)
  const archRadius = Math.max(1, Number(design.tunnelArchRadius) || width / 2)
  return calcTunnelArea(shape, width, wallHeight, archRadius)
}

function getAdvanceLength(design = {}) {
  const advance = Number(design.advanceLength)
  if (Number.isFinite(advance) && advance > 0) return advance
  const holeDepth = Math.max(0.5, Number(design.holeDepth) || 2.5)
  const utilization = Math.max(0.3, Math.min(1.0, Number(design.utilization) || 0.85))
  return holeDepth * utilization
}

function buildGenerationMetrics(dataset = {}, overrides = {}) {
  const design = dataset.design || {}
  const result = dataset.result || {}
  const event = dataset.event || {}
  const rockParams = event.rockParams || {}
  const volumeRoundM3 = getSectionArea(design) * getAdvanceLength(design)
  const rockDensity =
    Number(overrides.rockDensityKgM3) ||
    Number(overrides.rockDensity) ||
    Number(design.rockDensity) ||
    Number(event.density) ||
    Number(rockParams.density) ||
    2650
  const explosiveType =
    overrides.explosiveType || event.explosiveType || design.explosiveType || 'emulsion'
  return {
    volumeRoundM3,
    rockDensityKgM3: rockDensity,
    specificChargeKgM3: volumeRoundM3 > 0 ? Number(event.chargeKg || 0) / volumeRoundM3 : null,
    throwDistanceTargetAvg:
      Number(result.throwDistanceAvg) || Number(design.expectedThrowDistance) || null,
    throwDistanceTargetMax: Number(result.throwDistanceMax) || null,
    explosiveType,
    eta: Number.isFinite(Number(overrides.eta)) ? Number(overrides.eta) : null,
    velocityScale: Number.isFinite(Number(overrides.velocityScale))
      ? Number(overrides.velocityScale)
      : null,
    usePerssonVelocity: overrides.usePerssonVelocity,
    enableVelocityCalibration: overrides.enableVelocityCalibration,
    fragmentX50: Number(overrides.x50) || Number(result.fragmentX50) || null,
    fragmentXmax: Number(overrides.xmax) || Number(result.fragmentXmax) || null,
    fragmentB: Number(overrides.b) || Number(result.fragmentB) || null,
    fragmentN: Number(overrides.n) || Number(result.fragmentN) || null
  }
}

// 渲染参数（硬编码默认值；旧 blasting_render_config 表已删除）
// 仅保留 three.js 桥接所需开关
const DEFAULT_RENDER_CONFIG = {
  threeJsEnabled: true,
  threeJsParticleScale: 1.0
}

// 爆心位置始终尊重 DB 中各事件的地理坐标（曾提供 UNIFY_BLAST_CENTER 统一爆心开关，恒为 false 已移除）

/**
 * 爆破模拟管理器（前端层）
 *
 * 重构后只保留 Three.js 桥接渲染：所有 Cesium 粒子、火球、烟雾柱、
 * 热力图、监测点、流式推送均已移除。视觉表现统一由 threeBlastingRenderer
 * 在 Cesium 之上叠加渲染。
 *
 * 数据集结构（新）：
 * {
 *   event:  { eventId, name, centerLon, centerLat, centerHeight, chargeKg, ... },
 *   design: { tunnelShape, tunnelWidth, ..., holes: [...] },
 *   result: { simulationDurationS, timeStepS, fragmentCount, fragmentXmax, ... }
 * }
 */
export class BlastingManager {
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for BlastingManager')
    this.viewer = viewer
    this.dataset = null
    this.currentFrame = 0
    // Cesium 实体（仅保留爆心标记，作为地理参考）
    this.centerEntity = null
    // 渲染配置
    this.renderConfig = { ...DEFAULT_RENDER_CONFIG }
    // three.js 高质量粒子渲染桥接器（懒初始化）
    this.threeBridge = null
    this.threeContainer = null
    // 地下视角状态：地下事件（centerHeight<0）需禁用地形碰撞检测，否则相机被推回地表
    this._undergroundSavedState = null
    this._undergroundActive = false

    // ── 本地振动场模拟（WS 不可用时自行模拟实时数据）──────────
    // 与 blastingWsConnector 推送同构：用相同物理模型（萨道夫斯基/弹性反演/Persson 损伤）
    // 按播放时钟逐帧计算，确保可视化效果与碎片动画同步。
    this._localVibrationEnabled = false
    this._localVibrationSim = null
    this._localParticleSystem = null
    // 粒子发射状态（从起爆时刻开始的一段短窗口内发射波前粒子）
    this._particleEmitState = { emittedUntil: -1, lastT: -1 }
    // 振动场热力图计算节流：每次全量计算 65536 点×3 场（PPV/应力/损伤）是主线程重负载，
    // 若每播放 tick（~50ms）都重算并上传 3 个 Data3DTexture 会卡死浏览器。
    // 热力图平滑连续变化，降低到 5Hz（每 0.2s 一次）视觉无差异，主线程压力大减。
    this._vibFieldLastUpdate = -1
    this._vibFieldUpdateInterval = 0.2
    // 上一步振动模拟时刻（时间轴一致性：识别回卷/前跳，见 stepLocalVibration）
    this._vibLastStepT = -1
    // 振动场计算 Web Worker 客户端：把多源矢量叠加的 PPV/应力/损伤场计算卸载到
    // Worker 线程，避免主线程因"网格点数×源数×幂/指数"计算卡死爆破动画。
    this._vibComputeClient = new VibrationComputeClient()
    this._vibComputeReqId = 0
    this._vibComputeReqInFlight = false // 当前是否有一个计算请求在途（只允许一个）
    this._vibComputePending = null // 在途期间到达的最新目标 { t, frame }，完成后补算
    // 上次热力图重算的墙钟时刻：与模拟时间节流共用（高倍速下重算频率仍被墙钟封顶，
    // 避免"模拟时间节流×倍速"把主线程重算压到每帧一次导致时序卡顿、与时间轴失同步）
    this._vibLastUpdateWallMs = 0
    // WS 应力/损伤帧最近到达时间（新鲜度检测：WS 帧新鲜时本地兜底让位，避免交替写入闪烁）
    this._lastWsStressMs = 0
    this._lastWsDamageMs = 0
    // 动画总时长（秒）：优先取渲染器实测/回放时长（全部落地+保持3s），
    // 未就绪时回退数据集 simulationDurationS（默认 10s）。
    this._durationS = null
  }

  /**
   * 更新渲染配置
   * @param {Object} config
   */
  setRenderConfig(config = {}) {
    this.renderConfig = { ...DEFAULT_RENDER_CONFIG, ...config }
  }

  /**
   * 清空场景：移除 Cesium 实体、销毁 three.js 桥接器
   */
  clearScene() {
    if (this.centerEntity) this.viewer.entities.remove(this.centerEntity)
    this._clearThreeBridge()
    this._restoreSurfaceView()

    // 恢复 Cesium 容器可见性，移除独立的 Three.js 容器
    if (this.viewer?.container) {
      this.viewer.container.style.display = ''
    }
    if (this.threeContainer?.parentNode) {
      this.threeContainer.parentNode.removeChild(this.threeContainer)
    }
    this.threeContainer = null

    this.centerEntity = null
    this.dataset = null
    this.currentFrame = 0
    // 重置本地振动场模拟状态（下一次 setDataset 时按新事件参数重新创建）
    this._localVibrationEnabled = false
    this._localVibrationSim = null
    this._localParticleSystem = null
    this._particleEmitState = { emittedUntil: -1, lastT: -1 }
    // 释放振动场计算 Worker（含在途请求），新事件重新初始化
    this._vibComputeClient.dispose()
    this._vibComputeReqInFlight = false
    this._vibComputePending = null
    // 动画时长信号随场景重建作废（新事件重新观测/烘焙）
    this._durationS = null
  }

  /**
   * 装载数据集并初始化爆破场景
   * 新数据集结构：{ event, design, result }
   * @param {Object} dataset
   */
  setDataset(dataset, options = {}) {
    this.clearScene()
    this.dataset = dataset
    this.currentFrame = 0
    // 楔形掏槽事件：将 Da Balai 文献化设计直接写回 dataset.design，
    // 使渲染器断面、炮孔、孔深/进尺标注、多源应力波、UI 全程读取同一套数据，
    // 避免渲染器与 overlay 因两套数值而显示不一致（断面/布孔/孔深同步对齐文献）。
    this._stampLiteratureDesignIfNeeded()
    this.buildEntities()
    this._initThreeBridge(options.kcoOverride || {})
    this._applyUndergroundViewIfNeeded()
    this.flyToCenter()
  }

  /**
   * 将南山隧道楔形掏槽文献设计写回 dataset.design（仅 wedge 事件，即 002）。
   * 数据库种子对 wedge 事件仍生成"4 孔菱形 + 10×9m 断面 + 孔深 2.0m"，
   * 与文献（南山隧道 15.56×10.23m 马蹄形；楔形 6 孔 ±1.2/2.0/2.8、微差 0ms、
   * 掏槽单眼 2.4kg；孔深 3.0m）不符，故在此统一覆盖，保证 3D 模型与 UI 一致。
   */
  _stampLiteratureDesignIfNeeded() {
    const design = this.dataset?.design
    if (!design) return
    const isWedge = String(design.cutPattern || '').toLowerCase() === 'wedge'
    if (!isWedge) return
    const ns = buildNanshanTunnelDesign()
    const s = ns.section
    design.tunnelWidth = s.width // 15.56
    design.tunnelWallHeight = s.wallHeight // 2.45
    design.tunnelArchRadius = s.archRadius // 7.78
    design.tunnelTotalHeight = s.totalHeight // 10.23
    design.tunnelShape = s.shape // horseshoe
    design.holeDepth = 3.0 // 南山掏槽孔深
    design.utilization = 0.85
    design.advanceLength = 3.0 * 0.85 // 2.55m
    design.holeDiameter = design.holeDiameter || 0.04
    design.holes = design.holes && design.holes.length > 0 ? ns.holes : ns.holes
    this._literatureStamped = true
  }

  /**
   * 跳转到隧道内部视角，直面掌子面（直接设置 Three.js 相机，非 Cesium 飞行）
   */
  flyToCenter() {
    this._jumpToCameraView()
  }

  /**
   * 切换爆破三维观察视角预设（内部/外部）
   * @param {'interior'|'exterior'} mode - 视角模式
   */
  setCameraViewMode(mode) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    if (!renderer?.setCameraViewMode) return
    const design = this.dataset?.design || {}
    renderer.setCameraViewMode(mode, {
      tunnelLength: Number(design.tunnelLength) || 0,
      wallHeight: Number(design.tunnelWallHeight) || 0
    })
  }

  /**
   * 设置视角配置（覆盖默认的相机参数）
   * @param {Object} config - { heading, cameraDist, eyeHeightOffset, shellLength, faceThickness, faceOffset }
   */
  setViewConfig(config = {}) {
    this.viewConfig = { ...(this.viewConfig || {}), ...config }
  }

  /**
   * 根据爆心高度切换地表/地下相机模式。
   * 露天爆破（centerHeight>=0）相机位于地表上方，使用 Cesium 默认碰撞检测，
   * 视角移动控制平滑自然；地下爆破（centerHeight<0）相机位于地形之下，默认碰撞
   * 检测会把相机顶回地表，导致拖拽/缩放/倾斜时被"卡住"。此处对地下事件关闭碰撞
   * 检测与地形深度测试，并将地球设为半透明（参照 undergroundView.js 模式），
   * 使地下视角移动控制与露天爆破一致。
   */
  _applyUndergroundViewIfNeeded() {
    if (!this.viewer?.scene) return
    const centerHeight = Number(this.dataset?.event?.centerHeight || 0)
    const isUnderground = centerHeight < 0
    const globe = this.viewer.scene.globe
    const controller = this.viewer.scene.screenSpaceCameraController
    if (!globe || !controller) return

    if (isUnderground && !this._undergroundActive) {
      // 保存原始状态（仅首次进入地下模式时保存，避免覆盖默认值）
      this._undergroundSavedState = {
        collisionDetection: controller.enableCollisionDetection,
        depthTestAgainstTerrain: globe.depthTestAgainstTerrain,
        translucencyEnabled: globe.translucency.enabled,
        frontFaceAlpha: globe.translucency.frontFaceAlpha,
        backFaceAlpha: globe.translucency.backFaceAlpha
      }
      // 关闭地形碰撞检测：相机可在地下自由移动，不再被推回地表
      controller.enableCollisionDetection = false
      // 关闭地形深度测试：地下实体（爆心标记等）不被地形遮挡
      globe.depthTestAgainstTerrain = false
      // 地球半透明：可透过地表看到地下隧道与爆破效果
      globe.translucency.enabled = true
      globe.translucency.frontFaceAlpha = 0.2
      globe.translucency.backFaceAlpha = 0.2
      this._undergroundActive = true
    } else if (!isUnderground && this._undergroundActive) {
      // 切换回地表事件：恢复默认相机控制
      this._restoreSurfaceView()
    }
  }

  /** 恢复地表视角的默认相机控制（关闭地下模式） */
  _restoreSurfaceView() {
    if (!this._undergroundActive || !this.viewer?.scene) return
    const globe = this.viewer.scene.globe
    const controller = this.viewer.scene.screenSpaceCameraController
    const s = this._undergroundSavedState
    if (s) {
      controller.enableCollisionDetection = s.collisionDetection
      globe.depthTestAgainstTerrain = s.depthTestAgainstTerrain
      globe.translucency.enabled = s.translucencyEnabled
      globe.translucency.frontFaceAlpha = s.frontFaceAlpha
      globe.translucency.backFaceAlpha = s.backFaceAlpha
    }
    this._undergroundActive = false
  }

  /**
   * 设置当前帧索引
   * 新 schema 不再提供 frames 数组，而是根据 result.simulationDurationS
   * 与 result.timeStepS 计算总帧数，并调用 threeBridge.seekTo 跳转到对应物理时间。
   * 时长优先取渲染器实测/回放时长（全部碎片落地 + 保持 3s，随事件自适应），
   * 使进度条与每个爆破事件的实际动画真正绑定（碎片抛掷未结束时进度条不提前到底）。
   * @param {number} frameIndex
   */
  setFrame(frameIndex) {
    // 每个播放 tick 同步渲染器时长信号（回放就绪/实测达成时进度条随之延长）
    this._syncDurationFromRenderer()
    if (!this.dataset?.result) return
    const duration = this.getDurationS() || Number(this.dataset.result.simulationDurationS) || 10
    // 显示帧网格固定 0.05s：与物理引擎关键帧烘焙网格（REPLAY_KEY_DT）一致，
    // 保证回放采样逐帧命中关键帧，且与播放 dt 一一对应
    const dt = 0.05
    const maxFrame = Math.max(1, Math.floor(duration / dt))
    this.currentFrame = Math.max(0, Math.min(maxFrame - 1, Number(frameIndex) || 0))
    if (this.threeBridge) {
      const targetTime = this.currentFrame * dt
      this.threeBridge.seekTo(targetTime)
      // WS 不可用时由本地模拟器按同一播放时钟逐帧计算振动场/波前粒子，
      // 保证热力图与粒子效果与碎片动画同步（实时数据推送协议的自模拟实现）。
      this.stepLocalVibration(targetTime, this.currentFrame)
    }
  }

  /**
   * 从渲染器同步动画总时长（只增不减，单调递增）：
   *  - 回放就绪 → 预烘焙录制时长（全部落地 + 3s）；
   *  - 直播中 → 渲染器返回"当前时刻+1s"持续延长，保证碎片未全落地时进度条不提前到底；
   *  - 完成实测/录制 → 固定时长（全落地 + 3s），进度条在该时长后结束/循环。
   */
  _syncDurationFromRenderer() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    if (!renderer) return
    const d = renderer.getSimulationDurationS?.() || null
    if (d != null && Number.isFinite(d) && d > 0 && d > (this._durationS || 0)) {
      this._durationS = d
    }
  }

  /** 当前动画总时长（秒）：渲染器实测/回放优先，未就绪返回 null */
  getDurationS() {
    return this._durationS
  }

  /** 关键帧回放（全速预计算）是否就绪 */
  isBlastReplayReady() {
    return !!this.threeBridge?.getThreeRenderer?.()?.getReplayDurationS?.()
  }

  /** 全速预计算进度：{ active: boolean, pct: 0-100 }（供 UI 显示"物理预计算中"） */
  getReplayProgress() {
    return (
      this.threeBridge?.getThreeRenderer?.()?.getReplayProgress?.() ?? {
        active: false,
        pct: 0
      }
    )
  }

  // ─── three.js 高质量粒子渲染 ───────────────────────

  /**
   * 初始化 three.js 桥接器并启动爆破效果
   * 使用新的 blasting_design / blasting_design_holes / blasting_result 表数据：
   *   - design.tunnelWidth/tunnelWallHeight/tunnelArchRadius/tunnelShape → 隧道断面
   *   - design.holes[] + 设计参数 → 炮孔布局
   *   - result（替代旧 design.blastEffect）→ 爆破效果可视化
   */
  _initThreeBridge(kcoOverride = {}) {
    // 防重复：500ms 内只执行一次，避免 watch 循环导致多次创建 WebGL 上下文
    const now = Date.now()
    if (this._lastInitTime && now - this._lastInitTime < 500) {
      console.warn('[BlastingManager] _initThreeBridge 防抖：500ms 内重复调用已忽略')
      return
    }
    this._lastInitTime = now
    if (!this.dataset?.event || !this.renderConfig.threeJsEnabled) {
      console.warn('[BlastingManager] three.js 桥接器未启动', {
        hasEvent: !!this.dataset?.event,
        threeJsEnabled: this.renderConfig.threeJsEnabled
      })
      return
    }

    // 创建独立的全屏容器（不挂在 Cesium 容器下，而是挂在 body 下）
    // 爆破模拟在纯黑背景的 Three.js 场景中进行，不显示 Cesium 地球
    if (!this.threeContainer) {
      this.threeContainer = document.createElement('div')
      this.threeContainer.style.position = 'fixed'
      this.threeContainer.style.top = '0'
      this.threeContainer.style.left = '0'
      this.threeContainer.style.width = '100vw'
      this.threeContainer.style.height = '100vh'
      this.threeContainer.style.pointerEvents = 'none'
      this.threeContainer.style.zIndex = '1'
      document.body.appendChild(this.threeContainer)
    }

    // 隐藏 Cesium 容器，显示纯黑 Three.js 场景
    if (this.viewer?.container) {
      this.viewer.container.style.display = 'none'
    }

    // 销毁旧的桥接器
    if (this.threeBridge) {
      this.threeBridge.dispose()
      this.threeBridge = null
    }

    // 创建新桥接器
    this.threeBridge = new CesiumThreeBridge(this.viewer, this.threeContainer)

    // 设置爆心位置（建立 ENU 局部坐标系）
    const event = this.dataset.event
    const center = {
      lon: Number(event.centerLon || 0),
      lat: Number(event.centerLat || 0),
      height: Number(event.centerHeight || 0)
    }
    this.threeBridge.setCenter(center.lon, center.lat, center.height)

    // ── 注入数据库爆破设计数据：隧道断面 + 炮孔设计 + 设计参数 ──
    const renderer = this.threeBridge.getThreeRenderer?.()
    const design = this.dataset?.design
    // holes 来自 blasting_design_holes 表，供炮孔布局与 KCO 单孔药量推导使用
    const holes = Array.isArray(design?.holes) ? design.holes : []

    // A6：楔形掏槽事件对齐南山隧道文献化设计（断面 + 布孔 + 微差时序）。
    // DB 种子对 wedge 事件仍生成"4 孔菱形（cut_r=0.8，延时 50ms 整批）"包裹在
    // 10×9m 断面内，与文献（南山隧道 15.56×10.23m 马蹄形，楔形孔 ±1.2/2.0/2.8、
    // 掏槽微差 0ms、单眼 2.4kg）不符，导致多源应力波因源点聚拢而呈准同心圆。
    // 此处统一以南山设计覆盖断面与布孔，使 3D 模型与文献一致，
    // 并让 _computeBlastSources 的多装药源空间铺开、时序错开 → 非同心圆干涉波场。
    const isWedge = String(design?.cutPattern || '').toLowerCase() === 'wedge'
    let effSection = null
    let effHoles = holes
    if (isWedge) {
      const ns = buildNanshanTunnelDesign()
      effSection = ns.section
      effHoles = ns.holes
    } else {
      effSection = {
        width: Number(design?.tunnelWidth) || DEFAULT_TUNNEL_WIDTH,
        wallHeight: Number(design?.tunnelWallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT,
        archRadius: Number(design?.tunnelArchRadius) || DEFAULT_TUNNEL_ARCH_RADIUS,
        shape: design?.tunnelShape || 'horseshoe'
      }
    }
    // 供 _computeBlastSources / getPpvStreamParams 读取同一套生效设计（多源应力波叠加数据源）
    this._effectiveSection = effSection
    this._effectiveHoles = effHoles

    if (renderer && design) {
      // 1) 隧道断面尺寸（新 blasting_design 表字段；楔形事件对齐 Da Balai 文献断面）
      renderer.setTunnelSection({
        width: Number(effSection.width) || DEFAULT_TUNNEL_WIDTH,
        wallHeight: Number(effSection.wallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT,
        archRadius: Number(effSection.archRadius) || DEFAULT_TUNNEL_ARCH_RADIUS,
        shape: effSection.shape || design.tunnelShape || 'horseshoe'
      })

      // 2) 炮孔设计 + 设计参数（holes 来自 blasting_design_holes 表；楔形事件对齐 Da Balai 布孔）
      const designParams = {
        cutPattern: design.cutPattern,
        cutAngle: design.cutAngle,
        cutHoleCount: design.cutHoleCount,
        emptyHoleCount: design.emptyHoleCount,
        delayIntervalMs: design.delayIntervalMs,
        initiationNetwork: design.initiationNetwork,
        chargeDensityCut: design.chargeDensityCut,
        chargeDensityAux: design.chargeDensityAux,
        chargeDensityPerim: design.chargeDensityPerim,
        stemmingLength: design.stemmingLength,
        holeDepth: design.holeDepth,
        holeDiameter: design.holeDiameter,
        utilization: design.utilization,
        advanceLength: design.advanceLength,
        totalHoleCount: effHoles.length,
        totalChargeKg: effHoles.reduce((s, h) => s + Number(h.chargeKg || 0), 0)
      }
      renderer.setBlastHoleDesign(effHoles, designParams)

      // 爆心 = 掏槽孔质心（掌子面 z=faceOffset 处），供应力/损伤场着色与本地模拟使用
      renderer.setBlastOrigin?.(this._computeBlastOrigin())

      // 3) 爆破效果数据（新 blasting_result 表替代旧 design.blastEffect）
      if (this.dataset.result && typeof renderer.setBlastEffect === 'function') {
        renderer.setBlastEffect(this.dataset.result)
      }
    }

    // 启动爆破粒子效果
    const chargeKg = Number(event.chargeKg || 100)
    const fragmentCountTarget = Number(this.dataset.result?.fragmentCount || 200)
    const blastParams = {
      chargeKg,
      fragmentCountTarget,
      fragmentCountRenderLimit: Number.isFinite(Number(kcoOverride.fragmentCountRenderLimit))
        ? Number(kcoOverride.fragmentCountRenderLimit)
        : DEFAULT_FRAGMENT_RENDER_LIMIT,
      enableInterCollision:
        kcoOverride.enableInterCollision != null ? kcoOverride.enableInterCollision : true,
      randomSeed: kcoOverride.randomSeed,
      generationMetrics: buildGenerationMetrics(this.dataset, kcoOverride)
    }
    // KCO 模型参数（透传到 threeBlastingRenderer.initBlast）
    // 基线值取自 DB result，UI 编辑后的 kcoOverride 覆盖之
    if (this.dataset.result) {
      // 只有当 kcoOverride 包含 KCO 相关字段时才用 'design' 模式，
      // 避免重新播放（传入 PERFORMANCE_PROFILE/randomSeed 等非 KCO 字段）时
      // 误切到 design 模式导致 KCO 参数与初次加载不一致。
      const kcoFields = ['Q', 'B', 'S', 'xmax', 'x50', 'n', 'b']
      const hasKcoOverride = kcoFields.some(f => kcoOverride[f] != null)
      // Q 为单孔装药量（KCO 模型定义，决定 x50）。
      // 由总装药量 ÷ 装药孔数推导；无孔数据时回退总装药量（单孔场景）。
      const chargedHoles = holes.filter(h => Number(h.chargeKg) > 0)
      const holeChargeKg =
        chargedHoles.length > 0
          ? chargedHoles.reduce((s, h) => s + Number(h.chargeKg), 0) / chargedHoles.length
          : holes.length > 0
            ? chargeKg / holes.length
            : chargeKg
      blastParams.kcoParams = {
        Q: holeChargeKg,
        xmax: this.dataset.result.fragmentXmax,
        x50: this.dataset.result.fragmentX50,
        b: this.dataset.result.fragmentB,
        n: this.dataset.result.fragmentN,
        explosiveType: this.dataset.event?.explosiveType || 'emulsion',
        sourceMode: hasKcoOverride ? 'design' : 'result',
        ...kcoOverride // UI 编辑后的覆盖值（Q/B/S/xmax 等任一字段）
      }
    } else if (Object.keys(kcoOverride).length > 0) {
      // 无 result 但有 override（极端情况）：仅用 override 启动
      // 如果 override 没有指定 Q，则使用平均估算（假设总装药量÷孔数）
      blastParams.kcoParams = { Q: chargeKg, sourceMode: 'design', ...kcoOverride }
    }

    this.threeBridge.startBlast(blastParams)

    // 注册爆破场景工具桥：供模型控制透明度/测量/裁剪等在爆破模式下重定向到 three 场景
    blastingSceneTools.setRenderer(this.threeBridge.getThreeRenderer?.() || null)

    // 跳转到隧道内部视角（直接设置相机位置，非飞行）
    this._jumpToCameraView()
  }

  /**
   * 直接设置 Three.js 相机到隧道内部视角（跳转，非飞行）
   * 相机位于隧道内部（掌子面后方），朝向掌子面观察
   */
  _jumpToCameraView() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    if (!renderer?.setupCameraView) return
    const design = this.dataset?.design || {}
    const tunnelLen = Number(design.tunnelLength) || 0
    const wallH = Number(design.tunnelWallHeight) || 0
    renderer.setupCameraView(tunnelLen, wallH)
  }

  /** 销毁 three.js 桥接器 */
  _clearThreeBridge() {
    blastingSceneTools.clear()
    if (this.threeBridge) {
      this.threeBridge.dispose()
      this.threeBridge = null
    }
  }

  /**
   * 获取 three.js 渲染统计
   * @returns {Object|null}
   */
  getThreeStats() {
    if (!this.threeBridge) return null
    return this.threeBridge.getThreeRenderer?.()?.getStats() || null
  }

  /**
   * 获取块度分布统计（按 physSize 分组）
   * @returns {Object|null} { buckets, total, x50, x80, xmax }
   */
  getFragmentDistribution() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getFragmentDistribution?.() || null
  }

  /**
   * 高亮指定块度范围的碎片
   * @param {number} minSize - 物理尺寸下限（米）
   * @param {number} maxSize - 物理尺寸上限（米）
   */
  highlightFragmentsBySize(minSize, maxSize) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.highlightFragmentsBySize?.(minSize, maxSize)
  }

  /** 清除碎片高亮，恢复原始颜色 */
  clearFragmentHighlight() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.clearFragmentHighlight?.()
  }

  // ─── PPV 振动场（实时推送的动态热力图）──────────────────────

  /**
   * 初始化振动场体积（收到首个 PPV 二进制帧时由 useBlasting 调用）
   * 如果 WS 传入的 gridShape 与本地模拟器不一致，重建本地模拟器以匹配 WS 网格，
   * 确保本地模拟的应力/损伤场数组长度与渲染器纹理一致。
   * @param {Object} cfg - { gridShape, boundsMin, boundsMax }
   */
  initVibrationField(cfg) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.initVibrationField?.(cfg)
    // 同步本地模拟器网格：WS 的 gridShape 可能与本地默认值不同
    // （后端 build_ppv_grid 使用 resolution=1.5m，本地默认 nx=32,ny=32,nz=64）
    // 不一致时本地 stress/damage 数组长度不匹配渲染器纹理，导致更新被跳过
    this._syncLocalVibrationSimGrid(cfg)
  }

  /**
   * 确保振动场体积网格与外部（WS 帧）网格一致：
   * 渲染器尚未初始化、或当前 gridShape 与传入不一致时，重建体积纹理。
   * 场景：本地模拟先用默认 32×32×64 网格初始化了体积，随后 WS 帧
   * 携带后端网格（resolution=1.5m，如 19×15×18）。若不重建，
   * 所有 WS 帧因数组长度不匹配被丢弃，导致画面冻结。
   * @param {Object} cfg - { gridShape, boundsMin, boundsMax }
   */
  ensureVibrationField(cfg) {
    if (!cfg?.gridShape) return
    const info = this.getVibrationFieldInfo()
    const cur = info?.gridShape
    const [nx, ny, nz] = cfg.gridShape
    if (cur && cur[0] === nx && cur[1] === ny && cur[2] === nz) return
    // 网格不一致或未初始化 → 重建（同时触发本地模拟器网格同步）
    this.initVibrationField(cfg)
  }

  /**
   * 同步本地振动模拟器网格参数到外部传入的 gridShape
   * 当 gridShape 或 bounds 变化时重建模拟器，保证 computeAtTime 输出长度匹配。
   * 使用 WS 显式边界（后端 y 边界非对称 [-0.2h, 1.2h]），使本地采样点与 WS 网格完全对齐。
   */
  _syncLocalVibrationSimGrid(cfg) {
    if (!cfg?.gridShape) return
    const sim = this._localVibrationSim
    if (sim) {
      const [nx, ny, nz] = cfg.gridShape
      const sameShape =
        sim.nx === nx &&
        sim.ny === ny &&
        sim.nz === nz &&
        sim.boundsMin?.[0] === cfg.boundsMin?.[0] &&
        sim.boundsMin?.[1] === cfg.boundsMin?.[1] &&
        sim.boundsMin?.[2] === cfg.boundsMin?.[2] &&
        sim.boundsMax?.[0] === cfg.boundsMax?.[0] &&
        sim.boundsMax?.[1] === cfg.boundsMax?.[1] &&
        sim.boundsMax?.[2] === cfg.boundsMax?.[2]
      if (sameShape) return
    }
    // 重建模拟器：使用外部网格参数，保证数组长度匹配
    const params = this.getPpvStreamParams()
    if (!params) return
    const [nx, ny, nz] = cfg.gridShape
    const sizeX = (cfg.boundsMax?.[0] ?? 0) - (cfg.boundsMin?.[0] ?? 0)
    const sizeY = (cfg.boundsMax?.[1] ?? 0) - (cfg.boundsMin?.[1] ?? 0)
    const sizeZ = (cfg.boundsMax?.[2] ?? 0) - (cfg.boundsMin?.[2] ?? 0)
    this._localVibrationSim = new LocalVibrationSimulator({
      chargeKg: params.chargeKg,
      tunnelWidth: Math.max(1, sizeX || params.tunnelWidth),
      tunnelHeight: Math.max(1, sizeY || params.tunnelHeight),
      lengthZ: Math.max(1, sizeZ || 40),
      nx: Math.max(2, nx),
      ny: Math.max(2, ny),
      nz: Math.max(2, nz),
      // 爆心 = 掏槽孔质心（与 WS blastCenter 一致，保证本地兜底与后端推送同源）
      origin: this._computeBlastOrigin(),
      // 多装药源：由实际炮孔布孔推算，驱动多应力波叠加（楔形掏槽微差起爆馆形干涉波场）
      sources: this._computeBlastSources(),
      // 显式边界：采样点与 WS 网格逐点对齐，避免应力/损伤云图错位
      boundsMin: cfg.boundsMin,
      boundsMax: cfg.boundsMax
    })
    // 补齐粒子系统与发射状态（_ensureLocalVibrationSim 因 sim 已存在会跳过创建，
    // 缺失时 stepLocalVibration 访问 _particleEmitState 会抛 TypeError 中断帧更新链）
    if (!this._localParticleSystem) {
      this._localParticleSystem = new VibrationParticleSystem(600)
    }
    if (!this._particleEmitState) {
      this._particleEmitState = { emittedUntil: -1, lastT: -1 }
    }
    // 重置节流状态与时间轴标记，使下一帧立即按新网格计算
    this._vibFieldLastUpdate = -1
    this._vibLastStepT = -1
    this._vibLastUpdateWallMs = 0
    // 重建 sim 后废弃旧 Worker 配置与在途计算（避免旧网格结果与新纹理长度不匹配）
    this._vibComputeClient.dispose()
    this._vibComputeReqInFlight = false
    this._vibComputePending = null
  }

  /**
   * 更新 PPV 场数据（每个二进制帧调用）
   * @param {Float32Array} ppv
   * @param {number} t
   * @param {number} frame
   */
  updateVibrationField(ppv, t, frame) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.updateVibrationField?.(ppv, t, frame)
  }

  /**
   * 更新 σ_vm 应力场（每个 STRESS 二进制帧调用）
   * @param {Float32Array} sigmaVm - σ_vm 数组（Pa）
   * @param {number} t
   * @param {number} frame
   */
  updateStressField(sigmaVm, t, frame) {
    this._lastWsStressMs = performance.now()
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.updateStressField?.(sigmaVm, t, frame)
  }

  /**
   * 更新损伤分区场（每个 DAMAGE 二进制帧调用）
   * @param {Int8Array} zones - 分区 id 数组（0~4）
   * @param {number} t
   * @param {number} frame
   */
  updateDamageField(zones, t, frame) {
    this._lastWsDamageMs = performance.now()
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.updateDamageField?.(zones, t, frame)
  }

  /**
   * 切换振动场显示模式（ppv/stress/damage）
   * @param {string|number} mode
   */
  setVibrationDisplayMode(mode) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.setVibrationDisplayMode?.(mode)
  }

  /**
   * 设置振动场底材"白模"开关：true=场图层开启时岩体切白模底，false=保留岩石纹理底
   * @param {boolean} enabled
   */
  setWhiteModelEnabled(enabled) {
    this.threeBridge?.getThreeRenderer?.()?.setBenchWhiteModel?.(!!enabled)
  }

  /** 当前是否已有可渲染的振动场 */
  hasVibrationField() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return !!renderer?.hasVibrationField?.()
  }

  /**
   * 开启"场点拾取"：用户点击振动场包围盒内任意点，
   * 回调返回该点采样值（{inside, ppvCmps, stressMPa, zone, ...}，场外为 null）。
   * 用于按实际 K/α 参数查询空间任意点 PPV，实现逐点取数。
   * @param {(sample: object|null) => void} handler
   * @param {{maxDragPx?: number}} [opts]
   */
  enablePpvPick(handler, opts) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.enablePointPick?.(handler, opts) ?? null
  }

  /** 关闭"场点拾取" */
  disablePpvPick() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.disablePointPick?.()
  }

  /** 振动场元信息（grid/时间/帧） */
  getVibrationFieldInfo() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getVibrationFieldInfo?.() || null
  }

  /**
   * 计算应力场/振动场爆心（网格局部坐标 [x, y, z]）。
   *
   * 爆心取"掏槽孔组质心"：骑在掌子面（z=faceOffset）上、断面孔位坐标系
   * （x=横向、y=距底板高度）下的掏槽孔位均值。这样初始应力波/损伤从实际
   * 掏槽爆破位置向外扩散，而不是从网格原点（隧道底板、掌子面前方 3m 空气中）。
   * 无数据库孔位（走 sceneBuilder 回退布孔）时退回典型布孔掏槽中心 (0, H/2)。
   *
   * @returns {number[]} [x, y, z] 网格局部坐标（米）
   */
  _computeBlastOrigin() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    const totalH =
      Math.max(1, Number(renderer?.tunnelHeight)) ||
      DEFAULT_TUNNEL_WALL_HEIGHT + DEFAULT_TUNNEL_ARCH_RADIUS
    const faceOffset = Number(renderer?.faceOffset) || 3
    // 优先 _effectiveHoles（楔形掏槽对齐 Da Balai 布孔），缺省回退 DB/回退布孔
    const holes = Array.isArray(this._effectiveHoles)
      ? this._effectiveHoles
      : Array.isArray(this.dataset?.design?.holes)
        ? this.dataset.design.holes
        : []
    // 掏槽孔（DB 孔型 'cut'/'easing'，含中心空孔——空孔位于掏槽组中心，参与定位质心）
    const cut = holes.filter(h => {
      const t = String(h?.holeType || 'production').toLowerCase()
      return t === 'cut' || t === 'easing'
    })
    if (cut.length > 0) {
      let sx = 0
      let sy = 0
      for (const h of cut) {
        sx += Number(h?.posX) || 0
        sy += Number(h?.posY) || 0
      }
      return [sx / cut.length, sy / cut.length, faceOffset]
    }
    // 回退：中央掏槽（空孔在 (0, H/2)，见 sceneBuilder._collectFallbackHoles）
    return [0, totalH * 0.5, faceOffset]
  }

  /**
   * 由当前爆破事件的炮孔布孔推算多装药源（驱动多应力波叠加模拟）。
   *
   * 依据文献（Da Balai 隧道楔形掏槽微差爆破 / 《爆炸与冲击》空孔直眼掏槽）：
   * 爆破应力场由 N 个炮孔装药段各自起爆的应力波在岩体内叠加形成——掏槽孔
   * 逐段微差起爆、孔底向掏槽核心收敛，使多源波场重叠干涉，而非单一药包产生的
   * 同心球面波。本方法把每个装药孔解析为一个独立源（位置=装药段中心沿孔向，
   * 楔形掏槽孔底向核心收敛），供 LocalVibrationSimulator 做矢量叠加。
   *
   * @returns {Array|null} [{x,y,z,chargeKg,delayMs,id}]；无事件/无装药孔时 null（退化为单源）
   */
  _computeBlastSources() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    const faceOffset = Number(renderer?.faceOffset) || 3
    const totalH =
      Math.max(1, Number(renderer?.tunnelHeight)) ||
      DEFAULT_TUNNEL_WALL_HEIGHT + DEFAULT_TUNNEL_ARCH_RADIUS

    // 炮孔来源：优先 _effectiveHoles（_initThreeBridge 按楔形掏槽对齐 Da Balai 布孔），
    // 其次 DB design.holes；缺省时回退到 SceneBuilder 生成的布孔
    // （getBlastDesign().holes 即楔形掏槽/菱形/辅助/周边孔集），使多源应力波
    // 叠加始终由"当前实际布孔"驱动，而非缺省退化为单源同心圆。
    let holes = Array.isArray(this._effectiveHoles)
      ? this._effectiveHoles
      : Array.isArray(this.dataset?.design?.holes)
        ? this.dataset.design.holes
        : []
    if (holes.length === 0) {
      const rbHoles = renderer?.getBlastDesign?.()?.holes
      if (Array.isArray(rbHoles)) holes = rbHoles
    }
    if (holes.length === 0) return null

    // 掏槽孔质心（楔形孔向内收敛的核心）
    const cut = holes.filter(h => {
      const t = String(h?.holeType || h?.type || 'production').toLowerCase()
      return t === 'cut' || t === 'easing'
    })
    let cx = 0
    let cy = 0
    if (cut.length > 0) {
      let sx = 0
      let sy = 0
      for (const h of cut) {
        // SceneBuilder 回退孔位用 x/y，DB 用 posX/posY，两种字段都归一化
        sx += Number(h?.posX ?? h?.x) || 0
        sy += Number(h?.posY ?? h?.y) || 0
      }
      cx = sx / cut.length
      cy = sy / cut.length
    } else {
      cy = totalH * 0.5
    }

    // 归一化孔位 schema：resolveChargePosition 读取 posX/posY、isEmptyHole、
    // holeType、inclinationAngle；SceneBuilder 回退孔位用 x/y、isEmpty、type、inclination
    const normalized = holes.map(h => ({
      posX: Number(h?.posX ?? h?.x) || 0,
      posY: Number.isFinite(Number(h.posY))
        ? Number(h.posY)
        : Number.isFinite(Number(h.y))
          ? Number(h.y)
          : cy,
      holeType: h?.holeType ?? h?.type ?? 'production',
      type: h?.holeType ?? h?.type ?? 'production',
      isEmptyHole: !!(h?.isEmptyHole ?? h?.isEmpty),
      isEmpty: !!(h?.isEmptyHole ?? h?.isEmpty),
      depth: Number(h?.depth) || Number(this.dataset?.design?.holeDepth) || 2.5,
      inclinationAngle: Number(h?.inclinationAngle ?? h?.inclination) || 0,
      azimuth: Number(h?.inclinationAzimuth ?? h?.azimuth) || 0,
      chargeKg: Number(h?.chargeKg) || 0,
      chargeLength: Number(h?.chargeLength) || 0,
      delayMs: Number(h?.delayMs) || 0,
      id: h?.id
    }))

    // A5：多应力波叠加仅用掏槽孔组（cut/easing）作装药源 —— 对应 Da Balai 楔形掏槽
    // 微差起爆的核心机理，N 小（≤12）使每帧矢量叠加开销可接受；
    // 辅助/周边孔段延时（≥数十 ms）不参与早期波场干涉，也免其拉高源数卡顿。
    // 若布孔无掏槽孔（异常），回退到全部非空孔，保证多源仍可用。
    const cutHoles = normalized.filter(h => {
      const t = String(h.holeType || h.type).toLowerCase()
      return (t === 'cut' || t === 'easing') && !h.isEmptyHole && Number(h.chargeKg) > 0
    })
    const srcHoles = cutHoles.length > 0 ? cutHoles : normalized.filter(h => !h.isEmptyHole)

    const sources = buildChargeSources(srcHoles, faceOffset, { x: cx, y: cy })
    return sources.length > 0 ? sources : null
  }

  /**
   * 获取 PPV 振动场 WebSocket 推送所需参数（供 useBlasting 调用 connector.startStream）。
   * 从当前 dataset 的 event/design 派生：装药量、隧道断面尺寸。
   * blastCenter 采用隧道局部坐标（爆心=掏槽孔质心，位处掌子面），后端采样网格以该点为波源。
   * @returns {{ chargeKg: number, blastCenter: number[], tunnelWidth: number, tunnelHeight: number, k: number, alpha: number }|null}
   */
  getPpvStreamParams() {
    if (!this.dataset?.event) return null
    const event = this.dataset.event
    const design = this.dataset.design || {}
    const effSec = this._effectiveSection
    return {
      chargeKg: Number(event.chargeKg) || 100,
      blastCenter: this._computeBlastOrigin(),
      tunnelWidth: Number(effSec?.width) || Number(design.tunnelWidth) || DEFAULT_TUNNEL_WIDTH,
      tunnelHeight:
        (Number(effSec?.wallHeight) || Number(design.tunnelWallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT) +
        (Number(effSec?.archRadius) || Number(design.tunnelArchRadius) || DEFAULT_TUNNEL_ARCH_RADIUS),
      k: this._sadoskyK ?? 90,
      alpha: this._sadoskyAlpha ?? 1.58
    }
  }

  /**
   * 设置萨道夫斯基场地参数（K/α），同步本地振动模拟器并供 WS 推送透传。
   * @param {Object} params - { k: 场地常数, alpha: 衰减指数 }
   */
  setSadoskyParams({ k, alpha } = {}) {
    if (Number.isFinite(Number(k)) && Number(k) > 0) this._sadoskyK = Number(k)
    if (Number.isFinite(Number(alpha)) && Number(alpha) > 0) this._sadoskyAlpha = Number(alpha)
    // 同步本地模拟器（WS 不可用时 fallback 使用同一 K/α）
    if (this._localVibrationSim?.params) {
      this._localVibrationSim.params.K = this._sadoskyK
      this._localVibrationSim.params.alpha = this._sadoskyAlpha
      // 使下一帧按新参数重算（清除缓存与节流标记）
      this._localVibrationSim._lastT = -1
      this._localVibrationSim._cachedPpv = null
      this._localVibrationSim._cachedSigmaVm = null
      this._vibFieldLastUpdate = -1
    }
    // 场地参数变更也同步到岩体面场着色（场盒外解析外推），保证内外同曲线
    this._pushFieldPhysics()
  }

  /**
   * 将当前事件的爆源/场地物理参数下发到岩体面场着色材质，
   * 驱动"场盒外解析外推"（萨道夫斯基波前）用与场盒内纹理同一物理曲线渲染，
   * 使 PPV 传播过程在整个岩体外围连续可见、边界无缝衔接。
   * 仅传入可解析字段，缺省项保留 SceneBuilder 内置默认，不会覆盖为无效值。
   */
  _pushFieldPhysics() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    if (!renderer) return
    const params = this.getPpvStreamParams()
    if (!params) return
    const design = this.dataset?.design || {}
    const rockParams = this.dataset?.event?.rockParams || {}
    renderer.setFieldPhysics?.({
      chargeKg: params.chargeKg,
      k: this._sadoskyK ?? 90,
      alpha: this._sadoskyAlpha ?? 1.58,
      beta: Number(rockParams.attenuationP) || this.dataset?.event?.beta || 0.02,
      visualCp: 35,
      rho: Number(design.rockDensity) || 2650,
      cp: Number(rockParams.pWaveSpeed) || 4500,
      nu: Number(design.poissonRatio) ?? Number(rockParams.poissonRatio) ?? 0.25,
      // 爆心（掏槽孔质心）：解析外推波前以该点为源，与场盒内纹理数据一致
      origin: this._computeBlastOrigin(),
      // 多装药源（各炮孔装药段）：驱动岩面非同心圆干涉波场；null 时着色器退化为单源
      sources: this._computeBlastSources()
    })
  }

  // ─── 本地振动场模拟（WS 不可用时自行模拟实时数据）───────────────
  // 与 WebSocket 推送同构：本地模拟器用相同物理模型按播放时钟逐帧计算
  // PPV/应力/损伤场与波前粒子，调用与 WS 帧处理器完全相同的渲染器接口，
  // 保证动态热力图与粒子效果始终可用且与碎片动画同步。

  /**
   * 启用/停用本地振动场模拟（由 useBlasting 依据 WS 连接状态切换）
   * @param {boolean} enabled - true=WS 不可用，本地模拟；false=使用 WS 推送
   */
  setLocalVibrationEnabled(enabled) {
    this._localVibrationEnabled = !!enabled
    if (this._localVibrationEnabled) {
      // 恢复本地模式：清除 WS 新鲜度标记，本地应力/损伤兜底立即恢复写入
      this._lastWsStressMs = 0
      this._lastWsDamageMs = 0
    } else {
      // 停用时清理粒子（避免残留上一轮的波前粒子）
      this.threeBridge?.getThreeRenderer?.()?.clearVibrationParticles?.()
      this._particleEmitState = { emittedUntil: -1, lastT: -1 }
    }
  }

  /**
   * 懒创建本地振动场模拟器与粒子系统（基于当前 dataset 参数）
   */
  _ensureLocalVibrationSim() {
    if (this._localVibrationSim) return this._localVibrationSim
    const params = this.getPpvStreamParams()
    if (!params) return null
    // 让场边界完整覆盖岩体断面（而非对称包裹爆心）：岩体 horseshoe 断面
    // 底部对齐 y=floorY、顶部到 floorY+totalH；旧版默认用对称 [-H/2, H/2]，
    // 导致岩体上半部（拱顶+上部直墙）落在场外→"外围一圈无颜色"。
    // 分辨率按完整断面高度调高竖向（ny），使热力色带在拱高方向更细致。
    const renderer = this.threeBridge?.getThreeRenderer?.()
    const tsec = renderer?.tunnelSection
    const W = Math.max(1, Number(tsec?.width) || params.tunnelWidth)
    const totalH = Math.max(1, Number(renderer?.tunnelHeight) || params.tunnelHeight)
    const floorY = renderer?.center?.y ?? 0
    const depthZ = 40
    const sim = new LocalVibrationSimulator({
      chargeKg: params.chargeKg,
      // 场地标定（石灰岩/金属矿硬岩现场测振回归 K=90、α=1.58，见文档 3/4 文献）
      K: params.k,
      alpha: params.alpha,
      tunnelWidth: W,
      tunnelHeight: totalH,
      lengthZ: depthZ,
      // 网格 48×64×96≈30 万点（旧 96×128×192≈236 万点，主线程全量重算+纹理上传
      // ~28MB/次过于沉重）：降网格使"模拟时间节流×高倍速"下重算仍即时完成，
      // 三线性插值+逐片元采样下视觉差异可忽略，三体稳定性明显改善
      nx: 48,
      ny: 64,
      nz: 96,
      // 爆心 = 掏槽孔质心（掌子面上），应力波/损伤从实际爆破位置扩散
      origin: this._computeBlastOrigin(),
      // 多装药源：由实际炮孔布孔推算，驱动多应力波叠加（楔形掏槽微差起爆的干涉波场）
      sources: this._computeBlastSources(),
      boundsMin: [-W / 2, floorY, 0],
      boundsMax: [W / 2, floorY + totalH, depthZ]
    })
    this._localVibrationSim = sim
    this._localParticleSystem = new VibrationParticleSystem(600)
    this._particleEmitState = { emittedUntil: -1, lastT: -1 }
    // 初次创建后即注入场地物理参数，驱动场盒外解析外推波前（与场盒内同一物理曲线）
    this._pushFieldPhysics()
    return sim
  }

  /**
   * 按播放时钟推进振动传播模拟（在 setFrame 中调用）
   *
   * 双职责：
   * 1. 波前粒子（振动传播可视化）始终由播放时钟驱动，与 WS 状态无关；
   * 2. 动态热力图（PPV/应力/损伤场）在本地模拟模式（WS 不可用）下由本模拟器
   *    逐帧计算并推送渲染器，与 WS 帧处理器使用同一接口，保证同步。
   *
   * @param {number} time - 模拟时间（秒）
   * @param {number} frame - 帧序号
   */
  stepLocalVibration(time, frame) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    if (!renderer) return
    const sim = this._ensureLocalVibrationSim()
    if (!sim) return
    // 防御：sim 可能被 _syncLocalVibrationSimGrid 直接替换（绕过 _ensureLocalVibrationSim），
    // 此时粒子系统/发射状态可能未创建；缺失会导致下方访问抛 TypeError，中断整个 setFrame 链
    if (!this._localParticleSystem) this._localParticleSystem = new VibrationParticleSystem(600)
    if (!this._particleEmitState) this._particleEmitState = { emittedUntil: -1, lastT: -1 }

    const t = Math.max(0, Number(time) || 0)
    // 起爆前（波前未到达）不初始化/不更新，避免全 0 体积占位
    const blastTriggerTime = Number(renderer.blastTriggerTime) || 0.1

    // ── 时间轴一致性：识别回卷/前跳（拖进度条、循环回卷、seek 跳变）──
    // 旧实现只按 _vibFieldLastUpdate 做正向节流：时间回退时 t−last<0 恒小于
    // interval → 热力图/损伤峰值停在跳变前的时刻，与时间轴脱节（循环回卷后
    // 甚至要等一整圈才能恢复刷新）。发现跳变立即强制：清掉旧波前粒子并重置
    // 发射状态、重置损伤峰值累积、置 _vibFieldLastUpdate=-1 使本帧重算目标时刻。
    const rewind = t < this._vibLastStepT - 1e-4
    const jumpForward =
      this._vibLastStepT >= 0 && t - this._vibLastStepT > this._vibFieldUpdateInterval * 1.5
    if (rewind || jumpForward) {
      renderer.clearVibrationParticles?.()
      this._particleEmitState = { emittedUntil: -1, lastT: -1 }
      sim.resetPeak?.()
      this._vibFieldLastUpdate = -1 // 强制下一段立即按目标时刻重算
    }
    this._vibLastStepT = t

    if (t < blastTriggerTime) {
      if (this._particleEmitState.emittedUntil >= 0) {
        // 回到起爆前（循环回卷）：清空粒子 + 重置损伤峰值累积
        renderer.clearVibrationParticles?.()
        this._particleEmitState = { emittedUntil: -1, lastT: -1 }
        sim.resetPeak?.()
      }
      return
    }

    // 发射波前粒子：起爆后一段窗口内持续发射，粒子沿径向扩散（模拟振动传播）
    const emitWindowEnd = blastTriggerTime + 0.6
    const dt = this._particleEmitState.lastT >= 0 ? t - this._particleEmitState.lastT : 0
    this._particleEmitState.lastT = t
    if (t <= emitWindowEnd && this._particleEmitState.emittedUntil < t) {
      // 按时间比例发射：每 0.05s 发射一批（约 80 个），粒子寿命短，形成波前扩散效果
      const batch = Math.min(80, Math.max(20, Math.floor(80 * (dt / 0.05))))
      const cp = sim.params.cp
      this._localParticleSystem?.emitBurst(t, batch, cp)
      this._particleEmitState.emittedUntil = t
    }

    // 推进粒子（年龄/位移/衰减）并推送渲染器（与 WS 状态无关，始终可见）
    if (this._localParticleSystem) {
      // 钳制物理步长：seek 跳变时 dt 可能很大，避免粒子瞬间飞出视野
      const stepDt = Math.min(Math.max(0, dt), 0.1)
      this._localParticleSystem.update(t, Math.max(0.016, stepDt || 0.016))
      renderer.updateVibrationParticles?.(this._localParticleSystem.activeParticles)
    }

    // 首次进入起爆后：初始化振动场体积（粒子系统由 renderer.initVibrationField 同步初始化）
    if (!renderer.hasVibrationField?.()) {
      const gridInfo = sim.getGridInfo()
      renderer.initVibrationField?.(gridInfo)
    }

    // 计算节流：全量重算三场 + 上传 3 个 Data3DTexture 是主线程重负载。
    // 双重节流：①模拟时间间隔（默认 0.2s）保证低倍速下波形平滑；②墙钟间隔
    // （120ms）给高倍速封顶——高倍速时模拟时间飞驰，若只按模拟时间节流，
    // 重算频率 ×倍速 会被压到每帧一次，主线程卡顿导致播放与热力图时序错乱。
    const nowMsThrottle = performance.now()
    const wallOk = nowMsThrottle - this._vibLastUpdateWallMs >= 120
    if (
      this._vibFieldLastUpdate >= 0 &&
      t - this._vibFieldLastUpdate < this._vibFieldUpdateInterval &&
      !wallOk
    ) {
      return
    }
    this._vibFieldLastUpdate = t
    this._vibLastUpdateWallMs = nowMsThrottle

    // 计算当前时刻三场数据并推送渲染器。
    // 优先走 Worker 异步卸载（多源矢量叠加很重，逐帧跑会卡死主线程）；
    // Worker 不可用时回退主线程同步计算（旧逻辑，数据量小时可接受）。
    this._dispatchVibrationCompute(t, frame, renderer)
  }

  /**
   * 派发振动场三场计算（PPV/应力/损伤），异步经 Worker 卸载重负载。
   *
   * 调度策略：
   *  - 同一时刻仅允许一个请求在途（coalesce）；在途期间新目标记为 pending，
   *    当前请求完成后补算最新一帧——保证不堆积请求、不丢失最新时刻；
   *  - requestId 用于丢弃过期的中途结果（网格/参数变化后旧结果直接作废）；
   *  - Worker 不可用（低端浏览器）回退到 sim.computeAtTime 同步计算，功能不变。
   *
   * @param {number} t - 目标模拟时间(s)
   * @param {number} frame - 帧序号（透传给渲染器）
   * @param {object} renderer - three.js 渲染器实例
   */
  _dispatchVibrationCompute(t, frame, renderer) {
    const sim = this._localVibrationSim
    if (!sim || !renderer) return

    if (this._vibComputeClient.ensure(sim)) {
      // Worker 可用 → 异步卸载
      if (this._vibComputeReqInFlight) {
        this._vibComputePending = { t, frame } // 只在途一次，完成后补算最新
        return
      }
      this._vibComputeReqInFlight = true
      const reqId = ++this._vibComputeReqId
      this._vibComputeClient.compute(t, reqId).then(res => {
        this._vibComputeReqInFlight = false
        if (res) this._applyVibrationFields(res.ppv, res.sigmaVm, res.zones, res.t, frame, renderer)
        // 期间到达了更新的目标帧 → 续算（只补最后一帧，避免堆积）
        if (this._vibComputePending) {
          const pending = this._vibComputePending
          this._vibComputePending = null
          this._dispatchVibrationCompute(pending.t, pending.frame, renderer)
        }
      })
      return
    }

    // Worker 不可用 → 主线程同步回退（旧路径）
    const result = sim.computeAtTime(t)
    this._applyVibrationFields(result.ppv, result.sigmaVm, result.zones, t, frame, renderer)
  }

  /**
   * 将计算好的三场数据写入渲染器体积纹理。
   * 仅本地模拟时更新 PPV；应力/损伤在 WS 帧新鲜（2s 内）时让位给 WS 数据，
   * 避免两数据源交替写同一纹理导致云图闪烁/回跳。
   * @param {Float32Array} ppv - PPV 场（m/s，x-最快轴序）
   * @param {Float32Array} sigmaVm - von Mises 应力场（Pa）
   * @param {Int8Array} zones - 损伤分区 id（0~4）
   * @param {number} t - 模拟时间(s)
   * @param {number} frame - 帧序号
   * @param {object} renderer - three.js 渲染器
   */
  _applyVibrationFields(ppv, sigmaVm, zones, t, frame, renderer) {
    if (!renderer) return
    // PPV 场：仅在本地模拟模式（WS 不可用）下更新。
    // WS 模式下 PPV 由后端实时帧推送，避免本地与 WS 数据交替写入造成闪烁。
    if (this._localVibrationEnabled) {
      renderer.updateVibrationField?.(ppv, t, frame)
    }
    // 应力场与损伤场：本地兜底更新，但 WS 帧新鲜（2s 内）时让位。
    // 本地模拟用 visualCp≈35m/s（可视波前），WS 用 cp=4500m/s（物理波前），
    // 两数据源交替写同一纹理会导致云图闪烁/回跳，故以 WS 优先、本地兜底。
    const nowMs = performance.now()
    const WS_STALE_MS = 2000
    if (nowMs - (this._lastWsStressMs || 0) > WS_STALE_MS) {
      renderer.updateStressField?.(sigmaVm, t, frame)
    }
    if (nowMs - (this._lastWsDamageMs || 0) > WS_STALE_MS) {
      renderer.updateDamageField?.(zones, t, frame)
    }
  }

  /**
   * 设置 three.js 渲染图层可见性（烟雾/碎石/隧道/钻孔/标注等）
   * @param {string} layer - 图层名
   * @param {boolean} visible
   */
  setLayerVisible(layer, visible) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.setLayerVisible?.(layer, visible)
  }

  /** 批量设置图层可见性 */
  setLayersVisible(map = {}) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.setLayersVisible?.(map)
  }

  /**
   * 运行时更新隧道断面与掏槽形式（UI 编辑入口）
   * 更新断面参数 + designParams.cutPattern，下次 buildScene 时生效
   * @param {Object} payload - { width, wallHeight, archRadius, shape, cutPattern }
   */
  updateSection(payload) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    if (!renderer) return
    // 1) 更新断面参数
    renderer.setTunnelSection({
      width: payload.width,
      wallHeight: payload.wallHeight,
      archRadius: payload.archRadius,
      shape: payload.shape
    })
    // 2) 更新 designParams.cutPattern（清空数据库孔位，走参数化回退布孔）
    const designParams = { cutPattern: payload.cutPattern || 'diamond' }
    renderer.setBlastHoleDesign(null, designParams)
    // 3) 同步到 dataset.design 供后续 initBlast 读取
    if (this.dataset) {
      if (!this.dataset.design) this.dataset.design = {}
      this.dataset.design.tunnelWidth = payload.width
      this.dataset.design.tunnelWallHeight = payload.wallHeight
      this.dataset.design.tunnelArchRadius = payload.archRadius
      this.dataset.design.tunnelShape = payload.shape
      this.dataset.design.cutPattern = payload.cutPattern
    }
  }

  /** 获取当前图层可见性状态 */
  getLayerVisibility() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getLayerVisibility?.() || null
  }

  // ─── 爆堆轮廓（三维包络 + 安息角标注）────────────────────

  /** 开启/关闭爆堆轮廓渲染 */
  setMuckPileOutlineEnabled(enabled) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.setMuckPileOutlineEnabled?.(enabled)
  }

  /** 当前爆堆轮廓是否可见 */
  getMuckPileOutlineEnabled() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return !!renderer?.getMuckPileOutlineEnabled?.()
  }

  /** 爆堆测量值（安息角/堆高/堆宽/堆长） */
  getMuckPileMeasure() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getMuckPileMeasure?.() ?? null
  }

  /**
   * 获取爆破设计数据（炮孔布置、统计、装药参数等）
   * @returns {Object|null}
   */
  getBlastDesign() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getBlastDesign?.() || null
  }

  /**
   * 重新触发爆破效果（用于 UI 按钮重播）
   * 复用当前 dataset，重新初始化 three.js 桥接器
   * @param {Object} kcoOverride - 可选，UI 编辑后的 KCO 参数覆盖（Q/xmax/x50/b/n 等）
   */
  replayBlast(kcoOverride = {}) {
    if (!this.threeBridge || !this.dataset?.event) {
      this._initThreeBridge(kcoOverride)
      return
    }
    this._clearThreeBridge()
    this._initThreeBridge(kcoOverride)
  }

  /**
   * 构建 Cesium 实体（仅保留爆心标记，作为地理参考）
   * 冲击波环、设计面、炮孔折线等可视化已交由 three.js 渲染，此处不再创建。
   */
  buildEntities() {
    if (!this.dataset?.event) return
    const event = this.dataset.event
    const center = {
      lon: Number(event.centerLon || 0),
      lat: Number(event.centerLat || 0),
      height: Number(event.centerHeight || 0)
    }
    const centerCartesian = toCartesian(center)

    this.centerEntity = this.viewer.entities.add({
      position: centerCartesian,
      point: {
        pixelSize: 12,
        color: Cesium.Color.ORANGE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2
      },
      label: {
        text: event.name || '',
        font: '13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        pixelOffset: new Cesium.Cartesian2(0, -24)
      }
    })
  }

  /**
   * 销毁管理器：清理场景与 three.js 容器
   */
  destroy() {
    this.clearScene()
    if (this.threeContainer && this.threeContainer.parentNode) {
      this.threeContainer.parentNode.removeChild(this.threeContainer)
      this.threeContainer = null
    }
  }
}
