import { ref, onMounted, watch, computed } from 'vue'
import * as Cesium from 'cesium'
import { ElMessageBox } from 'element-plus'
import useStress, {
  STRESS_METRIC_LABELS,
  buildStressMetricOptions
} from '../../../../composables/useStress.js'
import {
  buildChartView,
  buildSvgContent,
  clamp01,
  downloadText,
  exportChartPng,
  fetchText,
  formatAxisNumber,
  formatNumber,
  formatScientific,
  measureEvaluation,
  safeInt
} from './stressPanelUtils.js'

export function useStressPanelController() {
  const stress = useStress()
  const {
    currentTime,
    maxTime,
    timeDimension,
    isPlaying,
    config,
    metric,
    metricLabel,
    unitStress,
    materialE,
    materialNu,
    isStrainSource,
    directionAzimuth,
    directionDip,
    pickedPoint,
    pickedPointValue,
    pickedPointDetails,
    pickedPointSeries,
    importStatus,
    heatmapDisplay
  } = stress.state
  const {
    initStressManager,
    exitStressAnalysis,
    togglePlayback,
    setTime,
    getCurrentValueRange,
    parseAndSetStressFile,
    setHeatmapDisplay,
    setMaterial,
    setMetric,
    setDirection,
    pickPointOnModel,
    buildPointSeriesForMetric,
    buildPointAllMetricsSeries
  } = stress.actions

  const fileInput = ref(null)
  const sliderTime = ref(currentTime.value)
  const evaluationRunning = ref(false)
  const evaluationResult = ref(null)
  const feedback = ref({ usability: 4, clarity: 4, smoothness: 4, notes: '' })
  const heatmapContrast = ref(1.9)
  const heatmapGamma = ref(0.72)
  const heatmapCutoff = ref(0)
  const heatmapForceVisible = ref(0.82)
  const heatmapTuningExpanded = ref(false)
  const chartDialogVisible = ref(false)
  const chartXAxisMode = ref('time')
  const chartYAxisMode = ref('value')
  const chartWidth = 640
  const chartHeight = 240
  const chartLargeWidth = 1280
  const chartLargeHeight = 620
  const chartYAxisOptions = [
    { value: 'value', label: '应力值' },
    { value: 'normalized', label: '归一化值(0~1)' },
    { value: 'delta_percent', label: '相对初值变化率(%)' }
  ]

  const EXAMPLE_URL = '/stress/应力分析_示例数据_自动生成-模型中心.json'

  const timeLabel = computed(() => {
    const map = { day: '日', week: '周', month: '月' }
    return map[timeDimension.value] || timeDimension.value
  })

  onMounted(() => {
    initStressManager()
  })

  const importedHint = computed(() => {
    const frames = config.value?.time?.frames || config.value?.field?.data?.frames?.length || 0
    if (!frames) return '未导入文件时，使用默认示例配置'
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    const mode = config.value?.field?.data?.frames?.length ? '体素场' : '点应力'
    return `当前模式：${mode}；帧数：${frames}；单位：${unit || '-'}`
  })

  const chartMetric = ref(metric.value)
  const isPointMode = computed(
    () => !config.value?.field?.data?.frames?.length && Boolean(config.value?.sources?.length)
  )
  const metricOptions = computed(() => {
    return buildStressMetricOptions(isPointMode.value)
  })
  const chartMetricOptions = metricOptions

  const chartMetricLabel = computed(() => {
    const v = chartMetric.value
    return chartMetricOptions.value.find(o => o.value === v)?.label || STRESS_METRIC_LABELS[v] || v
  })

  const materialHint = computed(() => {
    if (isStrainSource.value) return '当前文件为“应变”，将按本构关系换算应力（可调整 E、nu）'
    return '当前文件为“应力”，材料参数仅用于记录（不会参与换算）'
  })

  const valueRangeText = computed(() => {
    const range = getCurrentValueRange()
    if (!range) return '—'
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    return `${formatNumber(range.min)} ~ ${formatNumber(range.max)} ${unit}`
  })

  const gradientScaleRangeText = computed(() => {
    const range = getCurrentValueRange()
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    if (!range) return '相对应力'
    return `${formatAxisNumber(range.min)} ~ ${formatAxisNumber(range.max)} ${unit}`
  })

  const gradientUnitLabel = computed(() => {
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    return unit || '相对值'
  })

  const gradientCutoffText = computed(() => {
    const range = getCurrentValueRange() || { min: 0, max: 1 }
    const cutoff = clamp01(Number(heatmapCutoff.value))
    const min = Number(range.min)
    const max = Number(range.max)
    const value = min + (max - min) * cutoff
    return formatScientific(value)
  })

  const gradientLegendCss = computed(() => {
    const ramp = Array.isArray(config.value?.colorRamp) ? config.value.colorRamp : []
    const cutoff = clamp01(Number(heatmapCutoff.value))
    if (!ramp.length) {
      return { height: '260px', background: 'linear-gradient(to top, #0000ff 0%, #ff0000 100%)' }
    }
    const list = ramp
      .map((r, idx) => ({
        t: clamp01(Number(r?.value ?? idx / Math.max(1, ramp.length - 1))),
        color: String(r?.color || '#ffffff')
      }))
      .sort((a, b) => a.t - b.t)
    const firstColor = list[0].color
    const toRaw = t => cutoff + (1 - cutoff) * clamp01(t)
    const stops = [
      `${firstColor} 0%`,
      ...list.map(s => `${s.color} ${formatNumber(toRaw(s.t) * 100, 2)}%`)
    ].join(', ')
    return { height: '260px', background: `linear-gradient(to top, ${stops})` }
  })

  const gradientValueTickRows = computed(() => {
    const range = getCurrentValueRange() || { min: 0, max: 1 }
    const cutoff = clamp01(Number(heatmapCutoff.value))
    const min = Number(range.min)
    const max = Number(range.max)
    const span = Math.max(1e-6, max - min)
    const tickCount = 12
    const rows = []
    for (let i = tickCount; i >= 0; i--) {
      const colorT = i / tickCount
      const rawT = cutoff + (1 - cutoff) * colorT
      const value = min + span * rawT
      rows.push({
        text: formatScientific(value),
        major: i % 3 === 0 || i === tickCount || i === 0
      })
    }
    return rows
  })

  const applyHeatmapPanelTuning = () => {
    setHeatmapDisplay({
      contrast: heatmapContrast.value,
      gamma: heatmapGamma.value,
      cutoff: heatmapCutoff.value,
      forceVisible: heatmapForceVisible.value
    })
  }

  const applyHeatmapPreset = mode => {
    if (mode === 'clear') {
      heatmapContrast.value = 2.2
      heatmapGamma.value = 0.62
      heatmapCutoff.value = 0
      heatmapForceVisible.value = 0.92
    } else {
      heatmapContrast.value = 1.6
      heatmapGamma.value = 0.82
      heatmapCutoff.value = 0.01
      heatmapForceVisible.value = 0.7
    }
    applyHeatmapPanelTuning()
  }

  const canPick = computed(
    () =>
      Boolean(config.value?.field?.data?.frames?.length) || Boolean(config.value?.sources?.length)
  )
  const canExitAnalysis = computed(() => canPick.value)

  const pickHint = computed(() => {
    if (!canPick.value) return '请先导入应力/应变数据文件'
    return '左键选点；右键取消'
  })

  const pickedPointText = computed(() => {
    if (!pickedPoint.value) return ''
    const carto = Cesium.Cartographic.fromCartesian(pickedPoint.value)
    const lon = Cesium.Math.toDegrees(carto.longitude)
    const lat = Cesium.Math.toDegrees(carto.latitude)
    const h = carto.height || 0
    return `${formatNumber(lon, 6)}, ${formatNumber(lat, 6)}, ${formatNumber(h, 2)}m`
  })

  const pickedPointValueText = computed(() => {
    const v = pickedPointValue.value
    if (v === null || v === undefined) return '—'
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    return `${formatNumber(v)} ${unit}`
  })

  const chartXAxisOptions = computed(() => [
    { value: 'time', label: `时间点（${timeLabel.value}）` },
    { value: 'frame', label: '帧序号' }
  ])

  const chartXAxisLabel = computed(() =>
    chartXAxisMode.value === 'frame' ? '帧序号' : `时间（${timeLabel.value}）`
  )

  const chartYAxisLabel = computed(() => {
    if (chartYAxisMode.value === 'normalized') return '归一化值'
    if (chartYAxisMode.value === 'delta_percent') return '相对初值变化率(%)'
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    return unit ? `应力值（${unit}）` : '应力值'
  })

  const chartTitle = computed(() => {
    return `曲线图（${chartMetricLabel.value}，X:${chartXAxisLabel.value}，Y:${chartYAxisLabel.value}）`
  })

  const chartSeries = computed(() => {
    const src = Array.isArray(pickedPointSeries.value) ? pickedPointSeries.value : []
    const out = []
    for (let i = 0; i < src.length; i++) {
      const p = src[i]
      const t = Number(p?.t)
      const v = Number(p?.v)
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      out.push({ frame: i + 1, t, v })
    }
    return out
  })

  const chartView = computed(() =>
    buildChartView(chartSeries.value, {
      width: chartWidth,
      height: chartHeight,
      xMode: chartXAxisMode.value,
      yMode: chartYAxisMode.value
    })
  )

  const chartViewLarge = computed(() =>
    buildChartView(chartSeries.value, {
      width: chartLargeWidth,
      height: chartLargeHeight,
      xMode: chartXAxisMode.value,
      yMode: chartYAxisMode.value
    })
  )

  const openChartDialog = () => {
    if (!chartSeries.value.length) return
    chartDialogVisible.value = true
  }

  const onFileChange = async evt => {
    const file = evt?.target?.files?.[0]
    if (!file) return
    await parseAndSetStressFile(file)
    await showImportFailure()
    if (fileInput.value) fileInput.value.value = ''
  }

  const importExample = async () => {
    const text = await fetchText(EXAMPLE_URL)
    if (!text) return
    const file = new File([text], '应力分析_示例数据_复合载荷-模型中心.json', {
      type: 'application/json'
    })
    await parseAndSetStressFile(file)
    await showImportFailure()
  }

  const showImportFailure = async () => {
    if (!importStatus.value || importStatus.value.ok !== false) return
    await ElMessageBox.alert(
      [importStatus.value.message, ...(importStatus.value.details || [])].join('\n'),
      importStatus.value.title || '提示',
      { confirmButtonText: '知道了' }
    )
  }

  const onSliderChange = v => {
    sliderTime.value = Number(v) || 0
    setTime(sliderTime.value)
  }

  const onExitAnalysis = async () => {
    if (!canExitAnalysis.value) return
    const ok = window.confirm('确认退出应力分析？')
    if (!ok) return
    chartDialogVisible.value = false
    evaluationResult.value = null
    await exitStressAnalysis()
  }

  watch(
    heatmapDisplay,
    next => {
      if (!next) return
      heatmapContrast.value = Number(next.contrast) || 1.9
      heatmapGamma.value = Number(next.gamma) || 0.72
      heatmapCutoff.value = Number(next.cutoff) || 0
      heatmapForceVisible.value = Number(next.forceVisible) || 0.82
    },
    { immediate: true, deep: true }
  )

  const onPickPoint = async () => {
    await pickPointOnModel()
    chartMetric.value = metric.value
    if (pickedPoint.value) {
      const series = buildPointSeriesForMetric(pickedPoint.value, chartMetric.value)
      if (series.length) pickedPointSeries.value = series
    }
  }

  const onChartMetricChange = v => {
    chartMetric.value = v
    if (!pickedPoint.value) return
    const series = buildPointSeriesForMetric(pickedPoint.value, chartMetric.value)
    if (series.length) pickedPointSeries.value = series
  }

  const onChartXAxisModeChange = v => {
    chartXAxisMode.value = v === 'frame' ? 'frame' : 'time'
  }

  const onChartYAxisModeChange = v => {
    if (v === 'normalized' || v === 'delta_percent') {
      chartYAxisMode.value = v
      return
    }
    chartYAxisMode.value = 'value'
  }

  const exportCsv = () => {
    const series = pickedPointSeries.value || []
    if (!series.length) return
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    const rows = [`时间,${chartMetricLabel.value}(${unit})`]
    for (const p of series) {
      if (!Number.isFinite(p?.t) || !Number.isFinite(p?.v)) continue
      rows.push(`${p.t},${p.v}`)
    }
    downloadText(rows.join('\n'), '选点_时间-应力.csv', 'text/csv')
  }

  const exportCsvAll = () => {
    if (!pickedPoint.value) return
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    const rows = buildPointAllMetricsSeries(pickedPoint.value)
    if (!rows.length) return
    const header = [
      '时间',
      `σxx(${unit})`,
      `σyy(${unit})`,
      `σzz(${unit})`,
      `σxy(${unit})`,
      `σyz(${unit})`,
      `σzx(${unit})`,
      `σ1(${unit})`,
      `σ2(${unit})`,
      `σ3(${unit})`,
      `p(${unit})`,
      `-p(${unit})`,
      `J2(${unit}^2)`,
      `vonMises(${unit})`,
      `τmax(${unit})`,
      `τ_oct(${unit})`,
      `σnn(${unit})`,
      `τn(${unit})`
    ].join(',')
    const lines = [header]
    for (const r of rows) {
      lines.push(
        [
          r.t,
          r.sxx,
          r.syy,
          r.szz,
          r.sxy,
          r.syz,
          r.szx,
          r.sigma1,
          r.sigma2,
          r.sigma3,
          r.mean,
          r.pressure,
          r.j2,
          r.von_mises,
          r.tau_max,
          r.tau_oct,
          r.snn,
          r.tau_n
        ].join(',')
      )
    }
    downloadText(lines.join('\n'), '选点_时间-应力_全部指标.csv', 'text/csv')
  }

  const exportSvg = () => {
    const svg = buildSvgContent(
      chartView.value,
      chartTitle.value,
      chartXAxisLabel.value,
      chartYAxisLabel.value
    )
    if (!svg) return
    downloadText(svg, '选点_时间-应力.svg', 'image/svg+xml')
  }

  const exportPng = async () => {
    const view = chartView.value
    await exportChartPng(
      view,
      chartTitle.value,
      chartXAxisLabel.value,
      chartYAxisLabel.value,
      '选点_时间-应力.png'
    )
  }

  const exportDialogSvg = () => {
    const svg = buildSvgContent(
      chartViewLarge.value,
      chartTitle.value,
      chartXAxisLabel.value,
      chartYAxisLabel.value
    )
    if (!svg) return
    downloadText(svg, '选点_时间-应力_放大图.svg', 'image/svg+xml')
  }

  const exportDialogPng = async () => {
    await exportChartPng(
      chartViewLarge.value,
      chartTitle.value,
      chartXAxisLabel.value,
      chartYAxisLabel.value,
      '选点_时间-应力_放大图.png'
    )
  }

  const evaluationHint = computed(() => {
    if (evaluationRunning.value) return '评估中：请保持页面在前台'
    if (!evaluationResult.value) return '将生成性能/兼容性摘要，并可导出 JSON 报告'
    return `已完成：平均FPS ${formatNumber(evaluationResult.value.performance.avgFps, 1)}；P95帧耗时 ${formatNumber(evaluationResult.value.performance.p95FrameMs, 1)}ms`
  })

  const runAutoEvaluation = async () => {
    if (evaluationRunning.value) return
    evaluationRunning.value = true
    try {
      evaluationResult.value = await measureEvaluation(10000)
    } finally {
      evaluationRunning.value = false
    }
  }

  const exportEvaluation = () => {
    if (!evaluationResult.value) return
    downloadText(
      JSON.stringify(evaluationResult.value, null, 2),
      '应力渲染评估报告.json',
      'application/json'
    )
  }

  const exportFeedback = () => {
    const payload = {
      时间: new Date().toISOString(),
      评分: {
        易用性: safeInt(feedback.value.usability, 1, 5),
        清晰度: safeInt(feedback.value.clarity, 1, 5),
        流畅度: safeInt(feedback.value.smoothness, 1, 5)
      },
      备注: String(feedback.value.notes || ''),
      关联评估报告: evaluationResult.value ? '应力渲染评估报告.json' : ''
    }
    downloadText(JSON.stringify(payload, null, 2), '应力渲染反馈.json', 'application/json')
  }

  watch(currentTime, val => {
    sliderTime.value = val
  })

  return {
    fileInput,
    currentTime,
    maxTime,
    timeLabel,
    sliderTime,
    isPlaying,
    metric,
    metricLabel,
    metricOptions,
    materialE,
    materialNu,
    materialHint,
    isStrainSource,
    setMaterial,
    setMetric,
    directionAzimuth,
    directionDip,
    setDirection,
    valueRangeText,
    togglePlayback,
    canExitAnalysis,
    onExitAnalysis,
    onSliderChange,
    config,
    unitStress,
    importedHint,
    importStatus,
    onFileChange,
    importExample,
    gradientScaleRangeText,
    gradientCutoffText,
    gradientLegendCss,
    gradientValueTickRows,
    gradientUnitLabel,
    canPick,
    pickHint,
    onPickPoint,
    pickedPoint,
    pickedPointText,
    pickedPointValueText,
    pickedPointDetails,
    fmt,
    chartMetric,
    chartMetricOptions,
    chartXAxisMode,
    chartYAxisMode,
    chartXAxisOptions,
    chartYAxisOptions,
    onChartMetricChange,
    onChartXAxisModeChange,
    onChartYAxisModeChange,
    chartView,
    chartViewLarge,
    chartTitle,
    chartXAxisLabel,
    chartYAxisLabel,
    pickedPointSeries,
    chartDialogVisible,
    openChartDialog,
    exportCsv,
    exportCsvAll,
    exportSvg,
    exportPng,
    exportDialogSvg,
    exportDialogPng,
    evaluationRunning,
    evaluationResult,
    evaluationHint,
    runAutoEvaluation,
    exportEvaluation,
    feedback,
    exportFeedback,
    heatmapTuningExpanded,
    heatmapContrast,
    heatmapGamma,
    heatmapCutoff,
    heatmapForceVisible,
    applyHeatmapPanelTuning,
    applyHeatmapPreset,
    formatNumber
  }

  function fmt(val) {
    const unit = config.value?.field?.data?.unitStress || unitStress.value || ''
    return `${formatNumber(val)} ${unit}`
  }
}
