import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 appConfig.js + modelConfig.js）----
const FALLBACK_CONFIG = {
  ore_grade_thresholds: { HIGH: 3.0, MEDIUM: 2.0 },
  model_defaults: { OPACITY: 100, VISIBLE: true },
  highlight_config: { COLOR: '#ffff00', DURATION: 1000 },
  borehole_config: {
    COLOR: '#ff0000', ALPHA: 0.8, DEPTH_FAIL_ALPHA: 0.3, WIDTH: 3, MARKER_SIZE: 24
  },
  section_config: {
    COLOR: '#0000ff', ALPHA: 0.7, DEPTH_FAIL_ALPHA: 0.3, WIDTH: 2
  },
  default_ore_density: { value: 2.5 },
  id_prefix: { value: 'feature_' },
  default_position: { longitude: 113.323, latitude: 23.106, height: -26 },
  default_transform: { rotationX: 15, rotationY: 0, rotationZ: 0 },
  default_model_config_path: { value: '/3d/demo4/feature.json' },
  default_lod_config: {
    maximumScreenSpaceError: 16, cacheBytes: 536870912,
    maximumCacheOverflowBytes: 536870912, cullWithChildrenBounds: true,
    dynamicScreenSpaceError: true, dynamicScreenSpaceErrorDensity: 0.0002,
    dynamicScreenSpaceErrorFactor: 24, dynamicScreenSpaceErrorHeightFalloff: 0.25,
    cullRequestsWhileMoving: true, cullRequestsWhileMovingMultiplier: 60,
    preferLeaves: false, foveatedScreenSpaceError: true, foveatedConeSize: 0.1,
    foveatedMinimumScreenSpaceErrorRelaxation: 0, foveatedTimeDelay: 0.2,
    skipLevelOfDetail: false, baseScreenSpaceError: 1024,
    skipScreenSpaceErrorFactor: 16, skipLevels: 1,
    immediatelyLoadDesiredLevelOfDetail: false, loadSiblings: false,
    preloadWhenHidden: false, preloadFlightDestinations: true,
    progressiveResolutionHeightFraction: 0.3
  },
  lod_presets: {
    high_quality: { displayName: '高质量', config: { maximumScreenSpaceError: 8, cacheBytes: 1073741824, maximumCacheOverflowBytes: 1073741824, dynamicScreenSpaceError: true, foveatedScreenSpaceError: false, skipLevelOfDetail: false, preloadFlightDestinations: true } },
    balanced: { displayName: '平衡', config: { maximumScreenSpaceError: 16 } },
    performance: { displayName: '高性能', config: { maximumScreenSpaceError: 32, cacheBytes: 268435456, maximumCacheOverflowBytes: 268435456, dynamicScreenSpaceError: true, skipLevelOfDetail: true, skipLevels: 2, cullRequestsWhileMoving: true, cullRequestsWhileMovingMultiplier: 80, foveatedScreenSpaceError: true, foveatedConeSize: 0.12, foveatedTimeDelay: 0.35, preloadWhenHidden: false } }
  },
  adaptive_load_config: {
    enabled: true, lowFpsThreshold: 24, pressureFpsThreshold: 32,
    recoverFpsThreshold: 48, degradeAfterSamples: 3, recoverAfterSamples: 5,
    cooldownMs: 4000, pendingRequestsThreshold: 12, tilesProcessingThreshold: 8,
    memoryThresholdMb: 768, steps: [
      { label: '提高细节阈值', branch: 'standard', lodConfig: { maximumScreenSpaceError: 32 } },
      { label: '切换低精度分支', branch: 'low_precision', lodConfig: { maximumScreenSpaceError: 48, skipLevelOfDetail: true, skipLevels: 2, immediatelyLoadDesiredLevelOfDetail: true, loadSiblings: false, dynamicScreenSpaceError: true, dynamicScreenSpaceErrorFactor: 32 }, displayQuality: 'medium' },
      { label: '降低地形影像分辨率', branch: 'low_precision', lodConfig: { maximumScreenSpaceError: 64, skipLevelOfDetail: true, skipLevels: 3, immediatelyLoadDesiredLevelOfDetail: true, progressiveResolutionHeightFraction: 0.5, foveatedConeSize: 0.18, foveatedTimeDelay: 0.5 }, displayQuality: 'low', terrainQuality: 'low' }
    ]
  }
}

export async function fetchAllAppConfig() {
  return safeRequest(() => client.get('/app-config'), FALLBACK_CONFIG)
}

export async function fetchAppConfigItem(key) {
  return safeRequest(
    () => client.get(`/app-config/${key}`),
    FALLBACK_CONFIG[key] || null
  )
}
