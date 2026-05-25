import * as Cesium from 'cesium'

/**
 * Equipment Manager - 设备运行层管理类
 * 负责设备轨迹、实时位置、健康状态展示
 */
export class EquipmentManager {
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for EquipmentManager')
    this.viewer = viewer
    this.equipment = new Map() // id -> entity
    this.trajectories = new Map() // id -> entity (polyline)
  }

  /**
   * 添加或更新设备
   * @param {Object} data 设备数据 { id, type, position: {x,y,z}, health: 'normal'|'warning'|'critical' }
   */
  updateEquipment(data) {
    const { id, type, position, health } = data

    let entity = this.equipment.get(id)
    const color = this.getHealthColor(health)

    if (!entity) {
      // 创建新设备
      entity = this.viewer.entities.add({
        id: `equipment_${id}`,
        position: Cesium.Cartesian3.fromDegrees(position.x, position.y, position.z),
        point: {
          pixelSize: 10,
          color: color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2
        },
        label: {
          text: `${type}-${id}`,
          font: '12px sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -9)
        },
        // 模拟简单的3D模型，实际项目应加载glb
        cylinder: {
          length: 4.0,
          topRadius: 2.0,
          bottomRadius: 2.0,
          material: color.withAlpha(0.7)
        }
      })
      this.equipment.set(id, entity)
    } else {
      // 更新位置和状态
      entity.position = Cesium.Cartesian3.fromDegrees(position.x, position.y, position.z)
      entity.point.color = color
      entity.cylinder.material = color.withAlpha(0.7)
    }

    // 更新轨迹
    this.updateTrajectory(id, position)
  }

  /**
   * 更新设备轨迹
   */
  updateTrajectory(id, position) {
    let trajectory = this.trajectories.get(id)
    const newPoint = Cesium.Cartesian3.fromDegrees(position.x, position.y, position.z)

    if (!trajectory) {
      trajectory = this.viewer.entities.add({
        polyline: {
          positions: [newPoint],
          width: 2,
          material: Cesium.Color.CYAN.withAlpha(0.5)
        }
      })
      this.trajectories.set(id, trajectory)
    } else {
      const positions = trajectory.polyline.positions.getValue(Cesium.JulianDate.now())
      positions.push(newPoint)
      trajectory.polyline.positions = positions
    }
  }

  getHealthColor(status) {
    switch (status) {
      case 'warning':
        return Cesium.Color.ORANGE
      case 'critical':
        return Cesium.Color.RED
      case 'normal':
      default:
        return Cesium.Color.GREEN
    }
  }

  clearAll() {
    this.equipment.forEach(e => this.viewer.entities.remove(e))
    this.trajectories.forEach(t => this.viewer.entities.remove(t))
    this.equipment.clear()
    this.trajectories.clear()
  }
}
