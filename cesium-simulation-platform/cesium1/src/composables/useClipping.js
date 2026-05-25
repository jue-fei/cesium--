import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import ClippingManager from '../features/model/clipping/clippingManager.js'
import useViewer from '@/composables/useViewer.js'
import useModel from './useModel.js'
import useMessage from '@/composables/useMessage.js'
import { useClippingStore } from '../stores/clippingStore.js'

// 内部单例状态
let clippingManager = null
let polygonHandler = null

export default function useClipping() {
  const { showOperationMessage } = useMessage()
  const { viewer: globalViewer, getViewer } = useViewer()
  const { tilesetRef } = useModel()

  const store = useClippingStore()
  const {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection
  } = storeToRefs(store)

  const ensureClippingManager = () => {
    const viewer = getViewer()
    if (!viewer) return null

    const currentViewer = clippingManager?.viewer
    const currentViewerDestroyed =
      currentViewer &&
      typeof currentViewer.isDestroyed === 'function' &&
      currentViewer.isDestroyed()

    if (!clippingManager || !currentViewer || currentViewerDestroyed || currentViewer !== viewer) {
      try {
        if (clippingManager?.destroy) {
          clippingManager.destroy()
        }
      } catch (e) {
        console.warn('Failed to destroy clipping manager', e)
      }
      clippingManager = new ClippingManager(viewer)
      clippingManager.setTileset(tilesetRef.value || null)
    }

    return clippingManager
  }

  // 计算属性
  const activePlaneConfig = computed(() => {
    if (activePlaneIndex.value === null || !clippingPlanes.value[activePlaneIndex.value]) {
      return null
    }
    return clippingPlanes.value[activePlaneIndex.value]
  })

  const initClippingManager = () => {
    ensureClippingManager()
  }

  // 监听查看器变化
  watch(globalViewer, newViewer => {
    if (!newViewer || (typeof newViewer.isDestroyed === 'function' && newViewer.isDestroyed())) {
      try {
        if (clippingManager?.destroy) {
          clippingManager.destroy()
        }
      } catch (e) {
        console.warn('Failed to destroy clipping manager', e)
      }
      clippingManager = null
      if (polygonHandler && !polygonHandler.isDestroyed()) {
        polygonHandler.destroy()
      }
      polygonHandler = null
      store.resetAll()
      return
    }

    ensureClippingManager()
  })

  // 监听瓦片集变化
  watch(tilesetRef, newTileset => {
    const manager = ensureClippingManager()
    if (manager) {
      manager.setTileset(newTileset || null)
    }
  })

  // 辅助方法
  const getClippingManager = () => clippingManager

  const removePolygonHandler = () => {
    if (polygonHandler) {
      if (!polygonHandler.isDestroyed()) {
        polygonHandler.destroy()
      }
      polygonHandler = null
    }
  }

  const setupPolygonHandler = manager => {
    removePolygonHandler()

    const viewer = globalViewer.value
    if (!viewer || !manager) return

    polygonHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    polygonHandler.setInputAction(movement => {
      manager.handleMouseClick(movement)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    polygonHandler.setInputAction(() => {
      toggleDrawingPolygon()
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
  }

  const updateStoreState = manager => {
    if (!manager) return
    store.setClippingPlanes(manager.getAllPlaneConfigs())
    store.setActivePlaneIndex(manager.activeClippingPlaneIndex)
  }

  // 操作方法
  const toggleClipping = () => {
    const manager = ensureClippingManager()
    if (!manager) {
      showOperationMessage('切割管理器初始化失败', 'error')
      return
    }

    if (clippingEnabled.value) {
      const result = manager.disableClipping()
      store.resetAll()
      showOperationMessage(result.message, 'info')
    } else {
      const result = manager.enableClipping()
      store.setClippingEnabled(result.success)
      if (result.success) {
        updateStoreState(manager)
        showOperationMessage(result.message, 'success')
      } else {
        showOperationMessage(result.message, 'error')
      }
    }
  }

  const addClippingPlane = () => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.addClippingPlane()
    if (result.success) {
      updateStoreState(manager)
      showOperationMessage(result.message, 'success')
    } else {
      showOperationMessage(result.message, 'error')
    }
  }

  const removeClippingPlane = index => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.removeClippingPlane(index)
    if (result.success) {
      updateStoreState(manager)
      showOperationMessage(result.message, 'success')
    } else {
      showOperationMessage(result.message, 'error')
    }
  }

  const setActiveClippingPlane = index => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.setActivePlane(index)
    if (result.success) {
      store.setActivePlaneIndex(index)
      showOperationMessage(result.message, 'success')
    } else {
      showOperationMessage(result.message, 'error')
    }
  }

  const updateClippingPlane = ({ index, ...params }) => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.updateClippingPlane(index, params)
    if (result.success) {
      updateStoreState(manager)
    }
    return result
  }

  // 针对具体字段的封装
  const updateClippingPlaneDistance = params => updateClippingPlane(params)
  const updateClippingPlaneRotation = params => updateClippingPlane(params)
  const updateClippingPlaneOpacity = params => updateClippingPlane(params)
  const updateClippingPlaneColor = params => updateClippingPlane(params)
  const updateClippingPlaneAxis = params => updateClippingPlane(params)
  const updateClippingPlaneDirection = params => updateClippingPlane(params)

  const resetClippingPlane = index => {
    if (!clippingManager) return

    const result = updateClippingPlane({
      index,
      distance: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
      opacity: 0.0,
      color: '#ffffff'
    })

    if (result.success) {
      showOperationMessage('切割面已重置', 'success')
    }
  }

  const clearAllClippingPlanes = () => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.clearAllPlanes()
    if (result.success) {
      store.setClippingPlanes([])
      store.setActivePlaneIndex(null)
      showOperationMessage(result.message, 'success')
    }
  }

  const resetClipping = () => {
    clearAllClippingPlanes()
    store.setClippingEnabled(false)
    const manager = ensureClippingManager()
    if (manager) {
      manager.disableClipping()
    }
    showOperationMessage('切割功能已重置', 'success')
  }

  // ===== Polygon Clipping Methods =====
  const togglePolygonClipping = () => {
    const manager = ensureClippingManager()
    if (!manager) {
      showOperationMessage('切割管理器初始化失败', 'error')
      return
    }

    if (polygonClippingEnabled.value) {
      const result = manager.disablePolygonClipping()
      store.setPolygonClippingEnabled(false)
      store.setIsDrawingPolygon(false)
      removePolygonHandler()
      showOperationMessage(result.message, 'info')
    } else {
      const result = manager.enablePolygonClipping()
      store.setPolygonClippingEnabled(result.success)
      if (result.success) {
        showOperationMessage(result.message, 'success')
      } else {
        showOperationMessage(result.message, 'error')
      }
    }
  }

  const toggleDrawingPolygon = () => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.toggleDrawingPolygon()
    if (result.success) {
      store.setIsDrawingPolygon(manager.isDrawingPolygon)
      if (manager.isDrawingPolygon) {
        setupPolygonHandler(manager)
      } else {
        removePolygonHandler()
      }
      showOperationMessage(result.message, 'success')
    } else {
      showOperationMessage(result.message, 'error')
    }
  }

  const handlePolygonMouseClick = movement => {
    const manager = ensureClippingManager()
    if (!manager) return
    manager.handleMouseClick(movement)
  }

  const clearAllPolygons = () => {
    const manager = ensureClippingManager()
    if (!manager) return

    const result = manager.clearAllPolygons()
    store.setPolygonClippingEnabled(false)
    store.setIsDrawingPolygon(false)
    removePolygonHandler()
    showOperationMessage(result.message, 'success')
  }

  const updatePolygonDepth = depth => {
    const manager = ensureClippingManager()
    if (!manager) return
    store.polygonDepth = Number(depth)
    const result = manager.setPolygonDepth(depth)
    void result
  }

  const updatePolygonDirection = direction => {
    const manager = ensureClippingManager()
    if (!manager) return
    store.polygonDirection = direction
    const result = manager.setPolygonDirection(direction)
    if (result.success) {
      showOperationMessage(result.message, 'success')
    }
  }

  const resetPolygonSettings = () => {
    const manager = ensureClippingManager()
    if (!manager) return
    const result = manager.resetPolygonSettings()
    if (result.success) {
      store.polygonDepth = 0
      store.polygonDirection = 'excavate'
      store.isDrawingPolygon = false
      removePolygonHandler()
      showOperationMessage(result.message, 'success')
    }
  }

  return {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    activePlaneConfig,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,

    initClippingManager,
    getClippingManager,
    toggleClipping,
    addClippingPlane,
    removeClippingPlane,
    setActiveClippingPlane,
    updateClippingPlaneDistance,
    updateClippingPlaneRotation,
    updateClippingPlaneOpacity,
    updateClippingPlaneColor,
    updateClippingPlaneAxis,
    updateClippingPlaneDirection,
    resetClippingPlane,
    clearAllClippingPlanes,
    resetClipping,
    togglePolygonClipping,
    toggleDrawingPolygon,
    handlePolygonMouseClick,
    clearAllPolygons,
    updatePolygonDepth,
    updatePolygonDirection,
    resetPolygonSettings
  }
}
