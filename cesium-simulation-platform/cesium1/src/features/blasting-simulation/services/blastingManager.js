import * as Cesium from 'cesium'
import { vibrationToColor } from './core/computation/vibrationFieldCore.js'
import { getSafetyLevel } from './core/computation/stressEvolutionCore.js'
import { PARTICLE_TYPES, PARTICLE_RENDER_PARAMS } from './core/computation/particleSystemCore.js'
import {
  BlastingStreamConnector,
  STREAM_MESSAGE_TYPES,
  STREAM_STATUS
} from './core/io/blastingStreamConnector.js'
import { CesiumThreeBridge } from './core/rendering/cesiumThreeBridge.js'

function toCartesian(position) {
  return Cesium.Cartesian3.fromDegrees(
    Number(position?.lon || 0),
    Number(position?.lat || 0),
    Number(position?.height || 0)
  )
}

const PARTICLE_COLORS = {
  [PARTICLE_TYPES.SHOCK_WAVE]: Cesium.Color.fromBytes(255, 200, 50, 200),
  [PARTICLE_TYPES.ROCK_FRAGMENT]: Cesium.Color.fromBytes(220, 160, 80, 230),
  [PARTICLE_TYPES.DUST]: Cesium.Color.fromBytes(180, 170, 160, 100),
  [PARTICLE_TYPES.SPALL]: Cesium.Color.fromBytes(200, 100, 50, 220),
  [PARTICLE_TYPES.FIRE]: Cesium.Color.fromBytes(255, 100, 10, 220),
  [PARTICLE_TYPES.SMOKE]: Cesium.Color.fromBytes(60, 60, 60, 130),
  [PARTICLE_TYPES.SPARK]: Cesium.Color.fromBytes(255, 220, 80, 240)
}

const PARTICLE_SIZES = {
  [PARTICLE_TYPES.SHOCK_WAVE]: 6,
  [PARTICLE_TYPES.ROCK_FRAGMENT]: 5,
  [PARTICLE_TYPES.DUST]: 3,
  [PARTICLE_TYPES.SPALL]: 4,
  [PARTICLE_TYPES.FIRE]: 8,
  [PARTICLE_TYPES.SMOKE]: 10,
  [PARTICLE_TYPES.SPARK]: 2
}

// 渲染参数（从数据库 blasting_render_config 加载）
const DEFAULT_RENDER_CONFIG = {
  particleMode: 'point_primitive', // point_primitive | entity
  fireballEnabled: true,
  smokeColumnEnabled: true,
  fragmentTrailEnabled: true,
  glowEffect: true,
  maxVisibleParticles: 2000,
  smokeColumnHeight: 80,
  smokeColumnRadius: 15,
  fireballRadius: 12,
  fireballDuration: 1.5,
  fragmentOutline: true,
  transparencyEnabled: true,
  lodDistance: 500,
  // three.js 高质量粒子渲染开关
  threeJsEnabled: true,
  threeJsParticleScale: 1.0
}

export class BlastingManager {
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for BlastingManager')
    this.viewer = viewer
    this.dataset = null
    this.currentFrame = 0
    this.centerEntity = null
    this.waveEntities = []
    this.fragmentEntities = []
    this.landingEntities = []
    this.designEntities = []
    this.holeEntities = []
    this.heatmapPrimitive = null
    this.heatmapCanvas = null
    this.heatmapContext = null
    this.heatmapBlurCanvas = null
    this.heatmapBlurContext = null
    this.heatmapAccumulatedField = null
    this.heatmapAccumulatedResolution = 0
    this.heatmapAccumulatedMaxIntensity = 0
    this.heatmapAccumulatedNonZeroCount = 0
    this.heatmapLastFrameIndex = -1
    this.heatmapOpacity = 0.85
    this.heatmapTextureDirty = true
    this.heatmapPlacementDirty = true
    // 热力图连续动画状态
    this.heatmapPreRenderListener = null
    this.heatmapPlaybackTime = 0 // 热力图播放时间（帧索引，浮点）
    this.heatmapLastWallTime = null // 上次 preRender 的真实时间（秒）
    this.heatmapPulsePhase = 0 // 脉动相位
    this.monitorEntities = []
    this.streamConnector = null
    this.streamStatus = STREAM_STATUS.IDLE
    // 高性能渲染
    this.pointCollection = null
    this.fragmentPointMap = new Map() // fragmentId -> point index
    this.fireballEntity = null
    this.smokeColumnEntity = null
    this.smokeParticles = []
    this.renderConfig = { ...DEFAULT_RENDER_CONFIG }
    // three.js 高质量粒子渲染桥接器（懒初始化）
    this.threeBridge = null
    this.threeContainer = null
  }

  setRenderConfig(config = {}) {
    this.renderConfig = { ...DEFAULT_RENDER_CONFIG, ...config }
  }

  clearScene() {
    if (this.centerEntity) this.viewer.entities.remove(this.centerEntity)
    this.waveEntities.forEach(e => this.viewer.entities.remove(e))
    this.fragmentEntities.forEach(e => this.viewer.entities.remove(e))
    this.landingEntities.forEach(e => this.viewer.entities.remove(e))
    this.designEntities.forEach(e => this.viewer.entities.remove(e))
    this.holeEntities.forEach(e => this.viewer.entities.remove(e))
    this.monitorEntities.forEach(e => this.viewer.entities.remove(e))
    this._stopHeatmapAnimation()
    this._clearHeatmap()
    this._clearPointCollection()
    this._clearFireball()
    this._clearSmokeColumn()
    this._clearThreeBridge()

    this.centerEntity = null
    this.waveEntities = []
    this.fragmentEntities = []
    this.landingEntities = []
    this.designEntities = []
    this.holeEntities = []
    this.monitorEntities = []
    this.dataset = null
    this.currentFrame = 0
  }

  setDataset(dataset) {
    this.clearScene()
    this.dataset = dataset
    this.currentFrame = 0
    this._resetHeatmapFieldState()
    this.buildEntities()
    this.buildMonitorPoints()
    this._initPointCollection()
    this._buildFireball()
    this._buildSmokeColumn()
    this._initThreeBridge()
    this._startHeatmapAnimation()
    this.flyToCenter()
  }

  flyToCenter() {
    if (!this.dataset?.event?.center || !this.viewer) return
    const center = this.dataset.event.center
    const design = this.dataset?.design

    // 默认在外部俯视（无掌子面朝向数据时的兜底）
    const fallback = () => {
      const destination = Cesium.Cartesian3.fromDegrees(
        center.lon,
        center.lat - 0.003,
        Math.max(250, (center.height || 0) + 350)
      )
      this.viewer.camera.flyTo({
        destination,
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch: Cesium.Math.toRadians(-35),
          roll: 0
        },
        duration: 1.5
      })
    }

    if (!design?.faceBefore?.center || design?.faceBefore?.headingDeg == null) {
      fallback()
      return
    }

    // 隧道内部视角：相机位于掌子面后方（掘进反方向），在隧道断面内水平看向掌子面
    const headingRad = Cesium.Math.toRadians(Number(design.faceBefore.headingDeg || 0))
    // 爆破方向在 ENU 中：East = sin(heading), North = cos(heading)
    // 相机在掌子面后方 → 沿 -forward 方向后退
    const cameraDist = 35 // 距掌子面后退距离(m)，保证能看到掌子面与抛掷碎石
    const eyeHeightOffset = 6 // 相机离底板高度(m)，约隧道半高，居中观察

    // 参考点使用爆心（与 Three.js 场景原点一致，保证相机对准渲染的掌子面）
    const refLon = Number(center.lon)
    const refLat = Number(center.lat)
    const refH = Number(center.height || 0)

    // 在爆心处建立 ENU 局部坐标系，计算相机位置（ENU 偏移 → 世界坐标）
    const refCartesian = Cesium.Cartesian3.fromDegrees(refLon, refLat, refH)
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(refCartesian)
    // ENU 偏移：East = -sin(heading)*dist（后退），North = -cos(heading)*dist，Up = eyeHeight
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

    // 朝向掌子面：heading 沿掘进方向，pitch=0 水平直视（隧道内部平视）
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

  setFrame(frameIndex) {
    if (!this.dataset) return
    const max = Math.max(0, this.dataset.frames.length - 1)
    this.currentFrame = Math.max(0, Math.min(max, Number(frameIndex) || 0))
    // 热力图由 preRender 监听器亚帧插值连续刷新，这里不再直接调用 _updateHeatmap
    this._updateMonitorPoints()
    this._updatePointCollection()
    this._updateFireball()
    this._updateSmokeColumn()
    // 同步 three.js 粒子到当前帧对应的物理时间
    if (this.threeBridge) {
      const frame = this.dataset.frames[this.currentFrame]
      const targetTime = Number(frame?.t ?? this.currentFrame * 0.05)
      this.threeBridge.seekTo(targetTime)
    }
  }

  // ─── PointPrimitiveCollection 高性能粒子渲染 ────────

  _initPointCollection() {
    if (!this.dataset) return
    this._clearPointCollection()

    // 当启用 Three.js 高质量粒子时，不创建 Cesium 2D 点粒子，避免与 3D 岩石模型重叠闪烁
    if (this.renderConfig.threeJsEnabled) return

    const mode = this.renderConfig.particleMode
    if (mode !== 'point_primitive') return

    // 创建 PointPrimitiveCollection
    this.pointCollection = this.viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT })
    )

    // 收集所有粒子轨迹
    const trackMap = new Map()
    this.dataset.frames.forEach(frame => {
      frame.fragments.forEach(fragment => {
        if (!trackMap.has(fragment.id)) trackMap.set(fragment.id, [])
        trackMap.get(fragment.id).push(fragment)
      })
    })

    // 限制最大可见粒子数
    const maxParticles = this.renderConfig.maxVisibleParticles
    let count = 0
    trackMap.forEach((track, fragmentId) => {
      if (count >= maxParticles) return
      const point = this.pointCollection.add({
        position: toCartesian(track[0].position),
        pixelSize: PARTICLE_SIZES[track[0].type] || 5,
        color: PARTICLE_COLORS[track[0].type] || Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.4),
        outlineWidth: 1,
        show: true
      })
      this.fragmentPointMap.set(fragmentId, point)
      count++
    })
  }

  _updatePointCollection() {
    if (!this.pointCollection || !this.dataset) return
    const frame = this.dataset.frames[this.currentFrame]
    if (!frame) return

    const fragmentMap = new Map()
    frame.fragments.forEach(f => fragmentMap.set(f.id, f))

    this.fragmentPointMap.forEach((point, fragmentId) => {
      const frag = fragmentMap.get(fragmentId)
      if (!frag) {
        point.show = false
        return
      }
      point.show = true
      point.position = toCartesian(frag.position)
      const baseSize = PARTICLE_SIZES[frag.type] || 5
      const renderParams = PARTICLE_RENDER_PARAMS[frag.type]
      let size = Math.max(2, Number(frag.size || 0.5) * baseSize)
      // 应用膨胀效果
      if (renderParams?.expand) {
        size *= 1 + (frag.age || 0) * 0.1
      }
      point.pixelSize = size

      // 颜色与透明度
      const baseColor = PARTICLE_COLORS[frag.type] || Cesium.Color.YELLOW
      if (this.renderConfig.transparencyEnabled && frag.opacity !== undefined) {
        point.color = baseColor.withAlpha(baseColor.alpha * frag.opacity)
      } else {
        point.color = baseColor
      }

      // 火焰不再使用正弦闪烁，避免爆点周围一闪一闪；改用平滑透明度
      if (frag.type === PARTICLE_TYPES.FIRE && frag.opacity !== undefined) {
        point.color = baseColor.withAlpha(baseColor.alpha * frag.opacity)
      }
    })
  }

  _clearPointCollection() {
    if (this.pointCollection) {
      this.viewer.scene.primitives.remove(this.pointCollection)
      this.pointCollection = null
    }
    this.fragmentPointMap.clear()
  }

  // ─── 火球效果 ─────────────────────────────────────

  _buildFireball() {
    if (!this.dataset || !this.renderConfig.fireballEnabled) return
    // Three.js 已负责高质量火球，禁用 Cesium 火球避免双重渲染与闪烁
    if (this.renderConfig.threeJsEnabled) return
    const center = this.dataset.event.center
    const centerCartesian = toCartesian(center)
    const radius = this.renderConfig.fireballRadius

    this.fireballEntity = this.viewer.entities.add({
      position: centerCartesian,
      ellipsoid: {
        radii: new Cesium.Cartesian3(radius, radius, radius),
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => {
            const frame = this.dataset?.frames[this.currentFrame]
            if (!frame) return Cesium.Color.TRANSPARENT
            const t = this.currentFrame / Math.max(1, this.dataset.frames.length)
            // 火球随时间膨胀并消散
            if (t > this.renderConfig.fireballDuration) return Cesium.Color.TRANSPARENT
            const alpha = Math.max(0, 1 - t / this.renderConfig.fireballDuration)
            const r = 1.0
            const g = Math.max(0.1, 0.6 - t * 0.5)
            const b = Math.max(0, 0.1 - t * 0.1)
            return new Cesium.Color(r, g, b, alpha * 0.7)
          }, false)
        ),
        outline: true,
        outlineColor: new Cesium.CallbackProperty(() => {
          const t = this.currentFrame / Math.max(1, this.dataset?.frames?.length || 1)
          if (t > this.renderConfig.fireballDuration) return Cesium.Color.TRANSPARENT
          return Cesium.Color.YELLOW.withAlpha(0.5)
        }, false)
      }
    })
  }

  _updateFireball() {
    // 火球通过 CallbackProperty 自动更新
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  _clearFireball() {
    if (this.fireballEntity) {
      this.viewer.entities.remove(this.fireballEntity)
      this.fireballEntity = null
    }
  }

  // ─── 烟雾柱效果 ───────────────────────────────────

  _buildSmokeColumn() {
    if (!this.dataset || !this.renderConfig.smokeColumnEnabled) return
    // Three.js 已负责高质量烟雾，禁用 Cesium 烟雾柱避免双重渲染
    if (this.renderConfig.threeJsEnabled) return
    const center = this.dataset.event.center
    const centerCartesian = toCartesian(center)
    const height = this.renderConfig.smokeColumnHeight
    const radius = this.renderConfig.smokeColumnRadius

    // 烟雾柱主体（圆柱）
    this.smokeColumnEntity = this.viewer.entities.add({
      position: centerCartesian,
      cylinder: {
        length: new Cesium.CallbackProperty(() => {
          const frame = this.dataset?.frames[this.currentFrame]
          if (!frame) return 1
          // 烟雾柱随时间增长
          const t = this.currentFrame / Math.max(1, this.dataset.frames.length)
          return Math.max(1, height * Math.min(1, t * 2))
        }, false),
        topRadius: new Cesium.CallbackProperty(() => {
          const t = this.currentFrame / Math.max(1, this.dataset?.frames?.length || 1)
          // 顶部膨胀形成蘑菇云
          return radius * (1 + t * 2)
        }, false),
        bottomRadius: radius,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => {
            const t = this.currentFrame / Math.max(1, this.dataset?.frames?.length || 1)
            const alpha = Math.max(0, 0.6 * (1 - t * 0.5))
            // 烟雾颜色从深灰到浅灰
            const gray = 0.2 + t * 0.3
            return new Cesium.Color(gray, gray, gray, alpha)
          }, false)
        ),
        outline: true,
        outlineColor: Cesium.Color.DARKGRAY.withAlpha(0.4)
      }
    })

    // 烟雾粒子（围绕柱体）
    this.smokeParticles = []
    const particleCount = 30
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2
      // 预计算随机参数，避免 CallbackProperty 每帧重新随机导致闪烁
      const r = radius * (0.5 + (((i * 37) % 100) / 100) * 0.5)
      const heightPhase = 0.2 + (((i * 13) % 100) / 100) * 0.8
      const size = 15 + (((i * 29) % 100) / 100) * 10
      const gray = 0.3 + (((i * 53) % 100) / 100) * 0.2
      const smokeEntity = this.viewer.entities.add({
        position: new Cesium.CallbackProperty(() => {
          const t = this.currentFrame / Math.max(1, this.dataset?.frames?.length || 1)
          const currentHeight = height * Math.min(1, t * 2) * heightPhase
          const currentR = r * (1 + t * 1.5)
          const latRad = (center.lat * Math.PI) / 180
          const dx = Math.cos(angle) * currentR
          const dy = Math.sin(angle) * currentR
          const dLon = dx / (111320 * Math.cos(latRad))
          const dLat = dy / 110540
          return Cesium.Cartesian3.fromDegrees(
            center.lon + dLon,
            center.lat + dLat,
            center.height + currentHeight
          )
        }, false),
        point: {
          pixelSize: size,
          color: new Cesium.CallbackProperty(() => {
            const t = this.currentFrame / Math.max(1, this.dataset?.frames?.length || 1)
            const alpha = Math.max(0, 0.4 * (1 - t * 0.3))
            return new Cesium.Color(gray, gray, gray, alpha)
          }, false)
        }
      })
      this.smokeParticles.push(smokeEntity)
    }
  }

  _updateSmokeColumn() {
    // 烟雾柱通过 CallbackProperty 自动更新
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  _clearSmokeColumn() {
    if (this.smokeColumnEntity) {
      this.viewer.entities.remove(this.smokeColumnEntity)
      this.smokeColumnEntity = null
    }
    this.smokeParticles.forEach(e => this.viewer.entities.remove(e))
    this.smokeParticles = []
  }

  // ─── three.js 高质量粒子渲染 ───────────────────────

  /**
   * 初始化 three.js 桥接器并启动爆破效果
   * three.js 渲染的粒子（火焰/烟雾/火花/碎片/冲击波/粉尘）叠加在 Cesium 之上，
   * 与 Cesium 实体粒子互补：three.js 负责高质量视觉效果，
   * Cesium 实体负责冲击波环、热力图、监测点等地理要素。
   */
  _initThreeBridge() {
    if (!this.dataset?.event?.center || !this.renderConfig.threeJsEnabled) {
      console.warn('[BlastingManager] three.js 桥接器未启动', {
        hasCenter: !!this.dataset?.event?.center,
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
      console.log('[BlastingManager] three.js 容器挂载', {
        hasContainer: !!cesiumContainer,
        containerTag: cesiumContainer?.tagName,
        containerId: cesiumContainer?.id
      })
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
    const center = this.dataset.event.center
    this.threeBridge.setCenter(
      Number(center.lon || 0),
      Number(center.lat || 0),
      Number(center.height || 0)
    )

    // 启动爆破粒子效果
    const chargeKg = Number(this.dataset.event.chargeKg || 100)
    const fragmentCount = Number(this.dataset?.summary?.fragmentCount || 200)

    // 从设计数据中提取掌子面方向（爆破方向）
    const blastParams = {
      chargeKg,
      fragmentCount: Math.min(300, Math.max(50, fragmentCount))
    }
    const design = this.dataset?.design
    if (design?.faceBefore?.center && design?.faceBefore?.headingDeg != null) {
      // 根据掌子面朝向计算爆破方向（ENU 局部坐标）
      const headingRad = (Number(design.faceBefore.headingDeg) * Math.PI) / 180
      blastParams.faceDirection = {
        x: Math.sin(headingRad), // East 分量
        y: 0,
        z: -Math.cos(headingRad) // South 分量（three 局部坐标使用 -North 保持右手）
      }
    }

    this.threeBridge.startBlast(blastParams)
  }

  _clearThreeBridge() {
    if (this.threeBridge) {
      this.threeBridge.dispose()
      this.threeBridge = null
    }
  }

  /**
   * 获取 three.js 渲染统计
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
   * @returns {object|null}
   */
  getBlastDesign() {
    const renderer = this.threeBridge?.getThreeRenderer?.()
    return renderer?.getBlastDesign?.() || null
  }

  /**
   * 重新触发爆破效果（用于 UI 按钮重播）
   */
  replayBlast() {
    if (!this.threeBridge || !this.dataset?.event?.center) {
      this._initThreeBridge()
      return
    }
    const center = this.dataset.event.center
    this.threeBridge.setCenter(
      Number(center.lon || 0),
      Number(center.lat || 0),
      Number(center.height || 0)
    )
    const chargeKg = Number(this.dataset.event.chargeKg || 100)
    const fragmentCount = Number(this.dataset?.summary?.fragmentCount || 200)

    // 从设计数据中提取掌子面方向（爆破方向）
    const blastParams = {
      chargeKg,
      fragmentCount: Math.min(300, Math.max(50, fragmentCount))
    }
    const design = this.dataset?.design
    if (design?.faceBefore?.center && design?.faceBefore?.headingDeg != null) {
      const headingRad = (Number(design.faceBefore.headingDeg) * Math.PI) / 180
      blastParams.faceDirection = {
        x: Math.sin(headingRad),
        y: 0,
        z: -Math.cos(headingRad)
      }
    }

    this.threeBridge.startBlast(blastParams)
  }

  buildEntities() {
    if (!this.dataset) return
    const center = this.dataset.event.center
    const visual = this.dataset?.visual || {}
    const waveRings = Number(visual.waveRings || 3)
    const centerCartesian = toCartesian(center)

    // 爆心标记
    this.centerEntity = this.viewer.entities.add({
      position: centerCartesian,
      point: {
        pixelSize: 12,
        color: Cesium.Color.ORANGE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2
      },
      label: {
        text: this.dataset.event.name,
        font: '13px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        pixelOffset: new Cesium.Cartesian2(0, -24)
      }
    })

    // 冲击波环
    for (let ring = 0; ring < waveRings; ring++) {
      const ringOffset = ring * 0.18
      const ringScale = 1 + ring * 0.25
      const waveRadiusProperty = new Cesium.CallbackProperty(() => {
        if (!this.dataset) return 1
        const base = Number(this.dataset.frames[this.currentFrame]?.waveRadius ?? 1)
        return Math.max(1, base * ringScale + base * ringOffset)
      }, false)
      const waveEntity = this.viewer.entities.add({
        position: centerCartesian,
        ellipse: {
          semiMajorAxis: waveRadiusProperty,
          semiMinorAxis: waveRadiusProperty,
          height: center.height + ring * 0.03,
          material: Cesium.Color.ORANGE.withAlpha(Math.max(0.08, 0.26 - ring * 0.08)),
          outline: true,
          outlineColor: Cesium.Color.ORANGE.withAlpha(Math.max(0.25, 0.68 - ring * 0.18))
        }
      })
      this.waveEntities.push(waveEntity)
    }

    this.buildDesignEntities()
    // 仅在非 PointPrimitiveCollection 模式且未启用 Three.js 时创建实体粒子（避免与 3D 岩石双重渲染）
    if (this.renderConfig.particleMode !== 'point_primitive' && !this.renderConfig.threeJsEnabled) {
      this._buildFragmentEntities()
    }
  }

  _buildFragmentEntities() {
    const visual = this.dataset?.visual || {}
    const trailWidth = Number(visual.trailWidth || 2.0)

    // 收集每个粒子的轨迹
    const trackMap = new Map()
    this.dataset.frames.forEach(frame => {
      frame.fragments.forEach(fragment => {
        if (!trackMap.has(fragment.id)) trackMap.set(fragment.id, [])
        trackMap.get(fragment.id).push({
          position: toCartesian(fragment.position),
          size: fragment.size,
          type: fragment.type,
          landed: fragment.landed
        })
      })
    })

    trackMap.forEach((track, fragmentId) => {
      const positionProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame, track.length - 1)
        return track[Math.max(0, idx)]?.position
      }, false)

      const sizeProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame, track.length - 1)
        const p = track[Math.max(0, idx)]
        const baseSize = PARTICLE_SIZES[p?.type] || 5
        return Math.max(2, Number(p?.size || 0.5) * baseSize)
      }, false)

      const colorProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame, track.length - 1)
        const p = track[Math.max(0, idx)]
        return PARTICLE_COLORS[p?.type] || Cesium.Color.YELLOW
      }, false)

      const pathProperty = new Cesium.CallbackProperty(() => {
        const idx = Math.min(this.currentFrame + 1, track.length)
        return track.slice(0, Math.max(1, idx)).map(item => item.position)
      }, false)

      const fragmentEntity = this.viewer.entities.add({
        id: `blasting-fragment-${fragmentId}`,
        position: positionProperty,
        point: {
          pixelSize: sizeProperty,
          color: colorProperty,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.4),
          outlineWidth: 1
        },
        polyline: {
          positions: pathProperty,
          width: Math.max(1, trailWidth),
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.22,
            color: Cesium.Color.YELLOW.withAlpha(0.45)
          })
        }
      })

      this.fragmentEntities.push(fragmentEntity)

      // 落地标记
      const landingPosition = track[track.length - 1]?.position
      if (landingPosition) {
        const showLanding = new Cesium.CallbackProperty(() => {
          return this.currentFrame >= track.length - 1
        }, false)
        const landingEntity = this.viewer.entities.add({
          position: landingPosition,
          show: showLanding,
          point: {
            pixelSize: 5,
            color: Cesium.Color.RED.withAlpha(0.85),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.75),
            outlineWidth: 1
          }
        })
        this.landingEntities.push(landingEntity)
      }
    })
  }

  buildDesignEntities() {
    const design = this.dataset?.design
    if (!design) return

    const buildFace = (face, color, label) => {
      if (!face?.center) return
      const facePosition = toCartesian(face.center)
      const headingRad = Cesium.Math.toRadians(Number(face.headingDeg || 0))
      const orientation = Cesium.Transforms.headingPitchRollQuaternion(
        facePosition,
        new Cesium.HeadingPitchRoll(headingRad, 0, 0)
      )
      const faceEntity = this.viewer.entities.add({
        position: facePosition,
        orientation,
        box: {
          dimensions: new Cesium.Cartesian3(
            Number(face.width || 1),
            Number(face.thickness || 0.2),
            Number(face.height || 1)
          ),
          material: color.withAlpha(0.85),
          outline: true,
          outlineColor: color
        },
        label: {
          text: label,
          font: '12px sans-serif',
          fillColor: color,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
          pixelOffset: new Cesium.Cartesian2(0, -22)
        }
      })
      this.designEntities.push(faceEntity)
    }

    buildFace(design.faceBefore, Cesium.Color.CYAN, '掌子面-爆前')
    buildFace(design.faceAfter, Cesium.Color.LIME, '掌子面-爆后')

    const holes = Array.isArray(design.holes) ? design.holes : []
    holes.forEach(hole => {
      if (!hole?.collar || !hole?.toe) return
      const collar = toCartesian(hole.collar)
      const toe = toCartesian(hole.toe)
      const width = Math.max(1, Number(hole?.diameter || 0.08) * 30)
      const holeEntity = this.viewer.entities.add({
        position: collar,
        polyline: {
          positions: [collar, toe],
          width,
          material: Cesium.Color.DODGERBLUE.withAlpha(0.8)
        },
        label: {
          text: `${hole.id}  ${Number(hole.delayMs || 0)}ms`,
          font: '11px monospace',
          fillColor: Cesium.Color.AZURE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.35),
          pixelOffset: new Cesium.Cartesian2(0, -12)
        }
      })
      this.holeEntities.push(holeEntity)
    })
  }

  // ─── 振动热力图 ─────────────────────────────────────

  _resetHeatmapFieldState() {
    this.heatmapAccumulatedField = null
    this.heatmapAccumulatedResolution = 0
    this.heatmapAccumulatedMaxIntensity = 0
    this.heatmapAccumulatedNonZeroCount = 0
    this.heatmapLastFrameIndex = -1
    this.heatmapTextureDirty = true
    this.heatmapPlacementDirty = true
  }

  // ─── 振动热力图（连续动画） ─────────────────────────
  //
  // 旧实现的问题：仅在被回放定时器调用的 setFrame 中重绘 canvas，且
  // ImageMaterialProperty 的 image 只在创建时传入一次，Cesium 因 canvas
  // 引用不变而不会重新上传纹理 → 视觉上像一张静态贴纸。
  //
  // 新实现：
  //  1. 注册 preRender 监听，按真实时间推进 heatmapPlaybackTime（浮点帧）
  //  2. 在相邻帧之间线性插值振动场，实现 60fps 平滑传播
  //  3. 用 CallbackProperty 作为 image，每帧强制 Cesium 重新求值并上传纹理
  //  4. 叠加轻微脉动（透明度呼吸），让热力图"活"起来

  _startHeatmapAnimation() {
    this._stopHeatmapAnimation()
    if (!this.viewer?.scene) return
    this.heatmapPlaybackTime = this.currentFrame
    this._heatmapAnimateBound = this._animateHeatmap.bind(this)
    this.heatmapPreRenderListener = this.viewer.scene.preRender.addEventListener(
      this._heatmapAnimateBound
    )
  }

  _stopHeatmapAnimation() {
    if (this.heatmapPreRenderListener) {
      this.heatmapPreRenderListener()
      this.heatmapPreRenderListener = null
    }
    this.heatmapLastWallTime = null
  }

  /**
   * preRender 回调：平滑追逐当前帧 + 重绘 canvas（带脉动）。
   *
   * 帧推进仍由回放定时器通过 setFrame 驱动（保持与其余模拟同步），
   * 这里只在相邻帧间做亚帧插值，让波纹传播更连贯，并叠加脉动效果。
   */
  _animateHeatmap() {
    if (!this.dataset) return
    const frames = this.dataset.frames
    if (!frames?.length) return

    // 亚帧平滑：heatmapPlaybackTime 向 currentFrame+1 方向追逐，
    // 当 setFrame 推进 currentFrame 时，热力图平滑过渡而非瞬切。
    const target = Math.min(frames.length - 1, this.currentFrame + 0.999)
    const wallNow = performance.now() / 1000
    if (this.heatmapLastWallTime != null) {
      const dt = Math.min(0.1, wallNow - this.heatmapLastWallTime)
      // 追逐速率：每秒覆盖约 20 帧的亚帧距离
      const speed = 20
      if (this.heatmapPlaybackTime < target) {
        this.heatmapPlaybackTime = Math.min(target, this.heatmapPlaybackTime + dt * speed)
      } else if (this.heatmapPlaybackTime > this.currentFrame) {
        // setFrame 跳回了（用户拖动时间轴），快速回落
        this.heatmapPlaybackTime = Math.max(
          this.currentFrame,
          this.heatmapPlaybackTime - dt * speed * 2
        )
      }
    }
    this.heatmapLastWallTime = wallNow
    this.heatmapPulsePhase = (this.heatmapPulsePhase + 0.06) % (Math.PI * 2)

    this._renderHeatmapAt(this.heatmapPlaybackTime)
  }

  /**
   * 在浮点帧索引 t 处计算插值振动场并重绘 canvas + 同步实体
   */
  _renderHeatmapAt(t) {
    const frames = this.dataset.frames
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(t)))
    const i1 = Math.min(frames.length - 1, i0 + 1)
    const frac = t - i0

    const f0 = frames[i0]?.vibrationField
    const f1 = frames[i1]?.vibrationField
    if (!f0) {
      this._clearHeatmap()
      return
    }

    const res = f0.resolution
    const len = f0.data.length
    if (
      !this.heatmapAccumulatedField ||
      this.heatmapAccumulatedField.length !== len ||
      this.heatmapAccumulatedResolution !== res
    ) {
      this.heatmapAccumulatedField = new Float32Array(len)
      this.heatmapAccumulatedResolution = res
    }
    const displayField = this.heatmapAccumulatedField

    // 帧间线性插值 + 时间平滑（保留拖尾，避免瞬时归零闪灭）
    let maxIntensity = 0
    let nonZeroCount = 0
    const decayFactor = 0.94
    const hasF1 = f1 && f1.data.length === len
    for (let i = 0; i < len; i++) {
      const raw = hasF1 ? f0.data[i] * (1 - frac) + f1.data[i] * frac : f0.data[i]
      const decayed = displayField[i] * decayFactor
      const smoothed = Math.max(raw, decayed)
      displayField[i] = smoothed >= 0.005 ? smoothed : 0
      if (displayField[i] >= 0.02) nonZeroCount += 1
      if (displayField[i] > maxIntensity) maxIntensity = displayField[i]
    }
    this.heatmapAccumulatedMaxIntensity = maxIntensity
    this.heatmapAccumulatedNonZeroCount = nonZeroCount

    const hasVisibleField = maxIntensity > 0.001 && nonZeroCount > 0
    if (!hasVisibleField) {
      this._clearHeatmap()
      return
    }

    this._ensureHeatmapCanvas()
    this._drawHeatmapCanvas(displayField, res)
    this._ensureHeatmapPrimitive()
  }

  _ensureHeatmapCanvas() {
    if (this.heatmapCanvas) return
    const canvasSize = 256
    this.heatmapCanvas = document.createElement('canvas')
    this.heatmapCanvas.width = canvasSize
    this.heatmapCanvas.height = canvasSize
    this.heatmapContext = this.heatmapCanvas.getContext('2d')
    this.heatmapBlurCanvas = document.createElement('canvas')
    this.heatmapBlurCanvas.width = canvasSize
    this.heatmapBlurCanvas.height = canvasSize
    this.heatmapBlurContext = this.heatmapBlurCanvas.getContext('2d')
  }

  /**
   * 将振动场绘制到 canvas，叠加脉动透明度让热力图"呼吸"
   */
  _drawHeatmapCanvas(displayField, res) {
    const canvas = this.heatmapCanvas
    const ctx = this.heatmapContext
    const blurCanvas = this.heatmapBlurCanvas
    const blurCtx = this.heatmapBlurContext
    if (!ctx || !blurCtx) return

    const canvasSize = canvas.width
    ctx.clearRect(0, 0, canvasSize, canvasSize)

    // 脉动：透明度在 0.8 ~ 1.0 之间呼吸，强化"能量场"观感
    const pulse = 0.9 + Math.sin(this.heatmapPulsePhase) * 0.1

    const cellSize = canvasSize / res
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const intensity = displayField[j * res + i]
        if (intensity < 0.02) continue
        const color = vibrationToColor(intensity)
        const a = Math.min(1, color.a * pulse)
        ctx.fillStyle = `rgba(${Math.floor(color.r * 255)},${Math.floor(color.g * 255)},${Math.floor(color.b * 255)},${a})`
        ctx.fillRect(i * cellSize, (res - 1 - j) * cellSize, cellSize + 1, cellSize + 1)
      }
    }

    // 临时画布模糊，避免自绘闪烁
    blurCtx.clearRect(0, 0, blurCanvas.width, blurCanvas.height)
    blurCtx.filter = 'blur(2px)'
    blurCtx.drawImage(canvas, 0, 0)
    blurCtx.filter = 'none'
    ctx.clearRect(0, 0, canvasSize, canvasSize)
    ctx.drawImage(blurCanvas, 0, 0)

    this.heatmapTextureDirty = false
  }

  /**
   * 创建或更新热力图矩形实体。
   * 关键：image 使用 CallbackProperty（非恒定），每帧强制 Cesium 重新求值
   * 并上传 canvas 纹理，从而让 canvas 内容变化真正反映到地表上。
   */
  _ensureHeatmapPrimitive() {
    const center = this.dataset.event.center
    const maxRadius = 200 // 与 VibrationField 配置一致
    const latRad = (center.lat * Math.PI) / 180
    const dLon = maxRadius / (111320 * Math.cos(latRad))
    const dLat = maxRadius / 110540
    const coordinates = Cesium.Rectangle.fromDegrees(
      center.lon - dLon,
      center.lat - dLat,
      center.lon + dLon,
      center.lat + dLat
    )
    const height = center.height + 2

    // 脉动透明度
    const pulse = 0.9 + Math.sin(this.heatmapPulsePhase) * 0.1
    this.heatmapOpacity = 0.8 * pulse

    if (!this.heatmapPrimitive) {
      this.heatmapPrimitive = this.viewer.entities.add({
        rectangle: {
          coordinates,
          height,
          material: new Cesium.ImageMaterialProperty({
            // CallbackProperty 非恒定 → 每帧重新求值 image → 纹理刷新
            image: new Cesium.CallbackProperty(() => this.heatmapCanvas, false),
            transparent: true,
            color: new Cesium.CallbackProperty(
              () => Cesium.Color.WHITE.withAlpha(this.heatmapOpacity),
              false
            )
          })
        }
      })
      this.heatmapPlacementDirty = false
    } else {
      this.heatmapPrimitive.show = true
      if (this.heatmapPlacementDirty) {
        this.heatmapPrimitive.rectangle.coordinates = coordinates
        this.heatmapPrimitive.rectangle.height = height
        this.heatmapPlacementDirty = false
      }
    }

    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  _updateHeatmap() {
    // 兼容旧调用入口：在当前帧重绘一次（动画循环会随后接管连续刷新）
    if (!this.dataset) return
    this.heatmapPlaybackTime = this.currentFrame
    this._renderHeatmapAt(this.currentFrame)
  }

  _clearHeatmap() {
    if (this.heatmapPrimitive) {
      this.heatmapPrimitive.show = false
    }
    if (this.heatmapContext && this.heatmapCanvas) {
      this.heatmapContext.clearRect(0, 0, this.heatmapCanvas.width, this.heatmapCanvas.height)
    }
    if (this.heatmapBlurContext && this.heatmapBlurCanvas) {
      this.heatmapBlurContext.clearRect(
        0,
        0,
        this.heatmapBlurCanvas.width,
        this.heatmapBlurCanvas.height
      )
    }
    this.heatmapAccumulatedField = null
    this.heatmapAccumulatedResolution = 0
    this.heatmapAccumulatedMaxIntensity = 0
    this.heatmapAccumulatedNonZeroCount = 0
    this.heatmapLastFrameIndex = -1
    this.heatmapTextureDirty = true
    this.heatmapPlacementDirty = true
  }

  // ─── 应力监测点 ─────────────────────────────────────

  buildMonitorPoints() {
    const points = this.dataset?.monitorPoints
    if (!Array.isArray(points)) return

    for (const point of points) {
      const center = this.dataset.event.center
      const latRad = (center.lat * Math.PI) / 180
      const dLon = point.x / (111320 * Math.cos(latRad))
      const dLat = point.y / 110540
      const position = Cesium.Cartesian3.fromDegrees(
        center.lon + dLon,
        center.lat + dLat,
        center.height + (point.z || 0)
      )

      const entity = this.viewer.entities.add({
        position,
        point: {
          pixelSize: 8,
          color: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString('#3498db'),
          outlineWidth: 2
        },
        label: {
          text: point.label,
          font: '11px sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
          pixelOffset: new Cesium.Cartesian2(0, -16)
        }
      })
      this.monitorEntities.push(entity)
    }
  }

  _updateMonitorPoints() {
    if (!this.dataset || this.monitorEntities.length === 0) return
    const frame = this.dataset.frames[this.currentFrame]
    if (!frame?.stresses) return

    for (let i = 0; i < frame.stresses.length && i < this.monitorEntities.length; i++) {
      const stress = frame.stresses[i]
      const entity = this.monitorEntities[i]
      const levelObj = getSafetyLevel(stress.safetyFactor)
      const color = Cesium.Color.fromCssColorString(levelObj?.color || '#2ecc71')

      entity.point.color = new Cesium.CallbackProperty(() => color, false)
      entity.point.outlineColor = new Cesium.CallbackProperty(() => color, false)
    }
  }

  // ─── 实时数据推送 ───────────────────────────────────

  startStream(config = {}) {
    if (this.streamConnector) {
      this.streamConnector.destroy()
    }

    this.streamConnector = new BlastingStreamConnector({
      mode: config.mode || 'local',
      wsUrl: config.wsUrl || '',
      eventId: this.dataset?.event?.id || null,
      frameInterval: config.frameInterval || 50
    })

    this.streamConnector.on(STREAM_MESSAGE_TYPES.BLASTING_FRAME, data => {
      if (data.frame) {
        this.currentFrame = data.frameIndex
        // 直接使用推送的帧数据更新场景
        this._applyStreamFrame(data.frame)
      }
    })

    this.streamConnector.on(STREAM_MESSAGE_TYPES.STATUS, data => {
      this.streamStatus = data.status
    })

    this.streamConnector.on(STREAM_MESSAGE_TYPES.COMPLETE, () => {
      this.streamStatus = STREAM_STATUS.COMPLETE
    })

    // 设置本地帧提供器
    if (config.mode !== 'websocket' && this.dataset) {
      this.streamConnector.setLocalFrameProvider(
        frameIndex => this.dataset.frames[frameIndex],
        this.dataset.frames.length
      )
    }

    this.streamConnector.connect()
  }

  stopStream() {
    if (this.streamConnector) {
      this.streamConnector.disconnect()
      this.streamStatus = STREAM_STATUS.IDLE
    }
  }

  _applyStreamFrame(frame) {
    // 实时帧已通过 setFrame 机制更新
    // 此处可处理额外的实时数据（如传感器读数覆盖）
    if (frame?.vibrationField) {
      this._updateHeatmap()
    }
    if (frame?.stresses) {
      this._updateMonitorPoints()
    }
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  getStreamStatus() {
    return this.streamStatus
  }

  destroy() {
    this.clearScene()
    if (this.streamConnector) {
      this.streamConnector.destroy()
      this.streamConnector = null
    }
    // 移除 three.js 容器
    if (this.threeContainer && this.threeContainer.parentNode) {
      this.threeContainer.parentNode.removeChild(this.threeContainer)
      this.threeContainer = null
    }
  }
}
