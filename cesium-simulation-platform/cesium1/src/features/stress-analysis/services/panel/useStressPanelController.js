import { onMounted, onUnmounted } from 'vue'
import { useStressPanel } from './useStressPanel.js'

// —— 等值线滑杆调参常量（模板滑杆 min/max 与脚本钳位共用同一口径，数值不变） ——
/** 等值线密度：最小层数 */
export const CONTOUR_LEVELS_MIN = 2
/** 等值线密度：最大层数 */
export const CONTOUR_LEVELS_MAX = 40
/** 等值线密度：非法输入兜底默认层数 */
export const CONTOUR_LEVELS_DEFAULT = 24
/** 等值线宽度：最小值 */
export const CONTOUR_WIDTH_MIN = 0.003
/** 等值线宽度：最大值 */
export const CONTOUR_WIDTH_MAX = 0.12
/** 等值线宽度：非法输入兜底默认值 */
export const CONTOUR_WIDTH_DEFAULT = 0.015

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

  // —— 热力图等值线参数调整：钳位后应用（与模板滑杆 min/max 共用同一组常量） ——
  const onContourLevelsChange = v => {
    heatmapUi.heatmapContourLevels.value = Math.max(
      CONTOUR_LEVELS_MIN,
      Math.min(CONTOUR_LEVELS_MAX, Number(v) || CONTOUR_LEVELS_DEFAULT)
    )
    heatmapUi.applyHeatmapPanelTuning()
  }

  const onContourWidthChange = v => {
    heatmapUi.heatmapContourWidth.value = Math.max(
      CONTOUR_WIDTH_MIN,
      Math.min(CONTOUR_WIDTH_MAX, Number(v) || CONTOUR_WIDTH_DEFAULT)
    )
    heatmapUi.applyHeatmapPanelTuning()
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
    onContourLevelsChange,
    onContourWidthChange,
    fmt: panel.fmt,
    formatNumber
  }
}
