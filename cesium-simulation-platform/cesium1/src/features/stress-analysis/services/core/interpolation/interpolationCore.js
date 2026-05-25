import { computeValueRange } from '../computation/index.js'
import { resolvePointOffset } from '../shared/stressActionShared.js'
import { resolveMetricFixedRange } from '../safety/index.js'
import {
  optimizeIDWParameters,
  createPointSpatialIndex,
  selectInterpolationPoints,
  resolveAdaptiveIdwPower
} from './idwCore.js'
import { computeAnisotropicDistanceSquared } from './config.js'
import {
  buildGridPositions,
  POINT_INTERPOLATION_CONSTANTS,
  createInterpolationProgressReporter,
  createValueTracker,
  resolveAnisotropyParams,
  resolveDefaultKrigingFitMode,
  resolveIdwRuntimeParams,
  resolveInterpolationGrid,
  resolveInterpolationMethod,
  resolveInterpolationPointLimit,
  resolveOptimizationConfig
} from './pointInterpolationConfig.js'

/**
 * 插值引擎门面（Facade）。
 * 这里继续保留稳定入口语义，但真实实现已经与核心算法收束到同一文件。
 */
export function createInterpolationEngine(deps) {
  return createInterpolationManager(deps)
}

function matrixSolve(X, n, eps = 1e-12) {
  const m = n
  const b = new Array(n * n)
  const indxc = new Array(n)
  const indxr = new Array(n)
  const ipiv = new Array(n)

  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i * n + j] = i === j ? 1 : 0
  for (let j = 0; j < n; j++) ipiv[j] = 0

  for (let i = 0; i < n; i++) {
    let big = 0
    let irow = -1
    let icol = -1
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
    ipiv[icol] += 1

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

    indxr[i] = irow
    indxc[i] = icol

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

  for (let l = n - 1; l >= 0; l--) {
    if (indxr[l] === indxc[l]) continue
    for (let k = 0; k < n; k++) {
      const tmp = X[k * n + indxr[l]]
      X[k * n + indxr[l]] = X[k * n + indxc[l]]
      X[k * n + indxc[l]] = tmp
    }
  }

  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) X[i * n + j] = b[i * n + j]
  return true
}

function variogramGaussian(h, nugget, range, sill) {
  if (!(h > 0)) return 0
  const r = Math.max(1e-9, Number(range) || 0)
  const hr = Number(h) / r
  return nugget + (sill - nugget) * (1 - Math.exp(-3 * hr * hr))
}

function variogramExponential(h, nugget, range, sill) {
  if (!(h > 0)) return 0
  const r = Math.max(1e-9, Number(range) || 0)
  const hr = Number(h) / r
  return nugget + (sill - nugget) * (1 - Math.exp(-3 * hr))
}

function variogramSpherical(h, nugget, range, sill) {
  const r = Math.max(1e-9, Number(range) || 0)
  if (!(h > 0)) return 0
  if (h >= r) return sill
  const hr = h / r
  return nugget + (sill - nugget) * (1.5 * hr - 0.5 * hr * hr * hr)
}

function dist3(x1, y1, z1, x2, y2, z2) {
  const dx = x1 - x2
  const dy = y1 - y2
  const dz = z1 - z2
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function solveLinearSystem(matrix, rhs, size) {
  const A = matrix.slice()
  const b = rhs.slice()
  const eps = 1e-10
  for (let col = 0; col < size; col++) {
    let pivotRow = col
    let pivotValue = Math.abs(A[col * size + col] || 0)
    for (let row = col + 1; row < size; row++) {
      const value = Math.abs(A[row * size + col] || 0)
      if (value > pivotValue) {
        pivotValue = value
        pivotRow = row
      }
    }
    if (pivotValue <= eps) return null
    if (pivotRow !== col) {
      for (let k = col; k < size; k++) {
        ;[A[col * size + k], A[pivotRow * size + k]] = [A[pivotRow * size + k], A[col * size + k]]
      }
      ;[b[col], b[pivotRow]] = [b[pivotRow], b[col]]
    }

    const pivot = A[col * size + col]
    for (let k = col; k < size; k++) A[col * size + k] /= pivot
    b[col] /= pivot

    for (let row = 0; row < size; row++) {
      if (row === col) continue
      const factor = A[row * size + col]
      if (Math.abs(factor) <= eps) continue
      for (let k = col; k < size; k++) A[row * size + k] -= factor * A[col * size + k]
      b[row] -= factor * b[col]
    }
  }
  return b
}

function buildTrendBasis3D(x, y, z, center, order) {
  const dx = (Number(x) || 0) - (center?.x || 0)
  const dy = (Number(y) || 0) - (center?.y || 0)
  const dz = (Number(z) || 0) - (center?.z || 0)
  if (order >= 2) {
    return [1, dx, dy, dz, dx * dx, dy * dy, dz * dz, dx * dy, dx * dz, dy * dz]
  }
  return [1, dx, dy, dz]
}

function fitLinearTrend3D(points, values, { robust = true, maxIter = 3 } = {}) {
  const n = Math.min(points.length, values.length)
  if (n < 4) return null

  let mx = 0
  let my = 0
  let mz = 0
  for (let i = 0; i < n; i++) {
    mx += Number(points[i].x) || 0
    my += Number(points[i].y) || 0
    mz += Number(points[i].z) || 0
  }
  mx /= n
  my /= n
  mz /= n

  const order = n >= 30 ? 2 : 1
  const basisSize = order >= 2 ? 10 : 4
  const center = { x: mx, y: my, z: mz }

  const allBasis = new Array(n)
  for (let i = 0; i < n; i++) {
    allBasis[i] = buildTrendBasis3D(points[i].x, points[i].y, points[i].z, center, order)
  }

  function solveWeighted(weights) {
    const xtx = new Array(basisSize * basisSize).fill(0)
    const xty = new Array(basisSize).fill(0)
    for (let i = 0; i < n; i++) {
      const w = weights ? (Number.isFinite(weights[i]) ? weights[i] : 1) : 1
      const basis = allBasis[i]
      const value = Number(values[i]) || 0
      for (let r = 0; r < basisSize; r++) {
        xty[r] += basis[r] * value * w
        for (let c = 0; c < basisSize; c++) xtx[r * basisSize + c] += basis[r] * basis[c] * w
      }
    }
    for (let i = 0; i < basisSize; i++) xtx[i * basisSize + i] += 1e-8
    return solveLinearSystem(xtx, xty, basisSize)
  }

  // 初次 OLS 拟合
  let coeffs = solveWeighted(null)
  if (!coeffs) return null

  if (!robust || n < 8) {
    return { center, coeffs, order }
  }

  // IRLS: 使用 Huber 权重迭代降权异常点
  for (let iter = 0; iter < maxIter; iter++) {
    const residuals = new Array(n)
    let absResiduals = new Array(n)
    for (let i = 0; i < n; i++) {
      const predicted = allBasis[i].reduce((sum, b, j) => sum + b * coeffs[j], 0)
      residuals[i] = Number(values[i]) - predicted
      absResiduals[i] = Math.abs(residuals[i])
    }
    absResiduals.sort((a, b) => a - b)
    const mad = absResiduals[Math.floor(n / 2)]
    const scale = Math.max(1e-10, mad * 1.4826) // MAD → σ 估计

    let maxWeightChange = 0
    const weights = new Array(n)
    for (let i = 0; i < n; i++) {
      const r = Math.abs(residuals[i]) / scale
      // Huber 权重: k=2.5 适配应力场（高峰值往往是真实特征而非异常）
      const huberK = 2.5
      const newW = r <= huberK ? 1 : huberK / r
      // 跟踪权重变化以判断收敛
      maxWeightChange = Math.max(maxWeightChange, Math.abs(newW - 1))
      weights[i] = newW
    }

    const newCoeffs = solveWeighted(weights)
    if (!newCoeffs) break
    coeffs = newCoeffs

    if (maxWeightChange < 0.03) break
  }

  return { center, coeffs, order }
}

function evaluateLinearTrend3D(trend, x, y, z) {
  if (!trend?.coeffs) return 0
  const basis = buildTrendBasis3D(x, y, z, trend.center, trend.order || 1)
  let result = 0
  for (let i = 0; i < basis.length; i++) result += (trend.coeffs[i] || 0) * basis[i]
  return result
}

function buildEmpiricalSemivariogram(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 1) return []
  const maxDistance = Number(pairs[pairs.length - 1]?.[0]) || 0
  if (!(maxDistance > 0)) return []
  const usablePairs = pairs.filter(
    pair => Number(pair?.[0]) > 0 && Number.isFinite(Number(pair?.[1]))
  )
  if (usablePairs.length < 1) return []
  const binCount = Math.max(6, Math.min(24, Math.round(Math.sqrt(usablePairs.length))))
  const binWidth = maxDistance / binCount
  if (!(binWidth > 0)) return []
  const bins = Array.from({ length: binCount }, () => ({ sumDistance: 0, sumGamma: 0, count: 0 }))
  for (let i = 0; i < usablePairs.length; i++) {
    const pair = usablePairs[i]
    const distance = Number(pair[0]) || 0
    const gamma = Number(pair[1]) || 0
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(distance / binWidth)))
    const bin = bins[index]
    bin.sumDistance += distance
    bin.sumGamma += gamma
    bin.count += 1
  }
  return bins
    .filter(bin => bin.count > 0)
    .map(bin => ({
      distance: bin.sumDistance / bin.count,
      gamma: bin.sumGamma / bin.count,
      count: bin.count
    }))
}

function computeVariogramFitError(empirical, model, nugget, range, sill) {
  if (!Array.isArray(empirical) || empirical.length < 1) return Number.POSITIVE_INFINITY
  let error = 0
  let weightSum = 0
  for (let i = 0; i < empirical.length; i++) {
    const row = empirical[i]
    const observed = Number(row?.gamma)
    const distance = Number(row?.distance)
    if (!Number.isFinite(observed) || !(distance > 0)) continue
    const predicted = model(distance, nugget, range, sill)
    const weight =
      Math.max(1, Number(row?.count) || 1) / Math.max(1e-6, distance / Math.max(range, 1e-6))
    const diff = observed - predicted
    error += diff * diff * weight
    weightSum += weight
  }
  if (!(weightSum > 0)) return Number.POSITIVE_INFINITY
  return error / weightSum
}

function uniquePositiveCandidates(values, fallback) {
  const out = []
  const push = value => {
    const n = Number(value)
    if (!(n > 0) || !Number.isFinite(n)) return
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i] - n) <= Math.max(1e-9, Math.abs(n) * 1e-6)) return
    }
    out.push(n)
  }
  for (let i = 0; i < values.length; i++) push(values[i])
  if (out.length < 1) push(fallback)
  return out
}

function fitVariogramParameters(pairs, model, variance, maxDistance) {
  const empirical = buildEmpiricalSemivariogram(pairs)
  const maxGamma = empirical.reduce((acc, row) => Math.max(acc, Number(row?.gamma) || 0), 0)
  const firstGamma = Number(empirical[0]?.gamma) || 0
  const baseSill = Math.max(1e-9, Number(variance) || 0, maxGamma)
  const sillBase = Math.max(baseSill, firstGamma + 1e-9)
  const nuggetUpper = Math.max(
    0,
    Math.min(sillBase * 0.22, firstGamma > 0 ? firstGamma * 1.15 : sillBase * 0.08)
  )
  const rangeCandidates = uniquePositiveCandidates(
    [0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1.0].map(scale => maxDistance * scale),
    maxDistance * 0.5
  )
  const sillCandidates = uniquePositiveCandidates(
    [0.8, 0.9, 1.0, 1.1, 1.25].map(scale => sillBase * scale),
    sillBase
  )
  const nuggetCandidates = [
    0,
    nuggetUpper * 0.2,
    nuggetUpper * 0.45,
    nuggetUpper * 0.7,
    nuggetUpper
  ]
    .map(value => Math.max(0, Math.min(value, sillBase * 0.3)))
    .filter(value => Number.isFinite(value))

  let best = {
    nugget: 0,
    range: Math.max(1e-9, maxDistance),
    sill: sillBase,
    fitError: Number.POSITIVE_INFINITY
  }

  for (let si = 0; si < sillCandidates.length; si++) {
    const sill = Math.max(1e-9, sillCandidates[si])
    for (let ni = 0; ni < nuggetCandidates.length; ni++) {
      const nugget = Math.max(0, Math.min(nuggetCandidates[ni], sill - 1e-9))
      for (let ri = 0; ri < rangeCandidates.length; ri++) {
        const range = Math.max(1e-9, rangeCandidates[ri])
        const fitError = computeVariogramFitError(empirical, model, nugget, range, sill)
        if (fitError < best.fitError) best = { nugget, range, sill, fitError }
      }
    }
  }

  if (!Number.isFinite(best.fitError)) {
    best.fitError = 0
  } else {
    const refinedSills = uniquePositiveCandidates(
      [0.9, 1, 1.1].map(scale => best.sill * scale),
      best.sill
    )
    const refinedRanges = uniquePositiveCandidates(
      [0.85, 1, 1.15].map(scale => best.range * scale),
      best.range
    )
    const refinedNuggets = [0.5, 0.75, 1, 1.25].map(scale =>
      Math.max(0, Math.min(best.nugget * scale, best.sill * 0.45))
    )
    for (let si = 0; si < refinedSills.length; si++) {
      const sill = Math.max(1e-9, refinedSills[si])
      for (let ni = 0; ni < refinedNuggets.length; ni++) {
        const nugget = Math.max(0, Math.min(refinedNuggets[ni], sill - 1e-9))
        for (let ri = 0; ri < refinedRanges.length; ri++) {
          const range = Math.max(1e-9, refinedRanges[ri])
          const fitError = computeVariogramFitError(empirical, model, nugget, range, sill)
          if (fitError < best.fitError) best = { nugget, range, sill, fitError }
        }
      }
    }
  }

  return {
    nugget: best.nugget,
    range: best.range,
    sill: best.sill,
    fitError: best.fitError,
    empirical
  }
}

function pickModel(name) {
  const m = String(name || 'exponential')
  if (m === 'gaussian') return variogramGaussian
  if (m === 'spherical') return variogramSpherical
  return variogramExponential
}

export function train3D(t, x, y, z, modelName, sigma2) {
  const values = Array.isArray(t) ? t.map(Number) : []
  const xs = Array.isArray(x) ? x.map(Number) : []
  const ys = Array.isArray(y) ? y.map(Number) : []
  const zs = Array.isArray(z) ? z.map(Number) : []
  const n = values.length
  if (!(n > 0 && xs.length === n && ys.length === n && zs.length === n)) {
    return null
  }

  const variogram = {
    t: values,
    x: xs,
    y: ys,
    z: zs,
    nugget: 0,
    range: 0,
    sill: 0,
    n: 0,
    model: pickModel(modelName),
    K: null,
    M: null,
    status: 'init',
    reason: '',
    krigMatrix: null,
    krigMatrixInv: null,
    fitError: null,
    empirical: [],
    trend: null
  }

  if (n < 2) {
    variogram.status = 'degraded'
    variogram.reason = 'insufficient_points'
    return variogram
  }

  let sum = 0
  let sumSq = 0
  const pointRows = new Array(n)
  for (let i = 0; i < n; i++) {
    pointRows[i] = { x: xs[i], y: ys[i], z: zs[i] }
  }
  const trend = fitLinearTrend3D(pointRows, values)
  variogram.trend = trend
  const residualValues = trend
    ? values.map(
        (value, index) => value - evaluateLinearTrend3D(trend, xs[index], ys[index], zs[index])
      )
    : values.slice()

  for (let i = 0; i < n; i++) {
    sum += residualValues[i]
    sumSq += residualValues[i] * residualValues[i]
  }
  const mean = sum / n
  const variance = sumSq / n - mean * mean

  const pairs = new Array((n * n - n) / 2)
  let k = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++, k++) {
      const d = dist3(xs[i], ys[i], zs[i], xs[j], ys[j], zs[j])
      const dz = residualValues[i] - residualValues[j]
      pairs[k] = [d, 0.5 * dz * dz]
    }
  }
  pairs.sort((a, b) => a[0] - b[0])

  // 鲁棒过滤：剔除残差平方差异过大的点对（通常由异常训练点引起）
  // 使用 95th 分位数作为上界，防止异常点对污染变异函数估计
  if (pairs.length >= 30) {
    const gammaValues = pairs.map(p => p[1])
    gammaValues.sort((a, b) => a - b)
    const gammaP95 = gammaValues[Math.floor(gammaValues.length * 0.95)]
    const gammaThreshold = Math.max(gammaP95, gammaValues[0] * 10)
    const filteredPairs = pairs.filter(p => p[1] <= gammaThreshold)
    if (filteredPairs.length >= Math.max(10, pairs.length * 0.6)) {
      pairs.length = 0
      for (let i = 0; i < filteredPairs.length; i++) pairs.push(filteredPairs[i])
    }
  }

  const maxDistance = pairs[pairs.length - 1][0] || 1
  variogram.range = maxDistance
  if (!(variogram.range > 0)) {
    variogram.status = 'degraded'
    variogram.reason = 'zero_range'
    return variogram
  }

  const fitted = fitVariogramParameters(pairs, variogram.model, variance, maxDistance)
  variogram.nugget = Math.max(0, Number(fitted?.nugget) || 0)
  variogram.range = Math.max(1e-9, Number(fitted?.range) || maxDistance)
  variogram.sill = Math.max(1e-9, Number(fitted?.sill) || variance || 1e-9)
  variogram.fitError = Number.isFinite(Number(fitted?.fitError)) ? Number(fitted.fitError) : null
  variogram.empirical = Array.isArray(fitted?.empirical) ? fitted.empirical : []

  const nn = xs.length
  const m = nn + 1
  const A = new Array(m * m).fill(0)

  for (let i = 0; i < nn; i++) {
    for (let j = 0; j < nn; j++) {
      const h = dist3(xs[i], ys[i], zs[i], xs[j], ys[j], zs[j])
      const gamma = variogram.model(h, variogram.nugget, variogram.range, variogram.sill)
      const cov = variogram.sill - gamma
      A[i * m + j] = cov
    }
    A[i * m + nn] = 1
    A[nn * m + i] = 1
  }
  A[nn * m + nn] = 0

  const reg = Number.isFinite(Number(sigma2)) ? Number(sigma2) : 1e-10
  for (let i = 0; i < nn; i++) {
    A[i * m + i] += reg
  }

  const A0 = A.slice(0)
  if (!matrixSolve(A0, m)) {
    variogram.status = 'degraded'
    variogram.reason = 'ordinary_system_singular'
    return variogram
  }

  variogram.n = nn
  variogram.krigMatrix = A
  variogram.krigMatrixInv = A0
  variogram.M = residualValues.slice(0)
  variogram.status = 'ok'
  variogram.reason = ''
  return variogram
}

export function setValues(variogram, t) {
  if (!variogram?.krigMatrixInv || !Number.isInteger(variogram?.n) || variogram.n <= 0) return false
  const n = variogram.n
  const values = Array.isArray(t) ? t.map(Number) : []
  if (values.length !== n) return false
  variogram.t = values
  if (variogram.trend) {
    const pointRows = new Array(n)
    for (let i = 0; i < n; i++) {
      pointRows[i] = {
        x: variogram.x[i],
        y: variogram.y[i],
        z: variogram.z[i]
      }
    }
    const updatedTrend = fitLinearTrend3D(pointRows, values)
    if (updatedTrend) variogram.trend = updatedTrend
  }
  variogram.M = variogram.trend
    ? values.map(
        (value, index) =>
          value -
          evaluateLinearTrend3D(
            variogram.trend,
            variogram.x[index],
            variogram.y[index],
            variogram.z[index]
          )
      )
    : values.slice(0)
  return true
}

export function predict3D(x, y, z, variogram, clampRange) {
  return predict3DWithScratch(x, y, z, variogram, null, clampRange)
}

export function predict3DWithScratch(x, y, z, variogram, rhsScratch, clampRange) {
  const v = variogram
  if (!v || !v.M || !v.krigMatrixInv || !Number.isInteger(v.n) || v.n <= 0) return 0
  const n = v.n
  const m = n + 1

  const rhs = Array.isArray(rhsScratch) && rhsScratch.length >= m ? rhsScratch : new Array(m)
  fillKrigingRightHandSide(rhs, x, y, z, v)

  const inv = v.krigMatrixInv
  const values = v.M
  let sum = 0
  for (let i = 0; i < n; i++) {
    let wi = 0
    const rowOffset = i * m
    for (let j = 0; j < m; j++) wi += (Number(inv[rowOffset + j]) || 0) * (Number(rhs[j]) || 0)
    sum += wi * (Number(values[i]) || 0)
  }
  let predicted = sum + evaluateLinearTrend3D(v.trend, x, y, z)
  if (!Number.isFinite(predicted)) predicted = 0
  if (clampRange && Array.isArray(clampRange) && clampRange.length === 2) {
    const margin = Math.max(0.01, (clampRange[1] - clampRange[0]) * 0.15)
    predicted = Math.max(clampRange[0] - margin, Math.min(clampRange[1] + margin, predicted))
  }
  return predicted
}

/**
 * 克里金预测 + 估计方差
 *
 * σ²_K(x₀) = C(0) - Σᵢ λᵢ·C(x₀, xᵢ) - μ
 *           = sill - Σᵢ λᵢ·(sill - γ(hᵢ)) - μ
 *
 * 其中 λᵢ 为克里金权重，μ 为拉格朗日乘子
 *
 * @returns {{ value: number, variance: number }}
 */
export function predict3DWithVariance(x, y, z, variogram, clampRange) {
  const v = variogram
  if (!v || !v.M || !v.krigMatrixInv || !Number.isInteger(v.n) || v.n <= 0) {
    return { value: 0, variance: NaN }
  }
  const n = v.n
  const m = n + 1
  const sill = Number(v.sill) || 1

  const rhs = new Array(m)
  fillKrigingRightHandSide(rhs, x, y, z, v)

  const inv = v.krigMatrixInv
  const values = v.M

  let sum = 0
  const weights = new Array(n)
  for (let i = 0; i < n; i++) {
    let wi = 0
    const rowOffset = i * m
    for (let j = 0; j < m; j++) wi += (Number(inv[rowOffset + j]) || 0) * (Number(rhs[j]) || 0)
    weights[i] = wi
    sum += wi * (Number(values[i]) || 0)
  }

  // 拉格朗日乘子
  let mu = 0
  const lastRowOff = n * m
  for (let j = 0; j < m; j++) mu += (Number(inv[lastRowOff + j]) || 0) * (Number(rhs[j]) || 0)

  // 克里金方差: σ²_K = sill - Σ λᵢ·C(x₀, xᵢ) - μ
  let covSum = 0
  for (let i = 0; i < n; i++) {
    // C(hᵢ) = sill - γ(hᵢ) = rhs[i] (rhs 中已预计算)
    covSum += weights[i] * (Number(rhs[i]) || 0)
  }
  let variance = sill - covSum - mu
  if (!Number.isFinite(variance) || variance < 0) variance = 0

  let predicted = sum + evaluateLinearTrend3D(v.trend, x, y, z)
  if (!Number.isFinite(predicted)) predicted = 0
  if (clampRange && Array.isArray(clampRange) && clampRange.length === 2) {
    const margin = Math.max(0.01, (clampRange[1] - clampRange[0]) * 0.15)
    predicted = Math.max(clampRange[0] - margin, Math.min(clampRange[1] + margin, predicted))
  }
  return { value: predicted, variance }
}

function fillKrigingRightHandSide(rhs, x, y, z, variogram) {
  const v = variogram
  const n = v.n
  for (let i = 0; i < n; i++) {
    const h = dist3(x, y, z, v.x[i], v.y[i], v.z[i])
    const gamma = v.model(h, v.nugget, v.range, v.sill)
    rhs[i] = v.sill - gamma
  }
  rhs[n] = 1
  return rhs
}

/**
 * 在排序数组中查找最接近目标值的索引（二分查找）
 * @param {Float32Array|Array} arr - 已排序的数组
 * @param {number} target - 目标值
 * @returns {number} 最接近的索引
 */
function findInterpolationInterval(arr, target) {
  if (!arr || arr.length === 0) return { lo: 0, hi: 0, frac: 0 }
  if (arr.length === 1) return { lo: 0, hi: 0, frac: 0 }
  let left = 0
  let right = arr.length - 1
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    if (arr[mid] < target) {
      left = mid + 1
    } else {
      right = mid
    }
  }
  const lo = Math.max(0, left - 1)
  const hi = Math.min(arr.length - 1, left)
  const span = arr[hi] - arr[lo]
  const frac = span > 1e-12 ? Math.max(0, Math.min(1, (target - arr[lo]) / span)) : 0
  return { lo, hi, frac }
}

function buildPointInterpolationStencil(point, grid, xs, ys, zs) {
  if (!point || !Number.isFinite(point.x)) return null
  const ix = findInterpolationInterval(xs, point.x)
  const iy = findInterpolationInterval(ys, point.y)
  const iz = findInterpolationInterval(zs, point.z)
  const w = grid.width
  const h = grid.height
  const toIdx = (xi, yi, zi) => zi * h * w + yi * w + xi

  const fx = ix.frac
  const fy = iy.frac
  const fz = iz.frac
  const nodes = [
    { idx: toIdx(ix.lo, iy.lo, iz.lo), weight: (1 - fx) * (1 - fy) * (1 - fz) },
    { idx: toIdx(ix.hi, iy.lo, iz.lo), weight: fx * (1 - fy) * (1 - fz) },
    { idx: toIdx(ix.lo, iy.hi, iz.lo), weight: (1 - fx) * fy * (1 - fz) },
    { idx: toIdx(ix.hi, iy.hi, iz.lo), weight: fx * fy * (1 - fz) },
    { idx: toIdx(ix.lo, iy.lo, iz.hi), weight: (1 - fx) * (1 - fy) * fz },
    { idx: toIdx(ix.hi, iy.lo, iz.hi), weight: fx * (1 - fy) * fz },
    { idx: toIdx(ix.lo, iy.hi, iz.hi), weight: (1 - fx) * fy * fz },
    { idx: toIdx(ix.hi, iy.hi, iz.hi), weight: fx * fy * fz }
  ]
  let weightSquareSum = 0
  for (let i = 0; i < nodes.length; i++) weightSquareSum += nodes[i].weight * nodes[i].weight
  return { nodes, weightSquareSum }
}

function sampleFrameAtStencil(values, stencil) {
  if (!values || !stencil?.nodes?.length) return Number.NaN
  let sampled = 0
  for (let i = 0; i < stencil.nodes.length; i++) {
    const node = stencil.nodes[i]
    sampled += (Number(values[node.idx]) || 0) * node.weight
  }
  return sampled
}

function enforceExactPointValues(framesOut, localPoints, allSeries, grid, xs, ys, zs) {
  if (!framesOut || framesOut.length === 0) return
  if (!localPoints || localPoints.length === 0) return
  if (!allSeries || allSeries.length === 0) return

  const frameCount = framesOut.length
  const stencils = new Array(localPoints.length)
  for (let pi = 0; pi < localPoints.length; pi++) {
    stencils[pi] = buildPointInterpolationStencil(localPoints[pi], grid, xs, ys, zs)
  }
  const maxIterations = Math.min(4, Math.max(2, Number(localPoints.length > 24 ? 3 : 2)))
  const tolerance = 1e-5

  for (let ti = 0; ti < frameCount; ti++) {
    const frameValues = framesOut[ti]?.values
    if (!(Array.isArray(frameValues) || ArrayBuffer.isView(frameValues))) continue
    for (let iter = 0; iter < maxIterations; iter++) {
      let maxError = 0
      for (let pi = 0; pi < localPoints.length; pi++) {
        const stencil = stencils[pi]
        if (!stencil || !(stencil.weightSquareSum > 1e-12)) continue
        const series = allSeries[pi]
        if (!series || ti >= series.length) continue
        const exactValue = Number(series[ti])
        if (!Number.isFinite(exactValue)) continue
        const sampled = sampleFrameAtStencil(frameValues, stencil)
        if (!Number.isFinite(sampled)) continue
        const delta = exactValue - sampled
        const absError = Math.abs(delta)
        if (absError > maxError) maxError = absError
        if (absError <= tolerance) continue
        const scale = delta / stencil.weightSquareSum
        for (let ni = 0; ni < stencil.nodes.length; ni++) {
          const node = stencil.nodes[ni]
          frameValues[node.idx] = (Number(frameValues[node.idx]) || 0) + node.weight * scale
        }
      }
      if (maxError <= tolerance) break
    }
  }
}

/**
 * 验证原始应力点位置的插值精度
 * 用于调试，检查 enforceExactPointValues 的效果
 *
 * @param {Array} framesOut - 输出帧数组
 * @param {Array} localPoints - 本地坐标点数组
 * @param {Array} allSeries - 所有时间序列数据
 * @param {Object} grid - 网格配置
 * @param {Float32Array} xs - X轴网格位置
 * @param {Float32Array} ys - Y轴网格位置
 * @param {Float32Array} zs - Z轴网格位置
 * @returns {Object} 验证统计信息
 */
function validateExactPointValues(framesOut, localPoints, allSeries, grid, xs, ys, zs) {
  if (!framesOut || framesOut.length === 0) return { valid: false, reason: 'no_frames' }
  if (!localPoints || localPoints.length === 0) return { valid: false, reason: 'no_points' }

  const frameCount = framesOut.length
  let maxError = 0
  let totalError = 0
  let checkCount = 0
  const errors = []

  for (let pi = 0; pi < Math.min(localPoints.length, 5); pi++) {
    const point = localPoints[pi]
    if (!point || !Number.isFinite(point.x)) continue

    const stencil = buildPointInterpolationStencil(point, grid, xs, ys, zs)
    if (!stencil) continue

    for (let ti = 0; ti < Math.min(frameCount, 3); ti++) {
      const series = allSeries[pi]
      if (!series || ti >= series.length) continue

      const exactValue = Number(series[ti])
      if (!Number.isFinite(exactValue)) continue

      const vals = framesOut[ti].values
      const interpolatedValue = sampleFrameAtStencil(vals, stencil)

      const error = Math.abs(interpolatedValue - exactValue)
      const relativeError = exactValue !== 0 ? error / Math.abs(exactValue) : error

      maxError = Math.max(maxError, error)
      totalError += error
      checkCount++

      if (error > 0.01 || relativeError > 0.001) {
        errors.push({
          pointIndex: pi,
          frameIndex: ti,
          expected: exactValue,
          actual: interpolatedValue,
          error,
          relativeError
        })
      }
    }
  }

  return {
    valid: errors.length === 0,
    maxError,
    avgError: checkCount > 0 ? totalError / checkCount : 0,
    checkCount,
    errors: errors.slice(0, 10) // 最多返回10个误差
  }
}

function recomputeInterpolatedFieldStats(framesOut, valueRangePolicy) {
  const maxSamples = POINT_INTERPOLATION_CONSTANTS.maxSampleCount
  const samples = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let total = 0
  for (let i = 0; i < framesOut.length; i++) {
    const values = framesOut[i]?.values
    if (!(Array.isArray(values) || ArrayBuffer.isView(values))) continue
    total += values.length
  }
  const step = Math.max(1, Math.floor(total / maxSamples) || 1)
  let globalIndex = 0
  let nextSampleIndex = 0
  for (let i = 0; i < framesOut.length; i++) {
    const values = framesOut[i]?.values
    if (!(Array.isArray(values) || ArrayBuffer.isView(values))) continue
    for (let j = 0; j < values.length; j++) {
      const v = Number(values[j])
      if (!Number.isFinite(v)) {
        globalIndex++
        continue
      }
      if (v < min) min = v
      if (v > max) max = v
      if (globalIndex === nextSampleIndex && samples.length < maxSamples) {
        samples.push(v)
        nextSampleIndex += step
      }
      globalIndex++
    }
  }
  return { min, max, samples, valueRangePolicy }
}

function buildLocalInterpolationPoints(points, size) {
  const localPoints = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!p) continue
    const { dx, dy, dz } = resolvePointOffset(p, size)
    localPoints.push({ p, x: dx, y: dy, z: dz })
  }
  return localPoints
}

function buildInterpolationSeries(
  localPoints,
  getPointMetricSeriesValues,
  pd,
  metricKey,
  direction,
  overlayItems
) {
  const out = new Array(localPoints.length)
  for (let i = 0; i < localPoints.length; i++) {
    const source = getPointMetricSeriesValues(
      localPoints[i].p,
      pd,
      metricKey,
      direction,
      overlayItems
    )
    const normalized = new Array(source.length)
    for (let j = 0; j < source.length; j++) {
      const value = source[j]
      normalized[j] = Number.isFinite(value) ? Number(value) : 0
    }
    out[i] = normalized
  }
  return out
}

function buildKrigingField({
  localPoints,
  allSeries,
  exactConstraintPoints,
  exactConstraintSeries,
  grid,
  xs,
  ys,
  zs,
  frames,
  timePoints,
  options,
  progress,
  tracker
}) {
  const pointCount = localPoints.length
  const px = new Array(pointCount)
  const py = new Array(pointCount)
  const pz = new Array(pointCount)
  for (let i = 0; i < pointCount; i++) {
    px[i] = localPoints[i].x
    py[i] = localPoints[i].y
    pz[i] = localPoints[i].z
  }
  const fitMode = resolveDefaultKrigingFitMode(options, frames)
  const fit = new Array(allSeries.length)
  for (let si = 0; si < allSeries.length; si++) {
    const series = allSeries[si]
    if (fitMode === 'mean') {
      let sum = 0
      for (let i = 0; i < series.length; i++) sum += Number(series[i]) || 0
      fit[si] = series.length ? sum / series.length : 0
    } else {
      fit[si] = Number(series[0]) || 0
    }
  }

  const modelName = String(options.model || 'exponential')
  const sigma2 = Number.isFinite(Number(options.sigma2)) ? Number(options.sigma2) : 1e-4
  const variogram = train3D(fit, px, py, pz, modelName, sigma2)
  const ready =
    variogram &&
    variogram.status === 'ok' &&
    Number.isInteger(variogram.n) &&
    variogram.n > 0 &&
    variogram.M

  if (!ready) {
    return {
      ok: false,
      fallback: {
        from: 'kriging',
        to: 'idw',
        reason: String(variogram?.reason || 'kriging_unavailable')
      }
    }
  }

  // 从输入数据计算值域范围，用于 clamp 插值外推
  let dataMin = Number.POSITIVE_INFINITY
  let dataMax = Number.NEGATIVE_INFINITY
  for (let si = 0; si < allSeries.length; si++) {
    const series = allSeries[si]
    for (let ti = 0; ti < series.length; ti++) {
      const v = Number(series[ti])
      if (Number.isFinite(v)) {
        if (v < dataMin) dataMin = v
        if (v > dataMax) dataMax = v
      }
    }
  }
  const krigClampRange =
    Number.isFinite(dataMin) && Number.isFinite(dataMax) && dataMin < dataMax
      ? [dataMin, dataMax]
      : null

  const computeVariance = Boolean(options.computeVariance)

  const framesOut = []
  const varianceFramesOut = computeVariance ? [] : null
  const rhsScratch = new Array(variogram.n + 1)
  const pointValues = new Array(allSeries.length)
  for (let ti = 0; ti < frames; ti++) {
    const values = new Float32Array(grid.width * grid.height * grid.depth)
    const variances = computeVariance
      ? new Float32Array(grid.width * grid.height * grid.depth)
      : null
    for (let si = 0; si < allSeries.length; si++) pointValues[si] = Number(allSeries[si][ti]) || 0
    setValues(variogram, pointValues)

    let idx = 0
    for (let kz = 0; kz < grid.depth; kz++) {
      const z = zs[kz]
      for (let jy = 0; jy < grid.height; jy++) {
        const y = ys[jy]
        for (let ix = 0; ix < grid.width; ix++) {
          const x = xs[ix]
          if (computeVariance) {
            const result = predict3DWithVariance(x, y, z, variogram, krigClampRange)
            const resolved = Number.isFinite(result.value) ? result.value : 0
            values[idx] = resolved
            variances[idx] = Number.isFinite(result.variance) ? result.variance : 0
            tracker.track(resolved)
          } else {
            const v = predict3DWithScratch(x, y, z, variogram, rhsScratch, krigClampRange)
            const resolved = Number.isFinite(v) ? v : 0
            values[idx] = resolved
            tracker.track(resolved)
          }
          idx++
        }
      }
      progress.nextSlice('kriging')
    }
    framesOut.push({ values })
    if (varianceFramesOut) varianceFramesOut.push({ values: variances })
  }

  // 强制保持原始应力点位置的精确值
  enforceExactPointValues(framesOut, exactConstraintPoints, exactConstraintSeries, grid, xs, ys, zs)

  // 验证精确点保持效果（仅在开发模式下）
  if (import.meta.env.DEV) {
    const validation = validateExactPointValues(
      framesOut,
      exactConstraintPoints,
      exactConstraintSeries,
      grid,
      xs,
      ys,
      zs
    )
    if (!validation.valid) {
      console.warn('[Kriging] 精确点保持验证发现误差:', validation)
    }
  }

  const result = {
    ok: true,
    field: {
      grid,
      frames: framesOut,
      timePoints
    }
  }
  if (varianceFramesOut) {
    result.varianceField = {
      grid,
      frames: varianceFramesOut,
      timePoints,
      unit: 'variance'
    }
  }
  return result
}

function findNearestSamples(
  index,
  localPoints,
  targetX,
  targetY,
  targetZ,
  neighborCount,
  radius2,
  anisotropyParams,
  neighborPolicy,
  sectorCount
) {
  const hasAnisotropy = anisotropyParams !== null
  const queryCount = hasAnisotropy ? neighborCount * 3 : neighborCount
  const candidates = index.findNearest({ x: targetX, y: targetY, z: targetZ }, queryCount, radius2)

  // 快速路径：无各向异性时，kd-tree 欧氏距离即为正确距离，无需重算
  if (!hasAnisotropy) {
    const used = Math.min(neighborCount, candidates.length)
    if (neighborPolicy !== 'sector' || used <= 2 || sectorCount <= 1) {
      return candidates.slice(0, used)
    }
    const sectors = new Array(sectorCount)
    for (let s = 0; s < sectorCount; s++) sectors[s] = []
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      const p = localPoints[c.index]
      const a = Math.atan2(targetY - p.y, targetX - p.x)
      const t = (a + Math.PI) / (2 * Math.PI)
      const si = Math.max(0, Math.min(sectorCount - 1, Math.floor(t * sectorCount)))
      sectors[si].push(c)
    }
    const picked = []
    for (let s = 0; s < sectors.length && picked.length < used; s++) {
      if (sectors[s].length > 0) picked.push(sectors[s].shift())
    }
    if (picked.length < used) {
      const rest = []
      for (let s = 0; s < sectors.length; s++) {
        for (let i = 0; i < sectors[s].length; i++) rest.push(sectors[s][i])
      }
      rest.sort((a, b) => a.distance2 - b.distance2)
      for (let i = 0; i < rest.length && picked.length < used; i++) picked.push(rest[i])
    }
    picked.sort((a, b) => a.distance2 - b.distance2)
    return picked
  }

  // 各向异性路径：用各向异性距离重新排序候选点
  const refined = []
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const point = localPoints[candidate.index]
    const dx = targetX - point.x
    const dy = targetY - point.y
    const dz = targetZ - point.z
    const distance2 = computeAnisotropicDistanceSquared(dx, dy, dz, anisotropyParams)
    if (distance2 <= radius2) {
      refined.push({ index: candidate.index, distance2 })
    }
  }
  refined.sort((a, b) => a.distance2 - b.distance2)
  const usedCount = Math.min(neighborCount, refined.length)
  if (neighborPolicy !== 'sector' || usedCount <= 2 || sectorCount <= 1) {
    return refined.slice(0, usedCount)
  }

  const sectors = new Array(sectorCount)
  for (let s = 0; s < sectorCount; s++) sectors[s] = []
  const aAngle = anisotropyParams.angle || 0
  const cosA = Math.cos(aAngle)
  const sinA = Math.sin(aAngle)
  for (let i = 0; i < refined.length; i++) {
    const candidate = refined[i]
    const point = localPoints[candidate.index]
    const ddx = targetX - point.x
    const ddy = targetY - point.y
    const rx = ddx * cosA + ddy * sinA
    const ry = -ddx * sinA + ddy * cosA
    const a = Math.atan2(ry, rx)
    const t = (a + Math.PI) / (2 * Math.PI)
    const sectorIndex = Math.max(0, Math.min(sectorCount - 1, Math.floor(t * sectorCount)))
    sectors[sectorIndex].push(candidate)
  }

  const picked = []
  for (let i = 0; i < sectors.length && picked.length < usedCount; i++) {
    if (sectors[i].length > 0) picked.push(sectors[i].shift())
  }
  if (picked.length < usedCount) {
    const remaining = []
    for (let i = 0; i < sectors.length; i++) {
      for (let j = 0; j < sectors[i].length; j++) remaining.push(sectors[i][j])
    }
    remaining.sort((a, b) => a.distance2 - b.distance2)
    for (let i = 0; i < remaining.length && picked.length < usedCount; i++) {
      picked.push(remaining[i])
    }
  }
  picked.sort((a, b) => a.distance2 - b.distance2)
  return picked
}

function buildIdwField({
  localPoints,
  allSeries,
  exactConstraintPoints,
  exactConstraintSeries,
  grid,
  xs,
  ys,
  zs,
  frames,
  timePoints,
  power,
  neighborCount,
  neighborPolicy,
  sectorCount,
  radius,
  adaptivePower,
  adaptiveNeighborCount,
  epsilon,
  anisotropyParams,
  progress,
  tracker
}) {
  const lpCount = localPoints.length
  const cappedNeighborCount = Math.min(neighborCount, lpCount)
  const radius2 = Number.isFinite(radius) ? radius * radius : Number.POSITIVE_INFINITY
  const eps2 = epsilon * epsilon
  const spatialIndex = createPointSpatialIndex(localPoints)
  const framesOut = []
  const pointValues = new Array(allSeries.length)

  // 自适应用幂指数只在开启时逐格计算，关闭时直接复用固定幂指数
  const useAdaptivePower = adaptivePower && localPoints.length >= 4
  const adaptiveParams = useAdaptivePower
    ? { power, adaptivePower: true, adaptiveNeighborCount }
    : null

  for (let ti = 0; ti < frames; ti++) {
    const values = new Float32Array(grid.width * grid.height * grid.depth)
    for (let si = 0; si < allSeries.length; si++) {
      const value = allSeries[si][ti]
      pointValues[si] = Number.isFinite(value) ? Number(value) : 0
    }

    let idx = 0
    for (let kz = 0; kz < grid.depth; kz++) {
      const z = zs[kz]
      for (let jy = 0; jy < grid.height; jy++) {
        const y = ys[jy]
        for (let ix = 0; ix < grid.width; ix++) {
          const x = xs[ix]
          const nearest = findNearestSamples(
            spatialIndex,
            localPoints,
            x,
            y,
            z,
            cappedNeighborCount,
            radius2,
            anisotropyParams,
            neighborPolicy,
            sectorCount
          )

          const usedPower = useAdaptivePower
            ? resolveAdaptiveIdwPower(
                localPoints,
                adaptiveParams,
                nearest.map(sample => sample.distance2)
              )
            : power
          const finalPower = Number.isFinite(usedPower) ? usedPower : power

          let weightSum = 0
          let valueSum = 0
          let resolved = 0
          let hit = false

          for (let ni = 0; ni < nearest.length; ni++) {
            const sample = nearest[ni]
            if (sample.distance2 <= eps2) {
              hit = true
              resolved = pointValues[sample.index]
              break
            }
            const w = 1 / (Math.sqrt(sample.distance2) + epsilon) ** finalPower
            weightSum += w
            valueSum += w * pointValues[sample.index]
          }

          if (!hit) {
            resolved = weightSum > 0 ? valueSum / weightSum : 0
          }
          values[idx++] = resolved
          tracker.track(resolved)
        }
      }
      progress.nextSlice('idw')
    }
    framesOut.push({ values })
  }

  // 强制保持原始应力点位置的精确值
  enforceExactPointValues(framesOut, exactConstraintPoints, exactConstraintSeries, grid, xs, ys, zs)

  // 验证精确点保持效果（仅在开发模式下）
  if (import.meta.env.DEV) {
    const validation = validateExactPointValues(
      framesOut,
      exactConstraintPoints,
      exactConstraintSeries,
      grid,
      xs,
      ys,
      zs
    )
    if (!validation.valid) {
      console.warn('[IDW] 精确点保持验证发现误差:', validation)
    }
  }

  return {
    grid,
    frames: framesOut,
    timePoints
  }
}

/**
 * 插值总控入口。
 *
 * 负责：
 * - 解析统一插值配置
 * - 点样本筛选
 * - 决定 Kriging / IDW 路线
 * - 汇总进度、值域与诊断信息
 *
 * 不负责：
 * - 点值缓存
 * - Worker 调度
 * - 面板层状态管理
 */
export function createInterpolationManager({ getPointMetricSeriesValues }) {
  function buildInterpolatedScalarFieldFromPointDataset(
    pd,
    metricKey,
    direction,
    overlayItems,
    options = {}
  ) {
    if (!pd || typeof pd !== 'object') return null
    const size = Array.isArray(pd.size) && pd.size.length >= 3 ? pd.size : [200, 200, 100]
    const points = (Array.isArray(pd.points) ? pd.points : []).slice(0, 1000)
    if (points.length < 1) return null

    const frames = Math.max(1, Number(pd?.time?.frames) || 1)
    const timePoints = Array.isArray(pd?.time?.timePoints) ? pd.time.timePoints : null
    const method = resolveInterpolationMethod(options)
    const grid = resolveInterpolationGrid(size, options)
    const { xs, ys, zs } = buildGridPositions(size, grid)
    const progress = createInterpolationProgressReporter(options, frames, grid)
    const totalValues = grid.width * grid.height * grid.depth * frames
    const tracker = createValueTracker({ ...options, totalValuesEstimate: totalValues }, pd)

    const localPointsRaw = buildLocalInterpolationPoints(points, size)
    if (localPointsRaw.length < 1) return null

    const allSeriesRaw = buildInterpolationSeries(
      localPointsRaw,
      getPointMetricSeriesValues,
      pd,
      metricKey,
      direction,
      overlayItems
    )

    const maxPoints = resolveInterpolationPointLimit(
      method,
      options.maxPoints,
      localPointsRaw.length
    )
    const selection = selectInterpolationPoints(
      localPointsRaw,
      allSeriesRaw,
      size,
      maxPoints,
      options,
      method
    )
    const localPoints = selection.localPoints
    const allSeries = selection.allSeries

    let optimizationResult = null
    let anisotropyParams = resolveAnisotropyParams(options)
    let {
      power,
      neighborCount,
      neighborPolicy,
      sectorCount,
      radius,
      adaptivePower,
      adaptiveNeighborCount,
      epsilon
    } = resolveIdwRuntimeParams(options, localPoints.length)

    if (method === 'idw' && Boolean(options.optimizeParameters) && localPoints.length >= 4) {
      const firstFrameValues = allSeries.map(s => (Number.isFinite(s[0]) ? Number(s[0]) : 0))
      optimizationResult = optimizeIDWParameters(
        localPoints,
        firstFrameValues,
        resolveOptimizationConfig(options)
      )
      if (optimizationResult.success) {
        power = optimizationResult.optimalParams.power
        neighborCount = optimizationResult.optimalParams.neighborCount
        anisotropyParams = optimizationResult.optimalParams.anisotropyParams
        neighborPolicy = optimizationResult.optimalParams.neighborPolicy || neighborPolicy
        sectorCount = optimizationResult.optimalParams.sectorCount || sectorCount
        adaptivePower = optimizationResult.optimalParams.adaptivePower ?? adaptivePower
        adaptiveNeighborCount =
          optimizationResult.optimalParams.adaptiveNeighborCount || adaptiveNeighborCount
      }
    }

    let fallback = null
    if (method === 'kriging') {
      const krigingResult = buildKrigingField({
        localPoints,
        allSeries,
        exactConstraintPoints: localPointsRaw,
        exactConstraintSeries: allSeriesRaw,
        grid,
        xs,
        ys,
        zs,
        frames,
        timePoints,
        options,
        progress,
        tracker
      })
      if (krigingResult.ok) {
        const trackedStats = tracker.snapshot()
        const stats = recomputeInterpolatedFieldStats(
          krigingResult.field.frames,
          trackedStats.valueRangePolicy
        )
        const result = {
          ...krigingResult.field,
          valueRange:
            resolveMetricFixedRange(metricKey) ||
            computeValueRange(
              { min: stats.min, max: stats.max, samples: stats.samples },
              stats.valueRangePolicy
            )
        }
        if (krigingResult.varianceField) {
          result.varianceField = krigingResult.varianceField
        }
        return result
      }
      fallback = krigingResult.fallback
    }

    const field = buildIdwField({
      localPoints,
      allSeries,
      exactConstraintPoints: localPointsRaw,
      exactConstraintSeries: allSeriesRaw,
      grid,
      xs,
      ys,
      zs,
      frames,
      timePoints,
      power,
      neighborCount,
      neighborPolicy,
      sectorCount,
      radius,
      adaptivePower,
      adaptiveNeighborCount,
      epsilon,
      anisotropyParams,
      progress,
      tracker
    })
    const trackedStats = tracker.snapshot()
    const stats = recomputeInterpolatedFieldStats(field.frames, trackedStats.valueRangePolicy)
    return {
      ...field,
      valueRange:
        resolveMetricFixedRange(metricKey) ||
        computeValueRange(
          { min: stats.min, max: stats.max, samples: stats.samples },
          stats.valueRangePolicy
        ),
      fallback,
      optimization: optimizationResult
        ? {
            enabled: true,
            success: optimizationResult.success,
            optimalPower: optimizationResult.success
              ? optimizationResult.optimalParams.power
              : null,
            optimalNeighborCount: optimizationResult.success
              ? optimizationResult.optimalParams.neighborCount
              : null,
            optimalAnisotropy: optimizationResult.success
              ? optimizationResult.optimalParams.anisotropyParams
              : null,
            neighborPolicy: optimizationResult.success
              ? optimizationResult.optimalParams.neighborPolicy
              : neighborPolicy,
            sectorCount: optimizationResult.success
              ? optimizationResult.optimalParams.sectorCount
              : sectorCount,
            fitness: optimizationResult.fitness,
            objectiveWeights: optimizationResult.objectiveWeights || null
          }
        : null,
      diagnostics: {
        method,
        power,
        neighborCount,
        neighborPolicy,
        sectorCount,
        anisotropy: anisotropyParams,
        spatialIndex: 'kdtree'
      }
    }
  }

  return {
    buildInterpolatedScalarFieldFromPointDataset
  }
}
