/**
 * API 配置加载器
 * 从数据库加载矿卡信息 + 模型地质信息
 */
const API = '/api'
const listeners = []

export const apiConfig = {
  modelConfigs: null,
  trucks: null,
  boreholes: null,
  orebodies: null,
  mineralTypes: null,
  miningPits: null,
  geologyStats: null,
  loaded: false
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

export async function loadApiConfig() {
  if (apiConfig.loaded) return apiConfig

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

    // 矿卡辅助数据 + 地质统计
    const [mineralTypes, miningPits, geologyStats] = await Promise.all([
      fetchJSONSafe(`${API}/monitoring/minerals`),
      fetchJSONSafe(`${API}/monitoring/mining-pits`),
      fetchJSONSafe(`${API}/geology/stats`)
    ])

    apiConfig.mineralTypes = mineralTypes
    apiConfig.miningPits = miningPits
    apiConfig.geologyStats = geologyStats

    apiConfig.loaded = true

    for (const fn of listeners) fn(apiConfig)
    listeners.length = 0
    return apiConfig
  } catch (e) {
    console.error('[API] 核心配置加载失败:', e.message)
    apiConfig.loaded = true
    for (const fn of listeners) fn(apiConfig)
    listeners.length = 0
    return apiConfig
  }
}

export function onConfigLoaded(fn) {
  if (apiConfig.loaded) { fn(apiConfig) }
  else { listeners.push(fn) }
}
