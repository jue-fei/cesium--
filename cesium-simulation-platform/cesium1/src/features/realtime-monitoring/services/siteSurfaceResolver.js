import * as Cesium from 'cesium'
import {
  buildSurfaceSearchCandidates,
  resolveInitialPlacementRadius,
  resolveScaledSiteRadius
} from './siteSurfaceCore.js'

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

  function getFeatureId(target) {
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
      console.warn('[RealtimeDataEngine] 读取要素ID失败:', error)
    }

    // @ts-ignore
    return target._id || target.id || null
  }

  function snapCartesianToFeatureSurface(featureId, approximateCartesian) {
    const viewer = getViewer?.()
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
        const hitFeatureId = getFeatureId(hitTarget)
        if (hitFeatureId !== featureId || !hit?.position) continue

        return Cesium.Cartesian3.add(
          hit.position,
          Cesium.Cartesian3.multiplyByScalar(up, vehicleSurfaceOffset, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        )
      }
    } catch (error) {
      console.warn('[RealtimeDataEngine] 命中指定子模型表面失败:', error)
    }

    return null
  }

  function buildMiningSiteFromSpec(spec, fallbackPosition) {
    const originalCartesian = spec?.cartesian
      ? Cesium.Cartesian3.fromArray(spec.cartesian)
      : Cesium.Cartesian3.fromDegrees(
          fallbackPosition.x,
          fallbackPosition.y,
          fallbackPosition.z || 0
        )
    const transformedCenter = transformOriginalPointToCurrent(originalCartesian)
    const snappedCenter =
      snapCartesianToFeatureSurface(spec?.id || null, transformedCenter) || transformedCenter

    const cartographic = Cesium.Cartographic.fromCartesian(snappedCenter)
    const longitude = Cesium.Math.toDegrees(cartographic.longitude)
    const latitude = Cesium.Math.toDegrees(cartographic.latitude)
    const fallbackHeight = Number(cartographic.height || fallbackPosition.z || 0)
    const radiusScale = getModelScaleFactor()
    const resolvedRadius = resolveScaledSiteRadius(
      Number(spec?.radius || siteRadius) || siteRadius,
      radiusScale,
      siteRadiusRatio,
      minSiteRadius,
      maxSiteRadius
    )

    const site = {
      longitude,
      latitude,
      height: fallbackHeight,
      radius: resolvedRadius,
      initialPlacementRadius: resolveInitialPlacementRadius(
        resolvedRadius,
        initialSiteRadiusRatio,
        minInitialRadius,
        maxInitialRadius
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
      const highestCurrentCartesian = transformOriginalPointToCurrent(
        highestPoint.originalCartesian
      )
      const highestPosition = cartesianToWorldPosition(highestCurrentCartesian, fallbackHeight)
      site.longitude = highestPosition.longitude
      site.latitude = highestPosition.latitude
      site.height = highestPosition.height
      site.currentCartesian = highestCurrentCartesian
    }

    return site
  }

  function getSiteSurfaceCartesian(site) {
    if (!site) return null
    const pooledPoint = getNearestSurfacePointFromPool(site, 0, 0)
    if (pooledPoint?.currentCartesian) {
      return pooledPoint.currentCartesian
    }
    if (site.originalCartesian) {
      const transformedCenter = transformOriginalPointToCurrent(site.originalCartesian)
      return snapCartesianToFeatureSurface(site.featureId, transformedCenter) || transformedCenter
    }

    return Cesium.Cartesian3.fromDegrees(site.longitude, site.latitude, site.height || 0)
  }

  function buildApproximateCartesian(site, eastOffset, northOffset, upOffset) {
    if (site.originalFrameMatrix) {
      const originalPoint = Cesium.Matrix4.multiplyByPoint(
        site.originalFrameMatrix,
        new Cesium.Cartesian3(eastOffset, northOffset, upOffset),
        new Cesium.Cartesian3()
      )
      return transformOriginalPointToCurrent(originalPoint)
    }

    return Cesium.Cartesian3.fromDegrees(
      site.longitude,
      site.latitude,
      (site.height || 0) + upOffset
    )
  }

  function resolveSiteOffsetCartesian(
    site,
    eastMeters = 0,
    northMeters = 0,
    upMeters = 0,
    options = {}
  ) {
    const { snapToFeature = true, searchNearestSurface = true, useSurfacePool = true } = options
    if (!site) return null

    if (snapToFeature && useSurfacePool) {
      const pooledPoint = getNearestSurfacePointFromPool(site, eastMeters, northMeters)
      if (pooledPoint?.currentCartesian) {
        return pooledPoint.currentCartesian
      }
    }

    let approximateCartesian = buildApproximateCartesian(site, eastMeters, northMeters, upMeters)
    if (!approximateCartesian) return null
    if (!snapToFeature) return approximateCartesian

    const directHit = snapCartesianToFeatureSurface(site.featureId, approximateCartesian)
    if (directHit || !searchNearestSurface) {
      return directHit || approximateCartesian
    }

    for (let ring = 1; ring <= featureSurfaceSearchRings; ring++) {
      const step = ring * featureSurfaceSearchStep
      const candidates = buildSurfaceSearchCandidates(eastMeters, northMeters, step)

      for (const [candidateEast, candidateNorth] of candidates) {
        approximateCartesian = buildApproximateCartesian(
          site,
          candidateEast,
          candidateNorth,
          upMeters
        )
        const hit = snapCartesianToFeatureSurface(site.featureId, approximateCartesian)
        if (hit) {
          return hit
        }
      }
    }

    return approximateCartesian
  }

  function resolveSiteOffsetWorldPosition(
    site,
    eastMeters = 0,
    northMeters = 0,
    upMeters = 0,
    options = {}
  ) {
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

  return {
    getFeatureId,
    snapCartesianToFeatureSurface,
    buildMiningSiteFromSpec,
    getSiteSurfaceCartesian,
    resolveSiteOffsetCartesian,
    resolveSiteOffsetWorldPosition
  }
}
