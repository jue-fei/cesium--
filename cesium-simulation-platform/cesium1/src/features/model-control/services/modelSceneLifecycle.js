import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'
import {
  createModelSelectionSnapshot,
  getPreset,
  resolveTilesetPath
} from './modelServiceHelpers.js'
import { getRenderEnhancementManager } from '@/features/lod-optimization/services/renderEnhancementManager.js'

function clearLoadedTileset(viewer, tilesetRef, runtimeState) {
  if (tilesetRef.value && viewer.scene.primitives.contains(tilesetRef.value)) {
    viewer.scene.primitives.remove(tilesetRef.value)
    tilesetRef.value = null
    runtimeState.originalModelMatrix = null
    runtimeState.originalBoundingSphereCenter = null
  }
}

function clearTilesetListeners(runtimeState) {
  if (!runtimeState.removeTilesetEventListeners) return
  runtimeState.removeTilesetEventListeners()
  runtimeState.removeTilesetEventListeners = null
}

function resolveFinalLodConfig(lodConfigParam, presetName, defaultLodConfig) {
  const preset = getPreset(presetName)
  if (preset && Object.keys(lodConfigParam).length === 0) {
    return { ...defaultLodConfig, ...preset.config }
  }
  return { ...defaultLodConfig, ...lodConfigParam }
}

function buildLoadSuccessResult(defaultPosition, defaultTransform, lodConfig, presetName) {
  return {
    type: 'success',
    message: '矿山模型已成功加载',
    position: { ...defaultPosition },
    transform: { ...defaultTransform },
    lodConfig: lodConfig.value,
    lodPreset: presetName
  }
}

export async function load3DModel({
  modelPaths,
  lodConfigParam = {},
  presetName = 'balanced',
  getViewer,
  measurement,
  tilesetRef,
  runtimeState,
  resetLodRuntime,
  adaptiveLoad,
  defaultModelConfigPath,
  defaultLodConfig,
  lodConfig,
  updateLodRuntime,
  bindTilesetLodRuntimeEvents,
  resetViewToModel,
  defaultPosition,
  defaultTransform,
  applyModelTransform,
  ensureResourceAvailable
}) {
  const viewer = getViewer()
  if (!viewer) return { type: 'error', message: 'Cesium Viewer未初始化' }

  measurement.clearHistoryVisualization()
  clearLoadedTileset(viewer, tilesetRef, runtimeState)
  clearTilesetListeners(runtimeState)
  resetLodRuntime()
  adaptiveLoad.resetAdaptiveLoadState()

  const possiblePaths = modelPaths || [resolveTilesetPath(defaultModelConfigPath)]
  for (const path of possiblePaths) {
    try {
      await ensureResourceAvailable(path)
      lodConfig.value = resolveFinalLodConfig(lodConfigParam, presetName, defaultLodConfig)
      adaptiveLoad.syncAdaptiveBaseline(lodConfig.value)

      const tileset = await Cesium.Cesium3DTileset.fromUrl(path, { ...lodConfig.value })
      viewer.scene.primitives.add(tileset)
      await tileset.readyPromise

      tilesetRef.value = tileset
      runtimeState.removeTilesetEventListeners = bindTilesetLodRuntimeEvents(
        viewer,
        tileset,
        patch => updateLodRuntime(patch)
      )
      runtimeState.originalModelMatrix = Cesium.Matrix4.clone(tileset.modelMatrix)
      runtimeState.originalBoundingSphereCenter = Cesium.Cartesian3.clone(
        tileset.boundingSphere.center
      )

      applyModelTransform(
        tileset,
        runtimeState.originalModelMatrix,
        defaultPosition,
        defaultTransform,
        runtimeState.originalBoundingSphereCenter
      )
      await resetViewToModel(tileset)

      // tileset 加载完成后触发渲染增强重新应用
      try {
        const enhancement = getRenderEnhancementManager()
        if (enhancement.state.attached) {
          tileset.shadows = Cesium.ShadowMode.ENABLED
          enhancement.applyToTileset(tileset)
          enhancement.applyAll()
        }
      } catch (e) {
        // 安全忽略：渲染增强应用失败不影响模型加载
      }

      return buildLoadSuccessResult(defaultPosition, defaultTransform, lodConfig, presetName)
    } catch (error) {
      console.error(`Model load failed (${path}):`, error)
    }
  }

  return { type: 'warning', message: '3D模型加载失败' }
}

function restoreCameraView(viewer, cameraSaved) {
  if (!cameraSaved || !viewer) return
  viewer.camera.setView({
    destination: cameraSaved.position,
    orientation: { direction: cameraSaved.direction, up: cameraSaved.up }
  })
}

export async function reloadCurrentModelWithLodConfig({
  nextLodConfig,
  presetName = 'custom',
  currentConfigFile,
  modelPosition,
  modelTransform,
  getViewer,
  selectedModel,
  modelList,
  interaction,
  getFeatureDataForConfig,
  loading,
  modelLoadStatus,
  load3DModel,
  initializeModelList,
  initializeDefaultModelList,
  tilesetRef,
  updatePosition,
  updateTransform,
  syncUndergroundViewIfNeeded
}) {
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
      if (featureData?.modelMappings?.length) {
        initializeModelList(featureData, preferredSelection)
      } else {
        initializeDefaultModelList(preferredSelection)
      }
      updatePosition(savedPosition)
      updateTransform(savedTransform)
      syncUndergroundViewIfNeeded()
      restoreCameraView(viewer, cameraSaved)
      interaction.initModelEventHandler(viewer, tilesetRef, feature =>
        interaction.handleModelSelection(feature, modelList, selectedModel)
      )
    }
    return result
  } catch (error) {
    console.error(error)
    initializeDefaultModelList(createModelSelectionSnapshot(selectedModel.value))
    loading.value = false
    return { type: 'error', message: error.message || '模型重载失败' }
  }
}

export async function onConfigChange(
  configFilePath,
  currentConfigFile,
  reloadCurrentModelWithLodConfig
) {
  if (configFilePath) currentConfigFile.value = configFilePath
  if (!currentConfigFile.value) return
  await reloadCurrentModelWithLodConfig()
}

export async function initModel({
  loading,
  discoverAvailableModels,
  currentConfigFile,
  load3DModel,
  modelLoadStatus,
  getViewer,
  tilesetRef,
  interaction,
  modelList,
  selectedModel,
  getFeatureDataForConfig,
  initializeModelList,
  loadModelProperties,
  syncUndergroundViewIfNeeded,
  modelPosition,
  modelTransform
}) {
  loading.value = true
  try {
    await discoverAvailableModels()
    const initialTilesetPath = resolveTilesetPath(currentConfigFile.value)
    const loadResult = await load3DModel([initialTilesetPath])
    modelLoadStatus.value = loadResult

    const viewer = getViewer()
    if (tilesetRef.value) {
      interaction.scanAndStoreFeatures(tilesetRef.value)
      interaction.initModelEventHandler(viewer, tilesetRef, feature =>
        interaction.handleModelSelection(feature, modelList, selectedModel)
      )

      if (currentConfigFile.value) {
        const dbData = await getFeatureDataForConfig(currentConfigFile.value)
        if (dbData?.modelMappings?.length) {
          initializeModelList(dbData)
        } else {
          await loadModelProperties()
        }
      } else {
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

export function destroyModel({
  getViewer,
  tilesetRef,
  runtimeState,
  adaptiveLoad,
  lodConfig,
  interaction,
  undergroundViewController,
  modelList,
  selectedModel
}) {
  const viewer = getViewer()
  if (tilesetRef.value && viewer?.scene?.primitives?.contains(tilesetRef.value)) {
    viewer.scene.primitives.remove(tilesetRef.value)
  }
  tilesetRef.value = null
  runtimeState.originalModelMatrix = null
  runtimeState.originalBoundingSphereCenter = null
  clearTilesetListeners(runtimeState)
  adaptiveLoad.stopGlobalFpsMonitoring(tilesetRef, lodConfig)
  interaction.destroy()
  undergroundViewController.destroy?.()
  modelList.value = []
  selectedModel.value = null
}

export async function fitToModel(getViewer, tilesetRef) {
  const viewer = getViewer()
  if (viewer && tilesetRef.value) {
    try {
      await viewer.zoomTo(tilesetRef.value)
    } catch (error) {
      warn('model', 'useModel', error)
    }
  }
}
