import * as Cesium from 'cesium'
import { storeToRefs } from 'pinia'
import { reactive, watch } from 'vue'
import { FeatureManager } from './featureManager.js'
import { createDefaultModelData } from './modelListCore.js'
import { useModelStore } from '../../../stores/modelStore.js'
import { useMeasurementStore } from '../../../stores/measurementStore.js'
import useMessage from '@/composables/useMessage.js'

function getFeatureNameFromFeature(feature) {
  try {
    if (feature) {
      return (
        feature.getProperty('name') ||
        feature.getProperty('Name') ||
        feature.getProperty('description') ||
        'Unknown Model'
      )
    }
  } catch (_) {
    /* ignore */
  }
  return 'Unknown Model'
}

function resetModelClickHandler(modelClickHandlerRef) {
  if (!modelClickHandlerRef.value) return
  try {
    modelClickHandlerRef.value.destroy()
  } catch (_) {
    /* ignore */
  }
  modelClickHandlerRef.value = null
}

function createSelectionHelpers({
  featureManager,
  globalOpacity,
  showOperationMessage,
  measurementState
}) {
  function getFeatureNameById(featureId) {
    return getFeatureNameFromFeature(featureManager.featureMap.get(featureId))
  }

  function scanAndStoreFeatures(tileset) {
    if (tileset && featureManager.getFeatureCount() === 0) {
      featureManager.setTileset(tileset)
      featureManager.scanAndStoreFeatures()
    }
  }

  function initModelEventHandler(viewer, tileset, onFeatureClick, modelClickHandlerRef) {
    if (!viewer) return
    resetModelClickHandler(modelClickHandlerRef)

    const nextHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    nextHandler.setInputAction(click => {
      if (!tileset.value) return
      if (
        featureManager.highlightLocked ||
        measurementState.isMeasuring.value ||
        measurementState.isAreaMeasuring.value
      )
        return

      // drillPick 穿透拾取：被隐藏（透明度 0 / visible=false）的要素仍会进入
      // GPU 拾取缓冲，单次 scene.pick 会被"看不见的地表瓦片"挡住井下目标；
      // 因此逐层检查要素可见性状态，取第一个真正可见的本模型要素。
      const pickedList = viewer.scene.drillPick(click.position, 8) || []
      let pickedFeature = null
      for (let i = 0; i < pickedList.length; i++) {
        const p = pickedList[i]
        if (!p || !(p instanceof Cesium.Cesium3DTileFeature)) continue
        if (p.primitive !== tileset.value) continue
        const fid = featureManager.getFeatureId(p)
        const st = featureManager.styleState && featureManager.styleState.get(fid)
        if (st) {
          // styleState.opacity 为 UI 百分比语义：0 = 不透明，100 = 全透明
          if (!st.visible) continue
          if (Number(st.opacity) >= 99.5) continue
        }
        pickedFeature = p
        break
      }
      if (pickedFeature) {
        // 点击反馈 = 选中持续高亮（由 createModelService 的 selectedModel watcher 统一驱动）
        onFeatureClick(pickedFeature)
      } else {
        // 点击空白处：清除选中（高亮消失、属性面板收起），与模型预览页行为一致
        onFeatureClick(null)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    modelClickHandlerRef.value = nextHandler
  }

  function handleModelSelection(feature, modelListRef, selectedModelRef) {
    // 双保险：测量模式（距离/面积）激活期间，点击模型一律不触发选中高亮与透明响应
    if (featureManager.highlightLocked) return
    if (measurementState.isMeasuring.value || measurementState.isAreaMeasuring.value) return
    const featureId = featureManager.getFeatureId(feature)
    if (!featureId) {
      showOperationMessage('无法获取模型特征ID', 'error')
      return
    }

    const model = modelListRef.value.find(item => (item.featureId || item.id) === featureId)
    if (model) {
      selectedModelRef.value = model
      if (!model.visible) {
        model.visible = true
        featureManager.toggleModelVisibility(model, globalOpacity.value)
      }
      showOperationMessage(`已选中模型: ${model.name}`, 'success')
      return
    }

    const tempModel = reactive(createDefaultModelData(featureId, `未分类模型 (${featureId})`))
    modelListRef.value.push(tempModel)
    selectedModelRef.value = tempModel
  }

  return {
    getFeatureNameById,
    scanAndStoreFeatures,
    initModelEventHandler,
    handleModelSelection
  }
}

function createVisibilityHelpers({ featureManager, globalOpacity, showOperationMessage }) {
  function toggleModelVisibility(model) {
    const result = featureManager.toggleModelVisibility(model, globalOpacity.value)
    showOperationMessage(result.message, result.success ? 'success' : 'warning')
  }

  function updateModelOpacity(model) {
    featureManager.updateModelOpacity(model, globalOpacity.value)
  }

  function updateGlobalOpacity(newOpacity, modelListRef) {
    const opacityValue = Number(newOpacity)
    modelListRef.value.forEach(model => featureManager.updateModelOpacity(model, opacityValue))
  }

  function resetAllOpacity(modelListRef) {
    modelListRef.value.forEach(model => {
      model.opacity = 0
    })
    featureManager.resetAllOpacity(modelListRef.value, globalOpacity.value)
  }

  function showAllModels(modelListRef) {
    featureManager.showAllModels(modelListRef.value, globalOpacity.value)
  }

  function hideAllModels(modelListRef) {
    featureManager.hideAllModels(modelListRef.value)
  }

  function showOnlyModel(model, modelListRef) {
    modelListRef.value.forEach(item => {
      item.visible = item.id === model.id
      featureManager.toggleModelVisibility(item, globalOpacity.value)
    })
    showOperationMessage(`仅显示模型: ${model.name}`, 'success')
  }

  // 批量设置可见性（分组显隐用）：无 toast，强制全量应用——
  // 历史失效渲染残留（visible 已是目标状态但 color/show 未生效的组件）
  // 只有重新应用才会被清除；循环内跳过 style 重建，结束后统一重建一次
  function setModelsVisibility(models, visible) {
    models.forEach(model => {
      model.visible = visible
      featureManager.toggleModelVisibility(model, globalOpacity.value, true)
    })
    if (featureManager.applyVisibilityStyle) featureManager.applyVisibilityStyle()
  }

  function highlightModel(model) {
    featureManager.highlightModel(model)
  }

  function updateModelColor(model, color) {
    featureManager.updateModelColor(model, color, globalOpacity.value)
  }

  return {
    toggleModelVisibility,
    setModelsVisibility,
    updateModelOpacity,
    updateGlobalOpacity,
    resetAllOpacity,
    showAllModels,
    hideAllModels,
    showOnlyModel,
    highlightModel,
    updateModelColor
  }
}

function createDatabaseSyncHelpers(featureManager) {
  function syncDbModelsWithFeatures(modelListRef) {
    if (featureManager.getFeatureCount() === 0) return

    const featureIds = new Set(featureManager.getAllFeatureIds())
    const featureEntries = Array.from(featureManager.featureMap.entries())
    modelListRef.value.forEach(model => {
      const featureId = model.featureId || model.id
      if (featureIds.has(featureId)) {
        model._dbLinked = true
        return
      }

      const modelName = (model.name || '').toLowerCase().trim()
      if (!modelName) return

      for (const [entryId, feature] of featureEntries) {
        try {
          const featureName = String(
            feature.getProperty('name') || feature.getProperty('Name') || ''
          )
            .toLowerCase()
            .trim()
          if (featureName && featureName === modelName) {
            model.featureId = entryId
            model._dbLinked = true
            return
          }
        } catch (_) {
          /* ignore */
        }
      }
    })
  }

  return { syncDbModelsWithFeatures }
}

/**
 * 模型交互管理器
 * 负责：点击检测、模型选中、特征管理、可见性/透明度控制
 */
export function createModelInteractionManager() {
  const store = useModelStore()
  const { globalOpacity } = storeToRefs(store)
  const measurementStore = useMeasurementStore()
  const { isMeasuring, isAreaMeasuring } = storeToRefs(measurementStore)
  const { showOperationMessage } = useMessage()

  const featureManager = new FeatureManager()
  const modelClickHandlerRef = { value: null }
  const selectionHelpers = createSelectionHelpers({
    featureManager,
    globalOpacity,
    showOperationMessage,
    measurementState: { isMeasuring, isAreaMeasuring }
  })
  const visibilityHelpers = createVisibilityHelpers({
    featureManager,
    globalOpacity,
    showOperationMessage
  })
  const databaseSyncHelpers = createDatabaseSyncHelpers(featureManager)

  // 测量模式锁定：进入测量（距离/面积）瞬间清除既有高亮并锁死点击选中，
  // 退出测量后恢复点击选中交互。与点击/选中入口的守卫构成三重保障。
  watch([isMeasuring, isAreaMeasuring], ([measuring, areaMeasuring]) => {
    featureManager.setHighlightLocked(!!(measuring || areaMeasuring))
  })

  function disableSelection() {
    if (modelClickHandlerRef.value) {
      modelClickHandlerRef.value.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }
  }

  function enableSelection() {
    if (modelClickHandlerRef.value) {
      modelClickHandlerRef.value.setInputAction(() => {
        // re-enable handled by initModelEventHandler
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }
  }

  function destroy() {
    resetModelClickHandler(modelClickHandlerRef)
    featureManager.destroy()
  }

  return {
    featureManager,
    modelClickHandler: () => modelClickHandlerRef.value,
    getFeatureNameById: selectionHelpers.getFeatureNameById,
    scanAndStoreFeatures: selectionHelpers.scanAndStoreFeatures,
    initModelEventHandler: (viewer, tileset, onFeatureClick) =>
      selectionHelpers.initModelEventHandler(viewer, tileset, onFeatureClick, modelClickHandlerRef),
    handleModelSelection: selectionHelpers.handleModelSelection,
    toggleModelVisibility: visibilityHelpers.toggleModelVisibility,
    setModelsVisibility: visibilityHelpers.setModelsVisibility,
    updateModelOpacity: visibilityHelpers.updateModelOpacity,
    updateGlobalOpacity: visibilityHelpers.updateGlobalOpacity,
    resetAllOpacity: visibilityHelpers.resetAllOpacity,
    showAllModels: visibilityHelpers.showAllModels,
    hideAllModels: visibilityHelpers.hideAllModels,
    showOnlyModel: visibilityHelpers.showOnlyModel,
    highlightModel: visibilityHelpers.highlightModel,
    updateModelColor: visibilityHelpers.updateModelColor,
    disableSelection,
    enableSelection,
    syncDbModelsWithFeatures: databaseSyncHelpers.syncDbModelsWithFeatures,
    destroy
  }
}
