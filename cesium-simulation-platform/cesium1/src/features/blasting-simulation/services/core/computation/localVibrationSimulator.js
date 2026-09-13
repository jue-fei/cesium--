/**
 * 本地爆破振动场模拟器（萨道夫斯基经验公式 + 球面波传播 + 弹性应力反演 + 损伤分区）
 *
 * 用途：在后端 WebSocket 不可用时，提供本地模拟的振动传播过程，
 * 满足用户"自行模拟实时数据"的需求，保证动态热力图和粒子效果始终可用。
 *
 * 物理模型完全复刻后端 blast_physics.py：
 *   1. PPV 实时质点速度：萨道夫斯基经验公式 + 球面波前传播 + 时变回落
 *      v(r, t) = K·(Q^(1/3)/R)^α · exp(-(β+βv)·(t - R/c̄)) · H(t - R/c̄)
 *      （c̄=visualCp 可视化波速；βv=visualBeta 可视化时变衰减，见 computePpvField3d）
 *   2. 应力场反演（弹性球面波本构一阶近似）：
 *      σ_rr = ρ·c_p·v_r（径向压）, σ_θθ = (ν/(1−ν))·σ_rr（切向拉幅值）,
 *      σ_vm = σ_rr/(1−ν)（von Mises）
 *   3. 损伤分区（Persson 模型，基于"波峰几何峰值×波前到达门控"，单位 cm/s）：
 *      0 elastic  (<20)    → 弹性区，无损伤（σ_vm<3.2MPa，低于中硬岩强度）
 *      1 micro_crack (20~50) → 微裂纹萌生
 *      2 crack_growth (50~100) → 裂纹扩展（接近 Persson 700mm/s 判据）
 *      3 fracture (100~200) → 岩体破碎
 *      4 throw (≥200) → 抛掷爆腔
 *
 * 坐标系：与 threeBlastingRenderer 一致，采用隧道局部坐标系（局部 ENU 原点）。
 * 默认 blastCenter = [0,0,0]（网格原点）；可通过 options.origin 指定爆心为任意点
 * （如掏槽孔组质心，位于掌子面 [x, y, faceOffset]），使应力波/损伤从实际爆破位置出发。
 * 网格轴序：输出按 WebGL Data3DTexture 要求（x-最快，z-最慢），保证纹理采样正确。
 */

// 损伤分区阈值（Persson 模型，近场损伤临界值，单位：cm/s）
// 与后端 DAMAGE_THRESHOLDS_CMPS 完全一致（P0-1 已提高至 (20,50,100,200)，
// 使损伤区收束到爆源邻近数米，避免解析场下出现"无视隧道轮廓的无边红圆/黄块"）
const DAMAGE_THRESHOLDS_CMPS = [20.0, 50.0, 100.0, 200.0]

// ─── 径向能量包络 / 损伤深度上限（与后端 blast_physics.py 逐项同口径） ─────────
// 后端 ppv_field_3d_multi / peak_ppv_envelope_multi 施加 env(r)（BLAST_INFLUENCE_
// RADIUS/TAU），damage_zone_field 施加 atten(r)（DAMAGE_MAX_RADIUS/ATTEN_TAU）。
// 本地模拟器（暂停/推流结束后接管热力图的数据源）必须施加同一对空间门控，
// 否则同一时刻 WS 推流帧与本地帧的场值/分区不一致——拖动进度条时两数据源交替
// 写纹理，表现为"Seek 后热力图跳变/损伤区错位"。r 取到最近**真实**装药源的
// 距离（不含镜象反射源，与后端 dmin 口径一致）。未传参（0/null）时门控关闭。
const INFLUENCE_ENVELOPE_TAU = 3.0
const DAMAGE_ATTEN_TAU = 1.5

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

function _radialEnv(distance, radius) {
  if (!(radius > 0)) return 1
  const tau = INFLUENCE_ENVELOPE_TAU
  const e = (radius + tau - distance) / tau
  return e < 0 ? 0 : e > 1 ? 1 : e
}

function _damageAtten(distance, maxRadius) {
  if (!(maxRadius > 0)) return 1
  const e = (maxRadius - distance) / DAMAGE_ATTEN_TAU
  return e < 0 ? 0 : e > 1 ? 1 : e
}

/**
 * 逐点到前 nDirect 个条目（真实装药源；expandSourcesWithReflections 先出直达后出
 * 反射，distTable 前 nDirect 条恰为真实源）的最小距离。门控 env/atten 的 r 与后端
 * dmin 同口径：不含镜象反射源。
 */
function _dminFromDistTable(distTable, nDirect, nPoints) {
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
// 真实爆破中掌子面与隧道内壁是自由面（应力为零），应力波入射发生近全反射，
// 对应拉伸波：自由面处法向质点速度加倍（同号镜象源）→ 靠近轮廓处振速场
// 出现"局部放大 + 直达波/反射波干涉相消"，这正是用户要求的"隧道轮廓不能只是
// 视觉贴图，必须能反射波场"。用镜象源法近似：把装药源沿自由面镜像为同号
// 虚拟源（幅值 × 反射系数 <1），反射波路径 = 接收点至镜像源距离，且仅在自由面
// 岩体一侧（z ≥ 掌子面）有效。物理口径与 GPU 着色器（sceneBuilder uReflectOn/
// uFaceZ/uReflectCoeff）完全一致。
//
// CPU 体网格反射项源数上限：体网格点 × 源 的矢量叠加需要缓存距离表，反射项
// 每个源多占一份 (dist, distPow) 列（≤8B/点）。43 孔昆阳 16 个反射源 =
// 16×294912×8B ≈ 37.7MB，可接受；更强的反射贡献来自药量最大的掏槽/底板/辅助孔，
// 16 已覆盖近掌子面干涉主形态（surface/monitor 路径不设上限，取全部源）。
const _REFL_MAX_SOURCES = 16

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

const _GATE_AXIS = { x: 0, y: 1, z: 2 }

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
  const src = (entries || []).filter(s => Number(s.chargeKg) > 0)
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
 * 生成 3D 网格坐标（X, Y, Z），覆盖隧道断面范围沿轴向扩展
 * @param {number} tunnelWidth - 隧道宽度(m)，横向(X)范围 [-w/2, w/2]
 * @param {number} tunnelHeight - 隧道总高度(m)，竖向(Y)范围 [-h/2, h/2]
 * @param {number} lengthZ - 沿隧道轴向(Z)长度(m)，范围 [0, lengthZ]
 * @param {number} nx - X 方向网格数
 * @param {number} ny - Y 方向网格数
 * @param {number} nz - Z 方向网格数
 * @param {Object} [explicitBounds] - 显式边界覆盖 { boundsMin: [x,y,z], boundsMax: [x,y,z] }，
 *                用于与后端 WS 网格完全对齐（后端 y 边界非对称：[-0.2h, 1.2h]）
 * @returns {Object} { gridXyz: Float32Array(n*3), gridShape: [nx,ny,nz], boundsMin: [xmin,ymin,zmin], boundsMax: [xmax,ymax,zmax] }
 */
export function buildPpvGrid(
  tunnelWidth,
  tunnelHeight,
  lengthZ = 40,
  nx = 32,
  ny = 32,
  nz = 64,
  explicitBounds = null
) {
  let xMin = -tunnelWidth / 2
  let xMax = tunnelWidth / 2
  let yMin = -tunnelHeight / 2
  let yMax = tunnelHeight / 2
  let zMin = 0
  let zMax = lengthZ
  if (explicitBounds?.boundsMin && explicitBounds?.boundsMax) {
    xMin = explicitBounds.boundsMin[0]
    yMin = explicitBounds.boundsMin[1]
    zMin = explicitBounds.boundsMin[2]
    xMax = explicitBounds.boundsMax[0]
    yMax = explicitBounds.boundsMax[1]
    zMax = explicitBounds.boundsMax[2]
  }

  const gridShape = [nx, ny, nz]
  const nTotal = nx * ny * nz
  const gridXyz = new Float32Array(nTotal * 3)

  let idx = 0
  for (let zi = 0; zi < nz; zi++) {
    const z = zMin + ((zMax - zMin) * (zi + 0.5)) / nz
    for (let yi = 0; yi < ny; yi++) {
      const y = yMin + ((yMax - yMin) * (yi + 0.5)) / ny
      for (let xi = 0; xi < nx; xi++) {
        const x = xMin + ((xMax - xMin) * (xi + 0.5)) / nx
        gridXyz[idx * 3 + 0] = x
        gridXyz[idx * 3 + 1] = y
        gridXyz[idx * 3 + 2] = z
        idx++
      }
    }
  }

  return {
    gridXyz,
    gridShape,
    boundsMin: [xMin, yMin, zMin],
    boundsMax: [xMax, yMax, zMax]
  }
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
  const alpha = options.alpha ?? 1.5
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

/**
 * 计算指定时刻的 3D PPV 场
 * @param {Float32Array} gridXyz - 网格坐标数组 [x0,y0,z0, x1,y1,z1, ...]
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - 岩体介质参数
 * @param {number} [options.K=200] - 萨道夫斯基场地常数
 * @param {number} [options.alpha=1.5] - 萨道夫斯基衰减指数
 * @param {number} [options.beta=0.02] - 介质阻尼系数（物理）
 * @param {number} [options.visualBeta=0.8] - 可视化时变衰减（1/s，非物理阻尼）：
 *                仅用于展示"实时质点速度"的波峰回落过程——波前扫过后速度按该常数
 *                指数衰减，使动画呈现"到达→峰值→回落"的瞬时演化，而非全场恒为峰值色
 * @param {number} [options.cp=4500] - 纵波速度(m/s)
 * @param {number} [options.minStandoff=0.5] - 最小距离下限
 * @param {number[]} [options.origin] - 爆心在网格局部坐标系中的坐标 [x,y,z]，缺省 [0,0,0]
 * @returns {Float32Array} PPV 数组，长度 = gridXyz.length / 3，单位 m/s
 */
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
function _getDistCache(gridXyz, src, minStandoff, visualCp, alpha = 1.5) {
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
function _ensureAccBuffers(n) {
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

// 峰值损伤预计算缓存：峰值几何场（矢量叠加模长→分区）与最早到达时刻均与 t
// 无关，只依赖 (点集, 源几何, K/α/minStandoff/visualCp) → 一次预计算，逐时刻 O(N) 门控。
// 同距离缓存一样按点集引用多槽（体网格与岩面顶点集共存），并额外保留连续峰值
// 数组 peak（m/s，分区 digitize 之前的原值）——等值线提取需要连续场而非离散档位。
const _PEAK_CACHE_MAX_SLOTS = 4
const _peakCacheMap = new Map()
function _getPeakCache(gridXyz, distFp, K) {
  let slot = _peakCacheMap.get(gridXyz)
  if (slot && slot.fp === distFp && slot.K === K && slot.zones) return slot
  return null
}
function _setPeakCache(gridXyz, distFp, K, zones, arrival, peak) {
  if (!_peakCacheMap.has(gridXyz) && _peakCacheMap.size >= _PEAK_CACHE_MAX_SLOTS) {
    const oldest = _peakCacheMap.keys().next().value
    _peakCacheMap.delete(oldest)
  }
  const slot = { grid: gridXyz, fp: distFp, K, zones, arrival, peak }
  _peakCacheMap.set(gridXyz, slot)
  return slot
}

export function computePpvField3d(gridXyz, chargeKg, t, options = {}, out = null) {
  const K = options.K ?? 200.0
  const alpha = options.alpha ?? 1.5
  const beta = options.beta ?? 0.02
  const visualBeta = options.visualBeta ?? 0.8
  const cp = options.cp ?? 4500.0
  const visualCp = options.visualCp ?? cp
  const minStandoff = options.minStandoff ?? 0.5
  // 径向能量包络半径（m，0/null=关）：与后端 ppv_field_3d 的 influence_radius 同口径
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
  // 本函数的语义是"瞬时质点速度场"（波前到达→振荡→衰减），含波动相位载波与
  // 自由面反射（镜象源）——与 GPU 着色器单源分支同口径。
  const origin = options.origin ?? null
  const ox = origin ? Number(origin[0]) || 0 : 0
  const oy = origin ? Number(origin[1]) || 0 : 0
  const oz = origin ? Number(origin[2]) || 0 : 0
  const carrierHz = Number(options.carrierHz) > 0.5 ? Number(options.carrierHz) : 0

  const nPoints = gridXyz.length / 3
  const ppv = out ?? new Float32Array(nPoints)
  // 自由面反射（单源）：镜象源位于掌子面另一侧，接收侧 z ≥ faceZ
  const planes = normalizeReflections(options.reflections)
  const facePlane = planes.find(p => p.axis === 'z')
  const img = facePlane
    ? { x: ox, y: oy, z: 2 * facePlane.value - oz, coeff: facePlane.coeff }
    : null

  for (let i = 0; i < nPoints; i++) {
    const x = gridXyz[i * 3 + 0]
    const y = gridXyz[i * 3 + 1]
    const z = gridXyz[i * 3 + 2]
    // 爆心在局部坐标 (ox,oy,oz)（缺省为原点），即掏槽孔爆破位置
    const dx = x - ox
    const dy = y - oy
    const dz = z - oz
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const arrival = r / visualCp // 波前到达时间（可视化速度）
    let v = 0
    if (t >= arrival) {
      const gap = t - arrival
      const peak = sadoskyPpv(chargeKg, r, { K, alpha, minStandoff })
      const osc =
        2 * Math.PI * carrierHz > 0
          ? Math.sin(2 * Math.PI * carrierHz * gap) *
            Math.exp((-Math.PI * carrierHz * gap) / WAVELET_Q)
          : 1.0
      v = peak * Math.exp(-(beta + visualBeta) * gap) * osc
    }
    // 反射分量（仅岩体侧）
    if (img && z >= facePlane.value) {
      const r2 = Math.sqrt(dx * dx + dy * dy + (z - img.z) * (z - img.z))
      const arr2 = r2 / visualCp
      if (t >= arr2) {
        const gap2 = t - arr2
        const peak2 = sadoskyPpv(chargeKg, r2, { K, alpha, minStandoff })
        const osc2 =
          2 * Math.PI * carrierHz > 0
            ? Math.sin(2 * Math.PI * carrierHz * gap2) *
              Math.exp((-Math.PI * carrierHz * gap2) / WAVELET_Q)
            : 1.0
        // 反射波与直达波方向不同（沿镜像方向），自由面放大靠二者叠加；这里取
        // 镜像源径向方向分量近似（单源退化模式，取向 z 分量符号翻转的镜像方向）
        v += peak2 * Math.exp(-(beta + visualBeta) * gap2) * osc2 * img.coeff
      }
    }
    // PPV 语义 = 质点速度模长，恒为非负量（与 GPU 着色器 length(totalVel) 同口径）：
    // 载波开启时 v 为带符号振荡，取绝对值保证采样/应力/损伤判据不出现负 PPV。
    // 隧道轮廓自由面放大（与 GPU uFaceBoost 同口径）：
    // 径向能量包络（与后端 ppv_field_3d / GPU peak *= env 同口径）：r 取到爆心距离
    ppv[i] =
      (v < 0 ? -v : v) *
      _radialEnv(r, influenceRadius) *
      tunnelFaceBoostFactor([x, y, z], options.tunnelFace)
  }

  return ppv
}

/**
 * 由单孔几何推算单个装药源的位置（装药源坐标，爆破应力波由此孔出发）
 *
 * 坐标系与平台一致：x=掌子面内横向（左右）、y=掌子面内竖向、z=掌子面轴向（进入岩体为正）。
 * 掌子面位于 z=faceOffset；collar 位于 (posX, posY, faceOffset)。
 *
 * 装药沿炮孔布置、偏孔底（底部起爆）。装药源中心取装药段中点：
 *   - 已知 chargeLength（装药段长）时，源距孔口 = depth − chargeLength/2；
 *   - 缺省时按"底部 60%"经验（cd = 0.6·depth）。
 *
 * 两类布孔方向：
 *   1. 楔形/倾斜掏槽孔（cut，inclination>0）：孔口分列掏槽核心两侧、孔轴向核心收敛
 *      —— 这是楔形掏槽"多应力波叠加增强"的几何本源。横向收敛量 lat=cd·sinθ、
 *      轴向进尺 axial=cd·cosθ（cd=装药段中点距孔口），方向由孔口指向掏槽孔组质心
 *      (center.x, center.y)。各掏槽孔装药源向核心收拢，应力波在该区域重叠干涉，
 *      不再呈单一同心圆。
 *   2. 直孔/辅助/周边孔（inclination≈0）：沿孔轴向内，位移由 inclination/azimuth
 *      按 sceneBuilder._buildHoleMeshes 的 Euler XYZ 旋转约定计算，与绘制炮孔对齐。
 *
 * @param {Object} h - 炮孔数据 { posX, posY, depth, chargeLength, inclinationAngle/azimuth,
 *                       holeType/type, chargeKg, delayMs, isEmptyHole, id }
 * @param {number} faceOffset - 掌子面轴向位置(m)
 * @param {Object} center - 掏槽孔质心 { x, y }（用于楔形孔向内收敛）
 * @returns {{x:number,y:number,z:number,chargeKg:number,delayMs:number,id?:*} | null}
 *          空孔或未装药孔返回 null（不参与应力波源）
 */
export function resolveChargePosition(h, faceOffset, center) {
  const q = Number(h.chargeKg)
  if (!(q > 0) || !!h.isEmptyHole) return null

  const type = String(h?.holeType || h?.type || 'production').toLowerCase()
  const isCut = type === 'cut' || type === 'easing'
  const depth = Math.max(0.2, Number(h.depth) || 2.5)
  const cxl = Number(h.chargeLength)
  const cd = Number.isFinite(cxl) && cxl > 0 ? Math.max(0.2, depth - cxl * 0.5) : depth * 0.6
  const inc = Math.max(0, Number(h.inclinationAngle ?? h.inclination) || 0) * (Math.PI / 180)

  const collarX = Number(h.posX) || 0
  const collarY =
    Number.isFinite(Number(h.posY)) && Number(h.posY) !== 0 ? Number(h.posY) : center.y
  const collarZ = faceOffset

  if (isCut && inc > 0.02) {
    // 楔形掏槽：孔轴指向掏槽核心（核心 = 掏槽孔质心），装药源取**装药段中点**
    // （距孔口 cd，与直孔口径统一；cd = depth − chargeLength/2，缺省 0.6·depth）。
    // 旧版直接用全孔深 depth 把源推到孔底汇拢点——正视图中环心与孔口标记偏移最大；
    // 装药段中点=装药重心，物理口径与辅助/周边孔一致，孔底干涉增强仍保留
    // （各掏槽孔源间距小、向核心收拢）。
    const dvx = (center.x || 0) - collarX
    const dvy = (center.y || 0) - collarY
    const dl = Math.hypot(dvx, dvy) || 1
    const lat = cd * Math.sin(inc)
    const axial = cd * Math.cos(inc)
    return {
      x: collarX + (dvx / dl) * lat,
      y: collarY + (dvy / dl) * lat,
      z: collarZ + axial,
      chargeKg: q,
      delayMs: Number(h.delayMs) || 0,
      id: h.id
    }
  }

  // 直孔/辅助/周边：按绘制炮孔的 Euler XYZ 旋转约定计算孔内偏移
  const azi = (Number(h.inclinationAzimuth ?? h.azimuth) || 0) * (Math.PI / 180)
  const rx = -Math.sin(azi) * inc
  const ry = Math.cos(azi) * inc
  return {
    x: collarX - cd * Math.cos(rx) * Math.sin(ry),
    y: collarY - cd * Math.sin(rx),
    z: collarZ + cd * Math.cos(rx) * Math.cos(ry),
    chargeKg: q,
    delayMs: Number(h.delayMs) || 0,
    id: h.id
  }
}

/**
 * 从炮孔列表构建多应力波源（用于本地多源叠加模拟）
 * @param {Array} holes - 炮孔数据列表
 * @param {number} faceOffset - 掌子面轴向位置(m)
 * @param {Object} cutCenter - 掏槽孔质心 { x, y }（楔形孔向内收敛的基准）
 * @param {Object} [options] - { delayJitterMs, rngSeed }
 *   - delayJitterMs>0：各段雷管起爆延期的蒙特卡洛误差（±σ ms，正态分布）。
 *     按 (rngSeed + 源索引) 确定性产生抖动 → 同一场景每次重建结果一致，
 *     且瞬时场/峰值场/损伤/等值线共用同一批抖动后源（打破完美对称干涉）。
 * @returns {Array} 装药源列表 [{x,y,z,chargeKg,delayMs,id}]；无有效源时返回空数组
 */
export function buildChargeSources(holes, faceOffset, cutCenter, options = {}) {
  if (!Array.isArray(holes) || holes.length === 0) return []
  const center = cutCenter || { x: 0, y: 0 }
  const jitterMs = Number(options.delayJitterMs) > 0 ? Number(options.delayJitterMs) : 0
  const seedBase = typeof options.rngSeed === 'number' ? options.rngSeed : 12345
  const sources = []
  for (let idx = 0; idx < holes.length; idx++) {
    const s = resolveChargePosition(holes[idx], faceOffset, center)
    if (!s) continue
    // 雷管起爆误差：对每段装药的 base delay 叠加确定性高斯抖动（σ=jitterMs）
    if (jitterMs > 0) {
      const base = Number(s.delayMs) || 0
      s.delayMs = Math.max(0, base + _seededGauss(seedBase + idx) * jitterMs)
    }
    sources.push(s)
  }
  return sources
}

// 确定性种子随机（mulberry32）＋ Box–Muller 高斯：同一 (seed) 永不改变 → 可复现
function _mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function _seededGauss(seed) {
  const rnd = _mulberry32(seed)
  const u = Math.max(rnd(), 1e-12)
  const v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * 计算单个监测点的三分量瞬时振速全时程（Vx/Vy/Vz/Vmag）与缩放 PPV
 *
 * 物理与 computeMultiSourcePpvField3d 完全一致：N 个装药源的**矢量叠加**
 * v(p,t) = Σ_s a_s(t)·u_s（u_s 为源→点径向单位向量），Vmag=|v|。返回
 * 每个采样时刻的 Vx,Vy,Vz,|V|，并给出全时程峰值 |V|max（PPV）。
 * 用于测点波形/时程曲线，与热图/等值线共用同一 sources（含雷管抖动）。
 *
 * @param {number[]} point - 监测点坐标 [x,y,z]
 * @param {Array} sources - 装药源列表 [{x,y,z,chargeKg,delayMs}]
 * @param {Float32Array|number[]} times - 采样时刻（s），需等间隔
 * @param {Object} [options] - { K, alpha, beta, visualBeta, cp, visualCp, minStandoff }
 * @returns {Object} { t, vx, vy, vz, vmag, ppv }（均为 Float32Array，ppv 为标量 m/s）
 */
export function computeMonitorTimeHistory(point, sources, times, options = {}) {
  const K = options.K ?? 200.0
  const alpha = options.alpha ?? 1.5
  const beta = options.beta ?? 0.02
  const visualBeta = options.visualBeta ?? 0.8
  const visualCp = options.visualCp ?? options.cp ?? 4500.0
  const minStandoff = options.minStandoff ?? 0.5
  // 波动相位载波（Hz，0=关）：时程曲线显示真实振动波形（正负交替、带调制的
  // 衰减振荡），与 GPU 热力图 uCarrierHz / CPU 瞬时场 options.carrierHz 同口径。
  const carrierHz = Number(options.carrierHz) > 0.5 ? Number(options.carrierHz) : 0

  const baseSrc = (sources || [])
    .filter(s => Number(s.chargeKg) > 0)
    .map(s => {
      const q = Number(s.chargeKg)
      return {
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        z: Number(s.z) || 0,
        delay: (Number(s.delayMs) || 0) / 1000,
        coef: K * Math.pow(q, alpha / 3) * 0.01
      }
    })
  // 自由面反射（镜象源）同样进入时程：反射波在波列中表现为"第二次到达包"，
  // 近掌子面测点可看到直达/反射叠加的干涉形态。单点计算量小，全部源参与反射。
  const src = expandSourcesWithReflections(baseSrc, options.reflections, 0)

  const n = times.length
  const t = new Float32Array(n)
  const vx = new Float32Array(n)
  const vy = new Float32Array(n)
  const vz = new Float32Array(n)
  const vmag = new Float32Array(n)
  const invCp = 1 / Math.max(visualCp, 1e-3)
  const decay = beta + visualBeta
  const twoPiF = 2 * Math.PI * carrierHz
  const px = point[0]
  const py = point[1]
  const pz = point[2]
  const nS = src.length
  let ppv = 0
  for (let ti = 0; ti < n; ti++) {
    const time = times[ti]
    t[ti] = time
    let sx = 0
    let sy = 0
    let sz = 0
    for (let s = 0; s < nS; s++) {
      const ss = src[s]
      // 反射条目接收侧门控
      if (
        ss.gate &&
        (ss.gate.axis === 'x'
          ? px < ss.gate.min
          : ss.gate.axis === 'y'
            ? py < ss.gate.min
            : pz < ss.gate.min)
      )
        continue
      const dx = px - ss.x
      const dy = py - ss.y
      const dz = pz - ss.z
      const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
      const gap = time - (ss.delay + r * invCp)
      if (gap <= 0) continue
      const osc =
        twoPiF > 0 ? Math.sin(twoPiF * gap) * Math.exp((-Math.PI * carrierHz * gap) / WAVELET_Q) : 1.0
      const a = ss.coef * Math.pow(r, -alpha) * Math.exp(-decay * gap) * osc
      const inv = 1 / Math.max(r, 1e-6)
      sx += a * dx * inv
      sy += a * dy * inv
      sz += a * dz * inv
    }
    const vm = Math.sqrt(sx * sx + sy * sy + sz * sz)
    vx[ti] = sx
    vy[ti] = sy
    vz[ti] = sz
    vmag[ti] = vm
    if (vm > ppv) ppv = vm
  }
  return { t, vx, vy, vz, vmag, ppv }
}

/**
 * 计算沿爆心径向（默认沿隧道轴向 +z 岩体内部）的 PPV 衰减剖面（m/s），
 * 用于"仿真结果 vs 萨道夫斯基经验公式"对比验证：
 *   - sim[i]    = 仿真 PPV：多装药源（含自由面反射）全时程峰值（包络，不载波）
 *                 取 computeMonitorTimeHistory 的 ppv（与热图/监测点同一物理模型）；
 *   - theory[i] = 萨道夫斯基公式：v = K·(Q^(1/3)/R)^α，Q 取所有源总装药量（kg），
 *                 R 取采样点到爆心（掌子面掏槽质心）的直线距离。
 * 两者放在同一图表可直接验证多孔叠加模拟是否符合经验衰减律（P2 级对比验证）。
 *
 * @param {Array} sources - 装药源（[{x,y,z,chargeKg,delayMs}]）
 * @param {Object} options - { K, alpha, visualCp, visualBeta, minStandoff, reflections,
 *                             directions: [ {axis:'z', count, spacing} ] }
 * @returns {Object} {
 *   r: number[],   // 采样点到爆心的距离(m)
 *   sim: number[], // 仿真峰值 PPV（m/s）
 *   theory: number[], // 萨道夫斯基公式 PPV（m/s）
 *   labels: string[]  // 每采样点标签（如 'L1'… 或 方向+距）
 * }
 */
export function computePpvDecayProfile(sources, options = {}) {
  const K = options.K ?? 30
  const alpha = options.alpha ?? 1.5
  const visualCp = options.visualCp ?? 35
  const visualBeta = options.visualBeta ?? 0.8
  const minStandoff = options.minStandoff ?? 0.5
  const reflections = options.reflections || null
  const dirs =
    Array.isArray(options.directions) && options.directions.length
      ? options.directions
      : [{ axis: 'z', count: 16, spacing: 2.0 }] // 默认沿 +z：自掌子面向岩体内部
  const srcList = (sources || []).filter(s => Number(s.chargeKg) > 0)
  const totalQ = srcList.reduce((a, s) => a + (Number(s.chargeKg) || 0), 0) || 100

  const r = []
  const sim = []
  const theory = []
  const labels = []
  // 单点全时程采样：5ms 步长、覆盖到最远采样点的波前到达 + 波列衰减
  let dMax = 0
  const points = []
  for (const d of dirs) {
    const ax = d.axis || 'z'
    const count = Math.max(2, Math.round(d.count) || 16)
    const spacing = Number(d.spacing) > 0 ? Number(d.spacing) : 2.0
    const base = d.base && Array.isArray(d.base) && d.base.length === 3 ? d.base.map(Number) : null
    for (let k = 1; k <= count; k++) {
      const p = base ? base.slice() : [0, 0, 0]
      p[ax === 'x' ? 0 : ax === 'y' ? 1 : 2] += spacing * k
      points.push({ p, dist: spacing * k, label: `${ax.toUpperCase()}${k}` })
      dMax = Math.max(dMax, spacing * k)
    }
  }
  const duration = Math.max(3, (dMax / Math.max(visualCp, 1)) * 4 + 1.5)
  const dt = 0.005
  const n = Math.max(32, Math.ceil(duration / dt))
  const times = new Float32Array(n)
  for (let i = 0; i < n; i++) times[i] = i * dt

  for (const { p, dist, label } of points) {
    const hist = computeMonitorTimeHistory(p, srcList, times, {
      K,
      alpha,
      visualBeta,
      visualCp,
      minStandoff,
      reflections,
      carrierHz: 0 // 对比用包络峰值
    })
    r.push(dist)
    sim.push(hist.ppv)
    theory.push(sadoskyPpv(totalQ, dist, { K, alpha, minStandoff }))
    labels.push(label)
  }
  return { r, sim, theory, labels, totalQ, K, alpha }
}

/**
 * 计算单个点的瞬时三维质点速度矢量（Vx/Vy/Vz + 模长），多源矢量叠加 + 自由面
 * 反射（镜象源）+ 波动相位载波——与 GPU 热力图（sceneBuilder 着色器）同口径。
 * 供矢量箭头场（P1-6）逐帧采样；单点计算量大头是源数×1，箭头数为几十~几百级，
 * 每帧开销微不足道。
 * @param {number[]} point - 坐标 [x,y,z]（grid 局部系）
 * @param {Array} sources - 装药源 [{x,y,z,chargeKg,delayMs}]
 * @param {number} t - 模拟时间(s)
 * @param {Object} [options] - { K, alpha, beta, visualBeta, visualCp, minStandoff,
 *                               carrierHz, reflections }
 * @returns {{vx:number,vy:number,vz:number,mag:number}}
 */
export function computePointVector(point, sources, t, options = {}) {
  const K = options.K ?? 30
  const alpha = options.alpha ?? 1.5
  const beta = options.beta ?? 0.02
  const visualBeta = options.visualBeta ?? 0.8
  const visualCp = options.visualCp ?? 35
  const minStandoff = options.minStandoff ?? 0.5
  const carrierHz = Number(options.carrierHz) > 0.5 ? Number(options.carrierHz) : 0
  const base = (sources || [])
    .filter(s => Number(s.chargeKg) > 0)
    .map(s => {
      const q = Number(s.chargeKg)
      return {
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        z: Number(s.z) || 0,
        delay: (Number(s.delayMs) || 0) / 1000,
        coef: K * Math.pow(q, alpha / 3) * 0.01
      }
    })
  const src = expandSourcesWithReflections(base, options.reflections, 0)
  const px = point[0],
    py = point[1],
    pz = point[2]
  const invCp = 1 / Math.max(visualCp, 1e-3)
  const decay = beta + visualBeta
  const twoPiF = 2 * Math.PI * carrierHz
  let vx = 0,
    vy = 0,
    vz = 0
  for (let s = 0; s < src.length; s++) {
    const ss = src[s]
    if (ss.gate) {
      const gv = ss.gate.axis === 'x' ? px : ss.gate.axis === 'y' ? py : pz
      if (gv < ss.gate.min) continue
    }
    const dx = px - ss.x
    const dy = py - ss.y
    const dz = pz - ss.z
    const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
    const gap = t - (ss.delay + r * invCp)
    if (gap <= 0) continue
    const osc = twoPiF > 0 ? Math.cos(twoPiF * gap) : 1.0
    const a = ss.coef * Math.pow(r, -alpha) * Math.exp(-decay * gap) * osc
    const inv = 1 / Math.max(r, 1e-6)
    vx += a * dx * inv
    vy += a * dy * inv
    vz += a * dz * inv
  }
  return { vx, vy, vz, mag: Math.sqrt(vx * vx + vy * vy + vz * vz) }
}

/**
 * 计算指定时刻的 3D PPV 场 —— 多装药源矢量叠加（波场干涉，非单一同心圆）
 *
 * 物理模型：N 个装药源（对应掏槽/辅助/周边各炮孔的装药段）在不同位置、按各自
 * delayMs 时序依次起爆。每个源发出一个球面波：
 *
 *   v_s(t) = K·(q_s^(1/3)/r_s)^α · exp(−(β+βv)·(t − delay_s − r_s/c̄)) · H(t − delay_s − r_s/c̄)
 *
 * 各源的瞬时质点速度是**矢量**：方向沿各自径向单位向量 u_s = (p − src_s)/r_s。
 * 某点的总瞬时质点速度 = 各源波场矢量和：v(p,t) = Σ_s v_s(t)·u_s，
 * 其模长 |v| 即为 PPV。由于各源位置分离、起爆时序错开，矢量和会产生
 * 相长/相消干涉：掏槽孔在孔底汇拢处源间距离小时相长（核心高应力增强），
 * 源间距离大或相位错开处出现干涉瓣——正是"多应力波叠加"的真实波场形态，
 * 不再是一个药包中心的单一同心圆。σ_vm 由该 PPV 线性反演（computeStressFieldFromPpv），
 * 故应力场同样呈现非同心、多源干涉的斑块结构。
 *
 * 空源（无装药孔）时退化为单源（源在 options.origin，缺省网格原点），
 * 与 computePpvField3d 行为一致，保证向后兼容。
 *
 * @param {Float32Array} gridXyz - 网格坐标 (N×3)
 * @param {number} t - 模拟时间(s)
 * @param {Object} options - { K, alpha, beta, visualBeta, cp, visualCp, minStandoff,
 *                            sources: [{x,y,z,chargeKg,delayMs}], origin }
 * @param {Float32Array} [out] - 复用输出缓冲区
 * @returns {Float32Array} PPV 数组（m/s）
 */
export function computeMultiSourcePpvField3d(gridXyz, t, options = {}, out = null) {
  const sources = (options.sources || []).filter(s => Number(s.chargeKg) > 0)
  if (sources.length === 0)
    return computePpvField3d(gridXyz, options.chargeKg ?? 100, t, options, out)

  const K = options.K ?? 200.0
  const alpha = options.alpha ?? 1.5
  const beta = options.beta ?? 0.02
  const visualBeta = options.visualBeta ?? 0.8
  const visualCp = options.visualCp ?? options.cp ?? 4500.0
  const minStandoff = options.minStandoff ?? 0.5
  // 波动相位子波（Hz，0=关）：瞬时质点速度 × sin(2πf·gap)·exp(-πf·gap/Q)——与
  // GPU 着色器 waveletOsc 同口径（WAVELET_Q 同值）。sin 起振为零（波前连续），
  // 包络按品质因数 Q 指数衰减（每周期 e^(-π/Q)≈0.73，10 周期后 ≈4%），有限时长
  // 瞬态脉冲。多孔延期差+路径差直接转化为相位差 → 干涉条纹；峰值场（损伤/等值线
  // 数据源）仍用包络（carrierHz 无关），保证工程判据稳定。
  const carrierHz = Number(options.carrierHz) > 0.5 ? Number(options.carrierHz) : 0

  // 每源预计算系数 K·q^(α/3)·0.01（sadoskyPpv 的数学展开）：配合距离缓存预存的
  // r^-α 表，热循环内不再逐 (点,源) 调 Math.pow——全孔源数下这是 0.2s 节流的关键。
  const baseSrc = sources.map(s => {
    const q = Number(s.chargeKg)
    return {
      x: Number(s.x) || 0,
      y: Number(s.y) || 0,
      z: Number(s.z) || 0,
      chargeKg: q,
      delay: (Number(s.delayMs) || 0) / 1000,
      coef: K * Math.pow(q, alpha / 3) * 0.01
    }
  })
  // 自由面反射（掌子面镜象源）：展开为 直达 + 反射 条目列表，条目带 gate
  const src = expandSourcesWithReflections(baseSrc, options.reflections, _REFL_MAX_SOURCES)

  const nPoints = gridXyz.length / 3
  const ppv = out ?? new Float32Array(nPoints)
  const cache = _getDistCache(gridXyz, src, minStandoff, visualCp, alpha)
  const distTable = cache.dist
  const distPow = cache.distPow

  // 径向能量包络（与后端 ppv_field_3d_multi 同口径）：r 取到最近真实装药源距离
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
  const dminArr = influenceRadius > 0 ? _dminFromDistTable(distTable, baseSrc.length, nPoints) : null

  // 源外/点内循环序：每个源顺序扫过 dist/distPow 各自连续的表段（预取友好），
  // 矢量和累加到模块级复用的逐点缓冲。相比"点外源内"在 nS 个相距 ~1MB 的表段
  // 间跳转，全源到达后单遍耗时约减半；且未到达的 (源,点) 不再计算方向分量。
  // 叠加的是**瞬时质点速度幅值**：载波用"同相位 cos 分量 + 正交 sin 分量"平方和
  // 表示（|v| = A·√(cos²θ+sin²θ) = A 恒正），与 GPU 着色器同口径。直接用
  // A·cosθ 作幅值会在过零点落回 0，归一化后触到色阶最暗档（Jet 底≈纯黑）→
  // 热力图整片死黑麻点；双分量形式保留全部相位/干涉信息且恒正无零点。
  // 该场供点选拾取瞬时振速 v(t) 采样与应力反演；损伤分区由独立的峰值几何场
  // （computeMultiSourcePeakDamageZones，不载波）判定，两者语义互不干扰。
  const acc = _ensureAccBuffers(nPoints)
  const accCx = acc.cx
  const accCy = acc.cy
  const accCz = acc.cz
  const accSx = acc.sx
  const accSy = acc.sy
  const accSz = acc.sz
  accCx.fill(0)
  accCy.fill(0)
  accCz.fill(0)
  accSx.fill(0)
  accSy.fill(0)
  accSz.fill(0)
  const invCp = 1 / Math.max(visualCp, 1e-3)
  const decay = beta + visualBeta
  const twoPiF = 2 * Math.PI * carrierHz
  const nS = src.length
  for (let s = 0; s < nS; s++) {
    const srcS = src[s]
    const sx = srcS.x
    const sy = srcS.y
    const sz = srcS.z
    const dS = srcS.delay
    const coef = srcS.coef
    const base = s * nPoints
    // 反射条目的接收侧门控：坐标不满足 gate（自由面空腔一侧）时不参与
    const gate = srcS.gate
    const gAx = gate ? _GATE_AXIS[gate.axis] : -1
    const gMin = gate ? gate.min : 0
    for (let i = 0; i < nPoints; i++) {
      if (gAx >= 0 && gridXyz[i * 3 + gAx] < gMin) continue
      const r = distTable[base + i]
      const gap = t - (dS + r * invCp)
      if (gap <= 0) continue // 该源波前未到达
      // 载波双分量：θ=2πf·gap，包络按品质因数 Q 指数衰减（每周期 e^(-π/Q)）
      let oscC = 1.0
      let oscS = 0.0
      if (twoPiF > 0) {
        const env = Math.exp((-Math.PI * carrierHz * gap) / WAVELET_Q)
        const th = twoPiF * gap
        oscC = Math.cos(th) * env
        oscS = Math.sin(th) * env
      }
      const a = coef * distPow[base + i] * Math.exp(-decay * gap)
      const inv = 1 / Math.max(r, 1e-6)
      const dx = (gridXyz[i * 3 + 0] - sx) * inv
      const dy = (gridXyz[i * 3 + 1] - sy) * inv
      const dz = (gridXyz[i * 3 + 2] - sz) * inv
      accCx[i] += a * oscC * dx
      accCy[i] += a * oscC * dy
      accCz[i] += a * oscC * dz
      accSx[i] += a * oscS * dx
      accSy[i] += a * oscS * dy
      accSz[i] += a * oscS * dz
    }
  }
  for (let i = 0; i < nPoints; i++) {
    // |v|² = |cos 分量|² + |sin 分量|²（正交分量平方和 → 恒正，无周期零点）
    const c2 = accCx[i] * accCx[i] + accCy[i] * accCy[i] + accCz[i] * accCz[i]
    const s2 = accSx[i] * accSx[i] + accSy[i] * accSy[i] + accSz[i] * accSz[i]
    // 隧道轮廓自由面放大（与 GPU uFaceBoost 同口径；face 缺省/coeff=0 返回 1）
    ppv[i] =
      Math.sqrt(c2 + s2) *
      tunnelFaceBoostFactor(
        [gridXyz[i * 3], gridXyz[i * 3 + 1], gridXyz[i * 3 + 2]],
        options.tunnelFace
      ) *
      (dminArr ? _radialEnv(dminArr[i], influenceRadius) : 1)
  }
  return ppv
}

/**
 * 由 PPV 场反演 von Mises 等效应力场（弹性球面波一阶近似）
 * @param {Float32Array} ppv - PPV 场数组 (m/s)
 * @param {Object} options - 岩体参数
 * @param {number} [options.rho=2650] - 岩体密度(kg/m³)
 * @param {number} [options.cp=4500] - 纵波速度(m/s)
 * @param {number} [options.nu=0.25] - 泊松比
 * @returns {Float32Array} σ_vm 等效应力场，单位 Pa
 *
 * 爆破应力波在岩体中产生两种破坏性应力（岩体爆破破坏/生成裂隙的机制）：
 *   - 径向压应力 σ_rr = ρ·c_p·v_r（加载相，波阻抗关系）
 *   - 切向拉应力 σ_θθ = ν/(1−ν)·σ_rr（切向受拉，方向与径向相反；σ_θθ≥σ_t
 *     抗拉强度处产生径向裂隙，是爆破成缝的主因）
 * von Mises：σ_1=σ_rr（压）、σ_2=σ_3=−σ_θθ（拉）→ σ_vm = σ_rr/(1−ν) × F(r)
 * 其中 F(r) 为近场几何修正（见模块头 NEAR_FIELD_* 注释）。
 * 与后端 blast_physics.py::stress_field_from_ppv 完全一致。
 *
 * 输入约定：ppv 应为**峰值包络场**（computeMultiSourcePeakField3d）。传入瞬时
 * 振速会让应力场与振速场只差一个常数（归一化后逐点相同 → 两图一模一样）。
 *
 * @param {Float32Array} [distance] - 各点到爆心距离(m)，用于近场几何修正；
 *   缺省则不施加修正（F≡1）
 *
 * 适用范围与局限（弹性假设标注）：
 *   - 弹性一阶近似，仅适用于中远场（r > 5R_charge，R_charge 为药包半径）；
 *   - 近场（爆腔附近）存在塑性变形与卸载拉应力，弹性预测偏低，
 *     需配合损伤分区（classifyDamageZones）修正理解。
 *
 * 理论依据：
 *   - Hwang & Mohanty, Int. J. Rock Mech. Min. Sci., 2005（球面波应力-速度关系）
 *   - 罗章喜, 爆炸与冲击 1982, 3:34-40（冲击波使岩石切向受拉）
 *   - Wang X. et al., Processes 2023, 11(9):2805（σ_θ = −b·σ_r, b = ν/(1−ν)）
 *   - 梁瑞等, 高压物理学报 2022, 36(6):064202（裂隙区径向压力+切向拉力，Mises 判据）
 */
export function computeStressFieldFromPpv(ppv, options = {}, out = null, distance = null) {
  const rho = options.rho ?? 2650.0
  const cp = options.cp ?? 4500.0
  const nu = options.nu ?? 0.25
  // 近场几何修正参数（见模块头 NEAR_FIELD_* 注释）：r_nf<=0 时 F≡1，退化为
  // 纯辐射项（与旧行为数值一致）
  const nfR = Number(options.nearFieldRadius) > 0 ? Number(options.nearFieldRadius) : 0
  const nfG =
    Number(options.nearFieldGain) > 0 ? Number(options.nearFieldGain) : NEAR_FIELD_GAIN

  const nPoints = ppv.length
  const sigmaVm = out ?? new Float32Array(nPoints)

  // σ_vm = ρ·c_p·v / (1−ν) × F(r)——径向压 + 切向拉（幅值 ν/(1−ν)·σ_rr）的等效应力。
  // 相比旧的弹性一维应变式 σ_vm=σ_rr·(1−2ν)/(1−ν)，本式体现了爆破破坏由
  // 切向拉应力主导的力学机制，数值更贴近实测应力幅值。
  // 注意：传入的 ppv 应为**峰值包络场**（computeMultiSourcePeakField3d），
  // 不是瞬时振速——否则应力场与振速场只差常数（两图相同）。
  const vmFactor = rho * cp * (1.0 / (1.0 - nu))
  const useNf = nfR > 0 && distance && distance.length >= nPoints

  for (let i = 0; i < nPoints; i++) {
    let v = vmFactor * ppv[i]
    if (useNf) v *= nearFieldGain(distance[i], nfR, nfG)
    sigmaVm[i] = v
  }

  return sigmaVm
}

/**
 * PPV 场分类为损伤分区（Persson 模型）
 * @param {Float32Array} ppv - PPV 场数组 (m/s)
 * @param {number[]} [thresholds] - 阈值数组 (cm/s)，默认 DAMAGE_THRESHOLDS_CMPS
 * @returns {Int8Array} 分区 id 数组：0~4，对应 elastic → throw
 */
export function classifyDamageZones(ppv, thresholds = DAMAGE_THRESHOLDS_CMPS, out = null) {
  const nPoints = ppv.length
  const zones = out ?? new Int8Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const ppvCmps = ppv[i] * 100.0 // m/s → cm/s
    let zone = 0
    for (let t = 0; t < thresholds.length; t++) {
      if (ppvCmps >= thresholds[t]) {
        zone = t + 1
      }
    }
    // 上限：≥last 阈值 → zone = len(thresholds) = 4，共 0~4 五级
    zones[i] = zone
  }

  return zones
}

/**
 * 按"该点波峰几何峰值 × 波前到达门控"计算损伤分区（与播放方向无关的确定性算法）
 *
 * 损伤是每个点经历过的最大 PPV 的不可逆判据。对时变衰减场 v(t)=peak·e^(−D(t−arrival))
 * （单调递减），"经历过的峰值"到任意时刻 t（t≥arrival）都等于 full peak（到达时刻的值），
 * 故分区 = digitize(峰值 cm/s)，仅以 波前是否到达（t ≥ r/c̄）作门控（未到达处 0）。
 *
 * 相比"逐帧峰值累积"，本式是纯确定的：同一时刻 (r,t) 无论正放、回拉、拖进度条都得到
 * 相同结果，修复"回拉进度条时损伤模式时序错乱"；且与场盒外解析分支（mpsPeak）语义一致。
 *
 * @param {Float32Array} gridXyz - 网格坐标数组 (N×3)
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - { K, alpha, minStandoff, visualCp, origin }（与 computePpvField3d 一致）
 * @param {Int8Array} [out] - 复用输出缓冲区
 * @returns {Int8Array} 分区 id 数组 0~4
 */
export function computePeakDamageZones(gridXyz, chargeKg, t, options = {}, out = null) {
  const K = options.K ?? 30.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  // 空间门控（与后端 peak_ppv_envelope_multi + damage_zone_field 同口径）
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
  const damageMaxRadius = Number(options.damageMaxRadius) > 0 ? Number(options.damageMaxRadius) : 0
  const origin = options.origin ?? null
  const ox = origin ? Number(origin[0]) || 0 : 0
  const oy = origin ? Number(origin[1]) || 0 : 0
  const oz = origin ? Number(origin[2]) || 0 : 0

  const nPoints = gridXyz.length / 3
  const zones = out ?? new Int8Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const x = gridXyz[i * 3 + 0]
    const y = gridXyz[i * 3 + 1]
    const z = gridXyz[i * 3 + 2]
    const dx = x - ox
    const dy = y - oy
    const dz = z - oz
    const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
    // 波前未到达：无损伤（0=elastic）
    if (t < r / visualCp) {
      zones[i] = 0
      continue
    }
    // 峰值 PPV（无时变衰减）× 包络 × 损伤深度衰减 → cm/s → Persson 档位
    const cm =
      sadoskyPpv(chargeKg, r, { K, alpha, minStandoff }) *
      100.0 *
      _radialEnv(r, influenceRadius) *
      _damageAtten(r, damageMaxRadius)
    let zone = 0
    for (let th = 0; th < DAMAGE_THRESHOLDS_CMPS.length; th++) {
      if (cm >= DAMAGE_THRESHOLDS_CMPS[th]) zone = th + 1
    }
    zones[i] = zone
  }

  return zones
}

/**
 * 确保"峰值几何场"缓存槽存在（内部）。
 *
 * 峰值矢量叠加、最早到达时刻与分区预计算都与 t 无关 → 按 (点集引用, 距离缓存
 * 指纹, K, 门控参数) 一次性预计算并缓存，此后每个模拟时刻只做 O(N) 门控。
 * 损伤分区（computeMultiSourcePeakDamageZones）与峰值应力场
 * （computeMultiSourcePeakField3d）共用同一槽，避免重复正演。
 *
 * 空源（无装药源）时返回 null，调用方退化到单源实现。
 * @returns {{peak:Float32Array, arrival:Float32Array, zones:Int8Array}|null}
 */
function _ensurePeakSlot(gridXyz, options = {}) {
  const sources = (options.sources || []).filter(s => Number(s.chargeKg) > 0)
  if (sources.length === 0) return null

  const K = options.K ?? 30.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  // 空间门控（与后端 peak_ppv_envelope_multi + damage_zone_field 同口径）：
  // 峰值场 × env(influenceRadius)；分区判据 digitize(peak × env × atten(damageMaxRadius))
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
  const damageMaxRadius = Number(options.damageMaxRadius) > 0 ? Number(options.damageMaxRadius) : 0

  const src0 = sources.map(s => {
    const q = Number(s.chargeKg)
    return {
      x: Number(s.x) || 0,
      y: Number(s.y) || 0,
      z: Number(s.z) || 0,
      chargeKg: q,
      delay: (Number(s.delayMs) || 0) / 1000,
      // 峰值系数 = sadoskyPpv 的数学展开：K·q^(α/3)·0.01，配合 distPow 表免逐点 pow
      coef: K * Math.pow(q, alpha / 3) * 0.01
    }
  })
  // 自由面反射同样计入峰值叠加（损伤是"经历过的峰值"不可逆判据，近掌子面
  // 反射放大应体现为更高分区）。与 computeMultiSourcePpvField3d 使用同一
  // 反射源数上限 → 距离缓存指纹一致，两遍共享同一 (dist, distPow) 表。
  const src = expandSourcesWithReflections(src0, options.reflections, _REFL_MAX_SOURCES)

  const nPoints = gridXyz.length / 3
  // alpha 必须显式传入：距离缓存按 (源几何, minStandoff, visualCp, alpha) 指纹单槽复用，
  // 漏传会回退默认 1.5 → 指纹与 PPV 遍不一致 → 两遍互相踩踏、缓存每步重建。
  const cache = _getDistCache(gridXyz, src, minStandoff, visualCp, alpha)
  const distTable = cache.dist
  const distPow = cache.distPow
  // 门控用 dmin（到最近真实装药源距离，不含镜象反射源）
  const dminArr =
    influenceRadius > 0 || damageMaxRadius > 0
      ? _dminFromDistTable(distTable, src0.length, nPoints)
      : null

  // 峰值几何场与最早到达时刻均与 t 无关 → 按 (点集引用, 距离缓存指纹, K) 一次性
  // 预计算并缓存（多槽：体网格与岩面顶点集各自独立成槽，互不踩踏）；
  // 此后每个模拟时刻只做 O(N) 门控（z = t ≥ arrival ? zonePre : 0）。
  // 门控参数必须纳入缓存指纹：滑块拖动（influence/damageMax 变化）若不失效，
  // 缓存返回旧口径分区（滑块"无效"的根因）。
  const gateFp = `${cache.fp}|e${influenceRadius}|d${damageMaxRadius}`
  let peakSlot = _getPeakCache(gridXyz, gateFp, K)
  if (!peakSlot) {
    const invCp = 1 / Math.max(visualCp, 1e-3)
    const acc = _ensureAccBuffers(nPoints)
    const accX = acc.cx
    const accY = acc.cy
    const accZ = acc.cz
    accX.fill(0)
    accY.fill(0)
    accZ.fill(0)
    const arrival = new Float32Array(nPoints).fill(Infinity)
    const nS = src.length
    for (let s = 0; s < nS; s++) {
      const srcS = src[s]
      const sx = srcS.x
      const sy = srcS.y
      const sz = srcS.z
      const dS = srcS.delay
      const coef = srcS.coef
      const base = s * nPoints
      // 反射条目接收侧门控（与瞬时场一致）
      const gate = srcS.gate
      const gAx = gate ? _GATE_AXIS[gate.axis] : -1
      const gMin = gate ? gate.min : 0
      for (let i = 0; i < nPoints; i++) {
        if (gAx >= 0 && gridXyz[i * 3 + gAx] < gMin) continue
        const r = distTable[base + i]
        const arr = dS + r * invCp
        if (arr < arrival[i]) arrival[i] = arr // 任意源（含反射波）波前到达即计入
        const a = coef * distPow[base + i]
        const inv = 1 / Math.max(r, 1e-6)
        accX[i] += a * (gridXyz[i * 3 + 0] - sx) * inv
        accY[i] += a * (gridXyz[i * 3 + 1] - sy) * inv
        accZ[i] += a * (gridXyz[i * 3 + 2] - sz) * inv
      }
    }
    const zonesPre = new Int8Array(nPoints)
    const peakPre = new Float32Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      const vx = accX[i]
      const vy = accY[i]
      const vz = accZ[i]
      const mps = Math.sqrt(vx * vx + vy * vy + vz * vz)
      // 与后端同口径：峰值场 × env；分区判据 digitize(peak × env × atten)（cm/s）
      const dmin = dminArr ? dminArr[i] : 0
      const env = dminArr ? _radialEnv(dmin, influenceRadius) : 1
      const atten = dminArr ? _damageAtten(dmin, damageMaxRadius) : 1
      peakPre[i] = mps * env
      const cm = mps * env * atten * 100.0
      let zone = 0
      for (let th = 0; th < DAMAGE_THRESHOLDS_CMPS.length; th++) {
        if (cm >= DAMAGE_THRESHOLDS_CMPS[th]) zone = th + 1
      }
      zonesPre[i] = zone
    }
    peakSlot = _setPeakCache(gridXyz, gateFp, K, zonesPre, arrival, peakPre)
  }

  return peakSlot
}

/**
 * 多源模式损伤分区（基于各源"几何峰值矢量叠加"，波前到达门控，确定性算法）
 *
 * 与单源 computePeakDamageZones 同语义：损伤是不可逆的峰值判据（无时间衰减）。
 * 对多源，该点的损伤强度取 N 个源各自峰值 PPV 的**矢量叠加**模长（峰值同向时相长、
 * 异向时相消，反映布孔几何），并仅以"任意源波前是否到达（t ≥ min_s(delay_s + r_s/c̄)）"
 * 作门控——未到达处 0（弹性）。结果随 (t, 源几何) 确定，正放/回拉/拖进度条一致。
 *
 * 空源时退化为单源（= computePeakDamageZones），向后兼容。
 *
 * @param {Float32Array} gridXyz - 网格坐标 (N×3)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - { K, alpha, minStandoff, visualCp, sources }
 * @param {Int8Array} [out] - 复用输出缓冲区
 * @returns {Int8Array} 分区 id 数组 0~4
 */
export function computeMultiSourcePeakDamageZones(gridXyz, t, options = {}, out = null) {
  const slot = _ensurePeakSlot(gridXyz, options)
  if (!slot) {
    return computePeakDamageZones(gridXyz, options.chargeKg ?? 100, t, options, out)
  }
  const nPoints = gridXyz.length / 3
  const zones = out ?? new Int8Array(nPoints)
  const zonesPre = slot.zones
  const arrival = slot.arrival
  for (let i = 0; i < nPoints; i++) {
    zones[i] = t >= arrival[i] ? zonesPre[i] : 0
  }
  return zones
}

/**
 * 多源峰值 PPV 包络场（m/s）：几何峰值矢量叠加模长 × env(influenceRadius)，
 * 按"最早到达"门控。与 computeMultiSourcePeakDamageZones 共用峰值缓存槽
 * （同一次正演同时产出连续峰值场与离散分区），空源时退化到 computePeakField3d。
 *
 * 用途：应力反演（computeStressFieldFromPpv）的输入。以峰值包络而非瞬时振速
 * 作输入，使"应力场 = 峰值判据场"，与"振速场 = 瞬时波形"空间结构不同。
 *
 * @param {Float32Array} gridXyz - 网格坐标 (N×3)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - { K, alpha, minStandoff, visualCp, sources, influenceRadius }
 * @param {Float32Array} [out] - 复用输出缓冲区
 * @returns {Float32Array} 峰值 PPV 场 (m/s)
 */
export function computeMultiSourcePeakField3d(gridXyz, t, options = {}, out = null) {
  const slot = _ensurePeakSlot(gridXyz, options)
  if (!slot) {
    return computePeakField3d(gridXyz, options.chargeKg ?? 100, t, options, out)
  }
  const nPoints = gridXyz.length / 3
  const res = out ?? new Float32Array(nPoints)
  const peak = slot.peak
  const arrival = slot.arrival
  for (let i = 0; i < nPoints; i++) {
    res[i] = t >= arrival[i] ? peak[i] : 0
  }
  return res
}

/**
 * 单源峰值 PPV 包络场（m/s）：sadoskyPpv × env(influenceRadius)，按 r/visualCp
 * 到达门控。与 computePeakDamageZones 同口径（后者再乘 atten 并 digitize）。
 *
 * @param {Float32Array} gridXyz - 网格坐标 (N×3)
 * @param {number} chargeKg - 总装药量(kg)
 * @param {number} t - 当前模拟时间(s)
 * @param {Object} options - { K, alpha, minStandoff, visualCp, influenceRadius, origin }
 * @param {Float32Array} [out] - 复用输出缓冲区
 * @returns {Float32Array} 峰值 PPV 场 (m/s)
 */
export function computePeakField3d(gridXyz, chargeKg, t, options = {}, out = null) {
  const K = options.K ?? 30.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
  const origin = options.origin ?? null
  const ox = origin ? Number(origin[0]) || 0 : 0
  const oy = origin ? Number(origin[1]) || 0 : 0
  const oz = origin ? Number(origin[2]) || 0 : 0

  const nPoints = gridXyz.length / 3
  const res = out ?? new Float32Array(nPoints)

  for (let i = 0; i < nPoints; i++) {
    const dx = gridXyz[i * 3 + 0] - ox
    const dy = gridXyz[i * 3 + 1] - oy
    const dz = gridXyz[i * 3 + 2] - oz
    const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), minStandoff)
    if (t < r / visualCp) {
      res[i] = 0
      continue
    }
    res[i] = sadoskyPpv(chargeKg, r, { K, alpha, minStandoff }) * _radialEnv(r, influenceRadius)
  }
  return res
}

/**
 * 计算岩体表面顶点集上的"峰值场 + 波前到达时刻"（等值线提取的数据源）。
 *
 * 与 GPU 岩面着色（sceneBuilder BENCH_FIELD_FRAGMENT_SHADER）完全同口径：
 *   peak(p) = |Σ_s dir_s · K·(q_s^(1/3)/r_s)^α| · occ(p−origin) · agn(p−origin)
 *   arrival(p) = min_s (delay_s + r_s / c̄)
 * 其中洞身遮挡 occ 与轴向增益 agn 是 GPU 侧的波场整形（洞腔截断 + 沿巷道
 * 延展），必须同样施加，否则等值线与热力图色带错位。峰值场与 t 无关 →
 * 每个爆破事件/参数变更只需计算一次；等值线几何随之静态，动画期仅在
 * 渲染侧按 arrival 门控显隐（无逐帧 CPU 重算、无闪烁）。
 *
 * 空源时退化为单一 origin 源（总装药量），与 GPU 单源分支一致。
 *
 * @param {Float32Array} surfaceXyz - 表面顶点坐标（grid 局部系，N×3）
 * @param {Object} options - { K, alpha, minStandoff, visualCp, chargeKg,
 *                             sources, origin, holeRadius, holeLen, lateralAttn }
 * @returns {{peak: Float32Array, arrival: Float32Array}} 峰值 PPV（m/s，含 occ×agn）与最早到达时刻（s）
 */
export function computeSurfacePeakField(surfaceXyz, options = {}) {
  const K = options.K ?? 30.0
  const alpha = options.alpha ?? 1.5
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  // 径向能量包络（与后端 peak_ppv_envelope_multi 同口径；GPU 岩面着色 peak *= env 同步）
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
  const origin = options.origin ?? [0, 0, 0]
  const ox = Number(origin[0]) || 0
  const oy = Number(origin[1]) || 0
  const oz = Number(origin[2]) || 0
  const holeRadius = Number(options.holeRadius) > 0 ? Number(options.holeRadius) : 9
  const holeLen = Number(options.holeLen) > 0 ? Number(options.holeLen) : 2.5
  const lateralAttn = Number(options.lateralAttn) > 0 ? Number(options.lateralAttn) : 0.95

  // —— 洞身遮挡/轴向增益（GLSL holeOcclusion/axialGain 的 JS 移植，逐点常数）——
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  const holeOcclusion = (px, py, pz) => {
    const Plen = Math.sqrt(px * px + py * py + pz * pz)
    if (Plen < 1e-3) return 1
    const ax = pz / Plen
    const sinT = Math.sqrt(Math.max(1 - ax * ax, 0))
    if (sinT < 1e-3) return 1
    const aHit = ax * (holeRadius / sinT)
    let inLen = 1 - smoothstep(holeLen - 0.6, holeLen + 0.6, aHit)
    const axialIn = smoothstep(-0.35, 0.35, ax)
    inLen = Math.min(1, Math.max(0, inLen * axialIn))
    const cross = smoothstep(0.02, 0.35, sinT)
    const occInside = 0.72 + (1.06 - 0.72) * (1 - cross)
    return 1 + (occInside - 1) * inLen
  }
  const axialGain = (px, py, pz) => {
    const Plen = Math.sqrt(px * px + py * py + pz * pz) || 1
    const ax = Math.abs(pz / Plen)
    return lateralAttn + (1 - lateralAttn) * smoothstep(0, 0.55, ax)
  }

  const nPoints = surfaceXyz.length / 3
  const peak = new Float32Array(nPoints)
  const arrival = new Float32Array(nPoints).fill(Infinity)

  const sources = (options.sources || []).filter(s => Number(s.chargeKg) > 0)
  if (sources.length === 0) {
    // 单源退化：源在 origin（掏槽孔质心），总装药量
    const q = Math.max(0.001, Number(options.chargeKg) || 100)
    const coef = K * Math.pow(q, alpha / 3) * 0.01
    const invCp = 1 / Math.max(visualCp, 1e-3)
    for (let i = 0; i < nPoints; i++) {
      const px = surfaceXyz[i * 3] - ox
      const py = surfaceXyz[i * 3 + 1] - oy
      const pz = surfaceXyz[i * 3 + 2] - oz
      const r = Math.max(Math.sqrt(px * px + py * py + pz * pz), minStandoff)
      arrival[i] = r * invCp
      peak[i] =
        coef *
        Math.pow(r, -alpha) *
        holeOcclusion(px, py, pz) *
        axialGain(px, py, pz) *
        tunnelFaceBoostFactor(
          [surfaceXyz[i * 3], surfaceXyz[i * 3 + 1], surfaceXyz[i * 3 + 2]],
          options.tunnelFace
        ) *
        _radialEnv(r, influenceRadius)
    }
    return { peak, arrival }
  }

  const src0 = sources.map(s => {
    const q = Number(s.chargeKg)
    return {
      x: Number(s.x) || 0,
      y: Number(s.y) || 0,
      z: Number(s.z) || 0,
      chargeKg: q,
      delay: (Number(s.delayMs) || 0) / 1000,
      coef: K * Math.pow(q, alpha / 3) * 0.01
    }
  })
  // 等值线是峰值场，必须与 GPU 岩面着色同一物理口径（含自由面反射镜象源）：
  // 近掌子面反射放大在等值线上应呈现为靠近轮廓处的扭曲/梯度剧变。surface
  // 顶点集点少，全部源都生成反射项（无上限）。
  const src = expandSourcesWithReflections(src0, options.reflections, 0)

  const cache = _getDistCache(surfaceXyz, src, minStandoff, visualCp, alpha)
  const distTable = cache.dist
  const distPow = cache.distPow
  // 门控用 dmin（到最近真实装药源距离；distTable 前 src0.length 条恰为真实源）
  const dminArr =
    influenceRadius > 0 ? _dminFromDistTable(distTable, src0.length, nPoints) : null
  const acc = _ensureAccBuffers(nPoints)
  const accX = acc.cx
  const accY = acc.cy
  const accZ = acc.cz
  accX.fill(0)
  accY.fill(0)
  accZ.fill(0)
  const invCp = 1 / Math.max(visualCp, 1e-3)
  const nS = src.length
  for (let s = 0; s < nS; s++) {
    const srcS = src[s]
    const sx = srcS.x
    const sy = srcS.y
    const sz = srcS.z
    const dS = srcS.delay
    const coef = srcS.coef
    const base = s * nPoints
    const gate = srcS.gate
    const gAx = gate ? _GATE_AXIS[gate.axis] : -1
    const gMin = gate ? gate.min : 0
    for (let i = 0; i < nPoints; i++) {
      if (gAx >= 0 && surfaceXyz[i * 3 + gAx] < gMin) continue
      const r = distTable[base + i]
      const arr = dS + r * invCp
      if (arr < arrival[i]) arrival[i] = arr
      const a = coef * distPow[base + i]
      const inv = 1 / Math.max(r, 1e-6)
      accX[i] += a * (surfaceXyz[i * 3 + 0] - sx) * inv
      accY[i] += a * (surfaceXyz[i * 3 + 1] - sy) * inv
      accZ[i] += a * (surfaceXyz[i * 3 + 2] - sz) * inv
    }
  }
  for (let i = 0; i < nPoints; i++) {
    const vx = accX[i]
    const vy = accY[i]
    const vz = accZ[i]
    const px = surfaceXyz[i * 3 + 0] - ox
    const py = surfaceXyz[i * 3 + 1] - oy
    const pz = surfaceXyz[i * 3 + 2] - oz
    // 峰值场与 GPU 岩面着色同口径：隧道轮廓自由面放大（face 缺省/coeff=0 返回 1）
    peak[i] =
      Math.sqrt(vx * vx + vy * vy + vz * vz) *
      holeOcclusion(px, py, pz) *
      axialGain(px, py, pz) *
      tunnelFaceBoostFactor(
        [surfaceXyz[i * 3], surfaceXyz[i * 3 + 1], surfaceXyz[i * 3 + 2]],
        options.tunnelFace
      ) *
      (dminArr ? _radialEnv(dminArr[i], influenceRadius) : 1)
  }
  return { peak, arrival }
}

/**
 * 将 3D 场从 (nx, ny, nz) 原始顺序（numpy indexing='ij'）转换为 WebGL Data3DTexture 要求的 x-最快顺序
 * @param {Float32Array} field - 一维展平场，原始顺序 nx×ny×nz（x-最慢，z-最快）
 * @param {number[]} gridShape - [nx, ny, nz]
 * @returns {Float32Array} 转换后场 (nz × ny × nx)，x 在内存中连续最快，与后端 _webgl_flatten_3d 完全一致
 */
export function reorderForWebGL(field, gridShape) {
  const [nx, ny, nz] = gridShape
  const output = new Float32Array(nx * ny * nz)

  // 原始：field[x*ny*nz + y*nz + z] → (nx, ny, nz)
  // WebGL 需要：output[z*ny*nx + y*nx + x] → (nz, ny, nx)，即转置 (2, 1, 0)
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        const srcIdx = x * ny * nz + y * nz + z
        const dstIdx = z * ny * nx + y * nx + x
        output[dstIdx] = field[srcIdx]
      }
    }
  }

  return output
}

/**
 * 本地振动模拟器类，管理网格、逐帧更新、数据推送
 */
export class LocalVibrationSimulator {
  /**
   * @param {Object} options - 模拟参数
   * @param {number} options.chargeKg - 总装药量(kg)
   * @param {number} options.tunnelWidth - 隧道宽度(m)
   * @param {number} options.tunnelHeight - 隧道总高度(m)
   * @param {number} [options.lengthZ=40] - 轴向长度(m)
   * @param {number} [options.nx=48] - X 网格数
   * @param {number} [options.ny=48] - Y 网格数
   * @param {number} [options.nz=72] - Z 网格数
   *
   *   分辨率说明（性能修复）：多装药源模式下，每帧需对 网格点数 × 源数 做同步
   *   矢量叠加。原默认 96×96×192=177 万点·源/帧，会把主线程阻塞到秒级（动画卡死）。
   *   现将默认降到 48×48×72=16.6 万点，且 (点,源) 的距离场由 _getDistCache 一次性
   *   预计算、之后逐时刻重算直接查表（省去每次 nS×nPts 次的 sqrt）。热力图是光滑场，
   *   该分辨率仍保留波场干涉形态，而每次全量重算耗时约降到原来的 1/5~1/7。
   * @param {number} [options.K=30] - 萨道夫斯基 K（已针对隧道尺度可视化校准，见下方说明）
   * @param {number} [options.alpha=1.5] - 萨道夫斯基 alpha
   * @param {number} [options.beta=0.02] - 阻尼系数
   * @param {number} [options.cp=4500] - 纵波速度
   * @param {number} [options.rho=2650] - 岩体密度
   * @param {number} [options.nu=0.25] - 泊松比
   * @param {number[]} [options.origin] - 爆心在网格局部坐标系中的坐标 [x,y,z]（如掏槽孔质心
   *                [x, y, faceOffset]），缺省 [0,0,0]
   */
  constructor(options) {
    this.chargeKg = options.chargeKg ?? 100
    this.tunnelWidth = options.tunnelWidth ?? 18
    this.tunnelHeight = options.tunnelHeight ?? 15
    this.lengthZ = options.lengthZ ?? 40
    this.nx = options.nx ?? 48
    this.ny = options.ny ?? 48
    this.nz = options.nz ?? 72
    // 爆心（网格局部坐标，缺省网格原点）——应力波/损伤从实际爆破位置（掏槽孔质心）扩散
    this._origin = Array.isArray(options.origin) ? options.origin.map(Number) : null
    // 多装药源：由实际炮孔布孔（楔形掏槽等）推算的装药源列表 [{x,y,z,chargeKg,delayMs}]。
    // 提供时启用多源矢量叠加（多应力波干涉波场）；为空则退化为单源（原行为）。
    this._sources = Array.isArray(options.sources) ? options.sources : null
    // 显式边界（与 WS 网格对齐时传入；null 则按隧道尺寸推导对称边界）
    this._explicitBounds =
      options.boundsMin && options.boundsMax
        ? { boundsMin: options.boundsMin, boundsMax: options.boundsMax }
        : null

    // 岩体与萨道夫斯基参数
    // K 默认取 30（而非工程常用 200）：本体积盒尺度为隧道局部（宽度≤18m、纵深≤40m），
    // 若 K=200，按 Q=100kg 计算即使盒最远角（≈42m）PPV 仍约 22 cm/s，远超 PPV 色阶上限
    // 15 cm/s，导致整个体积盒饱和成一片红（用户看到的"红色方形"），应力/损伤也被淹没。
    // K=30 时近爆心 PPV 仍达数十 cm/s（破碎/抛掷区，红），远场衰减至 ~1 cm/s（蓝），
    // 呈现"近红→中绿→远蓝"的球面梯度，使 PPV/应力/损伤三模式均能正确分级显示。
    this.params = {
      K: options.K ?? 30,
      alpha: options.alpha ?? 1.5,
      beta: options.beta ?? 0.02,
      visualBeta: options.visualBeta ?? 0.8, // 可视化时变衰减（波峰回落实时速度）
      cp: options.cp ?? 4500,
      visualCp: options.visualCp ?? 35, // 波前可视传播速度（见 computePpvField3d 注释）
      // 波动相位载波（Hz，0=关）：瞬时质点速度 × cos(2πf·gap)。爆破碎破振动
      // 的瞬时振速是正负交替的振荡波形（波峰/波谷随波前推进）；但 PPV 场/应力
      // 反演/点选采样都需要"模长恒正"的标量场，载波只在 GPU 着色器（uCarrierHz）
      // 与用户显式开启的"艺术化渲染"路径生效。默认 0=关（与 GPU/UI 默认一致）：
      // 物理干涉由多源矢量叠加（各炮孔延期差+路径差）本身产生，无需载波伪影。
      carrierHz: Number(options.carrierHz) > 0.5 ? Number(options.carrierHz) : 0,
      // 空间门控（与后端 influence_radius / damage_max_radius 同口径）：
      // PPV/峰值场 × env(influenceRadius)（tau=3m）；损伤分区再乘 atten(damageMaxRadius)
      // （tau=1.5m）。由 blastingManager 透传（滑块可调），缺省 0=关。
      influenceRadius: Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0,
      damageMaxRadius: Number(options.damageMaxRadius) > 0 ? Number(options.damageMaxRadius) : 0,
      // 隧道马蹄形轮廓自由面放大配置（与 GPU uFaceBoost 同口径；null=关）
      tunnelFace: options.tunnelFace || null,
      rho: options.rho ?? 2650,
      nu: options.nu ?? 0.25,
      minStandoff: 0.5,
      // 近场几何修正（应力场专用，见模块头 NEAR_FIELD_* 注释）：
      // 交叉半径缺省由装药量反算（r_nf = MULT × 空腔半径），可被外部覆盖。
      nearFieldRadius:
        Number(options.nearFieldRadius) > 0
          ? Number(options.nearFieldRadius)
          : nearFieldRadius(options.chargeKg ?? 100),
      nearFieldGain:
        Number(options.nearFieldGain) > 0 ? Number(options.nearFieldGain) : NEAR_FIELD_GAIN,
      // 爆心（掏槽孔质心）；computePpvField3d / computePeakDamageZones 均以该点为波源
      origin: this._origin,
      // 多装药源：提供时 computeAtTime 走多源矢量叠加（多应力波干涉波场）
      sources: this._sources,
      // 自由面反射（镜象源法）：掌子面/临空面自由边界对波场的反射参与计算。
      // 默认按"爆心所在掌子面"近似：反射面 z = origin.z（掌子面轴向位置）。
      reflections:
        Array.isArray(options.reflections) && options.reflections.length
          ? options.reflections
          : this._origin
            ? [{ axis: 'z', value: Number(this._origin[2]) || 0, coeff: 0.85 }]
            : null
    }

    // 预计算网格
    const grid = buildPpvGrid(
      this.tunnelWidth,
      this.tunnelHeight,
      this.lengthZ,
      this.nx,
      this.ny,
      this.nz,
      this._explicitBounds
    )
    this.gridXyz = grid.gridXyz
    this.gridShape = grid.gridShape
    this.boundsMin = grid.boundsMin
    this.boundsMax = grid.boundsMax

    // 缓存上一帧计算结果
    this._lastT = -1
    this._cachedPpv = null
    this._cachedSigmaVm = null
    this._cachedZones = null

    // 预分配输出缓冲区（computeAtTime 每帧调用，避免 new Float32Array(65536)×2 + Int8Array(65536) 导致 GC 压力）
    const nPoints = this.nx * this.ny * this.nz
    this._ppvBuf = new Float32Array(nPoints)
    this._peakBuf = new Float32Array(nPoints)
    this._sigmaBuf = new Float32Array(nPoints)
    this._zoneBuf = new Int8Array(nPoints)
    // 各网格点到爆心的距离(m)：应力近场几何修正用。网格与爆心在整个生命周期内
    // 不变 → 预计算一次，避免每帧再算一遍 O(N) 开方。
    const origin = this._origin
    const ox = origin ? Number(origin[0]) || 0 : 0
    const oy = origin ? Number(origin[1]) || 0 : 0
    const oz = origin ? Number(origin[2]) || 0 : 0
    this._gridR = new Float32Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      const dx = this.gridXyz[i * 3] - ox
      const dy = this.gridXyz[i * 3 + 1] - oy
      const dz = this.gridXyz[i * 3 + 2] - oz
      this._gridR[i] = Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }

  /** 获取网格信息（供渲染器初始化） */
  getGridInfo() {
    return {
      gridShape: this.gridShape,
      boundsMin: this.boundsMin,
      boundsMax: this.boundsMax
    }
  }

  /**
   * 计算指定时刻的三场数据（PPV/应力/损伤）
   * @param {number} t - 模拟时间(s)
   * @returns {Object} { ppv: Float32Array, sigmaVm: Float32Array, zones: Int8Array }
   *          输出已按 WebGL 轴序（x-最快）排列，可直接传给 blastVibrationFieldRenderer
   *
   * 轴序说明：buildPpvGrid 生成的 gridXyz 已是 x-最快（zi 最外层、xi 最内层，
   * idx = zi*ny*nx + yi*nx + xi），computePpvField3d / computeStressFieldFromPpv /
   * classifyDamageZones 均逐点保持该顺序。该顺序与后端 pack_ppv_binary 中
   * np.transpose(2,1,0) 后的 WebGL 布局完全一致，因此这里不能再调用 reorderForWebGL
   * （它假设输入为 x-最慢），否则会二次转置导致数据错乱。
   */
  computeAtTime(t) {
    // 全量计算（增量优化意义不大，网格不大，直接计算可保证精度）
    // 复用预分配缓冲区，避免每帧 576KB 临时数组分配导致 GC 压力
    const multi = Array.isArray(this.params.sources) && this.params.sources.length > 0
    const ppv = multi
      ? computeMultiSourcePpvField3d(this.gridXyz, t, this.params, this._ppvBuf)
      : computePpvField3d(this.gridXyz, this.chargeKg, t, this.params, this._ppvBuf)
    // 应力场由**瞬时振速**反演 + 近场几何修正 F(r)——与 GPU shader 解析支
    // （mps × stressFactor × F(r)）同口径，保证波前/梯度清晰可见。
    // 【勿改回峰值包络】峰值场是静态云图，会丢失波前时间结构
    // （用户实测："巨大的黄色高斯云，缺乏波场结构"）。
    // 与振速场的区别来自近场项 F(r)（局部、温和）+ 独立标定的满量程
    // （σ_ref 锚在场最大值，见 blastingManager._computeAutoFieldRefs）。
    const sigmaVm = computeStressFieldFromPpv(ppv, this.params, this._sigmaBuf, this._gridR)
    // 损伤分区：按"波峰几何峰值 × 波前到达门控"（computePeakDamageZones / 多源版）——
    // 确定性算法，与播放方向无关：正放/回拉/拖进度条同一时刻结果一致，
    // 波前到达处显示常驻五色分区、未到达处 0（修复回拉进度条时序错乱）。
    const zones = multi
      ? computeMultiSourcePeakDamageZones(this.gridXyz, t, this.params, this._zoneBuf)
      : computePeakDamageZones(this.gridXyz, this.chargeKg, t, this.params, this._zoneBuf)

    this._lastT = t
    this._cachedPpv = ppv
    this._cachedSigmaVm = sigmaVm
    this._cachedZones = zones

    return { ppv, sigmaVm, zones }
  }

  /**
   * 重设多装药源（切换爆破事件/炮孔布孔时调用）。
   * 更新 params.sources 并使下一帧重算（清除缓存）。
   * 传入空数组/null 则退化为单源模式。
   * @param {Array|null} sources - [{x,y,z,chargeKg,delayMs}]
   */
  setSources(sources) {
    this._sources = Array.isArray(sources) && sources.length > 0 ? sources : null
    this.params.sources = this._sources
    this._lastT = -1
    this._cachedPpv = null
    this._cachedSigmaVm = null
  }

  /**
   * 重置损伤状态（保留 API 兼容：损伤分区已改为"峰值×到达门控"的确定性算法，
   * 输出只与当前时刻 t 有关，不再跨帧累积，故无需额外状态清理）。
   */
  resetPeak() {
    // 确定性算法下无需清理；保留空实现以兼容外部调用（循环回卷/seek 跳变）。
  }

  /** 是否已初始化 */
  get isReady() {
    return !!this.gridXyz && this.gridXyz.length > 0
  }
}

/**
 * 振动场计算 Web Worker 客户端
 *
 * 把 LocalVibrationSimulator 中最重的逐帧计算（多源矢量叠加 PPV/应力/损伤场）
 * 卸载到 Worker 线程，避免主线程因"网格点数×源数×幂/指数"计算卡死动画。
 * 使用 Transferable 零拷贝取回结果；同一时刻只允许一个 compute 请求在途，
 * requestId 用于识别并丢弃过期的中途结果。
 */
export class VibrationComputeClient {
  constructor() {
    this._worker = null
    this._simKey = null // 绑定的 sim 实例引用（识别是否需要重新 config）
    this._configSig = null // 已下发 Worker 的物理参数签名（K/α/网格/源数），变化时重配
  }

  get isWorkerAvailable() {
    return this._worker != null
  }

  /** 计算已下发配置的参数签名（K/α/介质/网格/源数；setSadoskyParams 原地改参后据此重配） */
  _signature(sim) {
    const p = sim.params
    return [
      sim.gridXyz ? sim.gridXyz.length : 0,
      Number(p.K),
      Number(p.alpha),
      Number(p.beta),
      Number(p.visualBeta),
      Number(p.visualCp),
      sim.chargeKg,
      Array.isArray(p.sources) ? p.sources.length : 0,
      Number(p.carrierHz) || 0,
      Number(p.influenceRadius) || 0,
      Number(p.damageMaxRadius) || 0,
      Array.isArray(p.reflections)
        ? p.reflections
            .map(r => `${r.axis}:${Number(r.value).toFixed(3)}:${Number(r.coeff).toFixed(3)}`)
            .join(',')
        : 'none'
    ].join('|')
  }

  /**
   * 确保 Worker 已启动并为本 sim 配备好网格/参数（只在 sim 或参数变化时重新 config）。
   * @param {LocalVibrationSimulator} sim
   * @returns {boolean} Worker 是否就绪（不可用时返回 false，供调用方回退同步计算）
   */
  ensure(sim) {
    if (!sim || !sim.gridXyz) return false
    const sig = this._signature(sim)
    if (this._worker && this._simKey === sim && this._configSig === sig) return true
    if (!this._worker) {
      try {
        this._worker = new Worker(new URL('./vibrationComputeWorker.js', import.meta.url), {
          type: 'module'
        })
      } catch (err) {
        this._worker = null
        console.warn('[VibrationComputeClient] Worker 启动失败，回退主线程计算', err)
        return false
      }
    }
    this._simKey = sim
    this._configSig = sig
    this._postConfig(sim)
    return true
  }

  _postConfig(sim) {
    // params 深拷贝一份发给 Worker（worker 侧不可变）；含 sources（多装药源）与萨道夫斯基参数
    const params = {
      ...sim.params,
      sources: Array.isArray(sim.params.sources) ? sim.params.sources.map(s => ({ ...s })) : null,
      origin: sim.params.origin ? sim.params.origin.slice() : null
    }
    this._worker.postMessage({
      type: 'config',
      gridXyz: sim.gridXyz,
      params,
      chargeKg: sim.chargeKg
    })
    // 注意：gridXyz 故意不进行 Transferable 转移——主线程 sim 仍需自身 gridXyz
    // 做同步回退计算(computeAtTime)，转移会 detach 主线程侧缓冲。仅每次 sim 变化
    // config 一次，结构化克隆 3D 坐标（~数 MB）开销可忽略。
  }

  /**
   * 请求计算某时刻三场数据（异步）。
   * @param {number} t - 模拟时间(s)
   * @param {number} requestId - 调用方自增 id，用于在回调中丢弃过期结果
   * @returns {Promise<{ppv:Float32Array,sigmaVm:Float32Array,zones:Int8Array,t:number,requestId:number}> | null}
   */
  compute(t, requestId) {
    if (!this._worker) return null
    return new Promise(resolve => {
      const handler = e => {
        const d = e.data
        if (!d || d.type !== 'result') return
        if (d.requestId !== requestId) return // 过期结果，丢弃
        this._worker.removeEventListener('message', handler)
        this._worker.removeEventListener('error', handler)
        resolve({ ppv: d.ppv, sigmaVm: d.sigmaVm, zones: d.zones, t: d.t, requestId: d.requestId })
      }
      const error = err => {
        this._worker.removeEventListener('message', handler)
        resolve(null) // 计算失败回退：调用方应自行兜底
        console.warn('[VibrationComputeClient] Worker 计算错误', err)
      }
      this._worker.addEventListener('message', handler)
      this._worker.addEventListener('error', error)
      this._worker.postMessage({ type: 'compute', t, requestId })
    })
  }

  /**
   * 下发岩面顶点集与洞身整形参数（等值线峰值场数据源）。
   * 表面坐标应为 grid 局部系（与世界→局部的换算在 sceneBuilder 侧完成）。
   * @param {Float32Array} surfaceXyz - 表面顶点 (N×3, grid 局部系)
   * @param {Object} shaping - { holeRadius, holeLen, lateralAttn, origin }
   */
  contourConfig(surfaceXyz, shaping) {
    if (!this._worker) return
    this._worker.postMessage({
      type: 'contourConfig',
      surfaceXyz,
      shaping: shaping || null
    })
  }

  /**
   * 请求岩面顶点峰值场 + 到达时刻（异步；结果与 t 无关，Worker 内缓存）。
   * @param {number} requestId - 调用方自增 id，过期结果在回调中丢弃
   * @returns {Promise<{peak:Float32Array,arrival:Float32Array,requestId:number}> | null}
   */
  computeContour(requestId) {
    if (!this._worker) return null
    return new Promise(resolve => {
      const handler = e => {
        const d = e.data
        if (!d || d.type !== 'contourData') return
        if (d.requestId !== requestId) return
        this._worker.removeEventListener('message', handler)
        this._worker.removeEventListener('error', handler)
        resolve({ peak: d.peak, arrival: d.arrival, requestId: d.requestId })
      }
      const error = () => {
        this._worker.removeEventListener('message', handler)
        resolve(null)
      }
      this._worker.addEventListener('message', handler)
      this._worker.addEventListener('error', error)
      this._worker.postMessage({ type: 'contourCompute', requestId })
    })
  }

  /** 丢弃未决结果并断开 Worker（场景重建/销毁时调用） */
  dispose() {
    if (this._worker) {
      this._worker.terminate()
      this._worker = null
    }
    this._simKey = null
  }
}

/**
 * 振动传播粒子系统（粒子跟随波前扩散，增强可视化效果）
 * 每个粒子沿径向从爆心向外运动，速度接近纵波速度，存活时间与波前位置匹配
 */
export class VibrationParticleSystem {
  /**
   * @param {number} maxParticles - 最大粒子数
   */
  constructor(maxParticles = 500) {
    this.maxParticles = maxParticles
    this.particles = [] // { x, y, z, vx, vy, vz, birthT, lifetime, size, alpha }
    this._rng = Math.random
  }

  /**
   * 在爆心附近发射一批粒子，沿径向扩散
   * @param {number} t - 当前发射时间
   * @param {number} count - 发射数量
   * @param {number} _cp - 纵波速度(m/s)（未使用，保留用于API一致性）
   */
  emitBurst(t, count, _cp = 4500) {
    // 视觉速度：波前粒子用于可视化，与热力图波前可视速度（visualCp≈35m/s）匹配，
    // 使粒子始终跟随波前在视野内扩散，形成可见的振动传播效果。
    const visualSpeed = 35 + 15 * this._rng() // 35~50 m/s
    for (let i = 0; i < count && this.particles.length < this.maxParticles; i++) {
      // 均匀采样球面方向
      const theta = this._rng() * 2 * Math.PI
      const phi = Math.acos(2 * this._rng() - 1)
      const speed = visualSpeed * (0.8 + 0.4 * this._rng()) // 散射
      const vx = speed * Math.sin(phi) * Math.cos(theta)
      const vy = speed * Math.sin(phi) * Math.sin(theta)
      const vz = speed * Math.cos(phi)

      // 从爆心（原点）附近发射
      const r0 = 0.5 + 2 * this._rng() // 0.5~2.5m 初始半径
      const x0 = r0 * Math.sin(phi) * Math.cos(theta)
      const y0 = r0 * Math.sin(phi) * Math.sin(theta)
      const z0 = r0 * Math.cos(phi)

      this.particles.push({
        x: x0,
        y: y0,
        z: z0,
        vx,
        vy,
        vz,
        birthT: t,
        lifetime: 1.5 + 1.5 * this._rng(), // 存活 1.5~3s，覆盖整个体积盒扩散过程
        size: 3.0 + 8.0 * this._rng(), // 像素大小（点精灵）
        alpha: 0.6 + 0.4 * this._rng()
      })
    }
  }

  /**
   * 更新粒子位置，淘汰过期粒子
   * @param {number} t - 当前时间(s)
   * @param {number} dt - 时间步长(s)
   */
  update(t, dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      const age = t - p.birthT
      if (age > p.lifetime) {
        this.particles.splice(i, 1)
        continue
      }
      // 简单匀速运动（阻尼可忽略，粒子寿命很短）
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      // alpha 随年龄衰减
      p.alpha = (1 - age / p.lifetime) * p.alpha
    }
  }

  /** 清除所有粒子 */
  clear() {
    this.particles.length = 0
  }

  /** 获取当前活跃粒子 */
  get activeParticles() {
    return this.particles
  }
}

export default {
  buildPpvGrid,
  sadoskyPpv,
  computePpvField3d,
  computeStressFieldFromPpv,
  classifyDamageZones,
  computePeakDamageZones,
  resolveChargePosition,
  buildChargeSources,
  normalizeReflections,
  expandSourcesWithReflections,
  computeMultiSourcePpvField3d,
  computeMultiSourcePeakDamageZones,
  computeMultiSourcePeakField3d,
  computePeakField3d,
  nearFieldRadius,
  cavityRadius,
  nearFieldGain,
  computeSurfacePeakField,
  computeMonitorTimeHistory,
  computePointVector,
  computePpvDecayProfile,
  reorderForWebGL,
  LocalVibrationSimulator,
  VibrationParticleSystem,
  VibrationComputeClient
}
