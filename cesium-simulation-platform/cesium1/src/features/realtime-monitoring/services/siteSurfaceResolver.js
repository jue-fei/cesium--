import * as Cesium from 'cesium'
import {
  buildSurfaceSearchCandidates,
  resolveInitialPlacementRadius,
  resolveScaledSiteRadius
} from './siteSurfaceCore.js'

function getFeatureIdFromTarget(target) {
  if (!target) return null

  try {
    if (typeof target.getProperty === 'function') {
      return (
        target.getProperty('id') ||
        target.getProperty('ID') ||
        target.getProperty('name') ||
        target.getProperty('Name') ||
        // @ts-ignore
        target._id ||
        null
      )
    }
  } catch (error) {
    // Ignore feature metadata read failures and fall back to loose ids.
  }

  // @ts-ignore
  return target._id || target.id || null
}

function snapCartesianToFeatureSurface({
  viewer,
  featureId,
  approximateCartesian,
  vehicleSurfaceOffset
}) {
  if (!featureId || !approximateCartesian || !viewer?.scene) {
    return null
  }

  try {
    const scene = viewer.scene
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      approximateCartesian,
      new Cesium.Cartesian3()
    )
    const rayStart = Cesium.Cartesian3.add(
      approximateCartesian,
      Cesium.Cartesian3.multiplyByScalar(up, 1500, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    )
    const rayDirection = Cesium.Cartesian3.negate(up, new Cesium.Cartesian3())
    const hits = scene.drillPickFromRay(new Cesium.Ray(rayStart, rayDirection), 32) || []

    for (const hit of hits) {
      const hitTarget = hit?.object || hit?.primitive || hit
      const hitFeatureId = getFeatureIdFromTarget(hitTarget)
      if (hitFeatureId !== featureId || !hit?.position) continue

      return Cesium.Cartesian3.add(
        hit.position,
        Cesium.Cartesian3.multiplyByScalar(up, vehicleSurfaceOffset, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      )
    }
  } catch (error) {
    // Ignore drill-pick failures and fall back to the approximate position.
  }

  return null
}

function buildApproximateCartesian({
  site,
  eastOffset,
  northOffset,
  upOffset,
  transformOriginalPointToCurrent
}) {
  if (site.originalFrameMatrix) {
    const originalPoint = Cesium.Matrix4.multiplyByPoint(
      site.originalFrameMatrix,
      new Cesium.Cartesian3(eastOffset, northOffset, upOffset),
      new Cesium.Cartesian3()
    )
    return transformOriginalPointToCurrent(originalPoint)
  }

  return Cesium.Cartesian3.fromDegrees(site.longitude, site.latitude, (site.height || 0) + upOffset)
}

function buildMiningSiteFromSpecInternal({
  spec,
  fallbackPosition,
  transformOriginalPointToCurrent,
  cartesianToWorldPosition,
  getModelScaleFactor,
  buildFeatureSurfacePointPool,
  constants,
  viewer
}) {
  const originalCartesian = spec?.cartesian
    ? Cesium.Cartesian3.fromArray(spec.cartesian)
    : Cesium.Cartesian3.fromDegrees(fallbackPosition.x, fallbackPosition.y, fallbackPosition.z || 0)
  const transformedCenter = transformOriginalPointToCurrent(originalCartesian)
  const snappedCenter =
    snapCartesianToFeatureSurface({
      viewer,
      featureId: spec?.id || null,
      approximateCartesian: transformedCenter,
      vehicleSurfaceOffset: constants.vehicleSurfaceOffset
    }) || transformedCenter

  const cartographic = Cesium.Cartographic.fromCartesian(snappedCenter)
  const longitude = Cesium.Math.toDegrees(cartographic.longitude)
  const latitude = Cesium.Math.toDegrees(cartographic.latitude)
  const fallbackHeight = Number(cartographic.height || fallbackPosition.z || 0)
  const radiusScale = getModelScaleFactor()
  const resolvedRadius = resolveScaledSiteRadius(
    Number(spec?.radius || constants.siteRadius) || constants.siteRadius,
    radiusScale,
    constants.siteRadiusRatio,
    constants.minSiteRadius,
    constants.maxSiteRadius
  )

  const site = {
    longitude,
    latitude,
    height: fallbackHeight,
    radius: resolvedRadius,
    initialPlacementRadius: resolveInitialPlacementRadius(
      resolvedRadius,
      constants.initialSiteRadiusRatio,
      constants.minInitialRadius,
      constants.maxInitialRadius
    ),
    featureId: spec?.id || null,
    featureName: spec?.name || null,
    originalCartesian,
    originalFrameMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(originalCartesian),
    currentCartesian: snappedCenter
  }

  const surfacePool = buildFeatureSurfacePointPool(site)
  if (surfacePool.length) {
    const highestPoint = surfacePool[0]
    const highestCurrentCartesian = transformOriginalPointToCurrent(highestPoint.originalCartesian)
    const highestPosition = cartesianToWorldPosition(highestCurrentCartesian, fallbackHeight)
    site.longitude = highestPosition.longitude
    site.latitude = highestPosition.latitude
    site.height = highestPosition.height
    site.currentCartesian = highestCurrentCartesian
  }

  return site
}

function getSiteSurfaceCartesianInternal({
  site,
  getNearestSurfacePointFromPool,
  transformOriginalPointToCurrent,
  viewer,
  constants
}) {
  if (!site) return null
  const pooledPoint = getNearestSurfacePointFromPool(site, 0, 0)
  if (pooledPoint?.currentCartesian) {
    return pooledPoint.currentCartesian
  }
  if (site.originalCartesian) {
    const transformedCenter = transformOriginalPointToCurrent(site.originalCartesian)
    return (
      snapCartesianToFeatureSurface({
        viewer,
        featureId: site.featureId,
        approximateCartesian: transformedCenter,
        vehicleSurfaceOffset: constants.vehicleSurfaceOffset
      }) || transformedCenter
    )
  }

  return Cesium.Cartesian3.fromDegrees(site.longitude, site.latitude, site.height || 0)
}

function resolveSiteOffsetCartesianInternal({
  site,
  eastMeters = 0,
  northMeters = 0,
  upMeters = 0,
  options = {},
  viewer,
  transformOriginalPointToCurrent,
  getNearestSurfacePointFromPool,
  constants
}) {
  const { snapToFeature = true, searchNearestSurface = true, useSurfacePool = true } = options
  if (!site) return null

  if (snapToFeature && useSurfacePool) {
    const pooledPoint = getNearestSurfacePointFromPool(site, eastMeters, northMeters)
    if (pooledPoint?.currentCartesian) {
      return pooledPoint.currentCartesian
    }
  }

  let approximateCartesian = buildApproximateCartesian({
    site,
    eastOffset: eastMeters,
    northOffset: northMeters,
    upOffset: upMeters,
    transformOriginalPointToCurrent
  })
  if (!approximateCartesian) return null
  if (!snapToFeature) return approximateCartesian

  const directHit = snapCartesianToFeatureSurface({
    viewer,
    featureId: site.featureId,
    approximateCartesian,
    vehicleSurfaceOffset: constants.vehicleSurfaceOffset
  })
  if (directHit || !searchNearestSurface) {
    return directHit || approximateCartesian
  }

  for (let ring = 1; ring <= constants.featureSurfaceSearchRings; ring++) {
    const step = ring * constants.featureSurfaceSearchStep
    const candidates = buildSurfaceSearchCandidates(eastMeters, northMeters, step)

    for (const [candidateEast, candidateNorth] of candidates) {
      approximateCartesian = buildApproximateCartesian({
        site,
        eastOffset: candidateEast,
        northOffset: candidateNorth,
        upOffset: upMeters,
        transformOriginalPointToCurrent
      })
      const hit = snapCartesianToFeatureSurface({
        viewer,
        featureId: site.featureId,
        approximateCartesian,
        vehicleSurfaceOffset: constants.vehicleSurfaceOffset
      })
      if (hit) return hit
    }
  }

  return approximateCartesian
}

function resolveSiteOffsetWorldPositionInternal({
  site,
  eastMeters = 0,
  northMeters = 0,
  upMeters = 0,
  options = {},
  cartesianToWorldPosition,
  resolveSiteOffsetCartesian
}) {
  const cartesian = resolveSiteOffsetCartesian(site, eastMeters, northMeters, upMeters, options)
  if (!cartesian) {
    return {
      longitude: site.longitude,
      latitude: site.latitude,
      height: site.height
    }
  }

  return cartesianToWorldPosition(cartesian, site.height || 0)
}

export function createSiteSurfaceResolver({
  getViewer,
  transformOriginalPointToCurrent,
  cartesianToWorldPosition,
  getModelScaleFactor,
  buildFeatureSurfacePointPool,
  getNearestSurfacePointFromPool,
  constants
}) {
  const {
    vehicleSurfaceOffset,
    siteRadius,
    siteRadiusRatio,
    initialSiteRadiusRatio,
    minSiteRadius,
    maxSiteRadius,
    minInitialRadius,
    maxInitialRadius,
    featureSurfaceSearchStep,
    featureSurfaceSearchRings
  } = constants
  const resolverConstants = {
    vehicleSurfaceOffset,
    siteRadius,
    siteRadiusRatio,
    initialSiteRadiusRatio,
    minSiteRadius,
    maxSiteRadius,
    minInitialRadius,
    maxInitialRadius,
    featureSurfaceSearchStep,
    featureSurfaceSearchRings
  }

  return {
    getFeatureId: getFeatureIdFromTarget,
    snapCartesianToFeatureSurface: (featureId, approximateCartesian) =>
      snapCartesianToFeatureSurface({
        viewer: getViewer?.(),
        featureId,
        approximateCartesian,
        vehicleSurfaceOffset
      }),
    buildMiningSiteFromSpec: (spec, fallbackPosition) =>
      buildMiningSiteFromSpecInternal({
        spec,
        fallbackPosition,
        transformOriginalPointToCurrent,
        cartesianToWorldPosition,
        getModelScaleFactor,
        buildFeatureSurfacePointPool,
        constants: resolverConstants,
        viewer: getViewer?.()
      }),
    getSiteSurfaceCartesian: site =>
      getSiteSurfaceCartesianInternal({
        site,
        getNearestSurfacePointFromPool,
        transformOriginalPointToCurrent,
        viewer: getViewer?.(),
        constants: resolverConstants
      }),
    resolveSiteOffsetCartesian: (
      site,
      eastMeters = 0,
      northMeters = 0,
      upMeters = 0,
      options = {}
    ) =>
      resolveSiteOffsetCartesianInternal({
        site,
        eastMeters,
        northMeters,
        upMeters,
        options,
        viewer: getViewer?.(),
        transformOriginalPointToCurrent,
        getNearestSurfacePointFromPool,
        constants: resolverConstants
      }),
    resolveSiteOffsetWorldPosition: (
      site,
      eastMeters = 0,
      northMeters = 0,
      upMeters = 0,
      options = {}
    ) =>
      resolveSiteOffsetWorldPositionInternal({
        site,
        eastMeters,
        northMeters,
        upMeters,
        options,
        cartesianToWorldPosition,
        resolveSiteOffsetCartesian: (
          targetSite,
          targetEast = 0,
          targetNorth = 0,
          targetUp = 0,
          targetOptions = {}
        ) =>
          resolveSiteOffsetCartesianInternal({
            site: targetSite,
            eastMeters: targetEast,
            northMeters: targetNorth,
            upMeters: targetUp,
            options: targetOptions,
            viewer: getViewer?.(),
            transformOriginalPointToCurrent,
            getNearestSurfacePointFromPool,
            constants: resolverConstants
          })
      })
  }
}
