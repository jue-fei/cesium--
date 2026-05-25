export function createClippingPolygonActions({
  store,
  globalViewer,
  polygonClippingEnabled,
  withManager,
  runManagerAction,
  syncPolygonState,
  notifyAction,
  setupPolygonHandler,
  removePolygonHandler,
  resetPolygonUiState,
  resetPolygonOptionsState
}) {
  const togglePolygonClipping = () => {
    withManager(
      manager => {
        if (polygonClippingEnabled.value) {
          const result = manager.disablePolygonClipping()
          notifyAction(result, {
            successType: 'info',
            errorType: 'info',
            onSuccess: resetPolygonUiState
          })
          return
        }
        const result = manager.enablePolygonClipping()
        store.setPolygonClippingEnabled(result.success)
        notifyAction(result, {
          onSuccess: () => syncPolygonState(manager)
        })
      },
      { onMissingMessage: '切割管理器初始化失败' }
    )
  }

  const toggleDrawingPolygon = () => {
    withManager(manager => {
      const result = manager.toggleDrawingPolygon()
      notifyAction(result, {
        onSuccess: () => {
          syncPolygonState(manager)
          store.setIsDrawingPolygon(manager.isDrawingPolygon)
          if (manager.isDrawingPolygon) {
            setupPolygonHandler({
              viewer: globalViewer.value,
              manager,
              onLeftClick: nextManager => syncPolygonState(nextManager),
              onRightClick: () => toggleDrawingPolygon()
            })
          } else {
            removePolygonHandler()
          }
        }
      })
    })
  }

  const clearAllPolygons = () => {
    runManagerAction(manager => manager.clearAllPolygons(), {
      onSuccess: manager => {
        syncPolygonState(manager)
        resetPolygonUiState()
      }
    })
  }

  const updatePolygonDepth = depth => {
    store.polygonDepth = Number(depth) || 0
    withManager(manager => {
      const result = manager.setPolygonDepth(depth)
      notifyAction(result, { successType: 'info', errorType: 'error' })
      syncPolygonState(manager)
    })
  }

  const updatePolygonDirection = direction => {
    store.polygonDirection = direction
    withManager(manager => {
      const result = manager.setPolygonDirection(direction)
      notifyAction(result)
      syncPolygonState(manager)
    })
  }

  const updatePolygonVisualizationOpacity = opacity => {
    store.polygonVisualizationOpacity = Math.max(0, Math.min(1, Number(opacity) || 0))
    withManager(manager => {
      const result = manager.setPolygonVisualizationOpacity(opacity)
      notifyAction(result, { successType: 'info', errorType: 'error' })
      syncPolygonState(manager)
    })
  }

  const resetPolygonSettings = () => {
    runManagerAction(manager => manager.resetPolygonSettings(), {
      onSuccess: manager => {
        syncPolygonState(manager)
        resetPolygonOptionsState()
      }
    })
  }

  return {
    togglePolygonClipping,
    toggleDrawingPolygon,
    clearAllPolygons,
    updatePolygonDepth,
    updatePolygonDirection,
    updatePolygonVisualizationOpacity,
    resetPolygonSettings
  }
}
