import { reactive } from 'vue'
import {
  appendMissingModelsFromFeatureIds,
  buildDefaultModelListFromFeatureIds,
  buildModelMappingsForSave,
  normalizeModelMappingFromConfig
} from './modelListCore.js'
import {
  discoverModelConfigs,
  fetchModelFeatures,
  saveModelConfig as saveModelConfigApi
} from './modelApi.js'
import {
  createModelSelectionSnapshot,
  normalizeFeatures,
  normalizePath
} from './modelServiceHelpers.js'

export function getConfigCacheByPath(configPath, modelFeaturesCache) {
  if (!configPath) return null
  const exact = modelFeaturesCache.value.get(configPath)
  if (exact?.modelMappings?.length) return exact
  const normalizedTarget = normalizePath(configPath)
  for (const [path, cached] of modelFeaturesCache.value.entries()) {
    if (normalizePath(path) === normalizedTarget && cached?.modelMappings?.length) {
      return cached
    }
  }
  return null
}

export function getModelConfigId(configPath, modelConfigIdMap) {
  if (!configPath) return ''
  const exact = modelConfigIdMap.value.get(configPath)
  if (exact) return exact
  const normalizedTarget = normalizePath(configPath)
  for (const [path, modelId] of modelConfigIdMap.value.entries()) {
    if (normalizePath(path) === normalizedTarget) return modelId
  }
  return ''
}

export async function getFeatureDataForConfig(configPath, modelFeaturesCache, modelConfigIdMap) {
  const cached = getConfigCacheByPath(configPath, modelFeaturesCache)
  if (cached) return cached
  const modelId = getModelConfigId(configPath, modelConfigIdMap)
  if (!modelId) return null
  try {
    const fetched = await fetchModelFeatures(modelId)
    if (fetched?.modelMappings?.length) {
      modelFeaturesCache.value.set(configPath, fetched)
      return fetched
    }
  } catch (_) {
    /* ignore */
  }
  return null
}

export function syncSelectedModelAfterListUpdate(preferredSelection, modelList, selectedModel) {
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

export function initializeDefaultModelList({
  preferredSelection,
  modelList,
  interaction,
  getFeatureNameById,
  selectedModel,
  showOperationMessage
}) {
  modelList.value = []
  if (interaction.featureManager.getFeatureCount() === 0) return
  const featureIds = interaction.featureManager.getAllFeatureIds()
  modelList.value = buildDefaultModelListFromFeatureIds(featureIds, getFeatureNameById).map(model =>
    reactive(model)
  )
  syncSelectedModelAfterListUpdate(preferredSelection, modelList, selectedModel)
  if (modelList.value.length > 0) {
    showOperationMessage(`基于特征数据生成了 ${modelList.value.length} 个模型`, 'success')
  }
}

function applyModelListStyles(modelList, interaction, globalOpacity) {
  modelList.value.forEach(model => {
    if (model.styleProperties?.color && model.styleProperties.color !== '#ffffff') {
      interaction.featureManager.updateModelColor(
        model,
        model.styleProperties.color,
        globalOpacity.value
      )
    }
    interaction.featureManager.updateModelOpacity(model, globalOpacity.value)
    if (!model.visible) interaction.featureManager.toggleModelVisibility(model, 100)
  })
}

export function initializeModelList({
  propertiesData,
  preferredSelection,
  modelConfigRaw,
  modelList,
  interaction,
  tilesetRef,
  getFeatureNameById,
  selectedModel,
  globalOpacity,
  showOperationMessage
}) {
  if (
    propertiesData?.modelMappings &&
    Array.isArray(propertiesData.modelMappings) &&
    propertiesData.modelMappings.length > 0
  ) {
    modelConfigRaw.value = JSON.parse(JSON.stringify(propertiesData))
    modelList.value = propertiesData.modelMappings.map(model =>
      reactive(normalizeModelMappingFromConfig(model))
    )
    interaction.scanAndStoreFeatures(tilesetRef.value)
    const featureIds = interaction.featureManager.getAllFeatureIds()
    const additions = appendMissingModelsFromFeatureIds(
      modelList.value,
      featureIds,
      getFeatureNameById
    )
    additions.forEach(model => modelList.value.push(reactive(model)))
    interaction.syncDbModelsWithFeatures(modelList)
    applyModelListStyles(modelList, interaction, globalOpacity)
    syncSelectedModelAfterListUpdate(preferredSelection, modelList, selectedModel)
    showOperationMessage(`成功从数据库加载 ${modelList.value.length} 个模型的配置`, 'success')
    return
  }

  if (interaction.featureManager.getFeatureCount() === 0 && tilesetRef.value) {
    interaction.scanAndStoreFeatures(tilesetRef.value)
  }
  initializeDefaultModelList({
    preferredSelection,
    modelList,
    interaction,
    getFeatureNameById,
    selectedModel,
    showOperationMessage
  })
}

export async function loadModelProperties({
  selectedModel,
  currentConfigFile,
  modelFeaturesCache,
  modelConfigIdMap,
  interaction,
  tilesetRef,
  modelConfigRaw,
  modelList,
  getFeatureNameById,
  globalOpacity,
  showOperationMessage
}) {
  const preferredSelection = createModelSelectionSnapshot(selectedModel.value)
  const data = await getFeatureDataForConfig(
    currentConfigFile.value,
    modelFeaturesCache,
    modelConfigIdMap
  )
  if (data?.modelMappings?.length) {
    initializeModelList({
      propertiesData: data,
      preferredSelection,
      modelConfigRaw,
      modelList,
      interaction,
      tilesetRef,
      getFeatureNameById,
      selectedModel,
      globalOpacity,
      showOperationMessage
    })
    showOperationMessage('已从数据库加载模型配置', 'success')
    return
  }
  if (interaction.featureManager.getFeatureCount() === 0 && tilesetRef.value) {
    interaction.scanAndStoreFeatures(tilesetRef.value)
  }
  initializeDefaultModelList({
    preferredSelection,
    modelList,
    interaction,
    getFeatureNameById,
    selectedModel,
    showOperationMessage
  })
  showOperationMessage('数据库暂无模型配置，使用3D模型默认属性', 'info')
}

export function updateModelId(model, newId, modelList, showOperationMessage) {
  if (!model || !newId) return false
  const trimmed = newId.trim()
  if (!trimmed || trimmed === model.id) return true
  if (modelList.value.some(item => item.id === trimmed)) {
    showOperationMessage('ID 已存在，无法修改', 'warning')
    return false
  }
  const originalFeatureId = model.featureId || model.id
  model.id = trimmed
  if (!model.featureId) model.featureId = originalFeatureId
  if (model.geologyProperties) model.geologyProperties.ID = trimmed
  return true
}

export async function saveModelConfig({
  currentConfigFile,
  showOperationMessage,
  modelConfigIdMap,
  modelConfigFiles,
  modelList,
  modelConfigRaw
}) {
  if (!currentConfigFile.value) {
    showOperationMessage('未选择配置文件，无法保存', 'warning')
    return false
  }
  const modelId = getModelConfigId(currentConfigFile.value, modelConfigIdMap) || ''
  const configName =
    modelConfigFiles.value.find(file => file.path === currentConfigFile.value)?.name || ''
  const payload = {
    model_id: modelId,
    name: configName,
    ...((modelConfigRaw.value && typeof modelConfigRaw.value === 'object'
      ? modelConfigRaw.value
      : {}) || {}),
    modelMappings: buildModelMappingsForSave(modelList.value)
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
  } catch (_) {
    showOperationMessage('保存失败', 'error')
    return false
  }
}

function applyConfigCaches(configs, modelConfigFiles, modelConfigIdMap, modelFeaturesCache) {
  modelConfigFiles.value = configs
  const idMap = new Map()
  const featuresMap = new Map()
  configs.forEach(config => {
    if (config.model_id && config.path) idMap.set(config.path, config.model_id)
    const normalized = normalizeFeatures(config.features)
    if (config.path && normalized) featuresMap.set(config.path, normalized)
  })
  modelConfigIdMap.value = idMap
  modelFeaturesCache.value = featuresMap
  return { idMap, featuresMap }
}

async function backfillFirstFeatureCache(idMap, modelFeaturesCache) {
  if (modelFeaturesCache.value.size > 0 || idMap.size === 0) return
  for (const [path, modelId] of idMap.entries()) {
    try {
      const data = await fetchModelFeatures(modelId)
      if (data?.modelMappings?.length) {
        modelFeaturesCache.value.set(path, data)
        break
      }
    } catch (_) {
      /* continue */
    }
  }
}

function resolvePreferredConfig(
  configs,
  currentConfigFile,
  modelFeaturesCache,
  defaultModelConfigPath
) {
  if (configs.length === 0) return
  const hasCurrent =
    currentConfigFile.value && modelFeaturesCache.value.has(currentConfigFile.value)
  if (hasCurrent) return
  const preferredConfig =
    configs.find(
      config => config.path === defaultModelConfigPath && modelFeaturesCache.value.has(config.path)
    ) ||
    configs.find(config => modelFeaturesCache.value.has(config.path)) ||
    configs[0]
  currentConfigFile.value = preferredConfig.path
}

export async function discoverAvailableModels({
  modelConfigFiles,
  modelConfigIdMap,
  modelFeaturesCache,
  currentConfigFile,
  defaultModelConfigPath
}) {
  const configs = await discoverModelConfigs()
  const { idMap } = applyConfigCaches(
    configs,
    modelConfigFiles,
    modelConfigIdMap,
    modelFeaturesCache
  )
  await backfillFirstFeatureCache(idMap, modelFeaturesCache)
  resolvePreferredConfig(configs, currentConfigFile, modelFeaturesCache, defaultModelConfigPath)
}
