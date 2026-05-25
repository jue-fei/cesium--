import * as Cesium from 'cesium'

function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

/**
 * 从点对象中解析中心坐标，支持 UVW、ENU、WGS84 多种格式。
 */
export function parsePointCenter(
  point,
  { clampUVW = false, allowCenterWGS84Alias = false, validateWgs84All = true } = {}
) {
  const uvw = Array.isArray(point?.['中心_UVW'])
    ? point['中心_UVW'].map(Number)
    : Array.isArray(point?.['centerUVW'])
      ? point['centerUVW'].map(Number)
      : null
  if (uvw && uvw.length >= 3 && uvw.every(Number.isFinite)) {
    return {
      ok: true,
      data: {
        coordMode: 'UVW',
        center: clampUVW ? [clamp01(uvw[0]), clamp01(uvw[1]), clamp01(uvw[2])] : uvw.slice(0, 3)
      }
    }
  }

  const enu = Array.isArray(point?.['中心_ENU_m'])
    ? point['中心_ENU_m'].map(Number)
    : Array.isArray(point?.['centerENU'])
      ? point['centerENU'].map(Number)
      : null
  if (enu && enu.length >= 3 && enu.every(Number.isFinite)) {
    return { ok: true, data: { coordMode: 'ENU', center: enu.slice(0, 3) } }
  }

  const wgs84Source = Array.isArray(point?.['中心_WGS84'])
    ? point['中心_WGS84']
    : Array.isArray(point?.['centerWGS84'])
      ? point['centerWGS84']
      : allowCenterWGS84Alias && Array.isArray(point?.['center'])
        ? point['center']
        : null
  const wgs84 = Array.isArray(wgs84Source) ? wgs84Source.map(Number) : null
  const validWgs84 = validateWgs84All
    ? wgs84 && wgs84.length >= 2 && wgs84.every(Number.isFinite)
    : wgs84 && wgs84.length >= 2 && wgs84.slice(0, 3).every(Number.isFinite)
  if (validWgs84) {
    return { ok: true, data: { coordMode: 'WGS84', center: [wgs84[0], wgs84[1], wgs84[2] || 0] } }
  }

  return { ok: false, data: null }
}

/**
 * 根据点的坐标模式和尺寸计算局部偏移量 (dx, dy, dz)。
 */
export function resolvePointOffset(point, size) {
  const sx = Number(size?.[0]) || 200
  const sy = Number(size?.[1]) || 200
  const sz = Number(size?.[2]) || 100
  if (point?.coordMode === 'ENU') {
    return {
      dx: Number(point.center?.[0] || 0),
      dy: Number(point.center?.[1] || 0),
      dz: Number(point.center?.[2] || 0)
    }
  }
  const u = Number(point.center?.[0] || 0.5)
  const v = Number(point.center?.[1] || 0.5)
  const w = Number(point.center?.[2] || 0.5)
  return {
    dx: (clamp01(u) - 0.5) * sx,
    dy: (clamp01(v) - 0.5) * sy,
    dz: (clamp01(w) - 0.5) * sz
  }
}

/**
 * 将笛卡尔坐标转换为经纬度（度），转换失败返回 null。
 */
export function cartesianToDegreesIfValid(cartesian) {
  try {
    if (!cartesian) return null
    const carto = Cesium.Cartographic.fromCartesian(cartesian)
    const lon = Cesium.Math.toDegrees(carto.longitude)
    const lat = Cesium.Math.toDegrees(carto.latitude)
    const h = carto.height || 0
    if (![lon, lat, h].every(Number.isFinite)) return null
    return [lon, lat, h]
  } catch (e) {
    return null
  }
}

/**
 * 解析点中心在世界坐标系下的经纬度（度）。
 */
export function resolvePointCenterDegrees(point, origin, size, tileset, resolveTilesetCenterInfo) {
  if (point?.coordMode === 'WGS84') return point.center

  const { dx, dy, dz } = resolvePointOffset(point, size)

  if (tileset) {
    const info = resolveTilesetCenterInfo?.(tileset)

    if (info?.mode === 'local+matrix' && info.localCenter && info.modelMatrix) {
      try {
        const localPoint = Cesium.Cartesian3.add(
          info.localCenter,
          new Cesium.Cartesian3(dx, dy, dz),
          new Cesium.Cartesian3()
        )
        const world = Cesium.Matrix4.multiplyByPoint(
          info.modelMatrix,
          localPoint,
          new Cesium.Cartesian3()
        )
        const degrees = cartesianToDegreesIfValid(world)
        if (degrees) return degrees
      } catch (e) {
        void e
      }
    }

    if (info?.mode === 'world' && info.worldCenter) {
      try {
        const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(info.worldCenter)
        const world = Cesium.Matrix4.multiplyByPoint(
          localToWorld,
          new Cesium.Cartesian3(dx, dy, dz),
          new Cesium.Cartesian3()
        )
        const degrees = cartesianToDegreesIfValid(world)
        if (degrees) return degrees
      } catch (e) {
        void e
      }
    }
  }

  const o = Array.isArray(origin) ? origin : [0, 0, 0]
  const originCart = Cesium.Cartesian3.fromDegrees(o[0], o[1], o[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(originCart)
  const world = Cesium.Matrix4.multiplyByPoint(
    localToWorld,
    new Cesium.Cartesian3(dx, dy, dz),
    new Cesium.Cartesian3()
  )
  return cartesianToDegreesIfValid(world)
}

/**
 * 解析点中心在世界坐标系下的笛卡尔坐标。
 */
export function resolvePointCenterCartesian(
  point,
  origin,
  size,
  tileset,
  resolveTilesetCenterInfo
) {
  if (point?.coordMode === 'WGS84') {
    const c = point?.center
    if (Array.isArray(c) && c.length >= 2 && c.slice(0, 3).every(Number.isFinite)) {
      return Cesium.Cartesian3.fromDegrees(c[0], c[1], c[2] || 0)
    }
    return null
  }

  const { dx, dy, dz } = resolvePointOffset(point, size)

  if (tileset) {
    const info = resolveTilesetCenterInfo?.(tileset)
    if (info?.localCenter) {
      if (info.mode === 'world') {
        const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(info.localCenter)
        return Cesium.Matrix4.multiplyByPoint(
          localToWorld,
          new Cesium.Cartesian3(dx, dy, dz),
          new Cesium.Cartesian3()
        )
      }

      const localPoint = Cesium.Cartesian3.add(
        info.localCenter,
        new Cesium.Cartesian3(dx, dy, dz),
        new Cesium.Cartesian3()
      )
      if (info.transformMatrix) {
        return Cesium.Matrix4.multiplyByPoint(
          info.transformMatrix,
          localPoint,
          new Cesium.Cartesian3()
        )
      }
      if (info.modelMatrix) {
        return Cesium.Matrix4.multiplyByPoint(info.modelMatrix, localPoint, new Cesium.Cartesian3())
      }
      return localPoint
    }
  }

  const o = Array.isArray(origin) ? origin : [0, 0, 0]
  const originCart = Cesium.Cartesian3.fromDegrees(o[0], o[1], o[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(originCart)
  const world = Cesium.Matrix4.multiplyByPoint(
    localToWorld,
    new Cesium.Cartesian3(dx, dy, dz),
    new Cesium.Cartesian3()
  )
  return world
}

/**
 * 在点列表中查找距离目标点最近的点配置。
 */
export function findNearestPointConfig(
  points,
  origin,
  size,
  targetWC,
  tileset,
  resolveTilesetCenterInfo
) {
  if (!targetWC || !Array.isArray(points) || points.length < 1) return null
  const o = Array.isArray(origin) ? origin : [0, 0, 0]
  const sx = Array.isArray(size) && size.length >= 3 ? size : [200, 200, 100]
  let best = null
  let bestD2 = Number.POSITIVE_INFINITY

  for (const p of points) {
    const centerDeg = resolvePointCenterDegrees(p, o, sx, tileset, resolveTilesetCenterInfo)
    if (!Array.isArray(centerDeg) || centerDeg.length < 2) continue
    const center = Cesium.Cartesian3.fromDegrees(centerDeg[0], centerDeg[1], centerDeg[2] || 0)
    const dx = center.x - targetWC.x
    const dy = center.y - targetWC.y
    const dz = center.z - targetWC.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      best = { point: p, centerDeg, centerWC: center, distance2: d2 }
    }
  }
  return best
}
