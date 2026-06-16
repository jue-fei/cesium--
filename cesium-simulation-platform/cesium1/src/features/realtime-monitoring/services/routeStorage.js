import {
  fetchDefaultRoute,
  fetchRoutes,
  createRoute,
  updateRoute,
  setDefaultRoute as setDefaultRouteApi,
  deleteRoute as deleteRouteApi
} from './routeApiService.js'

const STORAGE_KEY_DEFAULT_ROUTE = 'mining_truck_default_route'
const STORAGE_KEY_SAVED_PATHS = 'mining_truck_saved_paths'
const ROUTE_OFFLINE_FALLBACK_ENABLED =
  String(import.meta.env.VITE_ENABLE_ROUTE_OFFLINE_FALLBACK || '').toLowerCase() === 'true'

// 静态默认路线缓存
let staticDefaultRouteCache = null

/**
 * 从静态资源加载默认路线
 * @returns {Promise<Object|null>} 路线数据或null
 */
export async function loadStaticDefaultRoute() {
  // 如果已有缓存，直接返回
  if (staticDefaultRouteCache) {
    return staticDefaultRouteCache
  }

  try {
    const response = await fetch('/default-route.json')
    if (!response.ok) {
      return null
    }

    const data = await response.json()
    if (!Array.isArray(data.points) || data.points.length < 2) {
      return null
    }

    // 验证并格式化数据
    const formattedData = {
      name: data.name || '默认矿卡路线',
      points: data.points.map(p => ({
        longitude: Number(p.longitude),
        latitude: Number(p.latitude),
        height: Number(p.height || 0)
      })),
      savedAt: data.savedAt || new Date().toISOString(),
      version: data.version || 1,
      isStatic: true
    }

    // 缓存结果
    staticDefaultRouteCache = formattedData

    return formattedData
  } catch (error) {
    return null
  }
}

/**
 * 清除静态路线缓存（用于重新加载）
 */
export function clearStaticRouteCache() {
  staticDefaultRouteCache = null
}

// ===== 数据库操作（优先） =====

async function tryDb(fn, fallback = null) {
  try {
    return await fn()
  } catch (e) {
    console.warn('[routeStorage] 数据库路线接口不可用:', e.message)
    return fallback
  }
}

export async function loadDefaultRouteFromDb() {
  const route = await fetchDefaultRoute()
  if (route && Array.isArray(route.points) && route.points.length >= 2) {
    return {
      id: route.id,
      name: route.name || '默认矿卡路线',
      points: route.points,
      isDefault: true,
      source: 'database'
    }
  }
  return null
}

export async function saveDefaultRouteToDb(name, points) {
  const route = await fetchDefaultRoute()
  if (route?.id) {
    await updateRoute(route.id, { name, points })
  } else {
    await createRoute(name, points, true)
  }
}

export async function saveRouteToDb(name, points, isDefault = false) {
  if (isDefault) {
    return saveDefaultRouteToDb(name, points)
  }
  return createRoute(name, points, false)
}

export async function loadAllRoutesFromDb() {
  const routes = await fetchRoutes()
  return routes.map(r => ({
    id: r.id,
    name: r.name || '未命名路线',
    points: r.points || [],
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    source: 'database'
  }))
}

export async function setRouteAsDefaultInDb(routeId) {
  await setDefaultRouteApi(routeId)
}

export async function updateRouteInDb(routeId, name, points, isDefault = false) {
  const data = { name, points }
  if (isDefault) data.is_default = 1
  await updateRoute(routeId, data)
}

export async function deleteRouteFromDb(routeId) {
  await deleteRouteApi(routeId)
}

// ===== 原有 localStorage 操作（仅作为显式离线模式兜底保留） =====

export function saveDefaultRoute(routeData) {
  if (!routeData || !Array.isArray(routeData.points) || routeData.points.length < 2) {
    return false
  }

  try {
    const payload = {
      name: routeData.name || '默认矿卡路线',
      points: routeData.points.map(p => ({
        longitude: Number(p.longitude),
        latitude: Number(p.latitude),
        height: Number(p.height || 0)
      })),
      savedAt: new Date().toISOString(),
      version: 1
    }

    localStorage.setItem(STORAGE_KEY_DEFAULT_ROUTE, JSON.stringify(payload))
    return true
  } catch (error) {
    console.error('[routeStorage] 保存默认路线失败:', error)
    return false
  }
}

/**
 * 加载默认路线（优先从localStorage，其次从静态资源）
 * @param {Object} options - 配置选项
 * @param {boolean} options.preferStatic - 是否优先使用静态资源（覆盖localStorage）
 * @returns {Promise<Object|null>} 路线数据或null
 */
export async function loadDefaultRoute(options = {}) {
  const { preferStatic = false } = options

  try {
    // 如果不优先使用静态资源，先尝试从localStorage加载
    if (!preferStatic) {
      const raw = localStorage.getItem(STORAGE_KEY_DEFAULT_ROUTE)
      if (raw) {
        const data = JSON.parse(raw)
        if (Array.isArray(data.points) && data.points.length >= 2) {
          return {
            name: data.name,
            points: data.points,
            savedAt: data.savedAt,
            pointCount: data.points.length,
            source: 'localStorage'
          }
        }
      }
    }

    // 从静态资源加载
    const staticRoute = await loadStaticDefaultRoute()
    if (staticRoute) {
      return {
        ...staticRoute,
        pointCount: staticRoute.points.length,
        source: 'static'
      }
    }

    return null
  } catch (error) {
    console.error('[routeStorage] 加载默认路线失败:', error)
    return null
  }
}

/**
 * 同步加载默认路线（保持向后兼容）
 * 仅检查localStorage，不加载静态资源
 * @returns {Object|null}
 */
export function loadDefaultRouteSync() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DEFAULT_ROUTE)
    if (!raw) return null

    const data = JSON.parse(raw)
    if (!Array.isArray(data.points) || data.points.length < 2) {
      return null
    }

    return {
      name: data.name,
      points: data.points,
      savedAt: data.savedAt,
      pointCount: data.points.length,
      source: 'localStorage'
    }
  } catch (error) {
    console.error('[routeStorage] 加载默认路线失败:', error)
    return null
  }
}

export function clearDefaultRoute() {
  try {
    localStorage.removeItem(STORAGE_KEY_DEFAULT_ROUTE)
    return true
  } catch (error) {
    console.error('[routeStorage] 清除默认路线失败:', error)
    return false
  }
}

export function hasDefaultRoute() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DEFAULT_ROUTE)
    if (!raw) return false
    const data = JSON.parse(raw)
    return Array.isArray(data.points) && data.points.length >= 2
  } catch {
    return false
  }
}

/**
 * 检查是否存在静态默认路线
 * @returns {Promise<boolean>}
 */
export async function hasStaticDefaultRoute() {
  try {
    const response = await fetch('/default-route.json', { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

export function saveAllPaths(paths) {
  if (!Array.isArray(paths)) return false
  try {
    const payload = paths.map(p => ({
      name: p.name,
      points: (p.points || []).map(pt => ({
        longitude: Number(pt.longitude),
        latitude: Number(pt.latitude),
        height: Number(pt.height || 0)
      })),
      createdAt: p.createdAt || new Date().toLocaleString(),
      isDefault: p.isDefault || false
    }))
    localStorage.setItem(STORAGE_KEY_SAVED_PATHS, JSON.stringify(payload))
    return true
  } catch (error) {
    console.error('[routeStorage] 保存路径列表失败:', error)
    return false
  }
}

export function loadAllPaths() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SAVED_PATHS)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data
  } catch (error) {
    console.error('[routeStorage] 加载路径列表失败:', error)
    return []
  }
}

function isOfflineFallbackEnabled(options = {}) {
  return options.allowOfflineFallback ?? ROUTE_OFFLINE_FALLBACK_ENABLED
}

/**
 * 初始化默认路线（应用启动时调用）
 * 在线模式下仅使用数据库路线；离线兜底需显式启用
 * @param {Object} options - 配置选项
 * @param {boolean} options.allowOfflineFallback - 是否允许离线兜底（localStorage/静态文件）
 * @param {boolean} options.useStaticAsFallback - 当离线兜底启用时，是否允许使用静态资源
 * @param {boolean} options.forceStatic - 强制使用静态资源（忽略localStorage）
 * @returns {Promise<Object|null>}
 */
export async function initializeDefaultRoute(options = {}) {
  const {
    allowOfflineFallback = isOfflineFallbackEnabled(options),
    useStaticAsFallback = allowOfflineFallback,
    forceStatic = false
  } = options

  if (forceStatic) {
    const staticRoute = await loadStaticDefaultRoute()
    if (staticRoute) return staticRoute
  }

  // 1. 优先从数据库加载
  const dbRoute = await tryDb(() => loadDefaultRouteFromDb())
  if (dbRoute) return dbRoute

  if (!allowOfflineFallback) {
    return null
  }

  // 2. 降级：从 localStorage 加载
  const localRoute = loadDefaultRouteSync()
  if (localRoute) return localRoute

  // 3. 最终降级：从静态文件加载
  if (useStaticAsFallback) {
    const staticRoute = await loadStaticDefaultRoute()
    if (staticRoute) return staticRoute
  }

  return null
}
