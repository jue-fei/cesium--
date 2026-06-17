/**
 * API 配置加载器
 * 从数据库加载矿卡信息 + 模型地质信息
 */
import { logger } from '@/utils/logger.js'

const API = '/api'
const listeners = []
let loadPromise = null
const API_CONFIG_MARK_START = 'api-config-load:start'
const API_CONFIG_MARK_END = 'api-config-load:end'

export const apiConfig = {
  modelConfigs: null,
  trucks: null,
  boreholes: null,
  orebodies: null,
  mineralTypes: null,
  miningPits: null,
  geologyStats: null,
  loaded: false,
  error: null
}

async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API ${url} 返回 ${res.status}`)
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.message || 'API 错误')
  return json.data
}

async function fetchJSONSafe(url) {
  try {
    return await fetchJSON(url)
  } catch (e) {
    return null
  }
}

function resetApiConfig() {
  apiConfig.modelConfigs = null
  apiConfig.trucks = null
  apiConfig.boreholes = null
  apiConfig.orebodies = null
  apiConfig.mineralTypes = null
  apiConfig.miningPits = null
  apiConfig.geologyStats = null
  apiConfig.loaded = false
}

function notifyLoaded() {
  for (const fn of listeners) fn(apiConfig)
  listeners.length = 0
}

export async function loadApiConfig() {
  if (apiConfig.loaded) return apiConfig
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    performance.mark(API_CONFIG_MARK_START)
    resetApiConfig()
    apiConfig.error = null

    try {
      // 核心数据：模型 / 矿卡 / 钻孔 / 矿体
      const [models, trucks, boreholes, orebodies] = await Promise.all([
        fetchJSON(`${API}/models`),
        fetchJSON(`${API}/trucks`),
        fetchJSON(`${API}/boreholes`),
        fetchJSON(`${API}/orebodies`)
      ])

      apiConfig.modelConfigs = models
      apiConfig.trucks = trucks
      apiConfig.boreholes = boreholes
      apiConfig.orebodies = orebodies

      // 辅助数据失败时允许保留为空，不阻断应用初始化。
      const [mineralTypes, miningPits, geologyStats] = await Promise.all([
        fetchJSONSafe(`${API}/monitoring/minerals`),
        fetchJSONSafe(`${API}/monitoring/mining-pits`),
        fetchJSONSafe(`${API}/geology/stats`)
      ])

      apiConfig.mineralTypes = mineralTypes
      apiConfig.miningPits = miningPits
      apiConfig.geologyStats = geologyStats
      apiConfig.loaded = true
      performance.mark(API_CONFIG_MARK_END)
      performance.measure('api-config-load', API_CONFIG_MARK_START, API_CONFIG_MARK_END)
      logger.info('api-config', '核心配置加载完成', {
        models: models.length,
        trucks: trucks.length,
        boreholes: boreholes.length,
        orebodies: orebodies.length
      })
      notifyLoaded()
      return apiConfig
    } catch (error) {
      resetApiConfig()
      apiConfig.error = error
      logger.error('api-config', '核心配置加载失败', null, error)
      throw new Error(`核心配置加载失败: ${error.message}`)
    } finally {
      loadPromise = null
    }
  })()

  return loadPromise
}

export function onConfigLoaded(fn) {
  if (apiConfig.loaded) {
    fn(apiConfig)
  } else {
    listeners.push(fn)
  }
}
