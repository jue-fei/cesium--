/**
 * 功能模块公共 API 层
 *
 * 所有跨功能模块的通信均通过此入口，避免深层相对路径导入。
 * 外部消费者（composables、App.vue 等）统一从此入口导入。
 *
 * 约定：
 * - 每个功能模块对外只暴露组合函数（useXxx）和纯工具函数
 * - 不暴露内部实现细节（manager 类、core 算法、panel 控制器）
 */

// ---- model-control（核心模块：模型加载 / 变换 / 特征管理）----
export { default as useModel, useModelState } from '../model-control/services/useModel.js'

// ---- measurement-analysis（测量分析：距离 / 面积 / 历史记录）----
export { default as useMeasurement } from '../measurement-analysis/services/useMeasurement.js'

// ---- model-clipping（模型切割：平面裁剪 / 多边形裁剪）----
export { default as useClipping } from '../model-clipping/services/useClipping.js'

// ---- geology-analysis（地质分析：钻孔 / 剖面 / 矿体储量）----
export {
  default as useGeologyAnalysis,
  exportBoreholesToJSON,
  exportGeologyReport,
  calculateStratigraphyStats
} from '../geology-analysis/services/useGeologyAnalysis.js'

// ---- realtime-monitoring（实时监控：矿卡、路线、回放）----
export { default as useMonitoring } from '../realtime-monitoring/services/useMonitoring.js'

// ---- blasting-simulation（爆破模拟：数据播放与场景动画）----
export { default as useBlasting } from '../blasting-simulation/services/useBlasting.js'

// ---- lod-optimization（LOD 优化：FPS 监控 / 自适应降级 / 质量配置）----
export { createFpsMonitor } from '../lod-optimization/services/fpsMonitor.js'
export {
  createAdaptiveLoadRuntime,
  evaluateAdaptiveLoad,
  getAdaptiveLoadStep
} from '../lod-optimization/services/adaptiveLoad.js'
export {
  createLodRuntimeState,
  bindTilesetLodRuntimeEvents,
  applyLodConfigToTileset,
  getTilesetMemoryUsageBytes
} from '../lod-optimization/services/lodRuntime.js'
export {
  getDisplayQualityProfile,
  getTerrainQualityProfile
} from '../lod-optimization/services/viewerQualityProfiles.js'

// ---- toolRegistry（工具注册表：侧边栏工具列表）----
export { TOOL_REGISTRY, getApiToolRegistry, onToolsReady } from '../toolRegistry.js'

// ---- fusion（模块间数据联动：FusionBus 事件总线）----
export { fusionBus, CHANNELS } from '@/services/fusion/FusionBus.js'
