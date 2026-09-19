/**
 * 本地爆破振动场模拟器（萨道夫斯基经验公式 + 球面波传播 + 弹性应力反演 + 损伤分区）
 *
 * 用途：在后端 WebSocket 不可用时，提供本地模拟的振动传播过程，
 * 满足用户"自行模拟实时数据"的需求，保证动态热力图和粒子效果始终可用。
 *
 * 物理模型完全复刻后端 blast_physics.py：
 *   1. PPV 实时质点速度：萨道夫斯基经验公式 + 球面波前传播 + 时变回落
 *      v(r, t) = K·(Q^(1/3)/R)^α · exp(-(β+βv)·(t - R/c̄)) · H(t - R/c̄)
 *      （c̄=visualCp 可视化波速；βv=visualBeta 可视化时变衰减，见 computePpvField3d）
 *   2. 应力场反演（弹性球面波本构一阶近似）：
 *      σ_rr = ρ·c_p·v_r（径向压）, σ_θθ = (ν/(1−ν))·σ_rr（切向拉幅值）,
 *      σ_vm = σ_rr/(1−ν)（von Mises）
 *   3. 损伤分区（Persson 模型，基于"波峰几何峰值×波前到达门控"，单位 cm/s）：
 *      0 elastic  (<20)    → 弹性区，无损伤（σ_vm<3.2MPa，低于中硬岩强度）
 *      1 micro_crack (20~50) → 微裂纹萌生
 *      2 crack_growth (50~100) → 裂纹扩展（接近 Persson 700mm/s 判据）
 *      3 fracture (100~200) → 岩体破碎
 *      4 throw (≥200) → 抛掷爆腔
 *
 * 坐标系：与 threeBlastingRenderer 一致，采用隧道局部坐标系（局部 ENU 原点）。
 * 默认 blastCenter = [0,0,0]（网格原点）；可通过 options.origin 指定爆心为任意点
 * （如掏槽孔组质心，位于掌子面 [x, y, faceOffset]），使应力波/损伤从实际爆破位置出发。
 * 网格轴序：输出按 WebGL Data3DTexture 要求（x-最快，z-最慢），保证纹理采样正确。
 */

// ─── 模块拆分说明（聚合再出口 barrel）─────────────────────────
// 本文件实现已按职责拆分至 ./vibration/ 子模块（纯搬运，逻辑/数值/注释语义零改动），
// 此处仅做聚合再出口：对外符号名、签名与默认导出对象完全不变，既有 import 方
// （blastingManager、vibrationComputeWorker、contourExtractor、sceneBuilder、
// vibrationColorScales、vibrationParticleRenderer 及各测试文件）零改动。
// 子模块结构：
//   vibration/shared.js        共享常量与底层工具（萨道夫斯基公式/回退默认值、近场修正、
//                              损伤阈值、径向包络、自由面反射展开、距离/累加/错峰缓存）
//   vibration/grid.js          buildPpvGrid 体网格生成
//   vibration/ppvField.js      单源/多源瞬时与峰值 PPV 场、应力反演、装药源解析、峰值缓存槽
//   vibration/damage.js        损伤分区（Persson 模型）
//   vibration/timeHistory.js   测点时程 / 衰减剖面 / 单点矢量采样
//   vibration/surfaceField.js  岩面顶点峰值场（等值线数据源）
//   vibration/simulator.js     LocalVibrationSimulator 类
//   vibration/particles.js     VibrationParticleSystem 粒子系统
//   vibration/computeClient.js VibrationComputeClient Worker 客户端
// 子模块间下划线前缀内部符号（_ensurePeakSlot 等）不在此聚合导出，保持对外 API 不变。

import {
  NEAR_FIELD_MULT,
  NEAR_FIELD_GAIN,
  cavityRadius,
  nearFieldRadius,
  nearFieldGain,
  DETONATION_GAMMA,
  ROCK_SIGMA_CD_DEFAULT,
  ROCK_SIGMA_TD_DEFAULT,
  BOREHOLE_RADIUS_DEFAULT,
  damageZoneRadius,
  normalizeReflections,
  tunnelFaceBoostFactor,
  expandSourcesWithReflections,
  sadoskyPpv,
  WAVELET_Q
} from './vibration/shared.js'
import { buildPpvGrid } from './vibration/grid.js'
import {
  computePpvField3d,
  resolveChargePosition,
  buildChargeSources,
  computeMultiSourcePpvField3d,
  computeStressFieldFromPpv,
  computeMultiSourcePeakField3d,
  computePeakField3d
} from './vibration/ppvField.js'
import {
  classifyDamageZones,
  computePeakDamageZones,
  computeMultiSourcePeakDamageZones
} from './vibration/damage.js'
import {
  computeMonitorTimeHistory,
  computePpvDecayProfile,
  computePointVector
} from './vibration/timeHistory.js'
import { computeSurfacePeakField } from './vibration/surfaceField.js'
import { LocalVibrationSimulator } from './vibration/simulator.js'
import { VibrationParticleSystem } from './vibration/particles.js'
import { VibrationComputeClient } from './vibration/computeClient.js'

export {
  NEAR_FIELD_MULT,
  NEAR_FIELD_GAIN,
  cavityRadius,
  nearFieldRadius,
  nearFieldGain,
  DETONATION_GAMMA,
  ROCK_SIGMA_CD_DEFAULT,
  ROCK_SIGMA_TD_DEFAULT,
  BOREHOLE_RADIUS_DEFAULT,
  damageZoneRadius,
  normalizeReflections,
  tunnelFaceBoostFactor,
  expandSourcesWithReflections,
  sadoskyPpv,
  WAVELET_Q,
  buildPpvGrid,
  computePpvField3d,
  resolveChargePosition,
  buildChargeSources,
  computeMultiSourcePpvField3d,
  computeStressFieldFromPpv,
  computeMultiSourcePeakField3d,
  computePeakField3d,
  classifyDamageZones,
  computePeakDamageZones,
  computeMultiSourcePeakDamageZones,
  computeMonitorTimeHistory,
  computePpvDecayProfile,
  computePointVector,
  computeSurfacePeakField,
  LocalVibrationSimulator,
  VibrationParticleSystem,
  VibrationComputeClient
}

export default {
  buildPpvGrid,
  sadoskyPpv,
  computePpvField3d,
  computeStressFieldFromPpv,
  classifyDamageZones,
  computePeakDamageZones,
  resolveChargePosition,
  buildChargeSources,
  normalizeReflections,
  expandSourcesWithReflections,
  computeMultiSourcePpvField3d,
  computeMultiSourcePeakDamageZones,
  computeMultiSourcePeakField3d,
  computePeakField3d,
  nearFieldRadius,
  cavityRadius,
  nearFieldGain,
  computeSurfacePeakField,
  computeMonitorTimeHistory,
  computePointVector,
  computePpvDecayProfile,
  LocalVibrationSimulator,
  VibrationParticleSystem,
  VibrationComputeClient
}
