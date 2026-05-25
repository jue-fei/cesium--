import {
  clamp01,
  formatAxisNumber,
  formatNumber,
  formatScientific
} from '../../utils/stressPanelUtils.js'

export const HEATMAP_PANEL_DEFAULTS = {
  contrast: 2.2,
  gamma: 0.65,
  cutoff: 0.04,
  lowRangeOpacity: 0.12,
  forceVisible: 0.18,
  diffuseMix: 0.88,
  emissiveMix: 0.72,
  anchorToModel: true,
  blendMode: 'max',
  maskMode: 'none',
  enableContour: true,
  enableGlow: false,
  enableMarker: false
}

const HEATMAP_PANEL_PRESETS = {
  clear: {
    contrast: 2.5,
    gamma: 0.55,
    cutoff: 0.06,
    lowRangeOpacity: 0.05,
    forceVisible: 0.25
  },
  continuous: {
    contrast: 1.4,
    gamma: 0.92,
    cutoff: 0.02,
    lowRangeOpacity: 0.22,
    forceVisible: 0.12
  },
  balanced: {
    contrast: 1.85,
    gamma: 0.72,
    cutoff: 0.03,
    lowRangeOpacity: 0.15,
    forceVisible: 0.18
  }
}

export function resolveHeatmapPanelState(next = {}) {
  return {
    contrast: Number(next.contrast) || HEATMAP_PANEL_DEFAULTS.contrast,
    gamma: Number(next.gamma) || HEATMAP_PANEL_DEFAULTS.gamma,
    cutoff: Number(next.cutoff) || HEATMAP_PANEL_DEFAULTS.cutoff,
    lowRangeOpacity: Number.isFinite(Number(next.lowRangeOpacity))
      ? Math.max(0, Math.min(0.6, Number(next.lowRangeOpacity)))
      : HEATMAP_PANEL_DEFAULTS.lowRangeOpacity,
    forceVisible: Number(next.forceVisible) || HEATMAP_PANEL_DEFAULTS.forceVisible,
    diffuseMix: Number(next.diffuseMix) || HEATMAP_PANEL_DEFAULTS.diffuseMix,
    emissiveMix: Number(next.emissiveMix) || HEATMAP_PANEL_DEFAULTS.emissiveMix,
    anchorToModel:
      next.anchorToModel !== undefined
        ? Boolean(next.anchorToModel)
        : HEATMAP_PANEL_DEFAULTS.anchorToModel,
    blendMode:
      next.blendMode === 'add' || next.blendMode === 'overlay'
        ? next.blendMode
        : HEATMAP_PANEL_DEFAULTS.blendMode,
    maskMode: next.maskMode === 'points' ? 'points' : HEATMAP_PANEL_DEFAULTS.maskMode,
    enableContour: Boolean(next.enableContour),
    enableGlow: Boolean(next.enableGlow),
    enableMarker: Boolean(next.enableMarker)
  }
}

export function resolveHeatmapPresetState(mode) {
  if (mode === 'clear') return HEATMAP_PANEL_PRESETS.clear
  if (mode === 'continuous') return HEATMAP_PANEL_PRESETS.continuous
  return HEATMAP_PANEL_PRESETS.balanced
}

export function buildHeatmapDisplayPayload(state) {
  return {
    contrast: state.contrast,
    gamma: state.gamma,
    cutoff: state.cutoff,
    lowRangeOpacity: state.lowRangeOpacity,
    forceVisible: state.forceVisible,
    diffuseMix: state.diffuseMix,
    emissiveMix: state.emissiveMix,
    anchorToModel: state.anchorToModel,
    blendMode: state.blendMode,
    maskMode: state.maskMode,
    enableContour: state.enableContour,
    enableGlow: state.enableGlow,
    enableMarker: state.enableMarker
  }
}

export function resolveStressUnit(configUnit, unitStress, _unused) {
  return configUnit || unitStress || ''
}

export function formatGradientScaleRangeText(range, unit) {
  if (!range) return '相对应力'
  return `${formatAxisNumber(range.min)} ~ ${formatAxisNumber(range.max)} ${unit}`.trim()
}

export function formatStressValueRangeText(range, unit) {
  if (!range) return '--'
  return `${formatNumber(range.min)} ~ ${formatNumber(range.max)} ${unit}`.trim()
}

export function resolveGradientRangeState(range, cutoffValue) {
  const safeRange = range || { min: 0, max: 1 }
  const cutoff = clamp01(Number(cutoffValue))
  const min = Number(safeRange.min)
  const max = Number(safeRange.max)
  return {
    cutoff,
    min,
    max,
    span: Math.max(1e-6, max - min)
  }
}

export function formatGradientCutoffText(rangeState) {
  const value = rangeState.min + (rangeState.max - rangeState.min) * rangeState.cutoff
  return formatScientific(value)
}

export function buildGradientLegendCss(colorRamp, cutoffValue) {
  const ramp = Array.isArray(colorRamp) ? colorRamp : []
  const cutoff = clamp01(Number(cutoffValue))
  if (!ramp.length) {
    return { height: '260px', background: 'linear-gradient(to top, #0000ff 0%, #ff0000 100%)' }
  }
  const list = ramp
    .map((row, idx) => ({
      t: clamp01(Number(row?.value ?? idx / Math.max(1, ramp.length - 1))),
      color: String(row?.color || '#ffffff')
    }))
    .sort((a, b) => a.t - b.t)
  const firstColor = list[0].color
  const toRaw = t => cutoff + (1 - cutoff) * clamp01(t)
  const stops = [
    `${firstColor} 0%`,
    ...list.map(stop => `${stop.color} ${formatNumber(toRaw(stop.t) * 100, 2)}%`)
  ].join(', ')
  return { height: '260px', background: `linear-gradient(to top, ${stops})` }
}

export function buildGradientValueTickRows(rangeState, tickCount = 12) {
  const rows = []
  for (let i = tickCount; i >= 0; i--) {
    const colorT = i / tickCount
    const rawT = rangeState.cutoff + (1 - rangeState.cutoff) * colorT
    const value = rangeState.min + rangeState.span * rawT
    rows.push({
      text: formatScientific(value),
      major: i % 3 === 0 || i === tickCount || i === 0
    })
  }
  return rows
}
