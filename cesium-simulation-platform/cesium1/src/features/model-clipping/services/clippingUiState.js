export function createClippingUiState({ store, removePolygonHandler }) {
  function resetPolygonDrawingState() {
    store.isDrawingPolygon = false
    removePolygonHandler()
  }

  function resetPolygonUiState() {
    store.setPolygonClippingEnabled(false)
    store.setPolygonVertices([])
    resetPolygonDrawingState()
  }

  function resetPolygonOptionsState() {
    store.polygonDepth = 0
    store.polygonDirection = 'excavate'
    store.polygonVisualizationOpacity = 0.35
    store.setPolygonVertices([])
    resetPolygonDrawingState()
  }

  return {
    resetPolygonDrawingState,
    resetPolygonUiState,
    resetPolygonOptionsState
  }
}
