export function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return NaN
  const clampedRatio = Math.max(0, Math.min(1, Number(ratio) || 0))
  const index = clampedRatio * (sortedValues.length - 1)
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.min(sortedValues.length - 1, Math.ceil(index))
  const t = index - lowerIndex
  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * t
}

export function computeHeatmapGlobalRange(snapshots, options = {}) {
  const { upperQuantile = 0.995, minSpan = 1, paddingRatio = 0.04 } = options

  const values = []
  for (const snap of snapshots || []) {
    for (const value of snap?.gridData?.values || []) {
      if (Number.isFinite(value)) values.push(value)
    }
  }

  if (!values.length) {
    return { min: 0, max: 1, rawMin: 0, rawMax: 1 }
  }

  values.sort((a, b) => a - b)
  const rawMin = values[0]
  const rawMax = values[values.length - 1]

  const robustMax = values.length >= 16 ? percentile(values, upperQuantile) : rawMax

  // 保留真实下界，避免存在负值时被硬夹到 0，导致色阶整体偏暖。
  let min = rawMin
  let max = Number.isFinite(robustMax) ? Math.max(robustMax, rawMin + minSpan) : rawMax
  if (max <= min) {
    max = min + minSpan
  }

  const padding = Math.max(0, (max - min) * paddingRatio)
  min = min - padding
  max = Math.max(min + minSpan, Math.max(rawMax, max) > max * 1.5 ? max + padding : rawMax)
  if (max <= min) {
    max = min + minSpan
  }

  return { min, max, rawMin, rawMax }
}
