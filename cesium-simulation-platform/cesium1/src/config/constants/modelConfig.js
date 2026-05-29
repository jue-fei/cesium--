import { apiConfig } from '@/services/api/initApiConfig.js'

export const DEFAULT_LOD_CONFIG = {
  maximumScreenSpaceError: 16,
  cacheBytes: 536870912,
  maximumCacheOverflowBytes: 536870912,
  cullWithChildrenBounds: true,
  dynamicScreenSpaceError: true,
  dynamicScreenSpaceErrorDensity: 0.0002,
  dynamicScreenSpaceErrorFactor: 24.0,
  dynamicScreenSpaceErrorHeightFalloff: 0.25,
  cullRequestsWhileMoving: true,
  cullRequestsWhileMovingMultiplier: 60.0,
  preferLeaves: false,
  foveatedScreenSpaceError: true,
  foveatedConeSize: 0.1,
  foveatedMinimumScreenSpaceErrorRelaxation: 0.0,
  foveatedTimeDelay: 0.2,
  skipLevelOfDetail: false,
  baseScreenSpaceError: 1024,
  skipScreenSpaceErrorFactor: 16,
  skipLevels: 1,
  immediatelyLoadDesiredLevelOfDetail: false,
  loadSiblings: false,
  preloadWhenHidden: false,
  preloadFlightDestinations: true,
  progressiveResolutionHeightFraction: 0.3
}

export const PRESETS = {
  high_quality: {
    displayName: '高质量',
    config: {
      maximumScreenSpaceError: 8,
      cacheBytes: 1073741824,
      maximumCacheOverflowBytes: 1073741824,
      dynamicScreenSpaceError: true,
      foveatedScreenSpaceError: false,
      skipLevelOfDetail: false,
      preloadFlightDestinations: true
    }
  },
  balanced: { displayName: '平衡', config: { maximumScreenSpaceError: 16 } },
  performance: {
    displayName: '高性能',
    config: {
      maximumScreenSpaceError: 32,
      cacheBytes: 268435456,
      maximumCacheOverflowBytes: 268435456,
      dynamicScreenSpaceError: true,
      skipLevelOfDetail: true,
      skipLevels: 2,
      cullRequestsWhileMoving: true,
      cullRequestsWhileMovingMultiplier: 80.0,
      foveatedScreenSpaceError: true,
      foveatedConeSize: 0.12,
      foveatedTimeDelay: 0.35,
      preloadWhenHidden: false
    }
  }
}

export const DEFAULT_ADAPTIVE_LOAD_CONFIG = {
  enabled: true,
  lowFpsThreshold: 24,
  pressureFpsThreshold: 32,
  recoverFpsThreshold: 48,
  degradeAfterSamples: 3,
  recoverAfterSamples: 5,
  cooldownMs: 4000,
  pendingRequestsThreshold: 12,
  tilesProcessingThreshold: 8,
  memoryThresholdMb: 768,
  steps: [
    { label: '提高细节阈值', branch: 'standard', lodConfig: { maximumScreenSpaceError: 32 } },
    {
      label: '切换低精度分支',
      branch: 'low_precision',
      lodConfig: {
        maximumScreenSpaceError: 48,
        skipLevelOfDetail: true,
        skipLevels: 2,
        immediatelyLoadDesiredLevelOfDetail: true,
        loadSiblings: false,
        dynamicScreenSpaceError: true,
        dynamicScreenSpaceErrorFactor: 32
      },
      displayQuality: 'medium'
    },
    {
      label: '降低地形影像分辨率',
      branch: 'low_precision',
      lodConfig: {
        maximumScreenSpaceError: 64,
        skipLevelOfDetail: true,
        skipLevels: 3,
        immediatelyLoadDesiredLevelOfDetail: true,
        progressiveResolutionHeightFraction: 0.5,
        foveatedConeSize: 0.18,
        foveatedTimeDelay: 0.5
      },
      displayQuality: 'low',
      terrainQuality: 'low'
    }
  ]
}

export const DEFAULT_POSITION = { longitude: 113.323, latitude: 23.106, height: -26 }
export const DEFAULT_TRANSFORM = { rotationX: 15, rotationY: 0, rotationZ: 0 }
export const DEFAULT_MODEL_CONFIG_PATH = '/3d/demo4/feature.json'

// 从数据库 API 获取实时配置
export function getApiLodConfig() {
  return apiConfig.app?.default_lod_config || DEFAULT_LOD_CONFIG
}

export function getApiLodPresets() {
  return apiConfig.app?.lod_presets || PRESETS
}

export function getApiAdaptiveLoadConfig() {
  return apiConfig.app?.adaptive_load_config || DEFAULT_ADAPTIVE_LOAD_CONFIG
}

export function getApiDefaultPosition() {
  const api = apiConfig.app?.default_position
  if (api) return { ...DEFAULT_POSITION, ...api }
  return DEFAULT_POSITION
}

export function getApiDefaultTransform() {
  const api = apiConfig.app?.default_transform
  if (api) return { ...DEFAULT_TRANSFORM, ...api }
  return DEFAULT_TRANSFORM
}

export function getApiDefaultModelConfigPath() {
  return apiConfig.app?.default_model_config_path?.value || DEFAULT_MODEL_CONFIG_PATH
}
