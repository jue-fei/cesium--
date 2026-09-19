/**
 * 岩面顶点峰值场（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * computeSurfacePeakField：等值线提取的数据源，与 GPU 岩面着色同口径。
 */

import {
  LOCAL_SIM_DEFAULT_ALPHA,
  LOCAL_SIM_DEFAULT_K,
  _GATE_AXIS,
  _dminFromDistColumns,
  _ensureAccBuffers,
  _getDistCache,
  _radialEnv,
  _staggeredPeakAccumulate,
  expandSourcesWithReflections,
  tunnelFaceBoostFactor
} from './shared.js'

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
  const K = options.K ?? LOCAL_SIM_DEFAULT_K
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
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
  const srcExpanded = expandSourcesWithReflections(src0, options.reflections, 0)
  // 时域错峰叠加峰值（与 GPU uPeakHistory / 后端 peak_method='history' 同口径）：
  // _staggeredPeakAccumulate 逐点**到达序**精确解 peak=max_k e^(−D·arr_k)·|ΣB|
  // （杨年华 2012 时域叠加预测口径，修正全源同时叠加的高估；延时序累加在
  // visualCp 模式下系统性偏高，见 helper 注释）。occ/agn/boost/env 为逐点非负
  // 常数，在候选最大值之后统一相乘（max(f·x) = f·max(x)），不影响错峰语义。
  const peakMethod = options.peakMethod === 'bound' ? 'bound' : 'history'
  const peakDecay = Math.max(
    Number(options.peakDecay ?? Number(options.beta ?? 0.02) + Number(options.visualBeta ?? 0.8)),
    0
  )
  const order = srcExpanded
    .map((e, idx) => idx)
    .sort((a, b) => srcExpanded[a].delay - srcExpanded[b].delay)
  const src = order.map(idx => srcExpanded[idx])
  const directCols = []
  for (let k = 0; k < order.length; k++) {
    if (order[k] < src0.length) directCols.push(k)
  }

  const cache = _getDistCache(surfaceXyz, src, minStandoff, visualCp, alpha)
  const distTable = cache.dist
  const distPow = cache.distPow
  // 门控用 dmin（到最近真实装药源距离；直达列由排序索引换算）
  const dminArr = influenceRadius > 0 ? _dminFromDistColumns(distTable, directCols, nPoints) : null
  const invCp = 1 / Math.max(visualCp, 1e-3)
  const history = peakMethod === 'history'
  const nS = src.length
  if (history) {
    // 逐点到达序精确解直接写入 peak（gate 未过源不参与候选/arrival）
    _staggeredPeakAccumulate(
      surfaceXyz,
      src,
      distTable,
      distPow,
      nPoints,
      peakDecay,
      invCp,
      arrival,
      peak
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
        accX[i] += a * ((surfaceXyz[i * 3] - sx) * inv)
        accY[i] += a * ((surfaceXyz[i * 3 + 1] - sy) * inv)
        accZ[i] += a * ((surfaceXyz[i * 3 + 2] - sz) * inv)
      }
    }
    for (let i = 0; i < nPoints; i++) {
      peak[i] = Math.sqrt(accX[i] * accX[i] + accY[i] * accY[i] + accZ[i] * accZ[i])
    }
  }
  for (let i = 0; i < nPoints; i++) {
    const px = surfaceXyz[i * 3 + 0] - ox
    const py = surfaceXyz[i * 3 + 1] - oy
    const pz = surfaceXyz[i * 3 + 2] - oz
    // 峰值场与 GPU 岩面着色同口径：隧道轮廓自由面放大（face 缺省/coeff=0 返回 1）。
    // 【勿从 acc 缓冲重算峰值】history 模式 acc 保存的是 e^(+D·arr) 加权矢量，
    // 模长并非错峰峰值——旧版在此覆盖导致等值线数据源失真。
    peak[i] =
      peak[i] *
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
