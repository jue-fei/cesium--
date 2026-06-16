import { reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { warn } from '@/utils/errorHandler.js'
import * as Cesium from 'cesium'
import { applyModelTransform } from './modelTransform.js'
import {
  appendMissingModelsFromFeatureIds,
  buildDefaultModelListFromFeatureIds,
  buildModelMappingsForSave,
  normalizeModelMappingFromConfig
} from './modelListCore.js'
import { bindTilesetLodRuntimeEvents, createLodRuntimeState, applyLodConfigToTileset, getTilesetMemoryUsageBytes } from '../../lod-optimization/services/lodRuntime.js'
import { createUndergroundViewController, flyToUndergroundView } from './undergroundView.js'
import { createModelAdaptiveLoadManager } from './modelAdaptiveLoad.js'
import { createModelInteractionManager } from './modelInteraction.js'

import {
  PRESETS,
  DEFAULT_TRANSFORM,
  DEFAULT_LOD_CONFIG,
  DEFAULT_POSITION,
  DEFAULT_MODEL_CONFIG_PATH
} from '../../../config/constants/modelConfig.js'
import {
  discoverModelConfigs,
  ensureResourceAvailable,
  fetchModelFeatures,
  saveModelConfig as saveModelConfigApi
} from './modelApi.js'
import { useModelStore } from '../../../stores/modelStore.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'
import useMeasurement from '@/features/measurement-analysis/services/useMeasurement.js'

// ---- 内部共享状态 ----
let originalModelMatrix = null
let originalBoundingSphereCenter = null
let currentTransform = { ...DEFAULT_TRANSFORM }
let removeTilesetEventListeners = null

// ---- 工具函数 ----

function normalizeFeatures(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (_) { return null }
  }
  if (Array.isArray(raw)) return raw.length > 0 ? { modelMappings: raw } : null
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.modelMappings) && raw.modelMappings.length > 0) return raw
    if (Array.isArray(raw.features) && raw.features.length > 0) return { modelMappings: raw.features }
  }
  return null
}

function normalizePath(path) {
  if (!path) return ''
  return path.replace(/^\//, '').replace(/\/+/g, '/').toLowerCase()
}

function createModelSelectionSnapshot(model) {
  if (!model) return null
  return { id: model.id || '', featureId: model.featureId || model.feature_id || model.id || '', name: model.name || '' }
}

function getPreset(presetName) {
  return PRESETS[presetName] || null
}

function resolveTilesetPath(configPath) {
  if (!configPath) return DEFAULT_MODEL_CONFIG_PATH.replace(/feature\.json$/i, 'tileset.json')
  const dirPath = configPath.substring(0, configPath.lastIndexOf('/'))
  return `${dirPath}/tileset.json`
}

export function useModelState() {
  const store = useModelStore()
  return storeToRefs(store)
}

let sharedModelService = null

export default function useModel() {
  if (sharedModelService) return sharedModelService

  const store = useModelStore()
  const {
    modelConfigFiles, currentConfigFile, modelList, globalOpacity,
    modelPosition, modelTransform, modelLoadStatus, loading, selectedModel,
    modelConfigRaw, undergroundViewEnabled, globeFrontFaceAlpha, globeBackFaceAlpha,
    tileset: tilesetRef, lodConfig, lodRuntime
  } = storeToRefs(store)

  const { showOperationMessage } = useMessage()
  const { getViewer, resetViewToModel, displayQuality, terrainQuality, updateDisplayQuality, updateTerrainQuality } = useViewer()

  // ---- 交互管理器 ----
  const interaction = createModelInteractionManager()

  // ---- 自适应降载管理器 ----
  const adaptiveLoad = createModelAdaptiveLoadManager()

  const modelConfigIdMap = ref(new Map())
  const modelFeaturesCache = ref(new Map())

  const lodVisualizationState = reactive({ mode: 'off' })

  const undergroundViewController = createUndergroundViewController(() => getViewer())

  // ---- LOD 运行时 ----
  const resetLodRuntime = () => {
    lodRuntime.value = createLodRuntimeState()
    lodVisualizationState.mode = 'off'
  }

  const updateLodRuntime = patch => {
    if (!lodRuntime.value || typeof lodRuntime.value !== 'object') resetLodRuntime()
    Object.assign(lodRuntime.value, patch, { lastUpdatedMs: Date.now() })
  }

  const applyLodVisualizationMode = mode => {
    const normalized = ['off', 'stage_color', 'stage_wireframe', 'random_tiles', 'random_wireframe'].includes(mode) ? mode : 'off'
    const viewer = getViewer()
    const tileset = tilesetRef.value
    if (tileset) {
      tileset.__lodVisualizationMode = normalized
      tileset.debugColorizeTiles = normalized === 'random_tiles' || normalized === 'random_wireframe'
      tileset.debugWireframe = normalized === 'stage_wireframe' || normalized === 'random_wireframe'
      if (viewer) viewer.scene.requestRender()
    }
    lodVisualizationState.mode = normalized
    if (lodRuntime.value && typeof lodRuntime.value === 'object') lodRuntime.value.visualizationMode = normalized
  }

  // ---- 模型配置缓存 ----
  const getFeatureNameById = featureId => interaction.getFeatureNameById(featureId)

  const getConfigCacheByPath = configPath => {
    if (!configPath) return null
    const exact = modelFeaturesCache.value.get(configPath)
    if (exact?.modelMappings?.length) return exact
    const normalizedTarget = normalizePath(configPath)
    for (const [path, cached] of modelFeaturesCache.value.entries()) {
      if (normalizePath(path) === normalizedTarget && cached?.modelMappings?.length) return cached
    }
    return null
  }

  const getModelConfigId = configPath => {
    if (!configPath) return ''
    const exact = modelConfigIdMap.value.get(configPath)
    if (exact) return exact
    const normalizedTarget = normalizePath(configPath)
    for (const [path, modelId] of modelConfigIdMap.value.entries()) {
      if (normalizePath(path) === normalizedTarget) return modelId
    }
    return ''
  }

  const getFeatureDataForConfig = async configPath => {
    const cached = getConfigCacheByPath(configPath)
    if (cached) return cached
    const modelId = getModelConfigId(configPath)
    if (!modelId) return null
    try {
      const fetched = await fetchModelFeatures(modelId)
      if (fetched?.modelMappings?.length) {
        modelFeaturesCache.value.set(configPath, fetched)
        return fetched
      }
    } catch (_) { /* ignore */ }
    return null
  }

  const syncSelectedModelAfterListUpdate = preferredSelection => {
    if (!Array.isArray(modelList.value) || modelList.value.length === 0) {
      selectedModel.value = null
      return
    }
    let nextSelected = null
    if (preferredSelection) {
      const { id, featureId, name } = preferredSelection
      nextSelected =
        modelList.value.find(model => (model.featureId || model.id) === featureId) ||
        modelList.value.find(model => model.id === id) ||
        modelList.value.find(model => model.name === name)
    }
    selectedModel.value = nextSelected || modelList.value[0]
  }

  function applyConfigToTileset(config) {
    const viewer = getViewer()
    const requestRender = () => { if (viewer) viewer.scene.requestRender() }
    return applyLodConfigToTileset(tilesetRef.value, { ...config }, requestRender)
  }

  // ---- 模型加载核心 ----
  const load3DModel = async (modelPaths, lodConfigParam = {}, presetName = 'balanced') => {
    const viewer = getViewer()
    if (!viewer) return { type: 'error', message: 'Cesium Viewer未初始化' }

    useMeasurement().clearHistoryVisualization()

    if (tilesetRef.value && viewer.scene.primitives.contains(tilesetRef.value)) {
      viewer.scene.primitives.remove(tilesetRef.value)
      tilesetRef.value = null
      originalModelMatrix = null
      originalBoundingSphereCenter = null
    }

    if (removeTilesetEventListeners) {
      removeTilesetEventListeners()
      removeTilesetEventListeners = null
    }
    resetLodRuntime()
    adaptiveLoad.resetAdaptiveLoadState()

    const possiblePaths = modelPaths || [resolveTilesetPath(DEFAULT_MODEL_CONFIG_PATH)]

    for (const path of possiblePaths) {
      try {
        await ensureResourceAvailable(path)

        let finalLodConfig = lodConfigParam
        const preset = getPreset(presetName)
        if (preset && Object.keys(lodConfigParam).length === 0) {
          finalLodConfig = { ...DEFAULT_LOD_CONFIG, ...preset.config }
        } else {
          finalLodConfig = { ...DEFAULT_LOD_CONFIG, ...lodConfigParam }
        }

        lodConfig.value = { ...finalLodConfig }
        adaptiveLoad.syncAdaptiveBaseline(lodConfig.value)

        const t = await Cesium.Cesium3DTileset.fromUrl(path, { ...lodConfig.value })
        viewer.scene.primitives.add(t)
        await t.readyPromise

        tilesetRef.value = t
        removeTilesetEventListeners = bindTilesetLodRuntimeEvents(viewer, t, patch => updateLodRuntime(patch))
        originalModelMatrix = Cesium.Matrix4.clone(t.modelMatrix)
        originalBoundingSphereCenter = Cesium.Cartesian3.clone(t.boundingSphere.center)

        applyModelTransform(t, originalModelMatrix, DEFAULT_POSITION, DEFAULT_TRANSFORM, originalBoundingSphereCenter)
        await resetViewToModel(t)

        return {
          type: 'success', message: '矿山模型已成功加载',
          position: { ...DEFAULT_POSITION }, transform: { ...DEFAULT_TRANSFORM },
          lodConfig: lodConfig.value, lodPreset: presetName
        }
      } catch (error) {
        console.error(`Model load failed (${path}):`, error)
        continue
      }
    }
    return { type: 'warning', message: '3D模型加载失败' }
  }

  // ---- 模型列表初始化 ----
  const initializeDefaultModelList = preferredSelection => {
    modelList.value = []
    if (interaction.featureManager.getFeatureCount() === 0) return
    const featureIds = interaction.featureManager.getAllFeatureIds()
    modelList.value = buildDefaultModelListFromFeatureIds(featureIds, getFeatureNameById).map(m => reactive(m))
    syncSelectedModelAfterListUpdate(preferredSelection)
    if (modelList.value.length > 0) showOperationMessage(`基于特征数据生成了 ${modelList.value.length} 个模型`, 'success')
  }

  const initializeModelList = (propertiesData, preferredSelection) => {
    if (propertiesData?.modelMappings && Array.isArray(propertiesData.modelMappings) && propertiesData.modelMappings.length > 0) {
      modelConfigRaw.value = JSON.parse(JSON.stringify(propertiesData))
      modelList.value = propertiesData.modelMappings.map(m => reactive(normalizeModelMappingFromConfig(m)))
      interaction.scanAndStoreFeatures(tilesetRef.value)
      const featureIds = interaction.featureManager.getAllFeatureIds()
      const additions = appendMissingModelsFromFeatureIds(modelList.value, featureIds, getFeatureNameById)
      additions.forEach(m => modelList.value.push(reactive(m)))
      interaction.syncDbModelsWithFeatures(modelList)
      modelList.value.forEach(model => {
        if (model.styleProperties?.color && model.styleProperties.color !== '#ffffff') {
          interaction.featureManager.updateModelColor(model, model.styleProperties.color, globalOpacity.value)
        }
        interaction.featureManager.updateModelOpacity(model, globalOpacity.value)
        if (!model.visible) interaction.featureManager.toggleModelVisibility(model, 100)
      })
      syncSelectedModelAfterListUpdate(preferredSelection)
      showOperationMessage(`成功从数据库加载 ${modelList.value.length} 个模型的配置`, 'success')
    } else {
      if (interaction.featureManager.getFeatureCount() === 0 && tilesetRef.value) interaction.scanAndStoreFeatures(tilesetRef.value)
      initializeDefaultModelList(preferredSelection)
    }
  }

  const loadModelProperties = async () => {
    const preferredSelection = createModelSelectionSnapshot(selectedModel.value)
    const data = await getFeatureDataForConfig(currentConfigFile.value)
    if (data && data.modelMappings && data.modelMappings.length > 0) {
      initializeModelList(data, preferredSelection)
      showOperationMessage('已从数据库加载模型配置', 'success')
      return
    }
    if (interaction.featureManager.getFeatureCount() === 0 && tilesetRef.value) interaction.scanAndStoreFeatures(tilesetRef.value)
    initializeDefaultModelList(preferredSelection)
    showOperationMessage('数据库暂无模型配置，使用3D模型默认属性', 'info')
  }

  // ---- 模型重载 ----
  const reloadCurrentModelWithLodConfig = async (nextLodConfig = lodConfig.value, presetName = 'custom') => {
    if (!currentConfigFile.value) return { type: 'warning', message: '未选择配置文件' }

    try {
      const configPath = currentConfigFile.value
      const modelPath = resolveTilesetPath(configPath)
      const savedPosition = { ...modelPosition.value }
      const savedTransform = { ...modelTransform.value }
      const viewer = getViewer()
      const cameraSaved = viewer && {
        position: viewer.camera.position.clone(),
        direction: viewer.camera.direction.clone(),
        up: viewer.camera.up.clone()
      }
      const preferredSelection = createModelSelectionSnapshot(selectedModel.value)

      modelList.value = []
      selectedModel.value = null
      interaction.featureManager.resetState()

      const featureData = await getFeatureDataForConfig(configPath)
      loading.value = true
      const result = await load3DModel([modelPath], nextLodConfig || {}, presetName)
      loading.value = false
      modelLoadStatus.value = result

      if (result.type !== 'error' && tilesetRef.value) {
        interaction.featureManager.setTileset(tilesetRef.value)
        interaction.scanAndStoreFeatures(tilesetRef.value)
        if (featureData && featureData.modelMappings && featureData.modelMappings.length > 0) {
          initializeModelList(featureData, preferredSelection)
        } else {
          initializeDefaultModelList(preferredSelection)
        }
        updatePosition(savedPosition)
        updateTransform(savedTransform)
        syncUndergroundViewIfNeeded()
        if (cameraSaved && viewer) {
          viewer.camera.setView({ destination: cameraSaved.position, orientation: { direction: cameraSaved.direction, up: cameraSaved.up } })
        }
        interaction.initModelEventHandler(viewer, tilesetRef, feature => interaction.handleModelSelection(feature, modelList, selectedModel))
      }
      return result
    } catch (error) {
      console.error(error)
      initializeDefaultModelList(createModelSelectionSnapshot(selectedModel.value))
      loading.value = false
      return { type: 'error', message: error.message || '模型重载失败' }
    }
  }

  const onConfigChange = async configFilePath => {
    if (configFilePath) currentConfigFile.value = configFilePath
    if (!currentConfigFile.value) return
    await reloadCurrentModelWithLodConfig()
  }

  // ---- 模型操作 ----
  const updateModelId = (model, newId) => {
    if (!model || !newId) return false
    const trimmed = newId.trim()
    if (!trimmed || trimmed === model.id) return true
    if (modelList.value.some(m => m.id === trimmed)) {
      showOperationMessage('ID 已存在，无法修改', 'warning')
      return false
    }
    const originalFeatureId = model.featureId || model.id
    model.id = trimmed
    if (!model.featureId) model.featureId = originalFeatureId
    if (model.geologyProperties) model.geologyProperties.ID = trimmed
    return true
  }

  const reloadCurrentConfig = async () => {
    if (currentConfigFile.value) await reloadCurrentModelWithLodConfig()
  }

  const saveModelConfig = async () => {
    if (!currentConfigFile.value) {
      showOperationMessage('未选择配置文件，无法保存', 'warning')
      return false
    }
    const modelId = getModelConfigId(currentConfigFile.value) || ''
    const configName = modelConfigFiles.value.find(f => f.path === currentConfigFile.value)?.name || ''
    const modelMappings = buildModelMappingsForSave(modelList.value)
    const payload = {
      model_id: modelId, name: configName,
      ...((modelConfigRaw.value && typeof modelConfigRaw.value === 'object' ? modelConfigRaw.value : {}) || {}),
      modelMappings
    }
    try {
      const result = await saveModelConfigApi(currentConfigFile.value, payload)
      if (!result.success) { showOperationMessage(result.message, 'error'); return false }
      modelConfigRaw.value = JSON.parse(JSON.stringify(payload))
      showOperationMessage(result.message, 'success')
      return true
    } catch (e) {
      showOperationMessage('保存失败', 'error')
      return false
    }
  }

  // ---- 地下视图 ----
  const applyUndergroundView = enabled => {
    undergroundViewController.apply({
      tileset: tilesetRef.value,
      enabled: !!enabled,
      frontFaceAlphaPercent: globeFrontFaceAlpha.value,
      backFaceAlphaPercent: globeBackFaceAlpha.value
    })
  }

  const syncUndergroundViewIfNeeded = () => {
    if (!undergroundViewEnabled.value || !tilesetRef.value) return
    applyUndergroundView(true)
  }

  const setUndergroundViewEnabled = enabled => {
    undergroundViewEnabled.value = !!enabled
    applyUndergroundView(undergroundViewEnabled.value)
  }

  const updateGlobeTranslucency = ({ frontFaceAlpha, backFaceAlpha } = {}) => {
    if (typeof frontFaceAlpha === 'number') globeFrontFaceAlpha.value = frontFaceAlpha
    if (typeof backFaceAlpha === 'number') globeBackFaceAlpha.value = backFaceAlpha
    if (!undergroundViewEnabled.value) return
    applyUndergroundView(true)
  }

  const enterUndergroundView = () => {
    const viewer = getViewer()
    if (!viewer || !tilesetRef.value) return
    if (!undergroundViewEnabled.value) undergroundViewEnabled.value = true
    applyUndergroundView(true)
    flyToUndergroundView(viewer, tilesetRef.value, 0.8)
  }

  // ---- 位置/变换 ----
  const resetView = async () => {
    if (tilesetRef.value) await resetViewToModel(tilesetRef.value)
  }

  const resetModel = () => {
    if (!tilesetRef.value || !originalModelMatrix) return
    useMeasurement().clearHistoryVisualization()
    applyModelTransform(tilesetRef.value, originalModelMatrix, { ...DEFAULT_POSITION }, { ...DEFAULT_TRANSFORM }, originalBoundingSphereCenter)
    currentTransform = { ...DEFAULT_TRANSFORM }
    modelPosition.value = { ...DEFAULT_POSITION }
    modelTransform.value = { ...DEFAULT_TRANSFORM }
    syncUndergroundViewIfNeeded()
    showOperationMessage('模型已重置到初始位置', 'success')
  }

  const updatePosition = newPosition => {
    if (!tilesetRef.value || !originalModelMatrix) return
    useMeasurement().clearHistoryVisualization()
    modelPosition.value = { ...modelPosition.value, ...newPosition }
    applyModelTransform(tilesetRef.value, originalModelMatrix, modelPosition.value, currentTransform, originalBoundingSphereCenter)
    syncUndergroundViewIfNeeded()
  }

  const updateTransform = newTransform => {
    if (!tilesetRef.value || !originalModelMatrix) return
    useMeasurement().clearHistoryVisualization()
    modelTransform.value = { ...modelTransform.value, ...newTransform }
    currentTransform = { ...newTransform }
    applyModelTransform(tilesetRef.value, originalModelMatrix, modelPosition.value, currentTransform, originalBoundingSphereCenter)
    syncUndergroundViewIfNeeded()
  }

  // ---- LOD 配置 ----
  const updateLodConfig = newConfig => {
    lodConfig.value = { ...lodConfig.value, ...newConfig }
    if (tilesetRef.value) {
      const ok = applyConfigToTileset(lodConfig.value)
      if (adaptiveLoad.adaptiveLoadState.level === 0) adaptiveLoad.syncAdaptiveBaseline(lodConfig.value)
      return ok
    }
    if (adaptiveLoad.adaptiveLoadState.level === 0) adaptiveLoad.syncAdaptiveBaseline(lodConfig.value)
    return false
  }

  const applyLodPreset = presetName => {
    const preset = getPreset(presetName)
    if (preset) updateLodConfig(preset.config)
  }

  const resetLodConfig = () => {
    lodConfig.value = { ...DEFAULT_LOD_CONFIG }
    if (tilesetRef.value) applyConfigToTileset(lodConfig.value)
  }

  // ---- 初始化 ----
  const discoverAvailableModels = async () => {
    const configs = await discoverModelConfigs()
    modelConfigFiles.value = configs

    const idMap = new Map()
    const featuresMap = new Map()
    configs.forEach(config => {
      if (config.model_id && config.path) idMap.set(config.path, config.model_id)
      const normalized = normalizeFeatures(config.features)
      if (config.path && normalized) featuresMap.set(config.path, normalized)
    })

    if (featuresMap.size === 0 && idMap.size > 0) {
      for (const [path, modelId] of idMap.entries()) {
        try {
          const data = await fetchModelFeatures(modelId)
          if (data && data.modelMappings && data.modelMappings.length > 0) {
            featuresMap.set(path, data); break
          }
        } catch (_) { /* continue */ }
      }
    }

    modelConfigIdMap.value = idMap
    modelFeaturesCache.value = featuresMap
    console.log('[initModel] 模型配置:', configs.length, '条, idMap:', idMap.size, '条, featuresMap:', featuresMap.size, '条')

    if (configs.length > 0) {
      const hasCurrent = currentConfigFile.value && featuresMap.has(currentConfigFile.value)
      if (!hasCurrent) {
        const preferredConfig =
          configs.find(config => config.path === DEFAULT_MODEL_CONFIG_PATH && featuresMap.has(config.path)) ||
          configs.find(config => featuresMap.has(config.path)) ||
          configs[0]
        currentConfigFile.value = preferredConfig.path
      }
    }
  }

  const initModel = async () => {
    loading.value = true
    try {
      await discoverAvailableModels()
      const initialTilesetPath = resolveTilesetPath(currentConfigFile.value)
      const loadResult = await load3DModel([initialTilesetPath])
      modelLoadStatus.value = loadResult

      const viewer = getViewer()

      if (tilesetRef.value) {
        interaction.scanAndStoreFeatures(tilesetRef.value)
        interaction.initModelEventHandler(viewer, tilesetRef, feature => interaction.handleModelSelection(feature, modelList, selectedModel))

        if (currentConfigFile.value) {
          const dbData = await getFeatureDataForConfig(currentConfigFile.value)
          console.log('[initModel] dbData:', dbData ? `modelMappings ${dbData.modelMappings?.length || 0} 条` : 'null')
          if (dbData && dbData.modelMappings && dbData.modelMappings.length > 0) {
            initializeModelList(dbData)
            console.log('[initModel] 已从数据库加载模型列表, modelList:', modelList.value.length, '条')
          } else {
            console.warn('[initModel] 数据库无模型数据，降级到 loadModelProperties')
            await loadModelProperties()
          }
        } else {
          console.warn('[initModel] currentConfigFile 未设置，降级到 loadModelProperties')
          await loadModelProperties()
        }
        syncUndergroundViewIfNeeded()
      }

      if (loadResult.position) modelPosition.value = loadResult.position
      if (loadResult.transform) modelTransform.value = loadResult.transform
    } catch (error) {
      console.error(error)
      modelLoadStatus.value = { type: 'error', message: error.message }
    } finally {
      loading.value = false
    }
  }

  // ---- 销毁 ----
  const destroyModel = () => {
    const viewer = getViewer()
    if (tilesetRef.value && viewer?.scene?.primitives?.contains(tilesetRef.value)) {
      viewer.scene.primitives.remove(tilesetRef.value)
    }
    tilesetRef.value = null
    originalModelMatrix = null
    originalBoundingSphereCenter = null
    if (removeTilesetEventListeners) {
      removeTilesetEventListeners(); removeTilesetEventListeners = null
    }
    adaptiveLoad.stopGlobalFpsMonitoring(tilesetRef, lodConfig)
    interaction.destroy()
    undergroundViewController.destroy?.()
    modelList.value = []
    selectedModel.value = null
  }

  const fitToModel = async () => {
    const viewer = getViewer()
    if (viewer && tilesetRef.value) {
      try { await viewer.zoomTo(tilesetRef.value) } catch (e) { warn('model', 'useModel', e) }
    }
  }

  const getLodStats = () => ({
    ...lodRuntime.value,
    totalMemoryUsageInBytes: getTilesetMemoryUsageBytes(tilesetRef.value)
  })

  const getOriginalModelMatrix = () => originalModelMatrix

  // ---- 返回 ----
  sharedModelService = {
    modelConfigFiles, currentConfigFile, modelList, globalOpacity,
    modelPosition, modelTransform, modelLoadStatus, loading, selectedModel,
    undergroundViewEnabled, globeFrontFaceAlpha, globeBackFaceAlpha,

    onConfigChange,
    toggleModelVisibility: model => interaction.toggleModelVisibility(model),
    updateModelOpacity: model => interaction.updateModelOpacity(model),
    updateGlobalOpacity: newOpacity => {
      globalOpacity.value = Number(newOpacity)
      interaction.updateGlobalOpacity(globalOpacity.value, modelList)
    },
    resetAllOpacity: () => interaction.resetAllOpacity(modelList),
    showAllModels: () => interaction.showAllModels(modelList),
    hideAllModels: () => interaction.hideAllModels(modelList),
    fitToModel,
    fitToModels: fitToModel,
    resetView,
    resetModel,
    setUndergroundViewEnabled,
    updateGlobeTranslucency,
    enterUndergroundView,
    updatePosition,
    updateTransform,
    syncModelInfo: model => { selectedModel.value = model },
    highlightModel: model => interaction.highlightModel(model),
    showModelProperties: model => { selectedModel.value = model },
    showOnlyModel: model => interaction.showOnlyModel(model, modelList),
    updateModelId,
    reloadCurrentConfig,
    reloadCurrentModelWithLodConfig,
    saveModelConfig,
    disableSelection: () => interaction.disableSelection(),
    enableSelection: () => interaction.enableSelection(),
    initModel,
    destroyModel,

    lodConfig,
    getLodStats,
    updateLodConfig,
    applyLodPreset,
    resetLodConfig,
    DEFAULT_LOD_CONFIG,
    lodRuntime,
    adaptiveLoadState: adaptiveLoad.adaptiveLoadState,
    lodVisualizationState,
    applyLodVisualizationMode,

    tilesetRef,
    tileset: tilesetRef,
    modelClickHandler: () => interaction.modelClickHandler(),
    getOriginalModelMatrix,

    fps: adaptiveLoad.fps,
    startGlobalFpsMonitoring: () => adaptiveLoad.startGlobalFpsMonitoring(tilesetRef, lodConfig, lodRuntime),
    stopGlobalFpsMonitoring: () => adaptiveLoad.stopGlobalFpsMonitoring(tilesetRef, lodConfig)
  }

  return sharedModelService
}
