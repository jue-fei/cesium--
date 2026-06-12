import * as Cesium from 'cesium'

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidCartesianArray(cartesian) {
  return (
    Array.isArray(cartesian) &&
    cartesian.length === 3 &&
    cartesian.every(component => isFiniteNumber(component))
  )
}

function isValidCartesian3(cartesian) {
  return (
    cartesian instanceof Cesium.Cartesian3 &&
    isFiniteNumber(cartesian.x) &&
    isFiniteNumber(cartesian.y) &&
    isFiniteNumber(cartesian.z)
  )
}

export class EquipmentManager {
  constructor(viewer, options = {}) {
    if (!viewer) throw new Error('Viewer is required')
    this.viewer = viewer
    this.truckEntities = new Map()
    this.labelEntities = new Map()
    this.trajectoryEntities = new Map()
    this.trajectoryPositions = new Map()
    this.options = {
      pointSize: options.pointSize || 8,
      showLabels: options.showLabels !== false,
      showTrajectories: options.showTrajectories === true,
      maxTrajectoryPoints: options.maxTrajectoryPoints || 240,
      pointScaleByDistance:
        options.pointScaleByDistance || new Cesium.NearFarScalar(150.0, 1.0, 5000.0, 0.2)
    }
  }

  updateTrucks(trucks) {
    trucks.forEach(truck => this.updateTruck(truck))
    const currentIds = new Set(trucks.map(t => t.id))
    this.truckEntities.forEach((entity, id) => {
      if (!currentIds.has(id)) this.removeTruck(id)
    })
  }

  updateTruck(truck) {
    const { id, position, status } = truck
    const color = this.getStatusColor(status)
    let entity = this.truckEntities.get(id)

    let cartesianPosition
    try {
      // 优先使用 Cartesian 世界坐标（由 RealtimeDataEngine 提供）
      // 注意：高度偏移已在 RealtimeDataEngine.js 中处理，这里直接使用原始坐标
      if (position?.cartesian && isValidCartesianArray(position.cartesian)) {
        cartesianPosition = new Cesium.Cartesian3(
          position.cartesian[0],
          position.cartesian[1],
          position.cartesian[2]
        )
      } else if (isFiniteNumber(position?.longitude) && isFiniteNumber(position?.latitude)) {
        // 回退：使用经纬度转换
        cartesianPosition = Cesium.Cartesian3.fromDegrees(
          position.longitude,
          position.latitude,
          position.height || 0
        )
      } else {
        console.error(`[EquipmentManager] 矿卡 ${id} 位置格式错误:`, position)
        return
      }
    } catch (error) {
      console.error(`[EquipmentManager] 矿卡 ${id} 位置计算失败:`, error)
      return
    }

    if (!entity) {
      entity = this.viewer.entities.add({
        id: `truck_${id}`,
        position: cartesianPosition,
        point: {
          pixelSize: this.options.pointSize,
          color: color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          scaleByDistance: this.options.pointScaleByDistance,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
        // 暂时禁用 billboard 和 label 以排查黑框问题
      })
      this.truckEntities.set(id, entity)
    } else {
      entity.position = cartesianPosition
      entity.point.color = color
    }

    if (this.options.showLabels) {
      this.updateLabel(id, {
        ...truck,
        cartesianPosition
      })
    } else {
      this.removeLabel(id)
    }

    if (this.options.showTrajectories) {
      this.updateTrajectory(id, cartesianPosition, color)
    } else {
      this.clearTrajectory(id)
    }
  }

  createArrowCanvas(heading, color) {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    ctx.save()
    ctx.translate(16, 16)
    ctx.rotate(((heading - 90) * Math.PI) / 180)
    ctx.beginPath()
    ctx.moveTo(12, 0)
    ctx.lineTo(-8, -6)
    ctx.lineTo(-4, 0)
    ctx.lineTo(-8, 6)
    ctx.closePath()
    ctx.fillStyle = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, 1)`
    ctx.fill()
    ctx.strokeStyle = 'white'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
    return canvas
  }

  updateLabel(id, data) {
    let labelEntity = this.labelEntities.get(id)
    const labelText = `${data.truckName || data.name}\n${data.driver}\n${data.mineralType?.name || ''}: ${Math.round(data.payload || 0)}t`
    if (!labelEntity) {
      labelEntity = this.viewer.entities.add({
        id: `truck_label_${id}`,
        position: data.cartesianPosition,
        label: {
          text: labelText,
          font: '10px Microsoft YaHei',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -10),
          backgroundColor: new Cesium.Color(0, 0, 0, 0.5),
          showBackground: true,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
      this.labelEntities.set(id, labelEntity)
    } else {
      labelEntity.position = data.cartesianPosition
      labelEntity.label.text = labelText
    }
  }

  updateTrajectory(id, cartesianPosition, color) {
    if (!isValidCartesian3(cartesianPosition)) {
      this.clearTrajectory(id)
      return
    }

    const positions = (this.trajectoryPositions.get(id) || []).filter(isValidCartesian3)
    const lastPosition = positions[positions.length - 1]

    if (!lastPosition || Cesium.Cartesian3.distance(lastPosition, cartesianPosition) > 0.5) {
      positions.push(Cesium.Cartesian3.clone(cartesianPosition))
      if (positions.length > this.options.maxTrajectoryPoints) {
        positions.shift()
      }
      this.trajectoryPositions.set(id, positions)
    }

    let trajectoryEntity = this.trajectoryEntities.get(id)
    if (positions.length < 2) {
      if (trajectoryEntity) this.clearTrajectory(id)
      else this.trajectoryPositions.set(id, positions)
      return
    }

    if (!trajectoryEntity) {
      trajectoryEntity = this.viewer.entities.add({
        id: `truck_path_${id}`,
        polyline: {
          positions,
          width: 2,
          material: color.withAlpha(0.55),
          clampToGround: false,
          arcType: Cesium.ArcType.NONE
        }
      })
      this.trajectoryEntities.set(id, trajectoryEntity)
      return
    }

    trajectoryEntity.polyline.positions = positions
    trajectoryEntity.polyline.material = color.withAlpha(0.55)
  }

  toggleLabels(forceValue) {
    this.options.showLabels =
      typeof forceValue === 'boolean' ? forceValue : !this.options.showLabels

    if (!this.options.showLabels) {
      this.labelEntities.forEach(entity => this.viewer.entities.remove(entity))
      this.labelEntities.clear()
    }

    return this.options.showLabels
  }

  toggleTrajectories(forceValue) {
    this.options.showTrajectories =
      typeof forceValue === 'boolean' ? forceValue : !this.options.showTrajectories

    if (!this.options.showTrajectories) {
      this.clearTrajectories()
    }

    return this.options.showTrajectories
  }

  getStatusColor(status) {
    const colors = {
      装载中: Cesium.Color.fromCssColorString('#4CAF50'),
      重载运输: Cesium.Color.fromCssColorString('#FF9800'),
      卸载中: Cesium.Color.fromCssColorString('#2196F3'),
      空载返程: Cesium.Color.fromCssColorString('#9E9E9E')
    }
    return colors[status] || Cesium.Color.YELLOW
  }

  removeTruck(id) {
    const entity = this.truckEntities.get(id)
    if (entity) {
      this.viewer.entities.remove(entity)
      this.truckEntities.delete(id)
    }
    this.removeLabel(id)
    this.clearTrajectory(id)
  }

  removeLabel(id) {
    const label = this.labelEntities.get(id)
    if (label) {
      this.viewer.entities.remove(label)
      this.labelEntities.delete(id)
    }
  }

  clearTrajectory(id) {
    const trajectory = this.trajectoryEntities.get(id)
    if (trajectory) {
      this.viewer.entities.remove(trajectory)
      this.trajectoryEntities.delete(id)
    }
    this.trajectoryPositions.delete(id)
  }

  clearTrajectories() {
    this.trajectoryEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.trajectoryEntities.clear()
    this.trajectoryPositions.clear()
  }

  clearAll() {
    this.truckEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.labelEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.trajectoryEntities.forEach(entity => this.viewer.entities.remove(entity))
    this.truckEntities.clear()
    this.labelEntities.clear()
    this.trajectoryEntities.clear()
    this.trajectoryPositions.clear()
  }

  destroy() {
    this.clearAll()
  }
}

export default EquipmentManager
