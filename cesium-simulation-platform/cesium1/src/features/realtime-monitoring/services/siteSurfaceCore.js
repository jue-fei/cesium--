export function buildSurfacePoolCandidates(radiusMeters, angleSteps = 16) {
  const safeRadius = Math.max(0, Number(radiusMeters) || 0)
  const radialSteps = Math.max(2, Math.ceil(safeRadius / 6))
  const candidates = [[0, 0]]

  for (let radiusIndex = 1; radiusIndex <= radialSteps; radiusIndex++) {
    const ringRadius = (safeRadius * radiusIndex) / radialSteps
    for (let step = 0; step < angleSteps; step++) {
      const angle = (step / angleSteps) * Math.PI * 2
      candidates.push([Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius])
    }
  }

  return candidates
}

export function isDuplicateSurfacePoint(points, eastMeters, northMeters, threshold = 1.5) {
  return points.some(point => {
    const dx = point.eastMeters - eastMeters
    const dy = point.northMeters - northMeters
    return Math.sqrt(dx * dx + dy * dy) < threshold
  })
}

export function selectResolvedSurfacePool(points, topBand, minPoints) {
  const sortedPoints = [...points].sort((a, b) => b.height - a.height)
  const maxHeight = sortedPoints[0]?.height ?? 0
  const topSurfacePoints = sortedPoints.filter(point => point.height >= maxHeight - topBand)
  return topSurfacePoints.length >= minPoints ? topSurfacePoints : sortedPoints
}

export function findNearestSurfacePoint(pool, eastMeters = 0, northMeters = 0) {
  if (!pool.length) return null

  let nearestPoint = pool[0]
  let nearestDistance = Infinity
  for (const point of pool) {
    const dx = point.eastMeters - eastMeters
    const dy = point.northMeters - northMeters
    const distance = dx * dx + dy * dy
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestPoint = point
    }
  }

  return nearestPoint
}

export function buildSurfaceSearchCandidates(eastMeters, northMeters, step) {
  return [
    [eastMeters + step, northMeters],
    [eastMeters - step, northMeters],
    [eastMeters, northMeters + step],
    [eastMeters, northMeters - step],
    [eastMeters + step, northMeters + step],
    [eastMeters + step, northMeters - step],
    [eastMeters - step, northMeters + step],
    [eastMeters - step, northMeters - step]
  ]
}

export function resolveScaledSiteRadius(baseRadius, radiusScale, ratio, minRadius, maxRadius) {
  const rawRadius = (Number(baseRadius) || 0) * (Number(ratio) || 0) * (Number(radiusScale) || 1)
  return Math.max(minRadius, Math.min(maxRadius, rawRadius))
}

export function resolveInitialPlacementRadius(
  resolvedRadius,
  initialRatio,
  minInitialRadius,
  maxInitialRadius
) {
  const rawRadius = (Number(resolvedRadius) || 0) * (Number(initialRatio) || 0)
  return Math.max(minInitialRadius, Math.min(maxInitialRadius, rawRadius))
}
