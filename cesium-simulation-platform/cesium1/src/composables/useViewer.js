import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import { useViewerStore } from '@/stores/viewerStore.js'
import { getDisplayQualityProfile, getTerrainQualityProfile } from '@/features/shared/index.js'
import { logger } from '@/utils/logger.js'
import { getRenderEnhancementManager } from '@/features/lod-optimization/services/renderEnhancementManager.js'

const VIEWER_INIT_MARK_START = 'viewer-init:start'
const VIEWER_INIT_MARK_END = 'viewer-init:end'

export default function useViewer() {
  const store = useViewerStore()
  const { viewer, displayQuality, terrainQuality } = storeToRefs(store)

  const getViewer = () => {
    const v = viewer.value
    return v && !v.isDestroyed?.() ? v : null
  }

  const requestRender = () => getViewer()?.scene?.requestRender()

  const applyDisplayQuality = (quality = 'high') => {
    const v = getViewer()
    if (!v) return
    const p = getDisplayQualityProfile(quality)
    v.useBrowserRecommendedResolution = p.useBrowserRecommendedResolution
    v.resolutionScale = p.resolutionScale
    if (v.scene) {
      v.scene.fxaa = p.fxaa
      if (v.scene.postProcessStages?.fxaa) v.scene.postProcessStages.fxaa.enabled = p.fxaa
    }
    requestRender()
  }

  const applyTerrainQuality = (quality = 'high') => {
    const globe = getViewer()?.scene?.globe
    if (globe)
      globe.maximumScreenSpaceError = getTerrainQualityProfile(quality).maximumScreenSpaceError
    requestRender()
  }

  const initViewer = async (containerId = 'cesiumContainer') => {
    if (viewer.value) return viewer.value

    performance.mark(VIEWER_INIT_MARK_START)
    Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN || ''

    const v = new Cesium.Viewer(containerId, {
      baseLayer: false,           // 不加载影像底图（与模型预览页一致：深色背景而非地球影像）
      infoBox: false,
      timeline: false,
      animation: false,
      selectionIndicator: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      geocoder: false,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      fullscreenButton: false,
      contextOptions: { webgl: { preserveDrawingBuffer: true } }
    })

    // 深色底球 + 关闭雾效（与 输出/地表外场_3DTiles/preview.html 同配置）
    v.scene.globe.baseColor = Cesium.Color.fromCssColorString('#16202e')
    v.scene.fog.enabled = false

    // 真实地形开关：Cesium 相机控制器的移动/缩放步长会按"相机离地表（含地形）的高度"
    // 自动缩放，接入 World Terrain 后贴地时触感明显变慢，且地下/地上不一致。
    // 默认关闭（与模型预览页一致，移动触感全局均匀）；测量功能对椭球面地形采样返回 0 高度，
    // 与地形接入失败时的回退路径相同。需要真实地形时改回 true 即可。
    const ENABLE_WORLD_TERRAIN = false
    if (ENABLE_WORLD_TERRAIN) {
      try {
        const terrain = await Cesium.createWorldTerrainAsync()
        v.terrainProvider = terrain
        logger.info('viewer', 'Cesium World Terrain 已接入')
      } catch (terrainErr) {
        logger.warn('viewer', 'World Terrain 接入失败，回退椭球面', null, terrainErr)
      }
    }

    // MSAA 4x 对倾斜摄影/大面积纹理场景收益小、带宽开销大，默认关闭（省 10-20% 帧预算）
    try {
      v.scene.msaaSamples = 1
    } catch (msaaErr) {
      // WebGL1 或不支持时忽略
    }

    const cc = v.cesiumWidget.creditContainer
    if (cc) cc.style.display = 'none'

    // 初始保持光照关闭；渲染增强管理器 attach 后会按配置启用
    v.scene.globe.enableLighting = false
    v.scene.globe.dynamicAtmosphereLighting = false
    v.scene.globe.dynamicAtmosphereLightingFromSun = false

    applyDisplayQuality(displayQuality.value)
    applyTerrainQuality(terrainQuality.value)
    store.setViewer(v)
    // 调试暴露：控制台可用 __cesiumViewer 直接访问（诊断采样/拾取问题时使用）
    if (typeof window !== 'undefined') window.__cesiumViewer = v

    // 接入渲染增强（AO / 太阳光照 / 阴影）——解决单色模型细节看不清的问题
    try {
      const enhancement = getRenderEnhancementManager()
      enhancement.attach(v)
      logger.info('viewer', '渲染增强已挂载', {
        ambientOcclusion: enhancement.state.config.ambientOcclusion.enabled,
        lighting: enhancement.state.config.lighting.enabled,
        shadow: enhancement.state.config.shadow.enabled
      })
    } catch (err) {
      logger.warn('viewer', '渲染增强挂载失败', null, err)
    }

    performance.mark(VIEWER_INIT_MARK_END)
    performance.measure('viewer-init', VIEWER_INIT_MARK_START, VIEWER_INIT_MARK_END)
    logger.info('viewer', 'Cesium Viewer 初始化完成', {
      containerId,
      displayQuality: displayQuality.value,
      terrainQuality: terrainQuality.value
    })

    return v
  }

  const destroyViewer = () => store.destroyViewer()

  const resetViewToModel = async tileset => {
    const v = getViewer()
    if (v && tileset) await v.zoomTo(tileset)
  }

  const toggleFullscreen = () => {
    const v = getViewer()
    if (!v) return
    if (!document.fullscreenElement) {
      document.getElementById('cesiumContainer')?.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  const updateDisplayQuality = quality => {
    store.setDisplayQuality(quality)
    applyDisplayQuality(quality)
  }

  const updateTerrainQuality = quality => {
    store.setTerrainQuality(quality)
    applyTerrainQuality(quality)
  }

  return {
    viewer,
    getViewer,
    initViewer,
    destroyViewer,
    toggleFullscreen,
    resetViewToModel,
    displayQuality,
    terrainQuality,
    applyDisplayQuality,
    applyTerrainQuality,
    updateDisplayQuality,
    updateTerrainQuality,
    updateCoordinateSystem: store.setCoordinateSystem,
    renderEnhancement: getRenderEnhancementManager()
  }
}
