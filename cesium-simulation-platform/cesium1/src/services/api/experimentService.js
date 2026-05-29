import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 experimentDefaults.js）----
const FALLBACK_PRESETS = [
  { preset_id: 'visual_contrast', label: '强对比可视化场景', description: '45 个稀疏采样点，梯度峰值应力场，三类 Kriging 模型同时对比', config_json: { dataGeneration: { pointCount: 45, noiseLevel: 0.1, anomalyCount: 6, anomalyMagnitude: 2.2, trendType: 'gradient_peak' }, comparison: { krigingModels: ['exponential', 'gaussian', 'spherical'] } } },
  { preset_id: 'small_dense', label: '小规模密集点', description: '100 个采样点，低噪声', config_json: { dataGeneration: { pointCount: 100, noiseLevel: 0.02, anomalyCount: 3 } } },
  { preset_id: 'medium_sparse', label: '中等规模稀疏点', description: '60 个采样点，中等噪声', config_json: { dataGeneration: { pointCount: 60, noiseLevel: 0.08, anomalyCount: 5 } } },
  { preset_id: 'large_noisy', label: '大规模含噪点', description: '200 个采样点，高噪声+异常值', config_json: { dataGeneration: { pointCount: 200, noiseLevel: 0.15, anomalyCount: 12, anomalyMagnitude: 2.5 } } },
  { preset_id: 'gradient_field', label: '梯度应力场', description: '线性梯度+高斯峰混合场', config_json: { dataGeneration: { pointCount: 150, noiseLevel: 0.05, anomalyCount: 6, trendType: 'gradient_peak' } } }
]

const FALLBACK_METHODS = [
  { method_key: 'idw', label: 'IDW（反距离加权）' },
  { method_key: 'kriging', label: 'Kriging（普通克里金）' },
  { method_key: 'idw_optimized', label: 'IDW-PSO（PSO优化）' },
  { method_key: 'idw_default', label: 'IDW（默认参数）' },
  { method_key: 'kriging_exponential', label: 'Kriging（指数模型）' },
  { method_key: 'kriging_gaussian', label: 'Kriging（高斯模型）' },
  { method_key: 'kriging_spherical', label: 'Kriging（球状模型）' }
]

const FALLBACK_DEFAULT_CONFIG = {
  dataGeneration: { fieldSize: [200, 200, 100], pointCount: 150, testRatio: 0.3, seed: 2026, noiseLevel: 0.05, anomalyCount: 8, anomalyMagnitude: 2.0, trendType: 'gaussian_mixture' },
  comparison: { krigingModels: ['exponential'], idwConfig: { optimizeParameters: false, neighborPolicy: 'sector', sectorCount: 8 }, krigingConfig: { model: 'exponential' }, gridResolution: 32, crossValidationFolds: 5, repeatCount: 5 },
  metrics: ['rmse', 'mae', 'r2', 'maxError', 'mape'],
  chart: { colors: { idw: '#409EFF', kriging: '#67C23A', krigingGaussian: '#E6A23C', krigingSpherical: '#F56C6C' } }
}

export async function fetchExperimentPresets() {
  return safeRequest(() => client.get('/experiment/presets'), FALLBACK_PRESETS)
}

export async function fetchExperimentMethods() {
  return safeRequest(() => client.get('/experiment/methods'), FALLBACK_METHODS)
}

export async function fetchExperimentDefaultConfig() {
  return safeRequest(() => client.get('/experiment/default-config'), FALLBACK_DEFAULT_CONFIG)
}

export async function fetchFullExperimentConfig() {
  return safeRequest(
    () => client.get('/experiment/full'),
    { presets: FALLBACK_PRESETS, methods: FALLBACK_METHODS, defaultConfig: FALLBACK_DEFAULT_CONFIG }
  )
}
