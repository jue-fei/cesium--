import * as Cesium from 'cesium'
import {
  findPathSegmentByDistance,
  normalizeLoopProgress,
  resolveSampledPathInterpolation
} from './realtimeDataCore.js'

export function createCustomPathState(pathPoints, transformCurrentPointToOriginal) {
  const customPathPoints = pathPoints.map((point, index) => {
    const currentCartesian = Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      point.height || 0
    )
    const originalCartesian = transformCurrentPointToOriginal(currentCartesian)

    return {
      index,
      longitude: point.longitude,
      latitude: point.latitude,
      height: point.height || 0,
      currentCartesian,
      originalCartesian,
      cumulativeDistance: 0
    }
  })

  let totalDistance = 0
  for (let index = 1; index < customPathPoints.length; index += 1) {
    const previousPoint = customPathPoints[index - 1]
    const currentPoint = customPathPoints[index]
    totalDistance += Cesium.Cartesian3.distance(
      previousPoint.originalCartesian,
      currentPoint.originalCartesian
    )
    currentPoint.cumulativeDistance = totalDistance
  }

  return {
    customPathPoints,
    customPathTotalLength: totalDistance
  }
}

export function sampleGroundPath(customPathPoints, samplesPerSegment = 50) {
  const sampledPath = []

  for (let segmentIndex = 0; segmentIndex < customPathPoints.length - 1; segmentIndex += 1) {
    const start = customPathPoints[segmentIndex]
    const end = customPathPoints[segmentIndex + 1]

    for (let sampleIndex = 0; sampleIndex < samplesPerSegment; sampleIndex += 1) {
      const progress = sampleIndex / samplesPerSegment
      sampledPath.push({
        originalCartesian: Cesium.Cartesian3.lerp(
          start.originalCartesian,
          end.originalCartesian,
          progress,
          new Cesium.Cartesian3()
        ),
        segmentIndex,
        segmentProgress: progress
      })
    }
  }

  const lastPoint = customPathPoints[customPathPoints.length - 1]
  sampledPath.push({
    originalCartesian: Cesium.Cartesian3.clone(lastPoint.originalCartesian),
    segmentIndex: customPathPoints.length - 1,
    segmentProgress: 1
  })

  return sampledPath
}

export function getCurrentCustomPathPoints(
  customPathPoints,
  transformOriginalPointToCurrent,
  cartesianToWorldPosition
) {
  return customPathPoints.map(point => {
    const currentCartesian = transformOriginalPointToCurrent(point.originalCartesian)
    const worldPosition = cartesianToWorldPosition(currentCartesian, point.height || 0)

    return {
      ...point,
      ...worldPosition,
      currentCartesian
    }
  })
}

export function getPositionFromSampledPath(
  sampledGroundPath,
  progress,
  transformOriginalPointToCurrent,
  cartesianToWorldPosition
) {
  const interpolation = resolveSampledPathInterpolation(progress, sampledGroundPath.length)
  if (!interpolation) return null

  const point1 = sampledGroundPath[interpolation.index1]
  const point2 = sampledGroundPath[interpolation.index2]
  const point1Current = transformOriginalPointToCurrent(point1.originalCartesian)
  const point2Current = transformOriginalPointToCurrent(point2.originalCartesian)
  const interpolatedCartesian = Cesium.Cartesian3.lerp(
    point1Current,
    point2Current,
    interpolation.localProgress,
    new Cesium.Cartesian3()
  )

  return cartesianToWorldPosition(interpolatedCartesian, 0)
}

export function getPositionOnCustomPath({
  customPathPoints,
  sampledGroundPath,
  customPathTotalLength,
  progress,
  transformOriginalPointToCurrent,
  cartesianToWorldPosition
}) {
  if (!customPathPoints || customPathPoints.length < 2) {
    return null
  }

  const normalizedProgress = normalizeLoopProgress(progress)

  if (sampledGroundPath && sampledGroundPath.length >= 2) {
    return getPositionFromSampledPath(
      sampledGroundPath,
      normalizedProgress,
      transformOriginalPointToCurrent,
      cartesianToWorldPosition
    )
  }

  const currentPathPoints = getCurrentCustomPathPoints(
    customPathPoints,
    transformOriginalPointToCurrent,
    cartesianToWorldPosition
  )
  const targetDistance = normalizedProgress * customPathTotalLength
  const segment = findPathSegmentByDistance(currentPathPoints, targetDistance)
  if (!segment) return null

  const interpolatedCartesian = Cesium.Cartesian3.lerp(
    segment.prev.currentCartesian,
    segment.curr.currentCartesian,
    segment.segmentProgress,
    new Cesium.Cartesian3()
  )

  return cartesianToWorldPosition(interpolatedCartesian, segment.prev.height || 0)
}

export function getHeightFromPathPoints(currentPathPoints, longitude, latitude) {
  if (!currentPathPoints.length) {
    return 0
  }

  let nearestIndex = 0
  let minDistance = Infinity

  for (let index = 0; index < currentPathPoints.length; index += 1) {
    const point = currentPathPoints[index]
    const longitudeDelta = point.longitude - longitude
    const latitudeDelta = point.latitude - latitude
    const distance = Math.sqrt(longitudeDelta * longitudeDelta + latitudeDelta * latitudeDelta)

    if (distance < minDistance) {
      minDistance = distance
      nearestIndex = index
    }
  }

  if (nearestIndex === 0 || nearestIndex === currentPathPoints.length - 1) {
    return currentPathPoints[nearestIndex].height
  }

  const previousPoint = currentPathPoints[nearestIndex - 1]
  const currentPoint = currentPathPoints[nearestIndex]
  const nextPoint = currentPathPoints[nearestIndex + 1]
  const distanceToPrevious = Math.sqrt(
    Math.pow(previousPoint.longitude - longitude, 2) +
      Math.pow(previousPoint.latitude - latitude, 2)
  )
  const distanceToNext = Math.sqrt(
    Math.pow(nextPoint.longitude - longitude, 2) + Math.pow(nextPoint.latitude - latitude, 2)
  )
  const totalDistance = distanceToPrevious + distanceToNext

  if (totalDistance === 0) {
    return currentPoint.height
  }

  const previousWeight = distanceToNext / totalDistance
  const nextWeight = distanceToPrevious / totalDistance
  return previousPoint.height * previousWeight + nextPoint.height * nextWeight
}
