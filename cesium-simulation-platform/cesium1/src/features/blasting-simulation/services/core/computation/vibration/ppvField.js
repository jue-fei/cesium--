/**
 * PPV 场核心（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * 单源/多源瞬时 PPV 场（computePpvField3d / computeMultiSourcePpvField3d）、
 * 单源/多源峰值包络场（computePeakField3d / computeMultiSourcePeakField3d）、
 * von Mises 应力反演（computeStressFieldFromPpv）、装药源解析
 * （resolveChargePosition / buildChargeSources）与峰值缓存槽 _ensurePeakSlot
 * （亦供 damage.js 多源损伤分区复用）。
 */

import {
  LOCAL_SIM_DEFAULT_ALPHA,
  LOCAL_SIM_DEFAULT_K,
  DAMAGE_THRESHOLDS_CMPS,
  NEAR_FIELD_GAIN,
  WAVELET_Q,
  _REFL_MAX_SOURCES,
  _GATE_AXIS,
  _dminFromDistColumns,
  _dminFromDistTable,
  _ensureAccBuffers,
  _getDistCache,
  _radialEnv,
  _staggeredPeakAccumulate,
  expandSourcesWithReflections,
  nearFieldGain,
  normalizeReflections,
  sadoskyPpv,
  tunnelFaceBoostFactor
} from './shared.js'

// 峰值损伤预计算缓存：峰值几何场（矢量叠加模长→分区）与最早到达时刻均与 t
// 无关，只依赖 (点集, 源几何, K/α/minStandoff/visualCp) → 一次预计算，逐时刻 O(N) 门控。
// 同距离缓存一样按点集引用多槽（体网格与岩面顶点集共存），并额外保留连续峰值
// 数组 peak（m/s，分区 digitize 之前的原值）——等值线提取需要连续场而非离散档位。
const _PEAK_CACHE_MAX_SLOTS = 4
const _peakCacheMap = new Map()
function _getPeakCache(gridXyz, distFp, K) {
  let slot = _peakCacheMap.get(gridXyz)
  if (slot && slot.fp === distFp && slot.K === K && slot.corePeak) return slot
  return null
}
function _setPeakCache(gridXyz, distFp, K, corePeak, arrival, dmin) {
  if (!_peakCacheMap.has(gridXyz) && _peakCacheMap.size >= _PEAK_CACHE_MAX_SLOTS) {
    const oldest = _peakCacheMap.keys().next().value
    _peakCacheMap.delete(oldest)
  }
  // corePeak/arrival/dmin 与 influenceRadius 无关（O(nS·N) 重算）；peak/zones 为
  // 乘 env 后的派生场（O(N)），按 influenceRadius 挂在槽上二级缓存——滑块拖动
  // 只重跑派生，不触发核心场重算
  const slot = {
    grid: gridXyz,
    fp: distFp,
    K,
    corePeak,
    arrival,
    dmin,
    peak: null,
    zones: null,
    derivedFp: null
  }
  _peakCacheMap.set(gridXyz, slot)
  return slot
}

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
export function computePpvField3d(gridXyz, chargeKg, t, options = {}, out = null) {
  const K = options.K ?? 200.0
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
 * 事件渲染源位置默认取**炮孔孔口/起始点**（collar）：
 *   - 这样热力图波前起点与掌子面上实际炮孔位置完全重合；
 *   - depth/chargeLength 仍作为事件设计属性保留，但不再偷偷把可视源推到孔底。
 *   - 如需研究装药段中点，可由调用方显式传 sourcePositionMode='charge-center'。
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
 * @param {Object} center - 掏槽孔质心 { x, y }（仅 charge-center 模式用于楔形孔向内收敛）
 * @param {Object} [options] - { sourcePositionMode:'collar'|'charge-center' }
 * @returns {{x:number,y:number,z:number,chargeKg:number,delayMs:number,id?:*} | null}
 *          空孔或未装药孔返回 null（不参与应力波源）
 */
export function resolveChargePosition(h, faceOffset, center, options = {}) {
  const q = Number(h.chargeKg)
  if (!(q > 0) || !!h.isEmptyHole) return null

  const type = String(h?.holeType || h?.type || 'production').toLowerCase()
  const isCut = type === 'cut' || type === 'easing'
  const depth = Math.max(0.2, Number(h.depth) || 2.5)
  const cxl = Number(h.chargeLength)
  const cd = Number.isFinite(cxl) && cxl > 0 ? Math.max(0.2, depth - cxl * 0.5) : depth * 0.6
  const inc = Math.max(0, Number(h.inclinationAngle ?? h.inclination) || 0) * (Math.PI / 180)

  const collarX = Number(h.posX) || 0
  const rawY = Number(h.posY)
  // y=0 是合法的底板孔位，不能被误判为"缺省值"而替换成掏槽中心。
  const collarY = Number.isFinite(rawY) ? rawY : center.y
  const collarZ = faceOffset
  const sourcePositionMode = String(options.sourcePositionMode || 'collar').toLowerCase()
  if (sourcePositionMode === 'collar') {
    return {
      x: collarX,
      y: collarY,
      z: collarZ,
      chargeKg: q,
      delayMs: Number(h.delayMs) || 0,
      id: h.id
    }
  }

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
 * @param {Object} [options] - { sourcePositionMode, delayJitterMs, rngSeed, jitterModel, detonatorType }
 *   - sourcePositionMode 默认 collar：源与炮孔孔口一致；charge-center 仅用于显式物理对比。
 *   - delayJitterMs>0：各段雷管起爆延期的蒙特卡洛误差（±σ ms，正态分布）。
 *     按 (rngSeed + 源索引) 确定性产生抖动 → 同一场景每次重建结果一致，
 *     且瞬时场/峰值场/损伤/等值线共用同一批抖动后源（打破完美对称干涉）。
 *   - jitterModel='han2019'（文献驱动，推荐）：σ 逐源按其名义延时取值——韩亮等
 *     《雷管延期误差对地震波叠加降振的概率分析》(振动与冲击 2019, 38(3))
 *     非电毫秒雷管批次回归 σ_base(t)=0.017·t+3.483 ms（段别越高 σ 越大）；
 *     detonatorType='electronic' 时取固定 σ≈1.2ms（数码电子雷管 ≤1ms 精度）。
 *     UI 的 delayJitterMs 作为**锚定缩放**：σ_i = σ_base(t_i)·delayJitterMs/
 *     σ_base(100ms)——默认 5ms 时 100ms 段误差=5ms（与旧常数口径衔接），
 *     短段略小、长段按回归式比例放大；delayJitterMs=0 → 纯理论 σ_base。
 *     jitterModel='off' → 完全关闭抖动（复现精确设计延期）。
 * @returns {Array} 装药源列表 [{x,y,z,chargeKg,delayMs,id}]；无有效源时返回空数组
 */
const HAN2019_A = 0.017
const HAN2019_B = 3.483
const HAN2019_ANCHOR_MS = 100
const ELECTRONIC_SIGMA_MS = 1.2

export function buildChargeSources(holes, faceOffset, cutCenter, options = {}) {
  if (!Array.isArray(holes) || holes.length === 0) return []
  const center = cutCenter || { x: 0, y: 0 }
  const jitterMs = Number(options.delayJitterMs) > 0 ? Number(options.delayJitterMs) : 0
  const jitterModel = String(
    options.jitterModel ?? (jitterMs > 0 ? 'const' : 'han2019')
  ).toLowerCase()
  const detonatorType = String(options.detonatorType || 'nonel').toLowerCase()
  const seedBase = typeof options.rngSeed === 'number' ? options.rngSeed : 12345
  // 韩亮 2019 回归基线 σ_base(t)=0.017·t+3.483；电子雷管固定 σ
  const sigmaBase = t =>
    detonatorType.startsWith('elec') ? ELECTRONIC_SIGMA_MS : HAN2019_A * Math.max(0, t) + HAN2019_B
  // UI 锚定缩放：σ(anchor)=delayJitterMs（未传/为 0 时 scale=1，纯理论口径）
  const anchorScale = jitterMs > 0 ? jitterMs / Math.max(sigmaBase(HAN2019_ANCHOR_MS), 1e-6) : 1.0
  const sources = []
  for (let idx = 0; idx < holes.length; idx++) {
    const s = resolveChargePosition(holes[idx], faceOffset, center, options)
    if (!s) continue
    // 雷管起爆误差：对每段装药的 base delay 叠加确定性高斯抖动
    if (jitterModel === 'han2019') {
      const base = Number(s.delayMs) || 0
      s.delayMs = Math.max(0, base + _seededGauss(seedBase + idx) * sigmaBase(base) * anchorScale)
    } else if (jitterModel === 'const' && jitterMs > 0) {
      const base = Number(s.delayMs) || 0
      s.delayMs = Math.max(0, base + _seededGauss(seedBase + idx) * jitterMs)
    } // jitterModel==='off' → 不抖动
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
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
  const dminArr =
    influenceRadius > 0 ? _dminFromDistTable(distTable, baseSrc.length, nPoints) : null

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
 * von Mises：σ_1=σ_rr（压）、σ_2=σ_3=−σ_θθ（拉）→ σ_vm = σ_rr/(1−μ_d) × F(r)
 * （μ_d 为动态泊松比 ≈0.8μ，见函数内注释；其中 F(r) 为近场几何修正）。
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
  // 动态泊松比（默认开启，与后端 stress_field_from_ppv dynamic_poisson=True 同口径）：
  // 高应变率下 μ_d ≈ 0.8·μ（静态），侧应力系数 b = μ_d/(1−μ_d)——
  // 依据：梁瑞等《球状药包应力波叠加过程的破岩特性》长江科学院院报 2020, 37(4):67-72
  // （λ=μ_d/(1−μ_d)，μ_d=0.8μ；β<arctanλ 切向受压压碎、β≥arctanλ 切向受拉剪裂）；
  // 刘步青《基于可视化的微差爆破应力波叠加及破裂机制研究》（孔间拉应力受泊松效应
  // 控制，是岩桥损伤主因）。ν=0.25：b 0.333→0.286，σ_vm 约 -6.25%。
  const dynamicPoisson = options.dynamicPoisson !== false
  const nuEff = dynamicPoisson ? 0.8 * nu : nu
  // 近场几何修正参数（见模块头 NEAR_FIELD_* 注释）：r_nf<=0 时 F≡1，退化为
  // 纯辐射项（与旧行为数值一致）
  const nfR = Number(options.nearFieldRadius) > 0 ? Number(options.nearFieldRadius) : 0
  const nfG = Number(options.nearFieldGain) > 0 ? Number(options.nearFieldGain) : NEAR_FIELD_GAIN

  const nPoints = ppv.length
  const sigmaVm = out ?? new Float32Array(nPoints)

  // σ_vm = ρ·c_p·v / (1−μ_d) × F(r)——径向压 + 切向拉（幅值 b·σ_rr）的等效应力。
  // 相比旧的弹性一维应变式 σ_vm=σ_rr·(1−2ν)/(1−ν)，本式体现了爆破破坏由
  // 切向拉应力主导的力学机制，数值更贴近实测应力幅值。
  // 注意：传入的 ppv 应为**峰值包络场**（computeMultiSourcePeakField3d），
  // 不是瞬时振速——否则应力场与振速场只差常数（两图相同）。
  const vmFactor = rho * cp * (1.0 / (1.0 - nuEff))
  const useNf = nfR > 0 && distance && distance.length >= nPoints

  for (let i = 0; i < nPoints; i++) {
    let v = vmFactor * ppv[i]
    if (useNf) v *= nearFieldGain(distance[i], nfR, nfG)
    sigmaVm[i] = v
  }

  return sigmaVm
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
export function _ensurePeakSlot(gridXyz, options = {}) {
  const sources = (options.sources || []).filter(s => Number(s.chargeKg) > 0)
  if (sources.length === 0) return null

  const K = options.K ?? LOCAL_SIM_DEFAULT_K
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  // 峰值方法（文献驱动升级，与后端 peak_ppv_envelope_multi 同口径）：
  //  - 'history'（默认）：时域错峰叠加峰值——杨年华(爆炸与冲击 2012)时域线性
  //    叠加预测原理：峰值取"各源波形按(延时+路径时差)错峰叠加后时程最大值"，
  //    修正 Blair(1993)/李洪超(爆炸与冲击 2026) 指出的"全源同时线性叠加系统性
  //    高估"。数学实现（_staggeredPeakAccumulate，逐点**到达序**精确解）：
  //        peak(p) = max_k e^(−D·arr_k)·|Σ_{j≤k} A_j·e^(+D·arr_j)·û_j|
  //    （arr=delay+r/c̄ 按该点升序）。旧"延时序"增量累加在 visualCp 模式下
  //    （路径时差压倒延期差）会把未到达源放大提前计入 → 系统性偏高。
  //    D = beta+visualBeta（与瞬时场同一时变衰减率）。延时充分错开 → 峰值≈最强
  //    单源幅值；同段齐发 → 退化为全源同相叠加（韩亮 2019 实测降振率规律一致）。
  //  - 'bound'：旧口径保守上界 |Σ A_s·û_s|（Holmberg–Persson 类同时叠加）。
  const peakMethod = options.peakMethod === 'bound' ? 'bound' : 'history'
  const beta = Number(options.beta ?? 0.02)
  const visualBeta = Number(options.visualBeta ?? 0.8)
  const peakDecay = Math.max(Number(options.peakDecay ?? beta + visualBeta), 0)
  // 空间门控（与后端 peak_ppv_envelope_multi + damage_zone_field 同口径）：
  // 峰值场 × env(influenceRadius)。损伤分区判据 digitize(peak × env)——损伤半径
  // 完全由 PPV 阈值纯物理计算得出，不设人工硬上限（damageMaxRadius 已废弃）。
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0

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
  const srcExpanded = expandSourcesWithReflections(src0, options.reflections, _REFL_MAX_SOURCES)
  // 延时升序稳定排序（同延时保持原序：直达先于其镜像反射）——时域错峰叠加
  // 要求按起爆顺序累加。直达源列索引随后用于 dmin（不含反射源，与后端同口径）。
  const order = srcExpanded
    .map((e, idx) => idx)
    .sort((a, b) => srcExpanded[a].delay - srcExpanded[b].delay)
  const src = order.map(idx => srcExpanded[idx])
  const directCols = []
  for (let k = 0; k < order.length; k++) {
    if (order[k] < src0.length) directCols.push(k)
  }

  const nPoints = gridXyz.length / 3
  // alpha 必须显式传入：距离缓存按 (源几何, minStandoff, visualCp, alpha) 指纹单槽复用，
  // 漏传会回退默认 1.5 → 指纹与 PPV 遍不一致 → 两遍互相踩踏、缓存每步重建。
  const cache = _getDistCache(gridXyz, src, minStandoff, visualCp, alpha)
  const distTable = cache.dist
  const distPow = cache.distPow

  // 核心峰值几何场与最早到达时刻均与 t、influenceRadius 无关 → 按 (点集引用,
  // 距离缓存指纹, K, peakMethod, peakDecay) 一次性预计算并缓存（多槽：体网格与
  // 岩面顶点集各自独立成槽，互不踩踏）；此后每个模拟时刻只做 O(N) 门控。
  // influenceRadius 只以 O(N) 的 env 乘法进入派生场（peak/zones），按其值二级
  // 缓存 → 包络半径滑块拖动不触发 O(nS·N) 核心重算。peakMethod/peakDecay 改变
  // 错峰语义，必须使核心缓存失效。
  const gateFp = `${cache.fp}|pm${peakMethod}|pd${peakDecay.toFixed(4)}`
  let peakSlot = _getPeakCache(gridXyz, gateFp, K)
  if (!peakSlot) {
    const invCp = 1 / Math.max(visualCp, 1e-3)
    const history = peakMethod === 'history'
    const arrival = new Float32Array(nPoints).fill(Infinity)
    const peakPre = new Float32Array(nPoints)
    const nS = src.length
    // 门控用 dmin（到最近真实装药源距离，不含镜象反射源）——恒随核心场缓存：
    // 派生 env(dmin) 需要它，且影响半径滑块变化时不重算核心场
    const dminArr = _dminFromDistColumns(distTable, directCols, nPoints)
    if (history) {
      // 逐点到达序精确解（含反射条目 gate；见 _staggeredPeakAccumulate）
      _staggeredPeakAccumulate(
        gridXyz,
        src,
        distTable,
        distPow,
        nPoints,
        peakDecay,
        invCp,
        arrival,
        peakPre
      )
    } else {
      const acc = _ensureAccBuffers(nPoints)
      const accX = acc.cx
      const accY = acc.cy
      const accZ = acc.cz
      accX.fill(0)
      accY.fill(0)
      accZ.fill(0)
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
          accX[i] += a * ((gridXyz[i * 3] - sx) * inv)
          accY[i] += a * ((gridXyz[i * 3 + 1] - sy) * inv)
          accZ[i] += a * ((gridXyz[i * 3 + 2] - sz) * inv)
        }
      }
      for (let i = 0; i < nPoints; i++) {
        peakPre[i] = Math.sqrt(accX[i] * accX[i] + accY[i] * accY[i] + accZ[i] * accZ[i])
      }
    }
    peakSlot = _setPeakCache(gridXyz, gateFp, K, peakPre, arrival, dminArr)
  }

  // 派生场（× env(influenceRadius) 的连续峰值 + digitize 损伤分区）：O(N)，按
  // influenceRadius 二级缓存——只有该值变化时重跑（几十 ms 级），不触发 O(nS·N)
  // 核心场重算（体网格 65 万点核心场需秒级）
  const dFp = `e${influenceRadius}`
  if (peakSlot.derivedFp !== dFp) {
    const peakEnv = new Float32Array(nPoints)
    const zonesPre = new Int8Array(nPoints)
    const dmin = peakSlot.dmin
    const corePeak = peakSlot.corePeak
    for (let i = 0; i < nPoints; i++) {
      // 与后端同口径：峰值场 × env；分区判据 digitize(peak × env)（cm/s）
      const env = dmin ? _radialEnv(dmin[i], influenceRadius) : 1
      const mps = corePeak[i] * env
      peakEnv[i] = mps
      const cm = mps * 100.0
      let zone = 0
      for (let th = 0; th < DAMAGE_THRESHOLDS_CMPS.length; th++) {
        if (cm >= DAMAGE_THRESHOLDS_CMPS[th]) zone = th + 1
      }
      zonesPre[i] = zone
    }
    peakSlot.peak = peakEnv
    peakSlot.zones = zonesPre
    peakSlot.derivedFp = dFp
  }

  return peakSlot
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
  const K = options.K ?? LOCAL_SIM_DEFAULT_K
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
