import {
  clamp01,
  formatAxisNumber,
  formatNumber,
  formatScientific
} from '../../utils/stressPanelUtils.js'
import { STRESS_COLORMAP_PRESETS } from '../core/render/stressColormap.js'

export const HEATMAP_PANEL_DEFAULTS = {
  contrast: 1.08,
  gamma: 0.72,
  cutoff: 0.03,
  lowRangeOpacity: 0.1,
  forceVisible: 0.16,
  diffuseMix: 0.84,
  emissiveMix: 0.78,
  anchorToModel: true,
  blendMode: 'max',
  maskMode: 'none',
  enableContour: true,
  contourLevels: 24,
  contourWidth: 0.015,
  enableGlow: false,
  enableMarker: false,
  colormapPreset: 'turbo32'
}

const HEATMAP_PANEL_PRESETS = {
  clear: {
    contrast: 1.18,
    gamma: 0.72,
    cutoff: 0.035,
    lowRangeOpacity: 0.07,
    forceVisible: 0.18,
    colormapPreset: 'turbo32',
    description: '清晰热力图：高对比度，层次分明，适合演示汇报'
  },
  continuous: {
    contrast: 0.9,
    gamma: 1.0,
    cutoff: 0.01,
    lowRangeOpacity: 0.28,
    forceVisible: 0.1,
    colormapPreset: 'viridis',
    description: '低值连续：感知均匀，色盲友好，适合学术分析'
  },
  balanced: {
    contrast: 1.08,
    gamma: 0.8,
    cutoff: 0.018,
    lowRangeOpacity: 0.12,
    forceVisible: 0.15,
    colormapPreset: 'turbo32',
    description: '平衡：日常分析推荐，通用场景适用'
  },
  alarm: {
    contrast: 1.3,
    gamma: 0.55,
    cutoff: 0.06,
    lowRangeOpacity: 0.05,
    forceVisible: 0.28,
    colormapPreset: 'inferno',
    description: '预警模式：突出高应力区域，弱化背景噪声'
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
    contourLevels: Number.isFinite(Number(next.contourLevels))
      ? Math.max(2, Math.min(40, Number(next.contourLevels)))
      : HEATMAP_PANEL_DEFAULTS.contourLevels,
    contourWidth: Number.isFinite(Number(next.contourWidth))
      ? Math.max(0.01, Math.min(0.2, Number(next.contourWidth)))
      : HEATMAP_PANEL_DEFAULTS.contourWidth,
    enableGlow: Boolean(next.enableGlow),
    enableMarker: Boolean(next.enableMarker),
    colormapPreset:
      next.colormapPreset && STRESS_COLORMAP_PRESETS[next.colormapPreset]
        ? next.colormapPreset
        : 'turbo32'
  }
}

export function resolveHeatmapPresetState(mode) {
  if (mode === 'clear') return HEATMAP_PANEL_PRESETS.clear
  if (mode === 'continuous') return HEATMAP_PANEL_PRESETS.continuous
  if (mode === 'alarm') return HEATMAP_PANEL_PRESETS.alarm
  return HEATMAP_PANEL_PRESETS.balanced
}

export function getHeatmapPresetList() {
  return Object.entries(HEATMAP_PANEL_PRESETS).map(([key, preset]) => ({
    key,
    description: preset.description || key
  }))
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
    contourLevels: state.contourLevels,
    contourWidth: state.contourWidth,
    enableGlow: state.enableGlow,
    enableMarker: state.enableMarker,
    colormapPreset: state.colormapPreset || 'turbo32'
  }
}

/** 获取所有可用的色图预设列表 */
export function getColormapPresetOptions() {
  return Object.entries(STRESS_COLORMAP_PRESETS).map(([key, preset]) => ({
    value: key,
    label: preset.name,
    levels: preset.levels
  }))
}

/** 根据预设 key 解析色带，失败时返回 turbo16 默认 */
export function resolveColormapRamp(presetKey) {
  const preset = STRESS_COLORMAP_PRESETS[presetKey]
  if (preset && Array.isArray(preset.ramp)) {
    return preset.ramp
  }
  return STRESS_COLORMAP_PRESETS.turbo16.ramp
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

export function buildContourValueRows(rangeState, contourLevels) {
  const levels = Math.max(2, Math.min(40, Number(contourLevels) || 24))
  const rows = []
  for (let i = 0; i <= levels; i++) {
    const colorT = i / levels
    const rawT = rangeState.cutoff + (1 - rangeState.cutoff) * colorT
    const value = rangeState.min + rangeState.span * rawT
    rows.push({
      text: formatScientific(value),
      index: i
    })
  }
  return rows
}
