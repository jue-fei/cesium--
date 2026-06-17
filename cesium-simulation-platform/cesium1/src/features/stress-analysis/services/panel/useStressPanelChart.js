import { computed, ref } from 'vue'
import {
  buildChartView,
  buildSvgContent,
  downloadText,
  exportChartPng
} from '../../utils/stressPanelUtils.js'

function createChartMetadata({
  chartMetric,
  chartMetricOptions,
  chartXAxisMode,
  chartYAxisMode,
  timeLabel,
  config,
  metricUnit
}) {
  const chartMetricLabel = computed(() => {
    const value = chartMetric.value
    return chartMetricOptions.value.find(option => option.value === value)?.label || value
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
    const unit = config.value?.field?.data?.unitStress || metricUnit.value || ''
    return unit ? `数值（${unit}）` : '数值'
  })

  const chartTitle = computed(
    () =>
      `曲线图（${chartMetricLabel.value}，X:${chartXAxisLabel.value}，Y:${chartYAxisLabel.value}）`
  )

  return {
    chartMetricLabel,
    chartXAxisOptions,
    chartXAxisLabel,
    chartYAxisLabel,
    chartTitle
  }
}

function createChartSeriesState({
  pickedPointSeries,
  chartWidth,
  chartHeight,
  chartLargeWidth,
  chartLargeHeight,
  chartXAxisMode,
  chartYAxisMode
}) {
  const chartSeries = computed(() => {
    const source = Array.isArray(pickedPointSeries.value) ? pickedPointSeries.value : []
    const output = []
    for (let index = 0; index < source.length; index += 1) {
      const point = source[index]
      const timeValue = Number(point?.t)
      const metricValue = Number(point?.v)
      if (!Number.isFinite(timeValue) || !Number.isFinite(metricValue)) continue
      output.push({ frame: index + 1, t: timeValue, v: metricValue })
    }
    return output
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

  return { chartSeries, chartView, chartViewLarge }
}

function createChartExportActions({
  pickedPoint,
  pickedPointSeries,
  buildPointAllMetricsSeries,
  chartMetricLabel,
  chartTitle,
  chartXAxisLabel,
  chartYAxisLabel,
  chartView,
  chartViewLarge,
  config,
  metricUnit
}) {
  const exportCsv = () => {
    const series = pickedPointSeries.value || []
    if (!series.length) return
    const unit = config.value?.field?.data?.unitStress || metricUnit.value || ''
    const rows = [`时间,${chartMetricLabel.value}(${unit})`]
    for (const point of series) {
      if (!Number.isFinite(point?.t) || !Number.isFinite(point?.v)) continue
      rows.push(`${point.t},${point.v}`)
    }
    downloadText(rows.join('\n'), '选点_时间-应力.csv', 'text/csv')
  }

  const exportCsvAll = () => {
    if (!pickedPoint.value) return
    const unit = config.value?.field?.data?.unitStress || metricUnit.value || ''
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
    for (const row of rows) {
      lines.push(
        [
          row.t,
          row.sxx,
          row.syy,
          row.szz,
          row.sxy,
          row.syz,
          row.szx,
          row.sigma1,
          row.sigma2,
          row.sigma3,
          row.mean,
          row.pressure,
          row.j2,
          row.von_mises,
          row.tau_max,
          row.tau_oct,
          row.snn,
          row.tau_n
        ].join(',')
      )
    }
    downloadText(lines.join('\n'), '选点_时间-应力_全部指标.csv', 'text/csv')
  }

  const exportSvgByView = (view, fileName) => {
    const svg = buildSvgContent(
      view,
      chartTitle.value,
      chartXAxisLabel.value,
      chartYAxisLabel.value
    )
    if (!svg) return
    downloadText(svg, fileName, 'image/svg+xml')
  }

  const exportPngByView = async (view, fileName) => {
    await exportChartPng(
      view,
      chartTitle.value,
      chartXAxisLabel.value,
      chartYAxisLabel.value,
      fileName
    )
  }

  return {
    exportCsv,
    exportCsvAll,
    exportSvg: () => exportSvgByView(chartView.value, '选点_时间-应力.svg'),
    exportPng: () => exportPngByView(chartView.value, '选点_时间-应力.png'),
    exportDialogSvg: () => exportSvgByView(chartViewLarge.value, '选点_时间-应力_放大图.svg'),
    exportDialogPng: () => exportPngByView(chartViewLarge.value, '选点_时间-应力_放大图.png')
  }
}

export function useStressPanelChart({
  chartMetricOptions,
  metricUnit,
  config,
  timeLabel,
  pickedPoint,
  pickedPointSeries,
  buildPointSeriesForMetric,
  buildPointAllMetricsSeries
}) {
  const chartDialogVisible = ref(false)
  const chartMetric = ref('von_mises')
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
  const chartMeta = createChartMetadata({
    chartMetric,
    chartMetricOptions,
    chartXAxisMode,
    chartYAxisMode,
    timeLabel,
    config,
    metricUnit
  })
  const chartState = createChartSeriesState({
    pickedPointSeries,
    chartWidth,
    chartHeight,
    chartLargeWidth,
    chartLargeHeight,
    chartXAxisMode,
    chartYAxisMode
  })

  const openChartDialog = () => {
    if (!chartState.chartSeries.value.length) return
    chartDialogVisible.value = true
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
  const chartExports = createChartExportActions({
    pickedPoint,
    pickedPointSeries,
    buildPointAllMetricsSeries,
    chartMetricLabel: chartMeta.chartMetricLabel,
    chartTitle: chartMeta.chartTitle,
    chartXAxisLabel: chartMeta.chartXAxisLabel,
    chartYAxisLabel: chartMeta.chartYAxisLabel,
    chartView: chartState.chartView,
    chartViewLarge: chartState.chartViewLarge,
    config,
    metricUnit
  })

  return {
    chartDialogVisible,
    chartMetric,
    chartMetricLabel: chartMeta.chartMetricLabel,
    chartXAxisMode,
    chartYAxisMode,
    chartXAxisOptions: chartMeta.chartXAxisOptions,
    chartYAxisOptions,
    onChartMetricChange,
    onChartXAxisModeChange,
    onChartYAxisModeChange,
    chartView: chartState.chartView,
    chartViewLarge: chartState.chartViewLarge,
    chartTitle: chartMeta.chartTitle,
    chartXAxisLabel: chartMeta.chartXAxisLabel,
    chartYAxisLabel: chartMeta.chartYAxisLabel,
    openChartDialog,
    exportCsv: chartExports.exportCsv,
    exportCsvAll: chartExports.exportCsvAll,
    exportSvg: chartExports.exportSvg,
    exportPng: chartExports.exportPng,
    exportDialogSvg: chartExports.exportDialogSvg,
    exportDialogPng: chartExports.exportDialogPng
  }
}
