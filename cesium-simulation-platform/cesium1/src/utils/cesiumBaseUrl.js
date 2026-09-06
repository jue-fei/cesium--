import * as Cesium from 'cesium'
import { logger } from './logger.js'

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '/').trim() || '/'
  return value.endsWith('/') ? value : `${value}/`
}

export function resolveCesiumBaseUrl() {
  const fromEnv = import.meta.env.VITE_CESIUM_ASSETS_URL
  if (fromEnv) return normalizeBaseUrl(fromEnv)

  const fromMeta =
    document.querySelector('meta[name="cesium-base-url"]')?.getAttribute('content') || '/'
  return normalizeBaseUrl(fromMeta)
}

export function initializeCesiumBaseUrl() {
  const baseUrl = resolveCesiumBaseUrl()

  if (typeof window !== 'undefined') {
    // Cesium 的 buildModuleUrl 在首次请求资源时读取该全局变量。
    window.CESIUM_BASE_URL = baseUrl
  }

  if (Cesium?.buildModuleUrl?.setBaseUrl) {
    try {
      Cesium.buildModuleUrl.setBaseUrl(baseUrl)
    } catch (error) {
      logger.warn(
        'cesium-base-url',
        '设置 Cesium 模块基址失败，已回退到 window.CESIUM_BASE_URL',
        { baseUrl },
        error
      )
    }
  }

  logger.info('cesium-base-url', 'Cesium 资源基址已初始化', { baseUrl })
  return baseUrl
}
