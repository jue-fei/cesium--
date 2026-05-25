import * as Cesium from 'cesium'

export const ORE_GRADE_THRESHOLDS = { HIGH: 3.0, MEDIUM: 2.0 }
export const MODEL_DEFAULTS = { OPACITY: 100, VISIBLE: true }
export const HIGHLIGHT_CONFIG = {
  COLOR: Cesium.Color.fromCssColorString('#ffff00'),
  DURATION: 1000
}
export const BOREHOLE_CONFIG = {
  COLOR: Cesium.Color.fromCssColorString('#ff0000'),
  ALPHA: 0.8,
  DEPTH_FAIL_ALPHA: 0.3,
  WIDTH: 3,
  MARKER_IMAGE: '/icons/borehole-marker.png',
  MARKER_SIZE: 24
}
export const SECTION_CONFIG = {
  COLOR: Cesium.Color.fromCssColorString('#0000ff'),
  ALPHA: 0.7,
  DEPTH_FAIL_ALPHA: 0.3,
  WIDTH: 2
}
export const DEFAULT_ORE_DENSITY = 2.5
export const ID_PREFIX = 'feature_'
