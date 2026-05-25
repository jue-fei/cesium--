import * as Cesium from 'cesium'

export function createUndergroundViewController(getViewer) {
  let savedGlobeTranslucency = null
  let savedCollisionDetection = null
  let savedDepthTestAgainstTerrain = null
  let savedBackgroundColor = null

  const apply = ({ tileset, enabled, frontFaceAlphaPercent, backFaceAlphaPercent }) => {
    const viewer = typeof getViewer === 'function' ? getViewer() : null
    if (!viewer || !viewer.scene) return false
    const globe = viewer.scene.globe
    const controller = viewer.scene.screenSpaceCameraController
    if (!globe || !globe.translucency || !controller) return false

    if (enabled) {
      if (!savedGlobeTranslucency) {
        savedGlobeTranslucency = {
          enabled: globe.translucency.enabled,
          frontFaceAlpha: globe.translucency.frontFaceAlpha,
          backFaceAlpha: globe.translucency.backFaceAlpha,
          rectangle: Cesium.Rectangle.clone(globe.translucency.rectangle, new Cesium.Rectangle())
        }
      }
      if (savedCollisionDetection === null) {
        savedCollisionDetection = controller.enableCollisionDetection
      }
      if (savedDepthTestAgainstTerrain === null) {
        savedDepthTestAgainstTerrain = globe.depthTestAgainstTerrain
      }
      if (!savedBackgroundColor) {
        savedBackgroundColor = Cesium.Color.clone(viewer.scene.backgroundColor, new Cesium.Color())
      }

      globe.translucency.enabled = true
      globe.translucency.frontFaceAlpha = Cesium.Math.clamp(
        Number(frontFaceAlphaPercent) / 100,
        0,
        1
      )
      globe.translucency.backFaceAlpha = Cesium.Math.clamp(Number(backFaceAlphaPercent) / 100, 0, 1)
      globe.depthTestAgainstTerrain = false
      controller.enableCollisionDetection = false
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#17253A')

      const center = tileset?.boundingSphere?.center
      const radius = tileset?.boundingSphere?.radius
      if (center && typeof radius === 'number' && Number.isFinite(radius)) {
        const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(center)
        if (carto) {
          const delta = Cesium.Math.clamp(
            (radius * 2.5) / Cesium.Ellipsoid.WGS84.maximumRadius,
            0,
            0.6
          )
          const west = carto.longitude - delta
          const east = carto.longitude + delta
          const south = Cesium.Math.clamp(
            carto.latitude - delta,
            -Cesium.Math.PI_OVER_TWO,
            Cesium.Math.PI_OVER_TWO
          )
          const north = Cesium.Math.clamp(
            carto.latitude + delta,
            -Cesium.Math.PI_OVER_TWO,
            Cesium.Math.PI_OVER_TWO
          )
          globe.translucency.rectangle = Cesium.Rectangle.fromRadians(west, south, east, north)
        } else {
          globe.translucency.rectangle = undefined
        }
      } else {
        globe.translucency.rectangle = undefined
      }
    } else {
      if (savedGlobeTranslucency) {
        globe.translucency.enabled = savedGlobeTranslucency.enabled
        globe.translucency.frontFaceAlpha = savedGlobeTranslucency.frontFaceAlpha
        globe.translucency.backFaceAlpha = savedGlobeTranslucency.backFaceAlpha
        globe.translucency.rectangle = savedGlobeTranslucency.rectangle
        savedGlobeTranslucency = null
      } else {
        globe.translucency.enabled = false
        globe.translucency.rectangle = undefined
      }
      if (savedCollisionDetection !== null) {
        controller.enableCollisionDetection = savedCollisionDetection
        savedCollisionDetection = null
      }
      if (savedDepthTestAgainstTerrain !== null) {
        globe.depthTestAgainstTerrain = savedDepthTestAgainstTerrain
        savedDepthTestAgainstTerrain = null
      }
      if (savedBackgroundColor) {
        viewer.scene.backgroundColor = savedBackgroundColor
        savedBackgroundColor = null
      }
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
