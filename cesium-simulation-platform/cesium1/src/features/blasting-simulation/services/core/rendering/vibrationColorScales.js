/**
 * 振动场色阶共享模块（单源真相）
 *
 * 渲染器（blastVibrationFieldRenderer.js）与 UI 组件（VibrationFieldPanel.vue）
 * 统一从此模块 import，避免双份维护导致色阶与图例不一致。
 *
 * 数据格式说明：
 * - 渲染器使用线性 sRGB 0..1 的 [v, [r,g,b]] 格式
 * - UI 图例使用 CSS rgb() 字符串的 {v, c} 格式
 * - 本模块同时提供两种格式，由 _convertToCss 与 _convertToLinear 互转
 */

// ─── PPV 色阶（GB6722-2014，cm/s；专业数值模拟软件 jet/rainbow 口径）───
// 色带对齐 LS-DYNA / ANSYS / ABAQUS 经典 rainbow 色带：
// 低端=深藏蓝（非亮蓝、非黑——亮蓝显得像 UI 配色，纯黑与模型暗部/无数据区混淆），
// 经 蓝→青→绿→黄→橙→红 渐进，顶端=暗红（近场饱和）。
// 停靠点数值保持 GB 阈值语义不变，仅重排颜色：
// 0     远场本底（深藏蓝，LS-DYNA 低端观感）
// 0.5-1 住宅安全阈值（藏蓝→蓝）
// 2-3   一般民用（蓝→青）
// 4-5.5 商业工业/显著（青→绿）
// 7-9   软岩巷道阈值（黄绿→橙黄）
// 12-15 损伤/严重损伤（红→暗红）
export const PPV_COLOR_STOPS_LINEAR = [
  [0.0, [0.0, 0.0, 0.42]],
  [0.5, [0.0, 0.0, 0.62]],
  [1.0, [0.0, 0.15, 0.92]],
  [2.0, [0.0, 0.45, 1.0]],
  [3.0, [0.0, 0.8, 1.0]],
  [4.0, [0.0, 1.0, 0.65]],
  [5.5, [0.1, 0.95, 0.15]],
  [7.0, [0.65, 1.0, 0.0]],
  [9.0, [1.0, 0.72, 0.0]],
  [12.0, [1.0, 0.15, 0.0]],
  [15.0, [0.55, 0.0, 0.0]]
]
export const PPV_LUT_MAX_CMPS = 15.0

// ─── 应力色阶（σ_vm 等效应力，MPa；同 jet/rainbow：低端深藏蓝、顶端暗红）───
// 弹性反演范围 0.1~10 MPa（中远场），近场可达数十 MPa
export const STRESS_COLOR_STOPS_LINEAR = [
  [0.0, [0.0, 0.0, 0.42]],
  [0.3, [0.0, 0.0, 0.62]],
  [1.0, [0.0, 0.15, 0.92]],
  [3.0, [0.0, 0.55, 1.0]],
  [6.0, [0.0, 0.9, 0.8]],
  [10.0, [0.55, 1.0, 0.0]],
  [20.0, [1.0, 0.3, 0.0]],
  [30.0, [0.55, 0.0, 0.0]]
]
export const STRESS_LUT_MAX_MPA = 30.0

// ─── 损伤分区（5 色离散，PPV 阈值分级）───
// 阈值依据（cm/s，质点峰值振速 PPV），前后端/着色器/点采样统一引用 DAMAGE_THRESHOLDS_CMPS：
//   zone0 弹性区      < 25        Bauer & Calder (1971)：完整岩石不致裂
//   zone1 微裂纹区    25~63.5     Bauer & Calder (1971)：轻微拉伸层裂（minor tensile slabbing）
//   zone2 裂隙扩展区  63.5~254    Bauer & Calder (1971)：强拉伸与径向裂缝（strong tensile / radial cracking）
//   zone3 破碎区      254~1500    Bauer & Calder (1971)：岩体完全破碎（complete break-up）
//   zone4 粉碎区      ≥ 1500      Persson et al. (1997) 瑞典硬岩"crushing"档（15 m/s），
//                                 对应爆腔近旁粉碎带（经验半径 2~3 倍炮孔半径，Ханукаев；
//                                 Hustrulid 建议 rc/rb ≤ 3~5，Esen et al. 1.3~6.6）
// 参考对照（不作为分级依据，仅注记）：
//   Savely (1986) 矿山边坡：斑岩无损伤 ≤12.7 / 可接受 ≤38.1 / 轻损伤 ≤63.5 / 爆破损伤 >63.5 cm/s
//   Langefors & Kihlström (1973)：无衬砌隧道落石 30.5 / 围岩新裂缝 61 cm/s
//   GB 6722-2014：保护对象安全允许振速 0.15~30 cm/s（远场建(构)筑物限值，语义不同，不混用）
//   → 本分级针对"岩体自身损伤"，阈值远高于 GB 6722 的远场保护限值。
// 【重要语义区分】"抛掷/扔出"是碎片运动学概念（实测抛掷初速 18~28 m/s 量级，高速摄影，
// 见《爆破》高台阶抛掷爆破数值模拟；由碎片系统 fragmentSpecGenerator 的速度场负责），
// 与 PPV 分区无对应关系——历史上 zone4 曾误标"抛掷区"（阈值 50 cm/s 仅为轻微层裂量级），
// 现按文献更名"粉碎区（近炮腔）"。
export const DAMAGE_THRESHOLDS_CMPS = [25.0, 63.5, 254.0, 1500.0]

export const DAMAGE_ZONES = [
  { zone: 0, label: '弹性区', range: '<25', linear: [77 / 255, 77 / 255, 89 / 255] },
  { zone: 1, label: '微裂纹区', range: '25~63.5', linear: [230 / 255, 217 / 255, 77 / 255] },
  { zone: 2, label: '裂隙扩展区', range: '63.5~254', linear: [242 / 255, 140 / 255, 38 / 255] },
  { zone: 3, label: '破碎区', range: '254~1500', linear: [230 / 255, 51 / 255, 38 / 255] },
  { zone: 4, label: '粉碎区(近炮腔)', range: '≥1500', linear: [153 / 255, 13 / 255, 26 / 255] }
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
export function _convertToLinear(cssStops) {
  return cssStops.map(s => {
    const m = s.c.match(/rgb\((\d+),(\d+),(\d+)\)/)
    if (!m) return [s.v, [0, 0, 0]]
    return [s.v, [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]]
  })
}

// ─── UI 图例派生数据（VibrationFieldPanel.vue 使用）───
export const PPV_LEGEND_STOPS = _convertToCss(PPV_COLOR_STOPS_LINEAR)
export const PPV_LEGEND_MAX = PPV_LUT_MAX_CMPS
export const PPV_TICKS = [0, 1, 2, 4, 7, 10, 15]

export const STRESS_LEGEND_STOPS = _convertToCss(STRESS_COLOR_STOPS_LINEAR)
export const STRESS_LEGEND_MAX = STRESS_LUT_MAX_MPA
export const STRESS_TICKS = [0, 3, 6, 10, 20, 30]

export const DAMAGE_LEGEND = DAMAGE_ZONES.map(z => ({
  zone: z.zone,
  label: z.label,
  range: z.range,
  c: _linearToCss(z.linear)
}))

// ─── 影响范围（爆破振动安全允许距离，工程口径）─────────────────────
// 【文献口径】昆阳磷矿文献（王万禄等 2024）按 GB 6722-2014 计算爆破振动安全允许
// 距离：R0 = (K/V0)^(1/α)·Q0^(1/3)。Q0 取全断面最大装药量（原文：井巷狭小空间
// 分段微差的冲击波叠加效应，取总装药量）；V0 为保护对象安全允许质点振速
// （GB 6722-2014 表 4：矿山巷道 15~30 cm/s，文献取 20；边坡文献取 10）。
// 文献结果：巷道 R0=11.40m（2.43×洞径 4.7m）、边坡 R0=17.67m（3.76×洞径）——
// 即"影响范围 ≈ 2.5~5 倍洞径"经验规则的出处。与损伤分区（Bauer-Calder 岩体
// 损伤判据）是两个不同的物理量：影响范围=保护对象振动安全，损伤圈=岩体致裂。
/** GB 6722-2014 表4 安全允许质点振速 (cm/s)：影响范围计算用默认档位 */
export const INFLUENCE_V0_CMPS = { tunnel: 20.0, slope: 10.0 }

/**
 * 爆破振动安全允许距离 R0 (m)：R0 = (K/V0)^(1/α)·Q0^(1/3)（萨道夫斯基反解，
 * 与昆阳文献式(2)一致；K 单位 cm/s、Q0 全断面最大装药量 kg）
 * @param {Object} p - { K, alpha, Q0, v0 }
 * @returns {number} R0 (m)；参数无效时返回 0
 */
export function safetyInfluenceRangeM({ K, alpha, Q0, v0 }) {
  const k = Number(K) || 0
  const a = Number(alpha) || 0
  const q = Number(Q0) || 0
  const v = Number(v0) || 0
  if (k <= 0 || a <= 0 || q <= 0 || v <= 0) return 0
  return Math.pow(k / v, 1 / a) * Math.cbrt(q)
}

// ─── CSS gradient 生成工具（VibrationFieldPanel.vue 使用）───
/**
 * 生成图例色带 CSS 渐变（线性标尺：与 shader 的线性映射同源）。
 * @param {Array<{c:string,v:number}>} stops - 色阶停靠点（值域线性）
 * @param {number} max - 满刻度（与 shader 归一化分母一致）
 */
export function gradientCss(stops, max) {
  return stops
    .map(s => `${s.c} ${(Math.min(1, Math.max(0, s.v / max)) * 100).toFixed(2)}%`)
    .join(', ')
}

// ─── 场值归一化（线性标尺）────────────────────────────
// 与 LS-DYNA 色带口径一致：在数据范围内线性均分，低值=色带低端（蓝）、高值=红。
// shader 取色位置 p = clamp((v/ref)·uNormAutoScale, 0, 1)（autoscale 由渲染器按当前范围下发）。
export const NORM_FLOOR = 0
export const NORM_LOG_SPAN = 1

/** 场值 v → 色带位置 [0,1]（线性；autoscale 由渲染器按当前范围下发） */
export function valueToNorm(v, ref, autoscale = 1) {
  const r = Math.max(Number(ref) || 0, 1e-9)
  const a = Number(autoscale) > 0 ? Number(autoscale) : 1
  return Math.min(1, Math.max(0, (Math.max(0, Number(v) || 0) / r) * a))
}

/** 色带位置 p ∈ [0,1] → 场值（线性反解；autoscale 同上） */
export function normToValue(p, ref, autoscale = 1) {
  const r = Math.max(Number(ref) || 0, 1e-9)
  const a = Number(autoscale) > 0 ? Number(autoscale) : 1
  const x = Math.min(1, Math.max(0, Number(p) || 0))
  return (r * x) / a
}

/**
 * 在线性色阶（[[v,[r,g,b]], …]）上按"值"线性插值取色，返回 [r,g,b] 0..1。
 * 用于需要与热力图同源取色的场合（图例刻度/自定义渲染）。
 * @param {Array} linearStops - PPV_COLOR_STOPS_LINEAR / STRESS_COLOR_STOPS_LINEAR
 * @param {number} value - 与色阶同单位的值（PPV: cm/s；应力: MPa）
 */
export function sampleScaleColor(linearStops, value) {
  const s = linearStops
  if (!Array.isArray(s) || !s.length) return [1, 1, 1]
  const v = Number(value)
  if (!Number.isFinite(v) || v <= s[0][0]) return s[0][1].slice()
  const lastStop = s[s.length - 1]
  if (v >= lastStop[0]) return lastStop[1].slice()
  for (let i = 1; i < s.length; i++) {
    const [v0, c0] = s[i - 1]
    const [v1, c1] = s[i]
    if (v <= v1) {
      const t = (v - v0) / Math.max(v1 - v0, 1e-9)
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return lastStop[1].slice()
}
