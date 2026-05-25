import { ref, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import { FeatureManager } from '../features/model/featureManager.js'
import { applyModelTransform } from '../features/model/transform/modelTransform.js'

import {
  PRESETS,
  DEFAULT_TRANSFORM,
  DEFAULT_LOD_CONFIG,
  DEFAULT_POSITION
} from '../config/constants/modelConfig.js'
import {
  discoverModelConfigs,
  ensureResourceAvailable,
  fetchJsonOrNull,
  saveModelConfig as saveModelConfigApi
} from '../features/model/modelApi.js'
import { useModelStore } from '../stores/modelStore.js'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'
import useMeasurement from './useMeasurement.js'

// 内部共享状态（非响应式，或仅用于运行时逻辑）
let originalModelMatrix = null
let originalBoundingSphereCenter = null
let currentTransform = { ...DEFAULT_TRANSFORM }
let modelClickHandler = null
let savedGlobeTranslucency = null
let savedCollisionDetection = null
let savedDepthTestAgainstTerrain = null
let removeTilesetEventListeners = null

const featureManager = new FeatureManager()
const MODEL_CLASSIFICATIONS = [
  {
    keywords: ['surface', '地表'],
    type: 'surface',
    category: '地形地貌',
    geologyType: '地表层'
  },
  {
    keywords: ['terrain', '地形'],
    type: 'terrain',
    category: '地形地貌',
    geologyType: '地形模型'
  },
  {
    keywords: ['pit', '采场'],
    type: 'mining_pit',
    category: '采矿工程',
    geologyType: '露天采场'
  },
  { keywords: ['ore', '矿体'], type: 'ore_body', category: '矿产资源', geologyType: '矿体' },
  { keywords: ['waste', '废石'], type: 'waste_body', category: '矿产资源', geologyType: '废石' }
]

function getPreset(presetName) {
  return PRESETS[presetName] || null
}

// 简单 FPS 监控器
const fps = ref(0)
let fpsFrameCount = 0
let fpsLastTime = Date.now()
let fpsHandler = null

function startGlobalFpsMonitoring() {
  const { getViewer } = useViewer()
  const viewer = getViewer()
  if (!viewer || fpsHandler) return

  const scene = viewer.scene

  fpsHandler = scene.postRender.addEventListener(() => {
    const now = Date.now()
    fpsFrameCount++

    if (now - fpsLastTime >= 1000) {
      fps.value = fpsFrameCount
      fpsFrameCount = 0
      fpsLastTime = now
    }
  })
}

function stopGlobalFpsMonitoring() {
  if (fpsHandler) {
    fpsHandler()
    fpsHandler = null
  }
}

function createDefaultModel(featureId, featureName) {
  return reactive({
    id: featureId,
    featureId,
    name: featureName,
    type: 'unknown',
    category: 'Unknown',
    visible: true,
    opacity: 0,
    includeInConfig: false,
    styleProperties: {
      color: '#ffffff',
      opacity: 1,
      visible: true,
      highlightColor: '#ffffff'
    },
    geologyProperties: { 地质类型: 'Unknown', ID: featureId }
  })
}

function applyModelClassification(model, featureId, featureName) {
  const idLower = featureId.toLowerCase()
  const nameLower = featureName.toLowerCase()
  for (const classification of MODEL_CLASSIFICATIONS) {
    if (classification.keywords.some(k => idLower.includes(k) || nameLower.includes(k))) {
      model.type = classification.type
      model.category = classification.category
      model.geologyProperties['地质类型'] = classification.geologyType
      break
    }
  }
  return model
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

  const { showOperationMessage } = useMessage()

  const onTilesetLoaded = () => null

  const { getViewer, resetViewToModel } = useViewer()

  const resetLodRuntime = () => {
    lodRuntime.value = {
      pendingRequests: 0,
      tilesProcessing: 0,
      initialTilesLoaded: false,
      allTilesLoaded: false,
      lastUpdatedMs: 0
    }
  }

  const updateLodRuntime = patch => {
    if (!lodRuntime.value || typeof lodRuntime.value !== 'object') {
      resetLodRuntime()
    }
    Object.assign(lodRuntime.value, patch, { lastUpdatedMs: Date.now() })
  }

  const bindTilesetRuntimeEvents = tileset => {
    if (!tileset) return () => null

    const onLoadProgress = (pendingRequests, tilesProcessing) => {
      updateLodRuntime({
        pendingRequests: Number(pendingRequests) || 0,
        tilesProcessing: Number(tilesProcessing) || 0
      })
    }

    const onInitialTilesLoaded = () => {
      updateLodRuntime({ initialTilesLoaded: true })
    }

    const onAllTilesLoaded = () => {
      updateLodRuntime({ allTilesLoaded: true })
    }

    tileset.loadProgress.addEventListener(onLoadProgress)
    tileset.initialTilesLoaded.addEventListener(onInitialTilesLoaded)
    tileset.allTilesLoaded.addEventListener(onAllTilesLoaded)

    return () => {
      try {
        tileset.loadProgress.removeEventListener(onLoadProgress)
        tileset.initialTilesLoaded.removeEventListener(onInitialTilesLoaded)
        tileset.allTilesLoaded.removeEventListener(onAllTilesLoaded)
      } catch (e) {
        void e
      }
    }
  }

  const getFeatureNameById = featureId => {
    let featureName = 'Unknown Model'
    try {
      const feature = featureManager.featureMap.get(featureId)
      if (feature) {
        featureName =
          feature.getProperty('name') ||
          feature.getProperty('Name') ||
          feature.getProperty('description') ||
          featureName
      }
    } catch (e) {
      void e
    }
    return featureName
  }

  function applyConfigToTileset(config) {
    if (!tilesetRef.value) return false
    const t = tilesetRef.value
    Object.keys(config).forEach(prop => {
      if (prop in t && typeof t[prop] !== 'function') {
        try {
          t[prop] = config[prop]
        } catch (e) {
          console.warn(`Failed to set property ${prop} on tileset`, e)
        }
      }
    })

    const viewer = getViewer()
    if (viewer) {
      viewer.scene.requestRender()
    }

    return true
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

    const possiblePaths = modelPaths || ['./3d/demo4/tileset.json']

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

        // @ts-ignore
        lodConfig.value = { ...finalLodConfig }

        // @ts-ignore
        const t = await Cesium.Cesium3DTileset.fromUrl(path, lodConfig.value)
        viewer.scene.primitives.add(t)
        await t.readyPromise

        tilesetRef.value = t
        removeTilesetEventListeners = bindTilesetRuntimeEvents(t)
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
      const { isMeasuring, isAreaMeasuring } = useMeasurement()
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
      const tempModel = createDefaultModel(featureId, `未分类模型 (${featureId})`)
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
    featureIds.forEach(featureId => {
      const featureName = getFeatureNameById(featureId)
      const model = applyModelClassification(
        createDefaultModel(featureId, featureName),
        featureId,
        featureName
      )
      modelList.value.push(model)
    })

    if (modelList.value.length > 0) {
      showOperationMessage(`基于特征数据生成了 ${modelList.value.length} 个模型`, 'success')
    }
  }

  const appendMissingModelsFromFeatures = () => {
    if (featureManager.getFeatureCount() === 0) return
    const featureIds = featureManager.getAllFeatureIds()
    const existing = new Set(modelList.value.map(m => m.featureId || m.id))
    featureIds.forEach(featureId => {
      if (existing.has(featureId)) return
      const featureName = getFeatureNameById(featureId)
      const model = applyModelClassification(
        createDefaultModel(featureId, featureName),
        featureId,
        featureName
      )
      modelList.value.push(model)
    })
  }

  const initializeModelList = propertiesData => {
    if (propertiesData.modelMappings && Array.isArray(propertiesData.modelMappings)) {
      modelConfigRaw.value = JSON.parse(JSON.stringify(propertiesData))
      modelList.value = propertiesData.modelMappings.map(model => {
        const style = model.styleProperties || {}
        const normalizedStyle = {
          color: style.color || '#ffffff',
          opacity: typeof style.opacity === 'number' ? style.opacity : 1,
          visible: typeof style.visible === 'boolean' ? style.visible : true,
          highlightColor: style.highlightColor || style.color || '#ffffff'
        }
        const featureId = model.featureId || model.id
        return reactive({
          ...model,
          featureId,
          visible: normalizedStyle.visible,
          opacity: 0,
          includeInConfig: true,
          styleProperties: normalizedStyle,
          geologyProperties: model.geologyProperties || {},
          miningProperties: model.miningProperties || {},
          safetyProperties: model.safetyProperties || {}
        })
      })
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
    candidates.push('./3d/demo4/feature.json')

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

  const onConfigChange = async configFilePath => {
    if (configFilePath) currentConfigFile.value = configFilePath
    if (!currentConfigFile.value) return

    try {
      // 根据配置文件路径推导模型路径
      // 约定结构：.../目录/feature.json -> .../目录/tileset.json
      const configPath = currentConfigFile.value
      const dirPath = configPath.substring(0, configPath.lastIndexOf('/'))
      const modelPath = `${dirPath}/tileset.json`

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

      // 优先从配置文件路径读取要素数据
      const featureData = await fetchJsonOrNull(configPath)

      loading.value = true
      const result = await load3DModel([modelPath])
      loading.value = false

      modelLoadStatus.value = result
      if (result.type !== 'error' && tilesetRef.value) {
        featureManager.setTileset(tilesetRef.value)
        scanAndStoreFeatures()

        if (featureData) initializeModelList(featureData)
        else initializeDefaultModelList()

        // 恢复模型变换
        updatePosition(savedPosition)
        updateTransform(savedTransform)

        if (cameraSaved && viewer) {
          viewer.camera.setView({
            destination: cameraSaved.position,
            orientation: { direction: cameraSaved.direction, up: cameraSaved.up }
          })
        }

        onTilesetLoaded(tilesetRef.value)
        initModelEventHandler()
      }
    } catch (error) {
      console.error(error)
      initializeDefaultModelList()
      loading.value = false
    }
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
    if (currentConfigFile.value) await onConfigChange(currentConfigFile.value)
  }

  const saveModelConfig = async () => {
    if (!currentConfigFile.value) {
      showOperationMessage('未选择配置文件，无法保存', 'warning')
      return false
    }

    const modelMappings = modelList.value
      .filter(model => model.includeInConfig === true)
      .map(model => {
        const style = model.styleProperties || {}
        const opacityValue =
          typeof style.opacity === 'number' ? style.opacity : 1 - (model.opacity || 0) / 100
        return {
          id: model.id,
          featureId: model.featureId || model.id,
          name: model.name,
          type: model.type,
          category: model.category,
          styleProperties: {
            color: style.color || '#ffffff',
            opacity: opacityValue,
            visible: model.visible,
            highlightColor: style.highlightColor || style.color || '#ffffff'
          },
          geologyProperties: model.geologyProperties || {},
          miningProperties: model.miningProperties || {},
          safetyProperties: model.safetyProperties || {}
        }
      })

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
    const viewer = getViewer()
    if (!viewer || !viewer.scene) return
    const globe = viewer.scene.globe
    const controller = viewer.scene.screenSpaceCameraController
    if (!globe || !globe.translucency || !controller) return

    if (enabled) {
      if (!savedGlobeTranslucency) {
        savedGlobeTranslucency = {
          enabled: globe.translucency.enabled,
          frontFaceAlpha: globe.translucency.frontFaceAlpha,
          backFaceAlpha: globe.translucency.backFaceAlpha,
          rectangle: Cesium.Rectangle.clone(globe.translucency.rectangle, new Cesium.Rectangle())
        }
      }
      if (savedCollisionDetection === null) {
        savedCollisionDetection = controller.enableCollisionDetection
      }
      if (savedDepthTestAgainstTerrain === null) {
        savedDepthTestAgainstTerrain = globe.depthTestAgainstTerrain
      }

      globe.translucency.enabled = true
      globe.translucency.frontFaceAlpha = Cesium.Math.clamp(globeFrontFaceAlpha.value / 100, 0, 1)
      globe.translucency.backFaceAlpha = Cesium.Math.clamp(globeBackFaceAlpha.value / 100, 0, 1)
      globe.depthTestAgainstTerrain = false
      controller.enableCollisionDetection = false

      const center = tilesetRef.value?.boundingSphere?.center
      const radius = tilesetRef.value?.boundingSphere?.radius
      if (center && typeof radius === 'number' && Number.isFinite(radius)) {
        const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(center)
        if (carto) {
          const delta = Cesium.Math.clamp(
            (radius * 2.5) / Cesium.Ellipsoid.WGS84.maximumRadius,
            0,
            0.6
          )
          const west = carto.longitude - delta
          const east = carto.longitude + delta
          const south = Cesium.Math.clamp(
            carto.latitude - delta,
            -Cesium.Math.PI_OVER_TWO,
            Cesium.Math.PI_OVER_TWO
          )
          const north = Cesium.Math.clamp(
            carto.latitude + delta,
            -Cesium.Math.PI_OVER_TWO,
            Cesium.Math.PI_OVER_TWO
          )
          globe.translucency.rectangle = Cesium.Rectangle.fromRadians(west, south, east, north)
        } else {
          globe.translucency.rectangle = undefined
        }
      } else {
        globe.translucency.rectangle = undefined
      }
    } else {
      if (savedGlobeTranslucency) {
        globe.translucency.enabled = savedGlobeTranslucency.enabled
        globe.translucency.frontFaceAlpha = savedGlobeTranslucency.frontFaceAlpha
        globe.translucency.backFaceAlpha = savedGlobeTranslucency.backFaceAlpha
        globe.translucency.rectangle = savedGlobeTranslucency.rectangle
        savedGlobeTranslucency = null
      } else {
        globe.translucency.enabled = false
        globe.translucency.rectangle = undefined
      }
      if (savedCollisionDetection !== null) {
        controller.enableCollisionDetection = savedCollisionDetection
        savedCollisionDetection = null
      }
      if (savedDepthTestAgainstTerrain !== null) {
        globe.depthTestAgainstTerrain = savedDepthTestAgainstTerrain
        savedDepthTestAgainstTerrain = null
      }
    }

    viewer.scene.requestRender()
  }

  const setUndergroundViewEnabled = enabled => {
    undergroundViewEnabled.value = !!enabled
    applyUndergroundView(undergroundViewEnabled.value)
  }

  const updateGlobeTranslucency = ({ frontFaceAlpha, backFaceAlpha } = {}) => {
    if (typeof frontFaceAlpha === 'number') globeFrontFaceAlpha.value = frontFaceAlpha
    if (typeof backFaceAlpha === 'number') globeBackFaceAlpha.value = backFaceAlpha

    if (!undergroundViewEnabled.value) return
    const viewer = getViewer()
    if (!viewer || !viewer.scene || !viewer.scene.globe?.translucency) return
    viewer.scene.globe.translucency.frontFaceAlpha = Cesium.Math.clamp(
      globeFrontFaceAlpha.value / 100,
      0,
      1
    )
    viewer.scene.globe.translucency.backFaceAlpha = Cesium.Math.clamp(
      globeBackFaceAlpha.value / 100,
      0,
      1
    )
    viewer.scene.requestRender()
  }

  const enterUndergroundView = () => {
    const viewer = getViewer()
    if (!viewer || !tilesetRef.value) return

    if (!undergroundViewEnabled.value) {
      undergroundViewEnabled.value = true
      applyUndergroundView(true)
    }

    const center = tilesetRef.value.boundingSphere?.center
    const radius = tilesetRef.value.boundingSphere?.radius || 200
    if (!center) return

    const normal = Cesium.Cartesian3.normalize(center, new Cesium.Cartesian3())
    const move = Math.max(200, radius * 1.5)
    const destination = Cesium.Cartesian3.subtract(
      center,
      Cesium.Cartesian3.multiplyByScalar(normal, move, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    )

    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(center, destination, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    )
    const up = Cesium.Cartesian3.normalize(destination, new Cesium.Cartesian3())

    viewer.camera.flyTo({
      destination,
      orientation: { direction, up },
      duration: 0.8
    })
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
      return applyConfigToTileset(lodConfig.value)
    }
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
      const demo4 = configs.find(c => c.path.includes('demo4'))
      currentConfigFile.value = demo4 ? demo4.path : configs[0].path
    }
  }

  const initModel = async () => {
    loading.value = true
    try {
      // 第一步：发现模型配置
      await discoverAvailableModels()

      // 第二步：确定初始模型路径
      let initialTilesetPath = './3d/demo4/tileset.json'
      if (currentConfigFile.value) {
        const configPath = currentConfigFile.value
        const dirPath = configPath.substring(0, configPath.lastIndexOf('/'))
        initialTilesetPath = `${dirPath}/tileset.json`
      }

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

        onTilesetLoaded(tilesetRef.value)
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
        void e
      }
    }
  }

  const getLodStats = () => {
    return {
      ...lodRuntime.value,
      totalMemoryUsageInBytes: tilesetRef.value ? tilesetRef.value.totalMemoryUsageInBytes : 0
    }
  }

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
    saveModelConfig,
    disableSelection,
    enableSelection,
    initModel,

    lodConfig,
    getLodStats,
    updateLodConfig,
    applyLodPreset,
    resetLodConfig,
    DEFAULT_LOD_CONFIG,
    lodRuntime,

    tilesetRef,
    tileset: tilesetRef,
    modelClickHandler: () => modelClickHandler,

    fps,
    startGlobalFpsMonitoring,
    stopGlobalFpsMonitoring
  }
}
