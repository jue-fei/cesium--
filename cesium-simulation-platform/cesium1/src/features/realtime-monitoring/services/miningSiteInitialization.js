import * as Cesium from 'cesium'

function buildDefaultMiningSite(position) {
  return {
    longitude: position.x,
    latitude: position.y,
    height: position.z
  }
}

function buildMiningSitesFromBoundingSphere(tileset) {
  const center = tileset.boundingSphere.center
  const cartographic = Cesium.Cartographic.fromCartesian(center)
  const modelLongitude = Cesium.Math.toDegrees(cartographic.longitude)
  const modelLatitude = Cesium.Math.toDegrees(cartographic.latitude)
  const modelHeight = cartographic.height

  return {
    site1: {
      longitude: modelLongitude - 0.0005,
      latitude: modelLatitude,
      height: modelHeight + 5
    },
    site2: {
      longitude: modelLongitude + 0.0005,
      latitude: modelLatitude,
      height: modelHeight + 5
    }
  }
}

export function resolveMiningSites({
  tileset,
  buildMiningSiteFromSpec,
  defaultSite1Position,
  defaultSite2Position,
  currentSite1,
  currentSite2
}) {
  const originalSites = tileset?.spec?.sites
  const sitesList = Array.isArray(originalSites) && originalSites.length >= 2 ? originalSites : null

  if (sitesList && tileset) {
    return {
      site1: buildMiningSiteFromSpec(sitesList[0], defaultSite1Position),
      site2: buildMiningSiteFromSpec(sitesList[1], defaultSite2Position)
    }
  }

  if (tileset?.boundingSphere) {
    try {
      return buildMiningSitesFromBoundingSphere(tileset)
    } catch (_) {
      // Ignore and fall back to defaults.
    }
  }

  return {
    site1: currentSite1 || buildDefaultMiningSite(defaultSite1Position),
    site2: currentSite2 || buildDefaultMiningSite(defaultSite2Position)
  }
}
