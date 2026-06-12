import { apiConfig, onConfigLoaded } from '@/services/api/initApiConfig.js'

/**
 * 从统一缓存 apiConfig 获取模型配置列表（含 features 用于前端直接渲染）
 * 不再自行发起 fetch，统一由 initApiConfig 管理数据加载
 * @returns {Promise<Array<{name: string, path: string, model_id?: string, features?: Array}>>}
 */
export async function discoverModelConfigs() {
  const normalize = m => ({
    name: m.name,
    path: m.path,
    model_id: m.model_id,
    features: m.features ?? m.feature ?? null
  })
  if (apiConfig.loaded && apiConfig.modelConfigs) {
    const result = apiConfig.modelConfigs.map(normalize)
    console.log('[modelApi] 从 apiConfig 加载模型配置:', result.length, '条')
    return result
  }
  // 等待 apiConfig 加载完成
  return new Promise(resolve => {
    onConfigLoaded(() => {
      const result = (apiConfig.modelConfigs || []).map(normalize)
      console.log('[modelApi] apiConfig 加载完成，返回模型配置:', result.length, '条')
      resolve(result)
    })
  })
}

/**
 * 从数据库 API 获取模型特征
 */
export async function fetchModelFeatures(modelConfigId) {
  try {
    const res = await fetch(`/api/models/${modelConfigId}/features`)
    const json = await res.json()
    if (json.code === 0) {
      return json.data
    }
  } catch (e) {
    console.warn('[modelApi] fetchModelFeatures 失败:', e.message)
  }
  return null
}

export async function ensureResourceAvailable(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return true
}

export async function fetchJsonOrNull(path) {
  try {
    const response = await fetch(path)
    if (!response.ok) return null
    return await response.json()
  } catch (_) { return null }
}

/**
 * 保存模型配置到数据库
 */
export async function saveModelConfig(configPath, data) {
  const modelId = (data && data.model_id) || ''
  const name = (data && data.name) || ''
  const response = await fetch('/api/models/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: configPath, data, model_id: modelId, name })
  })
  if (!response.ok) return { success: false, message: '保存失败' }
  const result = await response.json()
  return { success: result?.code === 0, message: result?.message || '保存成功' }
}

/**
 * 从 API 加载矿卡配置（统一从 apiConfig 缓存获取）
 */
export async function fetchTrucks() {
  if (apiConfig.loaded && apiConfig.trucks) return apiConfig.trucks
  return new Promise(resolve => {
    onConfigLoaded(() => resolve(apiConfig.trucks || []))
  })
}

/**
 * 从 API 加载钻孔配置（统一从 apiConfig 缓存获取，返回数组）
 */
export async function fetchBoreholeConfig() {
  if (apiConfig.loaded && apiConfig.boreholes) return apiConfig.boreholes
  return new Promise(resolve => {
    onConfigLoaded(() => resolve(apiConfig.boreholes || []))
  })
}