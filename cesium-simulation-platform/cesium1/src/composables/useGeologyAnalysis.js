import { watch, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useGeologyStore } from '../stores/geologyStore.js'
import {
  GeologyManager,
  geologyAnalysisUtils,
  geologyExportUtils
} from '../features/geology/geologyManager.js'
import { GeologyVisualizer } from '../features/geology/geologyVisualizer.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'

// 单例实例
let geologyVisualizer = null
const geologyManagerService = new GeologyManager()

export default function useGeologyAnalysis() {
  const { getViewer } = useViewer()
  const { showOperationMessage } = useMessage()

  const store = useGeologyStore()
  const { boreholes, orebodies, sections, stats } = storeToRefs(store)

  const geologicalStats = computed(() => [
    {
      id: 'avg-thick',
      label: '平均厚度',
      value: stats.value.averageThickness,
      unit: 'm',
      icon: '📏'
    },
    {
      id: 'min-int',
      label: '矿化强度',
      value: stats.value.mineralizationIntensity,
      unit: '',
      icon: '⚡'
    },
    {
      id: 'est-res',
      label: '预估储量',
      value: stats.value.estimatedReserves,
      unit: '万吨',
      icon: '⚖️'
    },
    {
      id: 'avg-grade',
      label: '平均品位',
      value: stats.value.averageGrade,
      unit: '%',
      icon: '💎'
    }
  ])

  /**
   * 初始化地质分析模块
   * @param {Object} viewerInstance
   */
  const initGeologyManager = (viewerInstance = null) => {
    const viewer = viewerInstance || getViewer()

    if (!viewer) return

    if (!viewer.scene || !viewer.scene.primitives) {
      console.warn('GeologyVisualizer: Viewer 场景未就绪')
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

    // 数据为空时写入默认数据
    /*
    if (store.boreholes.length === 0) {
      const dummyBoreholes = [
        {
          id: 'ZK001',
          name: 'ZK-001',
          x: 110.1,
          y: 30.1,
          z: 100,
          depth: 245.5,
          stratigraphy: [
            { depth: 0, lithology: 'Topsoil', thickness: 5 },
            { depth: 5, lithology: 'Sandstone', thickness: 100 },
            { depth: 105, lithology: 'Granite', thickness: 140.5 }
          ]
        },
        { id: 'ZK002', name: 'ZK-002', x: 110.2, y: 30.2, z: 105, depth: 312.8, stratigraphy: [] }
      ]
      store.setBoreholes(geologyManagerService.processBoreholes(dummyBoreholes))
    }
    */

    if (store.orebodies.length === 0) {
      const dummyOrebodies = [
        {
          id: 'ore1',
          name: '主矿体',
          grade: 2.5,
          reserves: 500,
          thickness: 12.5,
          boundingBox: { minX: 0, maxX: 100, minY: 0, maxY: 100, minZ: 0, maxZ: 50 }
        },
        {
          id: 'ore2',
          name: '北翼延伸',
          grade: 1.2,
          reserves: 120,
          thickness: 8.0,
          boundingBox: { minX: 100, maxX: 150, minY: 0, maxY: 50, minZ: 0, maxZ: 30 }
        }
      ]
      store.setOrebodies(dummyOrebodies)
    }

    if (store.stats.estimatedReserves === 0) {
      store.updateStats({
        averageThickness: 15.4,
        mineralizationIntensity: 0.85,
        estimatedReserves: 620,
        averageGrade: 1.85
      })
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

    exportBoreholeData: data => geologyExportUtils.exportBoreholesToJSON(data || store.boreholes),
    exportGeologyReport: geologyExportUtils.exportGeologyReport,
    calculateStratigraphyStats: () =>
      geologyAnalysisUtils.calculateStratigraphyStats(store.boreholes),

    destroy
  }
}
