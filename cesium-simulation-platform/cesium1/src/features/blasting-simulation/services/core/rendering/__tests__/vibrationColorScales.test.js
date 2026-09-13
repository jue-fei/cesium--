import { describe, it, expect } from 'vitest'
import {
  kneeWarp,
  buildDamageLutData,
  DAMAGE_ZONES,
  KNEE_WARP_A,
  KNEE_WARP_B,
  NORM_FLOOR,
  NORM_LOG_SPAN
} from '../vibrationColorScales.js'

// kneeWarp 与 sceneBuilder.js 片元着色器的高光膝形压缩同源同值：
//   norm' = mix(norm, 1-pow(1-norm,1.35), smoothstep(KNEE_WARP_A, KNEE_WARP_B, norm))
// 图例刻度必须套同一变换才能对准屏幕色档边界。
describe('kneeWarp', () => {
  it('端点不动（0→0，1→1）', () => {
    expect(kneeWarp(0)).toBe(0)
    expect(kneeWarp(1)).toBeCloseTo(1, 12)
  })

  it('单调不减（全区间采样）', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const p = i / 100
      const w = kneeWarp(p)
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(w).toBeGreaterThanOrEqual(0)
      expect(w).toBeLessThanOrEqual(1)
      prev = w
    }
  })

  it('已知值与 shader 公式一致', () => {
    const ss = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    for (const p of [0.1, 0.45, 0.5, 0.7, 0.8, 0.92, 0.95]) {
      const expected = p + (1 - Math.pow(1 - p, 1.35) - p) * ss(KNEE_WARP_A, KNEE_WARP_B, p)
      expect(kneeWarp(p)).toBeCloseTo(expected, 12)
    }
    // 拐点上界处被压向 1-pow(1-p,1.35) 曲线（顶部带宽放缓）
    expect(kneeWarp(KNEE_WARP_B)).toBeCloseTo(1 - Math.pow(1 - KNEE_WARP_B, 1.35), 12)
  })

  it('中段（<KNEE_WARP_A）恒等映射：保住中高值区色阶对比', () => {
    for (const p of [0.1, 0.3, 0.5, 0.7]) {
      expect(p).toBeLessThan(KNEE_WARP_A)
      expect(kneeWarp(p)).toBeCloseTo(p, 12)
    }
  })
})

// 归一化标尺常量：热力图/图例/等值线/着色器四处的动态范围必须同源
describe('归一化标尺常量', () => {
  it('floor 与动态范围自洽，且足够覆盖中远场', () => {
    expect(NORM_FLOOR).toBeGreaterThan(0)
    expect(NORM_FLOOR).toBeLessThan(0.02)
    expect(NORM_LOG_SPAN).toBeCloseTo(Math.log2(1 / NORM_FLOOR), 12)
    // 至少 8 个八度（256×）才能让 1/r^1.5 幂律场的中远场落在可见域内
    expect(NORM_LOG_SPAN).toBeGreaterThan(8)
  })
})

// 损伤五色 LUT：由 DAMAGE_ZONES 单源生成（替代 shader 内硬编码五色）
describe('buildDamageLutData', () => {
  it('生成 5×1 RGBA 数据且颜色与 DAMAGE_ZONES 一致', () => {
    const data = buildDamageLutData()
    expect(data).toHaveLength(DAMAGE_ZONES.length * 4)
    DAMAGE_ZONES.forEach((z, i) => {
      expect(data[i * 4]).toBe(Math.round(z.linear[0] * 255))
      expect(data[i * 4 + 1]).toBe(Math.round(z.linear[1] * 255))
      expect(data[i * 4 + 2]).toBe(Math.round(z.linear[2] * 255))
      expect(data[i * 4 + 3]).toBe(255)
    })
  })
})
