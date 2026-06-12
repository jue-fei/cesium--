import { computed, ref, watch } from 'vue'
import {
  buildContourValueRows,
  buildGradientLegendCss,
  buildGradientValueTickRows,
  buildHeatmapDisplayPayload,
  formatGradientCutoffText,
  formatGradientScaleRangeText,
  HEATMAP_PANEL_DEFAULTS,
  resolveGradientRangeState,
  resolveHeatmapPanelState,
  resolveHeatmapPresetState,
  resolveStressUnit
} from './stressHeatmapPanelState.js'

export function useStressPanelHeatmap({
  config,
  metricUnit,
  heatmapDisplay,
  getCurrentValueRange,
  setHeatmapDisplay
}) {
  const heatmapContrast = ref(HEATMAP_PANEL_DEFAULTS.contrast)
  const heatmapGamma = ref(HEATMAP_PANEL_DEFAULTS.gamma)
  const heatmapCutoff = ref(HEATMAP_PANEL_DEFAULTS.cutoff)
  const heatmapLowRangeOpacity = ref(HEATMAP_PANEL_DEFAULTS.lowRangeOpacity)
  const heatmapForceVisible = ref(HEATMAP_PANEL_DEFAULTS.forceVisible)
  const heatmapDiffuseMix = ref(HEATMAP_PANEL_DEFAULTS.diffuseMix)
  const heatmapEmissiveMix = ref(HEATMAP_PANEL_DEFAULTS.emissiveMix)
  const heatmapAnchorToModel = ref(HEATMAP_PANEL_DEFAULTS.anchorToModel)
  const heatmapBlendMode = ref(HEATMAP_PANEL_DEFAULTS.blendMode)
  const heatmapMaskMode = ref(HEATMAP_PANEL_DEFAULTS.maskMode)
  const heatmapEnableContour = ref(false)
  const heatmapContourLevels = ref(HEATMAP_PANEL_DEFAULTS.contourLevels)
  const heatmapContourWidth = ref(HEATMAP_PANEL_DEFAULTS.contourWidth)
  const heatmapEnableGlow = ref(false)
  const heatmapEnableMarker = ref(false)
  const heatmapColormapPreset = ref(HEATMAP_PANEL_DEFAULTS.colormapPreset)
  const heatmapTuningExpanded = ref(false)

  const gradientScaleRangeText = computed(() => {
    const range = getCurrentValueRange()
    const unit = resolveStressUnit(config.value?.field?.data?.unitStress, metricUnit.value)
    return formatGradientScaleRangeText(range, unit)
  })

  const gradientUnitLabel = computed(() => {
    const unit = resolveStressUnit(config.value?.field?.data?.unitStress, metricUnit.value)
    return unit || '相对值'
  })

  const gradientCutoffText = computed(() => {
    return formatGradientCutoffText(resolveCurrentGradientRangeState())
  })

  const gradientLegendCss = computed(() => {
    return buildGradientLegendCss(config.value?.colorRamp, heatmapCutoff.value)
  })

  const gradientValueTickRows = computed(() => {
    return buildGradientValueTickRows(resolveCurrentGradientRangeState())
  })

  const contourValueRows = computed(() => {
    if (!heatmapEnableContour.value) return []
    return buildContourValueRows(resolveCurrentGradientRangeState(), heatmapContourLevels.value)
  })

  const applyHeatmapPanelTuning = () => {
    setHeatmapDisplay(
      buildHeatmapDisplayPayload({
        contrast: heatmapContrast.value,
        gamma: heatmapGamma.value,
        cutoff: heatmapCutoff.value,
        lowRangeOpacity: heatmapLowRangeOpacity.value,
        forceVisible: heatmapForceVisible.value,
        diffuseMix: heatmapDiffuseMix.value,
        emissiveMix: heatmapEmissiveMix.value,
        anchorToModel: heatmapAnchorToModel.value,
        blendMode: heatmapBlendMode.value,
        maskMode: heatmapMaskMode.value,
        enableContour: heatmapEnableContour.value,
        contourLevels: heatmapContourLevels.value,
        contourWidth: heatmapContourWidth.value,
        enableGlow: heatmapEnableGlow.value,
        enableMarker: heatmapEnableMarker.value,
        colormapPreset: heatmapColormapPreset.value
      })
    )
  }

  const applyHeatmapPreset = mode => {
    assignHeatmapPanelState(resolveHeatmapPresetState(mode))
    applyHeatmapPanelTuning()
  }

  watch(
    heatmapDisplay,
    next => {
      if (!next) return
      assignHeatmapPanelState(resolveHeatmapPanelState(next))
    },
    { immediate: true, deep: true }
  )

  return {
    heatmapTuningExpanded,
    heatmapContrast,
    heatmapGamma,
    heatmapCutoff,
    heatmapLowRangeOpacity,
    heatmapForceVisible,
    heatmapDiffuseMix,
    heatmapEmissiveMix,
    heatmapAnchorToModel,
    heatmapBlendMode,
    heatmapMaskMode,
    heatmapEnableContour,
    heatmapContourLevels,
    heatmapContourWidth,
    heatmapEnableGlow,
    heatmapEnableMarker,
    heatmapColormapPreset,
    contourValueRows,
    applyHeatmapPanelTuning,
    applyHeatmapPreset,
    gradientScaleRangeText,
    gradientCutoffText,
    gradientLegendCss,
    gradientValueTickRows,
    gradientUnitLabel
  }

  function resolveCurrentGradientRangeState() {
    return resolveGradientRangeState(getCurrentValueRange(), heatmapCutoff.value)
  }

  function assignHeatmapPanelState(nextState) {
    heatmapContrast.value = nextState.contrast
    heatmapGamma.value = nextState.gamma
    heatmapCutoff.value = nextState.cutoff
    heatmapLowRangeOpacity.value = nextState.lowRangeOpacity
    heatmapForceVisible.value = nextState.forceVisible
    heatmapDiffuseMix.value = nextState.diffuseMix
    heatmapEmissiveMix.value = nextState.emissiveMix
    heatmapAnchorToModel.value = nextState.anchorToModel
    heatmapBlendMode.value = nextState.blendMode
    heatmapMaskMode.value = nextState.maskMode
    heatmapEnableContour.value = nextState.enableContour
    heatmapContourLevels.value = nextState.contourLevels
    heatmapContourWidth.value = nextState.contourWidth
    heatmapEnableGlow.value = nextState.enableGlow
    heatmapEnableMarker.value = nextState.enableMarker
    if (nextState.colormapPreset) {
      heatmapColormapPreset.value = nextState.colormapPreset
    }
  }
}
