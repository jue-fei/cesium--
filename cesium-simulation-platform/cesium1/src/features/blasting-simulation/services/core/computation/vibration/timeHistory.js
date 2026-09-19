/**
 * 测点时程与单点采样（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * computeMonitorTimeHistory（三分量全时程）、computePpvDecayProfile
 * （仿真 vs 萨道夫斯基衰减剖面）、computePointVector（单点瞬时矢量，矢量箭头场采样）。
 */

import {
  LOCAL_SIM_DEFAULT_ALPHA,
  LOCAL_SIM_DEFAULT_K,
  WAVELET_Q,
  expandSourcesWithReflections,
  sadoskyPpv
} from './shared.js'

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
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
        twoPiF > 0
          ? Math.sin(twoPiF * gap) * Math.exp((-Math.PI * carrierHz * gap) / WAVELET_Q)
          : 1.0
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
 *   - theory[i] = 萨道夫斯基公式：v = K·(Q^(1/3)/R)^α，Q 取**最大单响药量**
 *                 （maxChargePerDelay，微差爆破振动预测规范口径——同段齐发孔
 *                 药量之和，而非全部源总装药量），R 取采样点到爆心（掌子面掏槽
 *                 质心）的直线距离。总药量口径会系统性高估理论线 n^(α/3) 倍。
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
  const K = options.K ?? LOCAL_SIM_DEFAULT_K
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
  // 最大单响药量（kg，规范口径）：雷管延时带抖动后同段孔不再严格同刻，
  // 按 15ms 滑窗取"窗内药量和"最大——段间隔(≥25ms)远大于窗宽时即同段齐发药量
  const maxChargePerDelay = _maxChargePerDelay(srcList, 15)

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
    theory.push(sadoskyPpv(maxChargePerDelay, dist, { K, alpha, minStandoff }))
    labels.push(label)
  }
  return { r, sim, theory, labels, totalQ, maxChargePerDelay, K, alpha }
}

// 最大单响药量（kg）：按 delay(ms) 升序双指针滑窗，取窗宽 windowMs 内药量和的
// 最大值。同段齐发孔的抖动延时彼此相差远小于窗宽 → 归入同窗；相邻段别间隔
// （毫秒雷管 ≥25ms）大于窗宽 → 不会误并。
function _maxChargePerDelay(srcList, windowMs = 15) {
  if (!srcList || srcList.length === 0) return 0
  const arr = srcList
    .map(s => ({ d: Number(s.delayMs) || 0, q: Number(s.chargeKg) || 0 }))
    .sort((a, b) => a.d - b.d)
  let best = 0
  let sum = 0
  let lo = 0
  for (let hi = 0; hi < arr.length; hi++) {
    sum += arr[hi].q
    while (arr[hi].d - arr[lo].d > windowMs) {
      sum -= arr[lo].q
      lo++
    }
    if (sum > best) best = sum
  }
  return best
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
  const K = options.K ?? LOCAL_SIM_DEFAULT_K
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
    // sin 起振为零：波前到达瞬间质点速度连续（与 computeMonitorTimeHistory /
    // 单源 computePpvField3d 同口径；旧 cos 在 gap→0+ 跳到满幅，物理不连续）
    const osc = twoPiF > 0 ? Math.sin(twoPiF * gap) : 1.0
    const a = ss.coef * Math.pow(r, -alpha) * Math.exp(-decay * gap) * osc
    const inv = 1 / Math.max(r, 1e-6)
    vx += a * dx * inv
    vy += a * dy * inv
    vz += a * dz * inv
  }
  return { vx, vy, vz, mag: Math.sqrt(vx * vx + vy * vy + vz * vz) }
}
