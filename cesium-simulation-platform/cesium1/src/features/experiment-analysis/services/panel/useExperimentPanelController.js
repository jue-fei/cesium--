import { ref, computed, onUnmounted } from 'vue'
import {
  renderHeatmapsOnMainThread,
  createExperimentWorkerClient
} from '../benchmark/experimentWorkerClient.js'
import { formatTimingMs } from '../benchmark/statisticsUtils.js'
import { exportExperimentResultsToExcel } from './experimentExcelExport.js'
import {
  EXPERIMENT_DEFAULT_CONFIG,
  EXPERIMENT_PRESETS,
  METHOD_LABELS,
  METRIC_LABELS,
  METRIC_UNITS,
  EXPERIMENT_PHASES,
  METHOD_INTRO,
  EXPERIMENT_DESIGN
} from '../../types/experimentDefaults.js'
import useMessage from '@/composables/useMessage.js'

const VISUAL_METRICS = [
  {
    key: 'rmse',
    title: 'RMSE 误差对比',
    caption: '条越短越好，能直接看出整体预测误差大小',
    lowerIsBetter: true
  },
  {
    key: 'mae',
    title: 'MAE 平均偏差',
    caption: '条越短越好，反映平均偏离真值的程度',
    lowerIsBetter: true
  },
  {
    key: 'r2',
    title: 'R² 拟合程度',
    caption: '条越长越好，越接近 1 表示越贴近真实场',
    lowerIsBetter: false
  }
]
const DISPLAY_METRICS = ['rmse', 'mae', 'r2', 'maxError', 'mape']

const STABILITY_LEVELS = [
  { maxCv: 5, label: '很稳定', tone: 'good' },
  { maxCv: 15, label: '较稳定', tone: 'ok' },
  { maxCv: Infinity, label: '需复核', tone: 'warn' }
]

function clampPercent(value, min = 3) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(100, value))
}

function metricRankValue(value, lowerIsBetter) {
  if (!Number.isFinite(value)) return lowerIsBetter ? Infinity : -Infinity
  return value
}

function createPresetConfig(presetId) {
  const newConfig = JSON.parse(JSON.stringify(EXPERIMENT_DEFAULT_CONFIG))
  const preset = EXPERIMENT_PRESETS.find(p => p.id === presetId)
  if (!preset) return newConfig

  if (preset.config.dataGeneration) {
    Object.assign(newConfig.dataGeneration, preset.config.dataGeneration)
  }
  if (preset.config.comparison) {
    Object.assign(newConfig.comparison, preset.config.comparison)
    if (preset.config.comparison.idwConfig) {
      newConfig.comparison.idwConfig = {
        ...EXPERIMENT_DEFAULT_CONFIG.comparison.idwConfig,
        ...preset.config.comparison.idwConfig
      }
    }
    if (preset.config.comparison.krigingConfig) {
      newConfig.comparison.krigingConfig = {
        ...EXPERIMENT_DEFAULT_CONFIG.comparison.krigingConfig,
        ...preset.config.comparison.krigingConfig
      }
    }
  }
  return newConfig
}

function getStabilityLevel(cv) {
  if (!Number.isFinite(cv)) return { label: 'N/A', tone: 'warn' }
  return (
    STABILITY_LEVELS.find(level => cv <= level.maxCv) ||
    STABILITY_LEVELS[STABILITY_LEVELS.length - 1]
  )
}

export default function useExperimentPanel() {
  const { showOperationMessage } = useMessage()
  const showMethodIntro = ref(false)
  const currentPreset = ref('visual_contrast')
  const config = ref(createPresetConfig(currentPreset.value))
  const results = ref(null)
  const status = ref('idle') // 'idle' | 'running' | 'completed' | 'error' | 'timeout'
  const currentPhase = ref('')
  const progressMessage = ref('')
  const workerPercent = ref(0)
  const heatmapRendering = ref(false)

  const presetOptions = EXPERIMENT_PRESETS

  const selectedPreset = computed(() => EXPERIMENT_PRESETS.find(p => p.id === currentPreset.value))

  const isRunning = computed(() => status.value === 'running')

  const progressPercent = computed(() => {
    if (status.value === 'completed') return 100
    if (heatmapRendering.value) return 96
    return workerPercent.value
  })

  const methodResults = computed(() => {
    if (!results.value?.comparison?.rows) return []
    return results.value.comparison.rows.map(row => ({
      ...row,
      methodLabel: METHOD_LABELS[row.key] || row.method,
      formattedTiming: formatTimingMs(row.timing?.totalMs),
      metrics: DISPLAY_METRICS.map(key => ({
        key,
        label: METRIC_LABELS[key] || key,
        value: formatMetricValue(row.metrics?.[key], METRIC_UNITS[key]),
        unit: METRIC_UNITS[key] || '',
        raw: row.metrics?.[key]
      }))
    }))
  })

  const visualMetricCards = computed(() => {
    const rows = results.value?.comparison?.rows || []
    if (!rows.length) return []

    return VISUAL_METRICS.map(metric => {
      const validRows = rows
        .map(row => ({
          key: row.key,
          methodLabel: METHOD_LABELS[row.key] || row.method,
          raw: Number(row.metrics?.[metric.key]),
          formatted: formatMetricValue(row.metrics?.[metric.key], METRIC_UNITS[metric.key])
        }))
        .filter(row => Number.isFinite(row.raw))

      if (!validRows.length) return null

      const bestRaw = metric.lowerIsBetter
        ? Math.min(...validRows.map(r => r.raw))
        : Math.max(...validRows.map(r => r.raw))
      const worstRaw = metric.lowerIsBetter
        ? Math.max(...validRows.map(r => r.raw))
        : Math.min(...validRows.map(r => r.raw))
      const maxMagnitude = Math.max(...validRows.map(r => Math.abs(r.raw)), 1e-9)

      const rankedRows = validRows
        .map(row => {
          const barWidth =
            metric.key === 'r2'
              ? clampPercent(Math.max(0, Math.min(1, row.raw)) * 100)
              : clampPercent((Math.abs(row.raw) / maxMagnitude) * 100)
          return { ...row, barWidth, isBest: row.raw === bestRaw, isWorst: row.raw === worstRaw }
        })
        .sort((a, b) => {
          const av = metricRankValue(a.raw, metric.lowerIsBetter)
          const bv = metricRankValue(b.raw, metric.lowerIsBetter)
          return metric.lowerIsBetter ? av - bv : bv - av
        })

      return { ...metric, rows: rankedRows }
    }).filter(Boolean)
  })

  const visibleSummary = computed(() => {
    const rows = results.value?.comparison?.rows || []
    const validRows = rows
      .map(row => ({
        key: row.key,
        methodLabel: METHOD_LABELS[row.key] || row.method,
        rmse: Number(row.metrics?.rmse)
      }))
      .filter(row => Number.isFinite(row.rmse))

    if (validRows.length < 2) return null
    const best = validRows.reduce((a, b) => (a.rmse < b.rmse ? a : b))
    const worst = validRows.reduce((a, b) => (a.rmse > b.rmse ? a : b))
    const gapPercent = worst.rmse > 0 ? ((worst.rmse - best.rmse) / worst.rmse) * 100 : 0

    return {
      best,
      worst,
      gapPercent,
      text: `${best.methodLabel} 的 RMSE 比 ${worst.methodLabel} 低 ${gapPercent.toFixed(1)}%`
    }
  })

  const psoVisual = computed(() => {
    const defaultRmse = Number(results.value?.idwDefault?.metrics?.rmse)
    const optimizedRmse = Number(results.value?.idw?.metrics?.rmse)
    if (!Number.isFinite(defaultRmse) || !Number.isFinite(optimizedRmse) || defaultRmse <= 0)
      return null
    const improvement = ((defaultRmse - optimizedRmse) / defaultRmse) * 100
    return {
      defaultLabel: formatMetricValue(defaultRmse, METRIC_UNITS.rmse),
      optimizedLabel: formatMetricValue(optimizedRmse, METRIC_UNITS.rmse),
      optimizedWidth: clampPercent((optimizedRmse / defaultRmse) * 100),
      improvement
    }
  })

  const feasibilityReport = computed(() => {
    const sampleCount = Number(config.value.dataGeneration?.pointCount)
    const testRatio = Number(config.value.dataGeneration?.testRatio)
    const repeatCount = Number(config.value.comparison?.repeatCount)
    const krigingModelCount = config.value.comparison?.krigingModels?.length || 0
    const warnings = []
    if (sampleCount < 40) warnings.push('采样点偏少，适合做强对比演示，但统计稳定性较弱')
    if (testRatio < 0.2) warnings.push('测试集比例偏低，建议保持在 0.2 到 0.35 之间')
    if (repeatCount < 5) warnings.push('重复轮次少于 5，建议使用重复实验获得均值和标准差')
    if (krigingModelCount < 2) warnings.push('Kriging 模型少于 2 个，变异函数敏感性分析不足')
    return {
      ...EXPERIMENT_DESIGN.feasibility,
      warnings,
      reliabilityLabel: warnings.length === 0 ? '专业对比配置' : '可行但需注意',
      reliabilityTone: warnings.length === 0 ? 'good' : 'ok',
      protocol: EXPERIMENT_DESIGN.protocol,
      controls: EXPERIMENT_DESIGN.controls
    }
  })

  const stabilityRows = computed(() => {
    const aggregation = results.value?.aggregation
    if (!aggregation) return []
    return Object.entries(aggregation)
      .map(([key, data]) => {
        const rmse = data?.metrics?.rmse
        const mean = rmse?.mean
        const std = rmse?.std
        const cv =
          Number.isFinite(mean) && Math.abs(mean) > 1e-9 && Number.isFinite(std)
            ? Math.abs(std / mean) * 100
            : NaN
        const level = getStabilityLevel(cv)
        return {
          key,
          methodLabel: METHOD_LABELS[key] || key,
          meanLabel: formatMetricValue(mean, METRIC_UNITS.rmse),
          stdLabel: formatMetricValue(std, METRIC_UNITS.rmse),
          cv,
          cvLabel: Number.isFinite(cv) ? `${cv.toFixed(1)}%` : 'N/A',
          levelLabel: level.label,
          tone: level.tone,
          repeatCount: data?.repeatCount || results.value?.repeatCount
        }
      })
      .sort((a, b) => {
        const av = Number.isFinite(Number(aggregation[a.key]?.metrics?.rmse?.mean))
          ? Number(aggregation[a.key]?.metrics?.rmse?.mean)
          : Infinity
        const bv = Number.isFinite(Number(aggregation[b.key]?.metrics?.rmse?.mean))
          ? Number(aggregation[b.key]?.metrics?.rmse?.mean)
          : Infinity
        return av - bv
      })
  })

  const heatmapImages = computed(() => {
    return results.value?.heatmap || null
  })

  const conclusion = computed(() => {
    if (!results.value?.comparison?.rows) return null
    const rows = results.value.comparison.rows
    let bestMethod = null,
      bestRMSE = Infinity
    for (const row of rows) {
      const rmse = row.metrics?.rmse
      if (rmse !== undefined && rmse !== null && rmse < bestRMSE) {
        bestRMSE = rmse
        bestMethod = METHOD_LABELS[row.key] || row.method
      }
    }
    return {
      bestMethod,
      bestRMSE,
      totalMethods: rows.length,
      summary: bestMethod
        ? `最佳插值方法为 ${bestMethod}，RMSE = ${formatMetricValue(bestRMSE, METRIC_UNITS.rmse)}`
        : '暂无结论'
    }
  })

  function applyPreset(presetId) {
    currentPreset.value = presetId
    config.value = createPresetConfig(presetId)
  }

  // ============ Worker Client ============
  let workerClient = null

  function ensureClient() {
    if (!workerClient) {
      workerClient = createExperimentWorkerClient({
        timeoutMs: 60000,
        onProgress: msg => {
          currentPhase.value = msg.phase
          progressMessage.value = msg.message
          workerPercent.value = msg.percent
        },
        onComplete: async workerResult => {
          // Worker 计算完成，在主线程渲染热力图
          heatmapRendering.value = true
          progressMessage.value = '正在渲染热力图...'

          // 使用 setTimeout 让进度条有时间更新
          await new Promise(r => setTimeout(r, 30))

          let heatmapData = null
          try {
            if (workerResult.heatmapSnapshots && workerResult.heatmapSnapshots.length > 0) {
              heatmapData = renderHeatmapsOnMainThread(
                workerResult.heatmapSnapshots,
                workerResult.globalRange,
                workerResult.dataset.fieldSize
              )
            }
          } catch (renderErr) {
            console.error('[ExperimentPanel] 热力图渲染失败:', renderErr)
          }

          heatmapRendering.value = false

          results.value = {
            ...workerResult,
            heatmap: heatmapData
          }
          status.value = 'completed'
          currentPhase.value = 'done'
          progressMessage.value = '实验完成'
          workerPercent.value = 100
        },
        onError: err => {
          console.error('[ExperimentPanel] 实验执行失败:', err)
          status.value = 'error'
          progressMessage.value = `实验失败: ${err.message || '未知错误'}`
          workerPercent.value = 0
        },
        onTimeout: () => {
          status.value = 'timeout'
          progressMessage.value = '实验超时（60秒），请减少采样点数或关闭PSO优化后重试'
          workerPercent.value = 100
        },
        onCancelled: () => {
          status.value = 'idle'
          progressMessage.value = '实验已取消'
          workerPercent.value = 0
        }
      })
    }
    return workerClient
  }

  async function startExperiment() {
    if (isRunning.value) return
    status.value = 'running'
    results.value = null
    currentPhase.value = ''
    workerPercent.value = 0
    progressMessage.value = '正在启动实验引擎...'

    const client = ensureClient()
    client.run(JSON.parse(JSON.stringify(config.value)))
  }

  async function startRepeatedExperiment() {
    if (isRunning.value) return
    status.value = 'running'
    results.value = null
    currentPhase.value = ''
    workerPercent.value = 0
    progressMessage.value = '正在启动重复实验引擎...'

    const repeatCount = config.value.comparison?.repeatCount || 3
    const allResults = []
    let latestResult = null

    for (let i = 0; i < repeatCount; i++) {
      if (status.value !== 'running') break

      progressMessage.value = `第 ${i + 1}/${repeatCount} 轮实验运行中...`
      workerPercent.value = Math.round((i / repeatCount) * 90)

      const modifiedConfig = JSON.parse(JSON.stringify(config.value))
      if (modifiedConfig.dataGeneration) {
        modifiedConfig.dataGeneration.seed = (config.value.dataGeneration?.seed || 2026) + i * 100
      }

      try {
        // 使用独立的 client 实例避免干扰主 client
        const tempClient = createExperimentWorkerClient({
          timeoutMs: 60000
        })
        const roundResult = await tempClient.run(modifiedConfig)
        tempClient.destroy()

        if (roundResult) {
          allResults.push(roundResult)
          latestResult = roundResult
        }
      } catch (err) {
        console.error(`[ExperimentPanel] 第 ${i + 1} 轮失败:`, err)
        if (err.message === 'TIMEOUT') {
          status.value = 'timeout'
          progressMessage.value = `第 ${i + 1} 轮实验超时，已完成 ${allResults.length} 轮`
          return
        }
        break
      }
    }

    if (allResults.length === 0) {
      status.value = 'error'
      progressMessage.value = '重复实验未能完成任何一轮'
      return
    }

    // 聚合重复实验结果
    const aggregation = aggregateRepeatResults(allResults)

    // 渲染最后一轮的热力图
    heatmapRendering.value = true
    progressMessage.value = '正在渲染热力图...'
    await new Promise(r => setTimeout(r, 30))

    let heatmapData = null
    try {
      if (latestResult?.heatmapSnapshots && latestResult.heatmapSnapshots.length > 0) {
        heatmapData = renderHeatmapsOnMainThread(
          latestResult.heatmapSnapshots,
          latestResult.globalRange,
          latestResult.dataset?.fieldSize
        )
      }
    } catch (renderErr) {
      console.error('[ExperimentPanel] 热力图渲染失败:', renderErr)
    }

    heatmapRendering.value = false

    results.value = {
      ...(latestResult || {}),
      aggregation,
      repeatCount: allResults.length,
      heatmap: heatmapData
    }
    status.value = 'completed'
    currentPhase.value = 'done'
    workerPercent.value = 100
    progressMessage.value = `${allResults.length} 轮重复实验完成`
  }

  function cancelExperiment() {
    if (!isRunning.value) return
    if (workerClient) {
      workerClient.cancel()
    }
    status.value = 'idle'
    progressMessage.value = '实验已取消'
    workerPercent.value = 0
  }

  async function exportResults() {
    if (!results.value) return
    try {
      await exportExperimentResultsToExcel({
        config: JSON.parse(JSON.stringify(config.value)),
        results: JSON.parse(JSON.stringify(results.value))
      })
      showOperationMessage('Excel 导出成功', 'success')
    } catch (error) {
      console.error('[ExperimentPanel] Excel 导出失败:', error)
      showOperationMessage(error?.message || 'Excel 导出失败', 'error')
    }
  }

  // 组件卸载时清理 Worker
  onUnmounted(() => {
    if (workerClient) {
      workerClient.destroy()
      workerClient = null
    }
  })

  return {
    config,
    results,
    status,
    currentPhase,
    progressMessage,
    currentPreset,
    selectedPreset,
    presetOptions,
    isRunning,
    progressPercent,
    methodResults,
    visualMetricCards,
    visibleSummary,
    psoVisual,
    feasibilityReport,
    stabilityRows,
    heatmapImages,
    conclusion,
    showMethodIntro,
    EXPERIMENT_PHASES,
    METHOD_INTRO,
    EXPERIMENT_DESIGN,
    applyPreset,
    startExperiment,
    startRepeatedExperiment,
    cancelExperiment,
    exportResults
  }
}

// ============ 辅助函数（复用自 statisticsUtils） ============

function computeBasicStats(values) {
  const filtered = values.filter(v => Number.isFinite(Number(v))).map(Number)
  if (filtered.length === 0)
    return { count: 0, min: null, max: null, mean: null, std: null, median: null }
  filtered.sort((a, b) => a - b)
  const n = filtered.length
  let sum = 0
  for (const v of filtered) sum += v
  const mean = sum / n
  let sumSqDiff = 0
  for (const v of filtered) sumSqDiff += (v - mean) ** 2
  const std = Math.sqrt(sumSqDiff / n)
  const median =
    n % 2 === 1 ? filtered[Math.floor(n / 2)] : (filtered[n / 2 - 1] + filtered[n / 2]) / 2
  return { count: n, min: filtered[0], max: filtered[n - 1], mean, std, median }
}

function aggregateRepeatResults(allResults) {
  if (!Array.isArray(allResults) || allResults.length === 0) return null

  const methodKeys = new Set()
  for (const r of allResults) {
    for (const row of r.comparison?.rows || []) {
      methodKeys.add(row.key)
    }
  }

  const methodAggs = {}
  for (const mKey of methodKeys) {
    const metricAgg = {}
    for (const m of DISPLAY_METRICS) {
      const vals = allResults
        .map(r => {
          const row = (r.comparison?.rows || []).find(c => c.key === mKey)
          return Number(row?.metrics?.[m])
        })
        .filter(Number.isFinite)
      if (vals.length > 0) {
        const stats = computeBasicStats(vals)
        metricAgg[m] = {
          mean: stats.mean,
          std: stats.std,
          min: stats.min,
          max: stats.max,
          count: vals.length
        }
      }
    }
    methodAggs[mKey] = { metrics: metricAgg, repeatCount: valsLength(metricAgg) }
  }

  return methodAggs
}

function valsLength(metricAgg) {
  for (const key of Object.keys(metricAgg)) {
    if (metricAgg[key]?.count) return metricAgg[key].count
  }
  return 0
}

function formatMetricValue(value, unit = '') {
  if (!Number.isFinite(value)) return 'N/A'
  if (unit === '%') return value.toFixed(2) + '%'
  if (Math.abs(value) < 0.01) return value.toExponential(3)
  if (Math.abs(value) < 1) return value.toFixed(4)
  if (Math.abs(value) < 100) return value.toFixed(2)
  return value.toFixed(1)
}
