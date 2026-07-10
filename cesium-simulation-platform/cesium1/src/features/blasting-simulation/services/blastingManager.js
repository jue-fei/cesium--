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

// 渲染参数（硬编码默认值；旧 blasting_render_config 表已删除）
// 仅保留 three.js 桥接所需开关
const DEFAULT_RENDER_CONFIG = {
  threeJsEnabled: true,
  threeJsParticleScale: 1.0
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
    const headingDeg = vc.heading ?? 0  // 隧道朝向(°)，默认正北
    const cameraDist = vc.cameraDist ?? Number(design.tunnelLength) * 0.7 ?? 55  // 相机距掌子面距离
    const eyeHeightOffset = vc.eyeHeightOffset ?? Number(design.tunnelWallHeight) ?? 6  // 相机离底板高度
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
    // 碎片数量：仅当 DB 有真实 fragmentCount 数据时传入，否则不传（undefined）触发体积驱动
    const dbFragmentCount = this.dataset.result?.fragmentCount
    const fragmentCount = dbFragmentCount != null ? Number(dbFragmentCount) : undefined
    const blastParams = {
      chargeKg,
      fragmentCount: fragmentCount != null ? Math.min(3000, Math.max(50, fragmentCount)) : undefined,
      // 确定性模式：相同 randomSeed 产生相同碎片物理轨迹（null 时回退到 Math.random）
      randomSeed: this.dataset.result?.randomSeed ?? null
    }
    // KCO 模型参数（透传到 threeBlastingRenderer.initBlast）
    // 基线值取自 DB result，UI 编辑后的 kcoOverride 覆盖之
    if (this.dataset.result) {
      blastParams.kcoParams = {
        Q: chargeKg,
        xmax: this.dataset.result.fragmentXmax,
        x50: this.dataset.result.fragmentX50,
        b: this.dataset.result.fragmentB,
        n: this.dataset.result.fragmentN,
        ...kcoOverride  // UI 编辑后的覆盖值（Q/B/S/xmax 等任一字段）
      }
    } else if (Object.keys(kcoOverride).length > 0) {
      // 无 result 但有 override（极端情况）：仅用 override 启动
      blastParams.kcoParams = { Q: chargeKg, ...kcoOverride }
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

  // ─── 爆破效果评价：数据获取 + 联动高亮 ──────────────────

  /** 获取损伤区半径数据 */
  getDamageZones() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getDamageZones?.() || null
  }

  /** 联动高亮：高亮指定损伤区 */
  highlightDamageZone(zone) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.highlightDamageZone?.(zone)
  }

  /** 联动高亮：高亮指定块度等级的碎片 */
  highlightBlockClass(cls) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.highlightBlockClass?.(cls)
  }

  /** 获取爆破效果统计（最远抛掷距离等） */
  getBlastEffectStats() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getBlastEffectStats?.() || null
  }

  /** 获取 PPV 场统计（需先 loadPPVField） */
  getPPVFieldStats() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getPPVFieldStats?.() || null
  }

  /** 切换 PPV 色标安全标准 */
  setSafetyStandard(std) {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    renderer?.setSafetyStandard?.(std)
  }

  /**
   * 异步加载 PPV 振动场数据（调用后端 /ppv-field）
   * @param {Object} [overrideParams] - 可选参数覆盖
   * @returns {Promise<boolean>} 是否成功
   */
  async loadPPVField(overrideParams = {}) {
    if (!this.dataset?.event) return false
    const { fetchPPVField } = await import('./blastingApi.js')
    const event = this.dataset.event
    const chargeKg = Number(event.chargeKg || 100)
    const params = {
      chargeKg,
      time: 0.1,
      xMin: -30, xMax: 30, yMin: -15, yMax: 15,
      nx: 100, ny: 60,
      explosiveType: 'emulsion',
      pWaveSpeed: 4500,
      attenuationP: 0.012,
      rockUcs: 120e6,
      ...overrideParams
    }
    try {
      const data = await fetchPPVField(params)
      const renderer = this.threeBridge?.getThreeRenderer?.()
      if (renderer && data) {
        renderer.setPPVFieldData(data, {
          safetyStandard: overrideParams.safetyStandard || 'general_building'
        })
        return true
      }
    } catch (e) {
      console.warn('[BlastingManager] loadPPVField 失败:', e?.message || e)
    }
    return false
  }

  /**
   * 联动：相机飞到最远碎片位置（点击"最大抛掷距离"时调用）
   * 在 three.js 局部坐标系中标记最远碎片位置（通过 Cesium 实体）
   */
  flyToFarthestFragment() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    const pos = renderer?.getFarthestFragmentPosition?.()
    if (!pos || !this.dataset?.event) return false
    // three.js 局部坐标 → Cesium 世界坐标（通过 threeBridge 的逆变换）
    const world = this.threeBridge?.localToWorld?.(pos)
    if (world && this.viewer) {
      this.viewer.camera.flyTo({
        destination: world,
        orientation: { heading: 0, pitch: -0.3, roll: 0 },
        duration: 1.2
      })
    }
    return true
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
