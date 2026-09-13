/**
 * 验证：多源矢量叠加算法是否真正产生"非对称/方向性花瓣"（E 项核查）。
 *
 * 方法：
 *  1. 构造一组带不同延期（0/50/120/250/415 ms）的多装药源（模拟掏槽+辅助+周边微差起爆）；
 *  2. 在爆心同心球面 R=5m 上均匀采样 128 点，计算各点"瞬时振速场"（computeMultiSourcePpvField3d）；
 *  3. 度量球面上值的变异系数（CV = std/mean）：
 *     - 完美同心圆（物理上只会来自单源/全源同期对称）→ CV≈0；
 *     - 多孔延时矢量叠加 → 不同方向值差异明显（CV 显著 >5%）。
 *  4. 用"单一等效药包"（同总药量单源）做对照：CV 应接近 0（准圆对称）。
 *
 * 亲测结论请见输出末尾。
 */
import {
  computeMultiSourcePpvField3d,
  computePpvField3d,
  computeSurfacePeakField,
  sadoskyPpv,
  tunnelFaceBoostFactor
} from '../src/features/blasting-simulation/services/core/computation/localVibrationSimulator.js'

function makeSources() {
  const faceOffset = 3
  const cutR = 0.4
  const auxR = 1.1
  const contR = 2.2
  const q = 1.6
  const list = []
  // 掏槽楔形 4 孔（0ms）
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2
    list.push({
      x: cutR * Math.cos(a),
      y: 2.0 + cutR * Math.sin(a),
      z: faceOffset - 0.3,
      chargeKg: q,
      delayMs: 0
    })
  }
  // 辅助孔 4 孔（50ms）
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4
    list.push({
      x: auxR * Math.cos(a),
      y: 2.0 + auxR * Math.sin(a),
      z: faceOffset - 0.15,
      chargeKg: q,
      delayMs: 50
    })
  }
  // 底板/崩落 4 孔（120ms，向 +x 偏置 → 方向性偏转来源之一）
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2
    list.push({
      x: 3.0 + 0.6 * Math.cos(a),
      y: 0.6 + 0.6 * Math.sin(a),
      z: faceOffset + 0.2,
      chargeKg: q,
      delayMs: 120
    })
  }
  // 周边孔 4 孔（415ms）
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4
    list.push({
      x: contR * Math.cos(a),
      y: 4.5 + contR * Math.sin(a),
      z: faceOffset + 0.1,
      chargeKg: q,
      delayMs: 415
    })
  }
  return list
}

/** 爆心同心球面均匀采样点（Tammes 近似：经/纬网格） */
function spherePoints(origin, R, nLon = 16, nLat = 8) {
  // 以爆心为心、半径 R，均匀分布方向 → 点
  const pts = []
  for (let i = 0; i < nLat; i++) {
    const phi = (Math.PI * (i + 0.5)) / nLat // 0..π
    const y = origin[1] + R * Math.cos(phi)
    const rr = R * Math.sin(phi)
    for (let j = 0; j < nLon; j++) {
      const th = (2 * Math.PI * j) / nLon
      pts[i * nLon + j] = [origin[0] + rr * Math.cos(th), y, origin[2] + rr * Math.sin(th)]
    }
  }
  return pts
}

function cv(values) {
  const n = values.length
  const mean = values.reduce((s, v) => s + v, 0) / n
  const var_ = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  return { mean, std: Math.sqrt(var_), cv: mean > 1e-9 ? Math.sqrt(var_) / mean : 0 }
}

const origin = [0, 2.4, 3]
const sources = makeSources()
const totalQ = sources.reduce((s, x) => s + x.chargeKg, 0)
const flat = sources.map(s => ({
  x: s.x,
  y: s.y,
  z: s.z,
  chargeKg: s.chargeKg,
  delayMs: s.delayMs
}))
const sphere = spherePoints(origin, 5.0)
const flatXyz = new Float32Array(sphere.flat())

const optMulti = {
  K: 90,
  alpha: 1.58,
  beta: 0.02,
  visualBeta: 0.8,
  visualCp: 35,
  minStandoff: 0.5,
  sources: flat
}

console.log('=== E: 多源矢量叠加非对称性验证 ===')
console.log('源数:', sources.length, ' 总药量:', totalQ.toFixed(1), 'kg')
console.log('延时分布(ms):', sources.map(s => s.delayMs).join(','))

let prev = null
for (const t of [0.2, 0.35, 0.6]) {
  // 多源瞬时场
  const fMulti = computeMultiSourcePpvField3d(flatXyz, t, optMulti)
  const vMulti = cv(Array.from(fMulti).filter(v => v > 0))
  // 单源对照（同总药量，同心圆基准）
  const fSingle = computePpvField3d(flatXyz, totalQ, t, {
    K: 90,
    alpha: 1.58,
    beta: 0.02,
    visualBeta: 0.8,
    visualCp: 35,
    minStandoff: 0.5,
    origin
  })
  const vSingle = cv(Array.from(fSingle).filter(v => v > 0))
  console.log(
    `t=${t}s  多源: CV=${(vMulti.cv * 100).toFixed(2)}% mean=${vMulti.mean.toFixed(3)} m/s  ` +
      `|  单源对照: CV=${(vSingle.cv * 100).toFixed(2)}% mean=${vSingle.mean.toFixed(3)} m/s`
  )
  prev = vMulti
}

// 峰值场（等值线数据源）：同样核查方向性
const surf = spherePoints(origin, 5.0).flat()
const peakRes = computeSurfacePeakField(new Float32Array(surf), {
  K: 90,
  alpha: 1.58,
  visualCp: 35,
  minStandoff: 0.5,
  chargeKg: totalQ,
  sources: flat,
  origin
})
const vPeak = cv(Array.from(peakRes.peak).filter(v => v > 0))
console.log(`峰值场(等值线源) R=5m: CV=${(vPeak.cv * 100).toFixed(2)}%`)

// 自由面放大函数一致性抽查（B 项）——取"岩体侧"（轮廓外）点：侧墙外0.1m / 2m / 拱上4.5m
const near = tunnelFaceBoostFactor([4.6, 3.0, 3], {
  coeff: 0.6,
  lambda: 1.2,
  halfW: 4.5,
  floorY: 0,
  archH: 6
})
const mid = tunnelFaceBoostFactor([6.5, 3.0, 3], {
  coeff: 0.6,
  lambda: 1.2,
  halfW: 4.5,
  floorY: 0,
  archH: 6
})
const far = tunnelFaceBoostFactor([4.5, 13.0, 3], {
  coeff: 0.6,
  lambda: 1.2,
  halfW: 4.5,
  floorY: 0,
  archH: 6
})
console.log(`---`)
console.log(
  `tunnelFaceBoost: 侧壁外0.1m=${near.toFixed(2)}x 侧壁外2m=${mid.toFixed(2)}x 拱上远处=${far.toFixed(2)}x（趋势应 近>中>远，贴近轮廓 ≈1.6x 全反射放大）`
)
console.log(
  `萨道夫斯基抽查 R=5m PPV(cm/s) = ${(sadoskyPpv(totalQ, 5, { K: 90, alpha: 1.58 }) * 100).toFixed(1)}`
)

console.log('=== 结论 ===')
if (prev && prev.cv > 0.05) {
  console.log('✓ 多源矢量叠加在多延时下产生显著非对称（CV>5%）：方向性偏转/花瓣存在于算法层。')
  console.log('  若视图中仍显示"对称同心圆"，请检查：①是否播放推进到全部延期段起爆后的瞬时帧；')
  console.log('  ②是否使用了峰值/损伤视图（包络天然更对称）；③可开启"干涉载波"增强相位干涉花瓣。')
} else {
  console.log('! CV 不显著，检查源几何/延期配置。')
}
