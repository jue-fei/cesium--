/**
 * 应力分析科学色带 —— 热感渐变，工程可视化专用
 *
 * 设计原则：
 * - 低应力区 (0.00~0.32)：深蓝→湖蓝，冷色平滑抬升，背景更干净
 * - 中应力区 (0.32~0.58)：蓝青→青绿→绿色，连续过渡，避免跳色
 * - 高应力区 (0.58~0.78)：绿→黄绿→明黄，风险逐步升温
 * - 危险区   (0.78~1.00)：黄→橙→红，保持经典预警语义且层次连贯
 */

/** 32 级应力专用色带 */
export const STRESS_TURBO_RAMP_32 = Object.freeze([
  { value: 0.00000, color: '#123b7a', label: '零应力基底' },
  { value: 0.03226, color: '#154a8a', label: '' },
  { value: 0.06452, color: '#195a99', label: '极低应力' },
  { value: 0.09677, color: '#1d69a8', label: '' },
  { value: 0.12903, color: '#2178b7', label: '低应力' },
  { value: 0.16129, color: '#2587c4', label: '' },
  { value: 0.19355, color: '#2a96cf', label: '中低应力' },
  { value: 0.22581, color: '#30a4d6', label: '' },
  { value: 0.25806, color: '#37b0d8', label: '中等偏下' },
  { value: 0.29032, color: '#40bbd5', label: '' },
  { value: 0.32258, color: '#4ac4cf', label: '中等应力' },
  { value: 0.35484, color: '#55cbc7', label: '' },
  { value: 0.38710, color: '#5fceb8', label: '中等偏上' },
  { value: 0.41935, color: '#68d0a8', label: '' },
  { value: 0.45161, color: '#71d197', label: '轻微集中' },
  { value: 0.48387, color: '#7bd084', label: '' },
  { value: 0.51613, color: '#88cd6f', label: '应力集中' },
  { value: 0.54839, color: '#99c95b', label: '' },
  { value: 0.58065, color: '#afc54d', label: '弱岩爆倾向' },
  { value: 0.61290, color: '#c5c044', label: '' },
  { value: 0.64516, color: '#dbba41', label: '黄色预警' },
  { value: 0.67742, color: '#ecb13c', label: '' },
  { value: 0.70968, color: '#f4a33a', label: '橙色报警' },
  { value: 0.74194, color: '#f99236', label: '' },
  { value: 0.77419, color: '#fb7d31', label: '红色危险' },
  { value: 0.80645, color: '#fb682c', label: '' },
  { value: 0.83871, color: '#f55228', label: '严重危险' },
  { value: 0.87097, color: '#eb4023', label: '' },
  { value: 0.90323, color: '#dd3120', label: '极限破坏' },
  { value: 0.93548, color: '#cc251d', label: '' },
  { value: 0.96774, color: '#b61d1b', label: '结构失效' },
  { value: 1.00000, color: '#98181a', label: '已损毁区' }
])

/** 16 级应力专用色带 —— 日常使用 */
export const STRESS_TURBO_RAMP_16 = Object.freeze([
  { value: 0.0000, color: '#123b7a', label: '零应力基底' },
  { value: 0.0667, color: '#195a99', label: '极低应力' },
  { value: 0.1333, color: '#2178b7', label: '低应力' },
  { value: 0.2000, color: '#2a96cf', label: '中低应力' },
  { value: 0.2667, color: '#37b0d8', label: '中等偏下' },
  { value: 0.3333, color: '#4ac4cf', label: '中等应力' },
  { value: 0.4000, color: '#5fceb8', label: '中等偏上' },
  { value: 0.4667, color: '#71d197', label: '轻微集中' },
  { value: 0.5333, color: '#88cd6f', label: '应力集中' },
  { value: 0.6000, color: '#afc54d', label: '弱岩爆倾向' },
  { value: 0.6667, color: '#dbba41', label: '黄色预警' },
  { value: 0.7333, color: '#f4a33a', label: '橙色报警' },
  { value: 0.8000, color: '#fb7d31', label: '红色危险' },
  { value: 0.8667, color: '#f55228', label: '严重危险' },
  { value: 0.9333, color: '#dd3120', label: '极限破坏' },
  { value: 1.0000, color: '#98181a', label: '已损毁区' }
])

/** Viridis 风格感知均匀色带 —— 色盲友好 */
export const STRESS_VIRIDIS_RAMP = Object.freeze([
  { value: 0.0000, color: '#440154', label: '零应力' },
  { value: 0.0667, color: '#482475', label: '' },
  { value: 0.1333, color: '#414287', label: '极低应力' },
  { value: 0.2000, color: '#355e8d', label: '' },
  { value: 0.2667, color: '#2b788e', label: '低应力' },
  { value: 0.3333, color: '#21918c', label: '' },
  { value: 0.4000, color: '#22a884', label: '中等应力' },
  { value: 0.4667, color: '#3fbd73', label: '' },
  { value: 0.5333, color: '#6ecf58', label: '应力集中' },
  { value: 0.6000, color: '#a3db36', label: '' },
  { value: 0.6667, color: '#d7e12e', label: '预警' },
  { value: 0.7333, color: '#f7c740', label: '' },
  { value: 0.8000, color: '#f89b2b', label: '报警' },
  { value: 0.8667, color: '#f26e1f', label: '' },
  { value: 0.9333, color: '#da3b1a', label: '危险' },
  { value: 1.0000, color: '#7a0403', label: '结构失效' }
])

/** Inferno 风格色带 —— 突出高值热感 */
export const STRESS_INFERNO_RAMP = Object.freeze([
  { value: 0.0000, color: '#000004', label: '零应力' },
  { value: 0.0667, color: '#1b0c41', label: '' },
  { value: 0.1333, color: '#3f1068', label: '极低应力' },
  { value: 0.2000, color: '#651682', label: '' },
  { value: 0.2667, color: '#8b1f81', label: '低应力' },
  { value: 0.3333, color: '#b12d6d', label: '' },
  { value: 0.4000, color: '#d24152', label: '中等应力' },
  { value: 0.4667, color: '#e85e32', label: '' },
  { value: 0.5333, color: '#f5892a', label: '应力集中' },
  { value: 0.6000, color: '#f9b12f', label: '' },
  { value: 0.6667, color: '#f7d847', label: '预警' },
  { value: 0.7333, color: '#f4e96f', label: '' },
  { value: 0.8000, color: '#fcf8a4', label: '报警' },
  { value: 0.8667, color: '#feeba1', label: '' },
  { value: 0.9333, color: '#fecf74', label: '危险' },
  { value: 1.0000, color: '#fcffa4', label: '结构失效' }
])

/** 发散色带 —— 以安全阈值为中性中心 */
export const STRESS_DIVERGING_RAMP = Object.freeze([
  { value: 0.0000, color: '#2166ac', label: '远低于阈值' },
  { value: 0.1000, color: '#67a9cf', label: '' },
  { value: 0.2000, color: '#d1e5f0', label: '低于阈值' },
  { value: 0.3000, color: '#f7f7f7', label: '' },
  { value: 0.4000, color: '#fddbc7', label: '近阈值' },
  { value: 0.5000, color: '#f4a582', label: '安全阈值' },
  { value: 0.6000, color: '#ef8a62', label: '' },
  { value: 0.6667, color: '#e85b26', label: '超阈值' },
  { value: 0.7333, color: '#d7191c', label: '' },
  { value: 0.8000, color: '#c4141f', label: '报警' },
  { value: 0.8667, color: '#a50026', label: '' },
  { value: 0.9333, color: '#8a0724', label: '危险' },
  { value: 1.0000, color: '#4d0024', label: '结构失效' }
])

/** 所有可用色带预设 */
export const STRESS_COLORMAP_PRESETS = {
  turbo32: { name: '热感 32级（柔和推荐）', ramp: STRESS_TURBO_RAMP_32, levels: 32 },
  turbo16: { name: '热感 16级（柔和）', ramp: STRESS_TURBO_RAMP_16, levels: 16 },
  viridis: { name: 'Viridis（色盲友好）', ramp: STRESS_VIRIDIS_RAMP, levels: 16 },
  inferno: { name: 'Inferno（高值热感）', ramp: STRESS_INFERNO_RAMP, levels: 16 },
  diverging: { name: '发散色带（阈值中心）', ramp: STRESS_DIVERGING_RAMP, levels: 13 }
}
