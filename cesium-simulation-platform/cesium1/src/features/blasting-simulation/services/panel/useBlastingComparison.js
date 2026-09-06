import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { fetchBlastingResults } from '../blastingApi.js'

const COMPARISON_METRICS = [
  { key: 'fragmentX50', label: '中位块度 x50', unit: 'm' },
  { key: 'fragmentX80', label: '筛余块度 x80', unit: 'm' },
  { key: 'throwDistanceMax', label: '最大抛掷距离', unit: 'm' },
  { key: 'throwDistanceAvg', label: '平均抛掷距离', unit: 'm' },
  { key: 'vibrationPeak', label: '振动峰值', unit: 'cm/s' },
  { key: 'craterDepth', label: '漏斗深度', unit: 'm' },
  { key: 'craterRadius', label: '漏斗半径', unit: 'm' }
]

export function useBlastingComparison(dbEvents) {
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

  const comparisonCharts = computed(() => {
    if (!comparisonData.value.length) return []
    const nameMap = {}
    for (const ev of dbEvents.value) {
      nameMap[ev.eventId] = ev.name
    }
    return COMPARISON_METRICS.map(m => {
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
    compareEventIds,
    comparisonData,
    comparing,
    compareEvents,
    comparisonCharts
  }
}
