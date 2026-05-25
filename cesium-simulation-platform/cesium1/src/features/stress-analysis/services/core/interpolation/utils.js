import * as Cesium from 'cesium'
import { resolvePointOffset } from '../shared/stressActionShared.js'

// ============ Point Center Parsing (from pointCenter.js) ============

export function parsePointCenter(
  point,
  { clampUVW = false, allowCenterWGS84Alias = false, validateWgs84All = true } = {}
) {
  const uvw = Array.isArray(point?.['中心_UVW'])
    ? point['中心_UVW'].map(Number)
    : Array.isArray(point?.centerUVW)
      ? point.centerUVW.map(Number)
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
    : Array.isArray(point?.centerENU)
      ? point.centerENU.map(Number)
      : null
  if (enu && enu.length >= 3 && enu.every(Number.isFinite)) {
    return { ok: true, data: { coordMode: 'ENU', center: enu.slice(0, 3) } }
  }

  const wgs84Source = Array.isArray(point?.['中心_WGS84'])
    ? point['中心_WGS84']
    : Array.isArray(point?.centerWGS84)
      ? point.centerWGS84
      : allowCenterWGS84Alias && Array.isArray(point?.center)
        ? point.center
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

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

// ============ Coordinate Utils ============

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

export function isPickedFromTileset(picked, targetTileset) {
  if (!picked || !targetTileset) return false
  if (picked.primitive === targetTileset) return true
  if (picked.tileset === targetTileset) return true
  if (picked.content?.tileset === targetTileset) return true
  if (picked.primitive?.tileset === targetTileset) return true
  if (picked.id?.tileset === targetTileset) return true
  return false
}

export function getPositionFromClick(viewer, screenPosition, targetTileset) {
  try {
    const picked = viewer.scene.pick(screenPosition)
    if (isPickedFromTileset(picked, targetTileset)) {
      const pos = viewer.scene.pickPosition(screenPosition)
      if (pos && Cesium.Cartesian3.distance(pos, Cesium.Cartesian3.ZERO) > 0) return pos
    }
    return null
  } catch (e) {
    return null
  }
}

export function resolvePointCenterDegrees(point, origin, size, tileset, resolveTilesetCenterInfo) {
  const center = point?.center
  if (point?.coordMode === 'WGS84' && Array.isArray(center) && center.length >= 2) {
    return [Number(center[0]) || 0, Number(center[1]) || 0, Number(center[2]) || 0]
  }
  return cartesianToDegreesIfValid(
    resolvePointCenterCartesian(point, origin, size, tileset, resolveTilesetCenterInfo)
  )
}

export function resolvePointCenterCartesian(
  point,
  origin,
  size,
  tileset,
  resolveTilesetCenterInfo
) {
  const wgs84Center = resolveWgs84CenterCartesian(point)
  if (wgs84Center) return wgs84Center

  const offset = createOffsetCartesian(resolvePointOffset(point, size))
  const tilesetWorld = resolveTilesetPointCenterCartesian(
    tileset ? resolveTilesetCenterInfo?.(tileset) : null,
    offset
  )
  if (tilesetWorld) return tilesetWorld

  return resolveOriginPointCenterCartesian(origin, offset)
}

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
    const center = resolvePointCenterCartesian(p, o, sx, tileset, resolveTilesetCenterInfo)
    if (!center) continue
    const centerDeg = cartesianToDegreesIfValid(center)
    if (!Array.isArray(centerDeg) || centerDeg.length < 2) continue
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

function resolveWgs84CenterCartesian(point) {
  if (point?.coordMode !== 'WGS84') return null
  const center = point?.center
  if (
    !Array.isArray(center) ||
    center.length < 2 ||
    !center.slice(0, 3).every(value => Number.isFinite(Number(value)))
  ) {
    return null
  }
  return Cesium.Cartesian3.fromDegrees(Number(center[0]), Number(center[1]), Number(center[2]) || 0)
}

function createOffsetCartesian(offset) {
  return new Cesium.Cartesian3(
    Number(offset?.dx) || 0,
    Number(offset?.dy) || 0,
    Number(offset?.dz) || 0
  )
}

function resolveOriginPointCenterCartesian(origin, offset) {
  const o = Array.isArray(origin) ? origin : [0, 0, 0]
  const originCart = Cesium.Cartesian3.fromDegrees(o[0], o[1], o[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(originCart)
  return Cesium.Matrix4.multiplyByPoint(localToWorld, offset, new Cesium.Cartesian3())
}

function resolveTilesetPointCenterCartesian(info, offset) {
  if (!info) return null

  const worldCenter = info.worldCenter || null
  if (info.mode === 'world' && worldCenter) {
    const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(worldCenter)
    return Cesium.Matrix4.multiplyByPoint(localToWorld, offset, new Cesium.Cartesian3())
  }

  if (info.localCenter) {
    const localPoint = Cesium.Cartesian3.add(info.localCenter, offset, new Cesium.Cartesian3())
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

  if (worldCenter) {
    const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(worldCenter)
    return Cesium.Matrix4.multiplyByPoint(localToWorld, offset, new Cesium.Cartesian3())
  }

  return null
}
