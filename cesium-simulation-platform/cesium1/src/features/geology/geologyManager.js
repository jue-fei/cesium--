import { DEFAULT_ORE_DENSITY } from '../../config/constants/appConfig.js'

/**
 * @typedef {Object} BoreholeLayer
 * @property {number} depth
 * @property {string} lithology
 * @property {number} thickness
 */

/**
 * @typedef {Object} Borehole
 * @property {string} id
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} depth
 * @property {number} azimuth
 * @property {number} dip
 * @property {BoreholeLayer[]} stratigraphy
 */

/**
 * Geology Manager - 地质分析纯逻辑服务
 * 负责数据的验证、计算和处理，不包含任何 Cesium 渲染逻辑
 */
export class GeologyManager {
  constructor() {
    // 计算缓存
    this.calculationCache = new Map()
  }

  /**
   * 验证并初始化钻孔数据
   * @param {Array} boreholeData - 钻孔数据数组
   * @returns {Array} 验证后的钻孔数据数组
   */
  processBoreholes(boreholeData) {
    if (!Array.isArray(boreholeData)) {
      console.warn('Invalid borehole data provided, expected an array')
      return []
    }

    return boreholeData
      .map(borehole => {
        // 数据验证
        if (!borehole.id || !borehole.x || !borehole.y) {
          console.warn('Invalid borehole data, skipping:', borehole)
          return null
        }

        // 确保数据结构完整
        return {
          id: borehole.id,
          name: borehole.name || `Borehole-${borehole.id}`,
          x: Number(borehole.x),
          y: Number(borehole.y),
          z: Number(borehole.z || 0),
          depth: Number(borehole.depth || 0),
          azimuth: Number(borehole.azimuth || 0),
          dip: Number(borehole.dip || -90),
          stratigraphy: Array.isArray(borehole.stratigraphy) ? borehole.stratigraphy : []
        }
      })
      .filter(Boolean)
  }

  /**
   * 创建地质剖面数据对象
   * @param {Array} sectionPoints - 剖面线点数组
   * @param {Array} stratigraphyData - 地层数据
   */
  createSectionData(sectionPoints, stratigraphyData) {
    if (!Array.isArray(sectionPoints) || sectionPoints.length === 0) {
      console.warn('Invalid section points provided')
      return null
    }

    return {
      id: `section-${Date.now()}`,
      name: `Section ${Date.now()}`,
      points: sectionPoints,
      stratigraphy: stratigraphyData,
      createdAt: new Date().toISOString()
    }
  }

  /**
   * 计算矿体储量
   * @param {Object} orebody - 矿体数据
   * @param {number} density - 矿石密度
   */
  calculateOreReserve(orebody, density = DEFAULT_ORE_DENSITY) {
    if (!orebody || !orebody.id) {
      return { volume: 0, weight: 0, grade: 0, metalContent: 0 }
    }

    const cacheKey = `reserve_${orebody.id}_${density}`
    if (this.calculationCache.has(cacheKey)) {
      return this.calculationCache.get(cacheKey)
    }

    const volume = this.calculateOrebodyVolume(orebody)
    const weight = volume * density
    const grade = orebody.grade || 0
    const metalContent = (weight * grade) / 100

    const result = {
      volume,
      weight,
      grade,
      metalContent
    }

    this.calculationCache.set(cacheKey, result)
    return result
  }

  /**
   * 计算矿体体积（简化版）
   * @param {Object} orebody - 矿体数据
   */
  calculateOrebodyVolume(orebody) {
    if (!orebody || !orebody.id) return 0

    const cacheKey = `volume_${orebody.id}`
    if (this.calculationCache.has(cacheKey)) {
      return this.calculationCache.get(cacheKey)
    }

    let volume = 0
    if (orebody.boundingBox) {
      const { maxX, minX, maxY, minY, maxZ, minZ } = orebody.boundingBox
      volume = (maxX - minX) * (maxY - minY) * (maxZ - minZ)
    }

    this.calculationCache.set(cacheKey, volume)
    return volume
  }

  /**
   * 生成地质报告
   * @param {Object} data - 报告所需数据 { boreholes, sections, orebodies }
   */
  generateGeologyReport(data = {}) {
    const { boreholes = [], sections = [], orebodies = [] } = data

    return {
      title: '地质分析报告',
      date: new Date().toISOString(),
      boreholeCount: boreholes.length,
      sectionCount: sections.length,
      orebodyCount: orebodies.length,
      summary: '地质分析报告包含钻孔数据、剖面分析和矿体储量计算结果。',
      details: {
        boreholes: boreholes.map(({ id, name, depth, stratigraphy }) => ({
          id,
          name,
          depth,
          stratigraphy
        })),
        sections: sections.map(({ id, name, points }) => ({
          id,
          name,
          points: points.length
        })),
        orebodies: orebodies.map(orebody => ({
          id: orebody.id,
          name: orebody.name,
          volume: this.calculateOrebodyVolume(orebody),
          grade: orebody.grade
        }))
      }
    }
  }

  clearCache() {
    this.calculationCache.clear()
  }
}

/**
 * 地质数据分析工具函数
 */
export const geologyAnalysisUtils = {
  calculateStratigraphyStats(boreholes) {
    const stats = {}
    for (const borehole of boreholes) {
      if (!borehole.stratigraphy) continue
      for (const layer of borehole.stratigraphy) {
        const { lithology, thickness } = layer
        if (!stats[lithology]) {
          stats[lithology] = { count: 0, totalThickness: 0, averageThickness: 0 }
        }
        stats[lithology].count++
        stats[lithology].totalThickness += thickness
      }
    }
    for (const lithology in stats) {
      const { totalThickness, count } = stats[lithology]
      stats[lithology].averageThickness = totalThickness / count
    }
    return stats
  }
}

/**
 * 导出地质数据
 */
export const geologyExportUtils = {
  exportBoreholesToJSON(boreholes) {
    const exportData = boreholes.map(({ id, name, x, y, z, depth, stratigraphy }) => ({
      id,
      name,
      x,
      y,
      z,
      depth,
      stratigraphy
    }))
    return JSON.stringify(exportData, null, 2)
  },

  exportGeologyReport(report) {
    const boreholeNames = report.details.boreholes.map(b => b.name).join(', ')
    const sectionsCount = report.details.sections.length
    const orebodiesCount = report.details.orebodies.length

    return `地质分析报告

报告日期: ${new Date(report.date).toLocaleString()}
钻孔数量: ${report.boreholeCount}
剖面数量: ${report.sectionCount}
矿体数量: ${report.orebodyCount}

摘要: ${report.summary}

详细信息:
- 钻孔: ${boreholeNames}
- 剖面: ${sectionsCount}个
- 矿体: ${orebodiesCount}个`
  }
}
