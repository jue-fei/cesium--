import * as Cesium from 'cesium'
import { apiConfig } from '@/services/api/initApiConfig.js'

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

// 从数据库 API 获取实时配置（合并 API 数据与默认值）
export function getApiOreGradeThresholds() {
  const api = apiConfig.app?.ore_grade_thresholds
  if (api) return { ...ORE_GRADE_THRESHOLDS, ...api }
  return ORE_GRADE_THRESHOLDS
}

export function getApiModelDefaults() {
  const api = apiConfig.app?.model_defaults
  if (api) return { ...MODEL_DEFAULTS, ...api }
  return MODEL_DEFAULTS
}

export function getApiBoreholeConfig() {
  const api = apiConfig.app?.borehole_config
  if (api) return {
    ...BOREHOLE_CONFIG,
    ...api,
    COLOR: Cesium.Color.fromCssColorString(api.COLOR || '#ff0000')
  }
  return BOREHOLE_CONFIG
}

export function getApiDefaultOreDensity() {
  return apiConfig.app?.default_ore_density?.value ?? DEFAULT_ORE_DENSITY
}

export function getApiIdPrefix() {
  return apiConfig.app?.id_prefix?.value ?? ID_PREFIX
}
