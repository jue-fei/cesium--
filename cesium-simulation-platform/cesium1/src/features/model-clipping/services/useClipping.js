import { computed, ref, watch } from 'vue'
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
import useModel, { useModelState } from '@/features/model-control/services/useModel.js'
import useMessage from '@/composables/useMessage.js'
import { useClippingStore } from '../../../stores/clippingStore.js'

// 切割基准半径（选中模型包围球半径，米）与面板量程信息：0 = 回退整场景。
// 模块级共享：useClipping 在 App / 系统工具 / 面板多处实例化，基准必须全局一致。
const clipRangeInfo = ref({ focusRadius: 0, sceneRadius: 0, centerOffset: 0 })

export default function useClipping() {
  const { showOperationMessage } = useMessage()
  const { viewer: globalViewer, getViewer } = useViewer()
  const { tileset: tilesetRef, selectedModel } = useModelState()
  const model = useModel()

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
    syncClipFocus()
  }

  /**
   * 切割基准跟随选中模型：偏移 0 = 刀面穿过该模型包围球中心，
   * 量程按模型半径缩放（见 useClippingPanelController.positionRange）。
   * 未选中/要素未加载时回退整场景包围球中心。
   */
  function syncClipFocus() {
    const manager = ensureClippingManager()
    if (!manager) return
    let bounds = null
    try {
      bounds = selectedModel.value ? model.getModelBounds?.(selectedModel.value) : null
    } catch (_) {
      bounds = null
    }
    manager.setClipFocus(bounds || null)
    clipRangeInfo.value = manager.getClipRangeInfo()
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
    syncClipFocus()
  })

  // 监听瓦片集变化（换模型后重建切割基准）
  watch(tilesetRef, () => {
    syncManagerTileset()
    syncClipFocus()
  })

  // 监听选中模型（场景点击/列表选中）→ 切换切割基准
  watch(selectedModel, () => syncClipFocus())

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
    clipRangeInfo,

    initClippingManager,
    ...planeActions,
    ...polygonActions
  }
}
