import * as Cesium from 'cesium'

/**
 * Risk Manager - 风险预警层管理类
 * 负责展示应力异常区域、灾害风险区
 */
export class RiskManager {
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for RiskManager')
    this.viewer = viewer
    this.riskZones = []
  }

  /**
   * 添加风险区域
   * @param {Object} data { id, positions: [{x,y},...], level: 'high'|'medium'|'low' }
   */
  addRiskZone(data) {
    const { id, positions, level } = data

    // 简单的多边形区域
    const hierarchy = Cesium.Cartesian3.fromDegreesArray(positions.flatMap(p => [p.x, p.y]))

    const color = this.getRiskColor(level)

    const entity = this.viewer.entities.add({
      id: `risk_${id}`,
      polygon: {
        hierarchy: hierarchy,
        material: color.withAlpha(0.3),
        outline: true,
        outlineColor: color,
        height: 0,
        extrudedHeight: 50 // 立体显示
      },
      label: {
        text: `风险区: ${level.toUpperCase()}`,
        font: '14px monospace',
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        position: Cesium.BoundingSphere.fromPoints(hierarchy).center
      }
    })

    this.riskZones.push(entity)
  }

  getRiskColor(level) {
    switch (level) {
      case 'high':
        return Cesium.Color.RED
      case 'medium':
        return Cesium.Color.ORANGE
      case 'low':
        return Cesium.Color.YELLOW
      default:
        return Cesium.Color.WHITE
    }
  }

  clearAll() {
    this.riskZones.forEach(e => this.viewer.entities.remove(e))
    this.riskZones = []
  }
}
