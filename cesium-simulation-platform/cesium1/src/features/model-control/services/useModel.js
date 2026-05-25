import { reactive, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { warn } from '@/utils/errorHandler.js'
import * as Cesium from 'cesium'
import { FeatureManager } from './featureManager.js'
import { applyModelTransform } from './modelTransform.js'
import {
  appendMissingModelsFromFeatureIds,
  buildDefaultModelListFromFeatureIds,
  buildModelMappingsForSave,
  createDefaultModelData,
  getFeatureNameFromFeature,
  normalizeModelMappingFromConfig
} from './modelListCore.js'
import { createFpsMonitor } from '../../lod-optimization/services/fpsMonitor.js'
import {
  createAdaptiveLoadRuntime,
  evaluateAdaptiveLoad,
  getAdaptiveLoadStep
} from '../../lod-optimization/services/adaptiveLoad.js'
import {
  applyLodConfigToTileset,
  bindTilesetLodRuntimeEvents,
  createLodRuntimeState,
  getTilesetMemoryUsageBytes
} from '../../lod-optimization/services/lodRuntime.js'
import { createUndergroundViewController, flyToUndergroundView } from './undergroundView.js'

import {
  PRESETS,
  DEFAULT_TRANSFORM,
  DEFAULT_LOD_CONFIG,
  DEFAULT_POSITION,
  DEFAULT_ADAPTIVE_LOAD_CONFIG,
  DEFAULT_MODEL_CONFIG_PATH
} from '../../../config/constants/modelConfig.js'
import {
  discoverModelConfigs,
  ensureResourceAvailable,
  fetchJsonOrNull,
  saveModelConfig as saveModelConfigApi
} from './modelApi.js'
import { useModelStore } from '../../../stores/modelStore.js'
import { useMeasurementStore } from '../../../stores/measurementStore.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'

// 内部共享状态（非响应式，或仅用于运行时逻辑）
let originalModelMatrix = null
let originalBoundingSphereCenter = null
let currentTransform = { ...DEFAULT_TRANSFORM }
let modelClickHandler = null
let removeTilesetEventListeners = null
let adaptiveLoadStopHandle = null
let adaptiveBaseline = {
  lodConfig: { ...DEFAULT_LOD_CONFIG },
  displayQuality: 'high',
  terrainQuality: 'high'
}

const featureManager = new FeatureManager()

const fpsMonitor = createFpsMonitor(() => {
  const { getViewer } = useViewer()
  return getViewer()
})
const fps = fpsMonitor.fps
const adaptiveLoadState = reactive({
  ...createAdaptiveLoadRuntime(),
  status: '待机',
  appliedStepLabel: '基线'
})

const undergroundViewController = createUndergroundViewController(() => {
  const { getViewer } = useViewer()
  return getViewer()
})

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

export default function useModel() {
  const store = useModelStore()
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
  } = storeToRefs(store)

  const measurementStore = useMeasurementStore()
  const { isMeasuring, isAreaMeasuring } = storeToRefs(measurementStore)

  const { showOperationMessage } = useMessage()

  const {
    getViewer,
    resetViewToModel,
    displayQuality,
    terrainQuality,
    updateDisplayQuality,
    updateTerrainQuality
  } = useViewer()

  const resetLodRuntime = () => {
    lodRuntime.value = createLodRuntimeState()
  }

  const updateLodRuntime = patch => {
    if (!lodRuntime.value || typeof lodRuntime.value !== 'object') {
      resetLodRuntime()
    }
    Object.assign(lodRuntime.value, patch, { lastUpdatedMs: Date.now() })
  }

  const getFeatureNameById = featureId => {
    const feature = featureManager.featureMap.get(featureId)
    return getFeatureNameFromFeature(feature, 'Unknown Model')
  }

  function applyConfigToTileset(config) {
    const viewer = getViewer()
    const requestRender = () => {
      if (viewer) viewer.scene.requestRender()
    }
    return applyLodConfigToTileset(tilesetRef.value, { ...config }, requestRender)
  }

  const resetAdaptiveLoadState = () => {
    Object.assign(adaptiveLoadState, createAdaptiveLoadRuntime(), {
      status: '待机',
      appliedStepLabel: '基线'
    })
  }

  const syncAdaptiveBaseline = () => {
    adaptiveBaseline = {
      lodConfig: { ...lodConfig.value },
      displayQuality: displayQuality.value,
      terrainQuality: terrainQuality.value
    }
  }

  const applyAdaptiveLevel = (level, reason = '') => {
    if (level <= 0) {
      lodConfig.value = { ...adaptiveBaseline.lodConfig }
      if (tilesetRef.value) applyConfigToTileset(lodConfig.value)
      updateDisplayQuality(adaptiveBaseline.displayQuality)
      updateTerrainQuality(adaptiveBaseline.terrainQuality)
      Object.assign(adaptiveLoadState, {
        level: 0,
        branch: 'standard',
        status: '已恢复',
        appliedStepLabel: '基线',
        lastReason: reason || '恢复到基线配置'
      })
      return
    }

    const step = getAdaptiveLoadStep(DEFAULT_ADAPTIVE_LOAD_CONFIG, level)
    if (!step) return

    lodConfig.value = {
      ...adaptiveBaseline.lodConfig,
      ...(step.lodConfig || {})
    }
    if (tilesetRef.value) applyConfigToTileset(lodConfig.value)
    updateDisplayQuality(step.displayQuality || adaptiveBaseline.displayQuality)
    updateTerrainQuality(step.terrainQuality || adaptiveBaseline.terrainQuality)

    Object.assign(adaptiveLoadState, {
      level,
      branch: step.branch || 'standard',
      status: '自动降载中',
      appliedStepLabel: step.label || `等级 ${level}`,
      lastReason: reason || step.label || `等级 ${level}`
    })
  }

  const handleAdaptiveLoadEvaluation = () => {
    if (!DEFAULT_ADAPTIVE_LOAD_CONFIG?.enabled || !tilesetRef.value) return
    if (adaptiveLoadState.level === 0) syncAdaptiveBaseline()

    const metrics = {
      fps: fps.value,
      ...lodRuntime.value,
      totalMemoryUsageInBytes: getTilesetMemoryUsageBytes(tilesetRef.value)
    }
    const result = evaluateAdaptiveLoad(
      metrics,
      adaptiveLoadState,
      DEFAULT_ADAPTIVE_LOAD_CONFIG,
      Date.now()
    )

    Object.assign(adaptiveLoadState, result.nextRuntimePatch)

    if (result.action === 'degrade') {
      const step = getAdaptiveLoadStep(DEFAULT_ADAPTIVE_LOAD_CONFIG, result.nextLevel)
      applyAdaptiveLevel(result.nextLevel, step?.label || '自动降载')
      showOperationMessage(
        `检测到低帧率，已执行${step?.label || '自动降载'}（FPS ${metrics.fps}）`,
        'warning'
      )
    }

    if (result.action === 'recover') {
      applyAdaptiveLevel(result.nextLevel, '性能恢复')
      showOperationMessage(
        result.nextLevel === 0 ? '帧率恢复，已回到基线配置' : '帧率恢复，已逐级回退降载',
        'success'
      )
    }
  }

  const startAdaptiveLoadMonitoring = () => {
    if (adaptiveLoadStopHandle || !DEFAULT_ADAPTIVE_LOAD_CONFIG?.enabled) return
    adaptiveLoadState.enabled = true
    syncAdaptiveBaseline()
    adaptiveLoadStopHandle = watch(fps, () => {
      handleAdaptiveLoadEvaluation()
    })
  }

  const stopAdaptiveLoadMonitoring = () => {
    if (adaptiveLoadStopHandle) {
      adaptiveLoadStopHandle()
      adaptiveLoadStopHandle = null
    }
    if (adaptiveLoadState.level > 0) {
      applyAdaptiveLevel(0, '停止自动降载')
    }
    resetAdaptiveLoadState()
    adaptiveLoadState.enabled = false
  }

  const startGlobalFpsMonitoring = () => {
    fpsMonitor.start()
    startAdaptiveLoadMonitoring()
  }

  const stopGlobalFpsMonitoring = () => {
    stopAdaptiveLoadMonitoring()
    fpsMonitor.stop()
  }

  const load3DModel = async (modelPaths, lodConfigParam = {}, presetName = 'balanced') => {
    const viewer = getViewer()
    if (!viewer) return { type: 'error', message: 'Cesium Viewer未初始化' }

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
    resetAdaptiveLoadState()

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
        syncAdaptiveBaseline()

        const t = await Cesium.Cesium3DTileset.fromUrl(path, { ...lodConfig.value })
        viewer.scene.primitives.add(t)
        await t.readyPromise

        tilesetRef.value = t
        removeTilesetEventListeners = bindTilesetLodRuntimeEvents(t, patch =>
          updateLodRuntime(patch)
        )
        originalModelMatrix = Cesium.Matrix4.clone(t.modelMatrix)
        originalBoundingSphereCenter = Cesium.Cartesian3.clone(t.boundingSphere.center)

        applyModelTransform(
          t,
          originalModelMatrix,
          DEFAULT_POSITION,
          DEFAULT_TRANSFORM,
          originalBoundingSphereCenter
        )
        await resetViewToModel(t)

        const successResult = {
          type: 'success',
          message: '矿山模型已成功加载',
          position: { ...DEFAULT_POSITION },
          transform: { ...DEFAULT_TRANSFORM },
          lodConfig: lodConfig.value,
          lodPreset: presetName
        }

        return successResult
      } catch (error) {
        console.error(`Model load failed (${path}):`, error)
        continue
      }
    }

    return { type: 'warning', message: '3D模型加载失败' }
  }

  function initModelEventHandler() {
    const viewer = getViewer()
    if (!viewer) return

    if (modelClickHandler) {
      try {
        modelClickHandler.destroy()
      } catch (e) {
        console.warn('Failed to destroy click handler', e)
      }
      modelClickHandler = null
    }

    modelClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    modelClickHandler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  function onLeftClick(click) {
    if (!tilesetRef.value) return
    const viewer = getViewer()
    if (!viewer) return

    const pickedFeature = viewer.scene.pick(click.position)
    if (!Cesium.defined(pickedFeature)) return

    if (
      pickedFeature.primitive === tilesetRef.value &&
      pickedFeature instanceof Cesium.Cesium3DTileFeature
    ) {
      if (isMeasuring.value || isAreaMeasuring.value) {
        return
      }
      handleModelSelection(pickedFeature)
    }
  }

  function handleModelSelection(feature) {
    const featureId = featureManager.getFeatureId(feature)
    if (!featureId) {
      showOperationMessage('无法获取模型特征ID', 'error')
      return
    }

    const model = modelList.value.find(m => (m.featureId || m.id) === featureId)
    if (model) {
      syncModelInfo(model)
      model.visible = true

      showOperationMessage(`已选中模型: ${model.name}`, 'success')
    } else {
      const tempModel = reactive(createDefaultModelData(featureId, `未分类模型 (${featureId})`))
      modelList.value.push(tempModel)
      syncModelInfo(tempModel)
    }
  }

  // ----------------------------------------------------------------
  // 要素与属性
  // ----------------------------------------------------------------

  const syncModelInfo = model => {
    selectedModel.value = model
  }
  const highlightModel = model => {
    featureManager.highlightModel(model)
  }
  const showModelProperties = model => {
    syncModelInfo(model)
  }

  const scanAndStoreFeatures = () => {
    if (tilesetRef.value && featureManager.getFeatureCount() === 0) {
      featureManager.setTileset(tilesetRef.value)
      featureManager.scanAndStoreFeatures()
    }
  }

  const initializeDefaultModelList = () => {
    modelList.value = []
    if (featureManager.getFeatureCount() === 0) return

    const featureIds = featureManager.getAllFeatureIds()
    modelList.value = buildDefaultModelListFromFeatureIds(featureIds, getFeatureNameById).map(
      model => reactive(model)
    )

    if (modelList.value.length > 0) {
      showOperationMessage(`基于特征数据生成了 ${modelList.value.length} 个模型`, 'success')
    }
  }

  const appendMissingModelsFromFeatures = () => {
    if (featureManager.getFeatureCount() === 0) return
    const featureIds = featureManager.getAllFeatureIds()
    const additions = appendMissingModelsFromFeatureIds(
      modelList.value,
      featureIds,
      getFeatureNameById
    )
    additions.forEach(model => {
      modelList.value.push(reactive(model))
    })
  }

  const initializeModelList = propertiesData => {
    if (propertiesData.modelMappings && Array.isArray(propertiesData.modelMappings)) {
      modelConfigRaw.value = JSON.parse(JSON.stringify(propertiesData))
      modelList.value = propertiesData.modelMappings.map(m =>
        reactive(normalizeModelMappingFromConfig(m))
      )
      scanAndStoreFeatures()
      appendMissingModelsFromFeatures()
      modelList.value.forEach(model => {
        if (model.styleProperties?.color) {
          featureManager.updateModelColor(model, model.styleProperties.color, globalOpacity.value)
        }
      })
      showOperationMessage(`成功加载 ${modelList.value.length} 个模型的配置`, 'success')
    } else {
      if (featureManager.getFeatureCount() === 0 && tilesetRef.value) scanAndStoreFeatures()
      initializeDefaultModelList()
    }
  }

  const loadModelProperties = async () => {
    const candidates = []
    if (currentConfigFile.value)
      candidates.push(currentConfigFile.value.replace(/tileset\.json$/i, 'feature.json'))
    candidates.push(DEFAULT_MODEL_CONFIG_PATH)

    for (const path of candidates) {
      try {
        const data = await fetchJsonOrNull(path)
        if (!data) continue
        initializeModelList(data)
        return
      } catch (e) {
        console.warn('Failed to load config', e)
      }
    }

    if (featureManager.getFeatureCount() === 0 && tilesetRef.value) scanAndStoreFeatures()
    initializeDefaultModelList()
    showOperationMessage('未找到模型属性文件，使用默认模型配置', 'warning')
  }

  // ----------------------------------------------------------------
  // 操作与配置变更
  // ----------------------------------------------------------------

  const reloadCurrentModelWithLodConfig = async (
    nextLodConfig = lodConfig.value,
    presetName = 'custom'
  ) => {
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

      modelList.value = []
      selectedModel.value = null
      featureManager.resetState()

      const featureData = await fetchJsonOrNull(configPath)

      loading.value = true
      const result = await load3DModel([modelPath], nextLodConfig || {}, presetName)
      loading.value = false

      modelLoadStatus.value = result
      if (result.type !== 'error' && tilesetRef.value) {
        featureManager.setTileset(tilesetRef.value)
        scanAndStoreFeatures()

        if (featureData) initializeModelList(featureData)
        else initializeDefaultModelList()

        updatePosition(savedPosition)
        updateTransform(savedTransform)

        if (cameraSaved && viewer) {
          viewer.camera.setView({
            destination: cameraSaved.position,
            orientation: { direction: cameraSaved.direction, up: cameraSaved.up }
          })
        }

        initModelEventHandler()
      }

      return result
    } catch (error) {
      console.error(error)
      initializeDefaultModelList()
      loading.value = false
      return { type: 'error', message: error.message || '模型重载失败' }
    }
  }

  const onConfigChange = async configFilePath => {
    if (configFilePath) currentConfigFile.value = configFilePath
    if (!currentConfigFile.value) return

    await reloadCurrentModelWithLodConfig()
  }

  const toggleModelVisibility = model => {
    if (!tilesetRef.value) return
    const result = featureManager.toggleModelVisibility(model)
    showOperationMessage(result.message, result.success ? 'success' : 'warning')
  }

  const updateModelOpacity = model => {
    if (!tilesetRef.value) return
    featureManager.updateModelOpacity(model, globalOpacity.value)
  }

  const updateGlobalOpacity = newOpacity => {
    globalOpacity.value = Number(newOpacity)
    modelList.value.forEach(model => updateModelOpacity(model))
  }

  const resetAllOpacity = () => {
    modelList.value.forEach(m => (m.opacity = 0))
    globalOpacity.value = 0
    featureManager.resetAllOpacity(modelList.value, 0)
  }

  const showAllModels = () => featureManager.showAllModels(modelList.value)
  const hideAllModels = () => featureManager.hideAllModels(modelList.value)
  const showOnlyModel = model => {
    if (!tilesetRef.value) return
    modelList.value.forEach(m => {
      m.visible = m.id === model.id
      featureManager.toggleModelVisibility(m)
    })
    showOperationMessage(`仅显示模型: ${model.name}`, 'success')
  }

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

    const modelMappings = buildModelMappingsForSave(modelList.value)

    const payload = {
      ...((modelConfigRaw.value && typeof modelConfigRaw.value === 'object'
        ? modelConfigRaw.value
        : {}) || {}),
      modelMappings
    }

    try {
      const result = await saveModelConfigApi(currentConfigFile.value, payload)
      if (!result.success) {
        showOperationMessage(result.message, 'error')
        return false
      }
      modelConfigRaw.value = JSON.parse(JSON.stringify(payload))
      showOperationMessage(result.message, 'success')
      return true
    } catch (e) {
      showOperationMessage('保存失败', 'error')
      return false
    }
  }

  const resetView = async () => {
    if (tilesetRef.value) await resetViewToModel(tilesetRef.value)
  }

  const applyUndergroundView = enabled => {
    undergroundViewController.apply({
      tileset: tilesetRef.value,
      enabled: !!enabled,
      frontFaceAlphaPercent: globeFrontFaceAlpha.value,
      backFaceAlphaPercent: globeBackFaceAlpha.value
    })
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

    if (!undergroundViewEnabled.value) {
      undergroundViewEnabled.value = true
    }
    applyUndergroundView(true)

    flyToUndergroundView(viewer, tilesetRef.value, 0.8)
  }

  const resetModel = () => {
    if (!tilesetRef.value || !originalModelMatrix) return
    applyModelTransform(
      tilesetRef.value,
      originalModelMatrix,
      { ...DEFAULT_POSITION },
      { ...DEFAULT_TRANSFORM },
      originalBoundingSphereCenter
    )
    currentTransform = { ...DEFAULT_TRANSFORM }
    modelPosition.value = { ...DEFAULT_POSITION }
    modelTransform.value = { ...DEFAULT_TRANSFORM }
    showOperationMessage('模型已重置到初始位置', 'success')
  }

  const updatePosition = newPosition => {
    if (!tilesetRef.value || !originalModelMatrix) return
    modelPosition.value = { ...modelPosition.value, ...newPosition }
    applyModelTransform(
      tilesetRef.value,
      originalModelMatrix,
      modelPosition.value,
      currentTransform,
      originalBoundingSphereCenter
    )
  }

  const updateTransform = newTransform => {
    if (!tilesetRef.value || !originalModelMatrix) return
    modelTransform.value = { ...modelTransform.value, ...newTransform }
    currentTransform = { ...newTransform }
    applyModelTransform(
      tilesetRef.value,
      originalModelMatrix,
      modelPosition.value,
      currentTransform,
      originalBoundingSphereCenter
    )
  }

  const updateLodConfig = newConfig => {
    lodConfig.value = { ...lodConfig.value, ...newConfig }
    if (tilesetRef.value) {
      const ok = applyConfigToTileset(lodConfig.value)
      if (adaptiveLoadState.level === 0) syncAdaptiveBaseline()
      return ok
    }
    if (adaptiveLoadState.level === 0) syncAdaptiveBaseline()
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

  // ----------------------------------------------------------------
  // 初始化
  // ----------------------------------------------------------------

  /**
   * 扫描 public/3d 目录下可用配置列表
   */
  const discoverAvailableModels = async () => {
    const configs = await discoverModelConfigs(10)
    modelConfigFiles.value = configs

    if (!currentConfigFile.value && configs.length > 0) {
      const preferredConfig =
        configs.find(config => config.path === DEFAULT_MODEL_CONFIG_PATH) || configs[0]
      currentConfigFile.value = preferredConfig.path
    }
  }

  const initModel = async () => {
    loading.value = true
    try {
      // 第一步：发现模型配置
      await discoverAvailableModels()

      // 第二步：确定初始模型路径
      const initialTilesetPath = resolveTilesetPath(currentConfigFile.value)

      // 第三步：加载模型
      const loadResult = await load3DModel([initialTilesetPath])
      modelLoadStatus.value = loadResult

      if (tilesetRef.value) {
        scanAndStoreFeatures()
        initModelEventHandler()

        // 第四步：加载属性
        if (currentConfigFile.value) {
          const data = await fetchJsonOrNull(currentConfigFile.value)
          if (data) initializeModelList(data)
          else await loadModelProperties()
        } else {
          await loadModelProperties()
        }
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

  const disableSelection = () => {
    if (modelClickHandler)
      modelClickHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  const enableSelection = () => {
    if (modelClickHandler)
      modelClickHandler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  const fitToModel = async () => {
    const viewer = getViewer()
    if (viewer && tilesetRef.value) {
      try {
        await viewer.zoomTo(tilesetRef.value)
      } catch (e) {
        warn('model', 'useModel', e)
      }
    }
  }

  const getLodStats = () => {
    return {
      ...lodRuntime.value,
      totalMemoryUsageInBytes: getTilesetMemoryUsageBytes(tilesetRef.value)
    }
  }

  const destroyModel = () => {
    const viewer = getViewer()
    if (tilesetRef.value && viewer?.scene?.primitives?.contains(tilesetRef.value)) {
      viewer.scene.primitives.remove(tilesetRef.value)
    }
    tilesetRef.value = null
    originalModelMatrix = null
    originalBoundingSphereCenter = null
    if (removeTilesetEventListeners) {
      removeTilesetEventListeners()
      removeTilesetEventListeners = null
    }
    if (modelClickHandler) {
      try {
        modelClickHandler.destroy()
      } catch (e) {
        console.warn('Failed to destroy click handler', e)
      }
      modelClickHandler = null
    }
    stopGlobalFpsMonitoring()
    featureManager.destroy()
    undergroundViewController.destroy?.()
    modelList.value = []
    selectedModel.value = null
  }

  const getOriginalModelMatrix = () => originalModelMatrix

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
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,

    onConfigChange,
    toggleModelVisibility,
    updateModelOpacity,
    updateGlobalOpacity,
    resetAllOpacity,
    showAllModels,
    hideAllModels,
    fitToModel,
    fitToModels: fitToModel,
    resetView,
    resetModel,
    setUndergroundViewEnabled,
    updateGlobeTranslucency,
    enterUndergroundView,
    updatePosition,
    updateTransform,
    syncModelInfo,
    highlightModel,
    showModelProperties,
    showOnlyModel,
    updateModelId,
    reloadCurrentConfig,
    reloadCurrentModelWithLodConfig,
    saveModelConfig,
    disableSelection,
    enableSelection,
    initModel,
    destroyModel,

    lodConfig,
    getLodStats,
    updateLodConfig,
    applyLodPreset,
    resetLodConfig,
    DEFAULT_LOD_CONFIG,
    lodRuntime,
    adaptiveLoadState,

    tilesetRef,
    tileset: tilesetRef,
    modelClickHandler: () => modelClickHandler,
    getOriginalModelMatrix,

    fps,
    startGlobalFpsMonitoring,
    stopGlobalFpsMonitoring
  }
}
