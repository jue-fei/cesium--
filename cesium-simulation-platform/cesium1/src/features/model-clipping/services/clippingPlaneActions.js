export function createClippingPlaneActions({
  store,
  clippingEnabled,
  withManager,
  runManagerAction,
  updateStoreState,
  notifyAction,
  showOperationMessage
}) {
  const updateClippingPlane = ({ index, ...params }) => {
    return withManager(manager => {
      const result = manager.updateClippingPlane(index, params)
      if (result.success) updateStoreState(manager)
      return result
    })
  }

  const toggleClipping = () => {
    withManager(
      manager => {
        if (clippingEnabled.value) {
          const result = manager.disableClipping()
          store.resetAll()
          notifyAction(result, { successType: 'info', errorType: 'error' })
          return
        }
        const result = manager.enableClipping()
        store.setClippingEnabled(result.success)
        notifyAction(result, {
          onSuccess: () => updateStoreState(manager)
        })
      },
      { onMissingMessage: '切割管理器初始化失败' }
    )
  }

  const addClippingPlane = () => {
    runManagerAction(manager => manager.addClippingPlane(), {
      onSuccess: manager => updateStoreState(manager)
    })
  }

  const removeClippingPlane = index => {
    runManagerAction(manager => manager.removeClippingPlane(index), {
      onSuccess: manager => updateStoreState(manager)
    })
  }

  const setActiveClippingPlane = index => {
    runManagerAction(manager => manager.setActivePlane(index), {
      onSuccess: () => store.setActivePlaneIndex(index)
    })
  }

  const resetClippingPlane = index => {
    const result = updateClippingPlane({
      index,
      distance: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      opacity: 0.0,
      color: '#ffffff'
    })
    notifyAction(
      {
        ...(result || {}),
        message: result?.success ? '切割面已重置' : result?.message
      },
      { successType: 'success', errorType: 'error' }
    )
  }

  const clearAllClippingPlanes = () => {
    runManagerAction(manager => manager.clearAllPlanes(), {
      onSuccess: () => {
        store.setClippingPlanes([])
        store.setActivePlaneIndex(null)
      }
    })
  }

  const resetClipping = () => {
    clearAllClippingPlanes()
    store.setClippingEnabled(false)
    withManager(manager => manager.disableClipping())
    showOperationMessage('切割功能已重置', 'success')
  }

  return {
    toggleClipping,
    addClippingPlane,
    removeClippingPlane,
    setActiveClippingPlane,
    updateClippingPlane,
    updateClippingPlaneDistance: params => updateClippingPlane(params),
    updateClippingPlaneRotation: params => updateClippingPlane(params),
    updateClippingPlaneOpacity: params => updateClippingPlane(params),
    updateClippingPlaneColor: params => updateClippingPlane(params),
    updateClippingPlaneAxis: params => updateClippingPlane(params),
    updateClippingPlaneDirection: params => updateClippingPlane(params),
    resetClippingPlane,
    clearAllClippingPlanes,
    resetClipping
  }
}
