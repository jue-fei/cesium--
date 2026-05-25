import * as Cesium from 'cesium'
import { BOREHOLE_CONFIG, SECTION_CONFIG } from '../../config/constants/appConfig.js'

/**
 * 地质可视化器 - 使用图元接口渲染地质数据
 */
export class GeologyVisualizer {
  /**
   * @param {Cesium.Viewer} viewer
   */
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for GeologyVisualizer')
    this.viewer = viewer

    // 校验场景与图元集合是否可用
    if (!this.viewer.scene || !this.viewer.scene.primitives) {
      throw new Error('Viewer scene or primitives not initialized')
    }

    // 图元集合
    this.polylineCollection = new Cesium.PolylineCollection()
    this.pointCollection = new Cesium.PointPrimitiveCollection()
    this.labelCollection = new Cesium.LabelCollection()

    // 将集合加入场景
    try {
      this.viewer.scene.primitives.add(this.polylineCollection)
      this.viewer.scene.primitives.add(this.pointCollection)
      this.viewer.scene.primitives.add(this.labelCollection)
    } catch (e) {
      console.error('Failed to add primitives to scene', e)
    }

    // 拾取映射
    this.primitiveIdMap = new Map() // primitive -> dataId

    // 初始化拾取处理器
    this.setupPicking()
  }

  setupPicking() {
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas)

    // 根据需要在此处注册鼠标交互事件
  }

  /**
   * 渲染钻孔列表 (使用 Primitive API)
   * @param {Array} boreholes
   */
  drawBoreholes(boreholes) {
    // 清空已有图元
    this.clearBoreholes()

    const startColor = BOREHOLE_CONFIG.COLOR

    boreholes.forEach(borehole => {
      if (!borehole || !borehole.id) return

      const startPoint = Cesium.Cartesian3.fromDegrees(borehole.x, borehole.y, borehole.z)
      const endPoint = Cesium.Cartesian3.fromDegrees(
        borehole.x,
        borehole.y,
        borehole.z - borehole.depth
      )

      // 绘制钻孔线
      this.polylineCollection.add({
        positions: [startPoint, endPoint],
        width: BOREHOLE_CONFIG.WIDTH,
        material: new Cesium.Material({
          fabric: {
            type: 'Color',
            uniforms: {
              color: startColor
            }
          }
        }),
        // 线集合不支持与实体一致的深度失败材质，这里只设置基础材质
        id: `borehole-${borehole.id}`
      })

      // 绘制钻孔起点标记
      this.pointCollection.add({
        position: startPoint,
        color: startColor,
        pixelSize: BOREHOLE_CONFIG.MARKER_SIZE,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        id: `borehole-marker-${borehole.id}`
      })
    })
  }

  /**
   * 绘制剖面
   */
  drawSection(section) {
    if (!section || !section.points) return null

    const positions = section.points.map(p => Cesium.Cartesian3.fromDegrees(p.x, p.y, p.z))

    // 使用线集合绘制剖面折线
    const polyline = this.polylineCollection.add({
      positions: positions,
      width: SECTION_CONFIG.WIDTH,
      material: Cesium.Material.fromType('Color', {
        color: SECTION_CONFIG.COLOR
      }),
      id: section.id
    })

    return polyline
  }

  /**
   * 聚焦到钻孔
   */
  zoomToBorehole(boreholeId) {
    // 在图元集合中定位目标线段，并将相机飞行到线段起点上方
    let targetPrimitive = null
    const len = this.polylineCollection.length
    for (let i = 0; i < len; i++) {
      const p = this.polylineCollection.get(i)
      if (p.id === `borehole-${boreholeId}`) {
        targetPrimitive = p
        break
      }
    }

    if (targetPrimitive) {
      const positions = targetPrimitive.positions
      if (positions && positions.length > 0) {
        const center = positions[0]
        this.viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromElements(
            center.x,
            center.y,
            center.z + 500 // 飞行到起点上方一定高度
          )
        })
        return true
      }
    }
    return false
  }

  /**
   * 清理所有实体
   */
  clearAll() {
    this.polylineCollection.removeAll()
    this.pointCollection.removeAll()
    this.labelCollection.removeAll()
    this.primitiveIdMap.clear()
  }

  clearBoreholes() {
    // 倒序遍历线集合，仅移除钻孔线段
    for (let i = this.polylineCollection.length - 1; i >= 0; i--) {
      const p = this.polylineCollection.get(i)
      if (p.id && String(p.id).startsWith('borehole-')) {
        this.polylineCollection.remove(p)
      }
    }
    this.pointCollection.removeAll() // Re-add all points is cheap
  }
}
