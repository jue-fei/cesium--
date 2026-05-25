import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import { useViewerStore } from '@/stores/viewerStore.js'

const DEFAULT_CESIUM_TOKEN = ''

export default function useViewer() {
  const store = useViewerStore()
  const { viewer: viewerRef, coordinateSystem, displayQuality, terrainQuality } = storeToRefs(store)

  const initToken = () => {
    if (typeof window !== 'undefined') {
      const token = import.meta.env.VITE_CESIUM_TOKEN || DEFAULT_CESIUM_TOKEN
      if (!token) {
        console.warn('Cesium Token 缺失，请在 .env 中设置 VITE_CESIUM_TOKEN。')
      }
      Cesium.Ion.defaultAccessToken = token
    }
  }

  const configureSceneLighting = viewerInstance => {
    if (!viewerInstance) return
    viewerInstance.scene.globe.enableLighting = false
    viewerInstance.scene.globe.dynamicAtmosphereLighting = false
    viewerInstance.scene.globe.dynamicAtmosphereLightingFromSun = false
  }

  const initViewer = async (containerId = 'cesiumContainer') => {
    if (viewerRef.value) return viewerRef.value

    initToken()

    const viewer = new Cesium.Viewer(containerId, {
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
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true
        }
      }
    })

    const creditContainer = viewer.cesiumWidget.creditContainer
    if (creditContainer) {
      creditContainer.style.display = 'none'
    }

    configureSceneLighting(viewer)
    store.setViewer(viewer)

    return viewer
  }

  const destroyViewer = () => {
    store.destroyViewer()
  }

  const resetViewToModel = async tileset => {
    const viewer = viewerRef.value
    if (viewer && tileset) {
      await viewer.zoomTo(tileset)
    }
  }

  const resetCursor = () => {
    const viewer = viewerRef.value
    if (viewer && viewer.canvas) {
      viewer.canvas.style.cursor = 'default'
    }
  }

  const toggleFullscreen = () => {
    const viewer = viewerRef.value
    if (!viewer) return
    if (!document.fullscreenElement) {
      const container = document.getElementById('cesiumContainer')
      if (container?.requestFullscreen) {
        container.requestFullscreen().catch(err => console.warn('Fullscreen failed:', err))
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen()
    }
  }

  const getViewer = () => {
    const viewer = viewerRef.value
    if (!viewer) return null
    if (typeof viewer.isDestroyed === 'function' && viewer.isDestroyed()) return null
    return viewer
  }

  return {
    viewerRef,
    viewer: viewerRef,
    initViewer,
    destroyViewer,
    resetCursor,
    toggleFullscreen,
    resetViewToModel,
    getViewer,

    coordinateSystem,
    displayQuality,
    terrainQuality,

    updateDisplayQuality: store.setDisplayQuality,
    updateTerrainQuality: store.setTerrainQuality,
    updateCoordinateSystem: store.setCoordinateSystem
  }
}
