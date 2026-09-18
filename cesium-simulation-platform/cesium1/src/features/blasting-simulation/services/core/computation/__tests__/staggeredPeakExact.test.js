import { describe, it, expect } from 'vitest'
import {
  computeMonitorTimeHistory,
  computeSurfacePeakField,
  computeMultiSourcePeakField3d,
  computeMultiSourcePeakDamageZones,
  computePpvDecayProfile,
  computePointVector,
  expandSourcesWithReflections,
  sadoskyPpv
} from '../localVibrationSimulator.js'

/**
 * 时域错峰叠加峰值（history）的"逐点到达序"精确性回归。
 *
 * 模型：每源波形为到达后指数衰减包络 A·e^(−D·τ)，点 p 总速度
 *   V(p,t) = Σ_{arr_s(p)≤t} A_s·e^(−D·(t−arr_s(p)))·û_s
 * 两到达之间单调衰减 → 峰值只出现在到达时刻，且累加必须按**该点自身的
 * 到达序**（arr = delay + r/c̄ 随点变化）。旧实现按全局延时序累加，在
 * visualCp 模式下（路径时差 ~1s 压倒延期差 0~0.2s）会把未到达源以
 * e^(+D·Δarr)>1 的权重提前计入 → 系统性偏高。本测试用
 * computeMonitorTimeHistory（carrierHz=0，同一模型的逐时刻暴力采样）作
 * 基准，锁定 peak 场 ≡ 暴力时程最大值（相对误差 < 1%）。
 *
 * 场景：延早路远 + 延晚路近 —— 探针 [0,0,20] 处
 *   延时序  A(0ms) < C(100ms) < B(250ms)
 *   到达序  B(0.32s) < C(0.45s) < A(0.58s)   （完全颠倒，旧实现偏差 >20%）
 */

const PROBE = [0, 0, 20]
// 探针在 +z 轴上：holeOcclusion/axialGain 恒为 1（视线纯轴向），整形因子退化
const SOURCES = [
  { x: 3, y: 0, z: 0, chargeKg: 100, delayMs: 0 }, // r≈20.2 → arr≈0.578s（最后到）
  { x: -2, y: 1, z: 8, chargeKg: 60, delayMs: 100 }, // r≈12.1 → arr≈0.445s
  { x: 0.5, y: 0.2, z: 17.6, chargeKg: 40, delayMs: 250 } // r≈2.47 → arr≈0.321s（先到）
]
const OPTS = { K: 90, alpha: 1.58, visualCp: 35, visualBeta: 0.8, beta: 0.02, minStandoff: 0.5 }

// 暴力基准：包络时程逐时刻采样取最大（dt=1ms，欠采样偏差 ≤ e^(−D·dt)≈0.08%）
function brutePpv(point, sources, opts = {}) {
  const times = new Float32Array(2001)
  for (let i = 0; i < times.length; i++) times[i] = i * 0.001
  const hist = computeMonitorTimeHistory(point, sources, times, {
    ...OPTS,
    ...opts,
    carrierHz: 0
  })
  return hist.ppv
}

describe('时域错峰峰值 = 逐点到达序精确解（history）', () => {
  it('computeSurfacePeakField ≡ 暴力时程最大值（直达场）', () => {
    const brute = brutePpv(PROBE, SOURCES)
    expect(brute).toBeGreaterThan(0)
    const { peak } = computeSurfacePeakField(new Float32Array(PROBE), {
      ...OPTS,
      sources: SOURCES,
      origin: [0, 0, 0]
    })
    const rel = Math.abs(peak[0] - brute) / brute
    expect(rel).toBeLessThan(0.01)
  })

  it('含镜象反射（gate 条目参与错峰、岩体侧门控）仍 ≡ 暴力基准', () => {
    // 反射面取 z=16：早源 A（z=17，岩体侧）的负号镜像反射在晚源 B 直达前
    // 参与叠加 → 峰值改变 ~20%（非平凡路径，可判别 gate/错峰/镜像符号错误）
    const reflections = [{ axis: 'z', value: 16, coeff: 0.85 }]
    const sources = [
      { x: 3, y: 0, z: 17, chargeKg: 100, delayMs: 0 }, // 直达 arr≈0.12s；镜象 arr≈0.17s
      { x: 0.5, y: 0.2, z: 17.6, chargeKg: 40, delayMs: 250 } // 直达 arr≈0.32s
    ]
    const bruteDirect = brutePpv(PROBE, sources)
    const brute = brutePpv(PROBE, sources, { reflections })
    expect(Math.abs(brute - bruteDirect) / bruteDirect).toBeGreaterThan(0.1)
    const { peak } = computeSurfacePeakField(new Float32Array(PROBE), {
      ...OPTS,
      sources,
      origin: [0, 0, 0],
      reflections
    })
    const rel = Math.abs(peak[0] - brute) / brute
    expect(rel).toBeLessThan(0.01)
  })

  it('体网格峰值场（_ensurePeakSlot）≡ 暴力基准，且波前未到达处为 0', () => {
    const brute = brutePpv(PROBE, SOURCES)
    const grid = new Float32Array([0, 0, 20, 5, 5, 5])
    const tAfter = 3.0 // 已过全部到达时刻
    const field = computeMultiSourcePeakField3d(grid, tAfter, {
      ...OPTS,
      sources: SOURCES
    })
    const rel = Math.abs(field[0] - brute) / brute
    expect(rel).toBeLessThan(0.01)
    expect(field[1]).toBeGreaterThan(0)
    // 波前未到达门控：t=0.1 < 最早到达 0.321s → 0（弹性）
    const early = computeMultiSourcePeakField3d(grid, 0.1, { ...OPTS, sources: SOURCES })
    expect(early[0]).toBe(0)
    const zones = computeMultiSourcePeakDamageZones(grid, 0.1, { ...OPTS, sources: SOURCES })
    expect(zones[0]).toBe(0)
  })

  it("peakMethod='bound' 分支回归：|Σ A·û|（同时叠加保守上界）", () => {
    const grid = new Float32Array(PROBE)
    const field = computeMultiSourcePeakField3d(grid, 3.0, {
      ...OPTS,
      sources: SOURCES,
      peakMethod: 'bound'
    })
    let ex = 0
    let ey = 0
    let ez = 0
    for (const s of SOURCES) {
      const dx = PROBE[0] - s.x
      const dy = PROBE[1] - s.y
      const dz = PROBE[2] - s.z
      const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.5)
      const a = OPTS.K * Math.pow(s.chargeKg, OPTS.alpha / 3) * 0.01 * Math.pow(r, -OPTS.alpha)
      ex += a * (dx / r)
      ey += a * (dy / r)
      ez += a * (dz / r)
    }
    expect(field[0]).toBeCloseTo(Math.sqrt(ex * ex + ey * ey + ez * ez), 4)
  })
})

describe('expandSourcesWithReflections 负号镜像 + 幅值损耗', () => {
  it('镜象条目 coef 取负 × coeff、带 gate；直达条目不变', () => {
    const entries = [{ x: 0, y: 0, z: 12, chargeKg: 8, delay: 0.5, coef: 1.234 }]
    const out = expandSourcesWithReflections(entries, [{ axis: 'z', value: 10, coeff: 0.6 }], 0)
    expect(out.length).toBe(2)
    const img = out[1]
    expect(img.z).toBe(8) // 2×10 − 12
    expect(img.gate).toEqual({ axis: 'z', min: 10 })
    // 负号镜像（自由面/压力释放边界：面上法向振速加倍），|幅值| × coeff 损耗
    expect(img.coef).toBeCloseTo(-1.234 * 0.6, 10)
    expect(out[0].coef).toBeCloseTo(1.234, 10)
    expect(out[0].gate).toBeNull()
  })

  it('源不在岩体侧（z ≤ 面位置）不生成反射', () => {
    const entries = [{ x: 0, y: 0, z: 5, chargeKg: 8, delay: 0.5, coef: 1.0 }]
    const out = expandSourcesWithReflections(entries, [{ axis: 'z', value: 10, coeff: 0.6 }], 0)
    expect(out.length).toBe(1)
    expect(out[0].gate).toBeNull()
  })
})

describe('computePpvDecayProfile 最大单响药量口径', () => {
  it('theory 线用 15ms 窗内最大药量和（同段齐发），totalQ 仅作展示', () => {
    const sources = [
      { x: 0, y: 0, z: 3, chargeKg: 10, delayMs: 0 },
      { x: 1, y: 0, z: 3, chargeKg: 20, delayMs: 2 },
      { x: 2, y: 0, z: 3, chargeKg: 30, delayMs: 5 }, // 同段（0~5ms）窗内和 = 60
      { x: 0, y: 1, z: 3, chargeKg: 5, delayMs: 250 },
      { x: 1, y: 1, z: 3, chargeKg: 7, delayMs: 252 } // 第二段 = 12
    ]
    const profile = computePpvDecayProfile(sources, { K: 90, alpha: 1.58 })
    expect(profile.maxChargePerDelay).toBeCloseTo(60, 6)
    expect(profile.totalQ).toBeCloseTo(72, 6)
    // 理论线逐点 = sadoskyPpv(maxChargePerDelay, r)
    for (let k = 0; k < profile.r.length; k++) {
      const th = sadoskyPpv(profile.maxChargePerDelay, profile.r[k], { K: 90, alpha: 1.58 })
      expect(profile.theory[k]).toBeCloseTo(th, 10)
    }
  })

  it('雷管抖动使同段孔延时不严格同刻时，窗口径仍归并同段', () => {
    const sources = [
      { x: 0, y: 0, z: 3, chargeKg: 30, delayMs: 100 - 4 },
      { x: 1, y: 0, z: 3, chargeKg: 30, delayMs: 100 },
      { x: 2, y: 0, z: 3, chargeKg: 30, delayMs: 100 + 4 }
    ]
    const profile = computePpvDecayProfile(sources, { K: 90, alpha: 1.58 })
    expect(profile.maxChargePerDelay).toBeCloseTo(90, 6)
  })
})

describe('computePointVector 波前连续性（sin 起振为零）', () => {
  it('到达瞬间幅值≈0，四分之一周期后达满幅（无 cos 跳变）', () => {
    const src = [{ x: 0, y: 0, z: 0, chargeKg: 50, delayMs: 0 }]
    const p = [0, 0, 6]
    const arr = 6 / 35
    const carrierHz = 40
    const T = 1 / carrierHz
    const opts = { ...OPTS, carrierHz }
    const vAtArrival = computePointVector(p, src, arr + 1e-4, opts)
    const vQuarter = computePointVector(p, src, arr + T / 4, opts)
    expect(vQuarter.mag).toBeGreaterThan(0)
    // sin(2π·40·1e-4)≈0.0503 → 到达瞬间幅值 < 8% 满幅（包络仅衰减 0.4%）
    expect(vAtArrival.mag).toBeLessThan(0.08 * vQuarter.mag)
  })
})
