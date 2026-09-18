/**
 * 爆堆轮廓渲染器（糖衣式三维包络 + 底部轮廓 + 安息角标注）
 *
 * 在碎片落地堆积形成爆堆后，从物理引擎的碎片状态实时提取世界坐标，
 * 构建"糖衣式"包裹壳。深度重构后的几何管线（每次重建按墙钟节流 ~5.4Hz）：
 *
 *   collect   收集"停稳"碎片：landed 或 |v|² < SLOW_SPEED2（空中飞石不入堆，
 *             否则足迹会被飞行散布撑得巨大；安息角判定会瞬时解除 landed，
 *             不补低速碎片会让壳出现闪烁性破洞）
 *   project   世界坐标 → 局部 (s 轴向, t 侧向, h 高)；掌子面平面裁掉穿模进
 *             未爆破岩体的碎片（壳不会被撑进岩体内部）；隧道断面裁掉
 *             "卡在隧道外"的异常碎石（中心在断面外的碎片不参与建场）
 *   grid      网格边界 = 碎片范围 + (maxRad + 1 格) pad。旧版网格只框到
 *             "碎片中心"范围，最外圈碎块的身体伸出网格外，足迹被网格边界
 *             硬切——这正是"包裹不了整个爆堆"的根源之一
 *   splat     每个碎片按"有向包围盒精确投影"溅射：用碎片四元数 + 变体
 *             半轴长计算其在 (s,t,up) 三个轴向上的支撑半长（es/et/su），
 *             足迹 = 投影矩形（精确）、顶面 = 中心 + su（紧贴真实顶面），
 *             不再用"最大球半径"近似（尖角变体 maxR≈2.0 会撑出大片空档）
 *   section   场级断面裁剪：侧向超出断面的格子 mask=0，格子高度按该
 *             侧向位置的断面净空封顶——壳被硬性约束在隧道内，贴墙堆积
 *             不会再把壳挤出隧道壁；碎片中心进入上部 35% 净空的"上端
 *             岩壁卡石"（贴上壁/拱腰的静止碎块）整体剔除，壳不再沿
 *             侧壁被拉到拱顶附近、扭曲爆堆形状
 *   cleanup   单格去噪 → 连通分量保留(≥4 格，保留次级堆瓣) → 填内部空洞 →
 *             填洞格高度单调生长
 *   surface   角点高度 = 相邻 4 格 max → 单遍 75:25 平滑 → 峰值还原(max) →
 *             +SHELL_EPS 上浮。峰值还原保证壳面 ≥ 任何碎片顶面，堆顶碎块
 *             不再刺穿壳面
 *   render    顶面网格（高度色带）+ 侧壁沿足迹外边界从壳面高度垂直收口到
 *             底板（投影轮廓与爆堆足迹严格一致）。安息角/堆高/面积/体积等
 *             测量信息一律不绘制进模型，全部交给 UI 面板展示。
 *
 * 数据源：构造时注入的 `getBodyStates` 读取
 * `[{ posX, posY, posZ, velX, velY, velZ, alive, landed, physSize }, ...]`。
 */
import * as THREE from 'three'
import { getRockVariantVertices } from './rockGeometryFactory.js'

// ─── 配色（学术偏暖的琥珀/橙，避免刺眼）──────────────────────

// 顶面"糖衣"透明度：0.55 半透明。既要让高度色带清晰可见（旧版 0.5 时
// 色带被亮灰碎石稀释得看不清），又要透过壳面看到下方碎石（0.9 近实心
// 会把碎石完全盖住）。0.55 两侧兼顾：色带仍足够清晰，碎石若隐若现。
const CAP_OPACITY = 0.55

// ─── 高度色带（hypsometric tint，暗背景下清晰）────────────────────
// 底→顶 亮青蓝→青绿→金黄→橙→绯红，全段高亮度避免暗背景不可见。
const RAMP_STOPS = [
  { t: 0.0, c: new THREE.Color(0x2a8fbd) }, // 底板·亮青蓝
  { t: 0.3, c: new THREE.Color(0x36b37e) }, // 坡脚·青绿
  { t: 0.55, c: new THREE.Color(0xd7c13f) }, // 下坡·金黄
  { t: 0.78, c: new THREE.Color(0xf0941f) }, // 腰坡·橙
  { t: 1.0, c: new THREE.Color(0xe8422a) } // 峰顶·绯红
]

// ─── 几何管线参数 ──────────────────────────────────────────
// 顶面色域高度场网格步长：0.12m 细格逐格跟随爆堆高度起伏。壳面 = 逐格
// 台阶面，每格按自身碎块顶高画一块平顶 + 侧壁，天然呈现棱角起伏；越细
// 越贴合碎石堆的尖角细节（有棱有角），不把顶部打磨成平滑穹顶。
const CAP_CELL = 0.12
// 唯一侧壁阈值（m）：相邻格顶高落差小于该值时不生成竖直侧壁面。
// 锥峰顶面让微坡度相邻格高度只有毫米~厘米差，若每格都画竖直墙，壳重建的面片
// 会爆炸（数千格 × 最多 4 墙）。只在落差 ≥ WALL_TOL（真正的"岩块台阶"）才画墙，
// 微小坡度差让平顶阶直接相邻（台阶缝≤几厘米、0.55 半透明下不可见），
// 几何量级级下降。保留了大石块峰脊那几级有棱角的粗台阶。
const WALL_TOL = 0.05
// 网格规模上限（防爆堆过大时开销失控，超出时步长自适应放大）。
// 上限按 CAP_CELL 放宽：大跨度爆堆也能保持细格贴合，不被强制粗化。
const GRID_MAX_S = 240
const GRID_MAX_T = 170
// 掌子面裁剪容差：碎片中心允许超出掌子面平面的距离。
// 爆堆物理上只存在于掌子面前方，超出该界面的碎片是穿模进未爆破岩体的错误点。
const FACE_TOLERANCE = 0.8
// 隧道断面裁剪容差：碎片中心允许伸出断面边界的距离（m）。
// "卡在隧道外壁/拱顶外的碎石"（异常点）不计入爆堆轮廓，避免包裹壳被它们撑偏；
// 贴墙正常堆积的碎石中心仍在断面内（距边界 ≥ 自身半径），不会被误剔。
const SECTION_TOLERANCE = 0.12
// 拱顶外露剔除容差：碎块顶面（中心 + AABB 竖向支撑 su）越过该侧向位置
// 断面净空允许的量(m)。净空是隧道内表面，正常堆积的碎块最多毫米级压线；
// 超过该值即判定为"从拱顶伸出隧道"的异常尖角碎块，整体剔除不参与建壳——
// 否则壳的高度场/峰值还原会被这类尖角撑到净空高度，造成"壳顶明显高于
// 碎石堆"且轮廓在拱顶出现尖刺外凸。
const CROWN_TOL = 0.3
// 低速纳入阈值（速度平方）：未置 landed 但已停稳的碎片也计入堆体。
const SLOW_SPEED2 = 1.0
// 连通分量保留阈值（格数）：≥4 格（约 0.8m²）的堆瓣全部保留，
// 只剔除孤立单石。旧版"≥最大分量 5%"会把次级堆瓣整块丢弃。
const MIN_COMPONENT_CELLS = 4
// 离群散石过滤：与最近邻（按 s/t 平面）距离超过该值(m)的碎片视为
// 零星抛远的散石，不参与建壳——避免个别散石把壳拉长/拉高，
// 造成"壳与主堆之间大片无碎石"的不贴合观感。
const OUTLIER_GAP = 4.0
// 几何重建节流间隔：约 4Hz。爆堆只在碎石停稳后成形，250ms 刷新仍能跟随堆形，
// 同时避免每 185ms 全量重建带来的持续 CPU 占用。
const REBUILD_INTERVAL_MS = 250
const ANGLE_MIN = 15
const ANGLE_MAX = 62

// 排障诊断开关：排查问题时临时打开（打印主爆堆掩码统计量）
const DEBUG_MUCKPILE = false

const EMPTY_MEASURE = {
  angle: null,
  height: null,
  meanHeight: null,
  width: null,
  length: null,
  mainLength: null,
  area: null,
  volume: null,
  keptCount: null,
  totalCount: null,
  excludedCount: null
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 二维点集凸包（Andrew 单调链，返回逆时针环，元素 [s,t]）。
 * 用于把某块碎石在 (s,t) 平面投影的全部顶点收敛成"可见外沿轮廓"，
 * 替代"旋转 AABB 整矩形"作为包裹壳掩码——箱角那几格不再被包进来，
 * 堆体足迹/体积随之收紧（对应"碎石渲染显得多"的一部分根源）。
 * @param {Array<[number,number]>} points
 * @returns {Array<[number,number]>}
 */
function convexHull2(points) {
  const n = points.length
  if (n <= 3) return points
  const a = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const lower = []
  for (const p of a) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = n - 1; i >= 0; i--) {
    const p = a[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * 点在逆时针凸多边形内判定（含边界）。
 * @param {Array<[number,number]>} h 凸包环
 * @param {number} x
 * @param {number} y
 */
function pointInConvex(h, x, y) {
  const n = h.length
  let sgn = 0
  for (let k = 0; k < n; k++) {
    const ax = h[k][0] - x
    const ay = h[k][1] - y
    const bx = h[(k + 1) % n][0] - x
    const by = h[(k + 1) % n][1] - y
    const cr = ax * by - ay * bx
    if (Math.abs(cr) < 1e-12) continue
    const s = cr > 0 ? 1 : -1
    if (sgn === 0) sgn = s
    else if (sgn !== s) return false
  }
  return true
}

/**
 * 离群散石过滤（就地返回新数组）：每块碎片求其在 (s,t) 平面的最近邻距离，
 * 若超过 OUTLIER_GAP 判定为零星散石，剔除。大幅降低壳被个别抛远碎块
 * 拉长/撑高造成的"壳与主堆大片空档"观感。
 * @param {Array<{s:number,t:number}>} pairs
 * @returns {Array} 过滤后的碎片
 */
function filterOutlierFragments(pairs) {
  const n = pairs.length
  // 返回拷贝（非引用），调用方会清空原数组并重填
  if (n < 8) return pairs.slice()
  // 空间分桶（桶边长 = OUTLIER_GAP）：每块碎块只与"同桶 + 8 邻桶"比较最近邻，
  // 把原 O(n²)（2000+ 停稳碎块 ≈ 840 万次距离）降到近线性，消除爆堆壳重建的
  // 卡顿来源。
  const cell = OUTLIER_GAP
  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const bk = Math.floor(pairs[i].s / cell) + ',' + Math.floor(pairs[i].t / cell)
    let arr = buckets.get(bk)
    if (!arr) buckets.set(bk, (arr = []))
    arr.push(i)
  }
  const D2 = OUTLIER_GAP * OUTLIER_GAP
  const keep = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const pi = pairs[i]
    const gs = Math.floor(pi.s / cell)
    const gt = Math.floor(pi.t / cell)
    let best = Infinity
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const arr = buckets.get(gs + a + ',' + (gt + b))
        if (!arr) continue
        for (let k = 0; k < arr.length; k++) {
          const j = arr[k]
          if (j === i) continue
          const pj = pairs[j]
          const dx = pi.s - pj.s
          const dy = pi.t - pj.t
          const d2 = dx * dx + dy * dy
          if (d2 < best) best = d2
          if (best <= D2) break
        }
        if (best <= D2) break
      }
      if (best <= D2) break
    }
    keep[i] = best <= D2 ? 1 : 0
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pairs[i])
  return out
}

/** 高度色带取值：normalized 0→1 底→顶，按 RAMP_STOPS 线性插值 */
function rampColor(t) {
  t = clamp(t, 0, 1)
  const out = new THREE.Color()
  for (let k = 1; k < RAMP_STOPS.length; k++) {
    if (t <= RAMP_STOPS[k].t) {
      const a = RAMP_STOPS[k - 1]
      const b = RAMP_STOPS[k]
      const u = (t - a.t) / (b.t - a.t)
      return out.copy(a.c).lerp(b.c, u)
    }
  }
  return out.copy(RAMP_STOPS[RAMP_STOPS.length - 1].c)
}

/**
 * 4 连通分量标记：返回每个格子的分量标签与各分量大小。
 */
function labelComponents(Ns, Nt, mask) {
  const N = Ns * Nt
  const belong = new Int32Array(N).fill(-1)
  const stack = new Int32Array(N)
  const sizes = []
  let label = 0
  for (let start = 0; start < N; start++) {
    if (!mask[start] || belong[start] >= 0) continue
    let top = 0
    stack[top++] = start
    belong[start] = label
    let count = 0
    while (top > 0) {
      const cur = stack[--top]
      count++
      const ci = (cur / Nt) | 0
      const cj = cur % Nt
      const nb = [
        ci > 0 ? cur - Nt : -1,
        ci < Ns - 1 ? cur + Nt : -1,
        cj > 0 ? cur - 1 : -1,
        cj < Nt - 1 ? cur + 1 : -1
      ]
      for (const n of nb) {
        if (n >= 0 && mask[n] && belong[n] < 0) {
          belong[n] = label
          stack[top++] = n
        }
      }
    }
    sizes.push(count)
    label++
  }
  return { belong, sizes }
}

/**
 * 连通分量过滤（就地）：保留所有 ≥ MIN_COMPONENT_CELLS 格的分量——
 * 主爆堆 + 次级堆瓣全部保留，只剔除孤立单石/残点。
 */
function keepComponents(Ns, Nt, mask) {
  const N = Ns * Nt
  const { belong, sizes } = labelComponents(Ns, Nt, mask)
  for (let i = 0; i < N; i++) {
    const lab = belong[i]
    if (lab >= 0 && sizes[lab] < MIN_COMPONENT_CELLS) mask[i] = 0
  }
}

/**
 * 孤立格去噪：把 4 邻域内没有其它占据格的"单点噪声"格清除。
 */
function removeNoiseCells(Ns, Nt, mask) {
  for (let i = 0; i < Ns; i++) {
    for (let j = 0; j < Nt; j++) {
      const idx = i * Nt + j
      if (!mask[idx]) continue
      let nb = 0
      if (i > 0 && mask[idx - Nt]) nb++
      if (i < Ns - 1 && mask[idx + Nt]) nb++
      if (j > 0 && mask[idx - 1]) nb++
      if (j < Nt - 1 && mask[idx + 1]) nb++
      if (nb === 0) mask[idx] = 0
    }
  }
}

/**
 * 内部空洞填补（就地）：从网格边界向"空格"洪泛，洪泛不可达的空格即被
 * 堆体包围的内部空洞，标记为占据。否则壳顶面会在堆体内部留出"漏底洞"，
 * 透过洞看到底板，像包裹壳破了一块。
 */
function fillHoles(Ns, Nt, mask) {
  const N = Ns * Nt
  const outside = new Uint8Array(N)
  const stack = new Int32Array(N)
  let top = 0
  const push = i => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1
      stack[top++] = i
    }
  }
  for (let j = 0; j < Nt; j++) {
    push(j)
    push((Ns - 1) * Nt + j)
  }
  for (let i = 0; i < Ns; i++) {
    push(i * Nt)
    push(i * Nt + Nt - 1)
  }
  while (top > 0) {
    const cur = stack[--top]
    const ci = (cur / Nt) | 0
    const cj = cur % Nt
    if (ci > 0) push(cur - Nt)
    if (ci < Ns - 1) push(cur + Nt)
    if (cj > 0) push(cur - 1)
    if (cj < Nt - 1) push(cur + 1)
  }
  for (let i = 0; i < N; i++) {
    if (!mask[i] && !outside[i]) mask[i] = 1
  }
}

/**
 * 高度生长（就地）：填洞/去噪后仍无高度的占据格，从 4 邻域已知高度
 * 单调生长（取最大），数轮扫描可覆盖多格宽的洞。
 */
function growHeights(Ns, Nt, mask, top, passes = 4) {
  for (let pass = 0; pass < passes; pass++) {
    let grew = false
    for (let i = 0; i < Ns; i++) {
      for (let j = 0; j < Nt; j++) {
        const idx = i * Nt + j
        if (!mask[idx] || top[idx] > -1e30) continue
        let m = -Infinity
        if (i > 0 && top[idx - Nt] > m) m = top[idx - Nt]
        if (i < Ns - 1 && top[idx + Nt] > m) m = top[idx + Nt]
        if (j > 0 && top[idx - 1] > m) m = top[idx - 1]
        if (j < Nt - 1 && top[idx + 1] > m) m = top[idx + 1]
        if (m > -1e30) {
          top[idx] = m
          grew = true
        }
      }
    }
    if (!grew) break
  }
}

// 锥峰径向衰减查找表：frac∈[0,1] → frac^1.4。splat 里避免逐格调 Math.pow
//（pow 单元开销大，2000+ 碎块 × 每块数格会在每次重建时累积明显耗时）。
const CONE_POW_STEPS = 256
const CONE_POW = new Float32Array(CONE_POW_STEPS + 1)
for (let k = 0; k <= CONE_POW_STEPS; k++) CONE_POW[k] = Math.pow(k / CONE_POW_STEPS, 1.4)

/**
 * 锥峰溅射（逐块碎石"尖顶凸起"高度场 + 包围盒足迹）。
 *
 * 足迹（mask/count）= 每块碎石的矩形包围盒投影（半宽 es/et，由四元数 + 变体
 * 半轴长精确算出）——保证壳面覆盖碎石的所有可见外沿，不会出现"没被包裹"的
 * 边缘空洞，也保证壳与爆堆足迹严格一致。若碎块提供了真实投影轮廓(sil)，
 * 掩码进一步收紧到该凸包内——箱角（旋转 AABB 的空档）不再计入，堆体体积/
 * 足迹随"碎石实际外沿"收紧。
 *
 * 顶面高度（top）= 以每块碎石为"尖顶锥峰"的包络线：
 *   每块碎石在自身中心顶出一个达到其真实顶面(hTop)的峰尖，沿径向按
 *   (d/R)^1.4 下落到锥底(≈碎块竖向尺寸 descent = su×1.25)。格心与中心距离
 *   frac → 顶高 = hTop - descent·frac^1.4。
 *   取所有覆盖格的锥峰最大值作为壳面高度。
 * 结果：顶部随每块碎石呈现一块块向下收尖的锥形凸起（有棱有角），而不是把整片
 * 顶面平在场最高碎块的包围盒顶、连成一块"磨平的穹顶"。
 * @param {Array<{s:number,t:number,es:number,et:number,su:number,hTop:number,sil:Array|null}>} pairs 局部坐标碎片
 * @param {number} floorY - 底板绝对高度（锥底下限）
 * @returns {{mask:Uint8Array, top:Float32Array, count:Uint16Array}}
 */
function splatConeTops(pairs, Ns, Nt, ds, dt, sLo, tLo, floorY) {
  const N = Ns * Nt
  const mask = new Uint8Array(N)
  const top = new Float32Array(N).fill(-Infinity)
  const count = new Uint16Array(N)
  for (const q of pairs) {
    const R = Math.max(q.es, q.et)
    if (R <= 0.0001) continue
    const hull = Array.isArray(q.sil) && q.sil.length >= 3 ? q.sil : null
    // 锥峰下落量 ≈ 碎块竖向尺寸的 1.25 倍（峰尖到锥底），至少 0.22m 保证
    // 小块也有尖顶。相对碎块半宽 R 形成 ~50° 的岩块状坡角（真实碎石安息角
    // 量级），顶部呈现"有棱有角"的锥形凸起而非针状尖刺。
    const descent = Math.max(Number(q.su) * 1.25, 0.22)
    const iA = clamp(Math.floor((q.s - q.es - sLo) / ds), 0, Ns - 1)
    const iB = clamp(Math.floor((q.s + q.es - sLo) / ds), 0, Ns - 1)
    const jA = clamp(Math.floor((q.t - q.et - tLo) / dt), 0, Nt - 1)
    const jB = clamp(Math.floor((q.t + q.et - tLo) / dt), 0, Nt - 1)
    for (let i = iA; i <= iB; i++) {
      const sc = sLo + (i + 0.5) * ds
      const dx = sc - q.s
      for (let j = jA; j <= jB; j++) {
        const tc = tLo + (j + 0.5) * dt
        // 真实轮廓掩码：格心不在石块投影凸包内则不计入（回退到包围盒全包时恒过）
        if (hull && !pointInConvex(hull, sc, tc)) continue
        const dy = tc - q.t
        // 归一化径向距离（锥内衰减；箱角区域 frac 封顶为 1 → 取锥底高）
        const F = (CONE_POW_STEPS * clamp(Math.sqrt(dx * dx + dy * dy) / R, 0, 1)) | 0
        const h = Math.max(floorY, q.hTop - descent * CONE_POW[F])
        const idx = i * Nt + j
        mask[idx] = 1
        count[idx]++
        if (h > top[idx]) top[idx] = h
      }
    }
  }
  return { mask, top, count }
}

export class MuckPileOutlineRenderer {
  /**
   * @param {THREE.Scene} scene - 场景
   * @param {() => Array<{posX:number,posY:number,posZ:number,velX:number,velY:number,velZ:number,alive:boolean,landed:boolean,physSize:number}>} getBodyStates - 读取碎片状态
   */
  constructor(scene, getBodyStates) {
    this.scene = scene
    this._getBodyStates = getBodyStates
    this.enabled = false

    this._group = new THREE.Group()
    this._group.name = 'muckPileOutline'
    // 局部基与爆堆参数（configure 时注入）
    this._forward = new THREE.Vector3(0, 0, 1)
    this._right = new THREE.Vector3(1, 0, 0)
    this._up = new THREE.Vector3(0, 1, 0)
    this._center = new THREE.Vector3()
    this._floorY = 0
    this._faceOffset = null // 掌子面沿 forward 距 center 的轴向距离（null = 不裁剪）
    this._section = null // 隧道断面参数（null = 不做断面裁剪）
    this._fragmentExtents = null // 逐碎片渲染包围盒半轴（null = 回退 physSize×0.5 立方）
    // 各几何变体的基础顶点（scale=1，索引同几何池），用于投影真实轮廓掩码
    this._variantVerts = getRockVariantVertices()

    // 持有的可释放对象
    this._geometries = []
    this._lastRebuild = 0
    this._lastDebug = 0
    this._field = null // 最近一次重建的堆体场（诊断/采样用）

    // 最新测量（供 UI 回读安息角）
    this.measure = { ...EMPTY_MEASURE }
    this._latestAngle = null
  }

  /**
   * 配置局部坐标系与爆堆参数。
   * 世界坐标约定（全类统一，_worldPoint 是唯一换算入口）：
   *   碎片世界坐标 = center + forward*s + right*t + up*(h - floorY)
   * 其中 h 为绝对高度，floorY 为底板绝对高度。
   */
  configure({ forward, right, up, center, floorY, faceOffset, section } = {}) {
    if (forward) this._forward.copy(forward)
    if (right) this._right.copy(right)
    if (up) this._up.copy(up)
    if (center) this._center.copy(center)
    if (Number.isFinite(Number(floorY))) this._floorY = Number(floorY)
    if (faceOffset != null) this._faceOffset = Number(faceOffset)
    // 隧道断面参数（用于剔除"卡在隧道外"的异常碎石）：{width,wallHeight,archRadius,shape}
    if (section) this._section = section
    if (this.enabled && this.scene && !this._group.parent) this.scene.add(this._group)
  }

  /**
   * 注入每个碎片的渲染包围盒半轴长（索引 = 物理引擎 body 顺序 = specs 顺序，
   * 值 = 变体 AABB 半轴 × dispSize）。配合碎片四元数做精确投影，
   * 使壳面足迹/高度紧贴可见碎石，不再用最大球半径近似。
   * @param {Array<{hx:number,hy:number,hz:number}>|null} extents
   */
  setFragmentExtents(extents) {
    this._fragmentExtents = Array.isArray(extents) ? extents : null
  }

  /**
   * 把某块碎石的几何全部顶点变换到世界并投影到 (s,t) 局部坐标，取凸包，
   * 得到该碎块的"真实可见外沿轮廓"（掩码用）。未提供有效变体/尺寸/顶点时
   * 返回 null（调用方回退到原矩形包围盒，保证覆盖不外露）。
   * @param {{variant:number,size:number}} ext
   * @param {number} s 中心轴向
   * @param {number} t 中心侧向
   * @param {...um} 局部三轴世界坐标方向 (c1/c2/c3)
   * @param {THREE.Vector3} ax forward
   * @param {THREE.Vector3} rt right
   */
  _projectSilhouette({ variant, size }, s, t, c1x, c1y, c1z, c2x, c2y, c2z, c3x, c3y, c3z, ax, rt) {
    const verts = this._variantVerts && this._variantVerts[variant]
    const sc = Math.max(0.0001, Number(size) || 1)
    if (!verts || verts.length < 9) return null
    const n = verts.length / 3
    const out = new Array(n)
    for (let k = 0; k < n; k++) {
      const bx = verts[k * 3] * sc
      const by = verts[k * 3 + 1] * sc
      const bz = verts[k * 3 + 2] * sc
      // 局部→世界 位移向量（三轴方向按分量组合）
      const wx = bx * c1x + by * c2x + bz * c3x
      const wy = bx * c1y + by * c2y + bz * c3y
      const wz = bx * c1z + by * c2z + bz * c3z
      out[k] = [s + (wx * ax.x + wy * ax.y + wz * ax.z), t + (wx * rt.x + wy * rt.y + wz * rt.z)]
    }
    return convexHull2(out)
  }

  /**
   * 隧道断面在侧向 t 处的净空高度（自底板起）；|t| 超出断面返回 null。
   * 用于把壳的高度场/足迹硬性约束在隧道内（贴墙堆积不挤出隧道壁）。
   */
  _sectionCeiling(tLateral) {
    const sec = this._section
    if (!sec) return null
    const halfW = Number(sec.width) / 2 || 0
    const wallH = Number(sec.wallHeight) || 0
    const R = Number(sec.archRadius) || 0
    const at = Math.abs(Number(tLateral) || 0)
    const shape = sec.shape || 'horseshoe'
    if (shape === 'circular') {
      if (at > R) return null
      return R + Math.sqrt(Math.max(0, R * R - at * at))
    }
    if (shape === 'rectangular') {
      if (at > halfW) return null
      return wallH + R
    }
    // 马蹄形：直墙区 |t| ≤ halfW；拱区按拱心 (0, wallH) 半径 R 的圆封顶
    if (at > halfW) return null
    if (at > R) return wallH
    return wallH + Math.sqrt(Math.max(0, R * R - at * at))
  }

  /**
   * 场级断面裁剪：侧向超出断面的格子清零（壳不出隧道壁），
   * 保留格子的高度按该侧向位置的断面净空封顶（壳不穿拱顶）。
   */
  _clipFieldToSection(Ns, Nt, dt, tLo, mask, top) {
    if (!this._section) return
    for (let j = 0; j < Nt; j++) {
      const tc = tLo + (j + 0.5) * dt
      // 以格子中心判越界（不向墙外扩半格），贴墙的正常堆积格得以保留，
      // 壳侧壁贴着墙面（距断面边界仅剩半格余量）
      const ceil = this._sectionCeiling(tc)
      const inSection =
        ceil != null && Math.abs(tc) <= Number(this._section.width) / 2 + SECTION_TOLERANCE
      for (let i = 0; i < Ns; i++) {
        const idx = i * Nt + j
        if (!inSection) {
          mask[idx] = 0
          continue
        }
        if (mask[idx]) {
          const cap = this._floorY + Math.max(0, ceil)
          if (Number.isFinite(cap) && top[idx] > cap) top[idx] = cap
        }
      }
    }
  }

  /**
   * 判断局部坐标 (t 侧向, u 竖向自底板起) 的碎片中心是否位于隧道断面之外。
   * 支持马蹄形 / 圆形 / 矩形；tolerance 允许轻微越界（贴面/贴墙正常堆积不误剔）。
   */
  _outsideSection(t, u) {
    const sec = this._section
    if (!sec) return false
    const halfW = Number(sec.width) / 2 || 0
    const wallH = Number(sec.wallHeight) || 0
    const R = Number(sec.archRadius) || 0
    const tol = SECTION_TOLERANCE
    const shape = sec.shape || 'horseshoe'
    if (shape === 'circular') {
      const dy = u - R
      return Math.hypot(t, dy) > R + tol
    }
    if (shape === 'rectangular') {
      return Math.abs(t) > halfW + tol || u > wallH + (R || 0) + tol
    }
    // 马蹄形：直墙段 |t| ≤ halfW（u ≤ wallH）；拱段按拱心圆约束
    if (u <= wallH) return Math.abs(t) > halfW + tol
    const dy = u - wallH
    return Math.hypot(t, dy) > R + tol
  }

  /**
   * "上端岩壁卡石"判定：碎片是否**悬空贴在岩壁/拱壁**上（而不是正常堆料）。
   * 与"是否堆得高"无关——用"到岩壁/拱内表面的间隙 < 碎片自身半深"来判定
   * 真的贴住了壁。爆堆峰顶再高，只要底下是堆体、没贴到拱壁，就不算卡石，
   * 会继续被壳罩住（否则壳顶会被削平、出现没被包裹的顶）。仅当碎片确实
   * 贴住直线墙上部或拱内表面时才剔除，避免把壳抬/拉到拱顶。
   * @param {number} t 侧向局部坐标
   * @param {number} u 竖向高度（自底板起）
   * @param {number} su 竖向半深（AABB up 方向支撑）
   * @param {number} et 侧向半宽（AABB right 方向支撑）
   */
  _wallStuck(t, u, su, et) {
    const sec = this._section
    if (!sec) return false
    const halfW = Number(sec.width) / 2 || 0
    const wallH = Number(sec.wallHeight) || 0
    const R = Number(sec.archRadius) || 0
    const shape = sec.shape || 'horseshoe'
    const tAbs = Math.abs(t)
    // 矩形断面：只有顶板，碎片顶面触及顶板即视为贴着上壁
    if (shape === 'rectangular') {
      const ceil = wallH + (R || 0)
      if (u + su > ceil) return true
      return false
    }
    // 拱/圆形：碎片进入拱形区(u>拱心高) 且 到拱内表面的径向间隙 < su
    // ⇒ 悬空贴着拱面。中心峰顶的堆料到拱面间隙大（u+su 远小于拱高度，
    // 底落在堆体上），不会被误判。
    if (u > wallH) {
      const dy = u - wallH
      const dArch = R - Math.hypot(t, dy) // 正=在拱内，趋 0=贴到拱面
      if (dArch < su) return true
    }
    // 马蹄形直墙上端：高度接近墙顶(u>墙顶-0.6)且侧向贴到直墙外沿
    if (shape === 'horseshoe' && u > wallH - 0.6 && halfW - tAbs < et) return true
    return false
  }

  /** 开关（不加入 scene 则不渲染） */
  setEnabled(v) {
    this.enabled = !!v
    if (this.enabled) {
      if (!this._group.parent) this.scene.add(this._group)
      this._lastRebuild = -Infinity // 强制立即重建（0 在进程刚启动时仍会被节流吞掉）
      this.update()
    } else if (this._group.parent) {
      this.scene.remove(this._group)
    }
  }

  get visible() {
    return this.enabled
  }

  /**
   * 逐帧调用：按墙钟节流重建轮廓几何
   */
  update() {
    if (!this.enabled || !this.scene) return
    const now = performance.now()
    if (now - this._lastRebuild < REBUILD_INTERVAL_MS) return
    this._lastRebuild = now

    // 运行时诊断（临时，排查"外部碎石仍被包裹"）：确认断面裁剪确实在执行
    if (!this._section) {
      console.warn('[muck] 断面参数缺失 section=null：隧道外碎石将无法剔除！')
    }

    this._clearGeometries()
    this._latestAngle = null
    this._field = null

    const field = this._buildField()
    if (!field) {
      this.measure = { ...EMPTY_MEASURE }
      return
    }
    this._field = field

    this._buildCap(field)
    this._buildRepose(field)

    this.measure = {
      angle: this._latestAngle,
      height: field.apex - this._floorY,
      meanHeight: field.meanHeight,
      width: field.bOK ? field.bTmax - field.bTmin : null,
      length: field.bOK ? field.bSmax - field.bSmin : null,
      mainLength: field.bOK ? field.bSmax - field.bSmin : null,
      area: field.area,
      volume: field.volume,
      keptCount: field.keptCount,
      totalCount: field.settled,
      excludedCount: field.excluded
    }

    if (DEBUG_MUCKPILE) {
      let pileCells = 0
      for (let i = 0; i < field.mask.length; i++) if (field.mask[i]) pileCells++
      console.info(
        `[muck] settled=${field.settled} kept=${field.keptCount} faceClipped=${field.excluded} crown=${field.crownClipped} ` +
          `wallStuck=${field.wallStuck} ` +
          `span=${(field.bSmax - field.bSmin).toFixed(1)}x${(field.bTmax - field.bTmin).toFixed(1)}m ` +
          `pile=${pileCells}cells apex=${(field.apex - this._floorY).toFixed(2)}m ` +
          `grid=${field.Ns}x${field.Nt}@${field.ds.toFixed(2)}`
      )
    }
  }

  /**
   * 堆体场构建：收集 → 投影裁剪 → 加 pad 网格 → 圆盘溅射 → 去噪/分量/填洞
   * → 角点高度场（平滑 + 峰值还原 + ε 上浮）。
   * @returns {Object|null} 场对象（数据不足时 null）
   */
  _buildField() {
    const states = this._getBodyStates ? this._getBodyStates() : []
    if (!states || states.length === 0) return null

    const ax = this._forward
    const rt = this._right
    const base = this._center
    const baseS = base.x * ax.x + base.y * ax.y + base.z * ax.z
    const baseT = base.x * rt.x + base.y * rt.y + base.z * rt.z
    const faceS = Number.isFinite(this._faceOffset) ? this._faceOffset : null

    // 1) 收集停稳碎片并投影到局部坐标（掌子面裁剪同步完成）
    const pairs = []
    let settled = 0
    let excluded = 0
    let crownClipped = 0
    let wallStuck = 0
    for (let i = 0; i < states.length; i++) {
      const b = states[i]
      if (!b || !b.alive) continue
      // 只统计"已停稳"的碎片：空中高速飞行的碎片不算爆堆。
      if (!b.landed) {
        const v2 = (b.velX || 0) ** 2 + (b.velY || 0) ** 2 + (b.velZ || 0) ** 2
        if (v2 >= SLOW_SPEED2) continue
      }
      settled++
      const s = b.posX * ax.x + b.posY * ax.y + b.posZ * ax.z - baseS
      // 掌子面几何裁剪：爆堆只存在于掌子面前方（s ≤ faceS + 容差），
      // 穿模进未爆破岩体的碎片被确定性剔除；离群散石交给网格级去噪。
      if (faceS != null && s > faceS + FACE_TOLERANCE) {
        excluded++
        continue
      }
      const t = b.posX * rt.x + b.posY * rt.y + b.posZ * rt.z - baseT
      // 隧道断面裁剪：剔除"卡在隧道外壁/拱顶外"的异常碎石（与掌子面裁剪并列），
      // 避免包裹壳被隧道外的碎石撑偏。
      const u = this._floorY != null ? b.posY - this._floorY : b.posY
      if (this._outsideSection(t, u)) {
        excluded++
        continue
      }
      // 有向包围盒精确投影：用碎片四元数 + 变体半轴长算出三个轴向上的
      // 支撑半长（es 轴向 / et 侧向 / su 竖向），足迹为精确矩形、
      // 顶面 = 中心 + su——壳面紧贴碎石可见外沿，无球半径近似的空档。
      const ext = this._fragmentExtents && this._fragmentExtents[i]
      let es
      let et
      let su
      let sil = null
      if (ext) {
        const qx = b.quatX || 0
        const qy = b.quatY || 0
        const qz = b.quatZ || 0
        const qw = b.quatW == null ? 1 : b.quatW
        // 旋转矩阵三列 = 碎片局部三轴在世界坐标系中的方向
        const c1x = 1 - 2 * (qy * qy + qz * qz)
        const c1y = 2 * (qx * qy + qw * qz)
        const c1z = 2 * (qx * qz - qw * qy)
        const c2x = 2 * (qx * qy - qw * qz)
        const c2y = 1 - 2 * (qx * qx + qz * qz)
        const c2z = 2 * (qy * qz + qw * qx)
        const c3x = 2 * (qx * qz + qw * qy)
        const c3y = 2 * (qy * qz - qw * qx)
        const c3z = 1 - 2 * (qx * qx + qy * qy)
        const { hx, hy, hz } = ext
        // up=(0,1,0) 方向支撑：各局部轴 y 分量绝对值加权和
        su = hx * Math.abs(c1y) + hy * Math.abs(c2y) + hz * Math.abs(c3y)
        // right（侧向 t）方向支撑
        et =
          hx * Math.abs(c1x * rt.x + c1y * rt.y + c1z * rt.z) +
          hy * Math.abs(c2x * rt.x + c2y * rt.y + c2z * rt.z) +
          hz * Math.abs(c3x * rt.x + c3y * rt.y + c3z * rt.z)
        // forward（轴向 s）方向支撑
        es =
          hx * Math.abs(c1x * ax.x + c1y * ax.y + c1z * ax.z) +
          hy * Math.abs(c2x * ax.x + c2y * ax.y + c2z * ax.z) +
          hz * Math.abs(c3x * ax.x + c3y * ax.y + c3z * ax.z)
        // 真实投影轮廓：把几何全部顶点变换到世界并投影到 (s,t) 取凸包，
        // 作为包裹壳掩码（只覆盖石块实际可见外沿，箱角空档不再计入）。
        sil = this._projectSilhouette(
          { variant: ext.variant, size: ext.size },
          s,
          t,
          c1x,
          c1y,
          c1z,
          c2x,
          c2y,
          c2z,
          c3x,
          c3y,
          c3z,
          ax,
          rt
        )
      } else {
        const r = (b.physSize || 0.3) * 0.5
        es = r
        et = r
        su = r
      }
      // 按所在位置的断面余量截断溅射半长（中心在内、但视觉网格超出断面的
      // 超大碎块）：侧向只能到墙、高度只能到拱形净空——壳不把伸出隧道外
      // 的网格包进去，也不被它们撑高。从拱顶伸出隧道的尖角碎块整块剔除
      // 不参与建壳（见下），避免壳顶被撑到净空高度；贴墙/贴拱的碎块保留
      // 足迹（es/et/su 截到余量），最终高度由网格级断面封顶兜底，避免壳缺口。
      if (this._section) {
        const halfW = Number(this._section.width) / 2 || 0
        const tAbs = Math.abs(t)
        // 侧向余量 = 断面半宽 - 中心 |t|
        const sideRoom = halfW + SECTION_TOLERANCE - tAbs
        if (sideRoom < et) et = Math.max(0, sideRoom)
        // 高度余量 = 该侧向位置的断面净空 - 中心高度（自底板起）
        const ceil = this._sectionCeiling(t)
        if (ceil != null) {
          // 上端岩壁"卡石"剔除：碎片**确实贴上壁/拱腰/拱面**（贴壁接触）才
          // 判定为悬浮卡石并整体剔除。用"到岩壁/拱内表面的间隙 < 碎片自身
          // 半深"来判定"贴着壁"而不是"只是堆得高"——这样高的爆堆峰顶
          // （底仍落在堆面上的正常堆料）不会被误删，依然是"有棱有角"包裹；
          // 只有底悬空、贴在拱壁上的卡石才被剔除，避免把壳抬到拱顶附近。
          if (this._wallStuck(t, u, su, et)) {
            wallStuck++
            excluded++
            continue
          }
          // 拱顶外露剔除：碎块顶面（中心 + AABB 竖向支撑）越过断面净空 + 容差
          // → 整块剔除、不参与建壳。这类"尖角"碎块的可见网格从拱顶伸出隧道，
          // 若保留会把壳的高度场/峰值还原撑到净空高度——既造成壳顶明显高于
          // 碎石堆，又在拱顶留下外凸尖刺。与"卡在隧道外"的碎块同等处理。
          if (u + su > ceil + CROWN_TOL) {
            crownClipped++
            excluded++
            continue
          }
          const topRoom = Math.max(0, ceil - u)
          if (topRoom < su) su = Math.max(0.02, topRoom)
        }
      }
      pairs.push({ s, t, h: b.posY, es, et, su, hTop: b.posY + Math.max(0.02, su), sil })
    }
    // 离群散石过滤：剔除零星抛远、与主堆断裂的碎块（避免壳被拉长/撑高，
    // 产生大片无碎石的"不贴合"空档）
    const keptPairs = filterOutlierFragments(pairs)
    if (DEBUG_MUCKPILE) console.warn(`[muck] 离群过滤 ${pairs.length} -> ${keptPairs.length}`)
    if (keptPairs.length < 4) return null
    pairs.length = 0
    pairs.push(...keptPairs)

    // 2) 足迹范围与最大溅射半宽（网格 pad 用）
    let sMin = Infinity
    let sMax = -Infinity
    let tMin = Infinity
    let tMax = -Infinity
    let maxRad = 0
    for (const q of pairs) {
      if (q.s < sMin) sMin = q.s
      if (q.s > sMax) sMax = q.s
      if (q.t < tMin) tMin = q.t
      if (q.t > tMax) tMax = q.t
      const rad = Math.max(q.es, q.et)
      if (rad > maxRad) maxRad = rad
    }
    if (sMax - sMin < 0.35 || tMax - tMin < 0.35) return null

    // 3) 网格：范围外扩 pad（maxRad + 1 格），最外圈碎块的身体不再被
    //    网格边界硬切（旧版网格只框到碎片中心范围——边缘包裹缺口的根源）。
    const cell = CAP_CELL
    const pad = maxRad + cell
    const sLo = sMin - pad
    const sHi = sMax + pad
    const tLo = tMin - pad
    const tHi = tMax + pad
    const Ns = clamp(Math.ceil((sHi - sLo) / cell), 2, GRID_MAX_S)
    const Nt = clamp(Math.ceil((tHi - tLo) / cell), 2, GRID_MAX_T)
    const ds = (sHi - sLo) / Ns
    const dt = (tHi - tLo) / Nt

    // 4) 锥峰溅射（有向包围盒足迹 + 逐块碎石尖顶锥峰高度场）：足迹与高度
    //    同源、边界在碎片可见外沿；顶面随每块碎石顶出尖峰，避免平顶磨平。
    const { mask, top, count } = splatConeTops(pairs, Ns, Nt, ds, dt, sLo, tLo, this._floorY)

    // 4.5) 场级断面裁剪：侧向超出断面的格子清零、高度按断面净空封顶，
    //      保证壳被硬性约束在隧道内（贴墙堆积不再把壳挤出隧道壁）。
    this._clipFieldToSection(Ns, Nt, dt, tLo, mask, top)

    // 5) 网格级清理：单格去噪 → 保留足够大的连通分量（主堆+次级堆瓣）
    //    → 填内部空洞 → 填洞格高度单调生长
    removeNoiseCells(Ns, Nt, mask)
    keepComponents(Ns, Nt, mask)
    fillHoles(Ns, Nt, mask)
    growHeights(Ns, Nt, mask, top)

    // 6) 堆体足迹范围反推与测量（壳面已改为逐格台阶面，仅用 mask/top，
    //    不再构建平滑角点曲面）。

    // 7) 由堆体掩码反推主爆堆实际足迹范围（测量值用）
    let bSmin = Infinity
    let bSmax = -Infinity
    let bTmin = Infinity
    let bTmax = -Infinity
    let bAny = false
    let tCent = 0
    let tCentW = 0
    const cellArea = ds * dt
    let pileCells = 0
    let area = 0
    let volume = 0
    let hSum = 0
    for (let i = 0; i < Ns; i++) {
      for (let j = 0; j < Nt; j++) {
        const idx = i * Nt + j
        if (!mask[idx]) continue
        bAny = true
        const ss = sLo + (i + 0.5) * ds
        const tt = tLo + (j + 0.5) * dt
        if (ss < bSmin) bSmin = ss
        if (ss > bSmax) bSmax = ss
        if (tt < bTmin) bTmin = tt
        if (tt > bTmax) bTmax = tt
        tCent += tt * count[idx]
        tCentW += count[idx]
        // 足迹面积 / 堆体体积（以格高近似）/ 平均堆高
        if (Number.isFinite(top[idx])) {
          pileCells++
          area += cellArea
          const h = top[idx] - this._floorY
          if (h > 0) {
            volume += h * cellArea
            hSum += h
          }
        }
      }
    }
    const bOK = bAny && bSmax - bSmin > 0.5 && bTmax - bTmin > 0.5
    const tCentFinal = tCentW > 0 ? tCent / tCentW : (bTmin + bTmax) / 2

    let apex = this._floorY
    for (let k = 0; k < top.length; k++) {
      if (mask[k] && top[k] > apex) apex = top[k]
    }

    return {
      Ns,
      Nt,
      ds,
      dt,
      sLo,
      tLo,
      mask,
      top,
      count,
      apex,
      bSmin,
      bSmax,
      bTmin,
      bTmax,
      bOK,
      tCent: tCentFinal,
      area,
      volume,
      meanHeight: pileCells > 0 ? hSum / pileCells : 0,
      settled,
      keptCount: pairs.length,
      excluded,
      crownClipped,
      wallStuck
    }
  }

  /** 由局部 (s,t,h) 转世界坐标：center + forward*s + right*t + up*(h-floorY) */
  _worldPoint(s, t, y) {
    return new THREE.Vector3(
      this._center.x + this._forward.x * s + this._right.x * t + this._up.x * (y - this._floorY),
      this._center.y + this._forward.y * s + this._right.y * t + this._up.y * (y - this._floorY),
      this._center.z + this._forward.z * s + this._right.z * t + this._up.z * (y - this._floorY)
    )
  }

  /**
   * 顶面"糖衣"包裹壳（逐格台阶棱角面，取代平滑双线性曲面）。
   *
   * 每个堆体格 = 一块水平顶面（高度 = 该格碎块顶高 top）+ 四向侧壁：
   *   - 邻格更低或为空 → 沿该边做竖直面收到邻格顶（或底板）——形成台阶棱角；
   *   - 邻格同高或更高 → 由更高格兜边，本格不再画（避免重叠面/裂缝）。
   * 结果：顶面随每格真实顶高逐格升降，呈现与碎石一致的棱角起伏（有棱有角），
   * 而不是被平滑成一块平平的曲面；且每个占用格都有一张顶面，爆堆内容
   * 完整包裹，不再出现平滑壳悬浮导致的"没被包裹"观感。
   */
  _buildCap(field) {
    const { Ns, Nt, ds, dt, sLo, tLo, mask, top } = field
    const floorY = this._floorY
    const hRange = Math.max(0.15, field.apex - floorY)
    const ramp = y => rampColor(Math.sqrt(Math.max(0, (y - floorY) / hRange)))

    const pos = []
    const col = []
    const idxArr = []
    const vertOf = (s, t, y) => {
      const iv = pos.length / 3
      const c = ramp(y)
      const p = this._worldPoint(s, t, y)
      pos.push(p.x, p.y, p.z)
      col.push(c.r, c.g, c.b)
      return iv
    }
    const quad = (a, b, c, d) => idxArr.push(a, b, c, a, c, d)
    const inBulk = (i, j) => i >= 0 && j >= 0 && i < Ns && j < Nt && !!mask[i * Nt + j]
    const hOf = (i, j) => {
      if (i < 0 || j < 0 || i >= Ns || j >= Nt) return floorY
      const h = top[i * Nt + j]
      return Number.isFinite(h) ? h : floorY
    }

    for (let i = 0; i < Ns; i++) {
      const s0 = sLo + i * ds
      const s1 = s0 + ds
      for (let j = 0; j < Nt; j++) {
        if (!inBulk(i, j)) continue
        const h = hOf(i, j)
        const t0 = tLo + j * dt
        const t1 = t0 + dt
        // 顶面：四角点同高 = 该格碎块顶高（碎块级平顶棱角）
        const a = vertOf(s0, t0, h)
        const b = vertOf(s1, t0, h)
        const c = vertOf(s1, t1, h)
        const d = vertOf(s0, t1, h)
        quad(a, b, c, a, c, d)
        // 侧壁：邻格更低或为空 → 收一阶（收到邻格顶或底板）
        const edges = [
          [hOf(i, j - 1), s0, t0, s1, t0],
          [hOf(i, j + 1), s0, t1, s1, t1],
          [hOf(i - 1, j), s0, t0, s0, t1],
          [hOf(i + 1, j), s1, t0, s1, t1]
        ]
        for (const [hn, px0, pt0, px1, pt1] of edges) {
          // 落差 < WALL_TOL 的微台阶不画墙（平顶阶直接相邻，避免面片爆炸）
          if (h - hn < WALL_TOL) continue
          const yBot = Math.max(floorY, hn)
          const w0 = vertOf(px0, pt0, h)
          const w1 = vertOf(px1, pt1, h)
          const w2 = vertOf(px1, pt1, yBot)
          const w3 = vertOf(px0, pt0, yBot)
          quad(w0, w1, w2, w0, w2, w3)
        }
      }
    }
    if (idxArr.length === 0) return

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
    geo.setIndex(idxArr)
    this._trackGeometry(geo)

    // 釉面材质：MeshBasicMaterial（自发光、不受隧道灯光影响），顶点色带
    // 直接作为最终颜色输出，半透明包裹始终呈现清晰的冷暖高度色带。
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: CAP_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = 8
    this._group.add(mesh)
  }

  /**
   * 安息角：沿轴向剖面（每柱最高点）拟合最陡坡面。
   * 仅计算并缓存 `_latestAngle` 供 UI 面板回读，不再在 3D 模型内画任何标注。
   */
  _buildRepose(field) {
    const { Ns, Nt, ds, mask, top } = field
    const floorY = this._floorY
    // 轴向剖面（柱最高点，仅统计堆体内的格），同时记录峰顶所在列的侧向位置
    const colTop = new Float32Array(Ns).fill(-Infinity)
    const colTopJ = new Int32Array(Ns).fill(-1)
    for (let i = 0; i < Ns; i++) {
      for (let j = 0; j < Nt; j++) {
        const idx = i * Nt + j
        if (!mask[idx]) continue
        if (top[idx] > colTop[i]) {
          colTop[i] = top[idx]
          colTopJ[i] = j
        }
      }
    }
    // 峰值（峰顶）
    let apexI = -1
    let apexH = -Infinity
    for (let i = 0; i < Ns; i++) {
      if (colTop[i] > apexH) {
        apexH = colTop[i]
        apexI = i
      }
    }
    if (apexI < 0 || !Number.isFinite(apexH) || apexH - floorY < 0.3) return

    // 安息角取经典定义：峰顶 → 坡脚连线的倾角。坡脚 = 沿该方向列顶高
    // 未跌破 15% 峰高的最后一列（忽略远端散石的拖尾）。旧版"中段线性
    // 回归"会被形状余量在坡脚处的相对抬高拉平，系统性低估坡角。
    const toeThr = floorY + (apexH - floorY) * 0.15
    const findToe = dirSign => {
      let toeI = apexI
      for (let i = apexI + dirSign; i >= 0 && i < Ns; i += dirSign) {
        const h = colTop[i]
        if (!Number.isFinite(h)) break
        if (h < toeThr) break
        toeI = i
      }
      return toeI
    }
    const mkFlank = (toeI, dirSign) => {
      const horiz = Math.abs(toeI - apexI) * ds
      const toeH = colTop[toeI]
      if (horiz < 0.8 || apexH - toeH < 0.3) return null
      return {
        toeI,
        dirSign,
        horiz,
        toeH,
        deg: (Math.atan((apexH - toeH) / horiz) * 180) / Math.PI
      }
    }
    // 贴掌子面(+s)一侧是堆体抵住岩壁的非自然坡，仅在自由侧(-s)退化时采用。
    const freeSide = mkFlank(findToe(-1), -1)
    const faceSide = mkFlank(findToe(1), 1)
    const chosen = freeSide || faceSide
    if (!chosen) return
    const angle = clamp(chosen.deg, ANGLE_MIN, ANGLE_MAX)
    this._latestAngle = Math.round(angle * 10) / 10
  }

  _trackGeometry(geo) {
    this._geometries.push(geo)
  }

  /** 释放所有几何，清空 group */
  _clearGeometries() {
    while (this._group.children.length) {
      const child = this._group.children.pop()
      child.geometry?.dispose?.()
      child.material?.dispose?.()
    }
    this._geometries = []
  }

  /** 隐藏并清空（不改变 enabled 状态） */
  clear() {
    this._clearGeometries()
    this._latestAngle = null
    this.measure = { ...EMPTY_MEASURE }
  }
}
