import * as Cesium from 'cesium'
import { CesiumThreeBridge } from './core/rendering/cesiumThreeBridge.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'
import {
  VibrationComputeClient,
  computePpvDecayProfile
} from './core/computation/localVibrationSimulator.js'
import {
  DEFAULT_TUNNEL_WIDTH,
  DEFAULT_TUNNEL_WALL_HEIGHT,
  DEFAULT_TUNNEL_ARCH_RADIUS,
  DEFAULT_FRAGMENT_RENDER_LIMIT,
  calcTunnelArea
} from './core/blastDefaults.js'
import { SADOVSKY_DEFAULT_K, SADOVSKY_DEFAULT_ALPHA } from './core/vibrationDefaults.js'
import { LiteratureDesignService } from './blasting/literatureDesign.js'
import { UndergroundViewController } from './blasting/undergroundView.js'
import { BlastSourceResolver } from './blasting/blastSources.js'
import { LocalVibrationOrchestrator } from './blasting/localVibrationOrchestrator.js'
import { VibrationFieldDomain } from './blasting/vibrationFieldDomain.js'

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

// ─── 组合域对象（职责拆分，见 services/blasting/）────────────────────
// BlastingManager 保留为门面：公共 API 逐个保留（一行委托），具体职责由域对象承担——
//   · LiteratureDesignService   文献设计盖章域（blasting/literatureDesign.js）
//   · UndergroundViewController 地下视角/相机域（blasting/undergroundView.js）
//   · BlastSourceResolver       爆源解析域（blasting/blastSources.js）
//   · LocalVibrationOrchestrator 本地振动场编排域（blasting/localVibrationOrchestrator.js）
//   · VibrationFieldDomain      场量程/等值线域（blasting/vibrationFieldDomain.js）
// 域对象懒创建并缓存在实例字段上（不占原型成员）：兼容测试用
// Object.create(BlastingManager.prototype) 裸实例（不运行构造函数），首次委托时才创建；
// 域对象经 this.m 反向访问门面共享状态，域间互不引用。
function domainOf(mgr, slot, Ctor) {
  return mgr[slot] || (mgr[slot] = new Ctor(mgr))
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
    // 地下视角状态（_undergroundSavedState/_undergroundActive）已迁至
    // UndergroundViewController（services/blasting/undergroundView.js）

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
    // _vibInfluenceRadius = 波场可达半径：由岩体几何尺度自动取（见 setInfluenceRadiusAuto），
    // 使波一直衰减到模型边界、不在岩体中部形成能量断崖。默认给一个足够大的占位值。
    this._vibInfluenceRadius = 60
    // 振动场计算 Web Worker 客户端：把多源矢量叠加的 PPV/应力/损伤场计算卸载到
    // Worker 线程，避免主线程因"网格点数×源数×幂/指数"计算卡死爆破动画。
    this._vibComputeClient = new VibrationComputeClient()
    this._vibComputeReqId = 0
    this._vibComputeReqInFlight = false // 当前是否有一个计算请求在途（只允许一个）
    this._vibComputePending = null // 在途期间到达的最新目标 { t, frame }，完成后补算
    // 等值线提取管线（峰值场 MS 提取，与热力图 0.2s 节流计算解耦）：
    // 峰值场与 t 无关 → 一次性计算；仅在几何版本/显示模式/标尺/事件参数变化时重提取。
    this._contourBuiltFp = null // 已构建折线的指纹（null=待构建）
    this._contourConfiguredVersion = -1 // 已下发 Worker 的岩面顶点集版本
    this._contourInFlight = false // 等值线峰值场计算在途（coalesce 单在途）
    this._contourDirty = false // 在途期间指纹又变化 → 完成后补算
    this._contourStats = null // 最近一次提取诊断 stats（面板显示）
    this._contourDensity = 12 // 色带分档数（等值线条数 = density-1）
    // WS 应力/损伤帧最近到达时间（新鲜度检测：WS 帧新鲜时本地兜底让位，避免交替写入闪烁）
    this._lastWsStressMs = 0
    this._lastWsDamageMs = 0
    // 热力图双缓冲 + 时间插值：全量重算被 throttle 到 ~0.2s，但相邻两帧精确场之间
    // 按当前模拟时间在每一帧线性混合后写纹理，使显示平滑跟随 t（消除"旧场停留→猛跳"的闪烁）
    this._fieldPrev = null // { t, ppv, sigmaVm } —— 上一帧精确场
    this._fieldCur = null // { t, ppv, sigmaVm } —— 最近一帧精确场
    //（插值输出复用 scratch _vibLerpBuf 已随插值逻辑迁至 LocalVibrationOrchestrator）
    // 上次热力图重算的墙钟时刻（_vibLastUpdateWallMs）同样迁至 LocalVibrationOrchestrator
    // 动画总时长（秒）：优先取渲染器实测/回放时长（全部落地+保持3s），
    // 未就绪时回退数据集 simulationDurationS（默认 10s）。
    this._durationS = null
    // 事件一致性：默认严格使用 blasting_design_holes.delayMs，不额外叠加
    // 蒙特卡洛雷管误差。需要做概率敏感性分析时，UI/调用方可显式设置 >0。
    this._delayJitterMs = 0
    this._useLiteratureDesign = false
    this._rngSeed = 20240910
    // 监测点（测点波形）：3D 放置，存 {id,label,x,y,z}；时程在放置/雷管误差变更时重算
    this._monitorPoints = []
    this._monitorSeq = 1
    // 振动场矢量箭头（P1-6）：开关 + 每帧计算粗网格箭头（跟随播放时钟）
    this._vibVectorFieldOn = false
    // 掌子面自由面反射（P0-2 镜象源法）：默认开启
    this._vibReflectOn = true
    this._vibReflectCoeff = 0.85
    // 显示侧满量程展开因子（P99.9 反解）：默认 1（不缩放），值线峰值场到达后更新
    this._fieldAutoScale = 1
    // 半透明渲染（D）：1=热力场上限 0.55 露出岩底轮廓，0=实色 0.85
    this._vibTranslucent = false
    // 隧道轮廓自由面放大（P1 诚实化）：回退到中性 coeff=0（完全关闭）。
    // 用 SDF 系数放大隧道壁法向振速只是"贴纸式"视觉增强，并非真实自由面反射——
    // shader 分支 `if (uFaceBoostCoeff>0.001)` 下任何非零值都会把岩面乘上
    // 1+coeff·exp(-d/λ)（coeff=1 时隧道壁附近最高 ~2× 的几何放大），属"用视觉参数
    // 扭曲物理规律"。真实反射统一由 _vibReflectOn 的镜象源法承担（物理近似），
    // 此处恒 0 关闭，不做任何伪造轮廓放大。
    this._vibFaceBoostCoeff = 0
    // 轮廓放大空间衰减长度（m）：随 coeff 中性化，λ 仅保留默认值不再参与放大
    this._vibFaceBoostLambda = 0.7
    // 波包子波载波频率（Hz，0=关）：驱动热力图上"行波脉冲环/多源干涉瓣"。
    // 默认关闭（0=纯包络云图）：正面近距离/掠射角下，即使 2Hz 也会把多源
    // 相位叠加投影成规则斜纹。面板"波包频率"滑块仍可手动开启行波环。
    this._vibCarrierHz = 0
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
    // 等值线管线随场景作废：新事件新 Worker 未收 contourConfig，指纹/版本全部重置
    this._contourBuiltFp = null
    this._contourConfiguredVersion = -1
    this._contourInFlight = false
    this._contourDirty = false
    this._contourStats = null
    // 动画时长信号随场景重建作废（新事件重新观测/烘焙）
    this._durationS = null
    // 实测自愈量程随事件作废：旧事件的实测峰值与新事件岩性/装药无关，
    // 残留会把新事件色标满刻度顶得过高（整图偏暗）
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
    // 默认以 API 返回的 event/design/result 为唯一事实源。文献模板只能由调用方
    // 显式开启，不能再按 eventId/名称静默覆盖当前事件的断面、炮孔和延期。
    this._useLiteratureDesign = options.useLiteratureDesign === true
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
    return domainOf(this, '_literature', LiteratureDesignService).resolveLiteratureDesign()
  }

  /**
   * 将文献化隧道设计写回 dataset.design（CO 对应 002 南山 / 004 昆阳 及其余文献事件）。
   * 数据库种子对楔形/掏槽事件可能回退到通用菱形掏槽 + 通用断面，与文献不符，
   * 故在此统一覆盖，保证 3D 模型与 UI 全程读取同一套数据（断面/布孔/孔深/进尺一致）。
   */
  _stampLiteratureDesignIfNeeded() {
    domainOf(this, '_literature', LiteratureDesignService).stampLiteratureDesignIfNeeded()
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
    domainOf(this, '_undergroundView', UndergroundViewController).setCameraViewMode(mode)
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
    domainOf(this, '_undergroundView', UndergroundViewController).applyUndergroundViewIfNeeded()
  }

  /** 恢复地表视角的默认相机控制（关闭地下模式） */
  _restoreSurfaceView() {
    domainOf(this, '_undergroundView', UndergroundViewController).restoreSurfaceView()
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

    // 事件一致性：默认只使用 API 返回的当前 design.holes 与 design 断面。
    // 文献模板仅在 setDataset({ useLiteratureDesign: true }) 时显式启用。
    const lit = this._useLiteratureDesign ? this._resolveLiteratureDesign() : { design: null }
    let effSection = {
      width: Number(design?.tunnelWidth) || DEFAULT_TUNNEL_WIDTH,
      wallHeight: Number(design?.tunnelWallHeight) || DEFAULT_TUNNEL_WALL_HEIGHT,
      archRadius: Number(design?.tunnelArchRadius) || DEFAULT_TUNNEL_ARCH_RADIUS,
      shape: design?.tunnelShape || 'horseshoe'
    }
    let effHoles = holes
    if (lit.design) {
      effSection = lit.design.section
      effHoles = lit.design.holes
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
    domainOf(this, '_undergroundView', UndergroundViewController).jumpToCameraView()
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
    // 岩体几何实测的"波场可达半径"回传（本地模拟器/后端包络都取同一值，
    // 保证波一路衰减到模型边界、不在岩体中部截断）
    renderer.onInfluenceRadiusMeasured = r => this.setInfluenceRadiusAuto(r)
    const rInf = renderer?.getInfluenceRadius?.()
    if (Number(rInf) > 0) this.setInfluenceRadiusAuto(Number(rInf))
    // 自动量程：场初始化后立即下发萨道夫斯基物理与代表性峰值，避免 setBenchFieldData
    // 用固定上限(0.15 m/s)覆盖、导致解析场全场饱和成单一品红
    this._pushFieldPhysics()
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
    this._vibGridShape = cfg.gridShape
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
    domainOf(this, '_vibration', LocalVibrationOrchestrator).syncSimGrid(cfg)
  }

  /**
   * 更新 PPV 场数据（每个二进制帧调用）
   * @param {Float32Array} ppv
   * @param {number} t
   * @param {number} frame
   */

  /**
   * 【工业平滑】场数据的 3 点可分离高斯平滑（σ≈0.5 格，各向一次）。
   *
   * 离散色阶把"档间边界"变成硬边：粗网格（后端 1.5m）三线性插值的逐格抖动
   * 会让边界呈锯齿/莫尔条纹，叠加 14 档量化后表现为大面积颗粒感/噪点
   * （用户实测：瞬时振速图放射状细纹、应力图整图颗粒）。
   * 渲染前一次轻量平滑可消除网格级噪声；波前与干涉主瓣（波长约 4m ≫ 1.5m
   * 网格）不受影响。axis 顺序按 [nx,ny,nz] 逐维处理，对任意布局均为对称模糊。
   * @param {Float32Array} arr - 场数据（原地不影响入参，返回新数组）
   * @param {number[]} shape - [nx,ny,nz]
   */
  _smoothField3d(arr, shape, passes = 2) {
    if (!(arr && arr.length) || !shape || shape.length < 3) return arr
    const nx = shape[0] | 0
    const ny = shape[1] | 0
    const nz = shape[2] | 0
    if (nx < 3 || ny < 3 || nz < 3 || nx * ny * nz !== arr.length) return arr
    const w0 = 0.25
    const w1 = 0.5
    // 【非原地】入参可能是本地模拟器复用缓冲（_ppvBuf）或插值双缓冲，
    // 原地写会逐帧累积模糊/污染插值 → 返回新数组。
    let src = Float32Array.from(arr)
    let dst = new Float32Array(arr.length)
    const zn = nx * ny
    const rounds = Math.max(1, passes | 0)
    for (let p = 0; p < rounds; p++) {
      // x 方向（步长 1）
      for (let i = 0; i < src.length; i++) {
        const x = i % nx
        const base = i - x
        dst[i] =
          w0 * src[base + Math.max(0, x - 1)] +
          w1 * src[i] +
          w0 * src[base + Math.min(nx - 1, x + 1)]
      }
      // y 方向（步长 nx）
      for (let i = 0; i < src.length; i++) {
        const y = ((i / nx) | 0) % ny
        const base = i - y * nx
        src[i] =
          w0 * dst[base + Math.max(0, y - 1) * nx] +
          w1 * dst[i] +
          w0 * dst[base + Math.min(ny - 1, y + 1) * nx]
      }
      // z 方向（步长 nx*ny）
      for (let i = 0; i < src.length; i++) {
        const z = (i / zn) | 0
        const base = i - z * zn
        dst[i] =
          w0 * src[base + Math.max(0, z - 1) * zn] +
          w1 * src[i] +
          w0 * src[base + Math.min(nz - 1, z + 1) * zn]
      }
      if (p < rounds - 1) {
        const t = src
        src = dst
        dst = t
      }
    }
    return dst
  }

  /**
   * 【本地兜底路径的空腔掩码】与后端 blast_physics.tunnel_void_mask 同口径：
   * 已开挖空腔（掌子面后方、|x|≤W/2 且 |y|≤H/2）内无岩体 → 场值置 0。
   * WS 主路径由后端掩码；本地模拟器缺这一步会导致波场"穿透"隧道轮廓。
   * @param {Float32Array} arr - 本地模拟场（与 sim.gridXyz 同序）
   * @param {Float32Array} gridXyz - 本地模拟网格坐标 (N×3)
   */
  _applyLocalVoidMask(arr, gridXyz) {
    if (!(arr && arr.length) || !gridXyz || gridXyz.length !== arr.length * 3) return arr
    const sim = this._localVibrationSim
    const origin = sim?.params?.origin
    const oz = origin ? Number(origin[2]) || 0 : 0
    const hw = Math.max(0.5, (Number(sim?.tunnelWidth) || 18) / 2)
    const hh = Math.max(0.5, (Number(sim?.tunnelHeight) || 15) / 2)
    for (let i = 0; i < arr.length; i++) {
      const x = gridXyz[i * 3]
      const y = gridXyz[i * 3 + 1]
      const z = gridXyz[i * 3 + 2]
      if (Math.abs(x) <= hw && Math.abs(y) <= hh && z < oz) arr[i] = 0
    }
    return arr
  }

  updateVibrationField(ppv, t, frame) {
    // 【PPV 固定量程】用户取证:Python 显示 rRef=117cm/s 已能拉出黄绿梯度;
    // 直接固定 uMaxPPV = 120cm/s,不再做任何自适应(旧 2×P50 EMA 把满刻度
    // 拉得极低,100%近场顶死在最高档 → 全红;用户已明确要求废止)。
    const renderer = this._threeRenderer
    renderer?.updateVibrationField?.(this._smoothField3d(ppv, this._vibGridShape), t, frame)
    this._liveRefs ??= {}
    const target = 1.2 // 120 cm/s = 1.20 m/s
    const prev = this._lastFieldRefs?.ppvRefMps ?? 0
    if (Math.abs(prev - target) / (target + 1e-6) > 0.01) {
      this._lastFieldRefs = { ...(this._lastFieldRefs || {}), ppvRefMps: target }
      renderer.setFieldPhysics?.({ ppvRefMps: target })
    }
  }

  /**
   * 【Seek 清屏】清空三张场纹理 + 本地插值缓冲。
   * 拖动进度条时调用：GPU 纹理里驻留的旧帧数据（峰值/损伤是"未来帧最大值"）
   * 会在新帧落地前被着色器读到，表现为"拖动后糊成色块"。清零后等价于
   * "Seek 期间阻塞着色器读取旧数据"，直到目标帧切片到达。
   */
  clearVibrationFieldTextures() {
    this._threeRenderer?.clearFieldTextures?.()
    this._fieldPrev = null
    this._fieldCur = null
    this._vibFieldLastUpdate = -1
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
   * @param {Int8Array} zones - 分区 id 数组（0~4）
   * @param {number} t
   * @param {number} frame
   */
  updateDamageField(zones, t, frame) {
    this._lastWsDamageMs = performance.now()
    const renderer = this._threeRenderer
    renderer?.updateDamageField?.(zones, t, frame)
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

  /** 开关振动场等力线（等值线）叠加显示 */
  setIsoLineEnabled(enabled) {
    this._threeRenderer?.setIsoLine?.(!!enabled)
  }

  /** 设置等值线样式（线宽 px / 统一颜色；color 省略=保持，null=恢复级别取色） */
  setIsoLineStyle({ width, color } = {}) {
    this._threeRenderer?.setIsoLineStyle?.({ width, color })
  }

  /** 开关振动场矢量箭头（P1-6：波传播方向可视化） */
  setVibrationVectorField(on) {
    this._vibVectorFieldOn = !!on
    this._pushVectorFieldNow(false)
  }

  /** 设置半透明渲染（1=热力场上限 0.55 露出岩底，0=实色 0.85） */
  setVibrationTranslucent(on) {
    this._vibTranslucent = !!on
    this._threeRenderer?.setFieldTranslucent?.(this._vibTranslucent)
  }

  /** 主动触发一次等值线构建（场景就绪/切换模式后调用，不依赖播放推进） */
  refreshContours() {
    const renderer = this._threeRenderer
    if (renderer) this._ensureContourPipeline(renderer)
  }

  /**
   * 计算单个局部点的三分量全时程（Vx/Vy/Vz/Vmag + PPV）。
   * 供"场点拾取 → 弹出时程曲线"使用：点击任意点即可看到该点振动波形。
   * @param {number[]} local - 岩体局部坐标 [x,y,z]
   * @returns {Object|null} 同 computeMonitorTimeHistory 输出
   */
  samplePointHistory(local) {
    return domainOf(this, '_vibration', LocalVibrationOrchestrator).samplePointHistory(local)
  }

  /**
   * 计算并下发矢量箭头场（P1-6）。采样平面 = 过爆心的水平切片(y=originY) +
   * 竖直切片(x=originX)，仅取岩体侧 (z ≥ 掌子面)；每点按当前模拟时刻 t 计算
   * 瞬时质点速度矢量（与热图同一物理模型：多源矢量叠加 + 自由面反射）。
   * 箭头随播放向前推进/摆动，直观展示波的传播方向。
   * @param {boolean} [force=true] - true=即便未开启也强制按当前几何重算并下发
   */
  _pushVectorFieldNow(force = true) {
    domainOf(this, '_vibration', LocalVibrationOrchestrator).pushVectorFieldNow(force)
  }

  /**
   * 获取"仿真 PPV 衰减曲线 vs 萨道夫斯基公式"对比数据（P2-8 验证）。
   * 沿隧道轴向（爆心→岩体内部 +z）与横向（±x）各取一组采样点：
   * sim = 多源叠加全时程峰值，theory = K·(Q^(1/3)/R)^α。
   * @returns {Object|null} computePpvDecayProfile 输出（r/sim/theory/labels/totalQ/K/alpha）
   */
  getPpvDecayData() {
    const sources = this._computeBlastSources()
    if (!sources || !sources.length) return null
    const rockParams = this.dataset?.event?.rockParams || {}
    const origin = this._computeBlastOrigin()
    return computePpvDecayProfile(sources, {
      K: this._sadoskyK ?? SADOVSKY_DEFAULT_K,
      alpha: this._sadoskyAlpha ?? SADOVSKY_DEFAULT_ALPHA,
      visualCp: 35,
      visualBeta: 0.8,
      minStandoff: 0.5,
      reflections: this._vibReflectOn
        ? [{ axis: 'z', value: Number(origin?.[2]) || 0, coeff: this._vibReflectCoeff }]
        : null,
      directions: [
        { axis: 'z', count: 14, spacing: 2.0, base: origin },
        { axis: 'x', count: 8, spacing: 2.0, base: origin }
      ]
    })
  }

  /**
   * 设置热力图/等值线色彩映射标尺：0=线性，1=对数（适应幂律衰减）。
   * 标尺变化会改变等值线级别 → _ensureContourPipeline 指纹失配自动重提取。
   * @param {number} mode - 0|1
   */
  setVibrationNormMode(mode) {
    this._threeRenderer?.setNormMode?.(mode)
  }

  /**
   * 设置热力图波包载波频率（Hz，0=关）。
   *
   * 该值不参与峰值判据（损伤分区/等值线用的 peak 是包络，与载波无关），
   * 只改变岩面瞬时振速场的空间频率——即屏幕上干涉条纹的疏密：
   *   · λ = visualCp / f（visualCp 默认 35 m/s）；f=8 时 λ=4.4m（约 4~5px/条纹，
   *     且每帧相位推进 48°、4x 倍速下每帧跨 0.53 周期）= 观感为噪点/摩尔纹；
   *   · f=2 时 λ=17.5m，但正面近距离仍可能出现规则斜纹；
   *   · f=0 退化为纯包络（无行波环，最平滑，当前默认）。
   *
   * 经 renderer.setFieldPhysics 下发：参数被渲染器缓存，场景重建后自动重放。
   * @param {number} hz - 0~10
   */
  setVibrationCarrierHz(hz) {
    const v = Math.max(0, Math.min(30, Number(hz) || 0))
    this._vibCarrierHz = v
    this._threeRenderer?.setFieldPhysics?.({ carrierHz: v })
  }

  /**
   * 设置等值线密度（色带分档数，条数 = density-1），变更后立即重提取。
   * @param {number} density - 4~24
   */
  setVibrationContourDensity(density) {
    const v = Math.max(4, Math.min(24, Math.round(Number(density) || 12)))
    if (v === this._contourDensity) return
    this._contourDensity = v
    this._contourBuiltFp = null // 强制重提取
  }

  /** 最近一次等值线提取诊断 stats（{segments, loops, openChains, loopsFiltered, chainsFiltered, totalPoints, extractMs}） */
  getVibrationContourStats() {
    return this._contourStats
  }

  /** 当前是否已有可渲染的振动场 */
  hasVibrationField() {
    const renderer = this._threeRenderer
    return !!renderer?.hasVibrationField?.()
  }

  /** 关闭"场点拾取" */
  disablePpvPick() {
    const renderer = this._threeRenderer
    renderer?.disablePointPick?.()
  }

  /** 振动场元信息（grid/时间/帧） */
  getVibrationFieldInfo() {
    const renderer = this._threeRenderer
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
    return domainOf(this, '_blastSources', BlastSourceResolver).computeBlastOrigin()
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
    return domainOf(this, '_blastSources', BlastSourceResolver).computeBlastSources()
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
    const origin = this._computeBlastOrigin()
    const renderer = this._threeRenderer
    const faceOffset = Number(renderer?.faceOffset ?? design.faceOffset)
    const backendOrigin = [
      origin[0],
      origin[1],
      origin[2] - (Number.isFinite(faceOffset) ? faceOffset : 3)
    ]
    return {
      chargeKg: Number(event.chargeKg) || 100,
      // backend build_ppv_grid 以当前掌子面为 z=0；GPU/本地 g 系仍保留 faceOffset。
      blastCenter: backendOrigin,
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
  }

  /**
   * 获取发送给后端 WS 的多源装药位置。
   *
   * 前端 GPU/本地模拟使用 g 系：掌子面 z=faceOffset；后端网格把当前
   * 掌子面归一为 z=0。必须只在边界处做一次平移，否则后端源会整体向
   * 岩体深处错位，甚至退化为 blastCenter 单源。
   * @returns {Array|null} [{x,y,z,chargeKg,delayMs,id}]，z 为后端面内坐标
   */
  getStreamBlastSources() {
    const sources = this._computeBlastSources()
    if (!Array.isArray(sources) || sources.length === 0) return null
    const renderer = this._threeRenderer
    const design = this.dataset?.design || {}
    const faceOffset = Number(renderer?.faceOffset ?? design.faceOffset)
    const faceZ = Number.isFinite(faceOffset) ? faceOffset : 3
    return sources.map(s => ({
      ...s,
      z: Number(s.z) - faceZ
    }))
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
   * 设置波场可达半径（保留接口）：influenceRadius 由 setInfluenceRadiusAuto 按岩体
   * 几何尺度一次性确定；此处仅同步到本地模拟器。损伤半径不再受人工上限约束——
   * 由纯物理的 PPV 阈值分区计算得出（见 computeMultiSourcePeakDamageZones）。
   * @param {Object} p - { influenceRadius?: number(m) }
   */
  setDamageBoundary({ influenceRadius } = {}) {
    if (Number.isFinite(Number(influenceRadius)) && Number(influenceRadius) > 0)
      this._vibInfluenceRadius = Number(influenceRadius)
    // 同步本地模拟器（暂停/推流结束后接管热力图的数据源）：门控参数原地更新并
    // 失效逐帧缓存。峰值/等值线缓存按门控指纹自动失效；Worker 按签名变化重配。
    const sim = this._localVibrationSim
    if (sim?.params) {
      sim.params.influenceRadius = this._vibInfluenceRadius
      sim._lastT = -1
      sim._cachedPpv = null
      sim._cachedSigmaVm = null
      this._vibFieldLastUpdate = -1
    }
    // 立即同步到岩体面场着色，并写入 getPpvStreamParams 供 WS start 透传
    this._pushFieldPhysics()
  }

  /**
   * 按岩体几何自动确定"波场可达半径"（= 爆心到岩体几何最远顶点的距离）。
   * 语义：波在岩体内按幂律连续衰减，走到该半径时已到模型几何边界 → 零值消失。
   * 一阶解析模型不含反射/衍射，故不会产生回波（满足"到边界就消失、不反弹"）。
   * @param {number} radius - 半径(m)，由渲染侧按岩体包围盒实测传入
   */
  setInfluenceRadiusAuto(radius) {
    const r = Number(radius)
    if (!(r > 0)) return
    if (Math.abs(r - this._vibInfluenceRadius) < 0.5) return
    this._vibInfluenceRadius = r
    const sim = this._localVibrationSim
    if (sim?.params) {
      sim.params.influenceRadius = r
      sim._lastT = -1
      sim._cachedPpv = null
      sim._cachedSigmaVm = null
      this._vibFieldLastUpdate = -1
    }
    this._pushFieldPhysics()
  }

  /**
   * 当前损伤边界（供 buildWsStartPayload 透传到后端 start 指令）。
   * 损伤半径由 PPV 阈值纯物理计算，不再下发人工硬上限。
   * @returns {Object} { influenceRadius:number }
   */
  getDamageBoundary() {
    return { influenceRadius: this._vibInfluenceRadius }
  }

  /**
   * 掌子面自由面反射配置（镜象源法）——仅供后端 WS 推流展开镜象源使用
   * （buildWsStartPayload 下发）。后端网格（build_ppv_grid / tunnel_void_mask）
   * 以掌子面为 z=0 平面 → 反射面 value 恒为 0。GPU 岩面着色器的反射面由
   * _pushFieldPhysics 以 g 系 faceOffset 单独下发（applyFieldPhysics.faceZ），
   * 两者物理口径一致、坐标系各自正确。
   * 反射关闭时返回 null（后端不加反射）。
   */
  getVibrationReflections() {
    if (!this._vibReflectOn) return null
    return { axis: 'z', value: 0, coeff: this._vibReflectCoeff }
  }

  /**
   * 将当前事件的爆源/场地物理参数下发到岩体面场着色材质，
   * 驱动"场盒外解析外推"（萨道夫斯基波前）用与场盒内纹理同一物理曲线渲染，
   * 使 PPV 传播过程在整个岩体外围连续可见、边界无缝衔接。
   * 仅传入可解析字段，缺省项保留 SceneBuilder 内置默认，不会覆盖为无效值。
   */
  _pushFieldPhysics() {
    domainOf(this, '_vibration', LocalVibrationOrchestrator).pushFieldPhysics()
  }

  /**
   * 自动量程：确定色标满刻度，使每个片元按其真实计算震速映射到有区分度的色域。
   * 满刻度 = 解析场在"距源代表可视距离 rRef"处的真实计算震速。
   *
   * 说明：若用近场极值(0.5m处~3000cm/s)当满刻度，岩体上绝大多数点位震速远小于它，
   * 归一化后场值全落在 shader 的可见下限(<0.02)内 → 整片塌成浅波前色带，"看不出
   * 按数值对应色域"。取隧道内代表可视半径(rRef≈4m)处的真实值当满刻度，使岩体从
   * 近场(顶色)沿距离真实衰变到冷色(远段)，每个点位颜色=该点真实计算震速在色标中
   * 的对应色，梯度清晰、量程不再被极值压垮。
   * @returns {{ ppvRefMps:number, stressRefMPa:number }}
   */
  _computeAutoFieldRefs(params, sources, design, rockParams) {
    return domainOf(this, '_vibrationField', VibrationFieldDomain).computeAutoFieldRefs(
      params,
      sources,
      design,
      rockParams
    )
  }

  /** 自动量程的最近一次计算值（供 UI 图例实时显示当前满刻度） */
  getFieldRange() {
    return this._lastFieldRefs || null
  }

  /**
   * 波场可达半径 = 爆心 → 岩体几何最远顶点的距离（由渲染侧实测后回传）。
   * 波传播到模型几何边界即衰减殆尽、零值消失，不在岩体中部形成能量断崖。
   * @returns {number} 半径(m)
   */
  getInfluenceRadius() {
    return this._vibInfluenceRadius
  }

  /** 分位值（下采样 + 降序取第 (1-q) 分位；arr 为 Float32Array，O(N)） */
  _fieldQuantile(arr, q = 0.997) {
    return domainOf(this, '_vibrationField', VibrationFieldDomain).fieldQuantile(arr, q)
  }

  /**
   * 启动分位扫描（每帧调用，锁定后零开销直接返回）。
   * @param {'ppv'|'stress'} kind - ppv 数组单位 m/s；stress 数组单位 Pa
   */
  _fixFieldRefOnce(kind, arr) {
    domainOf(this, '_vibrationField', VibrationFieldDomain).fixFieldRefOnce(kind, arr)
  }

  /**
   * 解析展开基线（autoscale 回退）：应力满刻度锚在近场(0.5m)极值，而岩体绝大多数
   * 点位应力远小于它 → 全片塌成低端深蓝。这里以 PPV 惯例的代表可视半径 rRef=4m
   * 处的解析应力为"期望铺满色域"的满刻度，反解展开因子 S = stressRef/stressAt4。
   * PPV 满刻度本就锚在 4m 代表值 → S≈1 保持原样。待值线峰值场 P99.9 实测到达后
   * 由 _buildAndPushContours 动态精细化（真实分布更贴近现场形态）。
   * @returns {number} 1~80 的展开因子（1=不缩放）
   */
  _analyticAutoscale(params, sources, design, rockParams) {
    return domainOf(this, '_vibrationField', VibrationFieldDomain).analyticAutoscale(
      params,
      sources,
      design,
      rockParams
    )
  }

  enablePpvPick(handler, opts) {
    const renderer = this._threeRenderer
    return renderer?.enablePointPick?.(handler, opts) ?? null
  }

  /** 关闭"场点拾取" */

  setLocalVibrationEnabled(enabled) {
    domainOf(this, '_vibration', LocalVibrationOrchestrator).setEnabled(enabled)
  }

  /**
   * 懒创建本地振动场模拟器与粒子系统（基于当前 dataset 参数）
   */

  _ensureLocalVibrationSim() {
    return domainOf(this, '_vibration', LocalVibrationOrchestrator).ensureLocalVibrationSim()
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
    domainOf(this, '_vibration', LocalVibrationOrchestrator).step(time, frame)
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
    domainOf(this, '_vibration', LocalVibrationOrchestrator).dispatchCompute(t, frame, renderer)
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

  /**
   * 隧道马蹄形轮廓自由面放大配置（本地模拟器 tunnelFace 选项）。
   * 与 GPU 侧 uFaceBoostCoeff/uFaceBoostLambda/uTunnelFloorY/uTunnelArchH 同口径
   * （见 _pushFieldPhysics 与 localVibrationSimulator.tunnelFaceBoostFactor）：
   * coeff=0.85、λ=0.7（自由面近全反射的贴壁增强带），archH=直墙高。
   * @returns {{coeff:number, lambda:number, halfW:number, floorY:number, archH:number}|null}
   */
  _tunnelFaceConfig(renderer, width, floorY) {
    return domainOf(this, '_vibration', LocalVibrationOrchestrator).tunnelFaceConfig(
      renderer,
      width,
      floorY
    )
  }

  /**
   * 测点时程曲线计算参数（computeMonitorTimeHistory 的 options）。
   * 与体积场/热力图同一物理模型口径（K/α/视觉衰减/波速）。
   */
  _monitorParams(rockParams = {}) {
    return domainOf(this, '_vibration', LocalVibrationOrchestrator).monitorParams(rockParams)
  }

  /**
   * 重算已放置测点的时程曲线（K/α 等参数变更后调用）。
   * 当前版本未内置测点子系统 → 保留为扩展钩子（no-op）。
   */
  rebuildMonitorHistories() {
    /* 扩展钩子：接入测点子系统后在此重算各测点 Vx/Vy/Vz/|V| 时程 */
  }

  /**
   * 场景重建/参数变更后重挂已放置测点的 3D 标记（新 benchMesh 上）。
   * 当前版本未内置测点子系统 → 保留为扩展钩子（no-op）。
   */
  _syncMonitorMarkers() {
    /* 扩展钩子：接入测点子系统后在此重建标记 Object3D */
  }

  _applyVibrationFields(ppv, sigmaVm, zones, t, frame, renderer) {
    domainOf(this, '_vibration', LocalVibrationOrchestrator).applyFields(
      ppv,
      sigmaVm,
      zones,
      t,
      frame,
      renderer
    )
  }

  // ─── 等值线提取管线（峰值场 MS 提取 + Line2 渲染下发） ──

  /**
   * 确保等值线折线与当前场景/样式一致（每播放 tick 调用，内部指纹比对）。
   *
   * 峰值场与时间无关 → 每个事件/参数组合只算一次：
   *   ① 从 renderer 导出岩面顶点集（getContourSurface，版本缓存零重算）；
   *   ② Worker 计算顶点峰值场 + 到达时刻（contourConfig/computeContour 协议，
   *      Worker 内结果缓存，样式变化时秒回）；Worker 不可用回退主线程同步计算；
   *   ③ computeContourLevels 按当前显示模式/标尺反解级别 → extractContours
   *      （Marching Squares + 拓扑后处理）→ setContourPolylines 构建 Line2 渲染组。
   *
   * 重提取触发（指纹失配）：岩体几何版本（build/爆后切换/剖切）、显示模式、
   * 色彩标尺、等值线密度、sim 事件参数（K/α/装药/源数）。
   * 单在途 coalesce：在途期间指纹再变记 dirty，完成后补算最新（不堆积请求）。
   * @param {object} renderer - three.js 渲染器
   */
  _ensureContourPipeline(renderer) {
    domainOf(this, '_vibrationField', VibrationFieldDomain).ensureContourPipeline(renderer)
  }

  /**
   * 由顶点峰值场构建等值线折线并下发渲染器。
   * @param {Float32Array} peak - 每顶点峰值 PPV（m/s，含 occ×agn 整形）
   * @param {Float32Array} arrival - 每顶点最早波前到达时刻(s)
   * @param {object} surface - getContourSurface 导出（positions/normals/index）
   * @param {object} rp - getFieldRenderParams（displayMode/normMode/满刻度）
   * @param {object} renderer - three.js 渲染器
   */
  _buildAndPushContours(peak, arrival, surface, rp, renderer) {
    domainOf(this, '_vibrationField', VibrationFieldDomain).buildAndPushContours(
      peak,
      arrival,
      surface,
      rp,
      renderer
    )
  }

  /**
   * 峰值场 P99.9 分位数 → 显示展开因子 S∈[1,80]。
   * S = ref / (P99.9 × 1.12)：让 P99.9 映射到约 89% 满刻度（header room 防顶冲），
   * 使低值区（外围）从深蓝展开为青绿、高值区（中心）保持黄红。
   * @param {Float32Array|number[]} values 当前模式单位下的逐顶点峰值
   * @param {number} ref 同一单位的满刻度参考
   * @returns {number}
   */
  _p99Autoscale(values, ref) {
    return domainOf(this, '_vibration', LocalVibrationOrchestrator).p99Autoscale(values, ref)
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
    domainOf(this, '_vibration', LocalVibrationOrchestrator).applyInterpolation(t, frame, renderer)
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
