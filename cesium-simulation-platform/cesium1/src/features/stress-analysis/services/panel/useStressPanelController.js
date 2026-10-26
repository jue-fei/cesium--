import { onMounted, onUnmounted } from 'vue'
import { useStressPanel } from './useStressPanel.js'

export function useStressPanelController() {
  const panel = useStressPanel()
  const { state, actions } = panel
  const {
    sliderTime,
    timeLabel,
    metricOptions,
    chartMetricOptions,
    valueRangeText,
    pointRender,
    heatmapUi,
    chart,
    formatNumber,
    fileInput,
    importedHint,
    onFileChange,
    importExample,
    canPick,
    canExitAnalysis,
    pickHint,
    pickedPointText,
    pickedPointValueText,
    onPickPoint,
    evaluationRunning,
    evaluationResult,
    feedback,
    evaluationHint,
    safetySummaryTitle,
    safetySummaryHint,
    safetySummaryEnabled,
    safetyScoreStandardLines,
    warnings,
    warningSummary
  } = panel

  const onUndo = async () => {
    if (state.canUndo.value) await actions.undoHistory()
  }
  const onRedo = async () => {
    if (state.canRedo.value) await actions.redoHistory()
  }

  const onWindowKeydown = event => {
    if (!event || !(event.ctrlKey || event.metaKey)) return
    if (event.key?.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault()
      void onUndo()
    }
    if (event.key?.toLowerCase() === 'y' || (event.key?.toLowerCase() === 'z' && event.shiftKey)) {
      event.preventDefault()
      void onRedo()
    }
  }

  const onExitAnalysis = async () => {
    if (!canExitAnalysis) return
    if (!window.confirm('确认退出应力分析？')) return
    chart.chartDialogVisible.value = false
    evaluationResult.value = null
    await actions.exitStressAnalysis()
  }

  onMounted(() => {
    actions.initStressManager()
    window.addEventListener('keydown', onWindowKeydown)
  })
  onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))

  return {
    ...state,
    ...heatmapUi,
    ...chart,
    ...pointRender,
    timeLabel,
    sliderTime,
    metricOptions,
    chartMetricOptions,
    valueRangeText,
    fileInput,
    importedHint,
    canPick,
    canExitAnalysis,
    pickHint,
    pickedPointText,
    pickedPointValueText,
    evaluationRunning,
    evaluationResult,
    feedback,
    evaluationHint,
    safetySummaryTitle,
    safetySummaryHint,
    safetySummaryEnabled,
    safetyScoreStandardLines,
    warnings,
    warningSummary,
    setMetric: actions.setMetric,
    setDirection: actions.setDirection,
    togglePlayback: actions.togglePlayback,
    setKnownPointStressVisible: actions.setKnownPointStressVisible,
    setWhiteModel: actions.setWhiteModel,
    onFileChange,
    importExample,
    onPickPoint,
    onExitAnalysis,
    onSliderChange: v => {
      sliderTime.value = Number(v) || 0
      actions.setTime(sliderTime.value)
    },
    onUndo,
    onRedo,
    fmt: panel.fmt,
    formatNumber
  }
}
