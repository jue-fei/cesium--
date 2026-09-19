/**
 * 损伤分区（Persson 模型，自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * classifyDamageZones / computePeakDamageZones / computeMultiSourcePeakDamageZones。
 * 多源版复用 ppvField.js 的峰值缓存槽 _ensurePeakSlot。
 */

import {
  DAMAGE_THRESHOLDS_CMPS,
  LOCAL_SIM_DEFAULT_ALPHA,
  LOCAL_SIM_DEFAULT_K,
  _radialEnv,
  sadoskyPpv
} from './shared.js'
import { _ensurePeakSlot } from './ppvField.js'

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
  const K = options.K ?? LOCAL_SIM_DEFAULT_K
  const alpha = options.alpha ?? LOCAL_SIM_DEFAULT_ALPHA
  const minStandoff = options.minStandoff ?? 0.5
  const visualCp = options.visualCp ?? 35.0
  // 空间门控（与后端 peak_ppv_envelope_multi + damage_zone_field 同口径）
  const influenceRadius = Number(options.influenceRadius) > 0 ? Number(options.influenceRadius) : 0
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
    // 峰值 PPV（无时变衰减）× 包络 → cm/s → Persson 档位
    const cm =
      sadoskyPpv(chargeKg, r, { K, alpha, minStandoff }) * 100.0 * _radialEnv(r, influenceRadius)
    let zone = 0
    for (let th = 0; th < DAMAGE_THRESHOLDS_CMPS.length; th++) {
      if (cm >= DAMAGE_THRESHOLDS_CMPS[th]) zone = th + 1
    }
    zones[i] = zone
  }

  return zones
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
