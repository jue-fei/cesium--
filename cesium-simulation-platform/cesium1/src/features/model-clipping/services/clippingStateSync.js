export function getPolygonPositions(manager) {
  if (Array.isArray(manager?.lastPolygonPositions)) return manager.lastPolygonPositions
  if (Array.isArray(manager?.currentPolygon)) return manager.currentPolygon
  return []
}

export function serializePolygonPositions(positions) {
  return positions.map(pos => ({
    x: Number(pos?.x) || 0,
    y: Number(pos?.y) || 0,
    z: Number(pos?.z) || 0
  }))
}

export function syncPolygonStateToStore(store, manager) {
  if (!manager) return
  store.setPolygonVertices(serializePolygonPositions(getPolygonPositions(manager)))
  store.polygonDepth = Number(manager.polygonDepth) || 0
  store.polygonDirection = manager.polygonDirection || 'excavate'
  store.polygonVisualizationOpacity = Number(manager.polygonVisualizationOpacity) || 0.35
}

export function updatePlaneStoreState(store, manager) {
  if (!manager) return
  store.setClippingPlanes(manager.getAllPlaneConfigs())
  store.setActivePlaneIndex(manager.activeClippingPlaneIndex)
}

export function notifyActionResult(showOperationMessage, result, options = {}) {
  if (!result || !result.message) return
  const { successType = 'success', errorType = 'error', onSuccess, onError } = options
  if (result.success) {
    if (typeof onSuccess === 'function') onSuccess()
    showOperationMessage(result.message, successType)
    return
  }
  if (typeof onError === 'function') onError()
  showOperationMessage(result.message, errorType)
}
