/**
 * 节理网络模型测试：产状 → 法线 → 三轴比 → Zingg 分类
 *
 * 关键断言：预设 massive 必须落在"等轴块状"，bedded 必须落在"板状"，
 * columnar 必须落在"柱状"——这是碎石不再默认压扁的形状学依据。
 */
import { describe, it, expect } from 'vitest'
import {
  normalFromDip,
  createJointNetwork,
  deriveShapeStats,
  classifyZingg,
  JOINT_PRESETS,
  ZINGG_LABELS
} from '../jointNetwork.js'

describe('jointNetwork', () => {
  it('产状 → 单位法线：水平面法线朝上，竖直面法线水平', () => {
    const flat = normalFromDip(0, 0)
    expect(flat.x).toBeCloseTo(0, 6)
    expect(flat.y).toBeCloseTo(1, 6)
    expect(flat.z).toBeCloseTo(0, 6)

    const vertical = normalFromDip(90, 0)
    expect(vertical.y).toBeCloseTo(0, 6)
    expect(Math.hypot(vertical.x, vertical.y, vertical.z)).toBeCloseTo(1, 6)
  })

  it('三组节理网络：法线单位化、间距为正', () => {
    const net = createJointNetwork({ preset: 'massive', seed: 7 })
    expect(net.sets).toHaveLength(3)
    for (const s of net.sets) {
      expect(Math.hypot(s.normal.x, s.normal.y, s.normal.z)).toBeCloseTo(1, 6)
      expect(s.spacing).toBeGreaterThan(0)
    }
  })

  it('预设形状：massive=块状、bedded=板状、columnar=柱状', () => {
    for (const [key, expectZingg] of [
      ['massive', 'blocky'],
      ['bedded', 'platy'],
      ['columnar', 'columnar']
    ]) {
      const net = createJointNetwork({ preset: key, seed: 42 })
      const stats = deriveShapeStats(net)
      expect(stats.zingg).toBe(expectZingg)
      expect(ZINGG_LABELS[stats.zingg]).toBeTruthy()
    }
  })

  it('间距比决定扁平度：层理间距越密，扁平度越小', () => {
    const bedded = deriveShapeStats(createJointNetwork({ preset: 'bedded', seed: 3 }))
    const massive = deriveShapeStats(createJointNetwork({ preset: 'massive', seed: 3 }))
    expect(bedded.flatness).toBeLessThan(massive.flatness)
    expect(bedded.flatness).toBeLessThan(0.45)
    expect(massive.flatness).toBeGreaterThan(0.6)
  })

  it('Zingg 分类边界', () => {
    expect(classifyZingg(0.9, 0.9)).toBe('blocky')
    expect(classifyZingg(0.9, 0.2)).toBe('platy')
    expect(classifyZingg(0.2, 0.9)).toBe('columnar')
    expect(classifyZingg(0.5, 0.5)).toBe('irregular')
  })

  it('退化输入有兜底：未知预设回落到 massive', () => {
    const net = createJointNetwork({ preset: 'not-exist', seed: 1 })
    expect(net.presetKey).toBe(JOINT_PRESETS.massive.key)
    expect(deriveShapeStats(null).zingg).toBe('blocky')
  })
})
