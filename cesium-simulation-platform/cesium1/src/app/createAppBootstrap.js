import { loadApiConfig } from '@/services/api/initApiConfig.js'
import twinClient from '@/services/fusion/twinClient.js'

export function createAppBootstrap({
  viewer,
  model,
  clipping,
  geology,
  blasting,
  measurement,
  lifecycle
}) {
  let isStarted = false

  async function start(containerId = 'cesiumContainer') {
    if (isStarted) return viewer.getViewer?.() || null

    // 从数据库加载所有配置（模型/设置/监测/应力等）
    await loadApiConfig()

    // 孪生事件流：与视图初始化解耦，连接失败不影响主流程（内部自动重连）
    twinClient.connect()

    const viewerInstance = await viewer.initViewer(containerId)
    if (!viewerInstance) return null

    try {
      lifecycle?.notifyViewer?.(viewerInstance)
      await model.initModel()
      clipping.initClippingManager()
      geology.initGeologyManager(viewerInstance)
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
