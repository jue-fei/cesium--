import * as Cesium from 'cesium'
import { storeToRefs } from 'pinia'
import { reactive } from 'vue'
import { FeatureManager } from './featureManager.js'
import { createDefaultModelData } from './modelListCore.js'
import { useModelStore } from '../../../stores/modelStore.js'
import { useMeasurementStore } from '../../../stores/measurementStore.js'
import useMessage from '@/composables/useMessage.js'

/**
 * 模型交互管理器
 * 负责：点击检测、模型选中、特征管理、可见性/透明度控制
 */
export function createModelInteractionManager() {
  const store = useModelStore()
  const { modelList, globalOpacity } = storeToRefs(store)
  const measurementStore = useMeasurementStore()
  const { isMeasuring, isAreaMeasuring } = storeToRefs(measurementStore)
  const { showOperationMessage } = useMessage()

  const featureManager = new FeatureManager()
  let modelClickHandler = null

  function getFeatureNameById(featureId) {
    const feature = featureManager.featureMap.get(featureId)
    try {
      if (feature) {
        return (
          feature.getProperty('name') ||
          feature.getProperty('Name') ||
          feature.getProperty('description') ||
          'Unknown Model'
        )
      }
    } catch (_) { /* ignore */ }
    return 'Unknown Model'
  }

  function scanAndStoreFeatures(tileset) {
    if (tileset && featureManager.getFeatureCount() === 0) {
      featureManager.setTileset(tileset)
      featureManager.scanAndStoreFeatures()
    }
  }

  function initModelEventHandler(viewer, tileset, onFeatureClick) {
    if (!viewer) return

    if (modelClickHandler) {
      try { modelClickHandler.destroy() } catch (e) { /* ignore */ }
      modelClickHandler = null
    }

    modelClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    modelClickHandler.setInputAction(click => {
      if (!tileset.value) return
      const pickedFeature = viewer.scene.pick(click.position)
      if (!Cesium.defined(pickedFeature)) return

      if (
        pickedFeature.primitive === tileset.value &&
        pickedFeature instanceof Cesium.Cesium3DTileFeature
      ) {
        if (isMeasuring.value || isAreaMeasuring.value) return
        onFeatureClick(pickedFeature)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  function handleModelSelection(feature, modelListRef, selectedModelRef) {
    const featureId = featureManager.getFeatureId(feature)
    if (!featureId) {
      showOperationMessage('无法获取模型特征ID', 'error')
      return
    }

    const model = modelListRef.value.find(m => (m.featureId || m.id) === featureId)
    if (model) {
      selectedModelRef.value = model
      if (!model.visible) {
        model.visible = true
        featureManager.toggleModelVisibility(model, globalOpacity.value)
      }
      showOperationMessage(`已选中模型: ${model.name}`, 'success')
    } else {
      const tempModel = reactive(createDefaultModelData(featureId, `未分类模型 (${featureId})`))
      modelListRef.value.push(tempModel)
      selectedModelRef.value = tempModel
    }
  }

  function toggleModelVisibility(model) {
    const result = featureManager.toggleModelVisibility(model, globalOpacity.value)
    showOperationMessage(result.message, result.success ? 'success' : 'warning')
  }

  function updateModelOpacity(model) {
    featureManager.updateModelOpacity(model, globalOpacity.value)
  }

  function updateGlobalOpacity(newOpacity, modelListRef) {
    const val = Number(newOpacity)
    modelListRef.value.forEach(model => featureManager.updateModelOpacity(model, val))
  }

  function resetAllOpacity(modelListRef) {
    modelListRef.value.forEach(m => (m.opacity = 0))
    featureManager.resetAllOpacity(modelListRef.value, globalOpacity.value)
  }

  function showAllModels(modelListRef) {
    featureManager.showAllModels(modelListRef.value, globalOpacity.value)
  }

  function hideAllModels(modelListRef) {
    featureManager.hideAllModels(modelListRef.value)
  }

  function showOnlyModel(model, modelListRef) {
    modelListRef.value.forEach(m => {
      m.visible = m.id === model.id
      featureManager.toggleModelVisibility(m, globalOpacity.value)
    })
    showOperationMessage(`仅显示模型: ${model.name}`, 'success')
  }

  function highlightModel(model) {
    featureManager.highlightModel(model)
  }

  function updateModelColor(model, color) {
    featureManager.updateModelColor(model, color, globalOpacity.value)
  }

  function disableSelection() {
    if (modelClickHandler)
      modelClickHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  function enableSelection() {
    if (modelClickHandler)
      modelClickHandler.setInputAction(click => {
        // re-enable handled by initModelEventHandler
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  function syncDbModelsWithFeatures(modelListRef) {
    if (featureManager.getFeatureCount() === 0) return
    const featureIds = new Set(featureManager.getAllFeatureIds())
    const featureEntries = Array.from(featureManager.featureMap.entries())
    modelListRef.value.forEach(model => {
      const fid = model.featureId || model.id
      if (featureIds.has(fid)) {
        model._dbLinked = true
        return
      }
      const modelName = (model.name || '').toLowerCase().trim()
      if (!modelName) return
      for (const [fId, feature] of featureEntries) {
        try {
          const fName = String(
            feature.getProperty('name') || feature.getProperty('Name') || ''
          ).toLowerCase().trim()
          if (fName && fName === modelName) {
            model.featureId = fId
            model._dbLinked = true
            return
          }
        } catch (_) { /* ignore */ }
      }
    })
  }

  function destroy() {
    if (modelClickHandler) {
      try { modelClickHandler.destroy() } catch (e) { /* ignore */ }
      modelClickHandler = null
    }
    featureManager.destroy()
  }

  return {
    featureManager,
    modelClickHandler: () => modelClickHandler,
    getFeatureNameById,
    scanAndStoreFeatures,
    initModelEventHandler,
    handleModelSelection,
    toggleModelVisibility,
    updateModelOpacity,
    updateGlobalOpacity,
    resetAllOpacity,
    showAllModels,
    hideAllModels,
    showOnlyModel,
    highlightModel,
    updateModelColor,
    disableSelection,
    enableSelection,
    syncDbModelsWithFeatures,
    destroy
  }
}
