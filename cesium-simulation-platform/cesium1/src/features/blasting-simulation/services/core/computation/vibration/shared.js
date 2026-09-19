/**
 * 振动场共享常量与底层工具（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * 内容：萨道夫斯基公式与回退默认值、近场几何修正、损伤分区阈值、径向能量包络、
 * 自由面反射（镜象源法）展开、隧道马蹄形轮廓放大、距离场/矢量累加/错峰峰值缓存。
 * 供 ppvField / damage / timeHistory / surfaceField / simulator 子模块 import；
 * 下划线前缀符号为子模块间内部接口，不进入 localVibrationSimulator.js 聚合出口。
 */

// 萨道夫斯基 K/α 默认值：单源在 vibrationDefaults.js
// （本文件位于 vibration/ 子目录，相对路径较拆分前的 '../vibrationDefaults.js' 加深一级，
//  解析结果与拆分前为同一文件）
import { LOCAL_SIM_DEFAULT_K, LOCAL_SIM_DEFAULT_ALPHA } from '../../vibrationDefaults.js'

export { LOCAL_SIM_DEFAULT_K, LOCAL_SIM_DEFAULT_ALPHA }

// 损伤分区阈值（Persson 模型，近场损伤临界值，单位：cm/s）
// 与后端 DAMAGE_THRESHOLDS_CMPS 完全一致（P0-1 已提高至 (20,50,100,200)，
// 使损伤区收束到爆源邻近数米，避免解析场下出现"无视隧道轮廓的无边红圆/黄块"）
export const DAMAGE_THRESHOLDS_CMPS = [20.0, 50.0, 100.0, 200.0]

// ─── 径向能量包络（与后端 blast_physics.py 同口径） ─────────
// 后端 ppv_field_3d_multi / peak_ppv_envelope_multi 施加 env(r)（BLAST_INFLUENCE_
// RADIUS/TAU）。损伤半径完全由 PPV 阈值纯物理计算，不施加人工 atten 上限。
// 本地模拟器（暂停/推流结束后接管热力图的数据源）必须施加同一空间门控，
// 否则同一时刻 WS 推流帧与本地帧的场值/分区不一致——拖动进度条时两数据源交替
// 写纹理，表现为"Seek 后热力图跳变/损伤区错位"。r 取到最近**真实**装药源的
// 距离（不含镜象反射源，与后端 dmin 口径一致）。未传参（0/null）时门控关闭。
const INFLUENCE_ENVELOPE_TAU = 3.0

// ─── 近场几何修正（区分"应力场"与"振速场"的空间结构）─────────────
// 弹性球面波在近场尚未充分发散：空腔膨胀的准静态应力场（σ ∝ r^-3）与几何
// 修正（波幅 ∝ r^-2）只在中远场才过渡为纯辐射项（σ = ρ·c_p·v）。
// 若应力直接取 σ = ρ·c_p·v/(1−ν)，它与瞬时振速场只差一个常数——归一化后
// 逐点相等，再配上同一张 Viridis 色阶，两模式必然是同一张图（用户实测
// "震速的图和应力的图一模一样"的根因）。
// 此处给辐射项叠加一阶等效的近场几何放大：
//     F(r) = 1 + NEAR_FIELD_GAIN · (r_nf / r)²
// 交叉半径 r_nf = NEAR_FIELD_MULT × 装药空腔半径 r_b（由装药体积反算）。
// 【幅值必须温和】近场项只允许在 1~2 m 内起作用（r_nf 取 2×r_b ≈ 0.5 m）：
// 若 r_nf 取到 1.5 m、GAIN 取 2，F(0.5m)=19，中心应力被抬高 19 倍 →
// 相对满量程深饱和，整图糊成"巨大黄色高斯云"（用户实测反馈）。
// 说明：弹性解在近场塑性区失效，本项按一阶几何等效给定，仅用于表达
// "应力比振速更集中于爆源"的空间结构，不作工程定量结论。
// 与后端 blast_physics.py 的 NEAR_FIELD_MULT / NEAR_FIELD_GAIN 跨语言镜像。
export const NEAR_FIELD_MULT = 2.0
export const NEAR_FIELD_GAIN = 2.0
const EXPLOSIVE_DENSITY_DEFAULT = 1250.0 // kg/m³（乳化炸药量级）

/** 装药空腔半径(m)：V = m/ρ_e，r_b = (3V/4π)^(1/3) */
export function cavityRadius(chargeKg, rhoExplosive = EXPLOSIVE_DENSITY_DEFAULT) {
  const m = Math.max(0, Number(chargeKg) || 0)
  const rhoE = Number(rhoExplosive) > 0 ? Number(rhoExplosive) : EXPLOSIVE_DENSITY_DEFAULT
  const v = m / rhoE
  return v > 0 ? Math.cbrt((3 * v) / (4 * Math.PI)) : 0
}

/** 近场交叉半径(m)：r_nf = NEAR_FIELD_MULT × r_b，钳制到 [0.5, 4] m（工程尺度） */
export function nearFieldRadius(chargeKg, rhoExplosive = EXPLOSIVE_DENSITY_DEFAULT) {
  const rb = cavityRadius(chargeKg, rhoExplosive)
  if (!(rb > 0)) return 0
  return Math.min(4, Math.max(0.5, NEAR_FIELD_MULT * rb))
}

/** 近场几何放大因子 F(r) = 1 + gain·(r_nf/r)²；r_nf<=0 或 r<=0 时退化为 1 */
export function nearFieldGain(r, rnf, gain = NEAR_FIELD_GAIN) {
  const R = Number(r)
  const Rnf = Number(rnf)
  if (!(Rnf > 0) || !(R > 0)) return 1
  const k = Rnf / R
  const g = Number(gain) > 0 ? Number(gain) : 0
  return 1 + g * k * k
}

// ─── 损伤范围理论（粉碎区/裂隙区半径，与后端 damage_zone_radius 跨语言镜像）──
// 依据：宗琦《岩石内爆炸应力波破裂区半径的计算》爆破 1994；梁瑞等 长江科学院院报
// 2020, 37(4):67-72（粉碎区衰减 δ=3、裂隙区 δ=2−μ_d/(1−μ_d)，μ_d=0.8μ）；刘步青
// 学位论文（孔间岩桥叠加增强）。孔壁初始压力（耦合装药波阻抗透射）：
//   P_cJ = ρ_e·D²/(γ+1) = ρ_e·D²/4；P_b = 2·Z_r/(Z_r+Z_e)·P_cJ·(d_c/d_b)^(2γ)
// 粉碎区 r_c = r_b·(P_b/σ_cd)^(1/3)；裂隙区 r_t = r_c·(b·σ_cd/σ_td)^(1/(2−b))。
// 文献量级：裂隙区约 10~20 倍装药半径（42mm 孔 ≈0.16m、250mm 孔 ≈0.9m）。
export const DETONATION_GAMMA = 3.0
export const ROCK_SIGMA_CD_DEFAULT = 100e6 // Pa 动态抗压（中硬岩量级）
export const ROCK_SIGMA_TD_DEFAULT = 10e6 // Pa 动态抗拉（≈抗压 1/10）
export const BOREHOLE_RADIUS_DEFAULT = 0.021 // m（Φ42mm 隧道炮孔）

/**
 * 损伤范围理论：由爆岩参数推算粉碎区/裂隙区半径（与后端同口径）
 * @param {Object} [o] - { rhoExplosive=1200, vod=4500, boreholeRadius=0.021,
 *   chargeDiameter=null(耦合), rhoRock=2650, cp=4500, nu=0.25,
 *   sigmaCd=100e6, sigmaTd=10e6 }
 * @returns {{wallPressure:number, crushRadius:number, crackRadius:number,
 *            b:number, decayCrack:number}}（SI 单位）
 */
export function damageZoneRadius(o = {}) {
  const rhoE = Number(o.rhoExplosive) > 0 ? Number(o.rhoExplosive) : 1200
  const vod = Number(o.vod) > 0 ? Number(o.vod) : 4500
  const rb = Number(o.boreholeRadius) > 0 ? Number(o.boreholeRadius) : BOREHOLE_RADIUS_DEFAULT
  const rhoR = Number(o.rhoRock) > 0 ? Number(o.rhoRock) : 2650
  const cp = Number(o.cp) > 0 ? Number(o.cp) : 4500
  const nu = Number(o.nu) > 0 ? Number(o.nu) : 0.25
  const sigmaCd = Math.max(Number(o.sigmaCd) || ROCK_SIGMA_CD_DEFAULT, 1e5)
  const sigmaTd = Math.max(Number(o.sigmaTd) || ROCK_SIGMA_TD_DEFAULT, 1e4)
  const pCj = (rhoE * vod * vod) / (DETONATION_GAMMA + 1.0)
  const zr = rhoR * cp
  const ze = rhoE * vod
  let pb = ((2 * zr) / (zr + ze)) * pCj
  const dc = Number(o.chargeDiameter)
  if (Number.isFinite(dc) && dc > 0) {
    pb *= Math.min(1.0, dc / (2 * rb)) ** (2 * DETONATION_GAMMA)
  }
  const muD = 0.8 * nu
  const b = muD / (1 - muD)
  const rCrush = rb * Math.cbrt(pb / sigmaCd)
  const decayCrack = 2.0 - b
  const rCrack = rCrush * Math.pow((b * sigmaCd) / sigmaTd, 1.0 / decayCrack)
  return { wallPressure: pb, crushRadius: rCrush, crackRadius: rCrack, b, decayCrack }
}

export function _radialEnv(distance, radius) {
  if (!(radius > 0)) return 1
  const tau = INFLUENCE_ENVELOPE_TAU
  const e = (radius + tau - distance) / tau
  return e < 0 ? 0 : e > 1 ? 1 : e
}

/**
 * 逐点到指定距离表列（列索引数组）的最小距离。门控 env 的 r 与后端
 * dmin 同口径：只统计**真实装药源**（直达）列，不含镜象反射源。
 * 峰值槽的源按延时升序排序后，直达/反射列在表中交错 → 由调用方传列索引。
 */
export function _dminFromDistColumns(distTable, colIdx, nPoints) {
  if (!colIdx || colIdx.length === 0) return null
  const dmin = new Float32Array(nPoints).fill(Infinity)
  for (let k = 0; k < colIdx.length; k++) {
    const base = colIdx[k] * nPoints
    for (let i = 0; i < nPoints; i++) {
      const r = distTable[base + i]
      if (r < dmin[i]) dmin[i] = r
    }
  }
  return dmin
}

/**
 * 逐点到前 nDirect 个条目（真实装药源；expandSourcesWithReflections 先出直达后出
 * 反射，distTable 前 nDirect 条恰为真实源）的最小距离。门控 env/atten 的 r 与后端
 * dmin 同口径：不含镜象反射源。
 */
export function _dminFromDistTable(distTable, nDirect, nPoints) {
  if (nDirect <= 0) return null
  const dmin = new Float32Array(nPoints).fill(Infinity)
  for (let s = 0; s < nDirect; s++) {
    const base = s * nPoints
    for (let i = 0; i < nPoints; i++) {
      const r = distTable[base + i]
      if (r < dmin[i]) dmin[i] = r
    }
  }
  return dmin
}

// ─── 自由面反射（镜象源法）：让掌子面/隧道临空面真正参与波场计算 ─────────────
// 真实爆破中掌子面与隧道内壁是自由面（应力为零，压力释放边界），应力波入射
// 发生近全反射，对应拉伸波：自由面处法向质点速度加倍（**负号镜像**——镜像贡献
// 方向取"指向镜像点"，见 expandSourcesWithReflections）→ 靠近轮廓处振速场
// 出现"局部放大 + 直达波/反射波干涉条纹"，这正是用户要求的"隧道轮廓不能只是
// 视觉贴图，必须能反射波场"。反射波路径 = 接收点至镜像源距离，且仅在自由面
// 岩体一侧（z ≥ 掌子面）有效。物理口径与 GPU 着色器（sceneBuilder uReflectOn/
// uFaceZ/uReflectCoeff）完全一致。
//
// CPU 体网格反射项源数上限：体网格点 × 源 的矢量叠加需要缓存距离表，反射项
// 每个源多占一份 (dist, distPow) 列（≤8B/点）。43 孔昆阳 16 个反射源 =
// 16×294912×8B ≈ 37.7MB，可接受；更强的反射贡献来自药量最大的掏槽/底板/辅助孔，
// 16 已覆盖近掌子面干涉主形态（surface/monitor 路径不设上限，取全部源）。
export const _REFL_MAX_SOURCES = 16

/** 反射面配置归一：[{ axis:'z', value:掌子面z(m), coeff:反射系数(0~1) }] */
export function normalizeReflections(refl) {
  if (!Array.isArray(refl)) return []
  return refl
    .filter(r => r && Number.isFinite(r.value) && Number(r.coeff) > 0.001)
    .map(r => ({
      axis: (String(r.axis || 'z') || 'z').toLowerCase(),
      value: Number(r.value),
      coeff: Math.max(0, Math.min(1, Number(r.coeff) || 0.85))
    }))
}

export const _GATE_AXIS = { x: 0, y: 1, z: 2 }

// —— 隧道马蹄形轮廓自由面（SDF 放大，与 GPU tunnelFaceSdf 同口径）——
// 直墙+拱顶轮廓是自由面（应力为零）：波反射使轮廓附近法向振速放大、出现畸变。
// 距轮廓 d≈0 处乘 (1 + coeff·exp(-d/λ))；face=null/coeff=0 返回 1（不改动数值）。
export function tunnelFaceBoostFactor(p3, face) {
  if (!face) return 1
  const coeff = Number(face.coeff)
  if (!(coeff > 0.001)) return 1
  const lambda = Number(face.lambda) > 0.05 ? Number(face.lambda) : 1.2
  const halfW = Math.max(0.5, Number(face.halfW) || 4.5)
  const yFloor = Number(face.floorY) || 0
  const archH = Math.max(0.5, Number(face.archH) || 6)
  const archC = yFloor + archH
  const x = p3[0]
  const y = p3[1]
  const dx = Math.abs(x) - halfW
  const wall = Math.max(dx, 0)
  const vlowV = yFloor - y
  const vhighV = y - archC
  const wallV = Math.max(wall, vhighV > 0 ? vhighV : vlowV)
  const arc = Math.hypot(Math.abs(x), y - archC) - halfW
  const d = Math.min(wallV, arc)
  return 1 + coeff * Math.exp(-Math.max(d, 0) / lambda)
}

/**
 * 把"源列表 + 自由面反射配置"展开为最终参与叠加的条目列表。
 * 每条 { x,y,z,chargeKg,delay,coef, gate:{axis,min}|null }（delay 已转秒）。
 *  - 直达条目：gate=null（恒参与）；
 *  - 反射条目：源在自由面岩体一侧（axis ≥ value）时生成，gate = {axis, min:value}
 *    —— 接收点坐标不满足 gate（在自由面空腔一侧）时该项跳过，模拟反射波仅存在于岩体。
 *  - maxReflSources>0 时仅对"药量最大的前 N 个源"生成反射（控体网格内存），
 *    0/缺省 = 全部源生成反射（surface/monitor 路径用）。
 * @param {Array} entries - [{x,y,z,chargeKg,delay,coef}]（已 resolve 的源，delay 秒）
 * @param {Array} [reflections] - 反射面配置（normalizeReflections 输出）
 * @param {number} [maxReflSources=0] - 反射源数上限
 * @returns {Array} 展开后条目（含 gate）
 */
export function expandSourcesWithReflections(entries, reflections, maxReflSources = 0) {
  // 空源判定兼容两种条目口径：{chargeKg,...}（原始源）与 {coef,...}
  // （computeMonitorTimeHistory/computePointVector 已折算幅值、不含 chargeKg
  // —— 只按 chargeKg 过滤会把它们整批丢掉，测点时程/矢量箭头场恒为零）
  const src = (entries || []).filter(s => Number(s.chargeKg) > 0 || Number(s.coef) > 0)
  const out = src.map(s => ({ ...s, gate: null }))
  const planes = normalizeReflections(reflections)
  if (!planes.length || src.length === 0) return out

  let reflSrc = src
  if (maxReflSources > 0 && src.length > maxReflSources) {
    reflSrc = src
      .slice()
      .sort((a, b) => Number(b.chargeKg) - Number(a.chargeKg) || 0)
      .slice(0, maxReflSources)
  }
  for (const pl of planes) {
    const ax = _GATE_AXIS[pl.axis]
    if (ax == null) continue
    for (const s of reflSrc) {
      const sv = _axisVal(s, ax)
      if (sv <= pl.value) continue // 源不在岩体侧，无反射
      const img = { ...s }
      img[pl.axis] = 2 * pl.value - sv // 沿自由面镜像
      // 自由面（压力释放边界）用**负号镜像**：径向核的镜像贡献方向取"指向镜像点"
      // （幅值取负等效），使自由面上法向质点速度与直达波同向叠加而**加倍**——
      // 与单源标量路径（v_direct + v_refl）及物理口径一致。同号正镜像对应
      // 刚性边界（法向振速在面上归零），与本处注释声称的"法向振速加倍"相反。
      // 幅值幅值损耗 |coeff|<1；萨道夫斯基幅值 ∝ q^(α/3)，须乘在幅值系数 coef
      // 上而非药量上（与 GPU ampI×uReflectCoeff / 后端 amp_scale 同口径）。
      if (Number.isFinite(Number(s.coef))) img.coef = -Number(s.coef) * pl.coeff
      img.gate = { axis: pl.axis, min: pl.value }
      out.push(img)
    }
  }
  return out
}

function _axisVal(e, ax) {
  return ax === 0 ? e.x : ax === 1 ? e.y : e.z
}

/** src 条目的距离-指纹（反射 gate 也纳入指纹：反射配置变化→距离缓存自动失效） */
function _entryFingerprint(src) {
  let fp = ''
  for (let s = 0; s < src.length; s++) {
    fp +=
      src[s].x.toFixed(3) +
      ',' +
      src[s].y.toFixed(3) +
      ',' +
      src[s].z.toFixed(3) +
      ',' +
      src[s].chargeKg.toFixed(2) +
      ',' +
      src[s].delay.toFixed(4) +
      ',' +
      (src[s].gate ? src[s].gate.axis + src[s].gate.min.toFixed(3) : '-') +
      ';'
  }
  return fp
}

/**
 * 萨道夫斯基经验公式计算 PPV（质点峰值速度，单位 m/s）
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} distance - 采样点到爆心距离(m)
 * @param {Object} options - { K: 场地常数, alpha: 衰减指数, minStandoff: 最小距离下限 }
 * @returns {number} PPV (m/s)
 */
export function sadoskyPpv(chargeKg, distance, options = {}) {
  const K = options.K ?? 200.0
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
  const minStandoff = options.minStandoff ?? 0.5
  const r = Math.max(distance, minStandoff)
  // K 单位为 cm/s → 转换为 m/s 需要 ×0.01
  return K * Math.pow(chargeKg ** (1 / 3) / r, alpha) * 0.01
}

/** 载波子波品质因数：包络每周期衰减 e^(-π/Q)（与 GPU waveletOsc 同口径）。
 *  Q=4 → 每周期 e^-0.785≈0.46，4 个周期后 <5%：子波脉冲短、各源的"波前环"彼此
 *  分明，叠加出的相长/相消花瓣比长振荡更容易在色带上读出来（Q=10 时各源长达
 *  10 个周期的波列互相糊在一起，视觉上退化成同心圆）。 */
export const WAVELET_Q = 4

// ─── 距离场预计算缓存（按点集引用多槽 + LRU） ───
// 网格点与热源几何在 LocalVibrationSimulator 生命周期内固定，因此 (点,源) 的距离 r
// 与模拟时刻 t 无关。多源场在每次（0.2s）全量重算时需跑 nS×nPts 次的 sqrt + exp，
// 其中 sqrt 距离每次都在重复计算。这里按 (点集引用 + 源指纹 + minStandoff +
// visualCp + alpha) 只算一次并缓存，之后各时刻重算用查表替换 sqrt。
// 【多槽化】体网格（0.2s 全量重算）与岩面顶点集（等值线峰值场一次性计算）两套
// 点集共存：单槽缓存会被两遍互相踩踏、每步全量重建。改为 Map<点集引用, 槽>，
// 每槽独立持有 (fp, dist, distPow)，Map 的插入序天然作 LRU（命中即重插到尾部），
// 超过 _DIST_CACHE_MAX_SLOTS 时淘汰最旧槽。
const _DIST_CACHE_MAX_SLOTS = 4
const _distCacheMap = new Map()
function _distFingerprint(src, minStandoff, visualCp, alpha) {
  // 条目指纹已含位置/药量/延期与反射 gate（见 _entryFingerprint）
  return (
    _entryFingerprint(src) +
    '|' +
    minStandoff +
    '|' +
    visualCp +
    '|' +
    Number(alpha).toFixed(4) +
    '|'
  )
}
export function _getDistCache(gridXyz, src, minStandoff, visualCp, alpha = 1.5) {
  const fp = _distFingerprint(src, minStandoff, visualCp, alpha)
  let slot = _distCacheMap.get(gridXyz)
  if (slot && slot.fp === fp && slot.dist) {
    // LRU：命中即移到尾部（最新）
    _distCacheMap.delete(gridXyz)
    _distCacheMap.set(gridXyz, slot)
    return slot
  }
  const nPts = gridXyz.length / 3
  const nS = src.length
  const dist = new Float32Array(nS * nPts)
  const distPow = new Float32Array(nS * nPts)
  const negAlpha = -alpha
  for (let s = 0; s < nS; s++) {
    const sx = src[s].x
    const sy = src[s].y
    const sz = src[s].z
    const base = s * nPts
    for (let i = 0; i < nPts; i++) {
      const dx = gridXyz[i * 3] - sx
      const dy = gridXyz[i * 3 + 1] - sy
      const dz = gridXyz[i * 3 + 2] - sz
      const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
      dist[base + i] = r
      distPow[base + i] = Math.pow(r, negAlpha)
    }
  }
  if (!slot) {
    // 新点集入槽：超上限淘汰最旧（Map 首个 key）
    if (_distCacheMap.size >= _DIST_CACHE_MAX_SLOTS) {
      const oldest = _distCacheMap.keys().next().value
      _distCacheMap.delete(oldest)
    }
  }
  slot = { grid: gridXyz, fp, dist, distPow }
  _distCacheMap.set(gridXyz, slot)
  return slot
}

// 源外/点内循环序所需的逐点矢量累加缓冲（模块级单槽复用，同步调用无重入）
const _accBuffers = { n: 0, cx: null, cy: null, cz: null, sx: null, sy: null, sz: null }
export function _ensureAccBuffers(n) {
  if (_accBuffers.n !== n || !_accBuffers.cx) {
    _accBuffers.n = n
    // 双分量（同相 cos / 正交 sin）× 三分量方向：模长取平方和 → 恒正无周期零点
    _accBuffers.cx = new Float32Array(n)
    _accBuffers.cy = new Float32Array(n)
    _accBuffers.cz = new Float32Array(n)
    _accBuffers.sx = new Float32Array(n)
    _accBuffers.sy = new Float32Array(n)
    _accBuffers.sz = new Float32Array(n)
  }
  return _accBuffers
}

// 时域错峰叠加峰值的"逐点到达序"精确累加（内部共享：_ensurePeakSlot 与
// computeSurfacePeakField）。
//
// 模型：每源波形为到达后指数衰减包络 A·e^(−D·τ)（无载波），点 p 总速度
//   V(p,t) = Σ_{arr_s(p)≤t} A_s·e^(−D·(t−arr_s(p)))·û_s，arr_s(p)=delay_s+r_s/c̄
// 两个到达时刻之间 V 单调衰减 → 局部极大只出现在到达时刻，故
//   peak(p) = max_k e^(−D·arr_k)·|Σ_{j≤k} A_j·e^(+D·arr_j)·û_j|
// 其中求和按**该点自身的到达序**。不能按全局延时序累加：visualCp 模式下路径
// 时差（r/c̄ 可达 ~1s）会压倒延期差（0~0.2s），到达序与延时序大面积颠倒，
// 延时序累加把尚未到达的源以 e^(+D·Δarr)>1 的放大权重提前计入 → 峰值系统性
// 偏高（既非精确也非保守上界）。物理波速（4500 m/s）下两序几乎一致，本实现
// 在两种情况下都给出精确解。
//
// 实现：逐点收集活跃（过 gate）源的 (arr, w=A·e^(min(D·arr,20)), û)，插入排序
// 按 arr 升序（复用上一点排序结果暖启动——网格邻点到达序变化极小，近似线性），
// 顺序累加 B 并逐到达时刻评估候选取最大。指数钳制 e^(D·arr)≤e^20 防 float 溢出。
// gate 未过的 (源,点) 不参与候选与 arrival。逐源循环读 distTable 列（源主序）。
//
// @param {Float32Array} gridXyz 点集 (N×3)
// @param {Array} src 展开后源条目 [{x,y,z,delay,coef,gate}]（次序不限）
// @param {Float32Array} distTable/distPow _getDistCache 输出（源主序 nS×N）
// @param {number} nPoints 点数 N
// @param {number} peakDecay 到达后时变衰减率 D=beta+visualBeta (1/s)
// @param {number} invCp 1/visualCp
// @param {Float32Array} arrival 输出：最早到达时刻（s，gate 未过源不参与）
// @param {Float32Array} [peakOut] 输出复用缓冲
// @returns {Float32Array} peak（m/s，未乘任何整形因子）
export function _staggeredPeakAccumulate(
  gridXyz,
  src,
  distTable,
  distPow,
  nPoints,
  peakDecay,
  invCp,
  arrival,
  peakOut = null
) {
  const nS = src.length
  const peak = peakOut ?? new Float32Array(nPoints)
  if (nS === 0) return peak
  const delayOf = new Float64Array(nS)
  const coefOf = new Float64Array(nS)
  const gAxis = new Int8Array(nS)
  const gMin = new Float64Array(nS)
  for (let s = 0; s < nS; s++) {
    const e = src[s]
    delayOf[s] = e.delay
    coefOf[s] = e.coef
    if (e.gate) {
      gAxis[s] = _GATE_AXIS[e.gate.axis]
      gMin[s] = e.gate.min
    } else {
      gAxis[s] = -1
    }
  }
  const EXP_CLAMP = Math.exp(20.0)
  // 可复用逐点缓冲（槽位 = 源序）
  const keyBuf = new Float64Array(nS)
  const wBuf = new Float64Array(nS)
  const uxBuf = new Float64Array(nS)
  const uyBuf = new Float64Array(nS)
  const uzBuf = new Float64Array(nS)
  const idxBuf = new Uint32Array(nS)
  let prevM = -1
  for (let i = 0; i < nPoints; i++) {
    const gx = gridXyz[i * 3]
    const gy = gridXyz[i * 3 + 1]
    const gz = gridXyz[i * 3 + 2]
    let m = 0
    let arrMin = Infinity
    for (let s = 0; s < nS; s++) {
      if (gAxis[s] >= 0 && (gAxis[s] === 0 ? gx : gAxis[s] === 1 ? gy : gz) < gMin[s]) continue
      const r = distTable[s * nPoints + i]
      const arr = delayOf[s] + r * invCp
      if (arr < arrMin) arrMin = arr
      keyBuf[m] = arr
      const dCl = peakDecay * arr
      wBuf[m] = coefOf[s] * distPow[s * nPoints + i] * (dCl > 20 ? EXP_CLAMP : Math.exp(dCl))
      const inv = 1 / (r > 1e-6 ? r : 1e-6)
      uxBuf[m] = (gx - src[s].x) * inv
      uyBuf[m] = (gy - src[s].y) * inv
      uzBuf[m] = (gz - src[s].z) * inv
      m++
    }
    arrival[i] = arrMin
    if (m === 0) continue
    if (m === 1) {
      peak[i] = wBuf[0] * Math.exp(-peakDecay * keyBuf[0])
      prevM = m
      continue
    }
    // idxBuf 须为 [0,m) 的排列：点间活跃集不变时沿用上一点次序（暖启动），
    // 活跃集变大则补尾部、变小则重建
    if (prevM !== m) {
      if (prevM < m && prevM > 0) {
        for (let k = prevM; k < m; k++) idxBuf[k] = k
      } else {
        for (let k = 0; k < m; k++) idxBuf[k] = k
      }
      prevM = m
    }
    // 插入排序（近有序输入近似 O(m)）
    for (let a = 1; a < m; a++) {
      const iA = idxBuf[a]
      const kA = keyBuf[iA]
      let b = a - 1
      while (b >= 0 && keyBuf[idxBuf[b]] > kA) {
        idxBuf[b + 1] = idxBuf[b]
        b--
      }
      idxBuf[b + 1] = iA
    }
    let bx = 0
    let by = 0
    let bz = 0
    let best = 0
    for (let k = 0; k < m; k++) {
      const j = idxBuf[k]
      const w = wBuf[j]
      bx += w * uxBuf[j]
      by += w * uyBuf[j]
      bz += w * uzBuf[j]
      const cand = Math.exp(-peakDecay * keyBuf[j]) * Math.sqrt(bx * bx + by * by + bz * bz)
      if (cand > best) best = cand
    }
    peak[i] = best
  }
  return peak
}
