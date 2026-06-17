function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasValidCartesianArray(position) {
  return (
    Array.isArray(position?.cartesian) &&
    position.cartesian.length === 3 &&
    position.cartesian.every(component => isFiniteNumber(component))
  )
}

function hasValidGeographicPosition(position) {
  return isFiniteNumber(position?.longitude) && isFiniteNumber(position?.latitude)
}

function lerp(start, end, progress) {
  return start + (end - start) * progress
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3)
}

export function hasRenderableTruckPosition(position) {
  return hasValidCartesianArray(position) || hasValidGeographicPosition(position)
}

export function cloneTruckState(truck) {
  if (!truck) return truck

  return {
    ...truck,
    mineralType: truck.mineralType ? { ...truck.mineralType } : truck.mineralType,
    vehicleInfo: truck.vehicleInfo ? { ...truck.vehicleInfo } : truck.vehicleInfo,
    driverInfo: truck.driverInfo ? { ...truck.driverInfo } : truck.driverInfo,
    tirePressure: Array.isArray(truck.tirePressure) ? [...truck.tirePressure] : truck.tirePressure,
    position: truck.position
      ? {
          ...truck.position,
          cartesian: Array.isArray(truck.position.cartesian)
            ? [...truck.position.cartesian]
            : undefined
        }
      : truck.position
  }
}

export function upsertTruckState(collection, truck) {
  const index = collection.value.findIndex(item => item.truckId === truck.truckId)

  if (index >= 0) {
    Object.assign(collection.value[index], cloneTruckState(truck))
    collection.value = [...collection.value]
    return
  }

  collection.value = [...collection.value, cloneTruckState(truck)]
}

export function canInterpolateTruckPosition(previousPosition, nextPosition) {
  return hasValidCartesianArray(previousPosition) && hasValidCartesianArray(nextPosition)
}

export function interpolateTruckPosition(
  truckId,
  targetPosition,
  previousPositions,
  { now = performance.now(), durationMs = 200 } = {}
) {
  const previous = previousPositions.get(truckId)
  if (!previous) return targetPosition

  if (!canInterpolateTruckPosition(previous.position, targetPosition)) {
    previousPositions.delete(truckId)
    return targetPosition
  }

  const elapsed = now - previous.timestamp
  if (elapsed >= durationMs) {
    previousPositions.delete(truckId)
    return targetPosition
  }

  const progress = easeOutCubic(elapsed / durationMs)
  return {
    cartesian: previous.position.cartesian.map((value, index) =>
      lerp(value, targetPosition.cartesian[index], progress)
    ),
    longitude: lerp(previous.position.longitude, targetPosition.longitude, progress),
    latitude: lerp(previous.position.latitude, targetPosition.latitude, progress),
    height: lerp(previous.position.height || 0, targetPosition.height || 0, progress)
  }
}
