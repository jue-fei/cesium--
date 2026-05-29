import axios from 'axios'

const API_BASE = '/api'

const client = axios.create({
  baseURL: API_BASE,
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' }
})

// 请求拦截器：记录请求
client.interceptors.request.use(
  config => {
    if (import.meta.env.DEV) {
      console.debug(`[API] ${config.method?.toUpperCase()} ${config.url}`)
    }
    return config
  },
  error => Promise.reject(error)
)

// 响应拦截器：统一提取 data 字段
client.interceptors.response.use(
  response => response.data,
  error => {
    if (import.meta.env.DEV) {
      console.warn(`[API] 请求失败: ${error.config?.url}`, error.message)
    }
    return Promise.reject(error)
  }
)

/**
 * 通用安全请求：失败时返回降级默认值
 * @param {Function} requestFn - 请求函数
 * @param {*} fallback - 降级默认值
 * @returns {Promise<*>}
 */
export async function safeRequest(requestFn, fallback) {
  try {
    const result = await requestFn()
    if (result?.ok && result.data !== undefined) {
      return result.data
    }
    return fallback
  } catch (_err) {
    console.warn('[API] 使用本地降级数据')
    return fallback
  }
}

export default client
