import { computed, ref } from 'vue'
import {
  buildChartView,
  buildSvgContent,
  downloadText,
  exportChartPng
} from '../../utils/stressPanelUtils.js'

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

  const chartMetricLabel = computed(() => {
    const v = chartMetric.value
    return chartMetricOptions.value.find(o => o.value === v)?.label || v
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
    const unit = config.value?.field?.data?.unitStress || metricUnit.value || ''
    const rows = [`时间,${chartMetricLabel.value}(${unit})`]
    for (const p of series) {
      if (!Number.isFinite(p?.t) || !Number.isFinite(p?.v)) continue
      rows.push(`${p.t},${p.v}`)
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

  const exportSvg = () => {
    exportSvgByView(chartView.value, '选点_时间-应力.svg')
  }

  const exportPng = async () => {
    await exportPngByView(chartView.value, '选点_时间-应力.png')
  }

  const exportDialogSvg = () => {
    exportSvgByView(chartViewLarge.value, '选点_时间-应力_放大图.svg')
  }

  const exportDialogPng = async () => {
    await exportPngByView(chartViewLarge.value, '选点_时间-应力_放大图.png')
  }

  return {
    chartDialogVisible,
    chartMetric,
    chartMetricLabel,
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
    openChartDialog,
    exportCsv,
    exportCsvAll,
    exportSvg,
    exportPng,
    exportDialogSvg,
    exportDialogPng
  }
}
