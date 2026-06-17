import { PRESETS, DEFAULT_MODEL_CONFIG_PATH } from '../../../config/constants/modelConfig.js'

export function normalizeFeatures(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (_) {
      return null
    }
  }
  if (Array.isArray(raw)) return raw.length > 0 ? { modelMappings: raw } : null
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.modelMappings) && raw.modelMappings.length > 0) return raw
    if (Array.isArray(raw.features) && raw.features.length > 0) {
      return { modelMappings: raw.features }
    }
  }
  return null
}

export function normalizePath(path) {
  if (!path) return ''
  return path.replace(/^\//, '').replace(/\/+/g, '/').toLowerCase()
}

export function createModelSelectionSnapshot(model) {
  if (!model) return null
  return {
    id: model.id || '',
    featureId: model.featureId || model.feature_id || model.id || '',
    name: model.name || ''
  }
}

export function getPreset(presetName) {
  return PRESETS[presetName] || null
}

export function resolveTilesetPath(configPath) {
  if (!configPath) return DEFAULT_MODEL_CONFIG_PATH.replace(/feature\.json$/i, 'tileset.json')
  const dirPath = configPath.substring(0, configPath.lastIndexOf('/'))
  return `${dirPath}/tileset.json`
}
