/**
 * JWL 爆生气膨胀模型
 *
 * 计算爆生气随时间膨胀时的压力，以及每个碎片受到的径向推力。
 *
 * 物理原理：
 * - 炸药爆轰瞬间产生高温高压爆生气，在岩体裂隙网络中膨胀
 * - 推力在 0-100ms 内从 GPa 级指数衰减至可忽略
 * - 距爆心近的大块碎片受推力更大（截面积大，质量增长慢于截面积）
 * - 近场（dist < 5×chargeLength）按柱面波膨胀，远场按球面波膨胀
 *
 * 参考文献：
 * - Lee, E.L. et al. (1968) "JWL Equation of State for Detonation Products"
 * - Sanchidrián, J.A. et al. (2017) "A New Model for Rock Blasting"
 */

import { JWL_PARAMS, GAS_EFFECTIVE_TIME, P_MAX_CLAMP } from './blastConstants.js'

// ─── 经验参数（Sanchidrián 2017 Table 3 校准范围） ─────
// 注：JWL_PARAMS / GAS_EFFECTIVE_TIME / P_MAX_CLAMP 已从 blastConstants.js 导入，与后端 constants.py 对齐
const K_LEAK = 0.08        // 气体泄漏系数（岩体裂隙渗透率高→大值，范围 0.05-0.20）
const C_SOUND = 4500       // 岩体 P 波速度 (m/s)
const ALPHA_ROCK = 0.15    // 岩体衰减系数（范围 0.10-0.25）

/**
 * 计算 JWL 状态方程压力
 * P(V) = A·(1 - ω/(R₁·V))·exp(-R₁·V) + B·(1 - ω/(R₂·V))·exp(-R₂·V) + ω·E₀/V
 *
 * @param {number} V - 相对体积 V_current/V_initial（无量纲，>0）
 * @param {string} explosiveType - 炸药类型 'emulsion'|'anfo'|'dynamite'
 * @returns {number} 气体压力 (Pa)
 */
export function jwlPressure(V, explosiveType = 'emulsion') {
  const p = JWL_PARAMS[explosiveType] || JWL_PARAMS.emulsion
  const Vc = Math.max(0.01, V) // 防止除零和指数发散
  return (
    p.A * (1 - p.w / (p.R1 * Vc)) * Math.exp(-p.R1 * Vc) +
    p.B * (1 - p.w / (p.R2 * Vc)) * Math.exp(-p.R2 * Vc) +
    p.w * p.E0 / Vc
  )
}

/**
 * 计算碎片的爆生气推力加速度
 *
 * 推力方向：从爆心指向碎片的径向方向（若碎片与爆心重合则用抛掷方向）
 * 推力大小：P_eff × 截面积 / 质量
 * 衰减因素：
 *   1. 时间衰减：(1 - simTime/GAS_EFFECTIVE_TIME)，100ms 后归零
 *   2. 距离衰减：exp(-α_rock × effDist)，岩体裂隙能量耗散
 *   3. 泄漏衰减：effDist = dist + k_leak × simTime × c_sound
 *
 * @param {Object} params
 * @param {number} params.posX/posY/posZ - 碎片世界坐标
 * @param {number} params.blastCX/blastCY/blastCZ - 爆心世界坐标
 * @param {number} params.physSize - 碎片物理直径(m)
 * @param {number} params.mass - 碎片质量(kg)
 * @param {number} params.simTime - 当前模拟时间(s)
 * @param {number} params.chargeVolume - 装药体积(m³)
 * @param {string} params.explosiveType - 炸药类型
 * @param {Array<number>} params.throwDir - 抛掷方向单位向量 [x,y,z]
 * @param {number} [params.chargeLength=3.0] - 装药长度(m)，用于近场/远场判定
 * @returns {{ax:number,ay:number,az:number}} 推力加速度向量
 */
export function computeGasThrustAccel(params) {
  const {
    posX, posY, posZ, blastCX, blastCY, blastCZ,
    physSize, mass, simTime, chargeVolume, explosiveType, throwDir,
    chargeLength = 3.0
  } = params

  // 1. 爆生气有效时间窗口：0-100ms
  if (simTime > GAS_EFFECTIVE_TIME || simTime < 0) {
    return { ax: 0, ay: 0, az: 0 }
  }

  // 2. 碎片到爆心的距离 + 径向方向
  const dx = posX - blastCX
  const dy = posY - blastCY
  const dz = posZ - blastCZ
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const dirX = dist > 0.001 ? dx / dist : throwDir[0]
  const dirY = dist > 0.001 ? dy / dist : throwDir[1]
  const dirZ = dist > 0.001 ? dz / dist : throwDir[2]

  // 3. 泄漏衰减：气体通过裂隙泄漏，有效膨胀距离增大
  //    R_eff = dist + k_leak × simTime × c_sound
  const leakPenalty = K_LEAK * simTime * C_SOUND
  const effDist = dist + leakPenalty

  // 4. 近场/远场膨胀几何
  //    隧道爆破炮孔为柱形装药（孔径 40-50mm，孔长 1-5m）
  //    近场（dist < 5×chargeLength）：柱面波，V ∝ π·R²·L
  //    远场（dist ≥ 5×chargeLength）：球面波，V ∝ (4/3)π·R³
  let effVolume
  const cylindricalThreshold = 5 * chargeLength
  if (effDist < cylindricalThreshold) {
    effVolume = Math.PI * effDist * effDist * chargeLength
  } else {
    effVolume = (4 / 3) * Math.PI * Math.pow(effDist, 3)
  }
  const relativeVolume = effVolume / Math.max(1e-9, chargeVolume)

  // 5. JWL 方程 → 当前气体压力
  const P = jwlPressure(relativeVolume, explosiveType)

  // 6. 岩体衰减因子 η = exp(-α_rock × effDist) × (1 - simTime/GAS_EFFECTIVE_TIME)
  const eta = Math.exp(-ALPHA_ROCK * effDist) * Math.max(0, 1 - simTime / GAS_EFFECTIVE_TIME)

  // 7. 有效推力上限钳制（避免 JWL 在 V<0.1 时指数项发散）
  const P_eff = Math.min(P, P_MAX_CLAMP) * eta

  // 8. 碎片迎风截面积（按球体投影）
  const crossSection = Math.PI * (physSize / 2) * (physSize / 2)

  // 9. 推力 = 压力 × 截面积；加速度 = 推力 / 质量
  const force = P_eff * crossSection
  const accel = force / Math.max(0.001, mass)

  return {
    ax: accel * dirX,
    ay: accel * dirY,
    az: accel * dirZ
  }
}

/**
 * 根据装药量和炸药密度计算装药体积
 * @param {number} chargeKg - 装药质量(kg)
 * @param {string} explosiveType - 炸药类型
 * @returns {number} 装药体积(m³)
 */
export function computeChargeVolume(chargeKg, explosiveType = 'emulsion') {
  const p = JWL_PARAMS[explosiveType] || JWL_PARAMS.emulsion
  return chargeKg / p.rho
}

export default { jwlPressure, computeGasThrustAccel, computeChargeVolume, JWL_PARAMS }
