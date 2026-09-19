/**
 * useExperimentRawData.js —— 随机生成数据详情表（ExperimentPanel 专用 composable）
 *
 * 持有"随机生成数据详情"区块的折叠态 / 训练-测试页签 / 翻页状态，
 * 并从 results.dataset 派生当前页行（坐标、观测值、真值、噪声偏差、异常标记）
 * 与该页签的统计量（最小/最大/均值/标准差）。
 */
import { ref, computed } from 'vue'

// 详情表每页展示的数据点行数
const RAW_DATA_PAGE_SIZE = 25

export function useExperimentRawData({ results }) {
  // ============ 随机生成数据展示 ============
  const showRawData = ref(false)
  const rawDataTab = ref('train')
  const rawDataPage = ref(0)
  const rawDataPageSize = RAW_DATA_PAGE_SIZE

  const rawDataTotalPages = computed(() => {
    const count =
      rawDataTab.value === 'train'
        ? results.value?.dataset?.trainCount || 0
        : results.value?.dataset?.testCount || 0
    return Math.max(1, Math.ceil(count / rawDataPageSize))
  })

  const rawDataStats = computed(() => {
    const ds = results.value?.dataset
    if (!ds) return { minVal: '-', maxVal: '-', meanVal: '-', stdVal: '-' }

    const values = rawDataTab.value === 'train' ? ds.trainTrueValues || [] : ds.testTrueValues || []

    if (!values.length) return { minVal: '-', maxVal: '-', meanVal: '-', stdVal: '-' }

    let min = Infinity,
      max = -Infinity,
      sum = 0
    for (const v of values) {
      const n = Number(v)
      if (Number.isFinite(n)) {
        if (n < min) min = n
        if (n > max) max = n
        sum += n
      }
    }
    const mean = sum / values.length
    let sumSq = 0
    for (const v of values) {
      const n = Number(v)
      if (Number.isFinite(n)) sumSq += (n - mean) ** 2
    }
    const std = Math.sqrt(sumSq / values.length)

    return {
      minVal: min.toFixed(4),
      maxVal: max.toFixed(4),
      meanVal: mean.toFixed(4),
      stdVal: std.toFixed(4)
    }
  })

  const visibleRawData = computed(() => {
    const ds = results.value?.dataset
    if (!ds) return []

    const isTrain = rawDataTab.value === 'train'
    const points = isTrain ? ds.trainPoints || [] : ds.testPoints || []
    const displayValues = isTrain ? ds.trainValues || [] : ds.testTrueValues || []
    const trueValues = isTrain ? ds.trainTrueValues || [] : []
    const anomalyFlags = isTrain ? ds.trainAnomaly || [] : ds.testAnomaly || []

    const start = rawDataPage.value * rawDataPageSize
    const end = Math.min(start + rawDataPageSize, points.length)

    const rows = []
    for (let i = start; i < end; i++) {
      const p = points[i]
      const displayVal = Number(displayValues[i])
      const trueVal = Number(trueValues[i])
      const noiseDelta = Number.isFinite(trueVal) ? (displayVal - trueVal).toFixed(4) : '-'

      rows.push({
        index: i,
        x: Number(p?.x) || 0,
        y: Number(p?.y) || 0,
        z: Number(p?.z) || 0,
        displayValue: displayVal,
        trueValue: trueVal,
        noiseDelta,
        isAnomaly: !!anomalyFlags[i]
      })
    }
    return rows
  })

  return {
    showRawData,
    rawDataTab,
    rawDataPage,
    rawDataPageSize,
    rawDataTotalPages,
    rawDataStats,
    visibleRawData
  }
}
