import * as Cesium from 'cesium'
import { cartesianToDegreesIfValid } from '../points/stressPointCore.js'

export function resolveTilesetCenterInfo(tileset) {
  try {
    const localCenter =
      tileset?.boundingSphere?.center ||
      tileset?.boundingSphere3D?.center ||
      tileset?._boundingSphere?.center ||
      tileset?.model?.boundingSphere?.center ||
      tileset?.root?.boundingSphere?.center ||
      tileset?._root?.boundingSphere?.center ||
      null
    if (!localCenter) return null
    const modelMatrix = tileset?.modelMatrix || tileset?.model?.modelMatrix || tileset?._modelMatrix
    const rootTransform = tileset?.root?.transform || tileset?._root?.transform || null
    const transformMatrix =
      modelMatrix && rootTransform
        ? Cesium.Matrix4.multiply(modelMatrix, rootTransform, new Cesium.Matrix4())
        : modelMatrix || rootTransform || null
    const localLen = Cesium.Cartesian3.magnitude(localCenter)
    const isPlausibleEcef = localLen > 4.5e6 && localLen < 7.5e6
    if (transformMatrix) {
      const worldCenter = Cesium.Matrix4.multiplyByPoint(
        transformMatrix,
        localCenter,
        new Cesium.Cartesian3()
      )
      const worldLen = Cesium.Cartesian3.magnitude(worldCenter)
      const worldPlausibleEcef = worldLen > 4.5e6 && worldLen < 7.5e6
      if (worldPlausibleEcef && !isPlausibleEcef) {
        return { mode: 'local+matrix', localCenter, worldCenter, modelMatrix, transformMatrix }
      }
    }
    if (isPlausibleEcef) {
      return {
        mode: 'world',
        localCenter,
        worldCenter: localCenter,
        modelMatrix: null,
        transformMatrix
      }
    }
    if (!transformMatrix) {
      return {
        mode: 'local',
        localCenter,
        worldCenter: null,
        modelMatrix: null,
        transformMatrix: null
      }
    }
    const worldCenter = Cesium.Matrix4.multiplyByPoint(
      transformMatrix,
      localCenter,
      new Cesium.Cartesian3()
    )
    const worldLen = Cesium.Cartesian3.magnitude(worldCenter)
    const worldPlausibleEcef = worldLen > 4.5e6 && worldLen < 7.5e6
    if (worldPlausibleEcef) {
      return { mode: 'local+matrix', localCenter, worldCenter, modelMatrix, transformMatrix }
    }
    return { mode: 'local', localCenter, worldCenter: null, modelMatrix, transformMatrix }
  } catch (e) {
    return null
  }
}

export function resolveOriginFromModelCenter(tileset) {
  try {
    const info = resolveTilesetCenterInfo(tileset)
    const center = info?.worldCenter
    if (!center) return null
    return cartesianToDegreesIfValid(center)
  } catch (e) {
    return null
  }
}

export function resolveTilesetRadius(tileset) {
  try {
    const r =
      tileset?.boundingSphere?.radius ||
      tileset?.boundingSphere3D?.radius ||
      tileset?._boundingSphere?.radius ||
      tileset?.model?.boundingSphere?.radius ||
      tileset?.root?.boundingSphere?.radius ||
      tileset?._root?.boundingSphere?.radius ||
      null
    return Number.isFinite(r) && r > 0 ? Number(r) : null
  } catch (e) {
    return null
  }
}

export function resolveOriginFromViewer(viewer) {
  try {
    const v = viewer
    if (!v?.scene || !v?.camera) return null
    const canvas = v.scene.canvas
    const cx = Math.floor((canvas?.clientWidth || 0) * 0.5)
    const cy = Math.floor((canvas?.clientHeight || 0) * 0.5)
    let pos = null
    if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) {
      pos = v.camera.pickEllipsoid(new Cesium.Cartesian2(cx, cy), v.scene.globe.ellipsoid)
    }
    if (!pos) {
      const cartoCam = v.camera.positionCartographic
      if (!cartoCam) return null
      const lon = Cesium.Math.toDegrees(cartoCam.longitude)
      const lat = Cesium.Math.toDegrees(cartoCam.latitude)
      const h = cartoCam.height || 0
      if (![lon, lat, h].every(Number.isFinite)) return null
      return [lon, lat, h]
    }
    return cartesianToDegreesIfValid(pos)
  } catch (e) {
    return null
  }
}

export function computeRadiusScaleFactor(tileset, size) {
  const baseSize =
    Array.isArray(size) && size.length >= 3 ? Math.min(size[0], size[1], size[2]) : null
  if (!(Number.isFinite(baseSize) && baseSize > 0)) return 1
  try {
    const r = resolveTilesetRadius(tileset)
    if (!(Number.isFinite(r) && r > 0)) return 1
    const diameter = r * 2
    const raw = diameter / baseSize
    return Math.max(0.5, Math.min(10, raw))
  } catch (e) {
    return 1
  }
}

export function toCartesian3IfValid(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.z)
  ) {
    return null
  }
  return new Cesium.Cartesian3(value.x, value.y, value.z)
}

export function toSimpleCartesian(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.z)
  ) {
    return null
  }
  return { x: Number(value.x), y: Number(value.y), z: Number(value.z) }
}

export function resolveRuntimeRenderHints(tileset, cfg) {
  try {
    const first = Array.isArray(cfg?.sources) && cfg.sources.length > 0 ? cfg.sources[0] : null
    const radiusVal = Number(first?.radius)
    const radiusText =
      Number.isFinite(radiusVal) && radiusVal > 0 ? `${radiusVal.toFixed(2)}m` : '不可用'
    if (!first?.centerCartesian || !tileset?.boundingSphere?.center) {
      return { distanceText: '不可用', radiusText }
    }
    const point = toCartesian3IfValid(first.centerCartesian)
    if (!point) return { distanceText: '不可用', radiusText }
    const center = tileset.boundingSphere.center
    const d = Cesium.Cartesian3.distance(point, center)
    const distanceText = Number.isFinite(d) ? `${d.toFixed(2)}m` : '不可用'
    return { distanceText, radiusText }
  } catch (e) {
    return { distanceText: '不可用', radiusText: '不可用' }
  }
}

export function emitConsoleRenderProbe({
  fileName,
  tileset,
  cfg,
  hints,
  sourceCountRaw,
  sourceCountRendered
}) {
  try {
    const first = Array.isArray(cfg?.sources) && cfg.sources.length > 0 ? cfg.sources[0] : null
    const modelCenter = tileset?.boundingSphere?.center || null
    const modelRadius = tileset?.boundingSphere?.radius || null
    const centerCartesian = first?.centerCartesian || null
    const timeSeries = Array.isArray(first?.timeSeries) ? first.timeSeries : []
    const radiusSeries = Array.isArray(first?.radiusSeries) ? first.radiusSeries : []
    const lines = [
      `file=${fileName || '(unknown)'}`,
      `sources(raw/rendered)=${sourceCountRaw}/${sourceCountRendered}`,
      `distance(first->modelCenter)=${hints?.distanceText || '不可用'}`,
      `firstRadius=${hints?.radiusText || '不可用'}`,
      `tilesetReady=${tileset ? 'yes' : 'no'}`
    ]
    console.group('[StressRenderProbe]')
    for (const line of lines) {
      console.log(line)
    }
    console.log('firstSource', {
      id: first?.id || '',
      name: first?.name || '',
      center: Array.isArray(first?.center) ? first.center : null,
      centerCartesian: toSimpleCartesian(centerCartesian),
      radius: Number(first?.radius),
      timeSeriesLength: timeSeries.length,
      radiusSeriesLength: radiusSeries.length
    })
    console.log('model', {
      center: toSimpleCartesian(modelCenter),
      radius: Number.isFinite(Number(modelRadius)) ? Number(modelRadius) : null
    })
    console.groupEnd()
  } catch (e) {
    console.error('[StressRenderProbe] failed', e)
  }
}
