/**
 * 振动场色阶共享模块（单源真相）
 *
 * 渲染器（blastVibrationFieldRenderer.js）与 UI 组件（VisualOptions.vue）
 * 统一从此模块 import，避免双份维护导致色阶与图例不一致。
 *
 * 数据格式说明：
 * - 渲染器使用线性 sRGB 0..1 的 [v, [r,g,b]] 格式
 * - UI 图例使用 CSS rgb() 字符串的 {v, c} 格式
 * - 本模块同时提供两种格式，由 _convertToCss 与 _convertToLinear 互转
 */

// ─── PPV 色阶（GB6722-2014，cm/s）───
// 0    背景极弱
// 0.5-1 住宅安全阈值
// 2-3  一般民用
// 4-5.5 商业工业/显著
// 7-9  软岩巷道阈值
// 12-15 损伤/严重损伤（红-品红）
export const PPV_COLOR_STOPS_LINEAR = [
  [0.0, [0.02, 0.05, 0.25]],
  [0.5, [0.0, 0.2, 0.6]],
  [1.0, [0.0, 0.45, 0.85]],
  [2.0, [0.0, 0.7, 0.7]],
  [3.0, [0.2, 0.85, 0.35]],
  [4.0, [0.75, 0.9, 0.1]],
  [5.5, [1.0, 0.85, 0.0]],
  [7.0, [1.0, 0.55, 0.0]],
  [9.0, [1.0, 0.25, 0.05]],
  [12.0, [0.95, 0.05, 0.25]],
  [15.0, [0.8, 0.0, 0.55]]
]
export const PPV_LUT_MAX_CMPS = 15.0

// ─── 应力色阶（σ_vm 等效应力，MPa）───
// 弹性反演范围 0.1~10 MPa（中远场），近场可达数十 MPa
export const STRESS_COLOR_STOPS_LINEAR = [
  [0.0, [0.02, 0.05, 0.25]],
  [0.3, [0.0, 0.2, 0.6]],
  [1.0, [0.0, 0.45, 0.85]],
  [3.0, [0.2, 0.85, 0.35]],
  [6.0, [0.95, 0.9, 0.1]],
  [10.0, [1.0, 0.55, 0.0]],
  [20.0, [1.0, 0.2, 0.05]],
  [30.0, [0.8, 0.0, 0.5]]
]
export const STRESS_LUT_MAX_MPA = 30.0

// ─── Persson 损伤分区（5 色离散）───
// 阈值：5/15/30/50 cm/s（PPV）
export const DAMAGE_ZONES = [
  { zone: 0, label: '弹性区', linear: [77 / 255, 77 / 255, 89 / 255] },
  { zone: 1, label: '微裂纹', linear: [230 / 255, 217 / 255, 77 / 255] },
  { zone: 2, label: '裂纹扩展', linear: [242 / 255, 140 / 255, 38 / 255] },
  { zone: 3, label: '破碎区', linear: [230 / 255, 51 / 255, 38 / 255] },
  { zone: 4, label: '抛掷区', linear: [153 / 255, 13 / 255, 26 / 255] }
]

// ─── 格式转换工具 ──────────────────────────────────────────

/** 线性 sRGB [r,g,b] 0..1 → CSS rgb() 字符串 */
function _linearToCss([r, g, b]) {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}

/** 线性色阶 [v, [r,g,b]] → CSS 图例格式 {v, c} */
function _convertToCss(linearStops) {
  return linearStops.map(([v, rgb]) => ({ v, c: _linearToCss(rgb) }))
}

/** CSS 图例色阶 → 线性色阶（反向转换，供渲染器复用 UI 数据） */
function _convertToLinear(cssStops) {
  return cssStops.map(s => {
    const m = s.c.match(/rgb\((\d+),(\d+),(\d+)\)/)
    if (!m) return [s.v, [0, 0, 0]]
    return [s.v, [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]]
  })
}

// ─── UI 图例派生数据（VisualOptions.vue 使用）───
export const PPV_LEGEND_STOPS = _convertToCss(PPV_COLOR_STOPS_LINEAR)
export const PPV_LEGEND_MAX = PPV_LUT_MAX_CMPS
export const PPV_TICKS = [0, 1, 2, 4, 7, 10, 15]

export const STRESS_LEGEND_STOPS = _convertToCss(STRESS_COLOR_STOPS_LINEAR)
export const STRESS_LEGEND_MAX = STRESS_LUT_MAX_MPA
export const STRESS_TICKS = [0, 3, 6, 10, 20, 30]

export const DAMAGE_LEGEND = DAMAGE_ZONES.map(z => ({
  zone: z.zone,
  label: z.label,
  c: _linearToCss(z.linear)
}))

// ─── CSS gradient 生成工具（VisualOptions.vue 使用）───
export function gradientCss(stops, max) {
  return stops
    .map(s => `${s.c} ${((s.v / max) * 100).toFixed(2)}%`)
    .join(', ')
}
