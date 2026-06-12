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
      this.tileset = null
      this.modelBounds = null
      return
    }

    this.tileset = tileset || null
    this.modelBounds = tileset?.boundingSphere || null
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
    // 与原始项目一致：法线为(1.0, 0.0, 0.0)，距离为0（在模型中间对半分）
    const normal = DEFAULT_NORMAL
    const distance = 0

    // 计算基于模型包围球的最大距离
    const maxDistance = this.modelBounds
      ? this.modelBounds.radius * MAX_DISTANCE_MULTIPLIER
      : DEFAULT_MAX_DISTANCE

    const planeConfig = {
      plane: new Cesium.ClippingPlane(normal, distance),
      normal: normal.clone(),
      distance,
      color: '#ffffff',
      opacity: 0.0, // 与原始项目一致：透明度为0
      rotation: { x: 0, y: 0, z: 0 },
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

    // 创建切割平面
    const plane = new Cesium.ClippingPlane(normal, distance)

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
   * 创建切割面可视化 - 使用CallbackProperty实现动态更新
   */
  createPlaneVisualization(planeConfig, index) {
    if (!this.isViewerAlive() || !this.isTilesetAlive() || !this.modelBounds) return

    const center = this.modelBounds.center
    const radius = this.modelBounds.radius
    // 位置使用CallbackProperty，跟随模型移动
    const positionCallback = new Cesium.CallbackProperty(() => {
      // 获取Tileset的变换信息
      const transformInfo = this.getTilesetTransformInfo()
      if (transformInfo) {
        return transformInfo.position
      }
      // 降级方案：使用包围球中心（可能不准确）
      return this.tileset?.boundingSphere?.center || center
    }, false)

    // 方向（旋转）使用CallbackProperty
    const orientationCallback = new Cesium.CallbackProperty(() => {
      const transformInfo = this.getTilesetTransformInfo()
      if (transformInfo) {
        return transformInfo.orientation
      }
      return Cesium.Quaternion.IDENTITY
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

        // 返回更新后的Plane (本地法向量 + 本地距离)
        // 因为Entity已经应用了Tileset的变换(Position & Orientation)，
        // 所以这里的Plane应该是相对于Entity坐标系的（即Tileset本地坐标系）
        return new Cesium.Plane(rotatedNormal, currentConfig.distance)
      }, false)
    }

    // 创建平面实体 - 与原始项目一致的配置
    const planeEntity = this.viewer.entities.add({
      id: `clipping-plane-${index}`,
      position: positionCallback, // 使用Tileset原点
      orientation: orientationCallback, // 使用Tileset旋转
      height: undefined, // 移除height:0，因为我们现在使用Entity的坐标系，设置height可能导致它相对于球体表面定位
      // 说明：平面几何在数学上为无限平面，渲染时会绘制一个四边形面片
      // 面片中心取 Entity.position 在平面上的投影点
      // 当 Entity 使用瓦片集变换时，Entity.position 表示局部原点变换到世界坐标的位置
      // 因此面片会以局部原点在平面上的投影为中心，满足当前可视化需求
      plane: {
        dimensions: new Cesium.Cartesian2(radius * 1.5, radius * 1.5), // 调整为模型半径的1.5倍
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

    if (!planeEntity || !this.modelBounds) return

    // 转换颜色为Cesium.Color并应用透明度
    const cesiumColor = Cesium.Color.fromCssColorString(planeConfig.color).withAlpha(
      planeConfig.opacity
    )

    // 只更新材质，plane由CallbackProperty自动更新
    planeEntity.plane.material = cesiumColor
  }

  /**
   * 应用切割平面集合到tileset
   */
  applyClippingPlanes() {
    if (!this.isTilesetAlive()) return

    // 使用辅助方法清理切割平面
    this.clearTilesetClippingPlanes()

    if (this.clippingPlanes.length === 0) {
      return
    }

    const planes = this.clippingPlanes.map(config => config.plane)

    try {
      this.tileset.clippingPlanes = new Cesium.ClippingPlaneCollection({
        planes,
        // edgeColor: Cesium.Color.RED,
        edgeWidth: 1.0,
        unionClippingRegions: true,
        enabled: this.clippingEnabled
      })
    } catch (e) {
      return
    }
  }

  /**
   * 清理tileset的切割平面
   */
  clearTilesetClippingPlanes() {
    if (!this.isTilesetAlive()) return

    try {
      if (this.tileset.clippingPlanes) {
        this.tileset.clippingPlanes.enabled = false
      }
      this.tileset.clippingPlanes = undefined
    } catch (e) {
    }
  }

  /**
   * 更新切割面参数
   */
  updateClippingPlane(index, params) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return this.createResult(false, '切割面索引无效')
    }

    const planeConfig = this.clippingPlanes[index]
    let needsNormalUpdate = false

    // 更新距离
    if (params.distance !== undefined) {
      planeConfig.distance = Number(params.distance)
      // 关键：直接更新ClippingPlane对象的distance属性
      planeConfig.plane.distance = Number(params.distance)
    }

    // 更新法向量（通过旋转角度）
    if (
      params.rotationX !== undefined ||
      params.rotationY !== undefined ||
      params.rotationZ !== undefined
    ) {
      const rotationX = Number(
        params.rotationX !== undefined ? params.rotationX : planeConfig.rotation?.x || 0
      )
      const rotationY = Number(
        params.rotationY !== undefined ? params.rotationY : planeConfig.rotation?.y || 0
      )
      const rotationZ = Number(
        params.rotationZ !== undefined ? params.rotationZ : planeConfig.rotation?.z || 0
      )

      // 使用rotatePlane方法处理旋转
      this.rotatePlane(index, rotationX, rotationY, rotationZ)
    }

    // 更新颜色
    if (params.color !== undefined) {
      planeConfig.color = params.color
    }

    // 更新透明度
    if (params.opacity !== undefined) {
      planeConfig.opacity = params.opacity
    }

    // 更新轴
    if (params.axis !== undefined) {
      planeConfig.axis = params.axis
      needsNormalUpdate = true
    }

    // 更新方向
    if (params.direction !== undefined) {
      planeConfig.direction = params.direction
      needsNormalUpdate = true
    }

    // 如果轴或方向发生变化，重新计算法向量
    if (needsNormalUpdate) {
      this.updatePlaneNormalFromAxisAndDirection(index)
    }

    // 更新可视化（颜色和透明度）
    this.updatePlaneVisualization(index)

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

    // 保存当前的法向量和距离
    const currentNormal = planeConfig.normal.clone()
    const currentDistance = planeConfig.distance

    // 使用辅助方法获取基础法向量
    const baseNormal = this.getBaseNormal(axis, direction)

    // 应用当前的旋转角度到新的基础法向量
    const rotationX = rotation?.x || 0
    const rotationY = rotation?.y || 0
    const rotationZ = rotation?.z || 0
    const rotatedNormal = this.calculateRotatedNormal(rotationX, rotationY, rotationZ, baseNormal)

    // 检查法向量是否反转
    const dotProduct = Cesium.Cartesian3.dot(currentNormal, rotatedNormal)
    const isReversed = Math.abs(dotProduct + 1) < 0.0001

    // 如果法向量反转，需要同时反转distance值以保持切割面位置不变
    if (isReversed) {
      planeConfig.distance = -currentDistance
      planeConfig.plane.distance = -currentDistance
    }

    // 更新切割面的法向量
    planeConfig.normal = rotatedNormal
    planeConfig.plane.normal = rotatedNormal

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
      this.tileset.clippingPlanes = new Cesium.ClippingPlaneCollection({
        planes: planes,
        edgeWidth: 1.0,
        edgeColor: Cesium.Color.RED,
        unionClippingRegions: !isExcavate,
        enabled: true
      })
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
    const { beforeRemove, errorMessage = 'Failed to remove entity' } = options
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
    if (viewerAlive) {
      try {
        this.clearAllPlanes()
      } catch (e) {
      }
      try {
        this.clearAllPolygons()
      } catch (e) {
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
