/**
 * PSO (Particle Swarm Optimization) 默认超参数。
 *
 * 目标：对 IDW 的关键参数做黑盒优化，降低"人工猜参数"的成本。
 * - power：距离衰减指数，越大越强调近邻点（更尖锐），越小越平滑。
 * - neighborCount：参与插值的最近邻数量，越大越稳定但更平滑。
 * - anisotropyParams：各向异性尺度与旋转角，允许方向性拉伸/压缩距离度量。
 *
 * PSO 参数解释：
 * - inertiaWeight (w)：惯性项，控制速度保持程度；过大易震荡，过小易早收敛。
 * - cognitiveWeight (c1)：个体最优吸引；强调粒子探索自身经验。
 * - socialWeight (c2)：全局最优吸引；强调群体收敛。
 * - convergenceThreshold：连续最优改进小于该值则视为趋近收敛。
 * - stagnationIterations：停滞计数达到阈值提前停止，避免无意义迭代。
 *
 * 注意：这里的 fitness 基于交叉验证的 RMSE + bias + variance 加权，
 * 默认使用空间阻塞验证，尽量让参数选择更贴近真实空间外推。
 */
import { computeAnisotropicDistanceSquared, createAnisotropyParams } from './config.js'
import { computeBBox, computeBBoxDiagonal } from '../shared/bbox.js'
import { selectNeighborsBySector } from '../shared/sectorNeighborSelection.js'
import { clamp01 } from '../shared/stressMathUtils.js'

export function createSeededRng(seed) {
  // 确定性线性同余生成器，用于稳定的优化运行
  let s = (Number(seed) || 0) >>> 0
  return function rng() {
    // 数值算法线性同余：x_{n+1} = (a*x_n + c) mod 2^32
    s = (1664525 * s + 1013904223) >>> 0
    return s / 4294967296
  }
}

const PSO_DEFAULT_CONFIG = {
  particleCount: 30,
  maxIterations: 100,
  inertiaWeight: 0.729,
  cognitiveWeight: 1.49445,
  socialWeight: 1.49445,
  convergenceThreshold: 1e-6,
  stagnationIterations: 15,
  // 控制交叉验证洗牌和PSO的确定性行为
  seed: 1337,
  crossValidationFolds: 5,
  crossValidationMode: 'spatial',
  adaptivePower: true,
  adaptiveNeighborCount: 8,
  // 性能优化：限制用于优化适应度计算的样本数量
  maxFitnessSamples: 160,
  // 使适应度函数更符合"渲染效果"
  // - rmse/bias/variance: 交叉验证误差项
  // - smoothness: 惩罚过度粗糙的场（减少"条纹/靶心"伪影）
  objectiveWeights: { rmse: 0.55, bias: 0.2, variance: 0.1, smoothness: 0.15 },
  // 交叉验证插值中使用的邻域选择策略
  neighborPolicy: 'sector', // 'nearest' | 'sector'
  sectorCount: 8
}

const PARAM_BOUNDS = {
  power: { min: 0.5, max: 5.0 },
  neighborCount: { min: 4, max: 32 },
  anisotropyScaleX: { min: 0.1, max: 3.0 },
  anisotropyScaleY: { min: 0.1, max: 3.0 },
  anisotropyScaleZ: { min: 0.1, max: 3.0 },
  anisotropyAngle: { min: 0, max: Math.PI }
}

function sampleWithoutReplacement(n, k, rng) {
  const kk = Math.max(0, Math.min(n, Math.floor(k)))
  const out = new Array(kk)
  const idx = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  for (let i = 0; i < kk; i++) out[i] = idx[i]
  return out
}

function assignRandomFolds(n, foldCount, rng) {
  const indices = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  const folds = new Array(n)
  for (let i = 0; i < n; i++) folds[indices[i]] = i % foldCount
  return folds
}

function resolveSpatialBlockCounts(points, foldCount) {
  const bbox = computeBBox(points)
  const extents = [bbox.dx, bbox.dy, bbox.dz]
  const counts = [1, 1, 1]
  const product = () => counts[0] * counts[1] * counts[2]
  while (product() < foldCount) {
    let bestAxis = 0
    let bestScore = extents[0] / counts[0]
    for (let axis = 1; axis < 3; axis++) {
      const score = extents[axis] / counts[axis]
      if (score > bestScore) {
        bestScore = score
        bestAxis = axis
      }
    }
    counts[bestAxis] += 1
  }
  return {
    minX: bbox.minX,
    minY: bbox.minY,
    minZ: bbox.minZ,
    maxX: bbox.maxX,
    maxY: bbox.maxY,
    maxZ: bbox.maxZ,
    nx: counts[0],
    ny: counts[1],
    nz: counts[2]
  }
}

function assignSpatialFolds(points, foldCount, rng) {
  if (!Array.isArray(points) || points.length < foldCount * 2) {
    return assignRandomFolds(points.length, foldCount, rng)
  }

  const layout = resolveSpatialBlockCounts(points, foldCount)
  const dx = Math.max(1e-6, layout.maxX - layout.minX)
  const dy = Math.max(1e-6, layout.maxY - layout.minY)
  const dz = Math.max(1e-6, layout.maxZ - layout.minZ)
  const blockMap = new Map()

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const ix = Math.max(
      0,
      Math.min(layout.nx - 1, Math.floor(((p.x - layout.minX) / dx) * layout.nx))
    )
    const iy = Math.max(
      0,
      Math.min(layout.ny - 1, Math.floor(((p.y - layout.minY) / dy) * layout.ny))
    )
    const iz = Math.max(
      0,
      Math.min(layout.nz - 1, Math.floor(((p.z - layout.minZ) / dz) * layout.nz))
    )
    const key = `${ix}|${iy}|${iz}`
    if (!blockMap.has(key)) blockMap.set(key, [])
    blockMap.get(key).push(i)
  }

  const blocks = Array.from(blockMap.entries()).map(([key, indices]) => {
    const [ix, iy, iz] = key.split('|').map(Number)
    return {
      indices,
      key,
      sortKey: ix * 73856093 + iy * 19349663 + iz * 83492791 + Math.floor(rng() * 17)
    }
  })

  if (blocks.length < Math.max(2, Math.min(foldCount, 3))) {
    return assignRandomFolds(points.length, foldCount, rng)
  }

  blocks.sort((a, b) => b.indices.length - a.indices.length || a.sortKey - b.sortKey)
  const foldSizes = new Array(foldCount).fill(0)
  const folds = new Array(points.length).fill(0)
  for (let bi = 0; bi < blocks.length; bi++) {
    let targetFold = 0
    for (let fi = 1; fi < foldCount; fi++) {
      if (foldSizes[fi] < foldSizes[targetFold]) targetFold = fi
    }
    const blockIndices = blocks[bi].indices
    for (let i = 0; i < blockIndices.length; i++) folds[blockIndices[i]] = targetFold
    foldSizes[targetFold] += blockIndices.length
  }
  return folds
}

function smoothstep01(value) {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

function getAdaptivePowerContext(points, params) {
  if (!params?.adaptivePower || !Array.isArray(points) || points.length < 4) return null
  if (params.__adaptivePowerContext?.points === points) return params.__adaptivePowerContext

  const bbox = computeBBox(points)
  const volume = Math.max(1e-6, bbox.dx * bbox.dy * bbox.dz)
  const density = Math.max(1e-9, points.length / volume)
  const expectedNearestDistance = 0.55396 / Math.cbrt(density)
  const adaptiveNeighborCount = Math.max(
    3,
    Math.min(16, Math.floor(Number(params.adaptiveNeighborCount) || 8))
  )

  const context = {
    points,
    expectedNearestDistance,
    adaptiveNeighborCount
  }
  params.__adaptivePowerContext = context
  return context
}

function interpolateAdaptivePowerLevels(levels, u) {
  const count = Math.max(2, levels.length)
  const scaled = clamp01(u) * (count - 1)
  const index = Math.min(count - 2, Math.floor(scaled))
  const localT = scaled - index
  return levels[index] + (levels[index + 1] - levels[index]) * localT
}

export function resolveAdaptiveIdwPower(points, params, sortedDistanceSquares) {
  const basePower = Math.max(0.1, Number(params?.power) || 1.6)
  if (!params?.adaptivePower) return basePower
  const context = getAdaptivePowerContext(points, params)
  if (!context || !Array.isArray(sortedDistanceSquares) || sortedDistanceSquares.length < 1) {
    return basePower
  }

  const usedCount = Math.max(
    1,
    Math.min(context.adaptiveNeighborCount, sortedDistanceSquares.length)
  )
  let observedNearestDistance = 0
  for (let i = 0; i < usedCount; i++) {
    observedNearestDistance += Math.sqrt(Math.max(0, Number(sortedDistanceSquares[i]) || 0))
  }
  observedNearestDistance /= usedCount

  const ratio = observedNearestDistance / Math.max(1e-6, context.expectedNearestDistance)
  // 参考 AIDW 文献，将局部点模式映射为距离衰减强度：
  // 稠密区域提高幂指数，稀疏区域降低幂指数，以兼顾局部细节与外推稳定性。
  const u = smoothstep01((ratio - 0.6) / 1.2)
  const levels = [
    Math.min(5, Math.max(0.2, basePower * 1.55)),
    Math.min(4.5, Math.max(0.2, basePower * 1.28)),
    basePower,
    Math.max(0.2, basePower * 0.82),
    Math.max(0.2, basePower * 0.62)
  ]
  return interpolateAdaptivePowerLevels(levels, u)
}

export function selectIdwNeighbors(targetX, targetY, targetZ, points, neighborCount, params) {
  const anisotropyParams = params.anisotropyParams || null
  const sectorCount = Math.max(1, Math.min(16, Math.floor(params.sectorCount || 8)))
  const eps = 1e-8
  const eps2 = eps * eps
  const hasAnisotropy = anisotropyParams !== null

  // 无各向异性时直接用欧氏距离，避免 computeAnisotropicDistanceSquared 调用开销
  const candidates = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const dx = targetX - p.x
    const dy = targetY - p.y
    const dz = targetZ - p.z
    const d2 = hasAnisotropy
      ? computeAnisotropicDistanceSquared(dx, dy, dz, anisotropyParams)
      : dx * dx + dy * dy + dz * dz
    // 仅在需要扇区旋转时存储 dx/dy，否则只存距离
    if (hasAnisotropy) {
      candidates.push({ index: i, d2, dx, dy })
    } else {
      candidates.push({ index: i, d2 })
    }
  }

  candidates.sort((a, b) => a.d2 - b.d2)
  const usedCount = Math.min(neighborCount, candidates.length)
  if (params.neighborPolicy !== 'sector' || usedCount <= 2 || sectorCount <= 1) {
    return { list: candidates.slice(0, usedCount), hitIndex: null, hitValueIndex: null, eps2 }
  }

  // 恰好落在已知点上
  if (candidates[0].d2 <= eps2) {
    return { list: [], hitIndex: candidates[0].index, hitValueIndex: candidates[0].index, eps2 }
  }

  const aAngle = anisotropyParams?.angle || 0
  const cosA = Math.cos(aAngle)
  const sinA = Math.sin(aAngle)
  const picked = selectNeighborsBySector(
    candidates,
    usedCount,
    sectorCount,
    c => {
      if (hasAnisotropy) {
        const rx = c.dx * cosA + c.dy * sinA
        const ry = -c.dx * sinA + c.dy * cosA
        return Math.atan2(ry, rx)
      }
      return Math.atan2(targetY - points[c.index].y, targetX - points[c.index].x)
    },
    { distanceKey: 'd2' }
  )

  return { list: picked, hitIndex: null, hitValueIndex: null, eps2 }
}

export function idwInterpolateSingle(targetX, targetY, targetZ, points, values, params) {
  const basePower = params.power
  const neighborCount = params.neighborCount
  const eps = 1e-8

  const selection = selectIdwNeighbors(targetX, targetY, targetZ, points, neighborCount, params)
  if (selection.hitValueIndex !== null) return values[selection.hitValueIndex]
  const picked = selection.list
  const usedCount = Math.min(neighborCount, picked.length)

  // 鲁棒过滤：检测并排除邻域中的异常值点
  // 使用中位数 + MAD 方法防止单个异常训练点污染局部插值
  const robustEnabled = params.robustFilter !== false && usedCount >= 5
  let filteredPicked = picked
  let filteredCount = usedCount

  if (robustEnabled) {
    const neighborVals = picked.slice(0, usedCount).map(item => Number(values[item.index]))
    const sortedVals = neighborVals.slice().sort((a, b) => a - b)
    const median = sortedVals[Math.floor(sortedVals.length / 2)]
    const absDiffs = neighborVals.map(v => Math.abs(v - median))
    absDiffs.sort((a, b) => a - b)
    const mad = absDiffs[Math.floor(absDiffs.length / 2)]
    const threshold = Math.max(1e-9, mad * 2.5)

    filteredPicked = []
    for (let i = 0; i < usedCount; i++) {
      const val = Number(values[picked[i].index])
      if (Math.abs(val - median) <= threshold + 1e-10) {
        filteredPicked.push(picked[i])
      }
    }
    // 如果过滤后点太少，回退到不过滤
    if (filteredPicked.length < Math.max(2, Math.floor(usedCount * 0.4))) {
      filteredPicked = picked.slice(0, usedCount)
    }
    filteredCount = filteredPicked.length
  }

  const activePicked = filteredPicked
  const activeCount = filteredCount

  const adaptivePower = resolveAdaptiveIdwPower(
    points,
    params,
    activePicked.slice(0, activeCount).map(item => item.d2)
  )
  const power = Number.isFinite(adaptivePower) ? adaptivePower : basePower
  let weightSum = 0
  let valueSum = 0

  for (let i = 0; i < activeCount; i++) {
    const d = Math.sqrt(activePicked[i].d2)
    const w = 1 / Math.pow(d + eps, power)
    weightSum += w
    valueSum += w * values[activePicked[i].index]
  }

  return weightSum > 0 ? valueSum / weightSum : 0
}

function crossValidationRMSE(
  points,
  values,
  params,
  foldCount = 5,
  rng = Math.random,
  mode = 'spatial'
) {
  const n = points.length
  if (n < foldCount) {
    foldCount = Math.max(2, n)
  }
  const folds =
    String(mode || '').toLowerCase() === 'random'
      ? assignRandomFolds(n, foldCount, rng)
      : assignSpatialFolds(points, foldCount, rng)
  let totalSquaredError = 0
  let totalValidations = 0
  const allErrors = []

  for (let fold = 0; fold < foldCount; fold++) {
    const trainPoints = []
    const trainValues = []
    const testPoints = []
    const testValues = []

    for (let i = 0; i < n; i++) {
      if (folds[i] === fold) {
        testPoints.push(points[i])
        testValues.push(values[i])
      } else {
        trainPoints.push(points[i])
        trainValues.push(values[i])
      }
    }

    if (trainPoints.length < 2 || testPoints.length < 1) continue

    for (let i = 0; i < testPoints.length; i++) {
      const predicted = idwInterpolateSingle(
        testPoints[i].x,
        testPoints[i].y,
        testPoints[i].z,
        trainPoints,
        trainValues,
        params
      )
      const error = predicted - testValues[i]
      totalSquaredError += error * error
      totalValidations++
      allErrors.push(error)
    }
  }

  const rmse =
    totalValidations > 0
      ? Math.sqrt(totalSquaredError / totalValidations)
      : Number.POSITIVE_INFINITY

  const bias =
    allErrors.length > 0 ? allErrors.reduce((sum, e) => sum + e, 0) / allErrors.length : 0
  const variance =
    allErrors.length > 1
      ? allErrors.reduce((sum, e) => sum + (e - bias) * (e - bias), 0) / (allErrors.length - 1)
      : 0

  return { rmse, bias: Math.abs(bias), variance, count: totalValidations }
}

function estimateSmoothnessPenalty(points, values, params, rng) {
  // 基于探测点的粗糙度度量：随机探测点上的平均平方梯度幅值
  // 这与体渲染中可见的"条纹/靶心"伪影相关
  const n = points.length
  if (n < 4) return 0

  const bbox = computeBBox(points)
  const probeCount = Math.max(16, Math.min(64, Math.floor(Math.sqrt(n) * 6)))
  const step = 0.02 * computeBBoxDiagonal(bbox)

  // 按数据尺度归一化，使不同数据集之间可比较
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length)
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / Math.max(1, values.length)
  const stdDev = Math.max(1e-6, Math.sqrt(variance))

  let sum = 0
  let count = 0
  for (let i = 0; i < probeCount; i++) {
    const x = bbox.minX + rng() * bbox.dx
    const y = bbox.minY + rng() * bbox.dy
    const z = bbox.minZ + rng() * bbox.dz
    const v0 = idwInterpolateSingle(x, y, z, points, values, params)
    const vx = idwInterpolateSingle(x + step, y, z, points, values, params)
    const vy = idwInterpolateSingle(x, y + step, z, points, values, params)
    const vz = idwInterpolateSingle(x, y, z + step, points, values, params)
    const gx = (vx - v0) / step
    const gy = (vy - v0) / step
    const gz = (vz - v0) / step
    const g2 = (gx * gx + gy * gy + gz * gz) / (stdDev * stdDev)
    if (Number.isFinite(g2)) {
      sum += g2
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

function fitnessFunction(points, values, params, config, rng) {
  const foldCount = Math.max(2, Math.floor(Number(config.crossValidationFolds) || 5))
  const cvMode = String(config.crossValidationMode || 'spatial').toLowerCase()
  const result = crossValidationRMSE(points, values, params, foldCount, rng, cvMode)
  const w = config.objectiveWeights || PSO_DEFAULT_CONFIG.objectiveWeights
  const smoothness = estimateSmoothnessPenalty(points, values, params, rng)

  return (
    w.rmse * result.rmse +
    w.bias * result.bias +
    w.variance * Math.sqrt(result.variance) +
    w.smoothness * smoothness
  )
}

function createParticle(bounds, rng) {
  const position = {}
  const velocity = {}

  for (const key in bounds) {
    const bound = bounds[key]
    position[key] = bound.min + rng() * (bound.max - bound.min)
    velocity[key] = (rng() - 0.5) * (bound.max - bound.min) * 0.1
  }

  return {
    position,
    velocity,
    bestPosition: { ...position },
    bestFitness: Number.POSITIVE_INFINITY
  }
}

function decodeParticlePosition(position) {
  return {
    power: Math.max(0.1, position.power),
    neighborCount: Math.max(1, Math.round(position.neighborCount)),
    anisotropyParams: createAnisotropyParams(
      position.anisotropyScaleX,
      position.anisotropyScaleY,
      position.anisotropyScaleZ,
      position.anisotropyAngle
    ),
    adaptivePower: true,
    adaptiveNeighborCount: 8,
    neighborPolicy: 'sector',
    sectorCount: 8
  }
}

function evaluateParticle(particle, points, values, config, rng) {
  const decoded = decodeParticlePosition(particle.position)
  // 保持评估策略与配置一致
  decoded.neighborPolicy = config.neighborPolicy || decoded.neighborPolicy
  decoded.sectorCount = Number(config.sectorCount) || decoded.sectorCount
  decoded.adaptivePower = config.adaptivePower !== false
  decoded.adaptiveNeighborCount = Math.max(
    3,
    Math.min(16, Math.floor(Number(config.adaptiveNeighborCount) || 8))
  )
  return fitnessFunction(points, values, decoded, config, rng)
}

function updateParticle(particle, globalBest, bounds, config, rng) {
  const w = config.inertiaWeight
  const c1 = config.cognitiveWeight
  const c2 = config.socialWeight

  for (const key in bounds) {
    const r1 = rng()
    const r2 = rng()

    const cognitive = c1 * r1 * (particle.bestPosition[key] - particle.position[key])
    const social = c2 * r2 * (globalBest.position[key] - particle.position[key])

    particle.velocity[key] = w * particle.velocity[key] + cognitive + social

    const maxVelocity = (bounds[key].max - bounds[key].min) * 0.2
    particle.velocity[key] = Math.max(-maxVelocity, Math.min(maxVelocity, particle.velocity[key]))

    particle.position[key] += particle.velocity[key]
    particle.position[key] = Math.max(
      bounds[key].min,
      Math.min(bounds[key].max, particle.position[key])
    )
  }
}

export function optimizeIDWParameters(points, values, options = {}) {
  const config = { ...PSO_DEFAULT_CONFIG, ...options }
  const rng = createSeededRng(config.seed)

  if (!points || points.length < 4 || !values || values.length !== points.length) {
    return {
      success: false,
      reason: 'insufficient_data',
      optimalParams: null,
      fitness: Number.POSITIVE_INFINITY
    }
  }

  // 在大型点集上计算适应度可能非常昂贵；对优化使用子采样
  const n = points.length
  const maxFitnessSamples = Math.max(24, Math.min(n, Math.floor(config.maxFitnessSamples || 160)))
  const subsetIdx =
    n > maxFitnessSamples ? sampleWithoutReplacement(n, maxFitnessSamples, rng) : null
  const fitPoints = subsetIdx ? subsetIdx.map(i => points[i]) : points
  const fitValues = subsetIdx ? subsetIdx.map(i => values[i]) : values

  const bounds = PARAM_BOUNDS
  const particles = []

  for (let i = 0; i < config.particleCount; i++) {
    particles.push(createParticle(bounds, rng))
  }

  let globalBest = {
    position: { ...particles[0].position },
    fitness: Number.POSITIVE_INFINITY
  }

  let previousBestFitness = Number.POSITIVE_INFINITY
  let stagnationCount = 0

  for (let iter = 0; iter < config.maxIterations; iter++) {
    for (const particle of particles) {
      const fitness = evaluateParticle(particle, fitPoints, fitValues, config, rng)

      if (fitness < particle.bestFitness) {
        particle.bestFitness = fitness
        particle.bestPosition = { ...particle.position }
      }

      if (fitness < globalBest.fitness) {
        globalBest.fitness = fitness
        globalBest.position = { ...particle.position }
      }
    }

    for (const particle of particles) {
      updateParticle(particle, globalBest, bounds, config, rng)
    }

    if (Math.abs(previousBestFitness - globalBest.fitness) < config.convergenceThreshold) {
      stagnationCount++
      if (stagnationCount >= config.stagnationIterations) {
        break
      }
    } else {
      stagnationCount = 0
    }

    previousBestFitness = globalBest.fitness
  }

  return {
    success: true,
    optimalParams: {
      ...decodeParticlePosition(globalBest.position),
      adaptivePower: config.adaptivePower !== false,
      adaptiveNeighborCount: Math.max(
        3,
        Math.min(16, Math.floor(Number(config.adaptiveNeighborCount) || 8))
      )
    },
    fitness: globalBest.fitness,
    iterations: config.maxIterations,
    particleCount: config.particleCount,
    neighborPolicy: config.neighborPolicy,
    sectorCount: config.sectorCount,
    objectiveWeights: config.objectiveWeights
  }
}

/**
 * 点位筛选与热点保留策略。
 *
 * 当原始点过多时，不直接把全部点送入 Kriging / IDW。
 * 这里先保留高应力热点，再用空间分散度补齐样本，兼顾：
 * 1. 高频热点不丢失；
 * 2. 空间覆盖不要过于集中。
 */
export function buildInterpolationSeriesStats(series) {
  let peakAbs = 0
  let meanAbs = 0
  let validCount = 0
  for (let i = 0; i < series.length; i++) {
    const value = Number(series[i])
    if (!Number.isFinite(value)) continue
    const absValue = Math.abs(value)
    if (absValue > peakAbs) peakAbs = absValue
    meanAbs += absValue
    validCount += 1
  }
  return {
    peakAbs,
    meanAbs: validCount > 0 ? meanAbs / validCount : 0
  }
}

function computeSpatialDistanceScore(a, b, invSize) {
  const dx = (a.x - b.x) * invSize.x
  const dy = (a.y - b.y) * invSize.y
  const dz = (a.z - b.z) * invSize.z
  return dx * dx + dy * dy + dz * dz
}

export function selectInterpolationPoints(
  localPointsRaw,
  allSeriesRaw,
  size,
  maxPoints,
  options,
  _method
) {
  if (maxPoints >= localPointsRaw.length) {
    return {
      localPoints: localPointsRaw,
      allSeries: allSeriesRaw
    }
  }

  const stats = allSeriesRaw.map(series => buildInterpolationSeriesStats(series))
  const ranked = stats
    .map((stat, index) => ({
      index,
      score: stat.peakAbs * 0.72 + stat.meanAbs * 0.28
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const requestedHotspotRatio = Number(options?.hotspotRatio)
  const hotspotRatio = Number.isFinite(requestedHotspotRatio)
    ? Math.max(0.1, Math.min(0.8, requestedHotspotRatio))
    : 0.5
  const hotspotCount = Math.min(maxPoints, Math.max(1, Math.round(maxPoints * hotspotRatio)))
  const selected = []
  const selectedSet = new Set()

  for (let i = 0; i < ranked.length && selected.length < hotspotCount; i++) {
    const nextIndex = ranked[i].index
    selected.push(nextIndex)
    selectedSet.add(nextIndex)
  }

  const invSize = {
    x: 1 / Math.max(1, Number(size?.[0]) || 1),
    y: 1 / Math.max(1, Number(size?.[1]) || 1),
    z: 1 / Math.max(1, Number(size?.[2]) || 1)
  }
  const maxScore = ranked.length > 0 ? ranked[0].score : 0

  while (selected.length < maxPoints) {
    let bestIndex = -1
    let bestMetric = Number.NEGATIVE_INFINITY
    for (let i = 0; i < localPointsRaw.length; i++) {
      if (selectedSet.has(i)) continue
      const candidate = localPointsRaw[i]
      let minDist = Number.POSITIVE_INFINITY
      for (let j = 0; j < selected.length; j++) {
        const dist = computeSpatialDistanceScore(candidate, localPointsRaw[selected[j]], invSize)
        if (dist < minDist) minDist = dist
      }
      const scoreBonus =
        maxScore > 0 ? ((stats[i].peakAbs * 0.72 + stats[i].meanAbs * 0.28) / maxScore) * 0.08 : 0
      const metric = minDist + scoreBonus
      if (metric > bestMetric) {
        bestMetric = metric
        bestIndex = i
      }
    }
    if (bestIndex < 0) break
    selected.push(bestIndex)
    selectedSet.add(bestIndex)
  }

  selected.sort((a, b) => a - b)
  return {
    localPoints: selected.map(index => localPointsRaw[index]),
    allSeries: selected.map(index => allSeriesRaw[index])
  }
}

function getAxisValue(point, axis) {
  return axis === 0 ? point.x : axis === 1 ? point.y : point.z
}

function squaredDistance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

function buildNode(points, depth) {
  if (!points.length) return null
  const axis = depth % 3
  const sorted = points.slice().sort((a, b) => getAxisValue(a, axis) - getAxisValue(b, axis))
  const mid = Math.floor(sorted.length / 2)
  return {
    point: sorted[mid],
    axis,
    left: buildNode(sorted.slice(0, mid), depth + 1),
    right: buildNode(sorted.slice(mid + 1), depth + 1)
  }
}

function insertNeighbor(best, candidate, maxNeighbors) {
  if (best.length < maxNeighbors) {
    best.push(candidate)
    return
  }
  let farthestIndex = 0
  for (let i = 1; i < best.length; i++) {
    if (best[i].distance2 > best[farthestIndex].distance2) farthestIndex = i
  }
  if (candidate.distance2 < best[farthestIndex].distance2) {
    best[farthestIndex] = candidate
  }
}

function currentFarthestDistance2(best, maxNeighbors) {
  if (best.length < maxNeighbors) return Number.POSITIVE_INFINITY
  let farthest = best[0]?.distance2 || Number.POSITIVE_INFINITY
  for (let i = 1; i < best.length; i++) {
    if (best[i].distance2 > farthest) farthest = best[i].distance2
  }
  return farthest
}

function searchKNearest(node, target, maxNeighbors, radius2, best) {
  if (!node) return

  const distance2 = squaredDistance(target, node.point)
  if (distance2 <= radius2) {
    insertNeighbor(best, { index: node.point.index, distance2 }, maxNeighbors)
  }

  const axis = node.axis
  const delta = getAxisValue(target, axis) - getAxisValue(node.point, axis)
  const primary = delta <= 0 ? node.left : node.right
  const secondary = delta <= 0 ? node.right : node.left

  searchKNearest(primary, target, maxNeighbors, radius2, best)

  const splitDistance2 = delta * delta
  const threshold = Math.min(radius2, currentFarthestDistance2(best, maxNeighbors))
  if (splitDistance2 <= threshold) {
    searchKNearest(secondary, target, maxNeighbors, radius2, best)
  }
}

export function createPointSpatialIndex(points) {
  const indexed = Array.isArray(points) ? points.map((point, index) => ({ ...point, index })) : []
  const root = buildNode(indexed, 0)

  return {
    findNearest(target, maxNeighbors, radius2 = Number.POSITIVE_INFINITY) {
      const best = []
      searchKNearest(root, target, Math.max(1, maxNeighbors), radius2, best)
      best.sort((a, b) => a.distance2 - b.distance2)
      return best
    }
  }
}
