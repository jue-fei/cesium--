import { warn } from '@/utils/errorHandler.js'

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

export function createDefaultModelData(featureId, featureName) {
  return {
    id: featureId,
    featureId,
    name: featureName,
    type: 'unknown',
    category: 'Unknown',
    visible: true,
    opacity: 0,
    includeInConfig: false,
    depth: null,
    styleProperties: {
      color: '#ffffff',
      opacity: 1,
      visible: true,
      highlightColor: '#ffffff'
    },
    geologyProperties: { 地质类型: 'Unknown', ID: featureId }
  }
}

export function applyModelClassificationData(model, featureId, featureName) {
  const idLower = String(featureId || '').toLowerCase()
  const nameLower = String(featureName || '').toLowerCase()
  for (const classification of MODEL_CLASSIFICATIONS) {
    if (classification.keywords.some(k => idLower.includes(k) || nameLower.includes(k))) {
      model.type = classification.type
      model.category = classification.category
      model.geologyProperties = model.geologyProperties || {}
      model.geologyProperties['地质类型'] = classification.geologyType
      break
    }
  }
  return model
}

export function getFeatureNameFromFeature(feature, fallbackName = 'Unknown Model') {
  let featureName = fallbackName
  try {
    if (feature) {
      featureName =
        feature.getProperty('name') ||
        feature.getProperty('Name') ||
        feature.getProperty('description') ||
        featureName
    }
  } catch (e) {
    warn('model', 'modelList', e)
  }
  return featureName
}

export function normalizeModelMappingFromConfig(modelMapping) {
  const model = modelMapping && typeof modelMapping === 'object' ? modelMapping : {}
  const style = model.styleProperties || model.style_properties || {}
  const normalizedStyle = {
    color: style.color || '#ffffff',
    opacity: typeof style.opacity === 'number' ? style.opacity : 1,
    visible: typeof style.visible === 'boolean' ? style.visible : true,
    highlightColor: style.highlightColor || style.color || '#ffffff'
  }
  const featureId = model.feature_id || model.featureId || model.id
  // style.opacity 范围 0(透明)~1(不透明)，转换为 UI transparency 0(不透明)~100(完全透明)
  const uiOpacity = Math.max(
    0,
    Math.min(100, Math.round((1 - (typeof style.opacity === 'number' ? style.opacity : 1)) * 100))
  )
  return {
    ...model,
    id: model.id || featureId,
    featureId,
    visible: normalizedStyle.visible,
    opacity: uiOpacity,
    depth: typeof model.depth === 'number' ? model.depth : null,
    includeInConfig: true,
    sourceFeature: JSON.parse(JSON.stringify(model)),
    styleProperties: normalizedStyle,
    geologyProperties: model.geologyProperties || model.geology_properties || {},
    miningProperties: model.miningProperties || model.mining_properties || {},
    safetyProperties: model.safetyProperties || model.safety_properties || {}
  }
}

export function createClassifiedModelData(featureId, featureName) {
  return applyModelClassificationData(
    createDefaultModelData(featureId, featureName),
    featureId,
    featureName
  )
}

export function buildDefaultModelListFromFeatureIds(featureIds, getFeatureNameById) {
  if (!Array.isArray(featureIds) || featureIds.length === 0) return []
  return featureIds.map(featureId => {
    const featureName =
      typeof getFeatureNameById === 'function' ? getFeatureNameById(featureId) : String(featureId)
    return createClassifiedModelData(featureId, featureName)
  })
}

export function appendMissingModelsFromFeatureIds(modelList, featureIds, getFeatureNameById) {
  const currentList = Array.isArray(modelList) ? modelList : []
  if (!Array.isArray(featureIds) || featureIds.length === 0) return []
  const existing = new Set(currentList.map(m => m?.featureId || m?.id))
  const additions = []
  featureIds.forEach(featureId => {
    if (existing.has(featureId)) return
    const featureName =
      typeof getFeatureNameById === 'function' ? getFeatureNameById(featureId) : String(featureId)
    additions.push(createClassifiedModelData(featureId, featureName))
  })
  return additions
}

export function buildModelMappingsForSave(modelList) {
  const list = Array.isArray(modelList) ? modelList : []
  return list
    .filter(model => model?.includeInConfig === true)
    .map(model => {
      const style = model.styleProperties || {}
      const transparencyValue = model.opacity != null ? model.opacity : 0
      const opacityValue =
        typeof style.opacity === 'number'
          ? style.opacity
          : 1 - Math.max(0, Math.min(100, transparencyValue)) / 100
      const depth = typeof model.depth === 'number' ? model.depth : null
      const featureBindingId = model.featureId || model.feature_id || model.id
      const result = {
        id: model.id,
        featureId: featureBindingId,
        feature_id: featureBindingId,
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
      if (depth !== null) result.depth = depth
      return result
    })
}
