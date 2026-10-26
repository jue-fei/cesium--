import * as Cesium from 'cesium'
import { CesiumThreeBridge } from './core/rendering/cesiumThreeBridge.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'
import {
  LocalVibrationSimulator,
  VibrationParticleSystem,
  VibrationComputeClient,
  buildChargeSources,
  resolveChargePosition,
  applyDelayGroupNormalization,
  computeMonitorTimeHistory,
  computeSurfacePeakField,
  computeSurfaceInstantField,
  estimateDamageAwareGrid
} from './core/computation/localVibrationSimulator.js'
import {
  DAMAGE_THRESHOLDS_CMPS,
  INFLUENCE_V0_CMPS,
  safetyInfluenceRangeM
} from './core/rendering/vibrationColorScales.js'
import { SADOVSKY_DEFAULT_K, SADOVSKY_DEFAULT_ALPHA } from './core/vibrationDefaults.js'
import { matchLiteratureEvent } from './core/literatureEvents.js'
import { buildNanshanTunnelDesign } from './core/computation/nanshanTunnelDesign.js'
import { buildKunyangTunnelDesign } from './core/computation/kunyangTunnelDesign.js'
import { buildDabalaiTunnelDesign } from './core/computation/dabalaiTunnelDesign.js'
import { buildSanlengshanTunnelDesign } from './core/computation/sanlengshanTunnelDesign.js'
import { buildYuyangTunnelDesign } from './core/computation/yuyangTunnelDesign.js'
import { buildDongwujunTunnelDesign } from './core/computation/dongwujunTunnelDesign.js'
import { buildFengyinTunnelDesign } from './core/computation/fengyinTunnelDesign.js'
import {
  DEFAULT_TUNNEL_WIDTH,
  DEFAULT_TUNNEL_WALL_HEIGHT,
  DEFAULT_TUNNEL_ARCH_RADIUS,
  DEFAULT_FRAGMENT_RENDER_LIMIT,
  calcTunnelArea
} from './core/blastDefaults.js'

// ─── 振动场可视化口径（与 shader 的 uniform 同源）───────────────────
// 岩体总深 20m。**视觉波速**决定"波前扫过整块岩体所需的模拟时间"：
// 35 m/s 时 20m 仅需 0.57s —— 相对 40s 时间轴几乎瞬间扫过，观感"波一动不动/传播没用"。
// 取 5 m/s → 约 4s 扫完：能看清波前推进，又不至于慢到失真。
const VISUAL_CP = 5
// 瞬时场**显示**时变衰减(1/s)：亮环厚度 ≈ VISUAL_CP / DISPLAY_DECAY。
// 3.0 → 厚 1.7m（多孔各自的环互相叠成大块"花瓣"，观感粗糙）；
// 7.0 → 厚 ≈0.7m 的**薄波前**：各孔的细环清晰可辨、随距离推进并自然并成连续波前
// （对齐 LS-DYNA 的细致波前观感）。与峰值判据解耦：峰值仍用 β+PEAK_VISUAL_BETA 缓衰减，
// 否则这个较大的显示衰减会把远场峰值压没（损伤分区随之缩水）。
const DISPLAY_DECAY = 7.0
// 峰值场（损伤判据 / 满量程）的视觉衰减项：≈ 原口径量级（β+0.8）在 4s 量级到达时的衰减
const PEAK_VISUAL_BETA = 0.15

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

// 文献事件 key → 隧道设计构建器（事件匹配规则见 core/literatureEvents.js）
const LITERATURE_DESIGN_BUILDERS = {
  nanshan: buildNanshanTunnelDesign,
  kunyang: buildKunyangTunnelDesign,
  dabalai: buildDabalaiTunnelDesign,
  sanlengshan: buildSanlengshanTunnelDesign,
  yuyang: buildYuyangTunnelDesign,
  dongwujun: buildDongwujunTunnelDesign,
  fengyin: buildFengyinTunnelDesign
}

// WS 振动场帧陈旧判定阈值（ms）：超过该时长未收到帧则回退本地模拟
const WS_STALE_MS = 2000

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
  /** three.js 渲染器快捷访问（threeBridge 懒初始化/销毁期间为 null） */
  get _threeRenderer() {
    return this.threeBridge?.getThreeRenderer?.() || null
  }

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
    // 振动场 CPU 网格重算节流（模拟时间间隔，秒）。
    // 【只影响点拾取刷新率，不影响热力图】岩面热力图/损伤分区/时程曲线全部由
    // 片元着色器/解析场逐帧计算，与本网格无关；本网格只喂 sampleAtWorldPoint。
    // 故可以放宽：24×32×48 网格单次 ≈ 207ms（实测），按 0.4s 节流 worker 占用约 52%。
    this._vibFieldLastUpdate = -1
    this._vibFieldUpdateInterval = 0.4
    // 波包载波频率（Hz，0=关）：见 setVibrationCarrierHz。默认 0 = 纯包络（与原版一致）
    this._vibCarrierHz = 0
    // 动态满量程系数（岩面瞬时场统计 → 热力图 uNormAutoScale，见 _updateFieldAutoScale）
    this._fieldAutoScale = 1
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
    // 热力图双缓冲 + 时间插值：全量重算被 throttle 到 ~0.2s，但相邻两帧精确场之间
    // 按当前模拟时间在每一帧线性混合后写纹理，使显示平滑跟随 t（消除"旧场停留→猛跳"的闪烁）
    this._fieldPrev = null // { t, ppv, sigmaVm } —— 上一帧精确场
    this._fieldCur = null // { t, ppv, sigmaVm } —— 最近一帧精确场
    this._vibLerpBuf = null // { ppv, sigma } —— 插值输出复用 scratch（避免逐帧分配大数组）
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
   * 按事件选择对应的文献化隧道设计（CO 按 event_id/名称赠送对应文献模型）。
   * 避免此前"凡 wedge 一律盖章南山"导致 006(Da Balai/昆阳) 与 002(南山) 模型完全相同。
   * 事件→key 的匹配规则与各事件孔深/利用率/K/α 见 core/literatureEvents.js（单源）。
   * @returns {{ key: 'nanshan'|'kunyang'|'dabalai'|'sanlengshan'|'yuyang'|'dongwujun'|'fengyin'|null,
   *    design?: {section, holes}, holeDepth?: number, utilization?: number }}
   */
  _resolveLiteratureDesign() {
    const ev = this.dataset?.event
    const lit = matchLiteratureEvent(ev?.event_id, ev?.name)
    if (!lit) return { key: null, design: null }
    const builder = LITERATURE_DESIGN_BUILDERS[lit.key]
    return {
      key: lit.key,
      design: builder ? builder() : null,
      holeDepth: lit.holeDepth,
      utilization: lit.utilization
    }
  }

  /**
   * 将文献化隧道设计写回 dataset.design（CO 对应 002 南山 / 004 昆阳 及其余文献事件）。
   * 数据库种子对楔形/掏槽事件可能回退到通用菱形掏槽 + 通用断面，与文献不符，
   * 故在此统一覆盖，保证 3D 模型与 UI 全程读取同一套数据（断面/布孔/孔深/进尺一致）。
   */
  _stampLiteratureDesignIfNeeded() {
    const design = this.dataset?.design
    if (!design) return
    const lit = this._resolveLiteratureDesign()
    if (!lit.design) return
    const { section: s, holes } = lit.design
    const depth = lit.holeDepth ?? 3.0
    const utilization = lit.utilization ?? 0.85
    design.tunnelWidth = s.width
    design.tunnelWallHeight = s.wallHeight
    design.tunnelArchRadius = s.archRadius
    design.tunnelTotalHeight = s.totalHeight
    design.tunnelShape = s.shape
    design.holeDepth = depth
    design.utilization = utilization
    design.advanceLength = depth * utilization
    design.holeDiameter = design.holeDiameter || 0.04
    design.holes = holes
    this._literatureStamped = lit.key
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
    const renderer = this._threeRenderer
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
    const renderer = this._threeRenderer
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
    return !!this._threeRenderer?.getReplayDurationS?.()
  }

  /** 全速预计算进度：{ active: boolean, pct: 0-100 }（供 UI 显示"物理预计算中"） */
  getReplayProgress() {
    return (
      this._threeRenderer?.getReplayProgress?.() ?? {
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
    const renderer = this._threeRenderer
    const design = this.dataset?.design
    // holes 来自 blasting_design_holes 表，供炮孔布局与 KCO 单孔药量推导使用
    const holes = Array.isArray(design?.holes) ? design.holes : []

    // 按事件对齐对应的文献化设计（002 南山 / 006 昆阳），使 3D 模型、布孔、微差时序
    // 与文献一致；否则回退到数据库 design。多源应力波（_computeBlastSources）据此在
    // 空间铺开、时序错开的装药源 → 非同心圆干涉波场。
    const lit = this._resolveLiteratureDesign()
    let effSection = null
    let effHoles = holes
    if (lit.design) {
      effSection = lit.design.section
      effHoles = lit.design.holes
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
    blastingSceneTools.setRenderer(this._threeRenderer || null)

    // 跳转到隧道内部视角（直接设置相机位置，非飞行）
    this._jumpToCameraView()
  }

  /**
   * 直接设置 Three.js 相机到隧道内部视角（跳转，非飞行）
   * 相机位于隧道内部（掌子面后方），朝向掌子面观察
   */
  _jumpToCameraView() {
    const renderer = this._threeRenderer
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
    return this._threeRenderer?.getStats() || null
  }

  /**
   * 获取块度分布统计（按 physSize 分组）
   * @returns {Object|null} { buckets, total, x50, x80, xmax }
   */
  getFragmentDistribution() {
    const renderer = this._threeRenderer
    return renderer?.getFragmentDistribution?.() || null
  }

  /**
   * 高亮指定块度范围的碎片
   * @param {number} minSize - 物理尺寸下限（米）
   * @param {number} maxSize - 物理尺寸上限（米）
   */
  highlightFragmentsBySize(minSize, maxSize) {
    const renderer = this._threeRenderer
    renderer?.highlightFragmentsBySize?.(minSize, maxSize)
  }

  /** 清除碎片高亮，恢复原始颜色 */
  clearFragmentHighlight() {
    const renderer = this._threeRenderer
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
    const renderer = this._threeRenderer
    renderer?.initVibrationField?.(cfg)
    // 解析外推波场物理参数（萨道夫斯基 K/α/装药量/源列表）：PPV/应力模式的岩面
    // 解析显示依赖这批 uniform，WS 模式下也必须在首帧前注入
    this._pushFieldPhysics()
    // 【已移除】影响范围圈（青/橙两环）场景渲染——用户要求去掉；
    // 影响范围数值仍经 getVibrationFieldInfo().influenceRanges 在面板图例中展示
    // 同步本地模拟器网格：WS 的 gridShape 可能与本地默认值不同
    // （后端 build_ppv_grid 使用 resolution=1.5m，本地默认 nx=32,ny=32,nz=64）
    // 不一致时本地 stress/damage 数组长度不匹配渲染器纹理，导致更新被跳过
    this._syncLocalVibrationSimGrid(cfg)
    // 首次拿到场数据即刷新一次动态满量程（暂停状态切换事件时不必等播放推进）
    this._updateFieldAutoScale(renderer)
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
    const sampleMode = cfg.gridSampleMode === 'nodes' ? 'nodes' : 'centers'
    const sameVector = (a, b) =>
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length >= 3 &&
      b.length >= 3 &&
      a.slice(0, 3).every((value, i) => Math.abs(Number(value) - Number(b[i])) <= 1e-5)
    const sameGrid =
      cur &&
      cur[0] === nx &&
      cur[1] === ny &&
      cur[2] === nz &&
      sameVector(info?.boundsMin, cfg.boundsMin) &&
      sameVector(info?.boundsMax, cfg.boundsMax) &&
      info?.gridSampleMode === sampleMode
    if (sameGrid) return
    // 尺寸、物理边界或采样约定任一变化都重建；避免同尺寸新网格误用旧 bounds。
    this.initVibrationField({ ...cfg, gridSampleMode: sampleMode })
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
      // 场地标定 K/α 必须与 _ensureLocalVibrationSim / WS 推送同源：缺省时本地模拟器
      // 会落到 LOCAL_SIM_DEFAULT_K=30（远场量级差 3 倍、损伤分区随之偏移）
      K: params.k,
      alpha: params.alpha,
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
    const renderer = this._threeRenderer
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
    const renderer = this._threeRenderer
    renderer?.updateStressField?.(sigmaVm, t, frame)
  }

  /**
   * 更新损伤分区场（每个 DAMAGE 二进制帧调用）
   * @param {Int8Array} zones - 分区 id（-1=未到达/未分类，0~4=档位）
   * @param {number} t
   * @param {number} frame
   */
  updateDamageField(zones, t, frame, gridSampleMode = 'nodes') {
    this._lastWsDamageMs = performance.now()
    const renderer = this._threeRenderer
    renderer?.updateDamageField?.(zones, t, frame, gridSampleMode)
  }

  /**
   * 切换振动场显示模式（ppv/stress/damage）
   * @param {string|number} mode
   */
  setVibrationDisplayMode(mode) {
    const renderer = this._threeRenderer
    renderer?.setVibrationDisplayMode?.(mode)
  }

  /**
   * 设置振动场底材"白模"开关：true=场图层开启时岩体切白模底，false=保留岩石纹理底
   * @param {boolean} enabled
   */
  setWhiteModelEnabled(enabled) {
    this._threeRenderer?.setBenchWhiteModel?.(!!enabled)
  }

  /**
   * 设置热力图波包载波频率（Hz，0=关）。
   *
   * 该值不参与峰值判据（损伤分区用的 peak 是包络，与载波无关），只改变岩面
   * 瞬时振速场的空间频率——即屏幕上干涉条纹的疏密：
   *   · 载波空间波长 λ = visualCp / f（visualCp=35 m/s）；f=2 时 λ=17.5m，波环清晰；
   *   · f 越大条纹越密，f≈8 以上在屏幕尺度上接近噪点；
   *   · f=0 退化为纯包络（无行波环，最平滑，与原版一致）。
   * 经 renderer.setFieldPhysics 下发：参数被渲染器缓存，场景重建后自动重放。
   * @param {number} hz - 0~30
   */
  setVibrationCarrierHz(hz) {
    const v = Math.max(0, Math.min(30, Number(hz) || 0))
    this._vibCarrierHz = v
    this._threeRenderer?.setFieldPhysics?.({ carrierHz: v })
  }

  /** 当前波包载波频率（Hz，0=关） */
  getVibrationCarrierHz() {
    return this._vibCarrierHz ?? 0
  }

  // ─── 动态满量程（岩面瞬时场统计 → 热力图归一化系数）──────────

  /**
   * 确保热力图动态满量程系数与当前时刻一致（每次播放 tick 调用）。
   *
   * 幂律衰减场动态范围可达 10^3：固定满刻度时要么近场整片饱和成顶端色（掌子面牛眼），
   * 要么远场全挤在同一档（无梯度）。按**当前瞬时场**的最大值反解缩放系数：只有最热点
   * 触及满刻度，其余按比例落位 → 近场饱和面积显著缩小；系数下发给 shader
   * （lin *= uNormAutoScale），热力图色带随场值分布自适应（LS-DYNA 口径）。
   *
   * 流程：导出岩面采样网格（grid 局部系，随几何版本缓存，见 sceneBuilder.getSurfaceSampleGrid）
   * → 算每顶点瞬时 |v(t)|（与热力图着色器同口径）→ 最大值反解 autoscale → setFieldPhysics 下发。
   * 岩面顶点数千级，单次毫秒级，无需 Worker。
   */
  _updateFieldAutoScale(renderer, tArg) {
    if (!renderer?.getSurfaceSampleGrid) return
    const surface = renderer.getSurfaceSampleGrid()
    if (!surface || !surface.positions?.length || surface.positions.length < 9) return
    const rp = renderer.getFieldRenderParams?.() || {}
    const t = Number.isFinite(Number(tArg)) ? Number(tArg) : Number(renderer.simTime) || 0
    if (t < 0.001) return // t≈0：波尚未到达，瞬时场恒为 0，保持上次系数
    const mode = Number(rp.displayMode) || 0
    const stressFactor = Number(rp.stressFactor)
    const inStressUnits = mode === 1 && Number.isFinite(stressFactor) && stressFactor > 0
    const cSt = inStressUnits ? stressFactor / 1.0e6 : 1
    // 瞬时场值（每 tick 重算）：单位与 shader 的 mps 一致（m/s）；应力模式换算为 MPa
    let values = computeSurfaceInstantField(surface.positions, {
      K: this._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta:
        Number(this.dataset?.event?.rockParams?.attenuationP) || this.dataset?.event?.beta || 0.02,
      visualBeta: PEAK_VISUAL_BETA,
      visualCp: VISUAL_CP,
      sources: this._computeBlastSources(),
      origin: this._computeBlastOrigin(),
      lateralAttn: 0.95,
      chargeKg: this.getPpvStreamParams()?.chargeKg,
      t,
      arrivalRise: this._vibArrivalRise ?? 0.12,
      carrierHz: this._vibCarrierHz ?? 0,
      displayDecay: DISPLAY_DECAY
    })
    if (values && inStressUnits) {
      const scaled = new Float32Array(values.length)
      for (let i = 0; i < values.length; i++) scaled[i] = values[i] * cSt
      values = scaled
    }
    if (!values) return
    const refDisp = mode === 1 ? Number(rp.stressRefMPa) || 0 : Number(rp.ppvRefMps) || 0
    let autoscale = 1
    if (refDisp > 0) autoscale = this._p99Autoscale(values, refDisp)
    this._fieldAutoScale = autoscale
    renderer.setFieldPhysics?.({ normAutoScale: autoscale })
  }

  /**
   * 动态满量程系数（按当前场值的**最大值**自动量程，LS-DYNA 口径）。
   *
   * 幂律衰减场动态范围可达 10^3：固定满刻度时要么近场整片饱和成顶端色（掌子面牛眼），
   * 要么远场全挤在同一档（无梯度）。用最大值（而非 P99.9）定标：只有最热点触及满刻度，
   * 其余按比例落位 → 近场饱和面积显著缩小、牛眼减弱。
   * 系数钳在 [0.02, 80]（可缩可放），并下发给 shader（lin *= uNormAutoScale）。
   * @param {Float32Array|number[]} values - 瞬时场（与 ref 同单位）
   * @param {number} ref - 满刻度（同单位）
   * @returns {number} autoscale ∈ [0.02, 80]
   */
  _p99Autoscale(values, ref) {
    let maxV = 0
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v > maxV) maxV = v
    }
    if (!(maxV > 0)) return 1
    return Math.min(80, Math.max(0.02, Number(ref) / (maxV * 1.05)))
  }

  /** 当前是否已有可渲染的振动场 */
  hasVibrationField() {
    const renderer = this._threeRenderer
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
    const renderer = this._threeRenderer
    if (!renderer?.enablePointPick) return null
    // 【关键】注入解析场采样器：渲染器只负责"射线打岩体网格拿世界坐标"，
    // 物理计算留在本类（用与岩面热力图同一套公式），故点在模型任意位置都有效。
    renderer.setProbeSampler?.(worldPos => this._sampleProbeAtWorld(worldPos))
    return renderer.enablePointPick(handler, opts) ?? null
  }

  /**
   * 在命中点用**解析场**采样，返回面板"场点采样"卡片所需的结构：
   *   { inside, local, gridX/Y/Z, ppvCmps, stressMPa, zone }
   *
   * 与岩面热力图严格同口径（同一份装药源、同 K/α/β/可视化波速/载波），所以该点的
   * 瞬时值就等于该时刻热力图在该点所代表颜色的振速；损伤档位按峰值 PPV 阈值
   * （DAMAGE_THRESHOLDS_CMPS 单源：25/63.5/254/1500 cm/s，Bauer-Calder/Persson
   * 文献口径，与后端一致）判定。
   *
   * 不走 3D 纹理采样：纹理网格只有约 18×15×40m 且分辨率低，既覆盖不到整块岩体，
   * 精度也不足以支撑"点哪算哪"的探测。
   */
  _sampleProbeAtWorld(worldPos) {
    const renderer = this._threeRenderer
    const grid = renderer?.worldToGrid?.(worldPos)
    if (!Array.isArray(grid)) return null
    const sources = this._computeBlastSources()
    if (!sources || !sources.length) return null
    const rockParams = this.dataset?.event?.rockParams || {}
    const design = this.dataset?.design || {}
    const params = this.getPpvStreamParams()
    const opts = {
      K: this._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta: Number(rockParams.attenuationP) || this.dataset?.event?.beta || 0.02,
      visualBeta: PEAK_VISUAL_BETA,
      visualCp: VISUAL_CP,
      carrierHz: this._vibCarrierHz ?? 0,
      displayDecay: DISPLAY_DECAY,
      minStandoff: 0.5
    }
    const t = Number(renderer?.simTime) || 0
    // 瞬时振速（含载波，与当前帧热力图同口径）
    const hist = computeMonitorTimeHistory(grid, sources, new Float32Array([t]), opts)
    const mps = hist.vmag[0]
    // 峰值（不含载波的包络峰值，与损伤分区同口径）
    const pk = computeSurfacePeakField(grid, {
      ...opts,
      sources,
      origin: this._computeBlastOrigin(),
      lateralAttn: 0.95,
      chargeKg: params?.chargeKg
    })
    const peak = pk.peak[0]
    // σ_vm = ρ·c_p/(1−μ_d)·v，动态泊松比 μ_d = 0.8ν（与 GPU/后端 stress_factor 同口径）
    const rho = Number(design.rockDensity) || 2650
    const cp = Number(rockParams.pWaveSpeed) || 4500
    const nuRaw = Number(design.poissonRatio) ?? Number(rockParams.poissonRatio) ?? 0.25
    const nuDyn = 0.8 * Math.max(0, Math.min(0.49, Number(nuRaw) || 0.25))
    const stressFactor = rho * cp * (1 / (1 - nuDyn))
    const cmps = peak * 100
    // 损伤分区：与 CPU 模拟器/着色器/后端同一套文献阈值（vibrationColorScales 单源）
    const DT = DAMAGE_THRESHOLDS_CMPS
    const zone = cmps < DT[0] ? 0 : cmps < DT[1] ? 1 : cmps < DT[2] ? 2 : cmps < DT[3] ? 3 : 4
    return {
      inside: true,
      local: grid,
      gridX: grid[0],
      gridY: grid[1],
      gridZ: grid[2],
      ppvCmps: mps * 100,
      stressMPa: (stressFactor * mps) / 1e6,
      zone
    }
  }

  /** 关闭"场点拾取" */
  disablePpvPick() {
    const renderer = this._threeRenderer
    renderer?.disablePointPick?.()
  }

  /** 振动场元信息（grid/时间/帧/影响范围，供面板展示与影响圈绘制） */
  getVibrationFieldInfo() {
    const renderer = this._threeRenderer
    const info = renderer?.getVibrationFieldInfo?.() || null
    if (!info) return null
    try {
      return { ...info, influenceRanges: this._computeInfluenceRanges() }
    } catch {
      return info
    }
  }

  /**
   * 计算某点的振动时程（探测点的"测试值 - 时间轴"二维曲线用）。
   *
   * 与岩面热力图严格同口径：同一份装药源、同一套 K/α/β/可视化波速/载波频率，
   * 因此曲线上任意时刻的值 = 该时刻热力图在该点的颜色所代表的振速，
   * 峰值 ppv 也与损伤分区判据一致（不含载波的包络峰值）。
   *
   * @param {number[]} localPos - 采样点 grid 局部坐标 [x,y,z]（取自场点拾取的 sample.local）
   * @param {number} [durationS] - 时程总时长（秒），缺省取事件/渲染器时长
   * @returns {null|{t,vx,vy,vz,vmag:Float32Array, ppv:number, peakT:number}}
   */
  computePointTimeHistory(localPos, durationS) {
    if (!Array.isArray(localPos) || localPos.length < 3) return null
    const sources = this._computeBlastSources()
    if (!sources || !sources.length) return null
    const rockParams = this.dataset?.event?.rockParams || {}
    const duration =
      Number(durationS) ||
      this.getDurationS() ||
      Number(this.dataset?.result?.simulationDurationS) ||
      10
    // 采样步长 0.02s：波环周期量级 0.5s（2Hz）时每周期 25 点，足够画出波形；
    // 上限 4000 点防止超长事件把曲线数组撑爆（纯前端绘制，无需更高密度）。
    const dt = 0.02
    const n = Math.max(16, Math.min(4000, Math.floor(duration / dt)))
    const times = new Float32Array(n)
    for (let i = 0; i < n; i++) times[i] = i * dt
    return computeMonitorTimeHistory(localPos, sources, times, {
      K: this._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta: Number(rockParams.attenuationP) || this.dataset?.event?.beta || 0.02,
      visualBeta: PEAK_VISUAL_BETA,
      visualCp: VISUAL_CP,
      carrierHz: this._vibCarrierHz ?? 0,
      displayDecay: DISPLAY_DECAY,
      minStandoff: 0.5
    })
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
    const renderer = this._threeRenderer
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
    const renderer = this._threeRenderer
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

    // A5：应力波源 = 掏槽孔组（cut/easing，楔形掏槽微差起爆的核心）+ 掌子面四向
    // （拱顶/底板/两侧）代表性装药孔；随后按装药量降序补齐**其余全部装药孔**。
    // 早前只取 16 个源（掏槽组+四向极端）→ 波前看起来"集中在掌子面中央一点"，
    // 而不是从各个炮孔起爆传播。现取全部装药孔作为源（上限 64，着色器容量 96），
    // 波前从每个炮孔起始、叠加成真实的多源波场。
    // 代价：CPU 逐点源循环与 GPU 片元源循环随源数线性增长（每帧点数×源数）。
    const MAX_SRCS = 64
    const charged = normalized.filter(h => !h.isEmptyHole && Number(h.chargeKg) > 0)
    const cutHoles = charged.filter(h => {
      const t = String(h.holeType || h.type).toLowerCase()
      return t === 'cut' || t === 'easing'
    })
    // 周边(非掏槽)孔代表装药量：取最常用孔位装药，未标装药量的周边孔也用其命名，
    // 保证四向极端孔即便 chargeKg=0 也能作为足量应力源参与叠加，不白圈位置。
    const perimCharges = normalized
      .filter(h => !h.isEmptyHole && Number(h.chargeKg) > 0)
      .map(h => Number(h.chargeKg))
      .sort((a, b) => b - a)
    const repPerimKg =
      perimCharges.length > 0
        ? perimCharges[Math.min(1, perimCharges.length - 1)]
        : Number(this.dataset?.event?.chargeKg) || 25
    if (cutHoles.length > 0 && cutHoles.length < MAX_SRCS) {
      // 在周边（非掏槽）装药孔里挑"四向极端"孔位：最高、最低、最左、最右，
      // 与中央掏槽组叠加 → 上/下/左/右围岩都能受力，消除中央单点漏斗。
      // 用"所有非空孔"而非仅已装药孔，避免某设计周边孔 chargeKg=0 时极端孔全部落空。
      const peripheral = normalized.filter(h => !h.isEmptyHole && !cutHoles.includes(h))
      if (peripheral.length > 0) {
        const byY = [...peripheral].sort((a, b) => a.posY - b.posY)
        const byX = [...peripheral].sort((a, b) => a.posX - b.posX)
        const picks = [byY[byY.length - 1], byY[0], byX[0], byX[byX.length - 1]]
        for (const p of picks) {
          if (!p || cutHoles.includes(p)) continue
          if (!(Number(p.chargeKg) > 0)) p.chargeKg = repPerimKg
          cutHoles.push(p)
          if (cutHoles.length >= MAX_SRCS) break
        }
      }
    }
    // 按装药量降序补齐其余装药孔 → 波前从**每个炮孔**起始传播（而非集中于中央一点）
    if (cutHoles.length < MAX_SRCS && charged.length > cutHoles.length) {
      const rest = charged
        .filter(h => !cutHoles.includes(h))
        .sort((a, b) => Number(b.chargeKg) - Number(a.chargeKg))
      for (const h of rest) {
        if (cutHoles.length >= MAX_SRCS) break
        cutHoles.push(h)
      }
    }
    const srcHoles = cutHoles.length > 0 ? cutHoles : charged

    const sources = buildChargeSources(srcHoles, faceOffset, { x: cx, y: cy })
    // 起爆段等效药量归一（见 localVibrationSimulator.applyDelayGroupNormalization）：
    // 修正"各孔峰值振幅直接相加"把远场按 N 而非 N^(α/3) 标度放大的问题
    // （萨道夫斯基药量是立方根标度；不归一时 PPV/应力/损伤分区整体偏大约 6~12 倍）。
    // 归一值写入 fieldChargeKg，chargeKg 保留真实药量供 JWL/FDTD 与统计使用。
    return sources.length > 0
      ? applyDelayGroupNormalization(sources, this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA)
      : null
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
    const result = {
      chargeKg: Number(event.chargeKg) || 100,
      blastCenter: this._computeBlastOrigin(),
      tunnelWidth: Number(effSec?.width) || Number(design.tunnelWidth) || DEFAULT_TUNNEL_WIDTH,
      tunnelHeight:
        (Number(effSec?.wallHeight) ||
          Number(design.tunnelWallHeight) ||
          DEFAULT_TUNNEL_WALL_HEIGHT) +
        (Number(effSec?.archRadius) ||
          Number(design.tunnelArchRadius) ||
          DEFAULT_TUNNEL_ARCH_RADIUS),
      k: this._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA
    }
    // 【显示域 = 全岩体】把岩体实际包围盒（场盒局部坐标）随启动参数发给后端，
    // 使 WS 计算网格与岩体几何对齐、热力图覆盖全部岩面；岩体几何尚不可用时不带
    // 该字段（后端回退到默认基础域）。见 _getRockFieldBounds。
    const rockBounds = this._getRockFieldBounds()
    if (rockBounds) {
      result.fieldBoundsMin = rockBounds.boundsMin
      result.fieldBoundsMax = rockBounds.boundsMax
    }
    return result
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
      // 回退默认值：防止只传 alpha 时把 undefined 写入 params.K
      // （computePpvField3d 会退到 options.K ?? 200，与 WS/着色器的 90 口径不一致）
      this._localVibrationSim.params.K = this._sadoskyK ?? SADOVSKY_DEFAULT_K
      this._localVibrationSim.params.alpha = this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA
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
    const renderer = this._threeRenderer
    if (!renderer) return
    const params = this.getPpvStreamParams()
    if (!params) return
    const design = this.dataset?.design || {}
    const rockParams = this.dataset?.event?.rockParams || {}
    renderer.setFieldPhysics?.({
      chargeKg: params.chargeKg,
      k: this._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      beta: Number(rockParams.attenuationP) || this.dataset?.event?.beta || 0.02,
      visualCp: VISUAL_CP,
      // 瞬时场显示时变衰减（薄亮环推进，看得见波前传播）；峰值判据另用 β+uPpvVisualBeta
      displayDecay: DISPLAY_DECAY,
      // 峰值判据的视觉衰减项（与显示衰减解耦，见文件头常量注释）
      ppvVisualBeta: PEAK_VISUAL_BETA,
      rho: Number(design.rockDensity) || 2650,
      cp: Number(rockParams.pWaveSpeed) || 4500,
      // 泊松比：Number(undefined)=NaN，`??` 拦不住 NaN（会让 applyFieldPhysics 的
      // isFinite 门控跳过 uStressFactor 下发 → 应力色阶用占位默认值）——显式判有限值
      nu: Number.isFinite(Number(design.poissonRatio))
        ? Number(design.poissonRatio)
        : Number.isFinite(Number(rockParams.poissonRatio))
          ? Number(rockParams.poissonRatio)
          : 0.25,
      // 爆心（掏槽孔质心）：解析外推波前以该点为源，与场盒内纹理数据一致
      origin: this._computeBlastOrigin(),
      // 多装药源（各炮孔装药段）：驱动岩面非同心圆干涉波场；null 时着色器退化为单源
      sources: this._computeBlastSources(),
      // 波包子波载波频率（Hz，0=纯包络）：控制热力图干涉条纹的疏密
      carrierHz: this._vibCarrierHz ?? 0,
      // 波前起跳沿(s)：0.25（与新版一致）。原为 0（直角阶跃）——每个爆源在岩面留下
      // 一条 1px 硬边波前环，多源叠加后表现为"岩体四周的平行细线"，拖动时间轴时
      // 各源波前同时在场、线条还会增多。平滑起跳沿消除该伪影。
      // （原注释担心"线性映射下缓升会把色阶显形成条纹"——现已改对数标尺 +
      //  连续 LUT 采样，该顾虑不成立。）
      arrivalRise: this._vibArrivalRise ?? 0.12,
      // 掌子面自由面反射（镜象源法，负号镜像）：反射面 = 掌子面轴向位置（grid 局部系）
      faceZ: Number(renderer?.faceOffset) || 3,
      // 掌子面自由面反射（镜象源法，负号镜像）：默认关（本版本原始行为无镜象源）。
      // 开它会给每个源再加一条"镜像到达沿"，在色阶上增加可见结构。
      reflectOn: this._vibReflectOn ?? false,
      reflectCoeff: this._vibReflectCoeff ?? 0.85
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
      this._threeRenderer?.clearVibrationParticles?.()
      this._particleEmitState = { emittedUntil: -1, lastT: -1 }
    }
  }

  /**
   * 计算岩体网格在**场盒局部坐标系**下的实际包围盒（显示域 = 全岩体的权威依据）
   *
   * 岩体模型的横向/竖向范围比"隧道断面×系数"更大（岩体是断面外扩的实体），
   * 用隧道尺寸推算的网格边界会把热力图裁在岩体内部。这里直接用
   * renderer.getSurfaceSampleGrid()（岩面顶点的 grid 局部坐标，与场纹理同一
   * 坐标系/轴向定义）的逐轴 min/max + 0.5m 外扩作为场计算域，保证着色器
   * insideFieldBounds 门控覆盖全部岩面。
   *
   * @returns {{boundsMin:number[], boundsMax:number[]}|null} 场盒局部坐标包围盒；
   *          岩体几何尚不可用时返回 null（调用方回退到隧道推算域）
   */
  _getRockFieldBounds() {
    const surface = this._threeRenderer?.getSurfaceSampleGrid?.()
    if (!surface?.positions || surface.positions.length < 9) return null
    const p = surface.positions
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i]
      if (p[i] > maxX) maxX = p[i]
      if (p[i + 1] < minY) minY = p[i + 1]
      if (p[i + 1] > maxY) maxY = p[i + 1]
      if (p[i + 2] < minZ) minZ = p[i + 2]
      if (p[i + 2] > maxZ) maxZ = p[i + 2]
    }
    const pad = 0.5
    const boundsMin = [minX - pad, minY - pad, minZ - pad]
    const boundsMax = [maxX + pad, maxY + pad, maxZ + pad]
    // 防御：岩面退化（零体积）或坐标异常时放弃
    for (let a = 0; a < 3; a++) {
      if (!Number.isFinite(boundsMin[a]) || !Number.isFinite(boundsMax[a])) return null
      if (boundsMax[a] - boundsMin[a] < 0.5) return null
    }
    return { boundsMin, boundsMax }
  }

  /**
   * 计算当前事件的爆破振动安全允许距离（影响范围，m）——文献/GB6722 口径：
   * R0 = (K/V0)^(1/α)·Q0^(1/3)，Q0 取全断面最大装药量（昆阳文献：井巷狭小空间
   * 分段微差冲击波叠加，取总装药量），V0 为保护对象安全允许振速
   * （矿山巷道 20 / 边坡 10 cm/s，见 vibrationColorScales.INFLUENCE_V0_CMPS）。
   * 昆阳事件复算：巷道 11.40m（2.43×D）、边坡 17.67m（3.76×D），与文献一致。
   * 注意：这是"保护对象振动安全"范围，与损伤分区（Bauer-Calder 岩体损伤圈）
   * 是两个不同的物理量，面板中分开展示。
   * @returns {{tunnel:number,slope:number,v0Tunnel:number,v0Slope:number,q0:number}|null}
   */
  _computeInfluenceRanges() {
    const params = this.getPpvStreamParams()
    if (!params) return null
    const K = this._sadoskyK ?? SADOVSKY_DEFAULT_K
    const alpha = this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA
    const Q0 = Number(params.chargeKg) || 0
    if (!(Q0 > 0)) return null
    return {
      tunnel: safetyInfluenceRangeM({ K, alpha, Q0, v0: INFLUENCE_V0_CMPS.tunnel }),
      slope: safetyInfluenceRangeM({ K, alpha, Q0, v0: INFLUENCE_V0_CMPS.slope }),
      v0Tunnel: INFLUENCE_V0_CMPS.tunnel,
      v0Slope: INFLUENCE_V0_CMPS.slope,
      q0: Q0
    }
  }

  /**
   * 懒创建本地振动场模拟器与粒子系统（基于当前 dataset 参数）
   */
  _ensureLocalVibrationSim() {
    if (this._localVibrationSim) return this._localVibrationSim
    const params = this.getPpvStreamParams()
    if (!params) return null
    // 基础域完整覆盖隧道断面；再按 25 cm/s 最低损伤阈值估算透明缓冲，
    // 防止有效损伤档碰到矩形采样盒边界后被硬裁成方形。体素总数限制在 60k。
    const renderer = this._threeRenderer
    const tsec = renderer?.tunnelSection
    const W = Math.max(1, Number(tsec?.width) || params.tunnelWidth)
    const totalH = Math.max(1, Number(renderer?.tunnelHeight) || params.tunnelHeight)
    const floorY = renderer?.center?.y ?? 0
    const depthZ = 40
    const origin = this._computeBlastOrigin()
    const sources = this._computeBlastSources() || []
    const damageGrid = estimateDamageAwareGrid({
      boundsMin: [-W / 2, floorY, 0],
      boundsMax: [W / 2, floorY + totalH, depthZ],
      gridShape: [24, 32, 48],
      chargeKg: params.chargeKg,
      origin,
      sources,
      K: params.k,
      alpha: params.alpha,
      paddingMeters: 1.5,
      maxVoxels: 60000
    })
    const sim = new LocalVibrationSimulator({
      chargeKg: params.chargeKg,
      K: params.k,
      alpha: params.alpha,
      tunnelWidth: W,
      tunnelHeight: totalH,
      lengthZ: depthZ,
      nx: damageGrid.gridShape[0],
      ny: damageGrid.gridShape[1],
      nz: damageGrid.gridShape[2],
      origin,
      sources: sources.length > 0 ? sources : null,
      boundsMin: damageGrid.boundsMin,
      boundsMax: damageGrid.boundsMax
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
    const renderer = this._threeRenderer
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
      // 清空插值缓冲：seek 后旧场已不适用，等待下一次全量重算重建双缓冲
      this._fieldPrev = null
      this._fieldCur = null
      this._vibFieldLastUpdate = -1 // 强制下一段立即按目标时刻重算
    }
    this._vibLastStepT = t

    if (t < blastTriggerTime) {
      if (this._particleEmitState.emittedUntil >= 0) {
        // 回到起爆前（循环回卷）：清空粒子
        renderer.clearVibrationParticles?.()
        this._particleEmitState = { emittedUntil: -1, lastT: -1 }
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

    // 逐帧时间插值：即使本轮 throttle 未放行（不触发全量重算），也先在相邻两帧
    // 精确场之间按当前 t 线性混合写纹理，让波前平滑滑移而非 0.2s 一跳到变。
    this._applyVibrationInterpolation(t, frame, renderer)

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
    // 动态满量程：瞬时场（随 t 变化）→ 每个 tick 按当前场值分布反解热力图缩放系数。
    this._updateFieldAutoScale(renderer, t)
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
   * @param {Int8Array} zones - 损伤分区 id（-1=未分类，0~4=档位）
   * @param {number} t - 模拟时间(s)
   * @param {number} frame - 帧序号
   * @param {object} renderer - three.js 渲染器
   */
  _applyVibrationFields(ppv, sigmaVm, zones, t, frame, renderer) {
    if (!renderer) return
    // 双缓冲记录：为逐帧时间插值保留最近两帧精确场（t 递增时 prev→cur→新cur）
    if (ppv) {
      this._fieldPrev = this._fieldCur
      this._fieldCur = { t, ppv, sigmaVm }
    }
    // PPV 场：仅在本地模拟模式（WS 不可用）下更新。
    // WS 模式下 PPV 由后端实时帧推送，避免本地与 WS 数据交替写入造成闪烁。
    if (this._localVibrationEnabled) {
      renderer.updateVibrationField?.(ppv, t, frame)
    }
    // 应力场与损伤场：本地兜底更新，但 WS 帧新鲜（2s 内）时让位。
    // 本地模拟用 visualCp≈35m/s（可视波前），WS 用 cp=4500m/s（物理波前），
    // 两数据源交替写同一纹理会导致云图闪烁/回跳，故以 WS 优先、本地兜底。
    const nowMs = performance.now()
    if (nowMs - (this._lastWsStressMs || 0) > WS_STALE_MS) {
      renderer.updateStressField?.(sigmaVm, t, frame)
    }
    if (nowMs - (this._lastWsDamageMs || 0) > WS_STALE_MS) {
      renderer.updateDamageField?.(zones, t, frame, 'centers')
    }
  }

  /**
   * 逐帧时间插值写热力图纹理（消除 throttle 跳变导致的闪烁）。
   *
   * 全量重算被 throttle 到 0.2s（+墙钟 120ms），若不在间隔内侧显示会"旧场停留→猛跳"。
   * 这里用最近两帧精确场（_fieldPrev / _fieldCur）在当前模拟时间 t 上做线性混合后
   * 写 PPV/应力纹理，使显示平滑跟随 t；损伤为离散档位不插值，由最新精确帧直接写入。
   * 仅本地模式生效（WS 帧本就逐帧推送）；t 落在窗口外时直接用最新场，不再重复上传。
   * @param {number} t - 当前模拟时间(s)
   * @param {number} frame - 帧序号
   * @param {object} renderer - three.js 渲染器
   */
  _applyVibrationInterpolation(t, frame, renderer) {
    if (!this._localVibrationEnabled || !renderer) return
    const prev = this._fieldPrev
    const cur = this._fieldCur
    if (!prev || !cur || prev.t >= cur.t) return
    if (t < prev.t || t > cur.t) return // 窗口外：显示最新场即可（已写入），无需重复上传

    const count = cur.ppv.length
    if (prev.ppv.length !== count || !prev.sigmaVm || !cur.sigmaVm) return
    if (prev.sigmaVm.length !== cur.sigmaVm.length) return

    if (!this._vibLerpBuf) this._vibLerpBuf = { ppv: null, sigma: null }
    if (!this._vibLerpBuf.ppv || this._vibLerpBuf.ppv.length !== count)
      this._vibLerpBuf.ppv = new Float32Array(count)
    if (!this._vibLerpBuf.sigma || this._vibLerpBuf.sigma.length !== cur.sigmaVm.length)
      this._vibLerpBuf.sigma = new Float32Array(cur.sigmaVm.length)

    const frac = (t - prev.t) / (cur.t - prev.t)
    const p0 = prev.ppv
    const p1 = cur.ppv
    const s0 = prev.sigmaVm
    const s1 = cur.sigmaVm
    const ppvBuf = this._vibLerpBuf.ppv
    const sigBuf = this._vibLerpBuf.sigma
    for (let i = 0; i < count; i++) {
      ppvBuf[i] = p0[i] + (p1[i] - p0[i]) * frac
      sigBuf[i] = s0[i] + (s1[i] - s0[i]) * frac
    }

    renderer.updateVibrationField?.(ppvBuf, t, frame)
    const nowMs = performance.now()
    if (nowMs - (this._lastWsStressMs || 0) > WS_STALE_MS) {
      renderer.updateStressField?.(sigBuf, t, frame)
    }
  }

  /**
   * 设置 three.js 渲染图层可见性（烟雾/碎石/隧道/钻孔/标注等）
   * @param {string} layer - 图层名
   * @param {boolean} visible
   */
  setLayerVisible(layer, visible) {
    const renderer = this._threeRenderer
    renderer?.setLayerVisible?.(layer, visible)
  }

  /** 批量设置图层可见性 */
  setLayersVisible(map = {}) {
    const renderer = this._threeRenderer
    renderer?.setLayersVisible?.(map)
  }

  /**
   * 运行时更新隧道断面与掏槽形式（UI 编辑入口）
   * 更新断面参数 + designParams.cutPattern，下次 buildScene 时生效
   * @param {Object} payload - { width, wallHeight, archRadius, shape, cutPattern }
   */
  updateSection(payload) {
    const renderer = this._threeRenderer
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
    const renderer = this._threeRenderer
    return renderer?.getLayerVisibility?.() || null
  }

  // ─── 爆堆轮廓（三维包络 + 安息角标注）────────────────────

  /** 开启/关闭爆堆轮廓渲染 */
  setMuckPileOutlineEnabled(enabled) {
    const renderer = this._threeRenderer
    renderer?.setMuckPileOutlineEnabled?.(enabled)
  }

  /** 当前爆堆轮廓是否可见 */
  getMuckPileOutlineEnabled() {
    const renderer = this._threeRenderer
    return !!renderer?.getMuckPileOutlineEnabled?.()
  }

  /** 爆堆测量值（安息角/堆高/堆宽/堆长） */
  getMuckPileMeasure() {
    const renderer = this._threeRenderer
    return renderer?.getMuckPileMeasure?.() ?? null
  }

  /**
   * 获取爆破设计数据（炮孔布置、统计、装药参数等）
   * @returns {Object|null}
   */
  getBlastDesign() {
    const renderer = this._threeRenderer
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
