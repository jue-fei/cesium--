/**
 * 爆破应力演化分析 —— 结构力学关键区域应力随时间变化
 *
 * 基于爆破振动场计算关键监测点的应力时程：
 * - 最大主应力 σ1
 * - 中间主应力 σ2
 * - 最小主应力 σ3
 * - Mises 等效应力
 * - 安全系数 FS = σc / σ_mises
 *
 * 关键区域类型：
 * - 爆心近区（冲击破坏区）
 * - 自由面附近（反射拉伸区）
 * - 结构薄弱面（断层/节理）
 * - 远场区（弹性振动区）
 */

import { VibrationField } from './vibrationFieldCore.js'

// ─── 岩体力学参数 ──────────────────────────────────────
const DEFAULT_ROCK_PARAMS = {
  density: 2650,
  youngsModulus: 30e9,
  poissonsRatio: 0.25,
  compressiveStrength: 80e6,
  tensileStrength: 8e6,
  shearStrength: 15e6
}

// ─── 安全等级 ──────────────────────────────────────────
export const SAFETY_LEVELS = {
  SAFE: { level: 'safe', label: '安全', color: '#2ecc71', threshold: 0.0 },
  WATCH: { level: 'watch', label: '关注', color: '#f1c40f', threshold: 0.4 },
  WARNING: { level: 'warning', label: '预警', color: '#e67e22', threshold: 0.6 },
  DANGER: { level: 'danger', label: '危险', color: '#e74c3c', threshold: 0.8 },
  CRITICAL: { level: 'critical', label: '临界', color: '#c0392b', threshold: 0.95 }
}

export function getSafetyLevel(safetyFactor) {
  const ratio = 1 - Math.min(1, safetyFactor)
  if (ratio >= 0.95) return SAFETY_LEVELS.CRITICAL
  if (ratio >= 0.8) return SAFETY_LEVELS.DANGER
  if (ratio >= 0.6) return SAFETY_LEVELS.WARNING
  if (ratio >= 0.4) return SAFETY_LEVELS.WATCH
  return SAFETY_LEVELS.SAFE
}

/**
 * 应力演化分析器
 */
export class StressEvolutionAnalyzer {
  constructor(config = {}) {
    this.rockParams = { ...DEFAULT_ROCK_PARAMS, ...config.rockParams }
    this.vibrationField = new VibrationField(config)
    this.monitorPoints = []
  }

  /**
   * 设置爆破源
   * @param {Array} sources - 爆破源数组
   */
  setBlastSources(sources) {
    this.vibrationField.clear()
    for (const s of sources) {
      this.vibrationField.addSource(s)
    }
  }

  /**
   * 添加监测点
   * @param {Object} point - 监测点
   * @param {string} point.id - 点 ID
   * @param {string} point.label - 点标签
   * @param {number} point.x - x 坐标(m)
   * @param {number} point.y - y 坐标(m)
   * @param {number} point.z - z 坐标(m)
   * @param {string} point.zoneType - 区域类型
   */
  addMonitorPoint(point) {
    this.monitorPoints.push({
      id: point.id || `MP${this.monitorPoints.length + 1}`,
      label: point.label || `监测点${this.monitorPoints.length + 1}`,
      x: point.x || 0,
      y: point.y || 0,
      z: point.z || 0,
      zoneType: point.zoneType || 'far_field',
      history: []
    })
  }

  /**
   * 自动生成监测点（围绕爆心分布）
   * @param {number} centerX - 爆心 x
   * @param {number} centerY - 爆心 y
   * @param {number} centerZ - 爆心 z
   * @param {Array} holes - 炮孔信息
   */
  autoGenerateMonitorPoints(centerX, centerY, centerZ, holes = []) {
    this.monitorPoints = []
    const distances = [5, 15, 30, 60, 100, 150]
    const angles = [0, Math.PI / 3, (2 * Math.PI) / 3, Math.PI, (4 * Math.PI) / 3, (5 * Math.PI) / 3]

    // 近区监测点
    for (let i = 0; i < 3; i++) {
      const angle = angles[i]
      this.addMonitorPoint({
        id: `NEAR-${i + 1}`,
        label: `近区点${i + 1}`,
        x: centerX + Math.cos(angle) * distances[0],
        y: centerY + Math.sin(angle) * distances[0],
        z: centerZ,
        zoneType: 'near_field'
      })
    }

    // 自由面监测点
    for (let i = 0; i < 3; i++) {
      const angle = angles[i + 3]
      this.addMonitorPoint({
        id: `FREE-${i + 1}`,
        label: `自由面点${i + 1}`,
        x: centerX + Math.cos(angle) * distances[1],
        y: centerY + Math.sin(angle) * distances[1],
        z: centerZ,
        zoneType: 'free_face'
      })
    }

    // 中远区监测点
    for (let di = 2; di < distances.length; di++) {
      const dist = distances[di]
      for (let ai = 0; ai < 3; ai++) {
        const angle = angles[ai * 2]
        this.addMonitorPoint({
          id: `MID-${di}-${ai + 1}`,
          label: `${dist}m点${ai + 1}`,
          x: centerX + Math.cos(angle) * dist,
          y: centerY + Math.sin(angle) * dist,
          z: centerZ,
          zoneType: di < 4 ? 'mid_field' : 'far_field'
        })
      }
    }

    // 炮孔附近监测点
    if (holes.length > 0) {
      for (let i = 0; i < Math.min(3, holes.length); i++) {
        const hole = holes[i]
        this.addMonitorPoint({
          id: `HOLE-${hole.id}`,
          label: `炮孔${hole.id}旁`,
          x: (hole.collar?.x || 0) + 2,
          y: (hole.collar?.y || 0) + 2,
          z: hole.collar?.z || centerZ,
          zoneType: 'borehole'
        })
      }
    }
  }

  /**
   * 计算某监测点在给定时刻的应力状态
   *
   * 将振动强度转换为应力：
   * - 振动速度 v 由强度反推：v = intensity * v_max
   * - 应力 σ = ρ * c * v （声弹性关系）
   * - 主应力由振动方向分解
   *
   * @param {Object} point - 监测点
   * @param {number} t - 时间(s)
   * @returns {Object} 应力状态
   */
  computeStressAtPoint(point, t) {
    const intensity = this.vibrationField.computeIntensity(point.x, point.y, point.z, t)
    if (intensity < 1e-6) {
      return this._zeroStress(point.id, t)
    }

    const { density, youngsModulus: E, poissonsRatio: nu } = this.rockParams
    const vp = Math.sqrt((E * (1 - nu)) / (density * (1 + nu) * (1 - 2 * nu)))
    const vs = Math.sqrt(E / (2 * density * (1 + nu)))

    // 最大振动速度 (m/s)，经验公式：v = k * Q^0.5 / R^0.75
    const vMax = intensity * 0.8

    // 声弹性关系：σ = ρ * c * v
    const sigmaP = density * vp * vMax
    const sigmaS = density * vs * vMax * 0.7

    // 主应力（简化模型）
    const sigma1 = sigmaP + sigmaS * 0.3
    const sigma2 = (sigmaP - sigmaS) * 0.3
    const sigma3 = -sigmaS * 0.5

    // Mises 等效应力
    const mises = Math.sqrt(
      0.5 * (
        (sigma1 - sigma2) ** 2 +
        (sigma2 - sigma3) ** 2 +
        (sigma3 - sigma1) ** 2
      )
    )

    // 安全系数
    const safetyFactor = this.rockParams.compressiveStrength / Math.max(1, mises)

    // 拉伸破坏判断
    const maxTensile = Math.max(0, -sigma3)
    const tensileSafety = this.rockParams.tensileStrength / Math.max(1, maxTensile)

    return {
      pointId: point.id,
      pointLabel: point.label,
      zoneType: point.zoneType,
      time: Number(t.toFixed(3)),
      intensity: Number(intensity.toFixed(4)),
      vibrationVelocity: Number(vMax.toFixed(4)),
      sigma1: Number((sigma1 / 1e6).toFixed(3)),
      sigma2: Number((sigma2 / 1e6).toFixed(3)),
      sigma3: Number((sigma3 / 1e6).toFixed(3)),
      mises: Number((mises / 1e6).toFixed(3)),
      safetyFactor: Number(safetyFactor.toFixed(3)),
      tensileSafety: Number(tensileSafety.toFixed(3)),
      safetyLevel: getSafetyLevel(safetyFactor).level,
      maxTensile: Number((maxTensile / 1e6).toFixed(3))
    }
  }

  _zeroStress(pointId, t) {
    return {
      pointId,
      pointLabel: '',
      zoneType: '',
      time: Number(t.toFixed(3)),
      intensity: 0,
      vibrationVelocity: 0,
      sigma1: 0,
      sigma2: 0,
      sigma3: 0,
      mises: 0,
      safetyFactor: 99,
      tensileSafety: 99,
      safetyLevel: 'safe',
      maxTensile: 0
    }
  }

  /**
   * 计算所有监测点在给定时刻的应力状态
   * @param {number} t - 时间(s)
   * @returns {Array} 应力状态数组
   */
  computeAllPoints(t) {
    return this.monitorPoints.map(p => this.computeStressAtPoint(p, t))
  }

  /**
   * 生成完整时间序列的应力演化数据
   * @param {number} duration - 总时长(s)
   * @param {number} frameCount - 帧数
   * @returns {Object} { frames: Array, points: Array }
   */
  generateEvolutionSeries(duration, frameCount) {
    const frames = []
    const dt = duration / frameCount

    for (let i = 0; i < frameCount; i++) {
      const t = i * dt
      const stresses = this.computeAllPoints(t)
      frames.push({ t: Number(t.toFixed(3)), stresses })

      // 记录历史
      for (const s of stresses) {
        const point = this.monitorPoints.find(p => p.id === s.pointId)
        if (point) point.history.push(s)
      }
    }

    // 汇总每个监测点的峰值
    const points = this.monitorPoints.map(p => {
      const history = p.history
      const peakMises = history.reduce((max, h) => Math.max(max, h.mises), 0)
      const peakIntensity = history.reduce((max, h) => Math.max(max, h.intensity), 0)
      const minSafety = history.reduce((min, h) => Math.min(min, h.safetyFactor), 99)
      const peakVibration = history.reduce((max, h) => Math.max(max, h.vibrationVelocity), 0)
      return {
        id: p.id,
        label: p.label,
        zoneType: p.zoneType,
        x: p.x,
        y: p.y,
        z: p.z,
        peakMises: Number(peakMises.toFixed(3)),
        peakIntensity: Number(peakIntensity.toFixed(4)),
        peakVibration: Number(peakVibration.toFixed(4)),
        minSafety: Number(minSafety.toFixed(3)),
        safetyLevel: getSafetyLevel(minSafety).level
      }
    })

    return { frames, points }
  }

  clear() {
    this.monitorPoints = []
    this.vibrationField.clear()
  }
}

export default StressEvolutionAnalyzer
