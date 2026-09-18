/**
 * 振动场计算 Web Worker
 *
 * 将本地振动模拟器中最重的计算（多装药源矢量叠加的 PPV/应力/损伤场）搬离主线程：
 *   - 多源模式下每帧需对 网格点数 × 源数 做同步矢量叠加，且每点每源各含一次
 *     Math.pow（萨道夫斯基）+ Math.exp（时间衰减）。当地规模拟网格较大（如
 *     48×64×96≈29 万点）、与多个掏槽孔源叠加时，单帧主线程耗时可到秒级，
 *     导致爆破动画"直接卡死"。物理引擎已 Worker 化，振动场计算同样搬走。
 *
 * 消息协议（主线程 → Worker）：
 *   { type: 'config', gridXyz: Float32Array, params: object, chargeKg: number }
 *     —— 一次性下发网格坐标与物理参数（params 含 sources/K/alpha/…）。
 *   { type: 'compute', t: number, requestId: number }
 *     —— 请求计算某模拟时刻的三场数据。
 *
 * 消息协议（Worker → 主线程）：
 *   { type: 'result', requestId: number, t: number,
 *     ppv: Float32Array, sigmaVm: Float32Array, zones: Int8Array }
 *     —— ppv/sigmaVm/zones 通过 Transferable 零拷贝移交主线程。
 *
 * 计算口径与主线程 LocalVibrationSimulator.computeAtTime 完全一致：
 *   - 有 sources 时用 computeMultiSource*（多应力波矢量叠加）；
 *   - 无 sources 时退化为 compute*（单源球面波）。
 */

import {
  computeMultiSourcePpvField3d,
  computePpvField3d,
  computeStressFieldFromPpv,
  computeMultiSourcePeakDamageZones,
  computePeakDamageZones,
  computeSurfacePeakField
} from './localVibrationSimulator.js'

let gridXyz = null
let gridLen = 0
let params = null
let chargeKg = 100
let configured = false

// 岩面顶点集（等值线峰值场数据源）：与体网格共存于同一 Worker。
// 峰值场与 t 无关 → 按 (表面引用, 源/参数指纹) 计算一次并缓存，重复请求直接回缓存。
let surfaceXyz = null
let surfaceShaping = null // { holeRadius, holeLen, lateralAttn, origin }（洞身遮挡/轴向增益参数）
let contourCache = { fp: null, peak: null, arrival: null }

function _sourcesFingerprint(list) {
  if (!Array.isArray(list) || list.length === 0) return 'none'
  let fp = ''
  for (const s of list) {
    fp +=
      (Number(s.x) || 0).toFixed(3) +
      ',' +
      (Number(s.y) || 0).toFixed(3) +
      ',' +
      (Number(s.z) || 0).toFixed(3) +
      ',' +
      (Number(s.chargeKg) || 0).toFixed(2) +
      ',' +
      (Number(s.delayMs) || 0).toFixed(1) +
      ';'
  }
  return fp
}

self.onmessage = e => {
  const msg = e.data
  if (!msg) return

  if (msg.type === 'config') {
    gridXyz = msg.gridXyz
    gridLen = gridXyz ? gridXyz.length / 3 : 0
    params = msg.params
    chargeKg = msg.chargeKg
    configured = true
    // 网格点到爆心距离随网格一起预计算（应力近场几何修正用）
    buildGridR()
    return
  }

  if (msg.type === 'contourConfig') {
    // 下发岩面顶点集与洞身整形参数（等值线峰值场数据源）。
    // surfaceXyz 经结构化克隆拷贝入 Worker（主线程保留原件继续渲染）。
    surfaceXyz = msg.surfaceXyz || null
    surfaceShaping = msg.shaping || null
    contourCache = { fp: null, peak: null, arrival: null }
    return
  }

  if (msg.type === 'contourCompute') {
    // 计算岩面顶点峰值场 + 波前到达时刻（与 t 无关，缓存复用）。
    if (!configured || !surfaceXyz || !surfaceXyz.length) return
    const p = params || {}
    const shaping = surfaceShaping || {}
    const srcFp = _sourcesFingerprint(p.sources)
    // 反射配置（掌子面自由面镜象源）纳入指纹：反射面变化 → 峰值场强制重算
    const reflFp = Array.isArray(p.reflections)
      ? p.reflections
          .map(r => `${r.axis}:${Number(r.value).toFixed(3)}:${Number(r.coeff).toFixed(3)}`)
          .join(',')
      : 'none'
    const fp =
      srcFp +
      '|' +
      Number(p.K).toFixed(3) +
      '|' +
      Number(p.alpha).toFixed(4) +
      '|' +
      Number(p.visualCp ?? p.cp).toFixed(2) +
      '|' +
      Number(p.minStandoff ?? 0.5).toFixed(2) +
      '|' +
      Number(chargeKg).toFixed(2) +
      '|' +
      (Array.isArray(p.origin) ? p.origin.map(v => Number(v).toFixed(3)).join(',') : '0,0,0') +
      '|' +
      reflFp +
      '|' +
      // 包络半径纳入指纹：computeSurfacePeakField 已施加 env(influenceRadius)，
      // 滑块拖动必须重算峰值场，否则缓存返回旧口径等值线（滑块"无效"的根因）
      (Number(p.influenceRadius) || 0) +
      '|' +
      Number(shaping.holeRadius).toFixed(3) +
      ',' +
      Number(shaping.holeLen).toFixed(3) +
      ',' +
      Number(shaping.lateralAttn).toFixed(3)
    if (contourCache.fp !== fp || !contourCache.peak) {
      const res = computeSurfacePeakField(surfaceXyz, {
        ...p,
        chargeKg,
        sources: Array.isArray(p.sources) ? p.sources : [],
        origin: Array.isArray(p.origin) ? p.origin : (shaping.origin ?? [0, 0, 0]),
        reflections: p.reflections, // 掌子面自由面反射（等值线 = 峰值场，与 GPU 同口径）
        holeRadius: shaping.holeRadius,
        holeLen: shaping.holeLen,
        lateralAttn: shaping.lateralAttn
      })
      contourCache = { fp, peak: res.peak, arrival: res.arrival }
    }
    // 拷贝后 Transferable 移交（缓存原件保留在 Worker 内供后续请求复用）
    const outPeak = contourCache.peak.slice()
    const outArrival = contourCache.arrival.slice()
    postMessage(
      { type: 'contourData', requestId: msg.requestId, peak: outPeak, arrival: outArrival },
      { transfer: [outPeak.buffer, outArrival.buffer] }
    )
    return
  }

  if (msg.type === 'compute') {
    if (!configured || !gridXyz) return
    const t = Number(msg.t) || 0
    const multi = Array.isArray(params?.sources) && params.sources.length > 0
    // 复用输出缓冲，避免每帧在 Worker 内大量分配
    ensureBuffers(gridLen)
    const ppv = multi
      ? computeMultiSourcePpvField3d(gridXyz, t, params, _ppvBuf)
      : computePpvField3d(gridXyz, chargeKg, t, params, _ppvBuf)
    // 应力场由**瞬时振速**反演 + 近场几何修正 —— 与主线程
    // LocalVibrationSimulator.computeAtTime / GPU shader 解析支同口径。
    // 【勿改回峰值包络】峰值场是静态云图，会丢失波前时间结构。
    const sigmaVm = computeStressFieldFromPpv(ppv, params, _sigmaBuf, _gridR)
    const zones = multi
      ? computeMultiSourcePeakDamageZones(gridXyz, t, params, _zoneBuf)
      : computePeakDamageZones(gridXyz, chargeKg, t, params, _zoneBuf)
    // 拷出到新缓冲后 Transferable 移交主线程（Worker 内部缓冲保持不变，可复用）
    const outPpv = ppv.slice()
    const outSigma = sigmaVm.slice()
    const outZones = zones.slice()
    postMessage(
      {
        type: 'result',
        requestId: msg.requestId,
        t,
        ppv: outPpv,
        sigmaVm: outSigma,
        zones: outZones
      },
      { transfer: [outPpv.buffer, outSigma.buffer, outZones.buffer] }
    )
  }
}

let _ppvBuf = null
let _peakBuf = null
let _sigmaBuf = null
let _zoneBuf = null
// 各网格点到爆心的距离(m)：应力近场几何修正用（见 localVibrationSimulator 的
// NEAR_FIELD_* 注释）。config 时随网格一次性算好。
let _gridR = null

function ensureBuffers(n) {
  if (_ppvBuf && _ppvBuf.length === n) return
  _ppvBuf = new Float32Array(n)
  _peakBuf = new Float32Array(n)
  _sigmaBuf = new Float32Array(n)
  _zoneBuf = new Int8Array(n)
}

/** 预计算网格点到爆心距离（config 时调用一次；origin 缺省为网格原点） */
function buildGridR() {
  if (!gridXyz || !gridLen) {
    _gridR = null
    return
  }
  const origin = params?.origin ?? null
  const ox = origin ? Number(origin[0]) || 0 : 0
  const oy = origin ? Number(origin[1]) || 0 : 0
  const oz = origin ? Number(origin[2]) || 0 : 0
  const r = new Float32Array(gridLen)
  for (let i = 0; i < gridLen; i++) {
    const dx = gridXyz[i * 3] - ox
    const dy = gridXyz[i * 3 + 1] - oy
    const dz = gridXyz[i * 3 + 2] - oz
    r[i] = Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  _gridR = r
}
