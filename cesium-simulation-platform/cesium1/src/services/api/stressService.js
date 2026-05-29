import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 computation/index.js + heatmapPalette.js + warningEngine.js）----
const FALLBACK_METRICS = [
  { metric_key: 'von_mises', label: '等效应力（von Mises）', sort_order: 1 },
  { metric_key: 'principal_1', label: '最大主应力（σ1）', sort_order: 2 },
  { metric_key: 'principal_2', label: '中间主应力（σ2）', sort_order: 3 },
  { metric_key: 'principal_3', label: '最小主应力（σ3）', sort_order: 4 },
  { metric_key: 'max_abs_normal', label: '三向正应力合成（最大绝对值）', sort_order: 5 },
  { metric_key: 'mean_stress', label: '平均应力（p=tr(σ)/3）', sort_order: 6 },
  { metric_key: 'pressure', label: '静水压力（-p）', sort_order: 7 },
  { metric_key: 'j2', label: '第二偏应力不变量（J2）', sort_order: 8 },
  { metric_key: 'tau_max', label: '最大剪应力（τmax）', sort_order: 9 },
  { metric_key: 'tau_oct', label: '八面体剪应力（τoct）', sort_order: 10 },
  { metric_key: 'sxx', label: 'σxx', sort_order: 11 },
  { metric_key: 'syy', label: 'σyy', sort_order: 12 },
  { metric_key: 'szz', label: 'σzz', sort_order: 13 },
  { metric_key: 'sxy', label: 'σxy', sort_order: 14 },
  { metric_key: 'syz', label: 'σyz', sort_order: 15 },
  { metric_key: 'szx', label: 'σzx', sort_order: 16 },
  { metric_key: 'snn', label: '方向正应力（σnn）', sort_order: 17 },
  { metric_key: 'tau_n', label: '方向剪应力（τn）', sort_order: 18 },
  { metric_key: 'safety_score', label: '综合安全评分', sort_order: 19 }
]

const FALLBACK_HEATMAP_RAMP = [
  { value: 0.0000, color: '#0d1b2a', label: '零应力基底' },
  { value: 0.0667, color: '#112e57', label: '极低应力' },
  { value: 0.1333, color: '#144585', label: '低应力' },
  { value: 0.2000, color: '#165fad', label: '中低应力' },
  { value: 0.2667, color: '#1a7abe', label: '中等偏下' },
  { value: 0.3333, color: '#2095c0', label: '中等应力' },
  { value: 0.4000, color: '#2aaf9d', label: '中等偏上' },
  { value: 0.4667, color: '#64c25f', label: '轻微集中' },
  { value: 0.5333, color: '#a3ce37', label: '应力集中' },
  { value: 0.6000, color: '#d8d82d', label: '弱岩爆倾向' },
  { value: 0.6667, color: '#f5be30', label: '黄色预警' },
  { value: 0.7333, color: '#f5912b', label: '橙色报警' },
  { value: 0.8000, color: '#e85b26', label: '红色危险' },
  { value: 0.8667, color: '#b71c1c', label: '严重危险' },
  { value: 0.9333, color: '#7a0000', label: '极限破坏' },
  { value: 1.0000, color: '#140001', label: '已损毁区' }
]

const FALLBACK_WARNING_RULES = [
  { rule_id: 'safety_score_critical', metric: 'safety_score', level: 'red', title: '综合安全评分 — 极高风险' },
  { rule_id: 'safety_score_high', metric: 'safety_score', level: 'orange', title: '综合安全评分 — 高风险' },
  { rule_id: 'safety_score_warning', metric: 'safety_score', level: 'yellow', title: '综合安全评分 — 中风险' },
  { rule_id: 'hoek_brown_critical', metric: 'hb_utilization', level: 'red', title: 'Hoek-Brown 接近峰值强度' },
  { rule_id: 'hoek_brown_yield', metric: 'hb_utilization', level: 'orange', title: 'Hoek-Brown 进入屈服阶段' },
  { rule_id: 'mc_shear_failure', metric: 'mc_shear_util', level: 'red', title: 'Mohr-Coulomb 剪切破坏临近' },
  { rule_id: 'mc_tension_failure', metric: 'mc_tension_util', level: 'red', title: 'Mohr-Coulomb 拉伸破坏临近' },
  { rule_id: 'von_mises_critical', metric: 'von_mises_util', level: 'red', title: '等效应力达到破坏阶段' },
  { rule_id: 'von_mises_elevated', metric: 'von_mises_util', level: 'orange', title: '等效应力偏高' },
  { rule_id: 'rockburst_strong', metric: 'rockburst_ratio', level: 'red', title: '强岩爆风险' },
  { rule_id: 'rockburst_moderate', metric: 'rockburst_ratio', level: 'orange', title: '中等岩爆风险' },
  { rule_id: 'rockburst_weak', metric: 'rockburst_ratio', level: 'yellow', title: '弱岩爆风险' }
]

const FALLBACK_DEFAULTS = {
  stress_default_metric: { value: 'von_mises' },
  stress_default_unit: { value: 'MPa' }
}

export async function fetchStressMetrics() {
  return safeRequest(() => client.get('/stress/metrics'), FALLBACK_METRICS)
}

export async function fetchHeatmapRamp() {
  return safeRequest(() => client.get('/stress/heatmap-ramp'), FALLBACK_HEATMAP_RAMP)
}

export async function fetchWarningRules() {
  return safeRequest(() => client.get('/stress/warning-rules'), FALLBACK_WARNING_RULES)
}

export async function fetchStressDefaults() {
  return safeRequest(() => client.get('/stress/defaults'), FALLBACK_DEFAULTS)
}
