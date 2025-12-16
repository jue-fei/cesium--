import * as Cesium from 'cesium'

/**
 * Geology Manager - 地质分析功能核心管理类
 */
export class GeologyManager {
    constructor(viewer) {
        this.viewer = viewer
        this.boreholes = []
        this.sections = []
        this.orebodies = []
        this.selectedBorehole = null
        this.selectedSection = null
    }

    /**
     * 初始化钻孔数据
     * @param {Array} boreholeData - 钻孔数据数组
     */
    initBoreholes(boreholeData) {
        this.boreholes = boreholeData.map(borehole => {
            // 创建钻孔可视化
            const boreholeEntity = this.createBoreholeEntity(borehole)
            return {
                ...borehole,
                entity: boreholeEntity
            }
        })
        return this.boreholes
    }

    /**
     * 创建钻孔可视化实体
     * @param {Object} borehole - 钻孔数据
     */
    createBoreholeEntity(borehole) {
        const startPoint = Cesium.Cartesian3.fromDegrees(borehole.x, borehole.y, borehole.z)
        const endPoint = Cesium.Cartesian3.fromDegrees(borehole.x, borehole.y, borehole.z - borehole.depth)

        const entity = this.viewer.entities.add({
            id: `borehole-${borehole.id}`,
            name: borehole.name,
            polyline: {
                positions: [startPoint, endPoint],
                width: 3,
                material: Cesium.Color.RED.withAlpha(0.8),
                depthFailMaterial: Cesium.Color.RED.withAlpha(0.3)
            },
            billboard: {
                position: startPoint,
                image: '/icons/borehole-marker.png',
                width: 24,
                height: 24,
                verticalOrigin: Cesium.VerticalOrigin.TOP
            },
            description: this.createBoreholeDescription(borehole)
        })

        return entity
    }

    /**
     * 创建钻孔描述信息
     * @param {Object} borehole - 钻孔数据
     */
    createBoreholeDescription(borehole) {
        return `<div class="borehole-info">
            <h3>${borehole.name}</h3>
            <p>ID: ${borehole.id}</p>
            <p>深度: ${borehole.depth} m</p>
            <p>位置: (${borehole.x}, ${borehole.y}, ${borehole.z})</p>
            <h4>地质分层:</h4>
            <ul>
                ${borehole.stratigraphy.map(layer =>
            `<li>${layer.depth}m - ${layer.lithology}: ${layer.thickness}m</li>`
        ).join('')}
            </ul>
        </div>`
    }

    /**
     * 创建地质剖面
     * @param {Array} sectionPoints - 剖面线点数组
     * @param {Array} stratigraphyData - 地层数据
     */
    createGeologicalSection(sectionPoints, stratigraphyData) {
        // 实现地质剖面生成逻辑
        const sectionEntity = this.viewer.entities.add({
            id: `section-${Date.now()}`,
            name: `Section ${this.sections.length + 1}`,
            polyline: {
                positions: sectionPoints.map(p => Cesium.Cartesian3.fromDegrees(p.x, p.y, p.z)),
                width: 2,
                material: Cesium.Color.BLUE.withAlpha(0.7)
            }
        })

        const section = {
            id: sectionEntity.id,
            name: sectionEntity.name,
            points: sectionPoints,
            entity: sectionEntity,
            stratigraphy: stratigraphyData
        }

        this.sections.push(section)
        return section
    }

    /**
     * 计算矿体储量
     * @param {Object} orebody - 矿体数据
     * @param {number} density - 矿石密度
     */
    calculateOreReserve(orebody, density = 2.5) {
        // 简化的储量计算逻辑
        const volume = this.calculateOrebodyVolume(orebody)
        const weight = volume * density
        const grade = orebody.grade || 0
        const metalContent = weight * grade / 100

        return {
            volume: volume,
            weight: weight,
            grade: grade,
            metalContent: metalContent
        }
    }

    /**
     * 计算矿体体积（简化版）
     * @param {Object} orebody - 矿体数据
     */
    calculateOrebodyVolume(orebody) {
        // 这里使用简化的体积计算方法
        // 实际项目中应该使用更精确的3D体积计算
        if (orebody.boundingBox) {
            const width = orebody.boundingBox.maxX - orebody.boundingBox.minX
            const length = orebody.boundingBox.maxY - orebody.boundingBox.minY
            const height = orebody.boundingBox.maxZ - orebody.boundingBox.minZ
            return width * length * height
        }
        return 0
    }

    /**
     * 生成地质报告
     * @param {Object} options - 报告选项
     */
    generateGeologyReport(options = {}) {
        const report = {
            title: '地质分析报告',
            date: new Date().toISOString(),
            boreholeCount: this.boreholes.length,
            sectionCount: this.sections.length,
            orebodyCount: this.orebodies.length,
            summary: '地质分析报告包含钻孔数据、剖面分析和矿体储量计算结果。',
            details: {
                boreholes: this.boreholes.map(b => ({
                    id: b.id,
                    name: b.name,
                    depth: b.depth,
                    stratigraphy: b.stratigraphy
                })),
                sections: this.sections.map(s => ({
                    id: s.id,
                    name: s.name,
                    points: s.points.length
                })),
                orebodies: this.orebodies.map(o => ({
                    id: o.id,
                    name: o.name,
                    volume: this.calculateOrebodyVolume(o),
                    grade: o.grade
                }))
            }
        }

        return report
    }

    /**
     * 显示钻孔详情
     * @param {string} boreholeId - 钻孔ID
     */
    showBoreholeDetails(boreholeId) {
        const borehole = this.boreholes.find(b => b.id === boreholeId)
        if (borehole && borehole.entity) {
            this.viewer.zoomTo(borehole.entity)
            this.selectedBorehole = borehole
            return borehole
        }
        return null
    }

    /**
     * 隐藏钻孔
     * @param {string} boreholeId - 钻孔ID
     */
    hideBorehole(boreholeId) {
        const borehole = this.boreholes.find(b => b.id === boreholeId)
        if (borehole && borehole.entity) {
            this.viewer.entities.remove(borehole.entity)
            borehole.visible = false
        }
    }

    /**
     * 显示钻孔
     * @param {string} boreholeId - 钻孔ID
     */
    showBorehole(boreholeId) {
        const borehole = this.boreholes.find(b => b.id === boreholeId)
        if (borehole && !borehole.entity) {
            borehole.entity = this.createBoreholeEntity(borehole)
            borehole.visible = true
        }
    }

    /**
     * 清理所有地质分析数据
     */
    clearAll() {
        // 清理钻孔
        this.boreholes.forEach(borehole => {
            if (borehole.entity) {
                this.viewer.entities.remove(borehole.entity)
            }
        })

        // 清理剖面
        this.sections.forEach(section => {
            if (section.entity) {
                this.viewer.entities.remove(section.entity)
            }
        })

        this.boreholes = []
        this.sections = []
        this.orebodies = []
        this.selectedBorehole = null
        this.selectedSection = null
    }
}

/**
 * 地质数据分析工具函数
 */
export const geologyAnalysisUtils = {
    /**
     * 计算两点之间的距离
     * @param {Cesium.Cartesian3} point1 - 第一个点
     * @param {Cesium.Cartesian3} point2 - 第二个点
     */
    calculateDistance(point1, point2) {
        return Cesium.Cartesian3.distance(point1, point2)
    },

    /**
     * 计算地层厚度统计
     * @param {Array} boreholes - 钻孔数据数组
     */
    calculateStratigraphyStats(boreholes) {
        const stats = {}

        boreholes.forEach(borehole => {
            borehole.stratigraphy.forEach(layer => {
                if (!stats[layer.lithology]) {
                    stats[layer.lithology] = {
                        count: 0,
                        totalThickness: 0,
                        averageThickness: 0
                    }
                }

                stats[layer.lithology].count++
                stats[layer.lithology].totalThickness += layer.thickness
            })
        })

        // 计算平均厚度
        Object.keys(stats).forEach(lithology => {
            stats[lithology].averageThickness =
                stats[lithology].totalThickness / stats[lithology].count
        })

        return stats
    },

    /**
     * 生成地质图例
     * @param {Object} options - 图例选项
     */
    generateGeologyLegend(options = {}) {
        const defaultOptions = {
            position: { x: 10, y: 10 },
            width: 200,
            height: 300,
            backgroundColor: 'rgba(0, 0, 0, 0.7)'
        }

        const mergedOptions = { ...defaultOptions, ...options }
        // 实现图例生成逻辑
        return mergedOptions
    }
}

/**
 * 导出地质数据
 */
export const geologyExportUtils = {
    /**
     * 导出钻孔数据为JSON
     * @param {Array} boreholes - 钻孔数据数组
     */
    exportBoreholesToJSON(boreholes) {
        const exportData = boreholes.map(borehole => ({
            id: borehole.id,
            name: borehole.name,
            x: borehole.x,
            y: borehole.y,
            z: borehole.z,
            depth: borehole.depth,
            stratigraphy: borehole.stratigraphy
        }))
        return JSON.stringify(exportData, null, 2)
    },

    /**
     * 导出地质报告
     * @param {Object} report - 报告数据
     */
    exportGeologyReport(report) {
        const reportText = `地质分析报告

` +
            `报告日期: ${new Date(report.date).toLocaleString()}
` +
            `钻孔数量: ${report.boreholeCount}
` +
            `剖面数量: ${report.sectionCount}
` +
            `矿体数量: ${report.orebodyCount}

` +
            `摘要: ${report.summary}

` +
            `详细信息:
` +
            `- 钻孔: ${report.details.boreholes.map(b => b.name).join(', ')}
` +
            `- 剖面: ${report.details.sections.length}个
` +
            `- 矿体: ${report.details.orebodies.length}个`

        return reportText
    }
}
