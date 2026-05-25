import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { createClippingManagerRuntime } from './clippingManagerRuntime.js'
import { createPolygonHandlerController } from './clippingPolygonHandler.js'
import { createClippingUiState } from './clippingUiState.js'
import { createClippingPlaneActions } from './clippingPlaneActions.js'
import { createClippingPolygonActions } from './clippingPolygonActions.js'
import {
  notifyActionResult,
  syncPolygonStateToStore,
  updatePlaneStoreState
} from './clippingStateSync.js'
import useViewer from '@/composables/useViewer.js'
import { useModelState } from '@/features/model-control/services/useModel.js'
import useMessage from '@/composables/useMessage.js'
import { useClippingStore } from '../../../stores/clippingStore.js'

export default function useClipping() {
  const { showOperationMessage } = useMessage()
  const { viewer: globalViewer, getViewer } = useViewer()
  const { tileset: tilesetRef } = useModelState()

  const store = useClippingStore()
  const { setupPolygonHandler, removePolygonHandler } = createPolygonHandlerController()
  const { ensureClippingManager, destroyClippingManager, syncManagerTileset } =
    createClippingManagerRuntime({
      getViewer,
      tilesetRef
    })
  const {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,
    polygonVisualizationOpacity
  } = storeToRefs(store)
  const { resetPolygonUiState, resetPolygonOptionsState } = createClippingUiState({
    store,
    removePolygonHandler
  })

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
      destroyClippingManager()
      removePolygonHandler()
      store.resetAll()
      return
    }

    ensureClippingManager()
  })

  // 监听瓦片集变化
  watch(tilesetRef, () => {
    syncManagerTileset()
  })

  const syncPolygonState = manager => {
    syncPolygonStateToStore(store, manager)
  }

  const updateStoreState = manager => {
    updatePlaneStoreState(store, manager)
  }

  const withManager = (action, options = {}) => {
    const manager = ensureClippingManager()
    if (!manager) {
      if (options.onMissingMessage) showOperationMessage(options.onMissingMessage, 'error')
      return undefined
    }
    return action(manager)
  }
  const runManagerAction = (mutate, options = {}) => {
    const {
      onSuccess,
      successType = 'success',
      errorType = 'error',
      onMissingMessage = '切割管理器初始化失败'
    } = options
    return withManager(
      manager => {
        const result = mutate(manager)
        notifyActionResult(showOperationMessage, result, {
          successType,
          errorType,
          onSuccess: () => {
            if (typeof onSuccess === 'function') onSuccess(manager, result)
          }
        })
        return result
      },
      { onMissingMessage }
    )
  }
  const notifyAction = (result, options = {}) =>
    notifyActionResult(showOperationMessage, result, options)

  const planeActions = createClippingPlaneActions({
    store,
    clippingEnabled,
    withManager,
    runManagerAction,
    updateStoreState,
    notifyAction,
    showOperationMessage
  })

  const polygonActions = createClippingPolygonActions({
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
  })

  return {
    clippingEnabled,
    clippingPlanes,
    activePlaneIndex,
    activePlaneConfig,
    polygonClippingEnabled,
    isDrawingPolygon,
    polygonDepth,
    polygonDirection,
    polygonVisualizationOpacity,

    initClippingManager,
    ...planeActions,
    ...polygonActions
  }
}
