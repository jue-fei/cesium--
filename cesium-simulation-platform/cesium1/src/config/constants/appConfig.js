import * as Cesium from 'cesium'
import { apiConfig } from '@/services/api/initApiConfig.js'

// ============================================================
// 运行时兜底值 — 仅在数据库/API 不可用时使用
// 数据库中的 app_settings 表为优先数据源
// ============================================================

export const ORE_GRADE_THRESHOLDS = { HIGH: 3.0, MEDIUM: 2.0 }
export const MODEL_DEFAULTS = { OPACITY: 100, VISIBLE: true }
export const HIGHLIGHT_CONFIG = {
  COLOR: Cesium.Color.fromCssColorString('#ffff00'),
  DURATION: 1000
}
export const SECTION_CONFIG = {
  COLOR: Cesium.Color.fromCssColorString('#0000ff'),
  ALPHA: 0.7,
  DEPTH_FAIL_ALPHA: 0.3,
  WIDTH: 2
}
export const DEFAULT_ORE_DENSITY = 2.5
export const ID_PREFIX = 'feature_'

const DEFAULT_BOREHOLE_VISUAL = {
  COLOR: Cesium.Color.fromCssColorString('#ff0000'),
  ALPHA: 0.8,
  DEPTH_FAIL_ALPHA: 0.3,
  WIDTH: 3,
  MARKER_IMAGE: '/icons/borehole-marker.png',
  MARKER_SIZE: 24
}

// 以下函数优先从数据库 API 读取，API 不可用时使用上方兜底值

export function getBoreholeVisualConfig() {
  const api = apiConfig.boreholes?.map?.borehole_visual
  if (api) {
    return {
      ...DEFAULT_BOREHOLE_VISUAL,
      ...api,
      COLOR: Cesium.Color.fromCssColorString(api.color || '#ff0000'),
      MARKER_IMAGE: api.markerIcon || '/icons/borehole-marker.png'
    }
  }
  return DEFAULT_BOREHOLE_VISUAL
}

export function getBoreholeLayerConfig() {
  const api = apiConfig.boreholes?.map?.borehole_layer
  if (api) return api
  return { defaultOreDensity: DEFAULT_ORE_DENSITY, oreGradeThresholds: ORE_GRADE_THRESHOLDS }
}

export function getDefaultOreDensity() {
  return apiConfig.boreholes?.map?.borehole_layer?.defaultOreDensity ?? DEFAULT_ORE_DENSITY
}
