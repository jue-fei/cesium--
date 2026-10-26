/**
 * 多源 PPV / 损伤分区**起爆段等效药量标度**回归测试
 *
 * 回归背景（用户实测问题）：损伤分区被系统性放大约 6~12 倍、破碎区远大于实际开挖范围。
 * 根因有二：
 *   ① 各炮孔峰值振幅**直接矢量相加**：萨道夫斯基药量为立方根标度，同段 N 孔齐爆远场
 *      只按 N^(α/3) 增长，直接相加相当于按 N^1 标度（42 孔 ≈ ×6；对"最大段药量"口径 ≈ ×12）；
 *   ② 峰值判据**跨起爆段相加**：段间波峰错峰到达本不叠加（可视化 τ≈1.2s ≫ 段间隔 75ms
 *      造成错误累加），应按规范取各段最大值。
 * 本测试锁定：归一性质（Σq_eff^(α/3) ≡ Q_段^(α/3)）、远场等效药量一致、损伤按段取最大。
 */
import { describe, it, expect } from 'vitest'
import {
  applyDelayGroupNormalization,
  computeMultiSourcePpvField3d,
  computeMultiSourcePeakDamageZones,
  estimateDamageAwareGrid,
  sadoskyPpv
} from '../localVibrationSimulator.js'

const K = 90.63
const ALPHA = 1.58
const OPT = { K, alpha: ALPHA, visualCp: 35, minStandoff: 0.5 }

/** 生成一"起爆段"：8 孔 2.4kg，位于掏槽汇拢点附近（x 向展布 ±0.7m） */
function makeGroup(delayMs) {
  const out = []
  for (let i = 0; i < 8; i++) {
    out.push({ x: i * 0.2 - 0.7, y: 1.3, z: 5.7, chargeKg: 2.4, delayMs })
  }
  return out
}

describe('起爆段等效药量归一（立方根标度）', () => {
  it('同段 Σq_eff^(α/3) = Q_段^(α/3)，且保留真实 chargeKg', () => {
    const srcs = [...makeGroup(0), ...makeGroup(525).map(s => ({ ...s, chargeKg: 1.0 }))]
    const norm = applyDelayGroupNormalization(srcs, ALPHA)
    const sum1 = norm.slice(0, 8).reduce((s, o) => s + Math.pow(o.fieldChargeKg, ALPHA / 3), 0)
    const sum2 = norm.slice(8).reduce((s, o) => s + Math.pow(o.fieldChargeKg, ALPHA / 3), 0)
    expect(sum1).toBeCloseTo(Math.pow(19.2, ALPHA / 3), 6)
    expect(sum2).toBeCloseTo(Math.pow(8.0, ALPHA / 3), 6) // 第二段 8 孔 × 1.0kg
    expect(norm[0].chargeKg).toBe(2.4) // 真实药量保留给 JWL/FDTD 与统计
    expect(norm[0].fieldChargeKg).toBeLessThan(2.4) // 等效场药量已归一
  })

  it('远场：同段 8 孔矢量叠加 ≡ 等效药量 Q=Σq 单源（未归一会 ≈2.7 倍）', () => {
    const srcs = makeGroup(0)
    const norm = applyDelayGroupNormalization(srcs, ALPHA)
    const grid = new Float32Array([0, 0, 0, 0, 1.3, 20]) // >1 点：顺带覆盖广播类缺陷
    const t = 20 / 35 + 3.0
    const ppv = computeMultiSourcePpvField3d(grid, t, { ...OPT, sources: norm })
    // 源在 z=5.7、观察点在 z=20 → 距离 14.3m（源横向 ±0.7m 的影响 <0.1%）
    const d = 14.3
    const decay = Math.exp(-(0.02 + 0.8) * (t - d / 35))
    const equiv = sadoskyPpv(19.2, d, OPT) * decay
    expect(ppv[1] / equiv).toBeCloseTo(1.0, 2) // ±0.5%
    // 历史口径（不加权直接相加）在 8 孔时偏大 N^(1−α/3)=8^0.473≈2.67 倍
    const unnorm = computeMultiSourcePpvField3d(grid, t, { ...OPT, sources: srcs })
    expect(unnorm[1]).toBeGreaterThan(ppv[1] * 2.4)
    expect(unnorm[1]).toBeLessThan(ppv[1] * 3.0)
  })
})

describe('损伤场采样域适配', () => {
  it('将最低损伤阈值轮廓与缓冲带纳入边界', () => {
    const baseBoundsMin = [-6, 0, 0]
    const baseBoundsMax = [6, 10, 20]
    const grid = estimateDamageAwareGrid({
      boundsMin: baseBoundsMin,
      boundsMax: baseBoundsMax,
      gridShape: [13, 11, 21],
      chargeKg: 100,
      origin: [0, 5, 10],
      K: 90.63,
      alpha: 1.58,
      paddingMeters: 1.5
    })
    const radius = Math.pow(100, 1 / 3) * Math.pow(90.63 / 25, 1 / 1.58)
    expect(grid.boundsMin[0]).toBeLessThanOrEqual(-radius - 1.5)
    expect(grid.boundsMax[0]).toBeGreaterThanOrEqual(radius + 1.5)
    expect(grid.boundsMin[1]).toBeLessThanOrEqual(5 - radius - 1.5)
    expect(grid.boundsMax[2]).toBeGreaterThanOrEqual(10 + radius + 1.5)
  })

  it('超大损伤域自动降低采样数，不超过体素预算', () => {
    const grid = estimateDamageAwareGrid({
      boundsMin: [-6, 0, 0],
      boundsMax: [6, 10, 20],
      gridShape: [13, 11, 21],
      chargeKg: 100,
      origin: [0, 5, 10],
      K: 100000,
      alpha: 1.5,
      maxVoxels: 60000
    })
    expect(grid.gridShape.reduce((total, size) => total * size, 1)).toBeLessThanOrEqual(60000)
  })
})

describe('损伤分区按起爆段取最大（段间错峰不叠加）', () => {
  it('两段完全相同 → 分区 = 单段分区；若跨段相加则更高', () => {
    const norm = applyDelayGroupNormalization([...makeGroup(0), ...makeGroup(75)], ALPHA)
    const grid = new Float32Array([0, 1.3, 7.6]) // 段幅值约 150cm/s（zone2），两段相加约 300cm/s（zone3）
    const t = 5.0

    const seg1 = computeMultiSourcePeakDamageZones(grid, t, { ...OPT, sources: norm.slice(0, 8) })
    const segAll = computeMultiSourcePeakDamageZones(grid, t, { ...OPT, sources: norm })
    // 两段峰值相同 → 取最大 = 单段（跨段相加会越级）
    expect(segAll[0]).toBe(seg1[0])
    expect(segAll[0]).toBe(2)

    // 对照组：把两段合并为一段（等价历史"跨段相加"口径）——显式 fieldChargeKg 防二次归一
    const asOneGroup = norm.map(s => ({ ...s, delayMs: 0 }))
    const sumZones = computeMultiSourcePeakDamageZones(grid, t, {
      ...OPT,
      sources: asOneGroup
    })
    expect(sumZones[0]).toBeGreaterThan(segAll[0])
  })

  it('波前未到达编码为 -1，与已到达弹性区区分', () => {
    const norm = applyDelayGroupNormalization(makeGroup(0), ALPHA)
    const grid = new Float32Array([0, 1.3, 25.0]) // 到达 ≈ 25/35 ≈ 0.71s
    const zones = computeMultiSourcePeakDamageZones(grid, 0.1, { ...OPT, sources: norm })
    expect(zones[0]).toBe(-1)
  })

  it('同一延时组须等最晚源到达后才结算完整峰值', () => {
    const sources = applyDelayGroupNormalization(
      [
        { x: 0, y: 0, z: 0, chargeKg: 2, delayMs: 0 },
        { x: 0, y: 0, z: 10, chargeKg: 2, delayMs: 0 }
      ],
      ALPHA
    )
    const grid = new Float32Array([0, 0, 1])
    const partial = computeMultiSourcePeakDamageZones(grid, 0.1, {
      ...OPT,
      sources
    })
    const complete = computeMultiSourcePeakDamageZones(grid, 0.3, {
      ...OPT,
      sources
    })

    expect(partial[0]).toBe(-1) // 近源已到，但远源尚未到；不提前纳入远源峰值
    expect(complete[0]).toBeGreaterThanOrEqual(0)
  })
})
