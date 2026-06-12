/**
 * 实验计算 Web Worker
 *
 * 将所有 CPU 密集型计算（数据生成、PSO优化、Kriging矩阵、统计指标、
 * 网格插值）移入 Worker 线程，彻底解决主线程卡死问题。
 *
 * 重要约束：
 * - 实验中的插值算法必须直接复用 `stress-analysis` 的核心实现；
 * - 本文件只负责实验数据生成、评估、组织结果和热力图快照，不再维护独立算法分支。
 */

import {
  optimizeIDWParameters as optimizeStressIDWParameters,
  idwInterpolateSingle
} from '../../../stress-analysis/services/core/interpolation/idwCore.js'
import {
  train3D as trainStressKriging3D,
  predict3D as predictStressKriging3D
} from '../../../stress-analysis/services/core/interpolation/interpolationCore.js'
import { clampInt, computeHeatmapGlobalRange } from './experimentVisualizationCore.js'

// ==================== 工具函数 ====================

function createSeededRng(seed) {
  let s = (Number(seed) || 0) >>> 0
  return function rng() {
    s = (1664525 * s + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ==================== 合成数据生成 ====================

function gaussianKernel(x, y, z, cx, cy, cz, sx, sy, sz, amplitude) {
  const dx = (x - cx) / Math.max(1e-6, sx)
  const dy = (y - cy) / Math.max(1e-6, sy)
  const dz = (z - cz) / Math.max(1e-6, sz)
  return amplitude * Math.exp(-0.5 * (dx * dx + dy * dy + dz * dz))
}

function linearGradient(x, y, z, size, gradVec) {
  return (
    (x / Math.max(1e-6, size[0])) * gradVec[0] +
    (y / Math.max(1e-6, size[1])) * gradVec[1] +
    (z / Math.max(1e-6, size[2])) * gradVec[2]
  )
}

function generateGaussianMixtureField({ size, seed, peakCount, baseAmp, minAmp, sigmaRange }) {
  const rng = createSeededRng(seed)
  const peaks = []
  for (let i = 0; i < peakCount; i++) {
    peaks.push({
      cx: rng() * size[0],
      cy: rng() * size[1],
      cz: rng() * size[2],
      sx: sigmaRange[0] + rng() * (sigmaRange[1] - sigmaRange[0]),
      sy: sigmaRange[0] + rng() * (sigmaRange[1] - sigmaRange[0]),
      sz: sigmaRange[0] * 0.5 + rng() * (sigmaRange[1] - sigmaRange[0]) * 0.5,
      amplitude: minAmp + rng() * (baseAmp - minAmp)
    })
  }
  return function (x, y, z) {
    let v = 0
    for (const p of peaks)
      v += gaussianKernel(x, y, z, p.cx, p.cy, p.cz, p.sx, p.sy, p.sz, p.amplitude)
    return v
  }
}

function generateGradientPeakField({ size, seed, gradVec, peakCount, peakAmp }) {
  const rng = createSeededRng(seed)
  const peaks = []
  for (let i = 0; i < peakCount; i++) {
    peaks.push({
      cx: 0.2 * size[0] + rng() * 0.6 * size[0],
      cy: 0.2 * size[1] + rng() * 0.6 * size[1],
      cz: 0.1 * size[2] + rng() * 0.5 * size[2],
      sx: 25 + rng() * 40,
      sy: 25 + rng() * 40,
      sz: 12 + rng() * 25,
      amplitude: peakAmp * (0.5 + rng() * 0.5)
    })
  }
  return function (x, y, z) {
    let v = linearGradient(x, y, z, size, gradVec)
    for (const p of peaks)
      v += gaussianKernel(x, y, z, p.cx, p.cy, p.cz, p.sx, p.sy, p.sz, p.amplitude)
    return Math.max(0, v)
  }
}

function generateMineMonitoringPoints(fieldSize, pointCount, anomalyCount, rng) {
  const positions = []
  const isAnomaly = []

  const [fx, fy, fz] = fieldSize

  const layerCount = Math.max(3, Math.min(8, Math.round(fz / 25)))
  const ptsPerLayer = Math.floor(pointCount / layerCount)
  const remainder = pointCount % layerCount

  for (let layer = 0; layer < layerCount; layer++) {
    const layerZStart = (layer / layerCount) * fz * 0.85 + fz * 0.05
    const layerZEnd = ((layer + 1) / layerCount) * fz * 0.85 + fz * 0.05
    const layerPoints = ptsPerLayer + (layer < remainder ? 1 : 0)

    const tunnelCount = Math.max(1, Math.floor(layerPoints / 12))
    const tunnelCenters = []
    for (let t = 0; t < tunnelCount; t++) {
      tunnelCenters.push({
        x: 0.15 * fx + rng() * 0.7 * fx,
        y: 0.15 * fy + rng() * 0.7 * fy,
        angle: rng() * Math.PI * 2,
        length: 0.2 * Math.min(fx, fy) + rng() * 0.4 * Math.min(fx, fy)
      })
    }

    const ptsPerTunnel = Math.floor(layerPoints / tunnelCount)
    const tunnelRemainder = layerPoints % tunnelCount

    for (let t = 0; t < tunnelCount; t++) {
      const tunnel = tunnelCenters[t]
      const tunnelPts = ptsPerTunnel + (t < tunnelRemainder ? 1 : 0)

      for (let p = 0; p < tunnelPts; p++) {
        const along = p / Math.max(1, tunnelPts - 1)
        const tx = tunnel.x + Math.cos(tunnel.angle) * tunnel.length * (along - 0.5)
        const ty = tunnel.y + Math.sin(tunnel.angle) * tunnel.length * (along - 0.5)

        const lateralOffset = (rng() - 0.5) * 8
        const ox = tx + Math.cos(tunnel.angle + Math.PI / 2) * lateralOffset
        const oy = ty + Math.sin(tunnel.angle + Math.PI / 2) * lateralOffset

        const z = layerZStart + rng() * (layerZEnd - layerZStart)

        positions.push({
          x: Math.max(0, Math.min(fx, ox)),
          y: Math.max(0, Math.min(fy, oy)),
          z: Math.max(0, Math.min(fz, z))
        })
        isAnomaly.push(false)
      }
    }
  }

  const anomalyZones = []
  const zoneCount = Math.max(1, Math.floor(anomalyCount / 3))
  for (let z = 0; z < zoneCount; z++) {
    anomalyZones.push({
      cx: 0.2 * fx + rng() * 0.6 * fx,
      cy: 0.2 * fy + rng() * 0.6 * fy,
      cz: 0.2 * fz + rng() * 0.6 * fz,
      rx: 10 + rng() * 30,
      ry: 10 + rng() * 30,
      rz: 5 + rng() * 15
    })
  }

  for (let i = 0; i < anomalyCount; i++) {
    const zone = anomalyZones[i % zoneCount]
    const ax = zone.cx + (rng() - 0.5) * 2 * zone.rx
    const ay = zone.cy + (rng() - 0.5) * 2 * zone.ry
    const az = zone.cz + (rng() - 0.5) * 2 * zone.rz

    positions.push({
      x: Math.max(0, Math.min(fx, ax)),
      y: Math.max(0, Math.min(fy, ay)),
      z: Math.max(0, Math.min(fz, az))
    })
    isAnomaly.push(true)
  }

  return { positions, isAnomaly }
}

function generateTestDataset(config = {}) {
  const fc = config || {}
  const fieldSize =
    Array.isArray(fc.fieldSize) && fc.fieldSize.length >= 3 ? fc.fieldSize : [200, 200, 100]
  const pointCount = Number.isFinite(fc.pointCount) ? Math.max(3, fc.pointCount) : 150
  const testRatio = Number.isFinite(fc.testRatio) ? Math.max(0.1, Math.min(0.5, fc.testRatio)) : 0.3
  const seed = Number.isFinite(fc.seed) ? fc.seed : 2026
  const noiseLevel = Number.isFinite(fc.noiseLevel) ? Math.max(0, fc.noiseLevel) : 0.05
  const anomalyCount = Number.isFinite(fc.anomalyCount)
    ? Math.max(0, Math.min(30, fc.anomalyCount))
    : 8
  const anomalyMag = Number.isFinite(fc.anomalyMagnitude) ? fc.anomalyMagnitude : 3.0
  const trendType = fc.trendType === 'gradient_peak' ? 'gradient_peak' : 'gaussian_mixture'

  const fieldFn =
    trendType === 'gradient_peak'
      ? generateGradientPeakField({
          size: fieldSize,
          seed,
          gradVec: [30, 15, -10],
          peakCount: 4,
          peakAmp: 40
        })
      : generateGaussianMixtureField({
          size: fieldSize,
          seed,
          peakCount: 5,
          baseAmp: 50,
          minAmp: 8,
          sigmaRange: [15, 60]
        })

  const rng = createSeededRng(seed + 1)
  const { positions, isAnomaly } = generateMineMonitoringPoints(
    fieldSize,
    pointCount,
    anomalyCount,
    rng
  )

  const totalPts = positions.length
  const trueValues = new Array(totalPts)
  for (let i = 0; i < totalPts; i++) {
    trueValues[i] = Math.max(0, fieldFn(positions[i].x, positions[i].y, positions[i].z))
  }

  const globalMax = Math.max(...trueValues, 1)
  const noisyValues = trueValues.map((v, i) => {
    if (!isAnomaly[i]) {
      const noise = (rng() - 0.5) * 2 * noiseLevel * globalMax
      return Math.max(0, v + noise)
    }
    return Math.max(0, v * anomalyMag * (0.7 + rng() * 0.6))
  })

  const normalIndices = []
  const anomalyIndices = []
  for (let i = 0; i < totalPts; i++) {
    if (isAnomaly[i]) anomalyIndices.push(i)
    else normalIndices.push(i)
  }

  for (let i = normalIndices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[normalIndices[i], normalIndices[j]] = [normalIndices[j], normalIndices[i]]
  }

  const testCount = Math.max(1, Math.floor(normalIndices.length * testRatio))
  const testSet = new Set(normalIndices.slice(0, testCount))

  const trainPts = [],
    trainVals = [],
    trainTrueVals = [],
    trainAnomaly = [],
    testPts = [],
    testTrueVals = [],
    testAnomaly = []

  for (let i = 0; i < totalPts; i++) {
    if (testSet.has(i)) {
      testPts.push(positions[i])
      testTrueVals.push(trueValues[i])
      testAnomaly.push(isAnomaly[i])
    } else {
      trainPts.push(positions[i])
      trainVals.push(noisyValues[i])
      trainTrueVals.push(trueValues[i])
      trainAnomaly.push(isAnomaly[i])
    }
  }

  return {
    fieldSize,
    fieldFn,
    trainPoints: trainPts,
    trainValues: trainVals,
    trainTrueValues: trainTrueVals,
    trainAnomaly,
    testPoints: testPts,
    testTrueValues: testTrueVals,
    testAnomaly,
    globalMax,
    config: {
      pointCount,
      testRatio,
      seed,
      noiseLevel,
      anomalyCount,
      anomalyMagnitude: anomalyMag,
      trendType
    }
  }
}

// ==================== IDW 插值 ====================

function idwInterpolatePoint(tx, ty, tz, trainPts, trainVals, params = {}) {
  return idwInterpolateSingle(tx, ty, tz, trainPts, trainVals, params)
}

function runIDWPredict(testPts, trainPts, trainVals, params) {
  const preds = new Array(testPts.length)
  for (let i = 0; i < testPts.length; i++) {
    const tp = testPts[i]
    preds[i] = idwInterpolatePoint(tp.x, tp.y, tp.z, trainPts, trainVals, params)
  }
  return preds
}

// ==================== PSO 优化（轻量版，更快收敛） ====================

const PSO_CONFIG = {
  particleCount: 24,
  maxIterations: 60,
  inertiaWeight: 0.729,
  cognitiveWeight: 1.49445,
  socialWeight: 1.49445,
  convergenceThreshold: 1e-6,
  stagnationIterations: 12,
  seed: 1337,
  maxFitnessSamples: 160,
  crossValidationFolds: 5,
  neighborPolicy: 'sector',
  sectorCount: 8,
  objectiveWeights: { rmse: 0.55, bias: 0.2, variance: 0.1, smoothness: 0.15 }
}

function optimizeIDWParameters(points, values, options, cancelFlag) {
  const cfg = { ...PSO_CONFIG, ...(options || {}) }
  const result = optimizeStressIDWParameters(points, values, cfg)
  if (cancelFlag?.cancelled) {
    return result?.success
      ? { ...result, cancelled: true }
      : { success: false, reason: 'cancelled', optimalParams: null, fitness: Infinity }
  }
  return result
}

// ==================== Kriging ====================

function trainKriging(trainPts, trainVals, modelName) {
  if (!Array.isArray(trainPts) || trainPts.length < 3) return null
  return trainStressKriging3D(
    trainVals,
    trainPts.map(p => p.x),
    trainPts.map(p => p.y),
    trainPts.map(p => p.z),
    modelName,
    1e-10
  )
}

function krigingPredict(x, y, z, model, clampRange) {
  return predictStressKriging3D(x, y, z, model, clampRange)
}

// ==================== 统计指标 ====================

function computeRMSE(preds, truth) {
  let sq = 0,
    c = 0
  for (let i = 0; i < Math.min(preds.length, truth.length); i++) {
    if (Number.isFinite(preds[i]) && Number.isFinite(truth[i])) {
      sq += (preds[i] - truth[i]) ** 2
      c++
    }
  }
  return c > 0 ? Math.sqrt(sq / c) : NaN
}

function computeMAE(preds, truth) {
  let sum = 0,
    c = 0
  for (let i = 0; i < Math.min(preds.length, truth.length); i++) {
    if (Number.isFinite(preds[i]) && Number.isFinite(truth[i])) {
      sum += Math.abs(preds[i] - truth[i])
      c++
    }
  }
  return c > 0 ? sum / c : NaN
}

function computeMaxError(preds, truth) {
  let maxErr = 0
  let c = 0
  for (let i = 0; i < Math.min(preds.length, truth.length); i++) {
    if (Number.isFinite(preds[i]) && Number.isFinite(truth[i])) {
      maxErr = Math.max(maxErr, Math.abs(preds[i] - truth[i]))
      c++
    }
  }
  return c > 0 ? maxErr : NaN
}

function computeMAPE(preds, truth) {
  // 计算真值均值的绝对值，作为尺度参考
  let sumAbsTruth = 0
  let validCount = 0
  for (let i = 0; i < Math.min(preds.length, truth.length); i++) {
    if (Number.isFinite(preds[i]) && Number.isFinite(truth[i])) {
      sumAbsTruth += Math.abs(truth[i])
      validCount++
    }
  }
  const meanAbsTruth = validCount > 0 ? sumAbsTruth / validCount : 0
  // 分母下限 = max(均值的1%, 1e-4)，避免近零真值导致 MAPE 爆炸
  const floor = Math.max(meanAbsTruth * 0.01, 1e-4)

  let sum = 0
  let c = 0
  for (let i = 0; i < Math.min(preds.length, truth.length); i++) {
    if (Number.isFinite(preds[i]) && Number.isFinite(truth[i])) {
      const denom = Math.max(floor, Math.abs(truth[i]))
      sum += Math.abs((preds[i] - truth[i]) / denom) * 100
      c++
    }
  }
  return c > 0 ? sum / c : NaN
}

function computeR2(preds, truth) {
  const valid = []
  let sumY = 0
  for (let i = 0; i < Math.min(preds.length, truth.length); i++) {
    if (Number.isFinite(preds[i]) && Number.isFinite(truth[i])) {
      valid.push({ p: preds[i], t: truth[i] })
      sumY += truth[i]
    }
  }
  if (valid.length < 2) return NaN
  const meanY = sumY / valid.length
  let ssRes = 0,
    ssTot = 0
  for (const { p, t } of valid) {
    ssRes += (p - t) ** 2
    ssTot += (t - meanY) ** 2
  }
  return ssTot < 1e-12 ? (ssRes < 1e-12 ? 1 : NaN) : 1 - ssRes / ssTot
}

function computeAllMetrics(preds, truth) {
  return {
    rmse: computeRMSE(preds, truth),
    mae: computeMAE(preds, truth),
    r2: computeR2(preds, truth),
    maxError: computeMaxError(preds, truth),
    mape: computeMAPE(preds, truth)
  }
}

function computeErrorDistribution(errors) {
  const valid = errors.filter(Number.isFinite)
  if (!valid.length) return { bins: [], count: 0 }
  let lo = valid[0],
    hi = valid[0]
  for (const v of valid) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const range = Math.max(0.01, (hi - lo) * 1.1)
  lo -= range * 0.05
  hi += range * 0.05
  const binN = 20,
    binW = range / binN
  const bins = new Array(binN).fill(0)
  for (const v of valid) {
    const idx = Math.min(binN - 1, Math.max(0, Math.floor((v - lo) / binW)))
    bins[idx]++
  }
  return { bins: bins.map((c, i) => ({ binStart: lo + i * binW, count: c })), count: valid.length }
}

// ==================== 网格插值（用于热力图数据） ====================

function idw2dGrid(dataset, gridRes, params) {
  const { fieldSize, trainPoints, trainValues } = dataset
  const gs = Math.max(14, Math.min(72, gridRes || 36))
  const aspectX = fieldSize[0] / Math.min(fieldSize[0], fieldSize[1])
  const aspectY = fieldSize[1] / Math.min(fieldSize[0], fieldSize[1])
  const nx = Math.max(12, Math.round(gs * aspectX))
  const ny = Math.max(12, Math.round(gs * aspectY))
  const zMid = fieldSize[2] / 2

  const vals = new Float32Array(nx * ny)

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (fieldSize[0] * i) / Math.max(1, nx - 1)
      const y = (fieldSize[1] * j) / Math.max(1, ny - 1)
      vals[j * nx + i] = idwInterpolatePoint(x, y, zMid, trainPoints, trainValues, params)
    }
  }
  return { grid: { width: nx, height: ny, depth: 1 }, values: vals }
}

function createDefaultIdwParams(pointCount, idwConfig = {}) {
  const safeCount = Math.max(1, pointCount)
  const defaultNeighborCount =
    safeCount <= 4
      ? safeCount
      : safeCount <= 10
        ? Math.min(safeCount, 6)
        : Math.min(28, Math.max(8, Math.round(safeCount * 0.15)))
  return {
    power: 1.85,
    neighborCount: clampInt(defaultNeighborCount, 1, safeCount, Math.min(8, safeCount)),
    anisotropyParams: null,
    neighborPolicy: idwConfig.neighborPolicy === 'nearest' ? 'nearest' : 'sector',
    sectorCount: clampInt(idwConfig.sectorCount, 1, 16, 8),
    adaptivePower: true,
    adaptiveNeighborCount: 8
  }
}

function kriging2dGrid(dataset, gridRes, model, krigingCache) {
  const { fieldSize } = dataset
  const gs = Math.max(14, Math.min(72, gridRes || 36))
  const aspectX = fieldSize[0] / Math.min(fieldSize[0], fieldSize[1])
  const aspectY = fieldSize[1] / Math.min(fieldSize[0], fieldSize[1])
  const nx = Math.max(12, Math.round(gs * aspectX))
  const ny = Math.max(12, Math.round(gs * aspectY))
  const zMid = fieldSize[2] / 2

  // 缓存/复用 Kriging 模型
  const cacheKey = model.modelName
  let krModel = krigingCache[cacheKey]
  if (!krModel) {
    krModel = trainKriging(dataset.trainPoints, dataset.trainValues, model.modelName)
    krigingCache[cacheKey] = krModel
  }

  const vals = new Float32Array(nx * ny)
  if (!krModel || krModel.n < 3) return { grid: { width: nx, height: ny, depth: 1 }, values: vals }

  const gridMin = dataset.trainValues.reduce((a, v) => Math.min(a, v), Infinity)
  const gridMax = dataset.trainValues.reduce((a, v) => Math.max(a, v), -Infinity)
  const gridClamp = [gridMin, gridMax]

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (fieldSize[0] * i) / Math.max(1, nx - 1)
      const y = (fieldSize[1] * j) / Math.max(1, ny - 1)
      vals[j * nx + i] = krigingPredict(x, y, zMid, krModel, gridClamp)
    }
  }
  return {
    grid: { width: nx, height: ny, depth: 1 },
    values: vals,
    variogram: { nugget: krModel.nugget, range: krModel.range, sill: krModel.sill }
  }
}

// ==================== 主实验流程 ====================

let currentRunId = null
let cancelFlag = { cancelled: false }

function sendProgress(runId, phase, message, percent) {
  self.postMessage({
    type: 'progress',
    phase,
    message,
    percent: Math.round(Math.min(100, Math.max(0, percent))),
    runId
  })
}

async function runExperiment(config, runId, cancelFg) {
  const reportProgress = (phase, msg, pct) => {
    if (cancelFg.cancelled) return
    if (runId !== currentRunId) return
    sendProgress(runId, phase, msg, pct)
  }

  // 检查取消
  const checkCancel = () => {
    if (cancelFg.cancelled) throw new Error('CANCELLED')
  }

  try {
    // 阶段1：数据生成 (0-10%)
    reportProgress('generating', '正在生成合成应力场数据...', 2)
    checkCancel()
    const dataset = generateTestDataset(config.dataGeneration || {})
    reportProgress(
      'splitting',
      `训练集 ${dataset.trainPoints.length} 点，测试集 ${dataset.testPoints.length} 点`,
      10
    )
    checkCancel()

    // 阶段2：IDW-PSO 参数优化 (10-30%)
    // 快/慢模式都会运行 PSO，区别仅在于粒子数、迭代数和重启次数
    const idwConfig = config.comparison?.idwConfig || {}
    const useThoroughPSO = idwConfig.optimizeParameters !== false && dataset.trainPoints.length >= 4

    let optimalParams = null
    let psoTimeMs = 0
    const defaultIdwParams = createDefaultIdwParams(dataset.trainPoints.length, idwConfig)
    let idwParams = { ...defaultIdwParams }

    // 始终运行 PSO：快模式用轻量参数，慢模式用完整参数
    const psoMode = useThoroughPSO ? 'thorough' : 'quick'
    const psoT0 = performance.now()
    const baseSeed = Number.isFinite(Number(idwConfig.optimizationSeed))
      ? Number(idwConfig.optimizationSeed)
      : dataset.config.seed + 1337

    const restartCount = useThoroughPSO ? 3 : 1
    const psoParticleCount = useThoroughPSO
      ? clampInt(idwConfig.optimizationParticles, 4, 40, PSO_CONFIG.particleCount)
      : 8
    const psoMaxIterations = useThoroughPSO
      ? clampInt(idwConfig.optimizationIterations, 4, 120, PSO_CONFIG.maxIterations)
      : 20
    const psoMaxFitnessSamples = useThoroughPSO
      ? clampInt(
          idwConfig.optimizationMaxFitnessSamples,
          24,
          dataset.trainPoints.length,
          PSO_CONFIG.maxFitnessSamples
        )
      : Math.min(60, dataset.trainPoints.length)

    reportProgress(
      'idw_benchmark',
      `PSO优化IDW参数 (${psoMode === 'thorough' ? '慢·精准' : '快·流畅'}模式, ${psoParticleCount}粒子×${psoMaxIterations}迭代×${restartCount}轮)...`,
      14
    )

    let bestPsoResult = null
    let bestFitness = Infinity

    for (let restart = 0; restart < restartCount; restart++) {
      checkCancel()
      const restartSeed = baseSeed + restart * 1733
      const psoResult = optimizeIDWParameters(
        dataset.trainPoints,
        dataset.trainValues,
        {
          particleCount: psoParticleCount,
          maxIterations: psoMaxIterations,
          maxFitnessSamples: psoMaxFitnessSamples,
          crossValidationFolds: clampInt(
            config.comparison?.crossValidationFolds,
            2,
            10,
            PSO_CONFIG.crossValidationFolds
          ),
          neighborPolicy: defaultIdwParams.neighborPolicy,
          sectorCount: defaultIdwParams.sectorCount,
          seed: restartSeed
        },
        cancelFg
      )
      if (psoResult.success && psoResult.fitness < bestFitness) {
        bestFitness = psoResult.fitness
        bestPsoResult = psoResult
      }
    }

    psoTimeMs = performance.now() - psoT0

    if (bestPsoResult?.success) {
      idwParams = { ...bestPsoResult.optimalParams }
      optimalParams = {
        power: idwParams.power,
        neighborCount: idwParams.neighborCount,
        anisotropy: idwParams.anisotropyParams,
        neighborPolicy: idwParams.neighborPolicy,
        sectorCount: idwParams.sectorCount,
        fitness: bestPsoResult.fitness,
        psoTimeMs,
        restarts: restartCount,
        mode: psoMode
      }
    } else {
      // PSO 失败时回退到默认参数，但仍记录尝试
      idwParams = { ...defaultIdwParams }
      optimalParams = null
    }

    reportProgress(
      'idw_benchmark',
      `IDW-PSO p=${idwParams.power.toFixed(2)}, k=${idwParams.neighborCount} (${psoMode})`,
      22
    )
    checkCancel()

    const idwT0 = performance.now()
    const idwPreds = runIDWPredict(
      dataset.testPoints,
      dataset.trainPoints,
      dataset.trainValues,
      idwParams
    )
    const idwTiming = performance.now() - idwT0
    const idwMetrics = computeAllMetrics(idwPreds, dataset.testTrueValues)
    const idwErrors = idwPreds.map((p, i) => p - dataset.testTrueValues[i])
    const idwErrDist = computeErrorDistribution(idwErrors)
    reportProgress(
      'idw_benchmark',
      `IDW-PSO 完成，RMSE=${idwMetrics.rmse?.toFixed(2) || 'N/A'}`,
      28
    )
    checkCancel()

    // 阶段3：IDW 默认基线 (28-35%)
    reportProgress('idw_default', 'IDW默认参数基线测试...', 29)
    const idwDefaultParams = createDefaultIdwParams(dataset.trainPoints.length, idwConfig)
    const idwDefT0 = performance.now()
    const idwDefPreds = runIDWPredict(
      dataset.testPoints,
      dataset.trainPoints,
      dataset.trainValues,
      idwDefaultParams
    )
    const idwDefTiming = performance.now() - idwDefT0
    const idwDefMetrics = computeAllMetrics(idwDefPreds, dataset.testTrueValues)
    reportProgress('idw_default', `IDW默认完成`, 34)
    checkCancel()

    // 阶段4：Kriging 测试 (34-55%)
    reportProgress('kriging_benchmark', 'Kriging插值基准测试...', 36)
    const krModels = config.comparison?.krigingModels || ['exponential']
    const krResults = {}

    let krIdx = 0
    for (const modelName of krModels) {
      reportProgress(
        'kriging_benchmark',
        `Kriging ${modelName} 模型...`,
        37 + Math.round((krIdx / Math.max(1, krModels.length)) * 18)
      )
      checkCancel()

      const krT0 = performance.now()
      const krModel = trainKriging(dataset.trainPoints, dataset.trainValues, modelName)
      const krTrainMs = performance.now() - krT0

      if (!krModel) {
        krResults[modelName] = {
          predictions: dataset.testPoints.map(() => 0),
          timing: { totalMs: krTrainMs, trainMs: krTrainMs, predictionMs: 0 },
          failed: true,
          reason: 'kriging_system_singular',
          metrics: { rmse: NaN, mae: NaN, r2: NaN, maxError: NaN, mape: NaN },
          errorDistribution: { bins: [], count: 0 }
        }
      } else {
        const krPredT0 = performance.now()

        // 用统计范围作为 clamp，避免 [min, max] 对异常测试点过度约束
        const trainSum = dataset.trainValues.reduce((a, v) => a + v, 0)
        const trainMean = trainSum / dataset.trainValues.length
        const trainVar =
          dataset.trainValues.reduce((a, v) => a + (v - trainMean) ** 2, 0) /
          dataset.trainValues.length
        const trainStd = Math.sqrt(trainVar)
        const trainMin = dataset.trainValues.reduce((a, v) => Math.min(a, v), Infinity)
        const trainMax = dataset.trainValues.reduce((a, v) => Math.max(a, v), -Infinity)

        // 均值 ± 4σ，确保覆盖异常点范围，同时不低于训练数据原始边界
        const clampMin = Math.min(trainMin, trainMean - 4 * trainStd)
        const clampMax = Math.max(trainMax, trainMean + 4 * trainStd)
        const krClamp = [Math.max(0, clampMin), clampMax]

        const krPreds = dataset.testPoints.map(tp =>
          krigingPredict(tp.x, tp.y, tp.z, krModel, krClamp)
        )
        const krPredMs = performance.now() - krPredT0

        krResults[modelName] = {
          predictions: krPreds,
          timing: { totalMs: krTrainMs + krPredMs, trainMs: krTrainMs, predictionMs: krPredMs },
          metrics: computeAllMetrics(krPreds, dataset.testTrueValues),
          model: {
            nugget: krModel.nugget,
            range: krModel.range,
            sill: krModel.sill,
            modelName,
            status: krModel.status || 'ok',
            fitError: krModel.fitError ?? null
          },
          errorDistribution: computeErrorDistribution(
            krPreds.map((p, i) => p - dataset.testTrueValues[i])
          )
        }
      }
      krIdx++
    }
    reportProgress('computing_metrics', '计算统计指标...', 55)
    checkCancel()

    // 阶段5：热力图网格数据生成 (55-80%)
    reportProgress('rendering_heatmaps', '生成热力图网格...', 58)
    const gridRes = config.comparison?.gridResolution || 36
    const heatmapSnapshots = []

    const idwGrid = idw2dGrid(dataset, gridRes, idwParams)
    heatmapSnapshots.push({
      methodKey: 'idw',
      label: `IDW-PSO (p=${idwParams.power.toFixed(1)}, k=${idwParams.neighborCount})`,
      gridData: idwGrid,
      params: {
        power: idwParams.power,
        neighborCount: idwParams.neighborCount,
        neighborPolicy: idwParams.neighborPolicy,
        sectorCount: idwParams.sectorCount,
        anisotropy: idwParams.anisotropyParams
      }
    })

    const krCache = {}
    reportProgress('rendering_heatmaps', `生成Kriging热力图 (${krModels.length}个模型)...`, 62)

    for (let mi = 0; mi < krModels.length; mi++) {
      const mn = krModels[mi]
      checkCancel()
      const ml =
        mn === 'exponential'
          ? '指数模型'
          : mn === 'gaussian'
            ? '高斯模型'
            : mn === 'spherical'
              ? '球状模型'
              : mn
      const krGrid = kriging2dGrid(dataset, gridRes, { modelName: mn }, krCache)
      heatmapSnapshots.push({
        methodKey: `kriging_${mn}`,
        label: `Kriging（${ml}）`,
        gridData: krGrid,
        variogram: krGrid.variogram
      })
      reportProgress(
        'rendering_heatmaps',
        `Kriging ${ml} 热力图...`,
        63 + Math.round((mi / krModels.length) * 12)
      )
    }
    reportProgress('rendering_heatmaps', '热力图网格计算完成', 78)
    checkCancel()

    // 构建比较表
    const comparisonRows = []

    // IDW-PSO（始终存在：快模式=轻量PSO，慢模式=完整PSO）
    comparisonRows.push({
      method: psoMode === 'thorough' ? 'IDW-PSO（精准优化）' : 'IDW-PSO（快速优化）',
      key: 'idw_optimized',
      metrics: idwMetrics,
      timing: { totalMs: idwTiming + psoTimeMs, psoMs: psoTimeMs, predictionMs: idwTiming },
      params: {
        power: idwParams.power,
        neighborCount: idwParams.neighborCount,
        neighborPolicy: idwParams.neighborPolicy,
        sectorCount: idwParams.sectorCount,
        anisotropy: idwParams.anisotropyParams
      }
    })

    // IDW 默认参数作为基线参考
    comparisonRows.push({
      method: 'IDW（默认参数）',
      key: 'idw_default',
      metrics: idwDefMetrics,
      timing: { totalMs: idwDefTiming },
      params: {
        power: idwDefaultParams.power,
        neighborCount: idwDefaultParams.neighborCount,
        neighborPolicy: idwDefaultParams.neighborPolicy,
        sectorCount: idwDefaultParams.sectorCount
      }
    })

    for (const [mn, kr] of Object.entries(krResults)) {
      const ml =
        mn === 'exponential'
          ? '指数模型'
          : mn === 'gaussian'
            ? '高斯模型'
            : mn === 'spherical'
              ? '球状模型'
              : mn
      comparisonRows.push({
        method: `Kriging（${ml}）`,
        key: `kriging_${mn}`,
        metrics: kr.metrics || { rmse: NaN, mae: NaN, r2: NaN },
        timing: kr.timing,
        modelInfo: kr.model || null
      })
    }

    const comparison = { rows: comparisonRows, summary: null }
    if (comparisonRows.length >= 2) {
      const best = comparisonRows.reduce((a, b) =>
        (a.metrics?.rmse || Infinity) < (b.metrics?.rmse || Infinity) ? a : b
      )
      const worst = comparisonRows.reduce((a, b) =>
        (a.metrics?.rmse || -Infinity) > (b.metrics?.rmse || -Infinity) ? a : b
      )
      comparison.summary = {
        bestMethod: best.method,
        bestRMSE: best.metrics?.rmse,
        worstMethod: worst.method,
        worstRMSE: worst.metrics?.rmse,
        totalMethods: comparisonRows.length,
        datasetInfo: {
          trainCount: dataset.trainPoints.length,
          testCount: dataset.testPoints.length,
          noiseLevel: dataset.config.noiseLevel
        }
      }
    }

    // 计算全局范围
    const gloRange = computeHeatmapGlobalRange(heatmapSnapshots)

    reportProgress('done', '实验计算完成，正在渲染热力图...', 95)

    // 返回结果（热力图实际canvas渲染在主线程完成）
    return {
      dataset: {
        trainCount: dataset.trainPoints.length,
        testCount: dataset.testPoints.length,
        fieldSize: dataset.fieldSize,
        globalMax: dataset.globalMax,
        noiseLevel: dataset.config.noiseLevel,
        anomalyCount: dataset.config.anomalyCount,
        anomalyMagnitude: dataset.config.anomalyMagnitude,
        trendType: dataset.config.trendType,
        seed: dataset.config.seed,
        testRatio: dataset.config.testRatio,
        trainPoints: dataset.trainPoints,
        trainValues: dataset.trainValues,
        trainTrueValues: dataset.trainTrueValues,
        trainAnomaly: dataset.trainAnomaly,
        testPoints: dataset.testPoints,
        testTrueValues: dataset.testTrueValues,
        testAnomaly: dataset.testAnomaly
      },
      idw: {
        metrics: idwMetrics,
        timing: { totalMs: idwTiming + psoTimeMs, psoMs: psoTimeMs, predictionMs: idwTiming },
        params: {
          power: idwParams.power,
          neighborCount: idwParams.neighborCount,
          neighborPolicy: idwParams.neighborPolicy,
          sectorCount: idwParams.sectorCount,
          optimizeParameters: useThoroughPSO,
          anisotropy: idwParams.anisotropyParams
        },
        optimalParams,
        predictions: idwPreds,
        errorDistribution: idwErrDist
      },
      idwDefault: {
        metrics: idwDefMetrics,
        timing: { totalMs: idwDefTiming },
        params: idwDefaultParams,
        predictions: idwDefPreds
      },
      kriging: krResults,
      comparison,
      heatmapSnapshots,
      globalRange: gloRange,
      timestamp: new Date().toISOString()
    }
  } catch (err) {
    if (err.message === 'CANCELLED') {
      sendProgress(runId, 'cancelled', '实验已取消', 0)
      return null
    }
    throw err
  }
}

// ==================== Worker 消息处理 ====================

self.addEventListener('message', async e => {
  const msg = e.data

  if (msg.type === 'run') {
    // 取消之前的运行
    if (currentRunId) {
      cancelFlag.cancelled = true
      // 等待一小段时间再重置
      await new Promise(r => setTimeout(r, 10))
    }

    currentRunId = msg.runId
    cancelFlag = { cancelled: false }
    const localCancel = cancelFlag

    try {
      const result = await runExperiment(msg.config, msg.runId, localCancel)
      if (result && !localCancel.cancelled) {
        self.postMessage({ type: 'complete', result, runId: msg.runId })
      }
    } catch (err) {
      if (!localCancel.cancelled) {
        self.postMessage({ type: 'error', message: err.message || '未知错误', runId: msg.runId })
      }
    }
  }

  if (msg.type === 'cancel') {
    cancelFlag.cancelled = true
    currentRunId = null
  }
})
