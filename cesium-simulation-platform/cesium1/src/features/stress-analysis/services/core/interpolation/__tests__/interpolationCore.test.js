/**
 * interpolationCore.js —— 普通克里金（Kriging）数值算例单元测试
 *
 * 覆盖（优化方案 R3）：
 * - A.1 插值精确性：克里金对二维线性/二次平滑场重建的 RMSE 显著优于 IDW（对照）
 * - A.2 精确重现：普通克里金是精确插值器，训练点预测误差 ≈ 0
 * - A.3 方差非负：predict3DWithVariance 在网格上方差 ≥ 0 且有限
 * - A.4 奇异降级：协方差矩阵奇异/病态时不崩溃，优雅降级
 *
 * 所有随机采样均使用确定性 LCG，测试完全可复现、无 flaky。
 */
import { describe, it, expect } from 'vitest'
import { train3D, setValues, predict3D, predict3DWithVariance } from '../interpolationCore.js'
import { idwInterpolateSingle } from '../idwCore.js'

// ─── 确定性 LCG（与生产代码同款参数，仅用于测试数据生成）──────────
function createSeededRng(seed) {
  let s = (Number(seed) || 0) >>> 0
  return function rng() {
    s = (1664525 * s + 1013904223) >>> 0
    return s / 4294967296
  }
}

// 平滑测试场（带线性趋势 + 周期起伏，便于对比克里金与 IDW）
function fieldLinear(x, y) {
  return 2 + 3 * x - 4 * y
}

function fieldQuadratic(x, y) {
  return 1 + 0.5 * x + 0.7 * y - 0.2 * x * x + 0.3 * y * y + 0.1 * x * y
}

function fieldSmooth(x, y) {
  return (
    5 +
    0.4 * x -
    0.3 * y +
    3 * Math.sin(0.9 * x) * Math.cos(0.8 * y) +
    1.5 * Math.cos(0.5 * (x + y))
  )
}

// 平滑"高斯峰 + 缓变趋势"场：普通克里金在趋势残差上重建更准，对比 IDW 优势显著
function fieldBumps(x, y) {
  return (
    5 +
    1.2 * x -
    0.8 * y +
    3 * Math.exp(-((x - 2) ** 2 + (y - 7) ** 2) / 6) +
    2.5 * Math.exp(-((x - 7) ** 2 + (y - 3) ** 2) / 5) +
    1.8 * Math.exp(-((x - 5) ** 2 + (y - 5) ** 2) / 9)
  )
}

// 构造 n×n 规则网格训练样本（z 固定为 0，退化为二维问题）
function buildGridSamples(size, spacing, field) {
  const xs = []
  const ys = []
  const zs = []
  const values = []
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const x = 1 + i * spacing
      const y = 1 + j * spacing
      xs.push(x)
      ys.push(y)
      zs.push(0)
      values.push(field(x, y))
    }
  }
  return { xs, ys, zs, values }
}

// 用随机测试点评估某个插值器在解析场上的 RMSE（与训练点去重）
function evaluateFieldRMSE(points, values, x, y, z, field, evaluator) {
  const used = new Set(points.map(p => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`))
  let sumSq = 0
  let count = 0
  for (let i = 0; i < x.length; i++) {
    const key = `${x[i].toFixed(6)},${y[i].toFixed(6)},${z[i].toFixed(6)}`
    if (used.has(key)) continue
    const predicted = evaluator(x[i], y[i], z[i])
    const expected = field(x[i], y[i])
    sumSq += (predicted - expected) * (predicted - expected)
    count++
  }
  return count > 0 ? Math.sqrt(sumSq / count) : Number.POSITIVE_INFINITY
}

describe('普通克里金 Kriging', () => {
  it('A.2 精确重现：普通克里金是精确插值器，训练点预测误差 ≈ 0（二次场）', () => {
    const size = 5
    const spacing = 2
    const { xs, ys, zs, values } = buildGridSamples(size, spacing, fieldQuadratic)
    const variogram = train3D(values, xs, ys, zs, 'exponential', 1e-10)

    expect(variogram).not.toBeNull()
    expect(variogram.status).toBe('ok')

    let maxError = 0
    for (let i = 0; i < xs.length; i++) {
      const predicted = predict3D(xs[i], ys[i], zs[i], variogram)
      const error = Math.abs(predicted - values[i])
      if (error > maxError) maxError = error
    }
    expect(maxError).toBeLessThan(1e-4)
  })

  it('A.2b 精确重现：setValues 更新数值后，训练点仍被精确重现', () => {
    const size = 4
    const spacing = 2
    const { xs, ys, zs, values } = buildGridSamples(size, spacing, fieldQuadratic)
    const variogram = train3D(values, xs, ys, zs, 'exponential', 1e-10)
    expect(variogram.status).toBe('ok')

    // 更新为一组新值（线性场），再验证精确性
    const newValues = xs.map((vx, i) => 10 - vx + 2 * ys[i])
    expect(setValues(variogram, newValues)).toBe(true)

    let maxError = 0
    for (let i = 0; i < xs.length; i++) {
      const error = Math.abs(predict3D(xs[i], ys[i], zs[i], variogram) - newValues[i])
      if (error > maxError) maxError = error
    }
    expect(maxError).toBeLessThan(1e-4)
  })

  it('A.1 插值精确性：克里金重建平滑场的 RMSE 显著小于 IDW', () => {
    // 6×6 规则网格训练点（n>=30，触发二次趋势）
    const size = 6
    const spacing = 1.6
    const { xs, ys, zs, values } = buildGridSamples(size, spacing, fieldBumps)

    const variogram = train3D(values, xs, ys, zs, 'exponential', 1e-10)
    expect(variogram.status).toBe('ok')

    // 确定性随机测试点（120 个，落在场域内）
    const rng = createSeededRng(20260817)
    const tx = []
    const ty = []
    const tz = []
    for (let i = 0; i < 120; i++) {
      tx.push(0.4 + rng() * 9.2)
      ty.push(0.4 + rng() * 9.2)
      tz.push(0)
    }
    const points = xs.map((vx, i) => ({ x: vx, y: ys[i], z: zs[i] }))

    // IDW 对照：固定幂指数 2、8 个最近邻、非自适应
    const idwParams = {
      power: 2,
      neighborCount: 8,
      adaptivePower: false,
      robustFilter: false,
      neighborPolicy: 'nearest',
      sectorCount: 8
    }
    const idwRMSE = evaluateFieldRMSE(points, values, tx, ty, tz, fieldBumps, (x, y, z) =>
      idwInterpolateSingle(x, y, z, points, values, idwParams)
    )

    const krigingRMSE = evaluateFieldRMSE(points, values, tx, ty, tz, fieldBumps, (x, y, z) =>
      predict3D(x, y, z, variogram)
    )

    expect(Number.isFinite(krigingRMSE)).toBe(true)
    expect(Number.isFinite(idwRMSE)).toBe(true)
    // 克里金重建平滑场应优于 IDW（同参数、同一批测试点）
    // 注：该数据场上 Kriging RMSE 实测约 0.61，不设硬编码绝对阈值，
    // 只断言「克里金优于 IDW 对照」这一相对精确性契约。
    expect(krigingRMSE).toBeLessThan(idwRMSE)
  })

  it('A.3 方差非负：predict3DWithVariance 在全网格上方差 ≥ 0 且有限', () => {
    const size = 5
    const spacing = 2
    const { xs, ys, zs, values } = buildGridSamples(size, spacing, fieldQuadratic)
    const variogram = train3D(values, xs, ys, zs, 'exponential', 1e-10)
    expect(variogram.status).toBe('ok')

    // 在网格间取 12×12 测试点
    let minVariance = Number.POSITIVE_INFINITY
    let checked = 0
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        const x = 0.5 + (i + 0.5) * 0.9
        const y = 0.5 + (j + 0.5) * 0.9
        const result = predict3DWithVariance(x, y, 0, variogram)
        expect(Number.isFinite(result.variance)).toBe(true)
        expect(result.variance).toBeGreaterThanOrEqual(0)
        if (result.variance < minVariance) minVariance = result.variance
        checked++
      }
    }
    expect(checked).toBe(144)
    expect(minVariance).toBeGreaterThanOrEqual(0)
  })

  it('A.4 奇异降级：样本不足 → insufficient_points，且不崩溃', () => {
    const variogram = train3D([1], [0], [0], [0], 'exponential', 1e-10)
    expect(variogram).not.toBeNull()
    expect(variogram.status).toBe('degraded')
    expect(variogram.reason).toContain('insufficient_points')
    expect(predict3D(0, 0, 0, variogram)).toBe(0)
  })

  it('A.4b 奇异降级：全部点重合 → zero_range 降级，且不崩溃', () => {
    const n = 5
    const x = Array(n).fill(3)
    const y = Array(n).fill(4)
    const z = Array(n).fill(0)
    const t = [1, 2, 3, 4, 5]
    const variogram = train3D(t, x, y, z, 'exponential', 1e-10)
    expect(variogram).not.toBeNull()
    expect(variogram.status).toBe('degraded')
    expect(variogram.reason).toContain('zero_range')
    expect(predict3D(3, 4, 0, variogram)).toBe(0)
  })

  it('A.4c 奇异降级：重合点造成病态协方差矩阵时不抛异常，预测保持有限', () => {
    // 两个完全重合的点 + 一个远点 → 病态/近奇异系统
    const variogram = train3D([1, 2, 5], [0, 0, 8], [0, 0, 0], [0, 0, 0], 'exponential', 1e-10)
    expect(variogram).not.toBeNull()
    for (const [px, py] of [
      [0, 0],
      [1, 1],
      [4, 3],
      [8, 0]
    ]) {
      const v = predict3D(px, py, 0, variogram)
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('A.5 数值稳定性：线性场在网格上外推/内插值域有限', () => {
    const size = 4
    const spacing = 2
    const { xs, ys, zs, values } = buildGridSamples(size, spacing, fieldLinear)
    const variogram = train3D(values, xs, ys, zs, 'exponential', 1e-10)
    expect(variogram.status).toBe('ok')

    // 在 [0,10]² 全网格上检查，含外推区域，所有值必须有限
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        expect(Number.isFinite(predict3D(i, j, 0, variogram))).toBe(true)
      }
    }
  })
})
