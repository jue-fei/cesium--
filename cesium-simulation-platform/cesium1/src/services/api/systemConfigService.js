import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 toolRegistry.js + viewerQualityProfiles.js + 各类常量）----
const FALLBACK_TOOLS = [
  { tool_id: 'model_control', name: '模型控制', icon: 'Location', component_path: '@/features/model-control/components/ModelTransformPanel.vue', sort_order: 1 },
  { tool_id: 'geology', name: '地质分析', icon: 'Monitor', component_path: '@/features/geology-analysis/components/GeologyPanel.vue', sort_order: 2 },
  { tool_id: 'measure', name: '测量分析', icon: 'Ruler', component_path: '@/features/measurement-analysis/components/MeasurementPanel.vue', sort_order: 3 },
  { tool_id: 'clipping', name: '模型切割', icon: 'Scissor', component_path: '@/features/model-clipping/components/ClippingPanel.vue', sort_order: 4 },
  { tool_id: 'monitoring', name: '现场调度中心', icon: 'DataLine', component_path: '@/features/realtime-monitoring/components/MonitoringPanel.vue', sort_order: 5 },
  { tool_id: 'blasting', name: '爆破模拟', icon: 'VideoPlay', component_path: '@/features/blasting-simulation/components/BlastingPanel.vue', sort_order: 6 },
  { tool_id: 'lod', name: 'LOD优化', icon: 'Odometer', component_path: '@/features/lod-optimization/components/LodPanel.vue', sort_order: 7 },
  { tool_id: 'stress', name: '应力分析', icon: 'Histogram', component_path: '@/features/stress-analysis/components/StressPanel.vue', sort_order: 8 },
  { tool_id: 'experiment', name: '实验分析', icon: 'DataAnalysis', component_path: '@/features/experiment-analysis/components/ExperimentPanel.vue', sort_order: 9 },
  { tool_id: 'system', name: '系统工具', icon: 'Setting', component_path: '@/features/system-tools/components/SystemTools.vue', sort_order: 10 }
]

const FALLBACK_DISPLAY_PROFILES = [
  { quality_level: 'low', profile_type: 'display', config_json: { resolutionScale: 0.65, useBrowserRecommendedResolution: true, fxaa: false } },
  { quality_level: 'medium', profile_type: 'display', config_json: { resolutionScale: 0.85, useBrowserRecommendedResolution: true, fxaa: false } },
  { quality_level: 'high', profile_type: 'display', config_json: { resolutionScale: 1, useBrowserRecommendedResolution: true, fxaa: false } },
  { quality_level: 'low', profile_type: 'terrain', config_json: { maximumScreenSpaceError: 32 } },
  { quality_level: 'medium', profile_type: 'terrain', config_json: { maximumScreenSpaceError: 16 } },
  { quality_level: 'high', profile_type: 'terrain', config_json: { maximumScreenSpaceError: 8 } }
]

const FALLBACK_CLIPPING = {
  axes: ['X', 'Y', 'Z'],
  directions: ['正向', '反向'],
  polygonDirections: [{ key: 'excavate', label: '挖掘' }, { key: 'isolate', label: '保留' }],
  defaultPositionRange: { min: -2000, max: 2000, step: 0.5 }
}

const FALLBACK_MEASUREMENT = {
  types: { DISTANCE: 'distance', AREA: 'area' },
  minPoints: { distance: 2, area: 3 }
}

const FALLBACK_EXPORT = {
  types: { JSON: 'json', REPORT: 'report', SCREENSHOT: 'screenshot', CSV: 'csv' },
  screenshotFormatOptions: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }],
  defaultScreenshotOptions: { format: 'png', quality: 1.0 }
}

export async function fetchTools() {
  return safeRequest(() => client.get('/system/tools'), FALLBACK_TOOLS)
}

export async function fetchDisplayProfiles() {
  return safeRequest(() => client.get('/system/display-profiles'), FALLBACK_DISPLAY_PROFILES)
}

export async function fetchClippingConstants() {
  return safeRequest(() => client.get('/system/clipping-constants'), FALLBACK_CLIPPING)
}

export async function fetchMeasurementConstants() {
  return safeRequest(() => client.get('/system/measurement-constants'), FALLBACK_MEASUREMENT)
}

export async function fetchExportConstants() {
  return safeRequest(() => client.get('/system/export-constants'), FALLBACK_EXPORT)
}

export async function fetchFullSystemConfig() {
  return safeRequest(
    () => client.get('/system/full'),
    {
      tools: FALLBACK_TOOLS,
      displayProfiles: FALLBACK_DISPLAY_PROFILES,
      clipping_constants: FALLBACK_CLIPPING,
      measurement_constants: FALLBACK_MEASUREMENT,
      export_constants: FALLBACK_EXPORT
    }
  )
}
