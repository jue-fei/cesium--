import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import { useViewerStore } from '@/stores/viewerStore.js'
import {
  getDisplayQualityProfile,
  getTerrainQualityProfile
} from '@/features/lod-optimization/services/viewerQualityProfiles.js'

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

    Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN || ''

    const v = new Cesium.Viewer(containerId, {
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
      terrainProvider: undefined,
      contextOptions: { webgl: { preserveDrawingBuffer: true } }
    })

    const cc = v.cesiumWidget.creditContainer
    if (cc) cc.style.display = 'none'

    v.scene.globe.enableLighting = false
    v.scene.globe.dynamicAtmosphereLighting = false
    v.scene.globe.dynamicAtmosphereLightingFromSun = false

    applyDisplayQuality(displayQuality.value)
    applyTerrainQuality(terrainQuality.value)
    store.setViewer(v)

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
    updateCoordinateSystem: store.setCoordinateSystem
  }
}
