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
  computePeakDamageZones
} from './localVibrationSimulator.js'

let gridXyz = null
let gridLen = 0
let params = null
let chargeKg = 100
let configured = false

self.onmessage = e => {
  const msg = e.data
  if (!msg) return

  if (msg.type === 'config') {
    gridXyz = msg.gridXyz
    gridLen = gridXyz ? gridXyz.length / 3 : 0
    params = msg.params
    chargeKg = msg.chargeKg
    configured = true
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
    const sigmaVm = computeStressFieldFromPpv(ppv, params, _sigmaBuf)
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
let _sigmaBuf = null
let _zoneBuf = null

function ensureBuffers(n) {
  if (_ppvBuf && _ppvBuf.length === n) return
  _ppvBuf = new Float32Array(n)
  _sigmaBuf = new Float32Array(n)
  _zoneBuf = new Int8Array(n)
}
