import * as Cesium from 'cesium'

const MIN_PICK_HEIGHT = -100
const MAX_PICK_HEIGHT = 10000

function isUsableHeight(height) {
  return Number.isFinite(height) && height > MIN_PICK_HEIGHT && height < MAX_PICK_HEIGHT
}

function getScreenPositionFromCartesian(scene, cartesian) {
  if (!scene || !cartesian) return null

  if (typeof scene.cartesianToCanvasCoordinates === 'function') {
    return scene.cartesianToCanvasCoordinates(cartesian, new Cesium.Cartesian2())
  }

  if (Cesium.SceneTransforms?.worldToWindowCoordinates) {
    return Cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      cartesian,
      new Cesium.Cartesian2()
    )
  }

  return null
}

function pickHeightFromCanvas(scene, longitude, latitude) {
  const cartesian = Cesium.Cartesian3.fromDegrees(longitude, latitude, 100)
  const screenPosition = getScreenPositionFromCartesian(scene, cartesian)
  if (!screenPosition || !scene.pickPositionSupported) {
    return null
  }

  const pickedCartesian = scene.pickPosition(screenPosition)
  if (!pickedCartesian) {
    return null
  }

  const cartographic = Cesium.Cartographic.fromCartesian(pickedCartesian)
  return isUsableHeight(cartographic.height) ? cartographic.height : null
}

function pickHeightFromTileset(scene, longitude, latitude) {
  const cartesianTop = Cesium.Cartesian3.fromDegrees(longitude, latitude, 1000)
  const cartesianBottom = Cesium.Cartesian3.fromDegrees(longitude, latitude, -1000)
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(cartesianBottom, cartesianTop, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  )
  const features = scene.drillPickFromRay(new Cesium.Ray(cartesianTop, direction), 10)

  if (!features?.length) {
    return null
  }

  for (const feature of features) {
    if (!feature?.position) continue
    const cartographic = Cesium.Cartographic.fromCartesian(feature.position)
    if (isUsableHeight(cartographic.height)) {
      return cartographic.height
    }
  }

  return null
}

function pickHeightFromGlobe(scene, longitude, latitude) {
  if (!scene.globe) {
    return null
  }

  const cartesianTop = Cesium.Cartesian3.fromDegrees(longitude, latitude, 1000)
  const picked = scene.globe.pick(
    new Cesium.Ray(cartesianTop, new Cesium.Cartesian3(0, 0, -1)),
    scene
  )
  if (!picked) {
    return null
  }

  return Cesium.Cartographic.fromCartesian(picked).height
}

export function resolveGroundHeight({
  viewer,
  hasTileset,
  longitude,
  latitude,
  defaultHeight = 0,
  vehicleSurfaceOffset = 0,
  getHeightFromPathPoints
}) {
  if (!viewer) {
    return getHeightFromPathPoints(longitude, latitude) + vehicleSurfaceOffset
  }

  try {
    const scene = viewer.scene
    const sampledHeight =
      pickHeightFromCanvas(scene, longitude, latitude) ??
      (hasTileset ? pickHeightFromTileset(scene, longitude, latitude) : null) ??
      pickHeightFromGlobe(scene, longitude, latitude) ??
      getHeightFromPathPoints(longitude, latitude) ??
      defaultHeight

    return sampledHeight + vehicleSurfaceOffset
  } catch (_) {
    return getHeightFromPathPoints(longitude, latitude) + vehicleSurfaceOffset
  }
}
