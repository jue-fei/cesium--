/**
 * gradeScale.js —— 品位分级着色与统计（纯函数，无 Cesium 依赖）
 *
 * 分级阈值 gradeLevels 真源在后端 config/ore_grade_synth.json（随
 * GET /api/geology/grade-blocks 下发，块段数据与图例共用同一份）；
 * 颜色复用 stress-analysis 的 STRESS_TURBO_RAMP_16 色带（全库色带单源），
 * 按品位在分级区间内的归一化位置取最近色标（离散着色，工程图风格）。
 */
import { STRESS_TURBO_RAMP_16 } from '../../stress-analysis/services/core/render/stressColormap.js'

/** 归一化：品位 → [0,1]（低于首阈值 0，高于末阈值 1）。levels 必须升序。 */
export function gradeT(gradePct, levels) {
  if (!Array.isArray(levels) || levels.length < 2) return 0
  const min = levels[0]
  const max = levels[levels.length - 1]
  const span = max - min
  if (!(span > 0)) return 0
  return Math.min(1, Math.max(0, (gradePct - min) / span))
}

/** 在色带（[{value, color}]，value∈[0,1]）上取最近色标。 */
export function sampleRamp(t, ramp = STRESS_TURBO_RAMP_16) {
  if (!ramp?.length) return '#38bdf8'
  let best = ramp[0]
  let bestDiff = Math.abs(best.value - t)
  for (const stop of ramp) {
    const diff = Math.abs(stop.value - t)
    if (diff < bestDiff) {
      best = stop
      bestDiff = diff
    }
  }
  return best.color
}

/** 品位 → 十六进制颜色（供 3D 块段着色与图例共用）。 */
export function gradeColorHex(gradePct, levels, ramp) {
  return sampleRamp(gradeT(gradePct, levels), ramp)
}

/**
 * 图例分级（与着色同一套逻辑）：
 * 返回 len(levels)+1 个分级：[-∞,l0], [l0,l1] ..., [ln, +∞]，各带颜色。
 * @returns [{label, color}]
 */
export function gradeLegendItems(levels, ramp) {
  if (!Array.isArray(levels) || !levels.length) return []
  const items = []
  items.push({ label: `<${levels[0]}`, color: gradeColorHex(levels[0] - 0.01, levels, ramp) })
  for (let i = 0; i < levels.length - 1; i++) {
    const mid = (levels[i] + levels[i + 1]) / 2
    items.push({ label: `${levels[i]}~${levels[i + 1]}`, color: gradeColorHex(mid, levels, ramp) })
  }
  items.push({
    label: `≥${levels[levels.length - 1]}`,
    color: gradeColorHex(levels[levels.length - 1] + 0.01, levels, ramp)
  })
  return items
}

/**
 * 直方图分箱（与图例同一边界）：
 * @returns [{label, color, count}]，count 总和 == blocks 数
 */
export function histogramBins(blocks, levels, ramp) {
  const legend = gradeLegendItems(levels, ramp)
  const counts = new Array(legend.length).fill(0)
  for (const b of blocks || []) {
    const g = b.gradePct
    // 第一个分箱：g < levels[0]；中间：[levels[i], levels[i+1])；末箱：≥ levels[n-1]
    let idx = levels.findIndex(lv => g < lv)
    if (idx === -1) idx = levels.length
    counts[idx]++
  }
  return legend.map((it, i) => ({ ...it, count: counts[i] }))
}
