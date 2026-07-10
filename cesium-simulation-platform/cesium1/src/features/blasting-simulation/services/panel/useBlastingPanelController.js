import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import useBlasting from '../useBlasting.js'
import useUI from '@/composables/useUI.js'
import useModel from '@/features/model-control/services/useModel.js'
import { fetchBlastingResults } from '../blastingApi.js'

export function useBlastingPanelController() {
  const fileInput = ref(null)
  const activeTab = ref('playback')
  const { closeTool } = useUI()
  const { resetView } = useModel()

  const {
    dataset,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    // B1 回放增强
    playbackRate,
    isLooping,
    abLoop,
    cyclePlaybackRate,
    stepFrame,
    toggleLoop,
    markAbLoopPoint,
    clearAbLoop,
    toggleAbLoop,
    // B7 加载进度
    loadProgress,
    // three.js 渲染
    threeStats,
    replayBlast,
    // KCO 模型参数（碎块尺寸分布）
    kcoParams,
    resetKcoParams,
    // 图层可见性与爆破设计
    LAYER_DEFS,
    layerVisibility,
    setLayerVisible,
    syncLayerVisibility,
    blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    loadDbEvents,
    loadDbEvent,
    // SubTask 6.7：模拟结果保存
    saveSimulationResult,
    flyToCenter,
    setFrame,
    togglePlayback,
    clearSimulation,
    // 爆破效果评价：数据获取 + 联动高亮
    getDamageZones,
    highlightDamageZone,
    highlightBlockClass,
    getBlastEffectStats,
    getPPVFieldStats,
    setSafetyStandard,
    loadPPVField,
    flyToFarthestFragment
  } = useBlasting()

  const eventName = computed(() => dataset.value?.event?.name || '-')

  // 组件挂载时加载事件列表
  onMounted(() => {
    loadDbEvents()
  })

  // 加载数据库事件
  const onDbEventChange = async eventId => {
    if (!eventId) return
    await loadDbEvent(eventId, { autoPlay: true })
  }

  // 退出爆破板块：清理场景 + 重置视角到模型 + 关闭面板
  const exitBlasting = () => {
    clearSimulation()
    resetView?.()
    closeTool()
  }

  // 保存模拟结果回写到数据库
  const saveResult = () => {
    saveSimulationResult()
  }

  // ─── SubTask 11：历史对比 ────────────────────────────
  const compareEventIds = ref([])
  const comparisonData = ref([])
  const comparing = ref(false)

  const compareEvents = async () => {
    if (compareEventIds.value.length < 2) {
      ElMessage.warning('请至少选择 2 个事件进行对比')
      return
    }
    comparing.value = true
    try {
      const rows = await fetchBlastingResults(compareEventIds.value)
      comparisonData.value = Array.isArray(rows) ? rows : []
      if (comparisonData.value.length === 0) {
        ElMessage.warning('所选事件暂无爆破结果数据')
      } else {
        ElMessage.success(`已加载 ${comparisonData.value.length} 条对比数据`)
      }
    } catch (e) {
      ElMessage.error('对比数据加载失败：' + (e?.message || e))
      comparisonData.value = []
    } finally {
      comparing.value = false
    }
  }

  // 将 comparisonData 转换为图表就绪数据（按指标归一化：每条柱宽 = value/max*100%）
  const comparisonCharts = computed(() => {
    if (!comparisonData.value.length) return []
    // 事件ID → 名称映射（dbEvents 来自 list_events，字段为 camelCase）
    const nameMap = {}
    for (const ev of dbEvents.value) {
      nameMap[ev.eventId] = ev.name
    }
    const metrics = [
      { key: 'fragmentX50', label: '碎块中位粒径', unit: 'm' },
      { key: 'throwDistanceMax', label: '最大抛掷距离', unit: 'm' },
      { key: 'vibrationPeak', label: '振动峰值', unit: '' }
    ]
    return metrics.map(m => {
      const items = comparisonData.value.map(r => ({
        name: nameMap[r.eventId] || r.eventId || '-',
        value: Number(r[m.key]) || 0
      }))
      const max = Math.max(...items.map(i => i.value), 0)
      return {
        label: m.label,
        unit: m.unit,
        max,
        items: items.map(i => ({
          ...i,
          percent: max > 0 ? (i.value / max) * 100 : 0
        }))
      }
    })
  })

  return {
    fileInput,
    activeTab,
    dataset,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    // B1 回放增强
    playbackRate,
    isLooping,
    abLoop,
    cyclePlaybackRate,
    stepFrame,
    toggleLoop,
    markAbLoopPoint,
    clearAbLoop,
    toggleAbLoop,
    // B7 加载进度
    loadProgress,
    // three.js 渲染
    threeStats,
    replayBlast,
    // KCO 模型参数（碎块尺寸分布）
    kcoParams,
    resetKcoParams,
    // 图层可见性与爆破设计
    LAYER_DEFS,
    layerVisibility,
    setLayerVisible,
    syncLayerVisibility,
    blastDesign,
    // MySQL 数据库事件
    dbEvents,
    dbLoading,
    currentEventId,
    loadDbEvents,
    loadDbEvent,
    flyToCenter,
    eventName,
    onDbEventChange,
    saveResult,
    togglePlayback,
    clearSimulation,
    exitBlasting,
    onFrameChange: setFrame,
    onSpeedChange: v => {
      playbackSpeedMs.value = Number(v || 50)
    },
    // SubTask 11：历史对比
    compareEventIds,
    comparisonData,
    comparisonCharts,
    comparing,
    compareEvents,
    // 爆破效果评价
    getDamageZones,
    highlightDamageZone,
    highlightBlockClass,
    getBlastEffectStats,
    getPPVFieldStats,
    setSafetyStandard,
    loadPPVField,
    flyToFarthestFragment
  }
}
