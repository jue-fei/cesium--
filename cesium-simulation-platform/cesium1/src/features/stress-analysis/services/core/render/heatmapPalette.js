/**
 * 色带常量 —— 保留旧版兼容，新版首选来自 stressColormap.js
 */

/** @deprecated 保留旧版兼容，新代码请使用 STRESS_TURBO_RAMP_16 */
export const DEFAULT_COLOR_RAMP = Object.freeze([
  { value: 0.0, color: '#1F4E79', label: '极低应力' },
  { value: 0.1667, color: '#2F75B5', label: '低应力' },
  { value: 0.3333, color: '#00B0F0', label: '应力调整' },
  { value: 0.5, color: '#00B050', label: '轻微集中' },
  { value: 0.625, color: '#FFD966', label: '弱岩爆倾向' },
  { value: 0.7083, color: '#F4B183', label: '黄色预警' },
  { value: 0.7917, color: '#E31A1C', label: '橙色报警' },
  { value: 0.875, color: '#7F0000', label: '红色危险' },
  { value: 1.0, color: '#2b0101', label: '严重破坏' }
])

export {
  STRESS_TURBO_RAMP_16,
  STRESS_TURBO_RAMP_32,
  STRESS_VIRIDIS_RAMP,
  STRESS_INFERNO_RAMP,
  STRESS_DIVERGING_RAMP,
  STRESS_COLORMAP_PRESETS
} from './stressColormap.js'
