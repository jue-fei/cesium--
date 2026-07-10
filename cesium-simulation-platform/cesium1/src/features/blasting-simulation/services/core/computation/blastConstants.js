/**
 * 爆破物理常量集中定义模块（前端）
 *
 * 与后端 app/services/blasting/constants.py 保持同结构同数值。
 * 所有前端物理计算模块 MUST 从本文件导入常量，禁止内联硬编码。
 *
 * 常量来源：从 gasExpansionModel.js / damageZoneCalculator.js /
 *           blastPhysicsEngine.js / kcoModelCore.js 原有内联硬编码值提取，
 *           并对齐后端 constants.py。
 */

// ─── JWL 状态方程参数（3 种炸药）─────────────────────────
// 来源：gasExpansionModel.js 中 jwlPressure 原内联 params 字典
// 键含义：A/B/R1/R2 为 JWL 系数，w 为 Grüneisen 系数，E0 为初始内能(J/m³)
// 注：A/B/R1/R2/w/E0 与后端 constants.py 完全一致；
//     rho 为前端独有字段（后端无），供 computeChargeVolume 计算装药体积使用
export const JWL_PARAMS = {
  emulsion: { A: 3.7377e11, B: 3.747e9, R1: 4.15, R2: 0.9, w: 0.35, E0: 3.9e9, rho: 1200 },
  anfo:     { A: 4.946e11, B: 1.216e9, R1: 4.5,  R2: 1.0, w: 0.30, E0: 2.484e9, rho: 850  },
  dynamite: { A: 5.242e11, B: 2.067e9, R1: 4.2,  R2: 1.1, w: 0.35, E0: 3.56e9,  rho: 1400 }
}

// ─── 萨道夫斯基振动公式默认经验常数 ─────────────────────
// 来源：后端 constants.py sadosky_vibration / wave_field_2d 原硬编码 K=200、alpha=1.5
export const SADOSKY_K_DEFAULT = 200.0       // 中国 GB6722-2014 中硬岩默认值
export const SADOSKY_ALPHA_DEFAULT = 1.5     // 衰减指数
export const SADOSKY_R_MIN = 0.5             // 距离最小钳制(m)，避免奇点

// ─── 损伤区计算系数 ─────────────────────────────────────
// 来源：damageZoneCalculator.js 原硬编码 1.8/1.5/2.5
export const DAMAGE_BETA = 2.5               // 应力衰减指数（柱面波 2 / 球面波 3 / 隧道取 2.5）
export const SIGMA_CD_FACTOR = 1.8           // 动态抗压强度 = 静态UCS × 该系数
export const SIGMA_TD_FACTOR = 1.5           // 动态抗拉强度 = 静态抗拉 × 该系数

// ─── KCO 模型 ───────────────────────────────────────────
// 来源：后端 kco_validator.py calculate_kco 原硬编码 oversize_threshold = 0.8
export const KCO_OVERSIZE_THRESHOLD = 0.8    // oversize 判定阈值(m)，工程上常取 0.8m

// ─── 爆生气膨胀 ─────────────────────────────────────────
// 说明：与后端 constants.py 一致，取工程典型参考值
export const GAS_EFFECTIVE_TIME = 0.1        // 气体有效作用时间(s)，爆生气典型作用时长 ~100ms
export const P_MAX_CLAMP = 5.0e9             // 压力上限钳制(Pa)，取 5 GPa 参考值

export default {
  JWL_PARAMS,
  SADOSKY_K_DEFAULT,
  SADOSKY_ALPHA_DEFAULT,
  SADOSKY_R_MIN,
  DAMAGE_BETA,
  SIGMA_CD_FACTOR,
  SIGMA_TD_FACTOR,
  KCO_OVERSIZE_THRESHOLD,
  GAS_EFFECTIVE_TIME,
  P_MAX_CLAMP
}
