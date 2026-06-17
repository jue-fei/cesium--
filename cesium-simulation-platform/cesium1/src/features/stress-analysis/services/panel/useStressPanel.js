import { computed, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import { ElMessageBox } from 'element-plus'
import useStress, { STRESS_METRIC_LABELS, buildStressMetricOptions } from '../useStress.js'
import { formatNumber, fetchText } from '../../utils/stressPanelUtils.js'
import { formatStressValueRangeText, resolveStressUnit } from './stressHeatmapPanelState.js'
import { useStressPanelChart } from './useStressPanelChart.js'
import { useStressPanelHeatmap } from './useStressPanelHeatmap.js'
import { useStressPanelPointRender } from './useStressPanelPointRender.js'
import { isSafetyMetric, SAFETY_SCORE_STANDARD_LINES } from '../core/safety/index.js'
import { evaluateSourceData, buildWarningSummary } from '../core/safety/warningEngine.js'

const EXAMPLE_URL = '/stress/应力分析_示例数据_自动生成-模型中心.json'

function createStressPanelImportActions({ state, actions }) {
  const fileInput = ref(null)
  const importedHint = computed(() => {
    const frames =
      state.config.value?.time?.frames || state.config.value?.field?.data?.frames?.length || 0
    if (!frames) return '未导入文件时，使用默认示例配置'
    const unit = state.config.value?.field?.data?.unitStress || state.unitStress.value || ''
    const mode =
      state.sourceKind.value === 'grid'
        ? '区域场'
        : state.sourceKind.value === 'points'
          ? '点位场'
          : '应力场'
    const isPoint = state.sourceKind.value === 'points'
    return {
      text: `当前模式：${mode}；帧数：${frames}；单位：${unit || '-'}`,
      isPoint
    }
  })

  const showImportFailure = async () => {
    if (!state.importStatus.value || state.importStatus.value.ok !== false) return
    await ElMessageBox.alert(
      [state.importStatus.value.message, ...(state.importStatus.value.details || [])].join('\n'),
      state.importStatus.value.title || '提示',
      { confirmButtonText: '知道了' }
    )
  }

  const onFileChange = async event => {
    const file = event?.target?.files?.[0]
    if (!file) return
    await actions.parseAndSetStressFile(file)
    await showImportFailure()
    if (fileInput.value) fileInput.value.value = ''
  }

  const importExample = async () => {
    const text = await fetchText(EXAMPLE_URL)
    if (!text) return
    const file = new File([text], '应力分析_示例数据_复合载荷-模型中心.json', {
      type: 'application/json'
    })
    await actions.parseAndSetStressFile(file)
    await showImportFailure()
  }

  return {
    fileInput,
    importedHint: computed(() => {
      const summary = importedHint.value
      if (!summary.isPoint) return summary.text
      return `${summary.text}${state.pointSourceMode.value === 'full' ? '；源点：全点优先' : '；源点：性能优先(Top4)'}`
    }),
    onFileChange,
    importExample
  }
}

function createStressPanelPicking({ state, actions, chart }) {
  const canPick = computed(
    () =>
      Boolean(state.config.value?.field?.data?.frames?.length) ||
      Boolean(state.config.value?.sources?.length)
  )
  const canExitAnalysis = computed(() => canPick.value)
  const pickHint = computed(() =>
    canPick.value ? '左键选点；右键取消' : '请先导入应力/应变数据文件'
  )
  const pickedPointText = computed(() => {
    if (!state.pickedPoint.value) return ''
    const cartographic = Cesium.Cartographic.fromCartesian(state.pickedPoint.value)
    const lon = Cesium.Math.toDegrees(cartographic.longitude)
    const lat = Cesium.Math.toDegrees(cartographic.latitude)
    const height = cartographic.height || 0
    return `${formatNumber(lon, 6)}, ${formatNumber(lat, 6)}, ${formatNumber(height, 2)}m`
  })
  const pickedPointValueText = computed(() => {
    const value = state.pickedPointValue.value
    if (value === null || value === undefined) return '—'
    const unit = state.metricUnit.value || ''
    return `${formatNumber(value)} ${unit}`
  })

  const onPickPoint = async () => {
    await actions.pickPointOnModel()
    chart.chartMetric.value = state.metric.value
    if (!state.pickedPoint.value) return
    const series = actions.buildPointSeriesForMetric(
      state.pickedPoint.value,
      chart.chartMetric.value
    )
    if (series.length) state.pickedPointSeries.value = series
  }

  return {
    canPick,
    canExitAnalysis,
    pickHint,
    pickedPointText,
    pickedPointValueText,
    onPickPoint
  }
}

function createStressPanelEvaluation(state, actions) {
  const evaluationRunning = ref(false)
  const evaluationResult = ref(null)
  const feedback = ref({ usability: 4, clarity: 4, smoothness: 4, notes: '' })
  const evaluationHint = computed(() => {
    if (evaluationRunning.value) return '评估中：请保持页面在前台'
    if (!evaluationResult.value) return '将生成性能/兼容性摘要，并可导出 JSON 报告'
    return `已完成：平均FPS ${formatNumber(evaluationResult.value.performance.avgFps, 1)}；P95帧耗时 ${formatNumber(evaluationResult.value.performance.p95FrameMs, 1)}ms`
  })
  const valueRangeText = computed(() => {
    const range = actions.getCurrentValueRange()
    const unit = resolveStressUnit(
      state.config.value?.field?.data?.unitStress,
      state.metricUnit.value
    )
    return formatStressValueRangeText(range, unit).replace('--', '—')
  })
  const safetySummaryTitle = computed(() => {
    if (!state.safetySummary.value) return '未生成区域安全分析'
    const summary = state.safetySummary.value
    return `${summary.riskLevel}，综合评分 ${formatNumber(summary.overallScore, 2)} / 10`
  })
  const safetySummaryHint = computed(() => {
    if (!state.safetySummary.value) {
      return '当前采用“应力阈值主导 + 地质修正”的混合评分，可直接用于连续热力图着色。'
    }
    return state.safetySummary.value.note || ''
  })
  const safetySummaryEnabled = computed(() => isSafetyMetric(state.metric.value))
  const safetyScoreStandardLines = computed(() => [...SAFETY_SCORE_STANDARD_LINES])

  return {
    evaluationRunning,
    evaluationResult,
    feedback,
    evaluationHint,
    valueRangeText,
    safetySummaryTitle,
    safetySummaryHint,
    safetySummaryEnabled,
    safetyScoreStandardLines
  }
}

function createStressPanelWarnings(state) {
  const warnings = computed(() =>
    evaluateSourceData(
      state.stressSource.value.kind,
      state.stressSource.value.data,
      state.currentTime.value,
      state.safetyContext.value
    )
  )
  const warningSummary = computed(() => buildWarningSummary(warnings.value))
  return { warnings, warningSummary }
}

export function useStressPanel() {
  const stress = useStress()
  const state = stress.state
  const actions = stress.actions
  const sliderTime = ref(state.currentTime.value)

  const timeLabel = computed(() => {
    const map = { day: '日', week: '周', month: '月' }
    return map[state.timeDimension.value] || state.timeDimension.value
  })

  // ============ 点渲染 ============
  const pointRender = useStressPanelPointRender({
    stressSource: state.stressSource,
    sourceKind: state.sourceKind,
    config: state.config,
    renderProgress: state.renderProgress,
    pointRenderModeRef: state.pointRenderMode,
    pointSourceMode: state.pointSourceMode,
    setPointRenderMode: actions.setPointRenderMode,
    setPointSourceMode: actions.setPointSourceMode,
    setPointInterpolationGrid: actions.setPointInterpolationGrid,
    setInterpolationPower: actions.setInterpolationPower,
    confirmPointInterpolationFinalPass: actions.confirmPointInterpolationFinalPass,
    keepPointInterpolationPreview: actions.keepPointInterpolationPreview
  })
  const panelImport = createStressPanelImportActions({ state, actions })

  // ============ 热力图 ============
  const heatmapUi = useStressPanelHeatmap({
    config: state.config,
    metricUnit: state.metricUnit,
    heatmapDisplay: state.heatmapDisplay,
    getCurrentValueRange: actions.getCurrentValueRange,
    setHeatmapDisplay: actions.setHeatmapDisplay
  })

  // ============ 图表 ============
  const metricOptions = computed(() => buildStressMetricOptions(pointRender.isPointMode.value))
  const chartMetricOptions = metricOptions

  const chart = useStressPanelChart({
    chartMetricOptions: computed(() =>
      chartMetricOptions.value.map(o => ({
        value: o.value,
        label: STRESS_METRIC_LABELS[o.value] || o.label
      }))
    ),
    metricUnit: state.metricUnit,
    config: state.config,
    timeLabel,
    pickedPoint: state.pickedPoint,
    pickedPointSeries: state.pickedPointSeries,
    buildPointSeriesForMetric: actions.buildPointSeriesForMetric,
    buildPointAllMetricsSeries: actions.buildPointAllMetricsSeries
  })
  chart.chartMetric.value = state.metric.value
  const panelPicking = createStressPanelPicking({ state, actions, chart })
  const panelEvaluation = createStressPanelEvaluation(state, actions)
  const panelWarnings = createStressPanelWarnings(state)

  watch(state.currentTime, val => {
    sliderTime.value = val
  })

  return {
    stress,
    state,
    actions,
    sliderTime,
    timeLabel,
    metricOptions,
    chartMetricOptions,
    valueRangeText,
    pointRender,
    heatmapUi,
    chart,

    // Import
    fileInput: panelImport.fileInput,
    importedHint: panelImport.importedHint,
    onFileChange: panelImport.onFileChange,
    importExample: panelImport.importExample,

    // Picking
    canPick: panelPicking.canPick,
    canExitAnalysis: panelPicking.canExitAnalysis,
    pickHint: panelPicking.pickHint,
    pickedPointText: panelPicking.pickedPointText,
    pickedPointValueText: panelPicking.pickedPointValueText,
    onPickPoint: panelPicking.onPickPoint,

    // Evaluation
    evaluationRunning: panelEvaluation.evaluationRunning,
    evaluationResult: panelEvaluation.evaluationResult,
    feedback: panelEvaluation.feedback,
    evaluationHint: panelEvaluation.evaluationHint,
    safetySummaryTitle: panelEvaluation.safetySummaryTitle,
    safetySummaryHint: panelEvaluation.safetySummaryHint,
    safetySummaryEnabled: panelEvaluation.safetySummaryEnabled,
    safetyScoreStandardLines: panelEvaluation.safetyScoreStandardLines,
    warnings: panelWarnings.warnings,
    warningSummary: panelWarnings.warningSummary,

    fmt(val) {
      const unit = resolveStressUnit(
        state.config.value?.field?.data?.unitStress,
        state.metricUnit.value
      )
      return `${formatNumber(val)} ${unit}`
    },
    formatNumber
  }
}
