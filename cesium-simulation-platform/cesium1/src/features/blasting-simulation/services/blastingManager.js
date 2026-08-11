import * as Cesium from 'cesium'
import { CesiumThreeBridge } from './core/rendering/cesiumThreeBridge.js'

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
  const width = Math.max(2, Number(design.tunnelWidth) || 18)
  const wallHeight = Math.max(1, Number(design.tunnelWallHeight) || 6)
  const archRadius = Math.max(1, Number(design.tunnelArchRadius) || width / 2)

  if (shape === 'circular') {
    return Math.PI * archRadius * archRadius
  }
  if (shape === 'rectangular') {
    return width * wallHeight
  }
  return width * wallHeight + (Math.PI * archRadius * archRadius) / 2
}

function getAdvanceLength(design = {}) {
  const advance = Number(design.advanceLength)
  if (Number.isFinite(advance) && advance > 0) return advance
  const holeDepth = Math.max(0.5, Number(design.holeDepth) || 2.5)
  const utilization = Math.max(0.3, Math.min(1.0, Number(design.utilization) || 0.85))
  return holeDepth * utilization
}

function buildGenerationMetrics(dataset = {}) {
  const design = dataset.design || {}
  const result = dataset.result || {}
  const volumeRoundM3 = getSectionArea(design) * getAdvanceLength(design)
  return {
    volumeRoundM3,
    rockDensityKgM3: 2650,
    specificChargeKgM3:
      volumeRoundM3 > 0 ? Number(dataset.event?.chargeKg || 0) / volumeRoundM3 : null,
    throwDistanceTargetAvg:
      Number(result.throwDistanceAvg) || Number(design.expectedThrowDistance) || null,
    throwDistanceTargetMax: Number(result.throwDistanceMax) || null
  }
}

// 渲染参数（硬编码默认值；旧 blasting_render_config 表已删除）
// 仅保留 three.js 桥接所需开关
const DEFAULT_RENDER_CONFIG = {
  threeJsEnabled: true,
  threeJsParticleScale: 1.0
}

// 统一爆心位置开关：默认关闭，尊重 DB 中各事件的地理位置
// 设为 true 时，所有事件共用露天台阶爆破(BLAST-2026-001)的地理位置，
// 使切换事件时相机不跳转、各事件模型在同一位置渲染（仅渲染当前选中事件）
const UNIFY_BLAST_CENTER = false
const UNIFIED_BLAST_CENTER = {
  lon: 116.3915,
  lat: 39.9015,
  height: 0
}

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

    this.centerEntity = null
    this.dataset = null
    this.currentFrame = 0
  }

  /**
   * 装载数据集并初始化爆破场景
   * 新数据集结构：{ event, design, result }
   * @param {Object} dataset
   */
  setDataset(dataset) {
    this.clearScene()
    this.dataset = dataset
    // 统一爆心位置：仅当 UNIFY_BLAST_CENTER=true 时覆盖 DB 坐标（默认关闭，尊重 DB）
    if (UNIFY_BLAST_CENTER && this.dataset?.event) {
      this.dataset.event.centerLon = UNIFIED_BLAST_CENTER.lon
      this.dataset.event.centerLat = UNIFIED_BLAST_CENTER.lat
      this.dataset.event.centerHeight = UNIFIED_BLAST_CENTER.height
    }
    this.currentFrame = 0
    this.buildEntities()
    this._initThreeBridge()
    this._applyUndergroundViewIfNeeded()
    this.flyToCenter()
  }

  /**
   * 飞到隧道内部视角，直面掌子面
   * 相机位于隧道内部（爆心后方），朝向掌子面（正北方向）观察。
   * 相机参数从 viewConfig 读取（可由 setViewConfig 覆盖，默认从 design 表字段推导）
   */
  flyToCenter() {
    if (!this.dataset?.event || !this.viewer) return
    const event = this.dataset.event
    const center = {
      lon: Number(event.centerLon || 0),
      lat: Number(event.centerLat || 0),
      height: Number(event.centerHeight || 0)
    }
    if (!center.lon && !center.lat) return

    // 视角配置：优先用 setViewConfig 设置的值，其次从 design 表字段推导
    const design = this.dataset?.design || {}
    const vc = this.viewConfig || {}
    const headingDeg = vc.heading ?? 0 // 隧道朝向(°)，默认正北
    // 相机距掌子面距离：优先 viewConfig.cameraDist，否则按隧道长度*0.7，再否则 55m
    // 注意：原写法 `vc.cameraDist ?? Number(design.tunnelLength) * 0.7 ?? 55` 有运算符优先级陷阱
    //   - tunnelLength 为 undefined 时：Number(undefined)*0.7 = NaN，NaN ?? 55 仍为 NaN（?? 只拦 null/undefined）
    //   - 修正：显式判断 tunnelLength > 0 后再乘 0.7
    const tunnelLen = Number(design.tunnelLength)
    const cameraDist = vc.cameraDist ?? (tunnelLen > 0 ? tunnelLen * 0.7 : 55)
    // 相机离底板高度：同上陷阱修正
    const wallH = Number(design.tunnelWallHeight)
    const eyeHeightOffset = vc.eyeHeightOffset ?? (wallH > 0 ? wallH : 6)
    const headingRad = Cesium.Math.toRadians(headingDeg)

    // 在爆心处建立 ENU 局部坐标系
    const refCartesian = Cesium.Cartesian3.fromDegrees(center.lon, center.lat, center.height)
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(refCartesian)
    // ENU 偏移：沿隧道反方向后退，Up=eyeHeight
    const camOffsetENU = new Cesium.Cartesian3(
      -Math.sin(headingRad) * cameraDist,
      -Math.cos(headingRad) * cameraDist,
      eyeHeightOffset
    )
    const destination = Cesium.Matrix4.multiplyByPoint(
      enuMatrix,
      camOffsetENU,
      new Cesium.Cartesian3()
    )

    // 相机朝向掌子面：heading=隧道朝向，pitch=0（水平直视），roll=0
    this.viewer.camera.flyTo({
      destination,
      orientation: {
        heading: headingRad,
        pitch: 0,
        roll: 0
      },
      duration: 1.5
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
   * @param {number} frameIndex
   */
  setFrame(frameIndex) {
    if (!this.dataset?.result) return
    const duration = Number(this.dataset.result.simulationDurationS) || 10
    const dt = Number(this.dataset.result.timeStepS) || 0.05
    const maxFrame = Math.max(1, Math.floor(duration / dt))
    this.currentFrame = Math.max(0, Math.min(maxFrame - 1, Number(frameIndex) || 0))
    if (this.threeBridge) {
      const targetTime = this.currentFrame * dt
      this.threeBridge.seekTo(targetTime)
    }
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

    // 创建覆盖在 Cesium 之上的容器
    if (!this.threeContainer) {
      this.threeContainer = document.createElement('div')
      this.threeContainer.style.position = 'absolute'
      this.threeContainer.style.top = '0'
      this.threeContainer.style.left = '0'
      this.threeContainer.style.width = '100%'
      this.threeContainer.style.height = '100%'
      this.threeContainer.style.pointerEvents = 'none'
      this.threeContainer.style.zIndex = '100'
      const cesiumContainer = this.viewer.container
      if (cesiumContainer) cesiumContainer.appendChild(this.threeContainer)
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
    if (renderer && design) {
      // 1) 隧道断面尺寸（新 blasting_design 表字段）
      renderer.setTunnelSection({
        width: Number(design.tunnelWidth) || 18,
        wallHeight: Number(design.tunnelWallHeight) || 6,
        archRadius: Number(design.tunnelArchRadius) || 9,
        shape: design.tunnelShape || 'horseshoe'
      })

      // 2) 炮孔设计 + 设计参数（holes 来自 blasting_design_holes 表）
      const holes = Array.isArray(design.holes) ? design.holes : []
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
        totalHoleCount: holes.length,
        totalChargeKg: holes.reduce((s, h) => s + Number(h.chargeKg || 0), 0)
      }
      renderer.setBlastHoleDesign(holes, designParams)

      // 3) 爆破效果数据（新 blasting_result 表替代旧 design.blastEffect）
      if (this.dataset.result && typeof renderer.setBlastEffect === 'function') {
        renderer.setBlastEffect(this.dataset.result)
      }
    }

    // 启动爆破粒子效果
    const chargeKg = Number(event.chargeKg || 100)
    const fragmentCountTarget = Number(this.dataset.result?.fragmentCount || 200)
    // 默认碎片渲染上限 3000：与 useBlasting.js 的 PERFORMANCE_PROFILE 保持一致，
    // 防止 setDataset（无 kcoOverride）路径下因 Infinity 导致碎片数爆增（如 25022），
    // 触发 Cesium "Invalid array length" 与 WebGL 上下文丢失。
    const DEFAULT_FRAGMENT_RENDER_LIMIT = 3000
    const blastParams = {
      chargeKg,
      fragmentCountTarget,
      fragmentCountRenderLimit: Number.isFinite(Number(kcoOverride.fragmentCountRenderLimit))
        ? Number(kcoOverride.fragmentCountRenderLimit)
        : DEFAULT_FRAGMENT_RENDER_LIMIT,
      enableInterCollision:
        kcoOverride.enableInterCollision != null
          ? kcoOverride.enableInterCollision
          : true,
      randomSeed: kcoOverride.randomSeed,
      generationMetrics: buildGenerationMetrics(this.dataset)
    }
    // KCO 模型参数（透传到 threeBlastingRenderer.initBlast）
    // 基线值取自 DB result，UI 编辑后的 kcoOverride 覆盖之
    if (this.dataset.result) {
      // 只有当 kcoOverride 包含 KCO 相关字段时才用 'design' 模式，
      // 避免重新播放（传入 PERFORMANCE_PROFILE/randomSeed 等非 KCO 字段）时
      // 误切到 design 模式导致 KCO 参数与初次加载不一致。
      const kcoFields = ['Q', 'B', 'S', 'xmax', 'x50', 'n', 'b']
      const hasKcoOverride = kcoFields.some(f => kcoOverride[f] != null)
      blastParams.kcoParams = {
        Q: chargeKg,
        xmax: this.dataset.result.fragmentXmax,
        x50: this.dataset.result.fragmentX50,
        b: this.dataset.result.fragmentB,
        n: this.dataset.result.fragmentN,
        sourceMode: hasKcoOverride ? 'design' : 'result',
        ...kcoOverride // UI 编辑后的覆盖值（Q/B/S/xmax 等任一字段）
      }
    } else if (Object.keys(kcoOverride).length > 0) {
      // 无 result 但有 override（极端情况）：仅用 override 启动
      blastParams.kcoParams = { Q: chargeKg, sourceMode: 'design', ...kcoOverride }
    }

    this.threeBridge.startBlast(blastParams)
  }

  /** 销毁 three.js 桥接器 */
  _clearThreeBridge() {
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
   * @param {Object} cfg - { gridShape, boundsMin, boundsMax }
   */
  initVibrationField(cfg) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.initVibrationField?.(cfg)
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

  /** 当前是否已有可渲染的振动场 */
  hasVibrationField() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return !!renderer?.hasVibrationField?.()
  }

  /** 振动场元信息（grid/时间/帧） */
  getVibrationFieldInfo() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getVibrationFieldInfo?.() || null
  }

  /**
   * 获取 PPV 振动场 WebSocket 推送所需参数（供 useBlasting 调用 connector.startStream）。
   * 从当前 dataset 的 event/design 派生：装药量、隧道断面尺寸。
   * blastCenter 采用 three.js 局部坐标 (0,0,0)（爆心为 ENU 原点，与 build_ppv_grid 一致）。
   * @returns {{ chargeKg: number, blastCenter: number[], tunnelWidth: number, tunnelHeight: number }|null}
   */
  getPpvStreamParams() {
    if (!this.dataset?.event) return null
    const event = this.dataset.event
    const design = this.dataset.design || {}
    return {
      chargeKg: Number(event.chargeKg) || 100,
      blastCenter: [0, 0, 0],
      tunnelWidth: Number(design.tunnelWidth) || 18,
      tunnelHeight: (Number(design.tunnelWallHeight) || 6) + (Number(design.tunnelArchRadius) || 9)
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
