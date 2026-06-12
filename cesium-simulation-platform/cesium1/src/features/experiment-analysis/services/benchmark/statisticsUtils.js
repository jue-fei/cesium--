export function computeRMSE(predictions, groundTruth) {
  const n = Math.min(predictions.length, groundTruth.length)
  if (n === 0) return Number.NaN
  let sumSq = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const pred = Number(predictions[i])
    const truth = Number(groundTruth[i])
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) continue
    const diff = pred - truth
    sumSq += diff * diff
    count++
  }
  return count > 0 ? Math.sqrt(sumSq / count) : Number.NaN
}

export function computeMAE(predictions, groundTruth) {
  const n = Math.min(predictions.length, groundTruth.length)
  if (n === 0) return Number.NaN
  let sumAbs = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const pred = Number(predictions[i])
    const truth = Number(groundTruth[i])
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) continue
    sumAbs += Math.abs(pred - truth)
    count++
  }
  return count > 0 ? sumAbs / count : Number.NaN
}

export function computeMaxError(predictions, groundTruth) {
  const n = Math.min(predictions.length, groundTruth.length)
  if (n === 0) return Number.NaN
  let maxErr = 0
  for (let i = 0; i < n; i++) {
    const pred = Number(predictions[i])
    const truth = Number(groundTruth[i])
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) continue
    maxErr = Math.max(maxErr, Math.abs(pred - truth))
  }
  return maxErr
}

export function computeMAPE(predictions, groundTruth) {
  const n = Math.min(predictions.length, groundTruth.length)
  if (n === 0) return Number.NaN

  // 先计算真值均值的绝对值，作为尺度参考
  let sumAbsTruth = 0
  let validCount = 0
  for (let i = 0; i < n; i++) {
    const pred = Number(predictions[i])
    const truth = Number(groundTruth[i])
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) continue
    sumAbsTruth += Math.abs(truth)
    validCount++
  }
  const meanAbsTruth = validCount > 0 ? sumAbsTruth / validCount : 0
  const floor = Math.max(meanAbsTruth * 0.01, 1e-4)

  let sum = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const pred = Number(predictions[i])
    const truth = Number(groundTruth[i])
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) continue
    const denom = Math.max(floor, Math.abs(truth))
    sum += Math.abs((pred - truth) / denom) * 100
    count++
  }
  return count > 0 ? sum / count : Number.NaN
}

export function computeR2(predictions, groundTruth) {
  const n = Math.min(predictions.length, groundTruth.length)
  if (n < 2) return Number.NaN
  let sumY = 0
  let count = 0
  const validPreds = []
  const validTruths = []
  for (let i = 0; i < n; i++) {
    const pred = Number(predictions[i])
    const truth = Number(groundTruth[i])
    if (!Number.isFinite(pred) || !Number.isFinite(truth)) continue
    validPreds.push(pred)
    validTruths.push(truth)
    sumY += truth
    count++
  }
  if (count < 2) return Number.NaN
  const meanY = sumY / count
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < count; i++) {
    const diff = validPreds[i] - validTruths[i]
    ssRes += diff * diff
    const totDiff = validTruths[i] - meanY
    ssTot += totDiff * totDiff
  }
  if (ssTot < 1e-12) return ssRes < 1e-12 ? 1 : Number.NaN
  return 1 - ssRes / ssTot
}

export function computeAllMetrics(predictions, groundTruth) {
  return {
    rmse: computeRMSE(predictions, groundTruth),
    mae: computeMAE(predictions, groundTruth),
    r2: computeR2(predictions, groundTruth),
    maxError: computeMaxError(predictions, groundTruth),
    mape: computeMAPE(predictions, groundTruth)
  }
}

export function computeBasicStats(values) {
  const filtered = []
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) filtered.push(n)
  }
  if (filtered.length === 0) {
    return { count: 0, min: null, max: null, mean: null, std: null, median: null }
  }
  filtered.sort((a, b) => a - b)
  const n = filtered.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += filtered[i]
  const mean = sum / n
  let sumSqDiff = 0
  for (let i = 0; i < n; i++) sumSqDiff += (filtered[i] - mean) ** 2
  const std = Math.sqrt(sumSqDiff / n)
  const median =
    n % 2 === 1 ? filtered[Math.floor(n / 2)] : (filtered[n / 2 - 1] + filtered[n / 2]) / 2
  return {
    count: n,
    min: filtered[0],
    max: filtered[n - 1],
    mean,
    std,
    median
  }
}

export function computeErrorDistribution(errors, binCount = 20) {
  const valid = []
  for (const e of errors) {
    const n = Number(e)
    if (Number.isFinite(n)) valid.push(n)
  }
  if (valid.length === 0) return { bins: [], binWidth: 0, count: 0 }

  const stats = computeBasicStats(valid)
  const range = Math.max(0.01, (stats.max - stats.min) * 1.1)
  const padding = range * 0.05
  const lo = stats.min - padding
  const hi = stats.max + padding
  const binWidth = range / binCount
  const bins = new Array(binCount).fill(0)

  for (const v of valid) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / binWidth)))
    bins[idx]++
  }

  const normalized = bins.map((count, i) => ({
    binStart: lo + i * binWidth,
    binEnd: lo + (i + 1) * binWidth,
    count,
    frequency: count / valid.length
  }))

  return { bins: normalized, binWidth, count: valid.length, lo, hi }
}

export function aggregateRepeatResults(allResults) {
  if (!Array.isArray(allResults) || allResults.length === 0) return null

  const metricKeys = ['rmse', 'mae', 'r2', 'maxError', 'mape']
  const aggregate = {}

  for (const key of metricKeys) {
    const values = []
    for (const result of allResults) {
      const v = result?.metrics?.[key]
      if (Number.isFinite(v)) values.push(v)
    }
    if (values.length > 0) {
      const stats = computeBasicStats(values)
      aggregate[key] = {
        mean: stats.mean,
        std: stats.std,
        min: stats.min,
        max: stats.max,
        count: values.length
      }
    }
  }

  if (allResults.length > 0 && allResults[0]?.timing && typeof allResults[0].timing === 'object') {
    const allTiming = allResults.map(r => r.timing)
    const timingKeys = Object.keys(allTiming[0] || {})
    const timingAgg = {}
    for (const key of timingKeys) {
      const values = allTiming.map(t => Number(t[key])).filter(Number.isFinite)
      if (values.length > 0) {
        const stats = computeBasicStats(values)
        timingAgg[key] = { mean: stats.mean, std: stats.std, count: values.length }
      }
    }
    aggregate.timing = timingAgg
  }

  return {
    metrics: aggregate,
    repeatCount: allResults.length,
    method: allResults[0]?.method || 'unknown'
  }
}

export function formatMetricValue(value, unit = '') {
  if (!Number.isFinite(value)) return 'N/A'
  if (unit === '%') return value.toFixed(2) + '%'
  if (Math.abs(value) < 0.01) return value.toExponential(3)
  if (Math.abs(value) < 1) return value.toFixed(4)
  if (Math.abs(value) < 100) return value.toFixed(2)
  return value.toFixed(1)
}

export function formatTimingMs(ms) {
  if (!Number.isFinite(ms)) return 'N/A'
  if (ms < 1) return (ms * 1000).toFixed(1) + ' μs'
  if (ms < 1000) return ms.toFixed(1) + ' ms'
  return (ms / 1000).toFixed(2) + ' s'
}

export function computeImprovementRatio(baselineMetrics, improvedMetrics, metricKey) {
  const base = Number(baselineMetrics?.[metricKey])
  const improved = Number(improvedMetrics?.[metricKey])
  if (!Number.isFinite(base) || !Number.isFinite(improved) || base === 0) return null
  return ((base - improved) / Math.abs(base)) * 100
}
