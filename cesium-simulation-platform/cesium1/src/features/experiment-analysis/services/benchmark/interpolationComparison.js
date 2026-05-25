import { generateTestDataset, generateGridGroundTruth } from './syntheticDataGenerator.js'
import {
  computeAllMetrics,
  computeErrorDistribution,
  aggregateRepeatResults,
  formatTimingMs
} from './statisticsUtils.js'
import { computeAnisotropicDistanceSquared } from '@/features/stress-analysis/services/core/interpolation/config.js'
import { optimizeIDWParameters } from '@/features/stress-analysis/services/core/interpolation/idwCore.js'
import {
  generateHeatmapSnapshots,
  renderSnapshotImages,
  renderDifferenceImage,
  computeGlobalRange
} from './gridComparisonUtils.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// eslint-disable-next-line no-unused-vars
function _buildMockPointDataset(trainPoints, trainValues, fieldSize, metrics) {
  const frames = metrics.length
  const timePoints = Array.from({ length: frames }, (_, i) => i)
  const points = trainPoints.map((p, i) => ({
    id: `P${String(i + 1).padStart(3, '0')}`,
    name: `测点${i + 1}`,
    coordMode: 'ENU',
    center: [p.x, p.y, p.z],
    stressSeries: metrics.map(m => m[i])
  }))

  return {
    sourceKind: 'points',
    size: fieldSize,
    time: { frames, timePoints, dimension: '帧', speedMs: 500 },
    points,
    algo: {
      stressRef: Math.max(...metrics.flat()) || 1,
      lowCut: 0.05,
      gamma: 1.15,
      radiusMin: 10,
      radiusScale: 50,
      radiusGamma: 0.9
    }
  }
}

// eslint-disable-next-line no-unused-vars
function _getPointMetricSeriesValues(point, pd, metricKey) {
  if (Array.isArray(point?.stressSeries)) return point.stressSeries
  return []
}

function idwInterpolate(targetX, targetY, targetZ, trainPoints, trainValues, power, neighborCount) {
  const eps = 1e-8
  const distances = trainPoints.map((p, i) => ({
    index: i,
    d2: (targetX - p.x) ** 2 + (targetY - p.y) ** 2 + (targetZ - p.z) ** 2
  }))
  distances.sort((a, b) => a.d2 - b.d2)

  const used = distances.slice(0, Math.min(neighborCount, distances.length))
  if (used.length > 0 && used[0].d2 <= eps * eps) {
    return trainValues[used[0].index]
  }

  let weightSum = 0
  let valueSum = 0
  for (const item of used) {
    const w = 1 / Math.pow(Math.sqrt(item.d2) + eps, power)
    weightSum += w
    valueSum += w * trainValues[item.index]
  }
  return weightSum > 0 ? valueSum / weightSum : 0
}

function idwInterpolateWithAnisotropy(
  targetX,
  targetY,
  targetZ,
  trainPoints,
  trainValues,
  power,
  neighborCount,
  anisotropyParams
) {
  const eps = 1e-8
  const distances = trainPoints.map((p, i) => ({
    index: i,
    d2: computeAnisotropicDistanceSquared(
      targetX - p.x,
      targetY - p.y,
      targetZ - p.z,
      anisotropyParams
    )
  }))
  distances.sort((a, b) => a.d2 - b.d2)
  const used = distances.slice(0, Math.min(neighborCount, distances.length))
  if (used.length > 0 && used[0].d2 <= eps * eps) {
    return trainValues[used[0].index]
  }
  let weightSum = 0
  let valueSum = 0
  for (const item of used) {
    const w = 1 / Math.pow(Math.sqrt(item.d2) + eps, power)
    weightSum += w
    valueSum += w * trainValues[item.index]
  }
  return weightSum > 0 ? valueSum / weightSum : 0
}

function dist3(x1, y1, z1, x2, y2, z2) {
  const dx = x1 - x2
  const dy = y1 - y2
  const dz = z1 - z2
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function trainKrigingModel(trainPoints, trainValues, modelName) {
  const n = trainPoints.length
  if (n < 2) return null

  const xs = trainPoints.map(p => p.x)
  const ys = trainPoints.map(p => p.y)
  const zs = trainPoints.map(p => p.z)

  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    sum += trainValues[i]
    sumSq += trainValues[i] * trainValues[i]
  }
  const mean = sum / n
  const variance = sumSq / n - mean * mean

  const pairs = new Array((n * n - n) / 2)
  let k = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++, k++) {
      const d = dist3(xs[i], ys[i], zs[i], xs[j], ys[j], zs[j])
      pairs[k] = [d, 0.5 * (trainValues[i] - trainValues[j]) ** 2]
    }
  }
  pairs.sort((a, b) => a[0] - b[0])

  const maxDistance = pairs[pairs.length - 1][0] || 1
  const modelFn = chooseModel(modelName)
  const fitted = fitVariogramGrid(pairs, modelFn, variance, maxDistance)

  // Build kriging system
  const m = n + 1
  const A = new Array(m * m).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const h = dist3(xs[i], ys[i], zs[i], xs[j], ys[j], zs[j])
      const gamma = modelFn(h, fitted.nugget, fitted.range, fitted.sill)
      A[i * m + j] = fitted.sill - gamma
    }
    A[i * m + n] = 1
    A[n * m + i] = 1
  }
  A[n * m + n] = 0

  // Add regularization
  for (let i = 0; i < n; i++) A[i * m + i] += 1e-10

  if (!matrixSolveInline(A, m)) return null

  return {
    x: xs,
    y: ys,
    z: zs,
    values: trainValues,
    n,
    nugget: fitted.nugget,
    range: fitted.range,
    sill: fitted.sill,
    modelFn,
    inv: A,
    m
  }
}

function chooseModel(name) {
  if (name === 'gaussian') {
    return (h, nugget, range, sill) => {
      if (!(h > 0)) return 0
      return nugget + (sill - nugget) * (1 - Math.exp(-3 * (h / Math.max(1e-9, range)) ** 2))
    }
  }
  if (name === 'spherical') {
    return (h, nugget, range, sill) => {
      if (!(h > 0)) return 0
      if (h >= range) return sill
      const hr = h / range
      return nugget + (sill - nugget) * (1.5 * hr - 0.5 * hr * hr * hr)
    }
  }
  return (h, nugget, range, sill) => {
    if (!(h > 0)) return 0
    return nugget + (sill - nugget) * (1 - Math.exp((-3 * h) / Math.max(1e-9, range)))
  }
}

function fitVariogramGrid(pairs, modelFn, variance, maxDistance) {
  const binCount = Math.max(6, Math.min(24, Math.round(Math.sqrt(pairs.length))))
  const binWidth = maxDistance / binCount
  const bins = Array.from({ length: binCount }, () => ({ sumD: 0, sumG: 0, cnt: 0 }))

  for (const [d, g] of pairs) {
    if (d <= 0) continue
    const idx = Math.min(binCount - 1, Math.floor(d / binWidth))
    bins[idx].sumD += d
    bins[idx].sumG += g
    bins[idx].cnt++
  }

  const empirical = bins
    .filter(b => b.cnt > 0)
    .map(b => ({ distance: b.sumD / b.cnt, gamma: b.sumG / b.cnt, count: b.cnt }))

  const maxGamma = empirical.reduce((max, r) => Math.max(max, r.gamma), 0)
  const sillBase = Math.max(variance || 1e-9, maxGamma, 1e-9)

  let best = { nugget: 0, range: maxDistance, sill: sillBase, error: Infinity }
  const ranges = [0.15, 0.3, 0.5, 0.7, 1.0].map(s => maxDistance * s)
  const sills = [0.85, 1.0, 1.2, 1.4].map(s => sillBase * s)
  const nuggets = [0, sillBase * 0.1, sillBase * 0.2, sillBase * 0.3]

  for (const sill of sills) {
    for (const nugget of nuggets) {
      if (nugget >= sill) continue
      for (const range of ranges) {
        let err = 0,
          wSum = 0
        for (const row of empirical) {
          const pred = modelFn(row.distance, nugget, range, sill)
          const w = row.count / Math.max(0.01, row.distance / range)
          err += (row.gamma - pred) ** 2 * w
          wSum += w
        }
        err = wSum > 0 ? err / wSum : Infinity
        if (err < best.error) best = { nugget, range, sill, error: err }
      }
    }
  }

  return { nugget: best.nugget, range: best.range, sill: best.sill, empirical }
}

function krigingPredict3D(x, y, z, model) {
  if (!model?.inv) return 0
  const { x: xArr, y: yArr, z: zArr, values, n, m, modelFn, nugget, range, sill } = model

  const rhs = new Array(m)
  for (let i = 0; i < n; i++) {
    const h = dist3(x, y, z, xArr[i], yArr[i], zArr[i])
    rhs[i] = sill - modelFn(h, nugget, range, sill)
  }
  rhs[n] = 1

  let sum = 0
  for (let i = 0; i < n; i++) {
    let wi = 0
    const off = i * m
    for (let j = 0; j < m; j++) {
      wi += (model.inv[off + j] || 0) * (rhs[j] || 0)
    }
    sum += wi * (values[i] || 0)
  }
  return Number.isFinite(sum) ? sum : 0
}

function matrixSolveInline(X, n) {
  const eps = 1e-12
  const m = n
  const b = new Array(n * n)
  const ipiv = new Array(n).fill(0)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i * n + j] = i === j ? 1 : 0

  for (let i = 0; i < n; i++) {
    let big = 0,
      irow = -1,
      icol = -1
    for (let j = 0; j < n; j++) {
      if (ipiv[j] === 1) continue
      for (let k = 0; k < n; k++) {
        if (ipiv[k] !== 0) continue
        const v = Math.abs(X[j * n + k])
        if (v >= big) {
          big = v
          irow = j
          icol = k
        }
      }
    }
    if (icol < 0 || irow < 0 || big <= eps) return false
    ipiv[icol]++

    if (irow !== icol) {
      for (let l = 0; l < n; l++) {
        const tmp = X[irow * n + l]
        X[irow * n + l] = X[icol * n + l]
        X[icol * n + l] = tmp
      }
      for (let l = 0; l < m; l++) {
        const tmp = b[irow * n + l]
        b[irow * n + l] = b[icol * n + l]
        b[icol * n + l] = tmp
      }
    }

    const pivot = X[icol * n + icol]
    if (Math.abs(pivot) <= eps) return false
    const pivinv = 1 / pivot
    X[icol * n + icol] = 1
    for (let l = 0; l < n; l++) X[icol * n + l] *= pivinv
    for (let l = 0; l < m; l++) b[icol * n + l] *= pivinv

    for (let ll = 0; ll < n; ll++) {
      if (ll === icol) continue
      const dum = X[ll * n + icol]
      X[ll * n + icol] = 0
      for (let l = 0; l < n; l++) X[ll * n + l] -= X[icol * n + l] * dum
      for (let l = 0; l < m; l++) b[ll * n + l] -= b[icol * n + l] * dum
    }
  }

  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) X[i * n + j] = b[i * n + j]
  return true
}

function runIDWBaseline(testPoints, trainPoints, trainValues, config = {}) {
  const t0 = performance.now()

  const power = Number.isFinite(config.power) ? config.power : 1.6
  const neighborCount = Number.isFinite(config.neighborCount)
    ? Math.max(1, config.neighborCount)
    : Math.min(24, Math.max(6, Math.round(trainPoints.length * 0.12)))
  const usePSO = config.optimizeParameters !== false && trainPoints.length >= 4

  let optimalParams = null
  let psoTiming = 0

  let finalPower = power
  let finalNeighborCount = neighborCount
  let anisotropyParams = null

  if (usePSO) {
    const psoStart = performance.now()
    const result = optimizeIDWParameters(trainPoints, trainValues, {
      particleCount: 20,
      maxIterations: 50
    })
    psoTiming = performance.now() - psoStart

    if (result.success) {
      finalPower = result.optimalParams.power
      finalNeighborCount = result.optimalParams.neighborCount
      anisotropyParams = result.optimalParams.anisotropyParams
      optimalParams = {
        power: finalPower,
        neighborCount: finalNeighborCount,
        anisotropy: anisotropyParams,
        fitness: result.fitness,
        psoTimeMs: psoTiming
      }
    }
  }

  const predictions = []
  for (const tp of testPoints) {
    predictions.push(
      anisotropyParams
        ? idwInterpolateWithAnisotropy(
            tp.x,
            tp.y,
            tp.z,
            trainPoints,
            trainValues,
            finalPower,
            finalNeighborCount,
            anisotropyParams
          )
        : idwInterpolate(tp.x, tp.y, tp.z, trainPoints, trainValues, finalPower, finalNeighborCount)
    )
  }

  const timing = performance.now() - t0

  return {
    predictions,
    timing: {
      totalMs: timing,
      psoMs: psoTiming,
      predictionMs: timing - psoTiming
    },
    params: {
      power: finalPower,
      neighborCount: finalNeighborCount,
      optimizeParameters: usePSO,
      anisotropy: anisotropyParams
    },
    optimalParams
  }
}

function runIDWDefault(testPoints, trainPoints, trainValues) {
  return runIDWBaseline(testPoints, trainPoints, trainValues, {
    power: 1.6,
    neighborCount: Math.min(24, Math.max(6, Math.round(trainPoints.length * 0.12))),
    optimizeParameters: false
  })
}

function runKriging(testPoints, trainPoints, trainValues, modelName = 'exponential') {
  const t0 = performance.now()

  const trainStart = performance.now()
  const model = trainKrigingModel(trainPoints, trainValues, modelName)
  const trainTiming = performance.now() - trainStart

  if (!model) {
    return {
      predictions: testPoints.map(() => 0),
      timing: { totalMs: performance.now() - t0, trainMs: trainTiming, predictionMs: 0 },
      failed: true,
      reason: 'kriging_system_singular'
    }
  }

  const predStart = performance.now()
  const predictions = testPoints.map(tp => krigingPredict3D(tp.x, tp.y, tp.z, model))
  const predTiming = performance.now() - predStart

  return {
    predictions,
    timing: {
      totalMs: performance.now() - t0,
      trainMs: trainTiming,
      predictionMs: predTiming
    },
    model: {
      nugget: model.nugget,
      range: model.range,
      sill: model.sill,
      modelName
    }
  }
}

export async function runFullComparison(config = {}, onProgress = null) {
  const report = (phase, detail = {}) => {
    if (typeof onProgress === 'function') onProgress({ phase, ...detail })
  }

  report('generating', { message: '正在生成合成实验数据...' })
  await delay(0)
  const dataset = generateTestDataset(config.dataGeneration || {})

  report('splitting', {
    message: `训练集: ${dataset.trainPoints.length} 点, 测试集: ${dataset.testPoints.length} 点`
  })
  await delay(0)

  report('idw_benchmark', { message: '正在运行 IDW-PSO 插值基准测试...' })
  await delay(0)
  const idwResult = runIDWBaseline(
    dataset.testPoints,
    dataset.trainPoints,
    dataset.trainValues,
    config.comparison?.idwConfig || {}
  )
  const idwMetrics = computeAllMetrics(idwResult.predictions, dataset.testTrueValues)
  const idwErrorDist = computeErrorDistribution(
    idwResult.predictions.map((p, i) => p - dataset.testTrueValues[i])
  )
  await delay(0)

  report('idw_default', { message: '正在运行 IDW 默认参数插值...' })
  await delay(0)
  const idwDefaultResult = runIDWDefault(
    dataset.testPoints,
    dataset.trainPoints,
    dataset.trainValues
  )
  const idwDefaultMetrics = computeAllMetrics(idwDefaultResult.predictions, dataset.testTrueValues)

  report('kriging_benchmark', { message: '正在运行 Kriging 插值基准测试...' })
  await delay(0)
  const krigingModels = config.comparison?.krigingModels || ['exponential']
  const krigingResults = {}

  for (const modelName of krigingModels) {
    report('kriging_benchmark', { message: `Kriging (${modelName} 模型)...` })
    await delay(0)
    const krResult = runKriging(
      dataset.testPoints,
      dataset.trainPoints,
      dataset.trainValues,
      modelName
    )
    krigingResults[modelName] = {
      ...krResult,
      metrics: computeAllMetrics(krResult.predictions, dataset.testTrueValues),
      errorDistribution: computeErrorDistribution(
        krResult.predictions.map((p, i) => p - dataset.testTrueValues[i])
      )
    }
  }

  report('computing_metrics', { message: '正在计算统计指标...' })
  await delay(0)
  const comparison = buildComparisonTable(
    idwMetrics,
    idwResult,
    idwDefaultMetrics,
    idwDefaultResult,
    krigingResults,
    dataset
  )

  report('rendering_heatmaps', { message: '正在生成热力图快照...' })
  await delay(0)
  const gridRes = config.comparison?.gridResolution || 36
  const heatmapSnapshots = generateHeatmapSnapshots(
    dataset,
    {
      power: idwResult.params.power,
      neighborCount: idwResult.params.neighborCount,
      optimized: true
    },
    krigingModels,
    gridRes
  )
  const globalRange = computeGlobalRange(heatmapSnapshots)
  const heatmapImages = renderSnapshotImages(
    heatmapSnapshots,
    globalRange.min,
    globalRange.max,
    dataset.fieldSize
  )

  let diffImage = null
  if (heatmapSnapshots.length >= 2) {
    diffImage = renderDifferenceImage(
      heatmapSnapshots[0],
      heatmapSnapshots[1],
      globalRange,
      dataset.fieldSize
    )
  }

  report('done', { message: '实验完成' })

  return {
    dataset: {
      trainCount: dataset.trainPoints.length,
      testCount: dataset.testPoints.length,
      fieldSize: dataset.fieldSize,
      globalMax: dataset.globalMax,
      noiseLevel: dataset.config.noiseLevel,
      anomalyCount: dataset.config.anomalyCount
    },
    idw: {
      metrics: idwMetrics,
      timing: idwResult.timing,
      params: idwResult.params,
      optimalParams: idwResult.optimalParams,
      errorDistribution: idwErrorDist
    },
    idwDefault: {
      metrics: idwDefaultMetrics,
      timing: idwDefaultResult.timing
    },
    kriging: krigingResults,
    comparison,
    heatmap: {
      images: heatmapImages,
      diffImage,
      globalRange,
      fieldSize: dataset.fieldSize
    },
    timestamp: new Date().toISOString()
  }
}

function buildComparisonTable(
  idwMetrics,
  idwResult,
  idwDefaultMetrics,
  idwDefaultResult,
  krigingResults,
  dataset
) {
  const rows = []

  const idwRow = {
    method: 'IDW-PSO',
    key: 'idw_optimized',
    metrics: idwMetrics,
    timing: idwResult.timing,
    params: {
      power: idwResult.params.power,
      neighborCount: idwResult.params.neighborCount
    }
  }
  rows.push(idwRow)

  const idwDefRow = {
    method: 'IDW（默认参数）',
    key: 'idw_default',
    metrics: idwDefaultMetrics,
    timing: idwDefaultResult.timing,
    params: { power: 1.6, neighborCount: 'auto' }
  }
  rows.push(idwDefRow)

  for (const [modelName, kr] of Object.entries(krigingResults)) {
    const modelLabel =
      modelName === 'exponential'
        ? '指数模型'
        : modelName === 'gaussian'
          ? '高斯模型'
          : modelName === 'spherical'
            ? '球状模型'
            : modelName

    rows.push({
      method: `Kriging（${modelLabel}）`,
      key: `kriging_${modelName}`,
      metrics: kr.metrics,
      timing: kr.timing,
      modelInfo: {
        model: modelName,
        nugget: kr.model?.nugget,
        range: kr.model?.range,
        sill: kr.model?.sill
      }
    })
  }

  if (rows.length >= 2) {
    const best = rows.reduce((a, b) =>
      (a.metrics.rmse || Infinity) < (b.metrics.rmse || Infinity) ? a : b
    )
    const worst = rows.reduce((a, b) =>
      (a.metrics.rmse || -Infinity) > (b.metrics.rmse || -Infinity) ? a : b
    )

    return {
      rows,
      summary: {
        bestMethod: best.method,
        bestRMSE: best.metrics.rmse,
        worstMethod: worst.method,
        worstRMSE: worst.metrics.rmse,
        totalMethods: rows.length,
        datasetInfo: {
          trainCount: dataset.trainPoints.length,
          testCount: dataset.testPoints.length,
          noiseLevel: dataset.config.noiseLevel
        }
      }
    }
  }

  return { rows, summary: null }
}

export async function runRepeatedComparison(config = {}, repeatCount = 3, onProgress = null) {
  const allResults = []
  let latestResult = null

  const report = (phase, detail = {}) => {
    if (typeof onProgress === 'function') onProgress({ phase, ...detail })
  }

  for (let i = 0; i < repeatCount; i++) {
    report('repeat', {
      message: `第 ${i + 1}/${repeatCount} 轮实验...`,
      current: i + 1,
      total: repeatCount
    })

    const modifiedConfig = JSON.parse(JSON.stringify(config))
    if (modifiedConfig.dataGeneration) {
      modifiedConfig.dataGeneration.seed = (config.dataGeneration?.seed || 2026) + i * 100
    }

    const result = await runFullComparison(modifiedConfig, null)
    allResults.push(result)
    latestResult = result
  }

  const aggregated = {
    idw_optimized: aggregateRepeatResults(
      allResults.map(r => ({
        metrics: r.idw.metrics,
        timing: r.idw.timing,
        method: 'idw_optimized'
      }))
    ),
    idw_default: aggregateRepeatResults(
      allResults.map(r => ({
        metrics: r.idwDefault.metrics,
        timing: r.idwDefault.timing,
        method: 'idw_default'
      }))
    )
  }

  const krigingKeys = Object.keys(latestResult?.kriging || {})
  for (const key of krigingKeys) {
    aggregated[`kriging_${key}`] = aggregateRepeatResults(
      allResults.map(r => ({
        metrics: r.kriging[key]?.metrics,
        timing: r.kriging[key]?.timing,
        method: `kriging_${key}`
      }))
    )
  }

  return {
    singleResult: latestResult,
    repeatCount,
    aggregated,
    allResults
  }
}

export function runGridPrecisionComparison(dataset, config = {}) {
  const gridResolution = config.gridResolution || 48
  const fieldSize = dataset.fieldSize

  const groundTruth = generateGridGroundTruth(dataset.fieldFn, fieldSize, gridResolution)

  const idwPower = 2.0
  const idwNeighbors = Math.min(32, Math.max(8, Math.round(dataset.trainPoints.length * 0.15)))

  const t0 = performance.now()
  const krigingModel = trainKrigingModel(dataset.trainPoints, dataset.trainValues, 'exponential')
  const krigingTrainTime = performance.now() - t0

  const totalCells = groundTruth.grid.width * groundTruth.grid.height * groundTruth.grid.depth
  const idwPreds = new Float32Array(totalCells)
  const krPreds = new Float32Array(totalCells)

  const t1 = performance.now()
  let idx = 0
  for (let k = 0; k < groundTruth.grid.depth; k++) {
    for (let j = 0; j < groundTruth.grid.height; j++) {
      for (let i = 0; i < groundTruth.grid.width; i++) {
        const x = groundTruth.xs[i]
        const y = groundTruth.ys[j]
        const z = groundTruth.zs[k]

        idwPreds[idx] = idwInterpolate(
          x,
          y,
          z,
          dataset.trainPoints,
          dataset.trainValues,
          idwPower,
          idwNeighbors
        )

        krPreds[idx] = krigingModel ? krigingPredict3D(x, y, z, krigingModel) : 0

        idx++
      }
    }
  }
  const predTime = performance.now() - t1

  const idwGridMetrics = computeAllMetrics(idwPreds, groundTruth.values)
  const krGridMetrics = computeAllMetrics(krPreds, groundTruth.values)

  const idwErrors = []
  const krErrors = []
  for (let i = 0; i < totalCells; i++) {
    idwErrors.push(idwPreds[i] - groundTruth.values[i])
    krErrors.push(krPreds[i] - groundTruth.values[i])
  }

  return {
    grid: groundTruth.grid,
    timing: {
      krigingTrainMs: krigingTrainTime,
      predictionTotalMs: predTime
    },
    idw: {
      metrics: idwGridMetrics,
      errorDistribution: computeErrorDistribution(idwErrors),
      params: { power: idwPower, neighborCount: idwNeighbors }
    },
    kriging: {
      metrics: krGridMetrics,
      errorDistribution: computeErrorDistribution(krErrors),
      variogram: krigingModel
        ? {
            nugget: krigingModel.nugget,
            range: krigingModel.range,
            sill: krigingModel.sill
          }
        : null
    }
  }
}

export { formatTimingMs }
