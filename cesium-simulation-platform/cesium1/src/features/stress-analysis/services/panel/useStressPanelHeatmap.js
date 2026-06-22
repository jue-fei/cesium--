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

function createHeatmapPanelRefs() {
  return {
    heatmapContrast: ref(HEATMAP_PANEL_DEFAULTS.contrast),
    heatmapGamma: ref(HEATMAP_PANEL_DEFAULTS.gamma),
    heatmapCutoff: ref(HEATMAP_PANEL_DEFAULTS.cutoff),
    heatmapLowRangeOpacity: ref(HEATMAP_PANEL_DEFAULTS.lowRangeOpacity),
    heatmapForceVisible: ref(HEATMAP_PANEL_DEFAULTS.forceVisible),
    heatmapDiffuseMix: ref(HEATMAP_PANEL_DEFAULTS.diffuseMix),
    heatmapEmissiveMix: ref(HEATMAP_PANEL_DEFAULTS.emissiveMix),
    heatmapAnchorToModel: ref(HEATMAP_PANEL_DEFAULTS.anchorToModel),
    heatmapBlendMode: ref(HEATMAP_PANEL_DEFAULTS.blendMode),
    heatmapMaskMode: ref(HEATMAP_PANEL_DEFAULTS.maskMode),
    heatmapEnableContour: ref(false),
    heatmapContourLevels: ref(HEATMAP_PANEL_DEFAULTS.contourLevels),
    heatmapContourWidth: ref(HEATMAP_PANEL_DEFAULTS.contourWidth),
    heatmapEnableGlow: ref(false),
    heatmapEnableMarker: ref(false),
    heatmapColormapPreset: ref(HEATMAP_PANEL_DEFAULTS.colormapPreset),
    heatmapTuningExpanded: ref(false)
  }
}

function assignHeatmapPanelState(refs, nextState) {
  refs.heatmapContrast.value = nextState.contrast
  refs.heatmapGamma.value = nextState.gamma
  refs.heatmapCutoff.value = nextState.cutoff
  refs.heatmapLowRangeOpacity.value = nextState.lowRangeOpacity
  refs.heatmapForceVisible.value = nextState.forceVisible
  refs.heatmapDiffuseMix.value = nextState.diffuseMix
  refs.heatmapEmissiveMix.value = nextState.emissiveMix
  refs.heatmapAnchorToModel.value = nextState.anchorToModel
  refs.heatmapBlendMode.value = nextState.blendMode
  refs.heatmapMaskMode.value = nextState.maskMode
  refs.heatmapEnableContour.value = nextState.enableContour
  refs.heatmapContourLevels.value = nextState.contourLevels
  refs.heatmapContourWidth.value = nextState.contourWidth
  refs.heatmapEnableGlow.value = nextState.enableGlow
  refs.heatmapEnableMarker.value = nextState.enableMarker
  if (nextState.colormapPreset) refs.heatmapColormapPreset.value = nextState.colormapPreset
}

function createHeatmapComputedState({ config, metricUnit, refs, getCurrentValueRange }) {
  const resolveCurrentGradientRangeState = () =>
    resolveGradientRangeState(getCurrentValueRange(), refs.heatmapCutoff.value)

  return {
    gradientScaleRangeText: computed(() => {
      const range = getCurrentValueRange()
      const unit = resolveStressUnit(config.value?.field?.data?.unitStress, metricUnit.value)
      return formatGradientScaleRangeText(range, unit)
    }),
    gradientUnitLabel: computed(() => {
      const unit = resolveStressUnit(config.value?.field?.data?.unitStress, metricUnit.value)
      return unit || '相对值'
    }),
    gradientCutoffText: computed(() =>
      formatGradientCutoffText(resolveCurrentGradientRangeState())
    ),
    gradientLegendCss: computed(() =>
      buildGradientLegendCss(config.value?.colorRamp, refs.heatmapCutoff.value)
    ),
    gradientValueTickRows: computed(() =>
      buildGradientValueTickRows(resolveCurrentGradientRangeState())
    ),
    contourValueRows: computed(() => {
      if (!refs.heatmapEnableContour.value) return []
      return buildContourValueRows(
        resolveCurrentGradientRangeState(),
        refs.heatmapContourLevels.value
      )
    })
  }
}

function createHeatmapPanelActions(refs, setHeatmapDisplay) {
  const applyHeatmapPanelTuning = () => {
    setHeatmapDisplay(
      buildHeatmapDisplayPayload({
        contrast: refs.heatmapContrast.value,
        gamma: refs.heatmapGamma.value,
        cutoff: refs.heatmapCutoff.value,
        lowRangeOpacity: refs.heatmapLowRangeOpacity.value,
        forceVisible: refs.heatmapForceVisible.value,
        diffuseMix: refs.heatmapDiffuseMix.value,
        emissiveMix: refs.heatmapEmissiveMix.value,
        anchorToModel: refs.heatmapAnchorToModel.value,
        blendMode: refs.heatmapBlendMode.value,
        maskMode: refs.heatmapMaskMode.value,
        enableContour: refs.heatmapEnableContour.value,
        contourLevels: refs.heatmapContourLevels.value,
        contourWidth: refs.heatmapContourWidth.value,
        enableGlow: refs.heatmapEnableGlow.value,
        enableMarker: refs.heatmapEnableMarker.value,
        colormapPreset: refs.heatmapColormapPreset.value
      })
    )
  }

  return {
    applyHeatmapPanelTuning,
    applyHeatmapPreset(mode) {
      assignHeatmapPanelState(refs, resolveHeatmapPresetState(mode))
      applyHeatmapPanelTuning()
    }
  }
}

export function useStressPanelHeatmap({
  config,
  metricUnit,
  heatmapDisplay,
  getCurrentValueRange,
  setHeatmapDisplay
}) {
  const refs = createHeatmapPanelRefs()
  const computedState = createHeatmapComputedState({
    config,
    metricUnit,
    refs,
    getCurrentValueRange
  })
  const actions = createHeatmapPanelActions(refs, setHeatmapDisplay)

  watch(
    heatmapDisplay,
    next => {
      if (!next) return
      assignHeatmapPanelState(refs, resolveHeatmapPanelState(next))
    },
    { immediate: true, deep: true }
  )

  return {
    ...refs,
    contourValueRows: computedState.contourValueRows,
    applyHeatmapPanelTuning: actions.applyHeatmapPanelTuning,
    applyHeatmapPreset: actions.applyHeatmapPreset,
    gradientScaleRangeText: computedState.gradientScaleRangeText,
    gradientCutoffText: computedState.gradientCutoffText,
    gradientLegendCss: computedState.gradientLegendCss,
    gradientValueTickRows: computedState.gradientValueTickRows,
    gradientUnitLabel: computedState.gradientUnitLabel
  }
}
