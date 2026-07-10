import { describe, it, expect } from 'vitest'
import { mulberry32 } from '../blastPhysicsEngine.js'
import { generateFragmentSpecs } from '../../rendering/fragmentSpecGenerator.js'

// 矩形断面掌子面（测试用最小有效几何）
const baseFace = {
  cx: 0, cy: 3, cz: 0,
  nx: 0, ny: 0, nz: 1, // 法线指向岩体内部（+Z）
  rx: 1, ry: 0, rz: 0, // 面内右侧（+X）
  ux: 0, uy: 1, uz: 0, // 面内上方（+Y）
  width: 10,
  wallHeight: 5,
  archRadius: 5,
  shape: 'rectangular'
}

// 构造 KCO 参数
function makeKco(n) {
  return { x50: 0.3, xmax: 1.0, b: 0.7, n, A: 1 }
}

describe('碎片数量公式', () => {
  // count = min(2000, max(60, floor(baseCount * nFactor)))
  // nFactor = 1 + (1.2 - n) * 0.5
  // baseCount 优先级: targetCount(数据导入) > volumePerRound(体积驱动) > chargeKg*0.5(回退)
  function runCount(kg, n) {
    const { specs } = generateFragmentSpecs({
      kco: makeKco(n),
      face: baseFace,
      chargeKg: kg,
      targetCount: kg * 0.5,
      rng: mulberry32(42)
    })
    return specs.length
  }

  it('kg=100, n=1.2 → count=60（触下限）', () => {
    // nFactor=1.0, floor(50*1.0)=50 → max(60,…)=60
    expect(runCount(100, 1.2)).toBe(60)
  })

  it('kg=500, n=0.8 → count=300', () => {
    // nFactor=1.2, floor(250*1.2)=300
    expect(runCount(500, 0.8)).toBe(300)
  })

  it('kg=1000, n=0.5 → count=675（上限放宽至 3000）', () => {
    // nFactor=1.35, floor(500*1.35)=675 → min(3000,…)=675
    expect(runCount(1000, 0.5)).toBe(675)
  })

  it('kg=10, n=1.5 → count=60（触下限）', () => {
    // nFactor=0.85, floor(5*0.85)=4 → max(60,…)=60
    expect(runCount(10, 1.5)).toBe(60)
  })
})

describe('端到端确定性回放', () => {
  it('相同 randomSeed 产生一致的碎片规格', () => {
    const opts = {
      kco: makeKco(1.2),
      face: baseFace,
      chargeKg: 100,
      targetCount: 50
    }
    const rng1 = mulberry32(42)
    const rng2 = mulberry32(42)
    const r1 = generateFragmentSpecs({ ...opts, rng: rng1 })
    const r2 = generateFragmentSpecs({ ...opts, rng: rng2 })

    expect(r1.specs.length).toBe(r2.specs.length)
    expect(r1.positions.length).toBe(r2.positions.length)
    expect(r1.velocities.length).toBe(r2.velocities.length)

    for (let i = 0; i < r1.specs.length; i++) {
      // 尺寸
      expect(r1.specs[i].physSize).toBeCloseTo(r2.specs[i].physSize, 10)
      expect(r1.specs[i].dispSize).toBeCloseTo(r2.specs[i].dispSize, 10)
      // 密度
      expect(r1.specs[i].density).toBeCloseTo(r2.specs[i].density, 10)
      // 颜色
      expect(r1.specs[i].color.r).toBeCloseTo(r2.specs[i].color.r, 10)
      expect(r1.specs[i].color.g).toBeCloseTo(r2.specs[i].color.g, 10)
      expect(r1.specs[i].color.b).toBeCloseTo(r2.specs[i].color.b, 10)
      // 变体索引
      expect(r1.specs[i].variantIndex).toBe(r2.specs[i].variantIndex)
      // 初始位置
      expect(r1.positions[i].x).toBeCloseTo(r2.positions[i].x, 10)
      expect(r1.positions[i].y).toBeCloseTo(r2.positions[i].y, 10)
      expect(r1.positions[i].z).toBeCloseTo(r2.positions[i].z, 10)
      // 初始速度
      expect(r1.velocities[i].x).toBeCloseTo(r2.velocities[i].x, 10)
      expect(r1.velocities[i].y).toBeCloseTo(r2.velocities[i].y, 10)
      expect(r1.velocities[i].z).toBeCloseTo(r2.velocities[i].z, 10)
    }
  })
})
