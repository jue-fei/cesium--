import { reactive, ref, watch } from 'vue'
import { applyModelTransform } from './modelTransform.js'
import { bindTilesetLodRuntimeEvents } from '../../lod-optimization/services/lodRuntime.js'
import { createUndergroundViewController } from './undergroundView.js'
import { createModelAdaptiveLoadManager } from './modelAdaptiveLoad.js'
import { createModelInteractionManager } from './modelInteraction.js'
import { createCameraFollow } from './cameraFollow.js'
import {
  DEFAULT_TRANSFORM,
  DEFAULT_LOD_CONFIG,
  DEFAULT_POSITION,
  DEFAULT_MODEL_CONFIG_PATH
} from '../../../config/constants/modelConfig.js'
import { isSelectionHighlightExempt } from '../../../config/constants/appConfig.js'
import { ensureResourceAvailable } from './modelApi.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'
import useMeasurement from '@/features/measurement-analysis/services/useMeasurement.js'
import { buildModelServiceApi } from './buildModelServiceApi.js'
import { createModelLodService } from './modelLodService.js'
import {
  discoverAvailableModels,
  getFeatureDataForConfig,
  initializeDefaultModelList,
  initializeModelList,
  loadModelProperties,
  saveModelConfig,
  updateModelId
} from './modelPropertyService.js'
import {
  destroyModel,
  fitToModel,
  initModel,
  load3DModel,
  onConfigChange,
  reloadCurrentModelWithLodConfig
} from './modelSceneLifecycle.js'
import {
  enterUndergroundView,
  resetModel,
  resetView,
  setUndergroundViewEnabled,
  syncUndergroundViewIfNeeded,
  updateGlobeTranslucency,
  updatePosition,
  updateTransform
} from './modelViewService.js'

function createRuntimeState() {
  return {
    originalModelMatrix: null,
    originalBoundingSphereCenter: null,
    currentTransform: { ...DEFAULT_TRANSFORM },
    removeTilesetEventListeners: null
  }
}

function createModelServiceContext(storeRefs) {
  const {
    modelConfigFiles,
    currentConfigFile,
    modelList,
    globalOpacity,
    modelPosition,
    modelTransform,
    modelLoadStatus,
    loading,
    selectedModel,
    modelConfigRaw,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    tileset: tilesetRef,
    lodConfig,
    lodRuntime
  } = storeRefs

  const { showOperationMessage } = useMessage()
  const { getViewer, resetViewToModel } = useViewer()
  const measurement = useMeasurement()
  const interaction = createModelInteractionManager()
  const cameraFollow = createCameraFollow((msg, type) => showOperationMessage(msg, type))

  // 选中持续高亮：任何路径改变选中模型（场景点击/列表属性按钮/信息同步）都生效；
  // 旧选中恢复正常样式，新选中保持高亮直到切换
  // 豁免模型（如地表 dibiao0615）只展示信息，不叠加半透明高亮响应
  watch(selectedModel, (model, prev) => {
    try {
      const fm = interaction.featureManager
      if (prev) fm.clearSelectedHighlight(prev.featureId || prev.id)
      if (model && !isSelectionHighlightExempt(model)) {
        fm.setSelectedHighlight(model.featureId || model.id)
      }
    } catch (_) {
      /* 高亮失败不影响选择流程 */
    }
  })

  /**
   * 视角追随开关：锁定相机到组件包围球，随组件移动；
   * 未加载的组件先飞往其位置，等瓦片加载后自动锁定；再点一次取消。
   */
  const toggleFollowModel = model => {
    const viewer = getViewer()
    const result = cameraFollow.toggleFollow(viewer, tilesetRef, model, interaction.featureManager)
    if (!result.ok) {
      showOperationMessage(result.reason || '视角追随失败', 'warning')
    }
    return result
  }
  const adaptiveLoad = createModelAdaptiveLoadManager()
  const runtimeState = createRuntimeState()
  const modelConfigIdMap = ref(new Map())
  const modelFeaturesCache = ref(new Map())
  const lodVisualizationState = reactive({ mode: 'off' })
  const undergroundViewController = createUndergroundViewController(() => getViewer())
  const getFeatureNameById = featureId => interaction.getFeatureNameById(featureId)

  return {
    modelConfigFiles,
    currentConfigFile,
    modelList,
    globalOpacity,
    modelPosition,
    modelTransform,
    modelLoadStatus,
    loading,
    selectedModel,
    modelConfigRaw,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    tilesetRef,
    lodConfig,
    lodRuntime,
    showOperationMessage,
    getViewer,
    resetViewToModel,
    measurement,
    interaction,
    cameraFollow,
    toggleFollowModel,
    adaptiveLoad,
    runtimeState,
    modelConfigIdMap,
    modelFeaturesCache,
    lodVisualizationState,
    undergroundViewController,
    getFeatureNameById
  }
}

function createModelLodRuntime(context) {
  return createModelLodService({
    lodRuntime: context.lodRuntime,
    lodVisualizationState: context.lodVisualizationState,
    tilesetRef: context.tilesetRef,
    getViewer: context.getViewer,
    lodConfig: context.lodConfig,
    adaptiveLoad: context.adaptiveLoad,
    defaultLodConfig: DEFAULT_LOD_CONFIG
  })
}

function createModelPropertyBindings(context) {
  const getFeatureData = configPath =>
    getFeatureDataForConfig(configPath, context.modelFeaturesCache, context.modelConfigIdMap)

  const initializeDefaultList = preferredSelection =>
    initializeDefaultModelList({
      preferredSelection,
      modelList: context.modelList,
      interaction: context.interaction,
      getFeatureNameById: context.getFeatureNameById,
      selectedModel: context.selectedModel,
      showOperationMessage: context.showOperationMessage
    })

  const initializeList = (propertiesData, preferredSelection) =>
    initializeModelList({
      propertiesData,
      preferredSelection,
      modelConfigRaw: context.modelConfigRaw,
      modelList: context.modelList,
      interaction: context.interaction,
      tilesetRef: context.tilesetRef,
      getFeatureNameById: context.getFeatureNameById,
      selectedModel: context.selectedModel,
      globalOpacity: context.globalOpacity,
      showOperationMessage: context.showOperationMessage
    })

  const loadProperties = () =>
    loadModelProperties({
      selectedModel: context.selectedModel,
      currentConfigFile: context.currentConfigFile,
      modelFeaturesCache: context.modelFeaturesCache,
      modelConfigIdMap: context.modelConfigIdMap,
      interaction: context.interaction,
      tilesetRef: context.tilesetRef,
      modelConfigRaw: context.modelConfigRaw,
      modelList: context.modelList,
      getFeatureNameById: context.getFeatureNameById,
      globalOpacity: context.globalOpacity,
      showOperationMessage: context.showOperationMessage
    })

  const discoverAvailableModelsWrapped = () =>
    discoverAvailableModels({
      modelConfigFiles: context.modelConfigFiles,
      modelConfigIdMap: context.modelConfigIdMap,
      modelFeaturesCache: context.modelFeaturesCache,
      currentConfigFile: context.currentConfigFile,
      defaultModelConfigPath: DEFAULT_MODEL_CONFIG_PATH
    })

  const updateModelIdWrapped = (model, newId) =>
    updateModelId(model, newId, context.modelList, context.showOperationMessage)

  const saveModelConfigWrapped = () =>
    saveModelConfig({
      currentConfigFile: context.currentConfigFile,
      showOperationMessage: context.showOperationMessage,
      modelConfigIdMap: context.modelConfigIdMap,
      modelConfigFiles: context.modelConfigFiles,
      modelList: context.modelList,
      modelConfigRaw: context.modelConfigRaw
    })

  return {
    getFeatureData,
    initializeDefaultList,
    initializeList,
    loadProperties,
    discoverAvailableModelsWrapped,
    updateModelIdWrapped,
    saveModelConfigWrapped
  }
}

function createModelViewBindings(context) {
  const syncUnderground = () =>
    syncUndergroundViewIfNeeded({
      undergroundViewEnabled: context.undergroundViewEnabled,
      tilesetRef: context.tilesetRef,
      undergroundViewController: context.undergroundViewController,
      globeFrontFaceAlpha: context.globeFrontFaceAlpha,
      globeBackFaceAlpha: context.globeBackFaceAlpha
    })

  const resetViewWrapped = () => resetView(context.tilesetRef, context.resetViewToModel)

  const resetModelWrapped = () =>
    resetModel({
      tilesetRef: context.tilesetRef,
      runtimeState: context.runtimeState,
      measurement: context.measurement,
      applyModelTransform,
      modelPosition: context.modelPosition,
      modelTransform: context.modelTransform,
      defaultPosition: DEFAULT_POSITION,
      defaultTransform: DEFAULT_TRANSFORM,
      syncUndergroundViewIfNeeded: syncUnderground,
      showOperationMessage: context.showOperationMessage
    })

  const updatePositionWrapped = newPosition =>
    updatePosition({
      tilesetRef: context.tilesetRef,
      runtimeState: context.runtimeState,
      measurement: context.measurement,
      modelPosition: context.modelPosition,
      modelTransform: context.modelTransform,
      applyModelTransform,
      syncUndergroundViewIfNeeded: syncUnderground,
      newPosition
    })

  const updateTransformWrapped = newTransform =>
    updateTransform({
      tilesetRef: context.tilesetRef,
      runtimeState: context.runtimeState,
      measurement: context.measurement,
      modelPosition: context.modelPosition,
      modelTransform: context.modelTransform,
      applyModelTransform,
      syncUndergroundViewIfNeeded: syncUnderground,
      newTransform
    })

  const setUndergroundViewEnabledWrapped = enabled =>
    setUndergroundViewEnabled({
      undergroundViewEnabled: context.undergroundViewEnabled,
      undergroundViewController: context.undergroundViewController,
      tilesetRef: context.tilesetRef,
      globeFrontFaceAlpha: context.globeFrontFaceAlpha,
      globeBackFaceAlpha: context.globeBackFaceAlpha,
      enabled
    })

  const updateGlobeTranslucencyWrapped = ({ frontFaceAlpha, backFaceAlpha } = {}) =>
    updateGlobeTranslucency({
      globeFrontFaceAlpha: context.globeFrontFaceAlpha,
      globeBackFaceAlpha: context.globeBackFaceAlpha,
      undergroundViewEnabled: context.undergroundViewEnabled,
      undergroundViewController: context.undergroundViewController,
      tilesetRef: context.tilesetRef,
      frontFaceAlpha,
      backFaceAlpha
    })

  const enterUndergroundViewWrapped = () =>
    enterUndergroundView({
      getViewer: context.getViewer,
      tilesetRef: context.tilesetRef,
      undergroundViewEnabled: context.undergroundViewEnabled,
      undergroundViewController: context.undergroundViewController,
      globeFrontFaceAlpha: context.globeFrontFaceAlpha,
      globeBackFaceAlpha: context.globeBackFaceAlpha
    })

  return {
    syncUnderground,
    resetViewWrapped,
    resetModelWrapped,
    updatePositionWrapped,
    updateTransformWrapped,
    setUndergroundViewEnabledWrapped,
    updateGlobeTranslucencyWrapped,
    enterUndergroundViewWrapped
  }
}

function createModelSceneBindings(context, lodService, propertyBindings, viewBindings) {
  const load3DModelWrapped = (modelPaths, lodConfigParam = {}, presetName = 'balanced') =>
    load3DModel({
      modelPaths,
      lodConfigParam,
      presetName,
      getViewer: context.getViewer,
      measurement: context.measurement,
      tilesetRef: context.tilesetRef,
      runtimeState: context.runtimeState,
      resetLodRuntime: lodService.resetLodRuntime,
      adaptiveLoad: context.adaptiveLoad,
      defaultModelConfigPath: DEFAULT_MODEL_CONFIG_PATH,
      defaultLodConfig: DEFAULT_LOD_CONFIG,
      lodConfig: context.lodConfig,
      updateLodRuntime: lodService.updateLodRuntime,
      bindTilesetLodRuntimeEvents,
      resetViewToModel: context.resetViewToModel,
      defaultPosition: DEFAULT_POSITION,
      defaultTransform: DEFAULT_TRANSFORM,
      applyModelTransform,
      ensureResourceAvailable
    })

  const reloadCurrentModelWithLodConfigWrapped = (
    nextLodConfig = context.lodConfig.value,
    presetName = 'custom'
  ) =>
    reloadCurrentModelWithLodConfig({
      nextLodConfig,
      presetName,
      currentConfigFile: context.currentConfigFile,
      modelPosition: context.modelPosition,
      modelTransform: context.modelTransform,
      getViewer: context.getViewer,
      selectedModel: context.selectedModel,
      modelList: context.modelList,
      interaction: context.interaction,
      getFeatureDataForConfig: propertyBindings.getFeatureData,
      loading: context.loading,
      modelLoadStatus: context.modelLoadStatus,
      load3DModel: load3DModelWrapped,
      initializeModelList: propertyBindings.initializeList,
      initializeDefaultModelList: propertyBindings.initializeDefaultList,
      tilesetRef: context.tilesetRef,
      updatePosition: viewBindings.updatePositionWrapped,
      updateTransform: viewBindings.updateTransformWrapped,
      syncUndergroundViewIfNeeded: viewBindings.syncUnderground
    })

  const onConfigChangeWrapped = configFilePath =>
    onConfigChange(
      configFilePath,
      context.currentConfigFile,
      reloadCurrentModelWithLodConfigWrapped
    )

  const initModelWrapped = () =>
    initModel({
      loading: context.loading,
      discoverAvailableModels: propertyBindings.discoverAvailableModelsWrapped,
      currentConfigFile: context.currentConfigFile,
      load3DModel: load3DModelWrapped,
      modelLoadStatus: context.modelLoadStatus,
      getViewer: context.getViewer,
      tilesetRef: context.tilesetRef,
      interaction: context.interaction,
      modelList: context.modelList,
      selectedModel: context.selectedModel,
      getFeatureDataForConfig: propertyBindings.getFeatureData,
      initializeModelList: propertyBindings.initializeList,
      loadModelProperties: propertyBindings.loadProperties,
      syncUndergroundViewIfNeeded: viewBindings.syncUnderground,
      modelPosition: context.modelPosition,
      modelTransform: context.modelTransform
    })

  const destroyModelWrapped = () =>
    destroyModel({
      getViewer: context.getViewer,
      tilesetRef: context.tilesetRef,
      runtimeState: context.runtimeState,
      adaptiveLoad: context.adaptiveLoad,
      lodConfig: context.lodConfig,
      interaction: context.interaction,
      undergroundViewController: context.undergroundViewController,
      modelList: context.modelList,
      selectedModel: context.selectedModel
    })

  const fitToModelWrapped = () => fitToModel(context.getViewer, context.tilesetRef)
  const reloadCurrentConfig = async () => {
    if (context.currentConfigFile.value) await reloadCurrentModelWithLodConfigWrapped()
  }

  return {
    load3DModelWrapped,
    reloadCurrentModelWithLodConfigWrapped,
    onConfigChangeWrapped,
    initModelWrapped,
    destroyModelWrapped,
    fitToModelWrapped,
    reloadCurrentConfig
  }
}

function buildModelService(context, lodService, propertyBindings, viewBindings, sceneBindings) {
  const getOriginalModelMatrix = () => context.runtimeState.originalModelMatrix

  return buildModelServiceApi({
    modelConfigFiles: context.modelConfigFiles,
    currentConfigFile: context.currentConfigFile,
    modelList: context.modelList,
    globalOpacity: context.globalOpacity,
    modelPosition: context.modelPosition,
    modelTransform: context.modelTransform,
    modelLoadStatus: context.modelLoadStatus,
    loading: context.loading,
    selectedModel: context.selectedModel,
    undergroundViewEnabled: context.undergroundViewEnabled,
    globeFrontFaceAlpha: context.globeFrontFaceAlpha,
    globeBackFaceAlpha: context.globeBackFaceAlpha,
    onConfigChange: sceneBindings.onConfigChangeWrapped,
    interaction: context.interaction,
    toggleFollowModel: context.toggleFollowModel,
    followedModelId: context.cameraFollow.followedId,
    fitToModel: sceneBindings.fitToModelWrapped,
    resetView: viewBindings.resetViewWrapped,
    resetModel: viewBindings.resetModelWrapped,
    setUndergroundViewEnabled: viewBindings.setUndergroundViewEnabledWrapped,
    updateGlobeTranslucency: viewBindings.updateGlobeTranslucencyWrapped,
    enterUndergroundView: viewBindings.enterUndergroundViewWrapped,
    updatePosition: viewBindings.updatePositionWrapped,
    updateTransform: viewBindings.updateTransformWrapped,
    updateModelId: propertyBindings.updateModelIdWrapped,
    reloadCurrentConfig: sceneBindings.reloadCurrentConfig,
    reloadCurrentModelWithLodConfig: sceneBindings.reloadCurrentModelWithLodConfigWrapped,
    saveModelConfig: propertyBindings.saveModelConfigWrapped,
    initModel: sceneBindings.initModelWrapped,
    destroyModel: sceneBindings.destroyModelWrapped,
    lodConfig: context.lodConfig,
    getLodStats: lodService.getLodStats,
    updateLodConfig: lodService.updateLodConfig,
    applyLodPreset: lodService.applyLodPreset,
    resetLodConfig: lodService.resetLodConfig,
    defaultLodConfig: DEFAULT_LOD_CONFIG,
    lodRuntime: context.lodRuntime,
    adaptiveLoad: context.adaptiveLoad,
    lodVisualizationState: context.lodVisualizationState,
    applyLodVisualizationMode: lodService.applyLodVisualizationMode,
    tilesetRef: context.tilesetRef,
    getOriginalModelMatrix
  })
}

export function createModelService(storeRefs) {
  const context = createModelServiceContext(storeRefs)
  const lodService = createModelLodRuntime(context)
  const propertyBindings = createModelPropertyBindings(context)
  const viewBindings = createModelViewBindings(context)
  const sceneBindings = createModelSceneBindings(
    context,
    lodService,
    propertyBindings,
    viewBindings
  )

  return buildModelService(context, lodService, propertyBindings, viewBindings, sceneBindings)
}
