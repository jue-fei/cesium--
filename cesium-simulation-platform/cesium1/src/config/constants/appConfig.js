import * as Cesium from 'cesium'
import appConstants from '../appConstants.json'

const parseColor = hex => {
  if (Cesium.Color && typeof Cesium.Color.fromCssColorString === 'function') {
    return Cesium.Color.fromCssColorString(hex)
  }
  const normalized = String(hex || '')
    .trim()
    .replace(/^#/, '')
  const m = normalized.match(/^[0-9a-fA-F]{6}$/)
  if (!m) return new Cesium.Color(1, 1, 1, 1)
  const r = parseInt(normalized.slice(0, 2), 16) / 255
  const g = parseInt(normalized.slice(2, 4), 16) / 255
  const b = parseInt(normalized.slice(4, 6), 16) / 255
  return new Cesium.Color(r, g, b, 1)
}

export const ORE_GRADE_THRESHOLDS = {
  HIGH: appConstants.oreGradeThresholds.high,
  MEDIUM: appConstants.oreGradeThresholds.medium
}

export const MODEL_DEFAULTS = {
  OPACITY: appConstants.modelDefaults.opacity,
  VISIBLE: appConstants.modelDefaults.visible
}

export const HIGHLIGHT_CONFIG = {
  COLOR: parseColor(appConstants.highlightConfig.colorHex),
  DURATION: appConstants.highlightConfig.durationMs
}

export const BOREHOLE_CONFIG = {
  COLOR: parseColor(appConstants.boreholeConfig.colorHex),
  ALPHA: appConstants.boreholeConfig.alpha,
  DEPTH_FAIL_ALPHA: appConstants.boreholeConfig.depthFailAlpha,
  WIDTH: appConstants.boreholeConfig.width,
  MARKER_IMAGE: appConstants.boreholeConfig.markerImage,
  MARKER_SIZE: appConstants.boreholeConfig.markerSize
}

export const SECTION_CONFIG = {
  COLOR: parseColor(appConstants.sectionConfig.colorHex),
  ALPHA: appConstants.sectionConfig.alpha,
  DEPTH_FAIL_ALPHA: appConstants.sectionConfig.depthFailAlpha,
  WIDTH: appConstants.sectionConfig.width
}

export const DEFAULT_ORE_DENSITY = appConstants.defaultOreDensity
export const ID_PREFIX = appConstants.idPrefix
export const DEFAULT_COORDINATES = appConstants.defaultCoordinates
