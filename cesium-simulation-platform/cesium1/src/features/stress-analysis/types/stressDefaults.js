export const DEFAULT_STRESS_METRIC = 'von_mises'
export const DEFAULT_STRESS_UNIT = 'MPa'

export function createDefaultOverlayItems() {
  return [
    { metric: 'von_mises', weight: 1 },
    { metric: 'tau_max', weight: 0.35 }
  ]
}

export function createDefaultHeatmapDisplay() {
  return {
    contrast: 1.9,
    gamma: 0.72,
    cutoff: 0,
    forceVisible: 0.18,
    diffuseMix: 0.85,
    emissiveMix: 0.75,
    anchorToModel: true,
    blendMode: 'max',
    maskMode: 'none',
    enableContour: true,
    enableGlow: false,
    enableMarker: false
  }
}
