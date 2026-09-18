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

// ─── PPV 色阶（Viridis 感知均匀渐变，顶色=亮黄热区）───
// 用 Viridis 替换原 GB6722 自定义 jet（原顶档品红正是 P1-4 中心"粉紫巨块"的视觉来源）。
// 顶档为亮黄，配合对数标尺 + 动态量程，近场热区沿距离梯度衰减，不再压成单色块。
// v 锚点仍保留 cm/s 物理量纲（图例用），颜色按 u=v/vMax 取 Viridis 采样值。
// Viridis 采样（matplotlib ≥3.0，0..1 均匀）：
//   0.033≈(68,15,102) 0.067≈(65,34,140) 0.133≈(60,59,153) 0.2≈(57,78,162)
//   0.267≈(45,97,172) 0.367≈(29,128,181) 0.467≈(18,152,176) 0.6≈(20,183,149)
//   0.8≈(139,224,66) 1.0≈(253,231,37)
export const PPV_COLOR_STOPS_LINEAR = [
  [0.0, [0.267, 0.004, 0.33]],
  [0.5, [0.267, 0.06, 0.4]],
  [1.0, [0.255, 0.13, 0.55]],
  [2.0, [0.235, 0.23, 0.6]],
  [3.0, [0.224, 0.31, 0.635]],
  [4.0, [0.176, 0.38, 0.675]],
  [5.5, [0.114, 0.5, 0.71]],
  [7.0, [0.071, 0.596, 0.69]],
  [9.0, [0.078, 0.718, 0.584]],
  [12.0, [0.545, 0.878, 0.259]],
  [15.0, [0.993, 0.906, 0.145]]
]
export const PPV_LUT_MAX_CMPS = 15.0

// ─── 应力色阶（Viridis，兼容弹性反演范围 0.1~30 MPa）───
// 颜色按 u=v/vMax 取 Viridis；顶档亮黄，近场应力热区梯度清晰。
export const STRESS_COLOR_STOPS_LINEAR = [
  [0.0, [0.267, 0.004, 0.33]],
  [0.3, [0.275, 0.02, 0.353]],
  [1.0, [0.267, 0.06, 0.4]],
  [3.0, [0.251, 0.173, 0.58]],
  [6.0, [0.224, 0.306, 0.635]],
  [10.0, [0.11, 0.49, 0.706]],
  [20.0, [0.216, 0.78, 0.486]],
  [30.0, [0.993, 0.906, 0.145]]
]
export const STRESS_LUT_MAX_MPA = 30.0

// ─── Persson 损伤分区（5 色离散）───
// 阈值：(20,50,100,200) cm/s（PPV），与后端 DAMAGE_THRESHOLDS_CMPS、
// localVibrationSimulator、sceneBuilder shader、computeContourLevels 保持同一档位。
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
  c: _linearToCss(z.linear)
}))

// ─── CSS gradient 生成工具（VibrationFieldPanel.vue 使用）───
export function gradientCss(stops, max) {
  return stops.map(s => `${s.c} ${((s.v / max) * 100).toFixed(2)}%`).join(', ')
}

// ─── 归一化标尺常量（单源真相）────────────────────────────
// 分辨率 / 图例刻度 / 等值线取色 / 片元着色器四处必须同源，否则刻度与屏幕
// 色档边界错位、等值线与热力图不对齐。着色器侧由 sceneBuilder 以字面量注入
// （见 glslNum），JS 侧直接 import。
//
// NORM_FLOOR：对数标尺可见下限（占满刻度比例）。动态范围 = 1/NORM_FLOOR。
//   · 0.02（50×）：近场峰值一旦被当作满刻度，可见下限随之抬高（如 ~56 cm/s），
//     中远场整片落到下限以下 → 岩体上只剩爆源附近极小一块有色
//     （"渲染范围为什么这么小 / 波很糊"的直接原因）；
//   · 0.002（500×）：近场饱和仍局限于破碎区（米级），中远场保留完整对数梯度。
export const NORM_FLOOR = 0.002
export const NORM_LOG_SPAN = Math.log2(1 / NORM_FLOOR)

// 高光膝形压缩拐点区间：仅在接近满刻度处放缓，保留中高值区（4~15 cm/s、
// 4~20 MPa）的色阶对比。旧区间 (0.45, 0.92) 从中段就开始压缩，
// 是"波很糊"叠加成因之一。
export const KNEE_WARP_A = 0.8
export const KNEE_WARP_B = 1.0

// 色标满刻度自愈的安全上限（相对解析基线 rRef=4m 代表值的倍数）。
//
// 满刻度应当锚在**近场峰值**上：实测 P99.7 落在爆源 0.5m 处，约为基线的 27 倍。
// 对数标尺的取色位置是 log2(v/ref/floor)/log2(1/floor)——ref 偏小会把整块岩体
// 的取色位置整体推到色阶顶部（断面 0.5~15m 对应 iVal≈0.44~1.0，全是黄绿），
// 热力图糊成一大团没有结构（"应力热力图全糊"的根因）；ref 偏大只会整体偏暗、
// 可见下限随之下移，危害小得多。所以这里只设一个防病态尖峰的**宽松**上限，
// 正常物理场（≈27×基线）永远不会触及。
// 真正决定"渲染范围"的是 NORM_FLOOR：可见下限 = NORM_FLOOR × 满刻度。
export const REF_HEAL_MAX_MULT = 64

/** 数值 → GLSL float 字面量（保证带小数点，避免被解析为 int） */
export function glslNum(v) {
  return Number(v).toFixed(6)
}

// ─── 工业风格离散色带（经典 Jet）──────────────────────────
// 工程标准热力图视觉：经典彩虹色（Jet）+ 强制离散色阶（带内纯色、无平滑过渡）。
// 色阶数 N 与等值线条数（N−1，画在色阶边界上）同源，图例/热力图/等值线三处对齐。
export const INDUSTRIAL_BANDS_MIN = 12
export const INDUSTRIAL_BANDS_MAX = 16
export const INDUSTRIAL_BANDS_DEFAULT = 14

// 经典 Jet 锚点（MATLAB jet，sRGB 0..1）：深蓝→蓝→青→黄→红→深红
const _JET_ANCHORS = [
  [0.0, 0.0, 0.0, 0.5],
  [0.125, 0.0, 0.0, 1.0],
  [0.375, 0.0, 1.0, 1.0],
  [0.625, 1.0, 1.0, 0.0],
  [0.875, 1.0, 0.0, 0.0],
  [1.0, 0.5, 0.0, 0.0]
]

/** 经典 Jet 色带（sRGB 0..1，分段线性插值） */
export function jetSrgb(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  let k = 0
  while (k < _JET_ANCHORS.length - 2 && x > _JET_ANCHORS[k + 1][0]) k++
  const a = _JET_ANCHORS[k]
  const b = _JET_ANCHORS[k + 1]
  const span = b[0] - a[0]
  const f = span > 0 ? (x - a[0]) / span : 0
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
}

export function industrialBandCount(v) {
  const n = Math.round(Number(v) || INDUSTRIAL_BANDS_DEFAULT)
  return Math.min(INDUSTRIAL_BANDS_MAX, Math.max(INDUSTRIAL_BANDS_MIN, n))
}

/** 第 i 档（i=0..N-1）的代表色（取档中心 (i+0.5)/N 采样 Jet） */
export function industrialBandSrgb(i, bands = INDUSTRIAL_BANDS_DEFAULT) {
  const n = industrialBandCount(bands)
  return jetSrgb((Math.min(n - 1, Math.max(0, i)) + 0.5) / n)
}

/** sRGB → 线性工作色空间（LUT 纹理存线性值，与既有 PPV/应力色阶同口径） */
export function _srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * 工业离散色带 LUT 数据（N×1 RGBA，线性色空间）。
 * 第 i 个 texel = 第 i 档纯色 → shader 以档中心坐标 (i+0.5)/N 采样即得纯色，
 * 档与档之间无渐变（阶梯分段）。
 */
export function buildIndustrialLutData(bands = INDUSTRIAL_BANDS_DEFAULT) {
  const n = industrialBandCount(bands)
  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const [r, g, b] = industrialBandSrgb(i, n).map(_srgbToLinear)
    data[i * 4] = Math.round(r * 255)
    data[i * 4 + 1] = Math.round(g * 255)
    data[i * 4 + 2] = Math.round(b * 255)
    data[i * 4 + 3] = 255
  }
  return data
}

/** 工业色带显示纹理宽度（texel 数） */
export const LUT_TEXELS = 256

/**
 * 工业色带 LUT（LUT_TEXELS×1 RGBA，线性色空间）——**光滑渐变表**。
 *
 * 与 buildIndustrialLutData 的区别决定了屏幕上有无竖向条纹：
 * 前者只有 N（12~16）个 texel，shader 用连续 norm 直接采样时，同一个 texel 会被
 * 拉伸映射到屏幕上一大片区域——相邻像素落在 texel 边界两侧即出现竖向条纹；
 * 本函数把整条色带铺满 256 个 texel（档色之间线性插值），每级色对应约
 * 1/256 的归一化区间，屏幕色成为连续梯度上的真实取样，条纹消失。
 *
 * 各档**纯色**仍精确落在 texel 中心 ((i+0.5)/N)·(LUT_TEXELS−1) 上，档边界
 * （等值线级别、图例色块）与工业分档口径一致，不破坏"色阶边界 ↔ 归一化值互逆"。
 */
export function buildIndustrialLutGradient(bands = INDUSTRIAL_BANDS_DEFAULT) {
  const n = industrialBandCount(bands)
  const data = new Uint8Array(LUT_TEXELS * 4)
  for (let i = 0; i < LUT_TEXELS; i++) {
    const u = i / (LUT_TEXELS - 1)
    const x = u * (n - 1)
    const bi = Math.min(n - 2, Math.floor(x))
    const f = x - bi
    const a = industrialBandSrgb(bi, n)
    const b = industrialBandSrgb(bi + 1, n)
    const r = _srgbToLinear(a[0] + (b[0] - a[0]) * f)
    const g = _srgbToLinear(a[1] + (b[1] - a[1]) * f)
    const bl = _srgbToLinear(a[2] + (b[2] - a[2]) * f)
    data[i * 4] = Math.round(r * 255)
    data[i * 4 + 1] = Math.round(g * 255)
    data[i * 4 + 2] = Math.round(bl * 255)
    data[i * 4 + 3] = 255
  }
  return data
}

/** N 档 CSS 颜色列表（sRGB），供图例色块与等值线取色 */
export function industrialBandCssList(bands = INDUSTRIAL_BANDS_DEFAULT) {
  const n = industrialBandCount(bands)
  return Array.from({ length: n }, (_, i) => {
    const [r, g, b] = industrialBandSrgb(i, n)
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
  })
}

/**
 * 色阶边界物理值（= 等值线级别，共 N−1 条）。
 * 与 shader 归一化完全互逆：norm = log2(v/(ref·FLOOR))/SPAN（对数）或 v/ref（线性）。
 * 工业风格下不做膝形压缩，故边界值是精确的几何/等差数列。
 */
export function industrialBandBoundaries({
  ref,
  unitScale = 1,
  normMode = 1,
  bands = INDUSTRIAL_BANDS_DEFAULT
} = {}) {
  const n = industrialBandCount(bands)
  const r = Number(ref) > 0 ? Number(ref) : 0
  const out = []
  if (!(r > 0)) return out
  for (let k = 1; k < n; k++) {
    const u = k / n
    out.push(
      normMode === 1
        ? r * unitScale * NORM_FLOOR * Math.pow(2, NORM_LOG_SPAN * u)
        : r * unitScale * u
    )
  }
  return out
}

/**
 * 工业图例条目（离散色块 + 数值区间），第 i 档覆盖 [v_i, v_{i+1})。
 * @returns {Array<{i:number, css:string, lo:number, hi:number, top:number}>}
 */
export function industrialLegendItems({
  ref,
  unitScale = 1,
  normMode = 1,
  bands = INDUSTRIAL_BANDS_DEFAULT
} = {}) {
  const n = industrialBandCount(bands)
  const css = industrialBandCssList(n)
  const r = Number(ref) > 0 ? Number(ref) : 0
  const v = u =>
    !(r > 0)
      ? 0
      : normMode === 1
        ? r * unitScale * NORM_FLOOR * Math.pow(2, NORM_LOG_SPAN * u)
        : r * unitScale * u
  const items = []
  for (let i = n - 1; i >= 0; i--) {
    items.push({
      i,
      css: css[i],
      lo: v(i / n),
      hi: v((i + 1) / n),
      top: v(1)
    })
  }
  return items
}

/** 等值线颜色：按所在色档亮度取黑/白实线（工程图惯例，保证任意色档上可辨） */
export function industrialContourColor(bandIndex, bands = INDUSTRIAL_BANDS_DEFAULT) {
  const n = industrialBandCount(bands)
  const [r, g, b] = industrialBandSrgb(bandIndex, n)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.45 ? '#111111' : '#ffffff'
}

// ─── GPU 膝形压缩（高光软拐点）───────────────────────────
// 与 sceneBuilder.js 片元着色器完全同源同值：shader 在 LUT 查询前对归一化
// 场值做此变换（顶部 ~2 档带宽放缓），图例刻度必须套同一变换才能对准
// 屏幕上的色档边界（色条本身即 LUT 内容，无需变换）。
function _smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
export function kneeWarp(p) {
  const k = 1 - Math.pow(1 - p, 1.35)
  return p + (k - p) * _smoothstep(KNEE_WARP_A, KNEE_WARP_B, p)
}

// ─── 损伤五色 LUT 数据（5×1 RGBA，供 uDamageLut 采样）───
// 由 DAMAGE_ZONES 单源生成，替代 shader 内硬编码五色（消除双份维护漂移）。
export function buildDamageLutData() {
  const data = new Uint8Array(DAMAGE_ZONES.length * 4)
  DAMAGE_ZONES.forEach((z, i) => {
    data[i * 4] = Math.round(z.linear[0] * 255)
    data[i * 4 + 1] = Math.round(z.linear[1] * 255)
    data[i * 4 + 2] = Math.round(z.linear[2] * 255)
    data[i * 4 + 3] = 255
  })
  return data
}
