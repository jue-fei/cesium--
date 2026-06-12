export const TRAJECTORY_HISTORY_LIMIT = 1000

export function normalizeLoopProgress(progress) {
  let nextProgress = Number(progress) || 0
  nextProgress %= 1
  if (nextProgress < 0) nextProgress += 1
  return nextProgress
}

export function calculateGreatCircleDistance(p1, p2) {
  const R = 6371000
  const lat1 = (p1.latitude * Math.PI) / 180
  const lat2 = (p2.latitude * Math.PI) / 180
  const deltaLat = ((p2.latitude - p1.latitude) * Math.PI) / 180
  const deltaLon = ((p2.longitude - p1.longitude) * Math.PI) / 180

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

export function findPathSegmentByDistance(pathPoints, targetDistance) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) return null

  for (let i = 1; i < pathPoints.length; i++) {
    const prev = pathPoints[i - 1]
    const curr = pathPoints[i]
    if (targetDistance > curr.cumulativeDistance) continue

    const segmentStart = prev.cumulativeDistance
    const segmentEnd = curr.cumulativeDistance
    const segmentLength = segmentEnd - segmentStart
    const segmentProgress = segmentLength > 0 ? (targetDistance - segmentStart) / segmentLength : 0

    return {
      prev,
      curr,
      segmentStart,
      segmentEnd,
      segmentLength,
      segmentProgress
    }
  }

  return {
    prev: pathPoints[pathPoints.length - 2],
    curr: pathPoints[pathPoints.length - 1],
    segmentStart: pathPoints[pathPoints.length - 2].cumulativeDistance,
    segmentEnd: pathPoints[pathPoints.length - 1].cumulativeDistance,
    segmentLength:
      pathPoints[pathPoints.length - 1].cumulativeDistance -
      pathPoints[pathPoints.length - 2].cumulativeDistance,
    segmentProgress: 1
  }
}

export function resolveSampledPathInterpolation(progress, totalSamples) {
  if (!Number.isFinite(totalSamples) || totalSamples < 2) return null

  const targetIndex = normalizeLoopProgress(progress) * (totalSamples - 1)
  const index1 = Math.floor(targetIndex)
  const index2 = Math.min(index1 + 1, totalSamples - 1)

  return {
    index1,
    index2,
    localProgress: targetIndex - index1
  }
}

export function isValidRealtimeTruckData(data) {
  if (!data) return false
  const hasTruckId = typeof data.truckId === 'string' || typeof data.truck_id === 'string'
  const position = data.position
  const hasPosition = position &&
    typeof position === 'object' &&
    (Array.isArray(position.cartesian) ||
      (typeof position.longitude === 'number' && typeof position.latitude === 'number'))
  const hasPhase = typeof data.phase === 'number' && data.phase >= 0 && data.phase <= 1
  return Boolean(hasTruckId && (hasPosition || hasPhase))
}

export function normalizeRealtimeTruckData(data, now = Date.now()) {
  const vehicleInfo = data.vehicleInfo || data.vehicle_info || {}
  const driverInfo = data.driverInfo || data.driver_info || {}
  return {
    ...data,
    receivedAt: now,
    timestamp: data.timestamp || now,
    truckName: data.truckName || data.name || data.truckId || '',
    speed: data.speed || 0,
    heading: data.heading || 0,
    status: data.status || '未知',
    payload: data.payload || 0,
    capacity: data.capacity || vehicleInfo.capacity || 0,
    driver: data.driver || '未知驾驶员',
    driverInfo,
    vehicleInfo,
    mineralType: data.mineralType || data.mineral_type || { name: '未知', code: 'UNK' }
  }
}

export function appendHistoryEntry(historyMap, truckId, data, limit = TRAJECTORY_HISTORY_LIMIT) {
  if (!historyMap.has(truckId)) historyMap.set(truckId, [])
  const history = historyMap.get(truckId)
  history.push({ timestamp: data.timestamp, position: data.position, data })
  if (history.length > limit) history.shift()
  return history
}

export function findNearestHistoryPoint(history, timestamp) {
  if (!history?.length) return null

  let nearest = history[0]
  let minDiff = Math.abs(history[0].timestamp - timestamp)
  for (let i = 1; i < history.length; i++) {
    const diff = Math.abs(history[i].timestamp - timestamp)
    if (diff < minDiff) {
      minDiff = diff
      nearest = history[i]
    }
  }

  return nearest
}

export function getTruckStatesAtTime(historyMap, timestamp) {
  const states = []
  historyMap.forEach(history => {
    const point = findNearestHistoryPoint(history, timestamp)
    if (point) states.push(point.data)
  })
  return states
}

export function getHistoryTimeRange(historyMap, now = Date.now()) {
  let minTime = Infinity
  let maxTime = -Infinity

  historyMap.forEach(history => {
    if (!history.length) return
    minTime = Math.min(minTime, history[0].timestamp)
    maxTime = Math.max(maxTime, history[history.length - 1].timestamp)
  })

  return {
    startTime: minTime === Infinity ? now : minTime,
    endTime: maxTime === -Infinity ? now : maxTime
  }
}
