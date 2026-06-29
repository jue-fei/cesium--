/**
 * 爆破振动传播场 —— 动态热力图模拟应力波扩散
 *
 * 物理模型：
 * - P波（纵波）：传播速度最快，振幅较小
 * - S波（横波）：传播速度较慢，振幅较大，是破坏主因
 * - 表面波（瑞利波）：沿地表传播，衰减最慢，远场破坏主因
 *
 * 热力图采用网格采样，每帧根据应力波传播方程计算各点振动强度，
 * 通过颜色映射（蓝→绿→黄→红）实时渲染振动场。
 */

// ─── 波速常量 (m/s) ────────────────────────────────────
const P_WAVE_SPEED = 4500
const S_WAVE_SPEED = 2600
const RAYLEIGH_WAVE_SPEED = 2200

// ─── 衰减系数 ──────────────────────────────────────────
const P_WAVE_ATTENUATION = 0.012
const S_WAVE_ATTENUATION = 0.018
const RAYLEIGH_WAVE_ATTENUATION = 0.006

// ─── 热力图色带（与应力分析模块一致） ──────────────────
export const VIBRATION_COLOR_RAMP = Object.freeze([
  { value: 0.0, color: [0.07, 0.23, 0.48] },
  { value: 0.15, color: [0.13, 0.35, 0.60] },
  { value: 0.3, color: [0.17, 0.55, 0.75] },
  { value: 0.45, color: [0.30, 0.75, 0.80] },
  { value: 0.55, color: [0.45, 0.85, 0.60] },
  { value: 0.65, color: [0.70, 0.85, 0.35] },
  { value: 0.75, color: [0.95, 0.75, 0.25] },
  { value: 0.85, color: [0.95, 0.50, 0.20] },
  { value: 1.0, color: [0.85, 0.15, 0.15] }
])

/**
 * 将振动强度映射为颜色
 * @param {number} value - 归一化振动强度 [0, 1]
 * @returns {{r: number, g: number, b: number, a: number}}
 */
export function vibrationToColor(value) {
  const v = Math.max(0, Math.min(1, value))
  for (let i = 0; i < VIBRATION_COLOR_RAMP.length - 1; i++) {
    const a = VIBRATION_COLOR_RAMP[i]
    const b = VIBRATION_COLOR_RAMP[i + 1]
    if (v >= a.value && v <= b.value) {
      const t = (v - a.value) / (b.value - a.value)
      return {
        r: a.color[0] + (b.color[0] - a.color[0]) * t,
        g: a.color[1] + (b.color[1] - a.color[1]) * t,
        b: a.color[2] + (b.color[2] - a.color[2]) * t,
        a: 0.35 + v * 0.55
      }
    }
  }
  const last = VIBRATION_COLOR_RAMP[VIBRATION_COLOR_RAMP.length - 1]
  return { r: last.color[0], g: last.color[1], b: last.color[2], a: 0.9 }
}

/**
 * 爆破振动场计算器
 *
 * 在给定网格点上计算每帧的振动强度，
 * 支持多炮孔延时爆破叠加。
 */
export class VibrationField {
  constructor(config = {}) {
    this.gridResolution = config.gridResolution || 64
    this.maxRadius = config.maxRadius || 300
    this.sampleHeight = config.sampleHeight ?? 0
    this.waves = []
  }

  /**
   * 添加一个爆破源
   * @param {Object} source - 爆破源
   * @param {number} source.x - 源 x 坐标(m)
   * @param {number} source.y - 源 y 坐标(m)
   * @param {number} source.z - 源 z 坐标(m)
   * @param {number} source.chargeKg - 装药量(kg)
   * @param {number} source.delayMs - 延时(ms)
   */
  addSource(source) {
    this.waves.push({
      x: source.x || 0,
      y: source.y || 0,
      z: source.z || 0,
      chargeKg: Math.max(1, source.chargeKg || 50),
      delayMs: Math.max(0, source.delayMs || 0),
      energy: Math.pow(Math.max(1, source.chargeKg || 50), 0.6) * 100
    })
  }

  /**
   * 计算某一点在给定时刻的振动强度
   *
   * 综合考虑 P波、S波、瑞利波的叠加效应
   *
   * @param {number} x - 点 x(m)
   * @param {number} y - 点 y(m)
   * @param {number} z - 点 z(m)
   * @param {number} t - 时间(s)
   * @returns {number} 振动强度 [0, 1]
   */
  computeIntensity(x, y, z, t) {
    let totalIntensity = 0

    for (const wave of this.waves) {
      const tWave = t - wave.delayMs / 1000
      if (tWave <= 0) continue

      const dx = x - wave.x
      const dy = y - wave.y
      const dz = z - wave.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < 0.1) continue

      // P波贡献
      const pArrival = dist / P_WAVE_SPEED
      if (tWave > pArrival) {
        const pDecay = Math.exp(-P_WAVE_ATTENUATION * dist) / (1 + dist * 0.01)
        const pEnvelope = Math.exp(-Math.pow((tWave - pArrival) / 0.15, 2))
        const pIntensity = wave.energy * pDecay * pEnvelope
        totalIntensity += pIntensity * 0.2
      }

      // S波贡献（破坏主因）
      const sArrival = dist / S_WAVE_SPEED
      if (tWave > sArrival) {
        const sDecay = Math.exp(-S_WAVE_ATTENUATION * dist) / (1 + dist * 0.012)
        const sEnvelope = Math.exp(-Math.pow((tWave - sArrival) / 0.25, 2))
        const sIntensity = wave.energy * sDecay * sEnvelope
        totalIntensity += sIntensity * 0.5
      }

      // 瑞利波贡献（远场主因，仅在地表附近显著）
      const surfaceFactor = Math.exp(-Math.abs(dz) / 15)
      const rArrival = dist / RAYLEIGH_WAVE_SPEED
      if (tWave > rArrival && surfaceFactor > 0.01) {
        const rDecay = Math.exp(-RAYLEIGH_WAVE_ATTENUATION * dist) / (1 + dist * 0.008)
        const rEnvelope = Math.exp(-Math.pow((tWave - rArrival) / 0.4, 2))
        const rIntensity = wave.energy * rDecay * rEnvelope * surfaceFactor
        totalIntensity += rIntensity * 0.3
      }
    }

    // 归一化到 [0, 1]
    return Math.min(1, totalIntensity / 500)
  }

  /**
   * 生成某一时刻的振动场网格数据
   * @param {number} t - 时间(s)
   * @param {number} centerX - 网格中心 x(m)
   * @param {number} centerY - 网格中心 y(m)
   * @returns {Object} 网格数据 { resolution, data: Float32Array, maxIntensity }
   */
  generateField(t, centerX = 0, centerY = 0) {
    const res = this.gridResolution
    const data = new Float32Array(res * res)
    const halfRange = this.maxRadius
    let maxIntensity = 0

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = centerX + (i / (res - 1) - 0.5) * 2 * halfRange
        const y = centerY + (j / (res - 1) - 0.5) * 2 * halfRange
        const intensity = this.computeIntensity(x, y, this.sampleHeight, t)
        data[j * res + i] = intensity
        if (intensity > maxIntensity) maxIntensity = intensity
      }
    }

    return { resolution: res, data, maxIntensity, time: t }
  }

  /**
   * 生成完整时间序列的振动场数据
   * @param {number} duration - 总时长(s)
   * @param {number} frameCount - 帧数
   * @param {number} centerX - 网格中心 x
   * @param {number} centerY - 网格中心 y
   * @returns {Array} 振动场帧数组
   */
  generateTimeSeries(duration, frameCount, centerX = 0, centerY = 0) {
    const frames = []
    const dt = duration / frameCount
    for (let i = 0; i < frameCount; i++) {
      const t = i * dt
      const field = this.generateField(t, centerX, centerY)
      frames.push(field)
    }
    return frames
  }

  clear() {
    this.waves = []
  }
}

export default VibrationField
