export function createAppBootstrap({
  viewer,
  model,
  clipping,
  geology,
  monitoring,
  blasting,
  measurement,
  lifecycle
}) {
  let isStarted = false

  async function start(containerId = 'cesiumContainer') {
    if (isStarted) return viewer.getViewer?.() || null

    const viewerInstance = await viewer.initViewer(containerId)
    if (!viewerInstance) return null

    try {
      lifecycle?.notifyViewer?.(viewerInstance)
      await model.initModel()
      clipping.initClippingManager()
      geology.initGeologyManager(viewerInstance)
      await monitoring.initMonitoringManager(viewerInstance)
      blasting.initBlastingManager(viewerInstance)
      measurement.loadMeasurementHistory?.()
      model.startGlobalFpsMonitoring?.()
      isStarted = true
      return viewerInstance
    } catch (error) {
      stop()
      throw error
    }
  }

  function stop() {
    model.stopGlobalFpsMonitoring?.()
    lifecycle?.destroyAll?.()
    monitoring.destroyMonitoringManager?.()
    model.destroyModel?.()
    viewer.destroyViewer?.()
    isStarted = false
  }

  return {
    start,
    stop,
    get isStarted() {
      return isStarted
    }
  }
}
