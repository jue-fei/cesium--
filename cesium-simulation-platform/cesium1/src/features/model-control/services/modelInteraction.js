import * as Cesium from 'cesium'
import { storeToRefs } from 'pinia'
import { reactive } from 'vue'
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
      const pickedFeature = viewer.scene.pick(click.position)
      if (!Cesium.defined(pickedFeature)) return

      if (
        pickedFeature.primitive === tileset.value &&
        pickedFeature instanceof Cesium.Cesium3DTileFeature
      ) {
        if (measurementState.isMeasuring.value || measurementState.isAreaMeasuring.value) return
        onFeatureClick(pickedFeature)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    modelClickHandlerRef.value = nextHandler
  }

  function handleModelSelection(feature, modelListRef, selectedModelRef) {
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

  function highlightModel(model) {
    featureManager.highlightModel(model)
  }

  function updateModelColor(model, color) {
    featureManager.updateModelColor(model, color, globalOpacity.value)
  }

  return {
    toggleModelVisibility,
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
