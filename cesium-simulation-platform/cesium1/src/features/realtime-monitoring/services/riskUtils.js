/**
 * 巷道安全评分 / 风险等级 / 渲染颜色 —— 统一口径。
 * TunnelMap3D（巷道渲染颜色）与 MultiObjectiveLhdView（详情标签）共用，
 * 保证「安全评分 ↔ 渲染颜色 ↔ 风险标签」三者一一对应、阈值完全一致。
 */

// 综合风险评分（0-100）：
//   封锁=100（最高）> 重载禁行+55 > 岩爆×28 > 拥堵×18 > 炮烟×12
//   + 物理约束：坡度超8%加分、净宽<4.5m加分、净高<3.8m加分、弯径<15m加分
//   若元数据带 _baseScore（无实测数据时的兜底分），直接采用该兜底分，保证渲染与详情同源
export function riskScore(m) {
  if (!m) return 0
  if (m.blocked) return 100
  if (m._baseScore != null) return Math.min(100, Math.round(m._baseScore))
  let s = 0
  if (m.passableLoaded === false) s += 55
  s += (m.rockburst || 0) * 28
  s += (m.congestion || 0) * 18
  s += (m.smoke || 0) * 12
  if (m.maxGradePct != null) s += Math.max(0, m.maxGradePct - 8) * 1.2
  if (m.clearWidthM != null && m.clearWidthM < 4.5) s += (4.5 - m.clearWidthM) * 6
  if (m.clearHeightM != null && m.clearHeightM < 3.8) s += (3.8 - m.clearHeightM) * 6
  if (m.minTurnRadiusM != null && m.minTurnRadiusM < 15) s += (15 - m.minTurnRadiusM) * 0.6
  return Math.min(100, Math.round(s))
}

// 无实测数据时的确定性基础风险分（0-100）：
// 由段 ID + 两端节点 + 开采水平推导，越深风险越高。
// 渲染颜色与详情评分共用，保证数据缺失时两边仍完全一致。
// @param {object} [opts] { activity: 开采水平活动度(0-1，缺省0.5), nLevels: 开采水平总数(缺省5) }
export function baseRiskScore(idA, idB, li, opts = {}) {
  const activity = opts.activity ?? 0.5
  const nLevels = opts.nLevels ?? 5
  const seed = (String(idA) + String(idB) + li).split('').reduce((s, c) => s + c.charCodeAt(0), 0)
  const r = ((seed * 31 + li * 17) % 100) / 100
  const depth = li / Math.max(1, nLevels - 1)
  return Math.min(100, Math.round((r * 0.55 + activity * 0.25 + depth * 0.35) * 100))
}

// 风险等级：颜色与标签共享同一阈值，保证评分 → 颜色/标签一一对应
export const RISK_LEVELS = [
  { min: 80, label: '极高危险', clazz: 'r-high', color: '#F43F5E' },
  { min: 55, label: '高风险', clazz: 'r-high', color: '#FB923C' },
  { min: 32, label: '中风险', clazz: 'r-mid', color: '#FBBF24' },
  { min: 20, label: '低风险', clazz: 'r-low', color: '#A3E635' },
  { min: 0, label: '安全', clazz: 'r-safe', color: '#4ADE80' }
]

export function riskLevel(score) {
  const s = score == null ? 0 : Number(score)
  for (const lv of RISK_LEVELS) if (s >= lv.min) return lv
  return RISK_LEVELS[RISK_LEVELS.length - 1]
}

// 评分 → 渲染颜色
export function riskColor(score) {
  return riskLevel(score).color
}
