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
export class ClippingManager {
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

    // 多边形切割深度 (0表示无限深度/穿透)
    this.polygonDepth = 0
    // 多边形切割方向 ('excavate': 挖掘/内部, 'isolate': 隔离/保留内部)
    this.polygonDirection = 'excavate'

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
      console.warn('No tileset available for clipping')
      return { success: false, message: '无可用模型进行切割' }
    }

    this.clippingEnabled = true

    // 如果没有切割面，创建一个默认的
    if (this.clippingPlanes.length === 0) {
      // 使用辅助方法创建默认切割面
      this.addDefaultClippingPlane()
    }

    return { success: true, message: '切割模式已启用' }
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
    return { success: true, message: '切割模式已禁用' }
  }

  /**
   * 添加切割面
   */
  addClippingPlane(options = {}) {
    if (!this.isViewerAlive() || !this.isTilesetAlive() || !this.modelBounds) {
      return { success: false, message: '模型未加载完成' }
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
      return { success: false, message: '无效的切割面索引' }
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

    return {
      success: true,
      message: `切割面已旋转：X=${rotationX}°, Y=${rotationY}°, Z=${rotationZ}°`
    }
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
        edgeColor: Cesium.Color.RED,
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
      console.warn('Failed to clear clipping planes:', e)
    }
  }

  /**
   * 更新切割面参数
   */
  updateClippingPlane(index, params) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return { success: false, message: '切割面索引无效' }
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

    return { success: true, message: `切割面 ${index + 1} 已更新` }
  }

  /**
   * 移除指定切割面
   */
  removeClippingPlane(index) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return { success: false, message: '切割面索引无效' }
    }

    // 移除可视化实体
    if (this.planeEntities[index] && this.viewer && this.viewer.entities) {
      try {
        const entity = this.planeEntities[index]
        // 清除plane材质引用
        if (entity.plane) {
          entity.plane.material = undefined
          entity.plane = undefined
        }
        this.viewer.entities.remove(entity)
      } catch (e) {
        console.warn('Failed to remove plane entity:', e)
      }
    }

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
    if (this.clippingPlanes.length > 0) {
      this.refreshAllVisualizations()
    } else {
      // 清除所有可视化引用，避免内存泄漏
      this.planeEntities = []
    }

    return { success: true, message: `切割面 ${index + 1} 已移除` }
  }

  /**
   * 刷新所有可视化
   */
  refreshAllVisualizations() {
    // 移除所有现有可视化
    this.planeEntities.forEach(entity => {
      if (entity && this.viewer && this.viewer.entities) {
        try {
          // 清除plane材质引用
          if (entity.plane) {
            entity.plane.material = undefined
            entity.plane = undefined
          }
          this.viewer.entities.remove(entity)
        } catch (e) {
          console.warn('Failed to remove entity during refresh:', e)
        }
      }
    })
    this.planeEntities = []

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
    this.clearPlaneEntities()

    // 清空数组引用，确保没有悬空引用
    this.clippingPlanes = []
    this.planeEntities = []
    this.activeClippingPlaneIndex = null

    return { success: true, message: '所有切割面已清除' }
  }

  /**
   * 清理所有平面实体
   */
  clearPlaneEntities() {
    this.planeEntities.forEach(entity => {
      if (entity && this.viewer && this.viewer.entities) {
        try {
          // 清除plane材质引用，避免渲染错误
          if (entity.plane) {
            entity.plane.material = undefined
            entity.plane = undefined
          }
          this.viewer.entities.remove(entity)
        } catch (e) {
          console.warn('Failed to remove plane entity:', e)
        }
      }
    })
  }

  /**
   * 设置激活的切割面
   */
  setActivePlane(index) {
    if (index < 0 || index >= this.clippingPlanes.length) {
      return { success: false, message: '切割面索引无效' }
    }

    this.activeClippingPlaneIndex = index
    return { success: true, message: `已选择切割面 ${index + 1}` }
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
      return { success: false, message: '切割面索引无效' }
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
      return { success: false, message: '无可用模型进行多边形切割' }
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
      return { success: false, message: '多边形切割初始化失败' }
    }

    return { success: true, message: '多边形切割模式已启用' }
  }

  /**
   * 禁用多边形切割模式
   */
  disablePolygonClipping() {
    this.polygonClippingEnabled = false
    this.stopDrawingPolygon()
    this.clearAllPolygons()
    return { success: true, message: '多边形切割模式已禁用' }
  }

  /**
   * 切换绘制状态 - 与原始项目一致，一个按钮切换开始/结束
   */
  toggleDrawingPolygon() {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) {
      return { success: false, message: '模型或视图未准备好' }
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
      return { success: false, message: '模型或视图未准备好' }
    }

    this.isDrawingPolygon = true
    this.currentPolygon = []

    // 清除之前的临时多边形
    if (this.polygonEntity) {
      this.viewer.entities.remove(this.polygonEntity)
      this.polygonEntity = null
    }

    // 清除之前的点标记
    this.clearPointEntities()

    return { success: true, message: '开始绘制多边形' }
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

    return { success: true, message: `切割深度已设置为 ${this.polygonDepth}米` }
  }

  /**
   * 设置多边形切割方向
   * @param {string} direction 'excavate' | 'isolate'
   */
  setPolygonDirection(direction) {
    if (direction !== 'excavate' && direction !== 'isolate') {
      return { success: false, message: '无效的方向参数' }
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

    return {
      success: true,
      message: `切割模式已设置为 ${direction === 'excavate' ? '挖掘' : '保留'}`
    }
  }

  /**
   * 重置多边形设置
   */
  resetPolygonSettings() {
    this.polygonDepth = 0
    this.polygonDirection = 'excavate'
    this.clearAllPolygons()
    return { success: true, message: '多边形设置已重置' }
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
      return { success: false, message: '模型未准备好' }

    // 保存顶点用于重新应用
    this.lastPolygonPositions = positions

    // 确保清除 ClippingPolygonCollection (如果存在)
    if (this.tileset.clippingPolygons) {
      this.tileset.clippingPolygons = undefined
      this.clippingPolygonCollection = null
    }

    // 1. 获取模型的世界变换矩阵的逆矩阵
    const transformInfo = this.getTilesetTransformInfo()
    if (!transformInfo) return { success: false, message: '无法获取模型变换' }

    const inverseTransform = Cesium.Matrix4.inverse(transformInfo.transform, new Cesium.Matrix4())

    // 2. 将世界坐标点转换为模型本地坐标点
    const localPositions = positions.map(pos => {
      return Cesium.Matrix4.multiplyByPoint(inverseTransform, pos, new Cesium.Cartesian3())
    })

    // 3. 计算多边形平面的法向量（平均法向量）
    // 计算中心点
    const center = Cesium.Cartesian3.ZERO.clone()
    localPositions.forEach(p => Cesium.Cartesian3.add(center, p, center))
    Cesium.Cartesian3.divideByScalar(center, localPositions.length, center)

    // 计算法向量 (Newell方法)
    const normal = new Cesium.Cartesian3()
    for (let i = 0; i < localPositions.length; i++) {
      const current = localPositions[i]
      const next = localPositions[(i + 1) % localPositions.length]

      normal.x += (current.y - next.y) * (current.z + next.z)
      normal.y += (current.z - next.z) * (current.x + next.x)
      normal.z += (current.x - next.x) * (current.y + next.y)
    }
    Cesium.Cartesian3.normalize(normal, normal)

    // 确保法向量指向"上方"
    if (Cesium.Cartesian3.dot(center, normal) < 0) {
      Cesium.Cartesian3.negate(normal, normal)
    }

    // 4. 创建切割面
    const planes = []
    const isExcavate = this.polygonDirection === 'excavate'

    // 4.1 底部平面
    // 挖掘模式：保留棱柱内部与底面上方的交集
    // 底面正半空间指向上方，因此底面法向量与上法向一致
    //
    // 隔离模式：保留棱柱内部整体（通过集合并集模式实现）
    // 底面正半空间指向下方，因此底面法向量与上法向相反

    const bottomNormal = isExcavate
      ? normal.clone()
      : Cesium.Cartesian3.negate(normal, new Cesium.Cartesian3())

    // 底部点 = 中心 + (下方 * 深度)
    const downDirection = Cesium.Cartesian3.negate(normal, new Cesium.Cartesian3())
    const depthVector = Cesium.Cartesian3.multiplyByScalar(
      downDirection,
      this.polygonDepth,
      new Cesium.Cartesian3()
    )
    const bottomPoint = Cesium.Cartesian3.add(center, depthVector, new Cesium.Cartesian3())

    const bottomDistance = -Cesium.Cartesian3.dot(bottomNormal, bottomPoint)
    planes.push(new Cesium.ClippingPlane(bottomNormal, bottomDistance))

    // 4.2 侧面平面
    for (let i = 0; i < localPositions.length; i++) {
      // 遍历所有边，包括最后一点到第一点
      const p1 = localPositions[i]
      const p2 = localPositions[(i + 1) % localPositions.length]

      // 跳过重复点
      if (Cesium.Cartesian3.distance(p1, p2) < 0.001) continue

      const edge = Cesium.Cartesian3.subtract(p2, p1, new Cesium.Cartesian3())
      // 侧面法向量 = 叉乘（边向量，上法向），初始指向外侧
      let sideNormal = Cesium.Cartesian3.cross(edge, normal, new Cesium.Cartesian3())
      Cesium.Cartesian3.normalize(sideNormal, sideNormal)

      // 验证方向: 指向中心的反方向 (OUT)
      const toCenter = Cesium.Cartesian3.subtract(center, p1, new Cesium.Cartesian3())
      if (Cesium.Cartesian3.dot(sideNormal, toCenter) > 0) {
        // 若侧面法向量指向内侧，则取反以指向外侧
        Cesium.Cartesian3.negate(sideNormal, sideNormal)
      }

      // 挖掘模式：侧面正半空间需要指向棱柱内部，因此对外侧法向取反
      // 隔离模式：侧面正半空间需要指向棱柱外部，保持外侧法向不变

      if (isExcavate) {
        Cesium.Cartesian3.negate(sideNormal, sideNormal)
      }

      const distance = -Cesium.Cartesian3.dot(sideNormal, p1)
      planes.push(new Cesium.ClippingPlane(sideNormal, distance))
    }

    // 5. 应用到Tileset
    // 清除现有的单面切割，避免冲突
    this.clearAllPlanes()

    // 创建新的集合
    try {
      // 挖掘模式：对各平面正半空间做交集
      // 隔离模式：对各平面正半空间做并集
      const unionClippingRegions = !isExcavate

      this.tileset.clippingPlanes = new Cesium.ClippingPlaneCollection({
        planes: planes,
        edgeWidth: 1.0,
        edgeColor: Cesium.Color.RED,
        unionClippingRegions: unionClippingRegions,
        enabled: true
      })
    } catch (e) {
      console.error('Failed to create excavation planes:', e)
      return { success: false, message: '创建挖掘面失败: ' + e.message }
    }

    // 清除辅助图形
    if (this.polygonEntity) {
      this.viewer.entities.remove(this.polygonEntity)
      this.polygonEntity = null
    }
    this.clearPointEntities()
    this.currentPolygon = []

    return {
      success: true,
      message: `已应用深度为 ${this.polygonDepth}米 的${isExcavate ? '挖掘' : '保留'}`
    }
  }

  /**
   * 停止绘制多边形 - 内部方法
   */
  stopDrawingPolygon() {
    this.isDrawingPolygon = false

    // 完成多边形绘制
    if (this.currentPolygon.length >= 3) {
      // 保存顶点
      // 注意：需要闭合多边形吗？Cesium ClippingPolygon 不需要显式闭合最后一点
      // 但如果之前代码加了，这里保持一致。
      // 之前的代码：const polygonPositions = [...this.currentPolygon, this.currentPolygon[0]]
      // 这里我们存原始点，apply的时候再去处理闭合

      // 为了兼容之前的逻辑，我们存一下如果不闭合的点
      this.lastPolygonPositions = [...this.currentPolygon]

      // 立即应用
      this.refreshPolygonClipping()

      // 清除临时多边形
      if (this.polygonEntity) {
        this.viewer.entities.remove(this.polygonEntity)
        this.polygonEntity = null
      }

      // 清除点标记
      this.clearPointEntities()
      this.currentPolygon = []

      return { success: true, message: '多边形已创建' }
    } else {
      // 如果点数量不足，清除临时数据
      if (this.polygonEntity) {
        this.viewer.entities.remove(this.polygonEntity)
        this.polygonEntity = null
      }

      // 清除点标记
      this.clearPointEntities()
      this.currentPolygon = []

      return { success: false, message: '多边形点数量不足' }
    }
  }

  /**
   * 应用不带深度（无限深度/穿透）的多边形切割
   * 使用 Cesium.ClippingPolygonCollection
   */
  applyPolygonClipping(positions) {
    if (!this.isViewerAlive() || !this.isTilesetAlive()) return

    // 保存顶点用于重新应用
    this.lastPolygonPositions = positions

    // 确保清除 ClippingPlaneCollection (如果存在)
    // 注意：这里我们清除的是 tileset.clippingPlanes，这可能会影响普通的多面切割功能
    // 如果我们希望多面切割和多边形切割共存...
    // 普通切割使用的是 ClippingPlaneCollection。
    // 多边形切割(Depth=0)使用的是 ClippingPolygonCollection。
    // 两者在 Cesium 中是分开的属性，可以共存。
    // 但带深度的多边形切割(applyPolygonExcavation)使用的是 ClippingPlaneCollection。
    // 所以如果我们从带深度切换到不带深度，我们需要清除 tileset.clippingPlanes 吗？
    // 如果 tileset.clippingPlanes 是由 applyPolygonExcavation 创建的，则需要清除。
    // 如果是普通切割创建的，则不应清除。
    // 我们如何区分？
    // 简单起见，目前的架构似乎是互斥的或者是覆盖的。
    // 调用 applyPolygonExcavation 时会执行 clearAllPlanes()，从而清除所有平面。
    // 所以带深度的多边形切割会覆盖普通切割。
    // 不带深度的多边形切割(ClippingPolygon) 与 ClippingPlane 是独立的。
    // 所以如果我们从带深度 -> 不带深度：
    // 我们应该清除那些"挖掘面"，但保留"普通切割面"？
    // 目前系统没有区分。applyPolygonExcavation 调用了 clearAllPlanes。
    // 所以我们假设多边形切割模式下，暂时接管了 ClippingPlanes。

    // 如果我们从带深度(Planes) 切换到 不带深度(Polygons)
    // 我们应该清除由带深度逻辑创建的 Planes。
    // 由于 applyPolygonExcavation 清除了之前的 planes，这里我们也应该清除。
    // 或者我们可以尝试恢复之前的普通切割面？
    // 这比较复杂。现在的逻辑似乎是"多边形切割"是一个独立的功能，可能会覆盖之前的切割。

    // 这里的逻辑：如果存在 ClippingPlaneCollection，我们先清除它？
    // 不，如果我们想保留普通切割，就不应该清除。
    // 但如果之前的 ClippingPlaneCollection 是 Excavation 产生的，必须清除。
    // 鉴于 applyPolygonExcavation 无论如何都清除了所有 planes，
    // 我们这里也清除所有 planes 以保持一致性，防止 Excavation planes 残留。
    this.clearAllPlanes()

    // 创建闭合多边形位置
    const polygonPositions = [...positions, positions[0]]

    // 创建ClippingPolygon
    const clippingPolygon = new Cesium.ClippingPolygon({
      positions: polygonPositions,
      ellipsoid: this.viewer.scene.globe.ellipsoid
    })

    const isExcavate = this.polygonDirection === 'excavate'

    // 移除现有的 Collection
    this.tileset.clippingPolygons = undefined

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

    // 首先尝试从模型表面拾取点
    let cartesian = null
    const pickedObject = this.viewer.scene.pick(movement.position)

    if (Cesium.defined(pickedObject) && Cesium.defined(pickedObject.primitive)) {
      // 使用pickPosition直接从模型表面获取精确位置
      cartesian = this.viewer.scene.pickPosition(movement.position)
    }

    // 如果无法从模型表面拾取，回退到椭球体表面拾取
    if (!cartesian) {
      cartesian = this.viewer.camera.pickEllipsoid(
        movement.position,
        this.viewer.scene.globe.ellipsoid
      )
    }

    if (cartesian) {
      // 添加到当前多边形（保持原始的笛卡尔坐标，包含正确的高度信息）
      this.currentPolygon.push(Cesium.Cartesian3.clone(cartesian))

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

      // 更新临时多边形
      if (this.polygonEntity) {
        this.viewer.entities.remove(this.polygonEntity)
      }

      if (this.currentPolygon.length >= 2) {
        // 创建临时多边形实体
        this.polygonEntity = this.viewer.entities.add({
          polygon: {
            hierarchy: this.currentPolygon,
            height: 0, // 显式设置高度为0，禁用地形贴附，以支持轮廓显示
            material: Cesium.Color.BLUE.withAlpha(0.3),
            outline: true,
            outlineColor: Cesium.Color.BLUE,
            outlineWidth: 2
          }
        })
      }

      return { success: true, message: `已绘制 ${this.currentPolygon.length} 个点` }
    }

    return { success: false, message: '无法拾取点' }
  }

  /**
   * 清除所有多边形
   */
  clearAllPolygons() {
    // 停止绘制
    this.isDrawingPolygon = false

    // 清除临时多边形
    if (this.polygonEntity && this.isViewerAlive()) {
      try {
        this.viewer.entities.remove(this.polygonEntity)
      } catch (e) {
        console.warn('Failed to remove polygon entity', e)
      }
      this.polygonEntity = null
    }

    // 清除点标记
    this.clearPointEntities()

    // 清除ClippingPolygonCollection
    if (this.clippingPolygonCollection) {
      try {
        this.clippingPolygonCollection.removeAll()
      } catch (e) {
        console.warn('Failed to remove clipping polygons', e)
      }
      if (this.isTilesetAlive()) {
        try {
          this.tileset.clippingPolygons = undefined
        } catch (e) {
          console.warn('Failed to clear tileset clipping polygons', e)
        }
      }
    }

    // 如果我们使用的是带深度的切割（ClippingPlanes），也应该清除？
    // 挖掘流程内部通过 clearAllPlanes() 清空 this.clippingPlanes 数组。
    // 但这里 clearAllPolygons 似乎只负责多边形？
    // 如果我们处于"带深度多边形切割"模式，tileset.clippingPlanes 实际上是用来做多边形切割的。
    // 所以这里应该也清除 planes？
    // 为了安全起见，如果我们确实在做多边形切割，应该清除它产生的影响。
    if (
      this.lastPolygonPositions &&
      this.lastPolygonPositions.length > 0 &&
      this.polygonDepth > 0
    ) {
      this.clearAllPlanes()
    }

    this.currentPolygon = []
    this.lastPolygonPositions = []

    return { success: true, message: '所有多边形已清除' }
  }

  /**
   * 清除点标记
   */
  clearPointEntities() {
    // 清除所有点标记
    if (this.isViewerAlive()) {
      this.pointEntities.forEach(pointEntity => {
        try {
          this.viewer.entities.remove(pointEntity)
        } catch (e) {
          console.warn('Failed to remove point entity', e)
        }
      })
    }
    this.pointEntities = []
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
        console.warn('Failed to clear planes on destroy', e)
      }
      try {
        this.clearAllPolygons()
      } catch (e) {
        console.warn('Failed to clear polygons on destroy', e)
      }
    } else {
      this.clippingPlanes = []
      this.clippingPolygonCollection = null
      this.currentPolygon = []
      this.lastPolygonPositions = []
      this.pointEntities = []
      this.polygonEntity = null
      this.activeClippingPlaneIndex = null
    }
    this.viewer = null
    this.tileset = null
    this.modelBounds = null
  }
}

export default ClippingManager
