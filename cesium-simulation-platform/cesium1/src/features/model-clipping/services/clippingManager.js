import * as Cesium from 'cesium'

// ===== 常量定义 =====
// 默认法向量
const DEFAULT_NORMAL = new Cesium.Cartesian3(1.0, 0.0, 0.0)

// 延迟时间常量
const VISUALIZATION_DELAY = 100 // 切割面可视化延迟(ms)

// 距离计算常量
const MAX_DISTANCE_MULTIPLIER = 1.5 // 最大距离为模型半径的倍数
const DEFAULT_MAX_DISTANCE = 1000 // 默认最大距离(m)

/**
 * 模型切割管理器
 * 支持多面切割、多边形切割、切割面可视化、切割面控制等功能
 */
class ClippingManager {
  constructor(viewer) {
    this.viewer = viewer
    this.tileset = null
    this.clippingPlanes = []
    this.planeEntities = []
    this.activeClippingPlaneIndex = null
    this.clippingEnabled = false
    this.modelBounds = null
    // 切割基准：刀面零点锚定的包围球（世界坐标）；为空时回退整场景包围球中心
    this.clipFocus = null
    // 新瓦片加载时补挂刀面的监听器
    this.tileLoadClippingListener = null

    // 多边形切割相关变量
    this.polygonClippingEnabled = false
    this.clippingPolygonCollection = null
    this.currentPolygon = []
    this.polygonEntity = null
    this.pointEntities = []
    this.isDrawingPolygon = false
    this.hoverPolygonPoint = null
    this.excavationSideEntities = []
    this.excavationBottomEntity = null
    this.excavationBottomEdgeEntity = null

    // 多边形切割深度 (0表示无限深度/穿透)
    this.polygonDepth = 0
    // 多边形切割方向 ('excavate': 挖掘/内部, 'isolate': 隔离/保留内部)
    this.polygonDirection = 'excavate'
    this.polygonVisualizationOpacity = 0.35

    // 上次绘制的多边形顶点（用于实时更新设置）
    this.lastPolygonPositions = []
  }

  isViewerAlive() {
    const viewer = this.viewer
    if (!viewer) return false
    if (typeof viewer.isDestroyed === 'function') return !viewer.isDestroyed()
    return true
  }

  isTilesetAlive() {
    const tileset = this.tileset
    if (!tileset) return false
    if (typeof tileset.isDestroyed === 'function') return !tileset.isDestroyed()
    return true
  }

  /**
   * 设置要切割的tileset
   */
  setTileset(tileset) {
    if (tileset && typeof tileset.isDestroyed === 'function' && tileset.isDestroyed()) {
      this.detachTileLoadClipping()
      this.tileset = null
      this.modelBounds = null
      return
    }

    this.detachTileLoadClipping()
    this.tileset = tileset || null
    this.modelBounds = tileset?.boundingSphere || null
    // 换模型后旧的切割基准失效，回退整场景包围球
    this.clipFocus = null
    this.bindTileLoadClipping()
  }

  /**
   * 当前集合是否生效（启用且有刀面）
   */
  hasActiveClipping() {
    const collection = this.isTilesetAlive() ? this.tileset.clippingPlanes : null
    return !!(collection && collection.enabled && collection.length > 0)
  }

  /**
   * 把 ClippingPlaneCollection 直接挂到瓦片模型上（含子树）。
   * 为什么需要手动挂：Cesium 只在 clippingPlanesState（=刀面个数）变化时
   * 才会通过 Model3DTileContent.update 把集合下发到 model；本聚合场景里
   * 地表这类大瓦片的状态号长期不变 → 模型永远拿不到集合 → 只有“瓦片整块
   * 剔除”而没有逐像素剖面（地表不随刀面切、成片消失）。
   * @param {object} tile 起始瓦片
   * @returns {number} 实际变更的模型数
   */
  assignClippingToTile(tile) {
    if (!tile || !this.isTilesetAlive()) return 0
    const collection = this.hasActiveClipping() ? this.tileset.clippingPlanes : undefined
    let changed = 0
    const walk = node => {
      if (!node) return
      try {
        const model = node.content && node.content._model
        if (model && model._clippingPlanes !== collection) {
          model._clippingPlanes = collection
          changed++
        }
      } catch (e) {
        // 瓦片内容已卸载/不可渲染，忽略
      }
      const children = node.children
      if (children) {
        for (let i = 0; i < children.length; i++) walk(children[i])
      }
    }
    walk(tile)
    return changed
  }

  /** 全量同步：当前集合（或摘除）到所有已加载瓦片模型 */
  syncClippingToModels() {
    if (!this.isTilesetAlive() || !this.tileset.root) return 0
    return this.assignClippingToTile(this.tileset.root)
  }

  /** 新瓦片加载时补挂切割面（否则新进入视野的地表瓦片不受切割） */
  bindTileLoadClipping() {
    this.detachTileLoadClipping()
    if (!this.isTilesetAlive()) return
    this.tileLoadClippingListener = tile => {
      if (this.hasActiveClipping()) this.assignClippingToTile(tile)
    }
    this.tileset.tileLoad.addEventListener(this.tileLoadClippingListener)
  }

  detachTileLoadClipping() {
    if (this.tileLoadClippingListener && this.isTilesetAlive()) {
      this.tileset.tileLoad.removeEventListener(this.tileLoadClippingListener)
    }
    this.tileLoadClippingListener = null
  }

  /**
   * 启用切割模式
   */
  enableClipping() {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) {
      return this.createResult(false, '无可用模型进行切割')
    }

    this.clippingEnabled = true

    // 如果没有切割面，创建一个默认的
    if (this.clippingPlanes.length === 0) {
      // 使用辅助方法创建默认切割面
      this.addDefaultClippingPlane()
    }

    return this.createResult(true, '切割模式已启用')
  }

  /**
   * 添加默认切割面
   * @private
   */
  addDefaultClippingPlane() {
    // 默认刀面：X 轴正向，偏移 0 = 穿过当前切割基准（选中模型中心 / 整场景中心）
    const axis = 'X'
    const direction = '正向'
    const normal = DEFAULT_NORMAL.clone()
    const distance = 0
    const focus = this.getFocusLocal()

    // 计算基于切割基准的最大距离
    const maxDistance =
      focus && focus.radius > 0
        ? focus.radius * MAX_DISTANCE_MULTIPLIER
        : this.modelBounds
          ? this.modelBounds.radius * MAX_DISTANCE_MULTIPLIER
          : DEFAULT_MAX_DISTANCE

    const planeConfig = {
      plane: new Cesium.ClippingPlane(normal, this.distanceForOffset(normal, distance)),
      normal: normal.clone(),
      distance,
      color: '#ffffff',
      opacity: 0.0, // 与原始项目一致：透明度为0
      rotation: { x: 0, y: 0, z: 0 },
      axis,
      direction,
      maxDistance // 存储最大距离，用于后续计算
    }

    this.clippingPlanes.push(planeConfig)
    this.activeClippingPlaneIndex = 0

    // 先应用ClippingPlane到tileset
    this.applyClippingPlanes()

    // 延迟创建可视化，确保ClippingPlane已就绪
    setTimeout(() => {
      this.createPlaneVisualization(planeConfig, 0)
    }, VISUALIZATION_DELAY)
  }

  /**
   * 禁用切割模式
   */
  disableClipping() {
    this.clippingEnabled = false
    this.clearAllPlanes()
    return this.createResult(true, '切割模式已禁用')
  }

  /**
   * 添加切割面
   */
  addClippingPlane(options = {}) {
    if (!this.isViewerAlive() || !this.isTilesetAlive() || !this.modelBounds) {
      return this.createResult(false, '模型未加载完成')
    }

    const {
      normal = new Cesium.Cartesian3(0, 0, 1), // 默认沿Z轴
      distance = 0,
      color = '#ffffff',
      opacity = 0.3
    } = options

    // 创建切割平面（distance 为 UI 偏移，换算成穿过基准中心的实际平面距离）
    const plane = new Cesium.ClippingPlane(normal, this.distanceForOffset(normal, distance))

    // 创建切割平面配置
    const planeConfig = {
      plane,
      normal: normal.clone(),
      distance,
      color,
      opacity,
      rotation: { x: 0, y: 0, z: 0 }, // 统一使用x,y,z命名
      axis: 'X',
      direction: '正向'
    }

    this.clippingPlanes.push(planeConfig)
    this.activeClippingPlaneIndex = this.clippingPlanes.length - 1

    // 先应用ClippingPlane
    this.applyClippingPlanes()

    // 延迟创建可视化
    setTimeout(() => {
      this.createPlaneVisualization(planeConfig, this.activeClippingPlaneIndex)
    }, VISUALIZATION_DELAY)

    return {
      success: true,
      message: `切割面 ${this.clippingPlanes.length} 已添加`,
      index: this.activeClippingPlaneIndex
    }
  }

  /**
   * 获取Tileset的世界变换信息
   */
  getTilesetTransformInfo() {
    if (!this.isTilesetAlive()) return null

    const modelMatrix = this.tileset.modelMatrix
    const rootTransform = this.tileset.root ? this.tileset.root.transform : Cesium.Matrix4.IDENTITY

    // 总变换: modelMatrix * rootTransform
    const transform = Cesium.Matrix4.multiply(modelMatrix, rootTransform, new Cesium.Matrix4())

    const position = Cesium.Matrix4.getTranslation(transform, new Cesium.Cartesian3())
    const rotationMatrix = Cesium.Matrix4.getMatrix3(transform, new Cesium.Matrix3())
    const orientation = Cesium.Quaternion.fromRotationMatrix(rotationMatrix)

    return { position, orientation, transform }
  }

  /**
   * 切割面参考坐标系：Cesium3DTileset 的 clippingPlanesOriginMatrix
   * （无变换时即为 root.computedTransform，等价于瓦片集根坐标系）。
   */
  getClipFrameMatrix() {
    if (!this.isTilesetAlive()) return Cesium.Matrix4.IDENTITY
    return this.tileset.clippingPlanesOriginMatrix || Cesium.Matrix4.IDENTITY
  }

  /** 世界坐标 → 切割面参考坐标系 */
  worldToClipFrame(point) {
    if (!point) return null
    const inverse = Cesium.Matrix4.inverse(this.getClipFrameMatrix(), new Cesium.Matrix4())
    return Cesium.Matrix4.multiplyByPoint(inverse, point, new Cesium.Cartesian3())
  }

  /**
   * 当前切割基准：优先用选中模型的包围球，否则回退整场景包围球。
   * @returns {{center: Cesium.Cartesian3, radius: number}|null} 切割面坐标系下的中心与半径(米)
   */
  getFocusLocal() {
    if (!this.isTilesetAlive()) return null
    const sphere = this.clipFocus || this.modelBounds || this.tileset.boundingSphere
    if (!sphere || !sphere.center) return null
    return {
      center: this.worldToClipFrame(sphere.center),
      radius: Number(sphere.radius) || 0
    }
  }

  /**
   * 设置切割基准（选中模型的包围球）。传入 null 则回退整场景包围球中心。
   * 基准变了会按各刀面当前法向量重算实际平面距离，并重建可视化面片。
   * @param {{center: Cesium.Cartesian3, radius: number}|null} focus 世界坐标包围球
   */
  setClipFocus(focus) {
    const center = focus && focus.center
    this.clipFocus = center
      ? {
        center: Cesium.Cartesian3.clone(center, new Cesium.Cartesian3()),
        radius: Number(focus.radius) || 0
      }
      : null
    if (!this.isTilesetAlive()) return this.createResult(false, '模型未加载')

    this.clippingPlanes.forEach(config => this.applyEffectiveDistance(config))
    this.refreshAllVisualizations()
    return this.createResult(true, '切割基准已更新')
  }

  /**
   * UI 偏移 → Cesium 平面距离。
   * ClippingPlane 的 distance 以参考坐标系原点量起；这里把偏移 0 定义为
   * “刀面穿过基准中心”，UI 正值沿法线正方向平移。
   * @param {Cesium.Cartesian3} normal 当前法向量（参考坐标系下）
   * @param {number} offset UI 偏移(米)
   */
  distanceForOffset(normal, offset) {
    const focus = this.getFocusLocal()
    const base = focus ? -Cesium.Cartesian3.dot(normal, focus.center) : 0
    return base - (Number(offset) || 0)
  }

  /**
   * 面板量程信息：基准半径 / 整场景半径 / 两中心距离。
   * 量程需同时覆盖“选中模型自身”与“从基准中心扫到整场景边缘”，
   * 否则地表这种跨千米大面片会出现“滑块到底还没切完”。
   */
  getClipRangeInfo() {
    const focus = this.getFocusLocal()
    const scene = this.modelBounds || (this.isTilesetAlive() ? this.tileset.boundingSphere : null)
    const sceneRadius = Number(scene?.radius) || 0
    let centerOffset = 0
    if (focus && scene && scene.center) {
      centerOffset = Cesium.Cartesian3.distance(focus.center, this.worldToClipFrame(scene.center))
    }
    return { focusRadius: focus?.radius || 0, sceneRadius, centerOffset }
  }

  /** 按刀面当前法向量把 UI 偏移换算成实际平面距离 */
  applyEffectiveDistance(planeConfig) {
    if (!planeConfig || !planeConfig.plane) return
    planeConfig.plane.distance = this.distanceForOffset(
      planeConfig.plane.normal,
      planeConfig.distance
    )
  }

  /**
   * 创建切割面可视化 - 使用CallbackProperty实现动态更新
   */
  createPlaneVisualization(planeConfig, index) {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) return
    if (!this.modelBounds && !this.clipFocus) return

    const sceneCenter = this.modelBounds?.center || this.tileset.boundingSphere.center
    const sceneRadius = this.modelBounds?.radius || this.tileset.boundingSphere.radius
    // 可视化面片贴合当前切割基准：位置取基准中心，尺寸按基准半径；随瓦片集变换/基准变化重算
    const positionCallback = new Cesium.CallbackProperty(() => {
      const focus = this.getFocusLocal()
      if (!focus) return this.tileset?.boundingSphere?.center || sceneCenter
      return Cesium.Matrix4.multiplyByPoint(
        this.getClipFrameMatrix(),
        focus.center,
        new Cesium.Cartesian3()
      )
    }, false)

    // 方向与切割面参考系一致：保证面片与真实剖面共面
    const orientationCallback = new Cesium.CallbackProperty(() => {
      const rotation = Cesium.Matrix4.getMatrix3(this.getClipFrameMatrix(), new Cesium.Matrix3())
      return Cesium.Quaternion.fromRotationMatrix(rotation)
    }, false)

    // 创建动态更新函数 - 与原始项目一致
    const createPlaneUpdateFunction = () => {
      return new Cesium.CallbackProperty(() => {
        // 获取当前切割面配置
        const currentConfig = this.clippingPlanes[index]
        if (!currentConfig) return new Cesium.Plane(this.getBaseNormal('X', '正向'), 0)

        // 获取轴和方向
        const axis = currentConfig.axis || 'X'
        const direction = currentConfig.direction || '正向'

        // 使用辅助方法获取基础法向量 (本地坐标系)
        const baseNormal = this.getBaseNormal(axis, direction)

        // 应用旋转控制 - 使用辅助方法计算旋转后的法向量 (本地坐标系)
        const rotationX = currentConfig.rotation?.x || 0
        const rotationY = currentConfig.rotation?.y || 0
        const rotationZ = currentConfig.rotation?.z || 0

        // 计算旋转后的法向量 (本地坐标系)
        const rotatedNormal = this.calculateRotatedNormal(
          rotationX,
          rotationY,
          rotationZ,
          baseNormal
        )

        // 返回更新后的Plane（Entity 位于切割基准中心、朝向与切割面参考系一致，
        // 因此这里只需把 UI 偏移转换成相对基准中心的平面距离）
        return new Cesium.Plane(rotatedNormal, -Number(currentConfig.distance || 0))
      }, false)
    }

    // 面片尺寸贴合切割基准半径（无基准时回退整场景半径）
    const focusRadius =
      (this.clipFocus && Number(this.clipFocus.radius)) || sceneRadius || DEFAULT_MAX_DISTANCE
    const planeSize = Math.max(20, focusRadius * 2.2)

    // 创建平面实体
    const planeEntity = this.viewer.entities.add({
      id: `clipping-plane-${index}`,
      position: positionCallback, // 切割基准中心（跟随瓦片集变换）
      orientation: orientationCallback, // 切割面参考系朝向
      height: undefined, // 使用 Entity 坐标系，不额外设height
      // 面片中心取 Entity.position 在平面上的投影点：即刀面穿过基准中心的位置
      plane: {
        dimensions: new Cesium.Cartesian2(planeSize, planeSize),
        material: Cesium.Color.WHITE.withAlpha(0.0), // 与原始项目一致：完全透明
        plane: createPlaneUpdateFunction(), // 使用CallbackProperty
        outline: true,
        outlineColor: Cesium.Color.WHITE // 与原始项目一致
      }
    })

    this.planeEntities[index] = planeEntity
  }

  /**
   * 创建旋转矩阵
   * @param {number} rotationX - X轴旋转角度（度）
   * @param {number} rotationY - Y轴旋转角度（度）
   * @param {number} rotationZ - Z轴旋转角度（度）
   * @returns {Cesium.Matrix3} 旋转矩阵
   */
  createRotationMatrix(rotationX, rotationY, rotationZ) {
    // 创建旋转矩阵 - 旋转顺序：Z→Y→X
    const rotationMatrix = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(Number(rotationZ)))
    Cesium.Matrix3.multiply(
      Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(Number(rotationY))),
      rotationMatrix,
      rotationMatrix
    )
    Cesium.Matrix3.multiply(
      Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(Number(rotationX))),
      rotationMatrix,
      rotationMatrix
    )
    return rotationMatrix
  }

  /**
   * 计算法线向量
   * @param {number} rotationX - X轴旋转角度（度）
   * @param {number} rotationY - Y轴旋转角度（度）
   * @param {number} rotationZ - Z轴旋转角度（度）
   * @param {Cesium.Cartesian3} baseNormal - 基础法线方向（可选，默认为X轴正方向）
   * @returns {Cesium.Cartesian3} 旋转后的法线向量
   */
  calculateRotatedNormal(
    rotationX,
    rotationY,
    rotationZ,
    baseNormal = new Cesium.Cartesian3(1.0, 0.0, 0.0)
  ) {
    // 创建旋转矩阵
    const rotationMatrix = this.createRotationMatrix(rotationX, rotationY, rotationZ)

    // 应用旋转到法线方向
    return Cesium.Matrix3.multiplyByVector(rotationMatrix, baseNormal, new Cesium.Cartesian3())
  }

  /**
   * 旋转切割面 - 与原始项目一致的旋转控制方法
   */
  rotatePlane(index, rotationX, rotationY, rotationZ) {
    if (!this.tileset || !this.modelBounds || index >= this.clippingPlanes.length) {
      return this.createResult(false, '无效的切割面索引')
    }
    const planeConfig = this.clippingPlanes[index]

    // 更新旋转角度
    planeConfig.rotation.x = rotationX
    planeConfig.rotation.y = rotationY
    planeConfig.rotation.z = rotationZ

    // 获取基础法向量
    const baseNormal = this.getBaseNormal(planeConfig.axis || 'X', planeConfig.direction || '正向')

    // 计算旋转后的法线
    const rotatedNormal = this.calculateRotatedNormal(rotationX, rotationY, rotationZ, baseNormal)

    // 更新配置中的法线
    planeConfig.normal = rotatedNormal

    // 关键：直接更新原有的ClippingPlane对象的normal属性
    // 这样ClippingPlaneCollection会自动检测到变化
    planeConfig.plane.normal = rotatedNormal

    // 法向量变了 → 以切割基准中心重新换算实际平面距离（UI 偏移保持不变）
    this.applyEffectiveDistance(planeConfig)

    // 注意：不需要重新应用ClippingPlanes，因为我们直接修改了plane对象
    // 回调属性会自动处理可视化更新

    return this.createResult(
      true,
      `切割面已旋转：X=${rotationX}°, Y=${rotationY}°, Z=${rotationZ}°`
    )
  }

  /**
   * 更新切割面可视化 - CallbackProperty会自动处理plane更新，只需更新颜色和透明度
   */
  updatePlaneVisualization(index) {
    if (!this.isViewerAlive() || index >= this.planeEntities.length) return

    const planeConfig = this.clippingPlanes[index]
    const planeEntity = this.planeEntities[index]

    if (!planeEntity || (!this.modelBounds && !this.clipFocus)) return

    // 转换颜色为Cesium.Color并应用透明度
    const cesiumColor = Cesium.Color.fromCssColorString(planeConfig.color).withAlpha(
      planeConfig.opacity
    )

    // 只更新材质，plane由CallbackProperty自动更新
    planeEntity.plane.material = cesiumColor
  }

  /**
   * 复用/创建 tileset 的 ClippingPlaneCollection。
   * 关键：已加载瓦片的 model.clippingPlanes 持有的是**集合对象引用**，而 Cesium 只在
   * clippingPlanesState（=平面个数）变化时才刷新瓦片引用。若每次应用都新建集合，
   * 旧瓦片（尤其地表这种一直跟切面相交的大瓦片）会停在旧集合上；而 ClippingPlane 的
   * onChangeCallback 只能指向一个集合，旧集合的刀面数据不再更新 → 表现为
   * “地表不随切面切割、只在整块剔除时才成片消失”。因此这里一律复用同一集合。
   */
  ensureClippingCollection(planes, options = {}) {
    if (!this.isTilesetAlive()) return null
    const { unionClippingRegions = true, edgeWidth = 1.0, edgeColor } = options
    const existing = this.tileset.clippingPlanes
    const alive =
      existing && !(typeof existing.isDestroyed === 'function' && existing.isDestroyed())

    try {
      if (!alive) {
        const created = new Cesium.ClippingPlaneCollection({
          planes,
          edgeWidth,
          unionClippingRegions,
          enabled: this.clippingEnabled
        })
        if (edgeColor) created.edgeColor = edgeColor
        this.tileset.clippingPlanes = created
        this.syncClippingToModels()
        return created
      }

      // 复用同一个集合：清空后重新挂入当前平面（重新绑定 onChangeCallback）
      existing.removeAll()
      planes.forEach(plane => existing.add(plane))
      existing.unionClippingRegions = unionClippingRegions
      existing.edgeWidth = edgeWidth
      if (edgeColor) existing.edgeColor = edgeColor
      existing.enabled = this.clippingEnabled
      this.syncClippingToModels()
      return existing
    } catch (e) {
      return null
    }
  }

  /**
   * 应用切割平面集合到tileset
   */
  applyClippingPlanes() {
    if (!this.isTilesetAlive()) return

    if (this.clippingPlanes.length === 0) {
      this.clearTilesetClippingPlanes()
      return
    }

    const planes = this.clippingPlanes.map(config => config.plane)
    this.ensureClippingCollection(planes, { unionClippingRegions: true, edgeWidth: 1.0 })
  }

  /**
   * 清理tileset的切割平面（不销毁集合对象：瓦片仍然引用它，销毁会造成
   * “旧瓦片持有已销毁集合”的诡异渲染）。仅禁用并清空平面。
   */
  clearTilesetClippingPlanes() {
    if (!this.isTilesetAlive()) return

    const collection = this.tileset.clippingPlanes
    if (!collection) return
    try {
      collection.enabled = false
      collection.removeAll()
      // 已加载瓦片模型也同步摘除，避免残留剖面
      this.syncClippingToModels()
    } catch (e) {
      // Ignore cleanup failures when tileset clipping state is already invalidated.
      void e
    }
  }

  /**
   * 更新切割面参数
   */
  updatePlaneDistance(index, planeConfig, distance) {
    if (distance === undefined) return
    // distance 为 UI 偏移（0 = 刀面穿过切割基准中心）
    planeConfig.distance = Number(distance)
    this.applyEffectiveDistance(planeConfig)
  }

  updatePlaneRotation(index, planeConfig, params) {
    if (
      params.rotationX === undefined &&
      params.rotationY === undefined &&
      params.rotationZ === undefined
    ) {
      return
    }
    const rotationX = Number(
      params.rotationX !== undefined ? params.rotationX : planeConfig.rotation?.x || 0
    )
    const rotationY = Number(
      params.rotationY !== undefined ? params.rotationY : planeConfig.rotation?.y || 0
    )
    const rotationZ = Number(
      params.rotationZ !== undefined ? params.rotationZ : planeConfig.rotation?.z || 0
    )
    this.rotatePlane(index, rotationX, rotationY, rotationZ)
  }

  updatePlaneAppearance(planeConfig, params) {
    if (params.color !== undefined) planeConfig.color = params.color
    if (params.opacity !== undefined) planeConfig.opacity = params.opacity
  }

  updatePlaneAxisDirection(planeConfig, params) {
    let needsNormalUpdate = false
    if (params.axis !== undefined) {
      planeConfig.axis = params.axis
      needsNormalUpdate = true
    }
    if (params.direction !== undefined) {
      planeConfig.direction = params.direction
      needsNormalUpdate = true
    }
    return needsNormalUpdate
  }

  updateClippingPlane(index, params) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return this.createResult(false, '切割面索引无效')
    }

    const planeConfig = this.clippingPlanes[index]
    this.updatePlaneDistance(index, planeConfig, params.distance)
    this.updatePlaneRotation(index, planeConfig, params)
    this.updatePlaneAppearance(planeConfig, params)
    if (this.updatePlaneAxisDirection(planeConfig, params)) {
      this.updatePlaneNormalFromAxisAndDirection(index)
    }

    this.updatePlaneVisualization(index)
    // 刀面参数变了：确保已加载瓦片模型都持有当前集合（地表等大瓦片尤其需要）
    this.syncClippingToModels()
    return this.createResult(true, `切割面 ${index + 1} 已更新`)
  }

  /**
   * 移除指定切割面
   */
  removeClippingPlane(index) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return this.createResult(false, '切割面索引无效')
    }

    const targetEntity = this.planeEntities[index]
    this.removeViewerEntity(targetEntity, {
      beforeRemove: planeEntity => {
        if (planeEntity.plane) {
          planeEntity.plane.material = undefined
          planeEntity.plane = undefined
        }
      },
      errorMessage: 'Failed to remove plane entity:'
    })

    // 移除切割面配置
    this.clippingPlanes.splice(index, 1)
    this.planeEntities.splice(index, 1)

    // 更新激活索引
    if (this.activeClippingPlaneIndex === index) {
      this.activeClippingPlaneIndex = this.clippingPlanes.length > 0 ? 0 : null
    } else if (this.activeClippingPlaneIndex > index) {
      this.activeClippingPlaneIndex--
    }

    // 重要：先重新应用切割平面，确保Cesium渲染状态正确
    this.applyClippingPlanes()

    // 只有当还有切割面时才重新创建可视化
    this.refreshAllVisualizations()
    return this.createResult(true, `切割面 ${index + 1} 已移除`)
  }

  /**
   * 刷新所有可视化
   */
  refreshAllVisualizations() {
    this.clearPlaneEntities({
      resetState: true,
      errorMessage: 'Failed to remove entity during refresh:'
    })

    // 只有当切割面数组不为空时才重新创建可视化
    if (this.clippingPlanes.length > 0) {
      this.clippingPlanes.forEach((planeConfig, index) => {
        this.createPlaneVisualization(planeConfig, index)
      })
    }
  }

  /**
   * 清除所有切割面
   */
  clearAllPlanes() {
    // 清理tileset的切割平面
    this.clearTilesetClippingPlanes()

    // 移除所有可视化Entity
    this.clearPlaneEntities({ resetState: true })

    // 清空数组引用，确保没有悬空引用
    this.clippingPlanes = []
    this.activeClippingPlaneIndex = null

    return this.createResult(true, '所有切割面已清除')
  }

  /**
   * 清理所有平面实体
   */
  clearPlaneEntities(options = {}) {
    const { resetState = false, errorMessage = 'Failed to remove plane entity:' } = options
    this.removeViewerEntities(this.planeEntities, {
      beforeRemove: planeEntity => {
        if (planeEntity.plane) {
          planeEntity.plane.material = undefined
          planeEntity.plane = undefined
        }
      },
      errorMessage
    })
    if (resetState) this.planeEntities = []
  }

  /**
   * 设置激活的切割面
   */
  setActivePlane(index) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return this.createResult(false, '切割面索引无效')
    }

    this.activeClippingPlaneIndex = index
    return this.createResult(true, `已选择切割面 ${index + 1}`)
  }

  /**
   * 获取激活的切割面配置
   */
  getActivePlaneConfig() {
    if (this.activeClippingPlaneIndex === null) return null
    return this.clippingPlanes[this.activeClippingPlaneIndex]
  }

  /**
   * 根据轴和方向更新切割面法向量
   */
  updatePlaneNormalFromAxisAndDirection(index) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return
    }

    const planeConfig = this.clippingPlanes[index]
    const { axis, direction, rotation } = planeConfig

    // 使用辅助方法获取基础法向量
    const baseNormal = this.getBaseNormal(axis, direction)

    // 应用当前的旋转角度到新的基础法向量
    const rotationX = rotation?.x || 0
    const rotationY = rotation?.y || 0
    const rotationZ = rotation?.z || 0
    const rotatedNormal = this.calculateRotatedNormal(rotationX, rotationY, rotationZ, baseNormal)

    // 更新切割面的法向量
    planeConfig.normal = rotatedNormal
    planeConfig.plane.normal = rotatedNormal

    // 法向量变了 → 重算实际平面距离（偏移 0 始终表示刀面穿过切割基准中心；
    // 不再像旧逻辑那样翻转 UI 偏移）
    this.applyEffectiveDistance(planeConfig)

    // 重新应用切割平面
    this.applyClippingPlanes()

    // 更新可视化
    this.updatePlaneVisualization(index)
  }

  /**
   * 根据轴和方向获取基础法向量
   * @param {string} axis - 轴 ('X', 'Y', 'Z')
   * @param {string} direction - 方向 ('正向', '反向')
   * @returns {Cesium.Cartesian3} 基础法向量
   */
  getBaseNormal(axis, direction) {
    // 根据轴确定基础法向量
    let normal
    switch (axis) {
      case 'X':
        normal = Cesium.Cartesian3.UNIT_X
        break
      case 'Y':
        normal = Cesium.Cartesian3.UNIT_Y
        break
      case 'Z':
        normal = Cesium.Cartesian3.UNIT_Z
        break
      default:
        normal = Cesium.Cartesian3.UNIT_X
    }

    // 根据方向调整法向量（反向时取反）
    if (direction === '反向') {
      normal = Cesium.Cartesian3.negate(normal, new Cesium.Cartesian3())
    }

    return normal
  }

  /**
   * 获取所有切割面配置
   */
  getAllPlaneConfigs() {
    return this.clippingPlanes.map((config, index) => ({
      index,
      distance: config.distance,
      rotation: config.rotation,
      color: config.color,
      opacity: config.opacity,
      axis: config.axis || 'X',
      direction: config.direction || '正向',
      isActive: index === this.activeClippingPlaneIndex
    }))
  }

  /**
   * 重置切割面到默认状态
   */
  resetClippingPlane(index) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return this.createResult(false, '切割面索引无效')
    }

    // 重置切割面参数到默认值
    const result = this.updateClippingPlane(index, {
      distance: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      opacity: 0.0,
      color: '#ffffff',
      axis: 'X',
      direction: '正向'
    })

    return result
  }

  /**
   * 启用多边形切割模式
   */
  enablePolygonClipping() {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) {
      return this.createResult(false, '无可用模型进行多边形切割')
    }

    this.polygonClippingEnabled = true

    try {
      this.clippingPolygonCollection = new Cesium.ClippingPolygonCollection({
        edgeColor: Cesium.Color.YELLOW,
        edgeWidth: 2.0,
        unionClippingRegions: false
      })
      this.tileset.clippingPolygons = this.clippingPolygonCollection
    } catch (e) {
      this.clippingPolygonCollection = null
      this.polygonClippingEnabled = false
      return this.createResult(false, '多边形切割初始化失败')
    }

    return this.createResult(true, '多边形切割模式已启用')
  }

  /**
   * 禁用多边形切割模式
   */
  disablePolygonClipping() {
    this.polygonClippingEnabled = false
    this.stopDrawingPolygon()
    this.clearAllPolygons()
    return this.createResult(true, '多边形切割模式已禁用')
  }

  /**
   * 切换绘制状态 - 与原始项目一致，一个按钮切换开始/结束
   */
  toggleDrawingPolygon() {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) {
      return this.createResult(false, '模型或视图未准备好')
    }

    if (this.isDrawingPolygon) {
      // 结束绘制
      return this.stopDrawingPolygon()
    } else {
      // 开始绘制
      return this.startDrawingPolygon()
    }
  }

  /**
   * 开始绘制多边形 - 内部方法
   */
  startDrawingPolygon() {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) {
      return this.createResult(false, '模型或视图未准备好')
    }

    this.isDrawingPolygon = true
    this.currentPolygon = []
    this.hoverPolygonPoint = null

    // 清除之前的临时多边形
    this.clearPolygonEntity()

    // 清除之前的点标记
    this.clearPointEntities()

    return this.createResult(true, '开始绘制多边形')
  }

  /**
   * 设置多边形切割深度
   */
  setPolygonDepth(depth) {
    this.polygonDepth = Number(depth) || 0

    // 如果有已存在的多边形，立即更新
    if (this.lastPolygonPositions && this.lastPolygonPositions.length > 0) {
      this.refreshPolygonClipping()
    }

    return this.createResult(true, `切割深度已设置为 ${this.polygonDepth}米`)
  }

  /**
   * 设置多边形切割方向
   * @param {string} direction 'excavate' | 'isolate'
   */
  setPolygonDirection(direction) {
    if (direction !== 'excavate' && direction !== 'isolate') {
      return this.createResult(false, '无效的方向参数')
    }
    this.polygonDirection = direction

    // 如果当前正在绘制且点数足够，也可立即应用
    if (
      (!this.lastPolygonPositions || this.lastPolygonPositions.length === 0) &&
      this.currentPolygon &&
      this.currentPolygon.length >= 3
    ) {
      this.lastPolygonPositions = [...this.currentPolygon]
    }

    // 如果有已存在的多边形，立即更新
    if (this.lastPolygonPositions && this.lastPolygonPositions.length > 0) {
      this.refreshPolygonClipping()
    }

    return this.createResult(true, `切割模式已设置为 ${direction === 'excavate' ? '挖掘' : '保留'}`)
  }

  setPolygonVisualizationOpacity(opacity) {
    const normalized = Math.max(0, Math.min(1, Number(opacity)))
    this.polygonVisualizationOpacity = Number.isFinite(normalized) ? normalized : 0.35
    this.updateExcavationVisualizationStyle()
    return this.createResult(
      true,
      `挖掘轮廓透明度已设置为 ${Math.round(this.polygonVisualizationOpacity * 100)}%`
    )
  }

  /**
   * 重置多边形设置
   */
  resetPolygonSettings() {
    this.polygonDepth = 0
    this.polygonDirection = 'excavate'
    this.polygonVisualizationOpacity = 0.35
    this.clearAllPolygons()
    return this.createResult(true, '多边形设置已重置')
  }

  /**
   * 刷新多边形切割（应用新的深度或方向）
   */
  refreshPolygonClipping() {
    if (!this.lastPolygonPositions || this.lastPolygonPositions.length < 3) return

    if (this.polygonDepth > 0) {
      this.applyPolygonExcavation(this.lastPolygonPositions)
    } else {
      this.applyPolygonClipping(this.lastPolygonPositions)
    }
  }

  /**
   * 应用带深度的多边形挖掘
   */
  applyPolygonExcavation(positions) {
    if (!this.isViewerAlive() || !this.isTilesetAlive())
      return this.createResult(false, '模型未准备好')

    this.lastPolygonPositions = positions

    if (this.tileset.clippingPolygons) {
      this.tileset.clippingPolygons = undefined
      this.clippingPolygonCollection = null
    }

    const transformInfo = this.getTilesetTransformInfo()
    if (!transformInfo) return this.createResult(false, '无法获取模型变换')
    const inverseTransform = Cesium.Matrix4.inverse(transformInfo.transform, new Cesium.Matrix4())
    const { localPositions, projectedPositions, center, up } = this.buildPolygonFrame(
      positions,
      inverseTransform
    )
    const isExcavate = this.polygonDirection === 'excavate'
    const planes = this.createExcavationPlanes(projectedPositions, center, up, isExcavate)
    const applied = this.applyExcavationPlanes(planes, isExcavate)
    if (!applied.success) return applied
    this.updateExcavationVisualization(
      localPositions,
      projectedPositions,
      up,
      center,
      transformInfo.transform,
      isExcavate
    )
    this.cleanupDrawingEntities()

    return this.createResult(
      true,
      `已应用深度为 ${this.polygonDepth}米 的${isExcavate ? '挖掘' : '保留'}`
    )
  }

  buildPolygonFrame(positions, inverseTransform) {
    const localPositions = positions.map(pos =>
      Cesium.Matrix4.multiplyByPoint(inverseTransform, pos, new Cesium.Cartesian3())
    )
    const center = Cesium.Cartesian3.ZERO.clone()
    localPositions.forEach(p => Cesium.Cartesian3.add(center, p, center))
    Cesium.Cartesian3.divideByScalar(center, localPositions.length, center)
    const centerWorld = Cesium.Matrix4.multiplyByPoint(
      Cesium.Matrix4.inverse(inverseTransform, new Cesium.Matrix4()),
      center,
      new Cesium.Cartesian3()
    )
    const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(centerWorld)
    const upWorld = Cesium.Matrix4.multiplyByPointAsVector(
      enuTransform,
      Cesium.Cartesian3.UNIT_Z,
      new Cesium.Cartesian3()
    )
    const up = Cesium.Matrix4.multiplyByPointAsVector(
      inverseTransform,
      upWorld,
      new Cesium.Cartesian3()
    )
    Cesium.Cartesian3.normalize(up, up)
    const projectedPositions = localPositions.map(position => {
      const offset = Cesium.Cartesian3.subtract(position, center, new Cesium.Cartesian3())
      const heightOffset = Cesium.Cartesian3.dot(offset, up)
      return Cesium.Cartesian3.subtract(
        position,
        Cesium.Cartesian3.multiplyByScalar(up, heightOffset, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      )
    })
    return { localPositions, projectedPositions, center, up }
  }

  createExcavationPlanes(projectedPositions, center, up, isExcavate) {
    const planes = []
    const downDirection = Cesium.Cartesian3.negate(up, new Cesium.Cartesian3())
    const bottomNormal = isExcavate ? downDirection.clone() : up.clone()
    const depthVector = Cesium.Cartesian3.multiplyByScalar(
      downDirection,
      this.polygonDepth,
      new Cesium.Cartesian3()
    )
    const bottomPoint = Cesium.Cartesian3.add(center, depthVector, new Cesium.Cartesian3())
    const bottomDistance = -Cesium.Cartesian3.dot(bottomNormal, bottomPoint)
    planes.push(new Cesium.ClippingPlane(bottomNormal, bottomDistance))
    for (let i = 0; i < projectedPositions.length; i++) {
      const p1 = projectedPositions[i]
      const p2 = projectedPositions[(i + 1) % projectedPositions.length]
      if (Cesium.Cartesian3.distance(p1, p2) < 0.001) continue
      const edge = Cesium.Cartesian3.subtract(p2, p1, new Cesium.Cartesian3())
      const sideNormal = Cesium.Cartesian3.cross(edge, up, new Cesium.Cartesian3())
      Cesium.Cartesian3.normalize(sideNormal, sideNormal)
      const toCenter = Cesium.Cartesian3.subtract(center, p1, new Cesium.Cartesian3())
      if (Cesium.Cartesian3.dot(sideNormal, toCenter) > 0) {
        Cesium.Cartesian3.negate(sideNormal, sideNormal)
      }
      if (!isExcavate) {
        Cesium.Cartesian3.negate(sideNormal, sideNormal)
      }
      const distance = -Cesium.Cartesian3.dot(sideNormal, p1)
      planes.push(new Cesium.ClippingPlane(sideNormal, distance))
    }
    return planes
  }

  applyExcavationPlanes(planes, isExcavate) {
    this.clearAllPlanes()
    try {
      // 同样复用同一个 ClippingPlaneCollection，避免旧瓦片停在被销毁的集合上
      const applied = this.ensureClippingCollection(planes, {
        unionClippingRegions: !isExcavate,
        edgeWidth: 1.0,
        edgeColor: Cesium.Color.RED
      })
      if (!applied) return this.createResult(false, '创建挖掘面失败')
      applied.enabled = true
      return this.createResult(true, '')
    } catch (e) {
      console.error('Failed to create excavation planes:', e)
      return this.createResult(false, '创建挖掘面失败: ' + e.message)
    }
  }

  updateExcavationVisualization(
    localPositions,
    projectedPositions,
    up,
    center,
    transform,
    isExcavate
  ) {
    this.clearExcavationVisualization()
    if (
      !isExcavate ||
      !this.isViewerAlive() ||
      !Array.isArray(localPositions) ||
      localPositions.length < 3
    ) {
      return
    }
    const depthVector = Cesium.Cartesian3.multiplyByScalar(
      Cesium.Cartesian3.negate(up, new Cesium.Cartesian3()),
      this.polygonDepth,
      new Cesium.Cartesian3()
    )
    const topPositions = localPositions.map(position =>
      Cesium.Matrix4.multiplyByPoint(transform, position, new Cesium.Cartesian3())
    )
    const bottomCenter = Cesium.Cartesian3.add(center, depthVector, new Cesium.Cartesian3())
    const bottomPositions = projectedPositions.map(position =>
      Cesium.Matrix4.multiplyByPoint(
        transform,
        Cesium.Cartesian3.add(
          position,
          Cesium.Cartesian3.subtract(bottomCenter, center, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      )
    )
    const alpha = this.polygonVisualizationOpacity
    const sideColor = Cesium.Color.CYAN.withAlpha(Math.max(0, alpha))
    const bottomColor = Cesium.Color.CYAN.withAlpha(Math.max(0, alpha * 0.8))
    const edgeColor = Cesium.Color.WHITE.withAlpha(Math.max(0, alpha))

    this.excavationSideEntities = []
    for (let i = 0; i < topPositions.length; i++) {
      const nextIndex = (i + 1) % topPositions.length
      this.excavationSideEntities.push(
        this.viewer.entities.add({
          polygon: {
            hierarchy: [
              topPositions[i],
              topPositions[nextIndex],
              bottomPositions[nextIndex],
              bottomPositions[i]
            ],
            perPositionHeight: true,
            material: sideColor,
            outline: true,
            outlineColor: edgeColor
          }
        })
      )
    }

    this.excavationBottomEntity = this.viewer.entities.add({
      polygon: {
        hierarchy: bottomPositions,
        perPositionHeight: true,
        material: bottomColor,
        outline: true,
        outlineColor: edgeColor
      }
    })

    this.excavationBottomEdgeEntity = this.viewer.entities.add({
      polyline: {
        positions: [...bottomPositions, bottomPositions[0]],
        width: 2,
        material: edgeColor
      }
    })
  }

  updateExcavationVisualizationStyle() {
    const alpha = this.polygonVisualizationOpacity
    const sideColor = Cesium.Color.CYAN.withAlpha(Math.max(0, alpha))
    const bottomColor = Cesium.Color.CYAN.withAlpha(Math.max(0, alpha * 0.8))
    const edgeColor = Cesium.Color.WHITE.withAlpha(Math.max(0, alpha))
    this.excavationSideEntities.forEach(entity => {
      if (!entity?.polygon) return
      entity.polygon.material = sideColor
      entity.polygon.outlineColor = edgeColor
    })
    if (this.excavationBottomEntity?.polygon) {
      this.excavationBottomEntity.polygon.material = bottomColor
      this.excavationBottomEntity.polygon.outlineColor = edgeColor
    }
    if (this.excavationBottomEdgeEntity?.polyline) {
      this.excavationBottomEdgeEntity.polyline.material = edgeColor
    }
  }

  clearExcavationVisualization() {
    this.removeViewerEntities(this.excavationSideEntities, {
      errorMessage: 'Failed to remove excavation side entity'
    })
    this.removeViewerEntity(this.excavationBottomEntity, {
      errorMessage: 'Failed to remove excavation bottom entity'
    })
    this.removeViewerEntity(this.excavationBottomEdgeEntity, {
      errorMessage: 'Failed to remove excavation edge entity'
    })
    this.excavationSideEntities = []
    this.excavationBottomEntity = null
    this.excavationBottomEdgeEntity = null
  }

  cleanupDrawingEntities() {
    this.clearPolygonEntity()
    this.clearPointEntities()
    this.currentPolygon = []
  }

  /**
   * 停止绘制多边形 - 内部方法
   */
  stopDrawingPolygon() {
    this.isDrawingPolygon = false
    this.hoverPolygonPoint = null

    if (this.currentPolygon.length >= 3) {
      this.lastPolygonPositions = [...this.currentPolygon]
      this.refreshPolygonClipping()
      this.cleanupDrawingEntities()
      return this.createResult(true, '多边形已创建')
    }
    this.cleanupDrawingEntities()
    return this.createResult(false, '多边形点数量不足')
  }

  /**
   * 应用不带深度（无限深度/穿透）的多边形切割
   * 使用 Cesium.ClippingPolygonCollection
   */
  applyPolygonClipping(positions) {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) return

    this.lastPolygonPositions = positions
    this.clearAllPlanes()
    this.clearExcavationVisualization()

    // 创建闭合多边形位置
    const polygonPositions = [...positions, positions[0]]

    // 创建ClippingPolygon
    const clippingPolygon = new Cesium.ClippingPolygon({
      positions: polygonPositions,
      ellipsoid: this.viewer.scene.globe.ellipsoid
    })

    const isExcavate = this.polygonDirection === 'excavate'
    this.clearTilesetClippingPolygons()

    try {
      this.clippingPolygonCollection = new Cesium.ClippingPolygonCollection({
        polygons: [clippingPolygon],
        enabled: true,
        inverse: !isExcavate
      })
      this.tileset.clippingPolygons = this.clippingPolygonCollection
    } catch (e) {
      return
    }
  }

  /**
   * 处理鼠标点击事件（用于绘制多边形）
   */
  handleMouseClick(movement) {
    if (!this.isDrawingPolygon || !this.isViewerAlive()) {
      return
    }

    if (!movement || !movement.position) {
      return
    }

    const cartesian = this.pickPolygonPoint(movement.position)

    if (cartesian) {
      // 添加到当前多边形（保持原始的笛卡尔坐标，包含正确的高度信息）
      this.currentPolygon.push(Cesium.Cartesian3.clone(cartesian))
      this.hoverPolygonPoint = null

      // 创建点标记（红色球体）
      const pointEntity = this.viewer.entities.add({
        position: cartesian,
        point: {
          pixelSize: 8,
          color: Cesium.Color.RED,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2
        }
      })

      // 存储点标记实体
      this.pointEntities.push(pointEntity)

      this.updateDrawingPolygonEntity()

      return this.createResult(true, `已绘制 ${this.currentPolygon.length} 个点`)
    }

    return this.createResult(false, '无法拾取点')
  }

  handleMouseMove(movement) {
    if (!this.isDrawingPolygon || !this.isViewerAlive()) return
    const screenPosition = movement?.endPosition || movement?.position
    if (!screenPosition) return
    const cartesian = this.pickPolygonPoint(screenPosition)
    this.hoverPolygonPoint = cartesian ? Cesium.Cartesian3.clone(cartesian) : null
    this.updateDrawingPolygonEntity()
  }

  pickPolygonPoint(screenPosition) {
    let cartesian = null
    const pickedObject = this.viewer.scene.pick(screenPosition)
    if (Cesium.defined(pickedObject) && Cesium.defined(pickedObject.primitive)) {
      cartesian = this.viewer.scene.pickPosition(screenPosition)
    }
    if (!cartesian) {
      cartesian = this.viewer.camera.pickEllipsoid(
        screenPosition,
        this.viewer.scene.globe.ellipsoid
      )
    }
    return cartesian
  }

  updateDrawingPolygonEntity() {
    this.clearPolygonEntity()
    const previewPoints = Array.isArray(this.currentPolygon) ? this.currentPolygon.slice() : []
    if (this.hoverPolygonPoint) previewPoints.push(this.hoverPolygonPoint)
    if (previewPoints.length < 2) return
    const polygonHierarchy =
      previewPoints.length >= 3
        ? previewPoints
        : [...previewPoints, previewPoints[previewPoints.length - 1]]
    this.polygonEntity = this.viewer.entities.add({
      polygon: {
        hierarchy: polygonHierarchy,
        height: 0,
        material: Cesium.Color.BLUE.withAlpha(0.3),
        outline: true,
        outlineColor: Cesium.Color.BLUE,
        outlineWidth: 2
      },
      polyline: {
        positions: previewPoints.length >= 2 ? [...previewPoints, previewPoints[0]] : previewPoints,
        width: 2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.CYAN
        })
      }
    })
  }

  /**
   * 清除所有多边形
   */
  clearAllPolygons() {
    this.isDrawingPolygon = false
    this.clearPolygonEntity()
    this.clearPointEntities()
    this.clearPolygonClippingCollection()
    this.clearExcavationVisualization()

    if (this.shouldClearPolygonExcavationPlanes()) {
      this.clearAllPlanes()
    }

    this.resetPolygonTrackingState()

    return this.createResult(true, '所有多边形已清除')
  }

  /**
   * 清除点标记
   */
  clearPointEntities() {
    this.removeViewerEntities(this.pointEntities, { errorMessage: 'Failed to remove point entity' })
    this.pointEntities = []
  }

  removeViewerEntity(entity, options = {}) {
    if (!entity || !this.isViewerAlive()) return false
    const { beforeRemove } = options
    try {
      if (typeof beforeRemove === 'function') beforeRemove(entity)
      this.viewer.entities.remove(entity)
      return true
    } catch (e) {
      return false
    }
  }

  removeViewerEntities(entities, options = {}) {
    if (!Array.isArray(entities) || entities.length === 0) return
    entities.forEach(entity => {
      this.removeViewerEntity(entity, options)
    })
  }

  createResult(success, message) {
    return { success, message }
  }

  clearPolygonEntity() {
    if (!this.polygonEntity) return
    this.removeViewerEntity(this.polygonEntity, { errorMessage: 'Failed to remove polygon entity' })
    this.polygonEntity = null
  }

  clearPolygonClippingCollection() {
    if (this.clippingPolygonCollection) {
      try {
        this.clippingPolygonCollection.removeAll()
      } catch (e) {
        // Ignore collection cleanup failures during teardown.
      }
    }
    this.clearTilesetClippingPolygons()
    this.clippingPolygonCollection = null
  }

  clearTilesetClippingPolygons() {
    if (!this.isTilesetAlive()) return
    try {
      this.tileset.clippingPolygons = undefined
    } catch (e) {
      // Ignore cleanup failures when clipping polygons have already been detached.
    }
  }

  shouldClearPolygonExcavationPlanes() {
    return (
      Array.isArray(this.lastPolygonPositions) &&
      this.lastPolygonPositions.length > 0 &&
      this.polygonDepth > 0
    )
  }

  resetPolygonTrackingState() {
    this.currentPolygon = []
    this.lastPolygonPositions = []
    this.hoverPolygonPoint = null
  }

  resetCoreState() {
    this.clippingPlanes = []
    this.planeEntities = []
    this.clipFocus = null
    this.tileLoadClippingListener = null
    this.clippingPolygonCollection = null
    this.currentPolygon = []
    this.lastPolygonPositions = []
    this.pointEntities = []
    this.polygonEntity = null
    this.excavationSideEntities = []
    this.excavationBottomEntity = null
    this.excavationBottomEdgeEntity = null
    this.isDrawingPolygon = false
    this.activeClippingPlaneIndex = null
  }

  /**
   * 清理资源
   */
  destroy() {
    const viewer = this.viewer
    const viewerAlive = viewer && typeof viewer.isDestroyed === 'function' && !viewer.isDestroyed()
    this.detachTileLoadClipping()
    if (viewerAlive) {
      try {
        this.clearAllPlanes()
      } catch (e) {
        // Ignore plane cleanup failures during manager teardown.
      }
      try {
        this.clearAllPolygons()
      } catch (e) {
        // Ignore polygon cleanup failures during manager teardown.
      }
    } else {
      this.resetCoreState()
    }
    this.viewer = null
    this.tileset = null
    this.modelBounds = null
  }
}

export default ClippingManager
