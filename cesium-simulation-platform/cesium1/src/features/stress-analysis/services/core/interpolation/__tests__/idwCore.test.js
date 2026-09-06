/**
 * idwCore.js —— IDW 反距离加权插值 + PSO 参数优化单元测试
 *
 * 覆盖（优化方案 R3）：
 * - B.1 在采样点上精确重现（IDW 插值过训练点）
 * - B.2 邻域选择正确性（selectIdwNeighbors）：距离越近的点被选中、按距离升序
 * - B.3 幂指数越大，远点影响越小
 * - C.1 PSO 确定性：固定种子结果完全一致
 * - C.2 PSO 收敛性：代数增加，适应度单调不劣化（合成平滑场，已知最优区间）
 * - C.3 PSO 边界合法性：最优参数落在声明的取值范围
 *
 * 所有随机源均为确定性 LCG（createSeededRng），无 flaky。
 */
import { describe, it, expect } from 'vitest'
import {
  createSeededRng,
  selectIdwNeighbors,
  idwInterpolateSingle,
  optimizeIDWParameters
} from '../idwCore.js'

// ─── 固定的 IDW 参数（测试全部关闭自适应，保持确定性）──────────
const BASE_IDW_PARAMS = {
  power: 2,
  neighborCount: 8,
  adaptivePower: false,
  robustFilter: false,
  neighborPolicy: 'nearest',
  sectorCount: 8
}

describe('IDW 反距离加权插值', () => {
  it('B.1 精确重现：IDW 插值严格过训练点', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 2, y: 3, z: 0 },
      { x: 4, y: 1, z: 0 }
    ]
    const values = [10, 20, 30, 5, -7]

    for (let i = 0; i < points.length; i++) {
      const predicted = idwInterpolateSingle(
        points[i].x,
        points[i].y,
        points[i].z,
        points,
        values,
        BASE_IDW_PARAMS
      )
      // IDW 在训练点上的插值等价于该点值（浮点近似，非 bit 级精确）
      expect(predicted).toBeCloseTo(values[i], 6)
    }
  })

  it('B.2 邻域选择：nearest 策略按距离升序返回最近邻点', () => {
    const points = [
      { x: 0, y: 0, z: 0 }, // d2 = 0
      { x: 1, y: 0, z: 0 }, // d2 = 1
      { x: 0, y: 1, z: 0 }, // d2 = 1
      { x: 5, y: 5, z: 0 }, // d2 = 50
      { x: 10, y: 10, z: 0 } // d2 = 200
    ]
    const params = { ...BASE_IDW_PARAMS, neighborCount: 4, neighborPolicy: 'nearest' }
    const selection = selectIdwNeighbors(0, 0, 0, points, 4, params)

    expect(selection.list.length).toBe(4)
    // 按距离平方升序
    for (let i = 1; i < selection.list.length; i++) {
      expect(selection.list[i].d2).toBeGreaterThanOrEqual(selection.list[i - 1].d2)
    }
    // 选中最近的 4 个点（索引 0,1,2,3）
    const selectedIndices = selection.list.map(c => c.index).sort((a, b) => a - b)
    expect(selectedIndices).toEqual([0, 1, 2, 3])
    // 最近点一定在最前
    expect(selection.list[0].index).toBe(0)
  })

  it('B.2b 邻域选择：目标恰好落在点上时命中该点', () => {
    const points = [
      { x: 2, y: 3, z: 0 },
      { x: 6, y: 7, z: 0 },
      { x: -1, y: 5, z: 0 }
    ]
    // 命中检测仅在 sector 策略下启用（目标与训练点重合，距离平方 < eps²）
    const params = { ...BASE_IDW_PARAMS, neighborPolicy: 'sector' }
    const selection = selectIdwNeighbors(6, 7, 0, points, 3, params)
    expect(selection.hitValueIndex).toBe(1)
    expect(selection.hitIndex).toBe(1)
  })

  it('B.3 幂指数越大，远点影响越小（预测向近点值收敛）', () => {
    const points = [
      { x: 1, y: 0, z: 0 }, // 近点，值 10
      { x: 10, y: 0, z: 0 } // 远点，值 0
    ]
    const values = [10, 0]

    const predPower1 = idwInterpolateSingle(0, 0, 0, points, values, {
      ...BASE_IDW_PARAMS,
      power: 1,
      neighborCount: 2
    })
    const predPower2 = idwInterpolateSingle(0, 0, 0, points, values, {
      ...BASE_IDW_PARAMS,
      power: 2,
      neighborCount: 2
    })
    const predPower4 = idwInterpolateSingle(0, 0, 0, points, values, {
      ...BASE_IDW_PARAMS,
      power: 4,
      neighborCount: 2
    })

    // 幂指数增大 → 远点权重下降 → 预测逼近近点值 10
    expect(predPower1).toBeLessThan(predPower2)
    expect(predPower2).toBeLessThan(predPower4)
    expect(predPower4).toBeGreaterThan(9.9)
  })

  it('B.4 确定性随机数：同一种子生成相同序列', () => {
    const rngA = createSeededRng(42)
    const rngB = createSeededRng(42)
    for (let i = 0; i < 50; i++) {
      expect(rngA()).toBe(rngB())
    }
  })
})

describe('PSO 参数优化（optimizeIDWParameters）', () => {
  // 构造合成平滑场数据：6×6 网格上的高斯峰 + 缓变趋势
  function buildSmoothDataset() {
    const points = []
    const values = []
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const x = i * 2
        const y = j * 2
        points.push({ x, y, z: 0 })
        values.push(10 * Math.exp(-((x - 5) ** 2 + (y - 5) ** 2) / 8) + 0.3 * x - 0.2 * y + 2)
      }
    }
    return { points, values }
  }

  const PSO_CONFIG = {
    particleCount: 10,
    maxIterations: 6,
    seed: 1337,
    crossValidationFolds: 4,
    crossValidationMode: 'random',
    maxFitnessSamples: 64,
    adaptivePower: true,
    adaptiveNeighborCount: 8
  }

  it('C.1 确定性：固定种子运行两次结果完全一致', () => {
    const { points, values } = buildSmoothDataset()
    const resultA = optimizeIDWParameters(points, values, PSO_CONFIG)
    const resultB = optimizeIDWParameters(points, values, PSO_CONFIG)

    expect(resultA.success).toBe(true)
    expect(resultB.success).toBe(true)
    expect(resultA.fitness).toBe(resultB.fitness)
    expect(resultA.optimalParams.power).toBe(resultB.optimalParams.power)
    expect(resultA.optimalParams.neighborCount).toBe(resultB.optimalParams.neighborCount)
  })

  it('C.2 收敛性：代数增加，适应度单调不劣化', () => {
    const { points, values } = buildSmoothDataset()
    const shortRun = optimizeIDWParameters(points, values, { ...PSO_CONFIG, maxIterations: 6 })
    const longRun = optimizeIDWParameters(points, values, { ...PSO_CONFIG, maxIterations: 40 })

    expect(shortRun.success).toBe(true)
    expect(longRun.success).toBe(true)
    // 更多迭代 → 全局最优适应度不会变差（粒子历史最优单调下降）
    expect(longRun.fitness).toBeLessThanOrEqual(shortRun.fitness + 1e-12)
    // 注：该合成数据上 PSO 在 maxIterations=6 时即已收敛到全局最优，
    // 40 代不会更优，因此不断言「严格更优」，只保留上面的「不劣化」契约。
  })

  it('C.3 边界合法性：最优参数落在声明的取值范围', () => {
    const { points, values } = buildSmoothDataset()
    const result = optimizeIDWParameters(points, values, PSO_CONFIG)

    expect(result.success).toBe(true)
    expect(Number.isFinite(result.fitness)).toBe(true)
    expect(result.optimalParams.power).toBeGreaterThanOrEqual(0.5)
    expect(result.optimalParams.power).toBeLessThanOrEqual(5.0)
    expect(result.optimalParams.neighborCount).toBeGreaterThanOrEqual(4)
    expect(result.optimalParams.neighborCount).toBeLessThanOrEqual(32)
    expect(result.optimalParams.anisotropyParams).not.toBeNull()
  })

  it('C.4 异常输入：样本不足时优雅返回 failure 而非抛异常', () => {
    const result = optimizeIDWParameters([{ x: 0, y: 0, z: 0 }], [1], PSO_CONFIG)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('insufficient_data')
  })
})
