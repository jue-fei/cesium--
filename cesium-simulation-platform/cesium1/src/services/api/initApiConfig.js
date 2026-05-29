/**
 * API 配置初始化 —— 在应用启动时从数据库加载配置
 * 加载成功则替换原有硬编码值，失败则保持默认值
 */
import { fetchAllAppConfig } from './appConfigService'
import { fetchFullMonitoringConfig } from './monitoringService'
import { fetchFullSystemConfig } from './systemConfigService'
import { fetchStressMetrics, fetchHeatmapRamp, fetchWarningRules } from './stressService'
import { fetchFullGeologyData } from './geologyService'
import { fetchFullExperimentConfig } from './experimentService'
import { fetchBlastingConfig } from './blastingService'
import { fetchModelConfigs } from './modelConfigService'

// 全局配置缓存 —— 模块级可变对象，各常量文件可直接读取
export const apiConfig = {
  app: null,
  monitoring: null,
  system: null,
  stressMetrics: null,
  heatmapRamp: null,
  warningRules: null,
  geology: null,
  experiment: null,
  blasting: null,
  modelConfigs: null,
  loaded: false
}

// 各模块的 API 配置变更回调
const listeners = []

export function onConfigLoaded(fn) {
  if (apiConfig.loaded) {
    fn(apiConfig)
  } else {
    listeners.push(fn)
  }
}

function notifyListeners() {
  listeners.forEach(fn => { try { fn(apiConfig) } catch (_) {} })
  listeners.length = 0
}

export async function initApiConfig() {
  if (apiConfig.loaded) return apiConfig

  const tasks = [
    fetchAllAppConfig().then(d => { apiConfig.app = d }).catch(() => {}),
    fetchFullMonitoringConfig().then(d => { apiConfig.monitoring = d }).catch(() => {}),
    fetchFullSystemConfig().then(d => { apiConfig.system = d }).catch(() => {}),
    fetchStressMetrics().then(d => { apiConfig.stressMetrics = d }).catch(() => {}),
    fetchHeatmapRamp().then(d => { apiConfig.heatmapRamp = d }).catch(() => {}),
    fetchWarningRules().then(d => { apiConfig.warningRules = d }).catch(() => {}),
    fetchFullGeologyData().then(d => { apiConfig.geology = d }).catch(() => {}),
    fetchFullExperimentConfig().then(d => { apiConfig.experiment = d }).catch(() => {}),
    fetchBlastingConfig().then(d => { apiConfig.blasting = d }).catch(() => {}),
    fetchModelConfigs().then(d => { apiConfig.modelConfigs = d }).catch(() => {})
  ]

  await Promise.allSettled(tasks)
  apiConfig.loaded = true
  notifyListeners()

  if (import.meta.env.DEV) {
    const loadedCount = Object.values(apiConfig).filter(v => v !== null && v !== false).length - 1
    console.log(`[API Config] 数据库配置加载完成: ${loadedCount}/10 模块成功`)
  }

  return apiConfig
}
