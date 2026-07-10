/**
 * 爆破损伤区计算器
 *
 * 基于 Holmberg-Persson 模型和 Griffith 断裂准则计算三区半径：
 * 1. 粉碎区（Crushed Zone）：爆炸应力超过岩石动态抗压强度 σ_cd
 * 2. 裂隙区（Fractured Zone）：环向拉应力超过岩石动态抗拉强度 σ_td
 * 3. 弹性区（Elastic Zone）：仅弹性变形，无永久损伤
 *
 * 参考文献：
 * - Holmberg, R. & Persson, P.A. (1980) "Design of Tunnel Blasts"
 * - Hustrulid, W. (1999) "Blasting Principles for Open Pit Mining"
 */

import { DAMAGE_BETA, SIGMA_CD_FACTOR, SIGMA_TD_FACTOR } from './blastConstants.js'

/**
 * 计算粉碎区（Crushed Zone）半径
 *
 * 粉碎区定义：爆炸应力超过岩石动态抗压强度 σ_cd 的区域。
 * 在此区域内岩石被完全压碎成粉末状（已由爆破过程移除，即碎片来源区）。
 *
 * R_crushed = r_charge × (P_det / σ_cd)^(1/β)
 *
 * @param {number} chargeKg - 装药质量(kg)
 * @param {number} explosiveDensity - 炸药密度(kg/m³)
 * @param {number} VoD - 爆速(m/s)
 * @param {number} rockUCS - 岩石静态单轴抗压强度(Pa)
 * @returns {number} 粉碎区半径(m)
 */
export function crushedZoneRadius(chargeKg, explosiveDensity, VoD, rockUCS) {
  // 等效球形装药半径 = (3M/(4πρ_exp))^(1/3)
  const rCharge = Math.pow((3 * chargeKg) / (4 * Math.PI * explosiveDensity), 1 / 3)
  // 爆轰压力 = ρ_exp × VoD² / 4（Chapman-Jouguet 条件）
  const pDet = explosiveDensity * VoD * VoD / 4
  // 动态抗压强度 ≈ 1.8×静态 UCS
  const sigmaCd = rockUCS * SIGMA_CD_FACTOR
  // 应力衰减指数（柱面波 β=2，球面波 β=3），隧道爆破取 2.5
  const beta = DAMAGE_BETA
  return rCharge * Math.pow(pDet / sigmaCd, 1 / beta)
}

/**
 * 计算裂隙区（Fractured Zone）半径
 *
 * 裂隙区定义：环向拉应力超过岩石动态抗拉强度的区域。
 *
 * R_fractured = R_crushed × (σ_cd / σ_td)^(1/β)
 *
 * @param {number} crushedR - 粉碎区半径(m)
 * @param {number} rockUCS - 岩石静态单轴抗压强度(Pa)
 * @param {number} rockTensile - 岩石静态抗拉强度(Pa)
 * @returns {number} 裂隙区外边界半径(m)
 */
export function fracturedZoneRadius(crushedR, rockUCS, rockTensile) {
  const sigmaCd = rockUCS * SIGMA_CD_FACTOR       // 动态抗压
  const sigmaTd = rockTensile * SIGMA_TD_FACTOR   // 动态抗拉
  const beta = DAMAGE_BETA
  return crushedR * Math.pow(sigmaCd / sigmaTd, 1 / beta)
}

/**
 * 计算爆破损伤区三区半径与可视化数据
 *
 * 典型值（100kg 乳化炸药 + 120MPa 花岗岩）：
 *   crushedR ≈ 0.35m, fracturedR ≈ 1.8m
 *
 * @param {number} chargeKg - 装药质量(kg)
 * @param {Object} rockParams - 岩石与炸药参数
 * @param {number} [rockParams.explosiveDensity=1200] - 炸药密度(kg/m³)
 * @param {number} [rockParams.VoD=4500] - 爆速(m/s)
 * @param {number} [rockParams.rockUCS=120e6] - 岩石静态抗压强度(Pa)
 * @param {number} [rockParams.rockTensile=10e6] - 岩石静态抗拉强度(Pa)
 * @returns {{crushedZoneRadius:number, fracturedZoneRadius:number, elasticZoneStart:number}}
 */
export function calculateDamageZones(chargeKg, rockParams = {}) {
  const {
    explosiveDensity = 1200,   // kg/m³（乳化炸药）
    VoD = 4500,                // m/s（爆速）
    rockUCS = 120e6,           // Pa（中硬花岗岩 120 MPa）
    rockTensile = 10e6         // Pa（抗拉强度 10 MPa ≈ UCS/12）
  } = rockParams

  const crushedR = crushedZoneRadius(chargeKg, explosiveDensity, VoD, rockUCS)
  const fracturedR = fracturedZoneRadius(crushedR, rockUCS, rockTensile)

  return {
    crushedZoneRadius: crushedR,       // 粉碎区半径(m)
    fracturedZoneRadius: fracturedR,   // 裂隙区外边界半径(m)
    elasticZoneStart: fracturedR       // 弹性区起始半径(m)，弹性区从此处延伸至无穷远，无外边界（elasticZoneStart === fracturedZoneRadius）
  }
}

export default { crushedZoneRadius, fracturedZoneRadius, calculateDamageZones }
