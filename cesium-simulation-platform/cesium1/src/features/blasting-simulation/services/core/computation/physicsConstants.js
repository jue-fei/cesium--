/**
 * 爆破碎片物理共享常量与空气阻力模型（单源）
 *
 * blastPhysicsEngine.js（自研 JS 引擎）与 rapierPhysicsEngine.js（Rapier 引擎）
 * 必须使用同一套物理常量与阻力模型，保证两引擎可透明替换且行为一致。
 * 此前这些量在两个文件各维护一份（靠注释约定"保持一致"），现收拢到本模块。
 */

// ─── 物理常量 ──────────────────────────────────────────
export const GRAVITY = 9.8

// 堆积冻结参数
export const SETTLE_SPEED = 0.8 // 冻结速度阈值(m/s)（提高以加速堆积冻结）
export const SETTLE_FRAMES = 3 // 持续低速帧数才冻结（降低以加速堆积冻结）

// 能量统计采样间隔（秒）：每 100ms 采样一次动能与堆积质量比，避免数组过大
export const ENERGY_SAMPLE_INTERVAL = 0.1

// ─── 空气动力学常量（原 particleSystemCore.js，收拢至此）───
export const AIR_DENSITY = 1.225 // ρ_air (kg/m³, 海平面 15℃)
export const AIR_KINEMATIC_VISC = 1.5e-5 // ν_air (m²/s, 运动粘度)
export const SPHERE_DRAG_COEFF = 0.47 // 球体湍流区阻力系数 Cd

// ─── body 状态标志位 ───────────────────────────────────
export const FLAG_ALIVE = 0x01
export const FLAG_LANDED = 0x02

/**
 * 计算碎片在空气中受到的阻力加速度（P-01 分段阻力模型）
 * 基于雷诺数自动选择湍流/过渡/层流阻力系数：
 * - Re > 1e4：湍流区，Cd = 0.47（球体常数）
 * - 1 < Re <= 1e4：过渡区，Schiller-Naumann 关联式
 * - Re <= 1：Stokes 区，Cd = 24/Re
 * @param {number} vx - 速度 x 分量 (m/s)
 * @param {number} vy - 速度 y 分量 (m/s)
 * @param {number} vz - 速度 z 分量 (m/s)
 * @param {number} size - 等效直径 (m)
 * @param {number} mass - 质量 (kg)
 * @returns {{ax:number, ay:number, az:number}} 阻力加速度向量（与速度方向相反）
 */
export function computeDragAccel(vx, vy, vz, size, mass) {
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz)
  if (v < 1e-6 || mass <= 0) return { ax: 0, ay: 0, az: 0 }
  const d = Math.max(0.01, size) // 等效直径
  const Re = (v * d) / AIR_KINEMATIC_VISC
  // 截面积（按球体）
  const area = Math.PI * (d / 2) * (d / 2)
  // 计算阻力系数 Cd
  let Cd
  if (Re > 1e4) {
    Cd = SPHERE_DRAG_COEFF
  } else if (Re > 1) {
    // Schiller-Naumann 关联式
    Cd = (24 / Re) * (1 + 0.15 * Math.pow(Re, 0.687))
  } else {
    // Stokes 区：等价 Cd = 24/Re，最终与 Fd = 3π·μ·d·v 一致
    Cd = 24 / Math.max(1e-3, Re)
  }
  // 阻力大小 Fd = ½·Cd·ρ·A·v²
  const Fd = 0.5 * Cd * AIR_DENSITY * area * v * v
  // 阻力加速度 a = Fd / m，方向与速度相反
  const a = Fd / mass
  const ax = -(a * vx) / v
  const ay = -(a * vy) / v
  const az = -(a * vz) / v
  return { ax, ay, az }
}
