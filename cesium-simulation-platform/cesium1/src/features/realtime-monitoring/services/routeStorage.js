const STORAGE_KEY_DEFAULT_ROUTE = 'mining_truck_default_route'
const STORAGE_KEY_SAVED_PATHS = 'mining_truck_saved_paths'

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
      console.warn('[routeStorage] 静态默认路线文件不存在:', response.status)
      return null
    }

    const data = await response.json()
    if (!Array.isArray(data.points) || data.points.length < 2) {
      console.warn('[routeStorage] 静态默认路线数据无效')
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

    console.log(
      '[routeStorage] 静态默认路线已加载:',
      formattedData.name,
      `(${formattedData.points.length} 个点)`
    )

    return formattedData
  } catch (error) {
    console.warn('[routeStorage] 加载静态默认路线失败:', error.message)
    return null
  }
}

/**
 * 清除静态路线缓存（用于重新加载）
 */
export function clearStaticRouteCache() {
  staticDefaultRouteCache = null
  console.log('[routeStorage] 静态路线缓存已清除')
}

export function saveDefaultRoute(routeData) {
  if (!routeData || !Array.isArray(routeData.points) || routeData.points.length < 2) {
    console.warn('[routeStorage] 路线数据无效，无法保存默认路线')
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
    console.log('[routeStorage] 默认路线已保存:', payload.name, `(${payload.points.length} 个点)`)
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
          console.log(
            '[routeStorage] 默认路线已从localStorage加载:',
            data.name,
            `(${data.points.length} 个点, 保存于 ${data.savedAt})`
          )
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
      console.warn('[routeStorage] 存储的默认路线数据无效')
      return null
    }

    console.log(
      '[routeStorage] 默认路线已加载:',
      data.name,
      `(${data.points.length} 个点, 保存于 ${data.savedAt})`
    )
    return {
      name: data.name,
      points: data.points,
      savedAt: data.savedAt,
      pointCount: data.points.length
    }
  } catch (error) {
    console.error('[routeStorage] 加载默认路线失败:', error)
    return null
  }
}

export function clearDefaultRoute() {
  try {
    localStorage.removeItem(STORAGE_KEY_DEFAULT_ROUTE)
    console.log('[routeStorage] 默认路线已清除')
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

/**
 * 初始化默认路线（应用启动时调用）
 * 优先加载静态资源作为系统默认
 * @param {Object} options - 配置选项
 * @param {boolean} options.useStaticAsFallback - 当localStorage没有数据时是否使用静态资源
 * @param {boolean} options.forceStatic - 强制使用静态资源（忽略localStorage）
 * @returns {Promise<Object|null>}
 */
export async function initializeDefaultRoute(options = {}) {
  const { useStaticAsFallback = true, forceStatic = false } = options

  // 如果强制使用静态资源
  if (forceStatic) {
    const staticRoute = await loadStaticDefaultRoute()
    if (staticRoute) {
      console.log('[routeStorage] 已强制加载静态默认路线')
      return staticRoute
    }
    console.warn('[routeStorage] 强制加载静态路线失败，尝试其他来源')
  }

  // 先尝试从localStorage加载
  const localRoute = loadDefaultRouteSync()
  if (localRoute) {
    console.log('[routeStorage] 已从localStorage恢复默认路线')
    return localRoute
  }

  // 如果localStorage没有且允许使用静态资源作为后备
  if (useStaticAsFallback) {
    const staticRoute = await loadStaticDefaultRoute()
    if (staticRoute) {
      console.log('[routeStorage] 已从静态资源加载默认路线作为初始值')
      return staticRoute
    }
  }

  console.log('[routeStorage] 没有找到可用的默认路线')
  return null
}
