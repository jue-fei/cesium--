import { watch, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useGeologyStore } from '../../../stores/geologyStore.js'
import { GeologyManager } from './geologyManager.js'
import { GeologyVisualizer } from './geologyVisualizer.js'

import { apiConfig, onConfigLoaded } from '../../../services/api/initApiConfig.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'

function buildGeologicalStatsCards(stats) {
  const s = stats || {}
  return [
    { id: 'avg-thick', label: '平均厚度', value: s.averageThickness, unit: 'm', icon: '📏' },
    { id: 'min-int', label: '矿化强度', value: s.mineralizationIntensity, unit: '', icon: '⚡' },
    { id: 'est-res', label: '预估储量', value: s.estimatedReserves, unit: '万吨', icon: '⚖️' },
    { id: 'avg-grade', label: '平均品位', value: s.averageGrade, unit: '%', icon: '💎' }
  ]
}

export function exportBoreholesToJSON(boreholes) {
  const exportData = (boreholes || []).map(({ id, name, x, y, z, depth, stratigraphy }) => ({
    id,
    name,
    x,
    y,
    z,
    depth,
    stratigraphy
  }))
  return JSON.stringify(exportData, null, 2)
}

export function exportGeologyReport(report) {
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

export function calculateStratigraphyStats(boreholes) {
  const stats = {}
  for (const borehole of boreholes || []) {
    if (!borehole?.stratigraphy) continue
    for (const layer of borehole.stratigraphy) {
      const lithology = layer?.lithology
      const thickness = Number(layer?.thickness || 0)
      if (!lithology) continue
      if (!stats[lithology]) {
        stats[lithology] = { count: 0, totalThickness: 0, averageThickness: 0 }
      }
      stats[lithology].count++
      stats[lithology].totalThickness += thickness
    }
  }
  for (const lithology in stats) {
    const { totalThickness, count } = stats[lithology]
    stats[lithology].averageThickness = totalThickness / Math.max(1, count)
  }
  return stats
}

// 单例实例
let geologyVisualizer = null
const geologyManagerService = new GeologyManager()

export default function useGeologyAnalysis() {
  const { getViewer } = useViewer()
  const { showOperationMessage } = useMessage()

  const store = useGeologyStore()
  const { boreholes, orebodies, sections, stats } = storeToRefs(store)

  const geologicalStats = computed(() => buildGeologicalStatsCards(stats.value))

  /**
   * 初始化地质分析模块
   * @param {Object} viewerInstance
   */
  const initGeologyManager = (viewerInstance = null) => {
    const viewer = viewerInstance || getViewer()

    if (!viewer) return

    if (!viewer.scene || !viewer.scene.primitives) {
      return
    }

    if (!geologyVisualizer) {
      try {
        geologyVisualizer = new GeologyVisualizer(viewer)
      } catch (e) {
        console.error('GeologyVisualizer 初始化失败:', e)
        return
      }

      if (store.boreholes.length > 0) {
        geologyVisualizer.drawBoreholes(store.boreholes)
      }
    }

    // 从 API 加载钻孔数据
    if (store.boreholes.length === 0) {
      loadBoreholesFromApi()
    }

    // 从 API 加载地质统计数据
    if (!store.stats.averageThickness && !store.stats.estimatedReserves) {
      loadGeologyStatsFromApi()
    }

    if (store.orebodies.length === 0) {
      // 从 API 加载矿体数据
      loadOrebodiesFromApi()
    }
  }

  // 监听数据变化并自动更新视图
  // 监听状态仓库中的数据引用变化
  watch(
    boreholes,
    newBoreholes => {
      if (geologyVisualizer) {
        geologyVisualizer.drawBoreholes(newBoreholes)
      }
    },
    { deep: false }
  ) // 浅引用无需深度监听

  watch(sections, newSections => {
    // 当前按条调用绘制方法
    if (geologyVisualizer) {
      // 遍历剖面列表并逐条调用绘制
      newSections.forEach(section => {
        // 未维护剖面标识映射时，按输入顺序调用绘制
        geologyVisualizer.drawSection(section)
      })
    }
  })

  /**
   * 初始化钻孔数据
   */
  const initBoreholes = boreholeData => {
    const processed = geologyManagerService.processBoreholes(boreholeData)
    store.setBoreholes(processed)
    return processed
  }

  /**
   * 显示钻孔详情
   */
  const showBoreholeDetails = boreholeId => {
    if (!geologyVisualizer) return
    geologyVisualizer.zoomToBorehole(boreholeId)
  }

  /**
   * 创建地质剖面
   */
  const createGeologicalSection = (sectionPoints, stratigraphyData) => {
    const sectionData = geologyManagerService.createSectionData(sectionPoints, stratigraphyData)
    if (sectionData) {
      store.addSection(sectionData)
      if (geologyVisualizer) {
        geologyVisualizer.drawSection(sectionData)
      }
    }
    return sectionData
  }

  /**
   * 计算矿体储量
   */
  /**
   * 从 API 加载矿体数据并写入 store
   */
  async function loadOrebodiesFromApi() {
    try {
      // 如果 API 配置还未加载，等待回调
      if (!apiConfig.loaded) {
        await new Promise(resolve => onConfigLoaded(resolve))
      }
      if (apiConfig.orebodies && apiConfig.orebodies.length > 0) {
        const mapped = apiConfig.orebodies.map(r => ({
          id: r.orebody_id,
          name: r.name,
          grade: Number(r.grade),
          reserves: Number(r.reserves),
          thickness: Number(r.thickness),
          oreType: r.ore_type,
          density: Number(r.density),
          volume: Number(r.volume),
          metalContent: Number(r.metal_content),
          miningMethod: r.mining_method,
          depthTop: Number(r.depth_top),
          depthBottom: Number(r.depth_bottom),
          dipAngle: Number(r.dip_angle),
          strike: Number(r.strike),
          status: r.status,
          geologicalZone: r.geological_zone,
          confidenceLevel: r.confidence_level,
          boundingBox: r.bounding_box,
          description: r.description
        }))
        store.setOrebodies(mapped)
        return true
      }
    } catch (e) {
      // Ignore API preload failures and allow local fallback data paths.
      void e
    }
    return false
  }

  /**
   * 从 API 加载钻孔数据并写入 store
   */
  async function loadBoreholesFromApi() {
    try {
      if (!apiConfig.loaded) {
        await new Promise(resolve => onConfigLoaded(resolve))
      }
      if (apiConfig.boreholes && apiConfig.boreholes.length > 0) {
        const processed = geologyManagerService.processBoreholes(
          apiConfig.boreholes.map(r => ({
            id: r.borehole_id || r.id,
            name: r.name,
            x: Number(r.x),
            y: Number(r.y),
            z: Number(r.z),
            depth: Number(r.depth),
            stratigraphy: r.stratigraphy || [],
            description: r.description
          }))
        )
        store.setBoreholes(processed)
        return true
      }
    } catch (e) {
      // Ignore API preload failures and allow local fallback data paths.
      void e
    }
    return false
  }

  /**
   * 从 API 加载地质统计并写入 store
   */
  async function loadGeologyStatsFromApi() {
    try {
      if (!apiConfig.loaded) {
        await new Promise(resolve => onConfigLoaded(resolve))
      }
      if (apiConfig.geologyStats) {
        const s = apiConfig.geologyStats
        store.updateStats({
          averageThickness: s.average_thickness ?? s.averageThickness ?? 0,
          mineralizationIntensity: s.mineralization_intensity ?? s.mineralizationIntensity ?? 0,
          estimatedReserves: s.estimated_reserves ?? s.estimatedReserves ?? 0,
          averageGrade: s.average_grade ?? s.averageGrade ?? 0
        })
        return true
      }
    } catch (e) {
      // Ignore API preload failures and allow local fallback data paths.
      void e
    }
    return false
  }

  /**
   * 计算矿体储量
   */
  const calculateOreReserve = (orebody, density) => {
    return geologyManagerService.calculateOreReserve(orebody, density)
  }

  /**
   * 生成报告
   */
  const generateGeologyReport = options => {
    const report = geologyManagerService.generateGeologyReport({
      boreholes: store.boreholes,
      sections: store.sections,
      orebodies: store.orebodies,
      ...options
    })
    showOperationMessage('地质报告已生成', 'success')
    return report
  }

  const destroy = () => {
    if (geologyVisualizer) {
      geologyVisualizer.clearAll()
      geologyVisualizer = null
    }
  }

  return {
    boreholes,
    orebodies,
    sections,
    geologicalStats,

    initGeologyManager,
    initBoreholes,
    showBoreholeDetails,
    createGeologicalSection,
    calculateOreReserve,
    generateGeologyReport,

    exportBoreholeData: data => exportBoreholesToJSON(data || store.boreholes),
    exportGeologyReport: exportGeologyReport,
    calculateStratigraphyStats: () => calculateStratigraphyStats(store.boreholes),

    destroy
  }
}
