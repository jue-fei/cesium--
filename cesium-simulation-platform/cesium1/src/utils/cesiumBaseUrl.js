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
    // 与当前直接通过 /Cesium.js 挂载的运行方式保持兼容。
    window.CESIUM_BASE_URL = baseUrl
  }

  if (globalThis.Cesium?.buildModuleUrl?.setBaseUrl) {
    try {
      globalThis.Cesium.buildModuleUrl.setBaseUrl(baseUrl)
    } catch (error) {
      logger.warn(
        'cesium-base-url',
        '设置 Cesium 模块基址失败，已回退到全局变量桥接',
        { baseUrl },
        error
      )
    }
  }

  logger.info('cesium-base-url', 'Cesium 资源基址已初始化', { baseUrl })
  return baseUrl
}
