import * as Cesium from 'cesium'
import { apiConfig } from '@/services/api/initApiConfig.js'

// ============================================================
// 运行时兜底值 — 仅在数据库/API 不可用时使用
// 数据库中的 app_settings 表为优先数据源
// ============================================================

export const ORE_GRADE_THRESHOLDS = { HIGH: 3.0, MEDIUM: 2.0 }
export const MODEL_DEFAULTS = { OPACITY: 100, VISIBLE: true }
export const HIGHLIGHT_CONFIG = {
  // 选中高亮：琥珀黄 × 半透明（与模型预览页 preview.html 的点击效果一致）
  COLOR: Cesium.Color.fromCssColorString('#ffd54a'),
  ALPHA: 0.5,
  DURATION: 1000
}
// 点击选中高亮豁免：命中的模型被选中时只展示信息，不叠加半透明高亮响应
// 目前仅地表模型 dibiao0615（地表0615）豁免
export const SELECTION_HIGHLIGHT_EXEMPT_MODEL_IDS = ['dibiao0615']

export function isSelectionHighlightExempt(model) {
  if (!model) return false
  const keys = [model.id, model.featureId, model.feature_id, model.name]
    .map(value =>
      String(value ?? '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean)
  return keys.some(key =>
    SELECTION_HIGHLIGHT_EXEMPT_MODEL_IDS.some(exemptId => key === exemptId.toLowerCase())
  )
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

function resolveObjectConfig(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate
    }
  }
  return null
}

function getBoreholeConfigSection(sectionName) {
  // 当前后端返回的 boreholes 是钻孔数据数组，不是显示配置对象。
  // 这里只接受未来显式提供的对象型配置，避免误把数组当配置源。
  const settings = resolveObjectConfig(
    apiConfig.appSettings,
    apiConfig.visualSettings,
    apiConfig.geologySettings
  )
  const section = settings?.[sectionName]
  return resolveObjectConfig(section)
}

// 以下函数优先从显式配置对象读取；未提供时使用兜底值。

export function getBoreholeVisualConfig() {
  const api = getBoreholeConfigSection('borehole_visual')
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
  const api = getBoreholeConfigSection('borehole_layer')
  if (api) return api
  return { defaultOreDensity: DEFAULT_ORE_DENSITY, oreGradeThresholds: ORE_GRADE_THRESHOLDS }
}

export function getDefaultOreDensity() {
  return getBoreholeLayerConfig().defaultOreDensity ?? DEFAULT_ORE_DENSITY
}
