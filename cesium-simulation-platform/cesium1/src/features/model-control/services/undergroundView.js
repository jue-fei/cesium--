import * as Cesium from 'cesium'

function saveViewerState(viewer, globe, controller, savedState) {
  if (!savedState.globeTranslucency) {
    savedState.globeTranslucency = {
      enabled: globe.translucency.enabled,
      frontFaceAlpha: globe.translucency.frontFaceAlpha,
      backFaceAlpha: globe.translucency.backFaceAlpha,
      rectangle: Cesium.Rectangle.clone(globe.translucency.rectangle, new Cesium.Rectangle())
    }
  }
  if (savedState.collisionDetection === null) {
    savedState.collisionDetection = controller.enableCollisionDetection
  }
  if (savedState.depthTestAgainstTerrain === null) {
    savedState.depthTestAgainstTerrain = globe.depthTestAgainstTerrain
  }
  if (!savedState.backgroundColor) {
    savedState.backgroundColor = Cesium.Color.clone(
      viewer.scene.backgroundColor,
      new Cesium.Color()
    )
  }
}

function buildTranslucencyRectangle(tileset) {
  const center = tileset?.boundingSphere?.center
  const radius = tileset?.boundingSphere?.radius
  if (!center || typeof radius !== 'number' || !Number.isFinite(radius)) {
    return undefined
  }

  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(center)
  if (!cartographic) {
    return undefined
  }

  const delta = Cesium.Math.clamp((radius * 2.5) / Cesium.Ellipsoid.WGS84.maximumRadius, 0, 0.6)
  const west = cartographic.longitude - delta
  const east = cartographic.longitude + delta
  const south = Cesium.Math.clamp(
    cartographic.latitude - delta,
    -Cesium.Math.PI_OVER_TWO,
    Cesium.Math.PI_OVER_TWO
  )
  const north = Cesium.Math.clamp(
    cartographic.latitude + delta,
    -Cesium.Math.PI_OVER_TWO,
    Cesium.Math.PI_OVER_TWO
  )

  return Cesium.Rectangle.fromRadians(west, south, east, north)
}

function applyEnabledUndergroundView({
  viewer,
  globe,
  controller,
  tileset,
  frontFaceAlphaPercent,
  backFaceAlphaPercent,
  savedState
}) {
  saveViewerState(viewer, globe, controller, savedState)

  globe.translucency.enabled = true
  globe.translucency.frontFaceAlpha = Cesium.Math.clamp(Number(frontFaceAlphaPercent) / 100, 0, 1)
  globe.translucency.backFaceAlpha = Cesium.Math.clamp(Number(backFaceAlphaPercent) / 100, 0, 1)
  globe.translucency.rectangle = buildTranslucencyRectangle(tileset)
  globe.depthTestAgainstTerrain = false
  controller.enableCollisionDetection = false
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#17253A')
}

function restoreDisabledUndergroundView({ viewer, globe, controller, savedState }) {
  if (savedState.globeTranslucency) {
    globe.translucency.enabled = savedState.globeTranslucency.enabled
    globe.translucency.frontFaceAlpha = savedState.globeTranslucency.frontFaceAlpha
    globe.translucency.backFaceAlpha = savedState.globeTranslucency.backFaceAlpha
    globe.translucency.rectangle = savedState.globeTranslucency.rectangle
    savedState.globeTranslucency = null
  } else {
    globe.translucency.enabled = false
    globe.translucency.rectangle = undefined
  }

  if (savedState.collisionDetection !== null) {
    controller.enableCollisionDetection = savedState.collisionDetection
    savedState.collisionDetection = null
  }
  if (savedState.depthTestAgainstTerrain !== null) {
    globe.depthTestAgainstTerrain = savedState.depthTestAgainstTerrain
    savedState.depthTestAgainstTerrain = null
  }
  if (savedState.backgroundColor) {
    viewer.scene.backgroundColor = savedState.backgroundColor
    savedState.backgroundColor = null
  }
}

export function createUndergroundViewController(getViewer) {
  const savedState = {
    globeTranslucency: null,
    collisionDetection: null,
    depthTestAgainstTerrain: null,
    backgroundColor: null
  }

  const apply = ({ tileset, enabled, frontFaceAlphaPercent, backFaceAlphaPercent }) => {
    const viewer = typeof getViewer === 'function' ? getViewer() : null
    if (!viewer || !viewer.scene) return false
    const globe = viewer.scene.globe
    const controller = viewer.scene.screenSpaceCameraController
    if (!globe || !globe.translucency || !controller) return false

    if (enabled) {
      applyEnabledUndergroundView({
        viewer,
        globe,
        controller,
        tileset,
        frontFaceAlphaPercent,
        backFaceAlphaPercent,
        savedState
      })
    } else {
      restoreDisabledUndergroundView({ viewer, globe, controller, savedState })
    }

    viewer.scene.requestRender()
    return true
  }

  return { apply }
}

export function flyToUndergroundView(viewer, tileset, durationSec = 0.8) {
  if (!viewer || !tileset) return false
  const center = tileset.boundingSphere?.center
  const radius = tileset.boundingSphere?.radius || 200
  if (!center) return false

  const normal = Cesium.Cartesian3.normalize(center, new Cesium.Cartesian3())
  const move = Math.max(200, radius * 1.5)
  const destination = Cesium.Cartesian3.subtract(
    center,
    Cesium.Cartesian3.multiplyByScalar(normal, move, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  )

  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(center, destination, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  )
  const up = Cesium.Cartesian3.normalize(destination, new Cesium.Cartesian3())

  viewer.camera.flyTo({
    destination,
    orientation: { direction, up },
    duration: Number(durationSec) || 0.8
  })
  return true
}
