import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'
import { logger } from '@/utils/logger.js'
import { isGeoreferencedTileset, surfaceAnchorLocal, surfaceAnchorWorld } from './modelTransform.js'
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

      const tileset = await Cesium.Cesium3DTileset.fromUrl(path, {
        ...lodConfig.value,
        // 视锥焦点渐进：视线中心高精度、边缘自动降精度，大场景帧率提升显著
        foveatedScreenSpaceError: true,
        foveatedConeSize: 0.3,
        foveatedMinimumScreenSpaceError: 24,
        // 预加载兄弟瓦片：聚合 tileset 的外部引用（地表/井下各层）尽早开始加载
        preloadSiblings: true,
        // 大数据集：提高缓存避免反复重新下载/解析已看过的瓦片
        cacheBytes: 1024 * 1024 * 1024,
        maximumCacheOverflowBytes: 1024 * 1024 * 1024,
        // 瓦片加载期不阻塞新请求调度
        dynamicScreenSpaceError: true,
        dynamicScreenSpaceErrorDensity: 0.0005
      })
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

      // ===== 自带地表锚点的模型：面板初始值 = 模型标称锚点 =====
      // 高程基准已在生成端固定（geoid 实测解算：椭球高 852.8 = 海拔 899.3 - 46.5），
      // 运行时不做 terrain delta 校正——倾斜摄影是厘米级真实地表，
      // World Terrain/DEM 为 30m 粗格网，强制贴合反而引入几十米级误差。
      if (isGeoreferencedTileset(tileset) && surfaceAnchorLocal(tileset)) {
        const surfaceWorld = surfaceAnchorWorld(tileset)
        const surfaceCarto = surfaceWorld && Cesium.Cartographic.fromCartesian(surfaceWorld)
        if (!surfaceCarto) {
          logger.warn('scene', '地表锚点解析失败，按本地模型处理')
        } else {
          const resultPosition = {
            longitude: Cesium.Math.toDegrees(surfaceCarto.longitude),
            latitude: Cesium.Math.toDegrees(surfaceCarto.latitude),
            height: surfaceCarto.height
          }
          const resultTransform = { rotationX: 0, rotationY: 0, rotationZ: 0 }
          // geo 模型原生水平姿态：清掉 demo 遗留的 15° X 旋转，位置面板同步锚点
          runtimeState.currentTransform = { ...resultTransform }
          runtimeState.initialPosition = { ...resultPosition }
          await resetViewToModel(tileset)
          // 渲染增强（与本地模型路径保持一致）
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
          return {
            type: 'success',
            message: '矿山模型已成功加载',
            position: { ...resultPosition },
            transform: { ...resultTransform },
            lodConfig: lodConfig.value,
            lodPreset: presetName
          }
        }
      }

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
      // 自带地表锚点的模型：面板同步为加载器返回的锚点（含地形校正），不回放上一模型位置
      if (surfaceAnchorLocal(tilesetRef.value)) {
        if (result.position) modelPosition.value = result.position
        if (result.transform) modelTransform.value = result.transform
      } else {
        updatePosition(savedPosition)
        updateTransform(savedTransform)
      }
      syncUndergroundViewIfNeeded()
      restoreCameraView(viewer, cameraSaved)
      interaction.initModelEventHandler(viewer, tilesetRef, feature => {
        // feature 为 null = 点击空白处：清除选中（高亮消失、属性面板收起）
        if (!feature) {
          selectedModel.value = null
          return
        }
        interaction.handleModelSelection(feature, modelList, selectedModel)
      })
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
      interaction.initModelEventHandler(viewer, tilesetRef, feature => {
        // feature 为 null = 点击空白处：清除选中（高亮消失、属性面板收起）
        if (!feature) {
          selectedModel.value = null
          return
        }
        interaction.handleModelSelection(feature, modelList, selectedModel)
      })

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
