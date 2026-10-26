import { describe, it, expect } from 'vitest'
import {
  calculateKCOParams,
  delayFragmentationFactor,
  DELAY_FRAGMENTATION_CORRECTION
} from '../kcoModelCore.js'

// 刘步青2026（鞍钢哑巴岭采区）工况：B=4 S=6 H=12 d=140mm L=8m Q≈141.6kg
const YABALING = {
  Q: 141.6,
  B: 4,
  S: 6,
  H: 12,
  d: 140,
  Ltot: 8,
  drillDeviation: 0.2,
  RMD: 20,
  RDI: 15,
  HF: 25, // A = 0.06×(20+15+25) = 3.6（平台默认岩石因子口径）
  SANFO: 100,
  xmax: 2.0,
  b: 2.0
}

describe('KCO 延时-块度修正（刘步青2026 哑巴岭现场回归）', () => {
  it('不传 interHoleDelayMs 或传 0 时不修正（向后兼容）', () => {
    const base = calculateKCOParams(YABALING)
    const zero = calculateKCOParams({ ...YABALING, interHoleDelayMs: 0 })
    expect(base.x50).toBeCloseTo(zero.x50, 12)
    expect(base.x80).toBeCloseTo(zero.x80, 12)
    expect(base.delayCorrection).toBeNull()
    expect(zero.delayCorrection).toBeNull()
    expect(delayFragmentationFactor(0)).toBeNull()
    expect(delayFragmentationFactor(-5)).toBeNull()
    expect(delayFragmentationFactor(NaN)).toBeNull()
  })

  it('修正因子数值与回归式一致（f50/f80 独立）', () => {
    const f8 = delayFragmentationFactor(8)
    expect(f8.f50).toBeCloseTo(0.03113 * Math.pow(8, 0.9573), 6)
    expect(f8.f80).toBeCloseTo(0.03123 * Math.pow(8, 1.0583), 6)
    expect(f8.clamped).toBe(false)
    const f22 = delayFragmentationFactor(22)
    expect(f22.f50).toBeGreaterThan(f8.f50)
    expect(f22.f80).toBeGreaterThan(f8.f80)
  })

  it('Δt 超出标定范围 [8,32]ms 时按端点截断并标记 clamped', () => {
    const lo = delayFragmentationFactor(3)
    const hi = delayFragmentationFactor(60)
    const f8 = delayFragmentationFactor(8)
    const f32 = delayFragmentationFactor(32)
    expect(lo.f50).toBeCloseTo(f8.f50, 12)
    expect(lo.clamped).toBe(true)
    expect(hi.f50).toBeCloseTo(f32.f50, 12)
    expect(hi.clamped).toBe(true)
  })

  it('哑巴岭工况：修正后 D50/D80 与实测表 7 一致（±3% 内）', () => {
    // 实测（表7）：8ms → D50=35.93mm, D80=77.38mm
    const base = calculateKCOParams(YABALING)
    const at8 = calculateKCOParams({ ...YABALING, interHoleDelayMs: 8 })
    const f50 = delayFragmentationFactor(8)
    const f80 = delayFragmentationFactor(8)
    expect(at8.x50).toBeCloseTo(base.x50 * f50.f50, 9)
    expect(at8.x80).toBeCloseTo(base.x80 * f80.f80, 9)
    // 基线 x50 = 158.4mm（报告口径）→ 修正后 ≈ 36.1mm vs 实测 35.93mm
    expect((at8.x50 * 1000) / 35.93 - 1).toBeLessThan(0.03)
    expect((at8.x80 * 1000) / 77.38 - 1).toBeLessThan(0.03)
  })

  it('延时越长块度越粗：x50/x80 单调随 Δt 增大（8→22→32ms）', () => {
    const at8 = calculateKCOParams({ ...YABALING, interHoleDelayMs: 8 })
    const at22 = calculateKCOParams({ ...YABALING, interHoleDelayMs: 22 })
    const at32 = calculateKCOParams({ ...YABALING, interHoleDelayMs: 32 })
    expect(at22.x50).toBeGreaterThan(at8.x50)
    expect(at32.x50).toBeGreaterThan(at22.x50)
    expect(at22.x80).toBeGreaterThan(at8.x80)
    expect(at32.x80).toBeGreaterThan(at22.x80)
  })

  it('D80/D50 比值随延时增大（粗端比细端粗化更快，与实测趋势一致）', () => {
    const at8 = calculateKCOParams({ ...YABALING, interHoleDelayMs: 8 })
    const at32 = calculateKCOParams({ ...YABALING, interHoleDelayMs: 32 })
    const ratio8 = at8.x80 / at8.x50
    const ratio32 = at32.x80 / at32.x50
    expect(ratio32).toBeGreaterThan(ratio8)
    // 实测比值：8ms 77.38/35.93=2.15；32ms 493.07/176.77=2.79
    expect(ratio8).toBeGreaterThan(2.0)
    expect(ratio32).toBeGreaterThan(ratio8)
  })

  it('导出常量与默认参数齐备', () => {
    expect(DELAY_FRAGMENTATION_CORRECTION.dtMin).toBe(8)
    expect(DELAY_FRAGMENTATION_CORRECTION.dtMax).toBe(32)
    expect(DELAY_FRAGMENTATION_CORRECTION.f50.c).toBeCloseTo(0.03113, 5)
  })
})
