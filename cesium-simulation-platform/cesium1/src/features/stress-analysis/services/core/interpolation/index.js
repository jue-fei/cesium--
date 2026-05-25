export {
  toNumberOrDefault,
  toFiniteNumber,
  clamp,
  clampInt,
  clamp01,
  ensureArray,
  parseSizeArray,
  createAnisotropyParams,
  resolveAnisotropyParams,
  resolveDefaultGrid,
  computeAnisotropicDistanceSquared,
  computeAnisotropicDistance,
  extractTensor6Arrays,
  getTensor6FrameCount,
  fract,
  rep,
  normalizeTo01,
  // From sampling.js (merged)
  isFiniteStressTensor,
  buildStressDetails,
  stressFromStrain,
  scaleFiniteSeries,
  scaleTensor6,
  mapStressToIntensity,
  mapStressToRadius,
  computeScalarSeriesFromTensor6,
  computeQuantile,
  buildGridSampleContext,
  sampleWithContext,
  sampleTensor6AtContext,
  toStressTensor,
  sampleStressAtTime,
  computePointDetailsAtTime,
  sampleGridScalarAt,
  sampleGridScalarNearestAt
} from './config.js'
export {
  buildGridPositions,
  POINT_INTERPOLATION_CONSTANTS,
  resolveDefaultKrigingFitMode,
  resolveIdwRuntimeParams,
  resolveInterpolationGrid,
  resolveInterpolationMethod,
  resolveInterpolationPointLimit,
  resolveInterpolationWorkerPolicy,
  resolveOptimizationConfig
} from './pointInterpolationConfig.js'

export {
  parsePointCenter,
  cartesianToDegreesIfValid,
  resolvePointCenterCartesian,
  resolvePointCenterDegrees,
  findNearestPointConfig,
  isPickedFromTileset,
  getPositionFromClick
} from './utils.js'

// Worker安全工具（无Cesium依赖）
// 注意：toNumberOrDefault、toFiniteNumber、clamp、clampInt 已从 config.js 导出
export { parsePointCenter as parsePointCenterWorker } from './utilsWorker.js'

export {
  buildInterpolationSeriesStats,
  createPointSpatialIndex,
  optimizeIDWParameters,
  selectInterpolationPoints
} from './idwCore.js'
export {
  createInterpolationEngine,
  createInterpolationManager,
  predict3D,
  predict3DWithScratch,
  setValues,
  train3D
} from './interpolationCore.js'
