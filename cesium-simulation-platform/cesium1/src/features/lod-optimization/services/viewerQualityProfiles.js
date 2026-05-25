const DISPLAY_QUALITY_PROFILES = {
  low: {
    resolutionScale: 0.65,
    useBrowserRecommendedResolution: true,
    fxaa: false
  },
  medium: {
    resolutionScale: 0.85,
    useBrowserRecommendedResolution: true,
    fxaa: false
  },
  high: {
    resolutionScale: 1,
    useBrowserRecommendedResolution: true,
    fxaa: false
  }
}

const TERRAIN_QUALITY_PROFILES = {
  low: {
    maximumScreenSpaceError: 32
  },
  medium: {
    maximumScreenSpaceError: 16
  },
  high: {
    maximumScreenSpaceError: 8
  }
}

export function getDisplayQualityProfile(quality) {
  return DISPLAY_QUALITY_PROFILES[quality] || DISPLAY_QUALITY_PROFILES.high
}

export function getTerrainQualityProfile(quality) {
  return TERRAIN_QUALITY_PROFILES[quality] || TERRAIN_QUALITY_PROFILES.high
}
