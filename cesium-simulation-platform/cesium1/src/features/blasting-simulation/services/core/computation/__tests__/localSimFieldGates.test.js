import { describe, it, expect } from 'vitest'
import {
  computePpvField3d,
  computeMultiSourcePpvField3d,
  computePeakDamageZones,
  computeMultiSourcePeakDamageZones,
  computeSurfacePeakField,
  VibrationComputeClient
} from '../localVibrationSimulator.js'

/**
 * 回归：本地模拟器（暂停/推流结束后接管热力图的数据源）缺 influenceRadius
 * 口径，与后端 WS 推流场不一致：
 *  - 后端 ppv_field_3d_multi / peak_ppv_envelope_multi 均施加径向能量包络
 *    env(r) = clip((R+tau−r)/tau, 0, 1)（tau=3m，r=到最近真实装药源距离）。
 * 本地模拟器没有 → 同一时刻 WS 模式与本地模式画面跳变（拖动进度条时
 * 后端推 seek 帧 + 本地帧交替写纹理，看起来"Seek 后场值不对"）。
 *
 * 口径契约（与 backend-py/app/services/blasting/blast_physics.py 逐项对齐）：
 *   PPV/峰值：field × env(influenceRadius, tau=3)
 *   损伤分区：digitize(peak × env) —— 损伤半径完全由 PPV 阈值纯物理计算，
 *   不施加人工 atten(damageMaxRadius) 上限（damageMaxRadius 已废弃）。
 * 未传参（0/null）时门控关闭，保持向后兼容。
 */

// 网格点：r=5（包络内）、r=12（衰减带 10~13）、r=16（超程归零），源在原点
const makeGrid = () =>
  new Float32Array([5, 0, 0, 12, 0, 0, 16, 0, 0])
const SRC = [{ x: 0, y: 0, z: 0, chargeKg: 84, delayMs: 0 }]
const OPTS = { K: 90, alpha: 1.58, sources: SRC }

describe('computeMultiSourcePpvField3d 径向能量包络（与后端同口径）', () => {
  it('超 influenceRadius+tau 归零；包络内不受影响；衰减带线性过渡', () => {
    const grid = makeGrid()
    const t = 1.0 // 波前已过全部点（r/35 ≤ 0.46s）
    const ref = computeMultiSourcePpvField3d(grid, t, OPTS)
    const env = computeMultiSourcePpvField3d(grid, t, {
      ...OPTS,
      influenceRadius: 10
    })
    expect(ref[0]).toBeGreaterThan(0)
    expect(env[0]).toBeCloseTo(ref[0], 6) // r=5 ≤ R：env=1
    // r=12 ∈ [10,13]：env=(13−12)/3=1/3
    expect(env[1]).toBeCloseTo(ref[1] / 3, 5)
    expect(env[2]).toBe(0) // r=16 ≥ R+tau：归零
  })

  it('不传 influenceRadius 时无包络（向后兼容）', () => {
    const grid = makeGrid()
    const a = computeMultiSourcePpvField3d(grid, 1.0, OPTS)
    const b = computeMultiSourcePpvField3d(grid, 1.0, { ...OPTS, influenceRadius: 0 })
    expect(b[2]).toBeCloseTo(a[2], 6)
  })
})

describe('computePpvField3d 单源包络（与多源同口径）', () => {
  it('超程归零、包络内不受影响', () => {
    const grid = makeGrid()
    const ref = computePpvField3d(grid, 84, 1.0, { K: 90, alpha: 1.58 })
    const env = computePpvField3d(grid, 84, 1.0, {
      K: 90,
      alpha: 1.58,
      influenceRadius: 10
    })
    expect(env[0]).toBeCloseTo(ref[0], 6)
    expect(env[2]).toBe(0)
  })
})

describe('computeMultiSourcePeakDamageZones 损伤门控（env，与后端同口径）', () => {
  // K=90、q=84：r=8 处峰值 ≈ 90·(4.38/8)^1.58·0.01 ≈ 0.30 m/s = 30 cm/s → zone1
  const gridFar = new Float32Array([8, 0, 0])
  it('损伤半径由 PPV 阈值纯物理计算（无人工上限）', () => {
    const z = computeMultiSourcePeakDamageZones(gridFar, 1.0, OPTS)
    expect(z[0]).toBeGreaterThanOrEqual(1) // 30cm/s → zone1
    // 即使显式传 damageMaxRadius（已废弃参数）也不应改变分区——不再做人工收束
    const zCap = computeMultiSourcePeakDamageZones(gridFar, 1.0, {
      ...OPTS,
      damageMaxRadius: 6
    })
    expect(zCap[0]).toBeGreaterThanOrEqual(1)
  })

  it('influenceRadius 超程 → 分区归 0', () => {
    const capped = computeMultiSourcePeakDamageZones(gridFar, 1.0, {
      ...OPTS,
      influenceRadius: 6
    })
    expect(capped[0]).toBe(0) // r=8 ≥ 6+3：包络归零
  })

  it('峰值缓存按门控参数失效：influenceRadius 变化后分区必须变化', () => {
    // r=8 峰值 ≈ 35cm/s：宽包络（30m）→ zone1；窄包络（6m）→ env=(9−8)/3=1/3，
    // 峰值 ×1/3 ≈ 12cm/s < 20 → zone0。回宽后必须恢复。
    const grid = new Float32Array([8, 0, 0])
    const wide = computeMultiSourcePeakDamageZones(grid, 1.0, {
      ...OPTS,
      influenceRadius: 30
    })
    expect(wide[0]).toBe(1)
    const narrow = computeMultiSourcePeakDamageZones(grid, 1.0, {
      ...OPTS,
      influenceRadius: 6
    })
    expect(narrow[0]).toBe(0)
    const wideAgain = computeMultiSourcePeakDamageZones(grid, 1.0, {
      ...OPTS,
      influenceRadius: 30
    })
    expect(wideAgain[0]).toBe(1)
  })
})

describe('computePeakDamageZones 单源损伤门控（env）', () => {
  it('损伤分区由 PPV 阈值决定，不设人工上限', () => {
    const grid = new Float32Array([8, 0, 0])
    const opts = { K: 90, alpha: 1.58, chargeKg: 84 }
    const z = computePeakDamageZones(grid, 84, 1.0, opts)
    expect(z[0]).toBeGreaterThanOrEqual(1)
    // 显式传已废弃的 damageMaxRadius 不影响分区（纯 PPV 阈值计算）
    const zCap = computePeakDamageZones(grid, 84, 1.0, { ...opts, damageMaxRadius: 6 })
    expect(zCap[0]).toBeGreaterThanOrEqual(1)
  })
})

describe('computeSurfacePeakField 包络（等值线与 GPU peak *= env 同口径）', () => {
  it('超程点峰值归零', () => {
    const surface = makeGrid()
    const ref = computeSurfacePeakField(surface, { K: 90, alpha: 1.58, chargeKg: 84 })
    const env = computeSurfacePeakField(surface, {
      K: 90,
      alpha: 1.58,
      chargeKg: 84,
      influenceRadius: 10
    })
    expect(ref.peak[0]).toBeGreaterThan(0)
    expect(env.peak[0]).toBeCloseTo(ref.peak[0], 6)
    expect(env.peak[2]).toBe(0)
  })
})

describe('VibrationComputeClient._signature 纳入门控参数（滑块变化触发 Worker 重配）', () => {
  const makeSim = p => ({
    gridXyz: new Float32Array(30),
    chargeKg: 84,
    params: {
      K: 90,
      alpha: 1.58,
      beta: 0.02,
      visualBeta: 0.8,
      visualCp: 35,
      sources: null,
      reflections: null,
      ...p
    }
  })
  it('influenceRadius 变化 → 签名变化', () => {
    const client = new VibrationComputeClient()
    const base = client._signature(makeSim({ influenceRadius: 30 }))
    const changedInf = client._signature(makeSim({ influenceRadius: 14 }))
    expect(changedInf).not.toBe(base)
  })
})
