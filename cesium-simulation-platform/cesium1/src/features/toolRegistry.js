import { apiConfig, onConfigLoaded } from '@/services/api/initApiConfig.js'

export const TOOL_REGISTRY = [
  {
    id: 'model_control',
    name: '模型控制',
    icon: 'Location',
    loader: () => import('@/features/model-control/components/ModelTransformPanel.vue')
  },
  {
    id: 'geology',
    name: '地质分析',
    icon: 'Monitor',
    loader: () => import('@/features/geology-analysis/components/GeologyPanel.vue')
  },
  {
    id: 'measure',
    name: '测量分析',
    icon: 'Ruler',
    loader: () => import('@/features/measurement-analysis/components/MeasurementPanel.vue')
  },
  {
    id: 'clipping',
    name: '模型切割',
    icon: 'Scissor',
    loader: () => import('@/features/model-clipping/components/ClippingPanel.vue')
  },
  {
    id: 'monitoring',
    name: '现场调度中心',
    icon: 'DataLine',
    loader: () => import('@/features/realtime-monitoring/components/MonitoringPanel.vue')
  },
  {
    id: 'blasting',
    name: '爆破模拟',
    icon: 'VideoPlay',
    loader: () => import('@/features/blasting-simulation/components/BlastingPanel.vue')
  },
  {
    id: 'lod',
    name: 'LOD优化',
    icon: 'Odometer',
    loader: () => import('@/features/lod-optimization/components/LodPanel.vue')
  },
  {
    id: 'stress',
    name: '应力分析',
    icon: 'Histogram',
    loader: () => import('@/features/stress-analysis/components/StressPanel.vue')
  },
  {
    id: 'experiment',
    name: '实验分析',
    icon: 'DataAnalysis',
    loader: () => import('@/features/experiment-analysis/components/ExperimentPanel.vue')
  },
  {
    id: 'system',
    name: '系统工具',
    icon: 'Setting',
    loader: () => import('@/features/system-tools/components/SystemTools.vue')
  }
]

// 本地 loader 映射表（组件懒加载函数不可序列化，保留在本地）
const LOCAL_LOADER_MAP = Object.fromEntries(
  TOOL_REGISTRY.map(t => [t.id, t.loader])
)

// 从数据库 API 获取工具列表（合并 API 元数据与本地 loader）
export function getApiToolRegistry() {
  const apiTools = apiConfig.system?.tools
  if (!apiTools?.length) return TOOL_REGISTRY

  return apiTools.map(t => ({
    id: t.tool_id || t.id,
    name: t.name,
    icon: t.icon,
    loader: LOCAL_LOADER_MAP[t.tool_id] || LOCAL_LOADER_MAP[t.id] || (() => Promise.resolve(null))
  }))
}

// 等待 API 配置加载完成后回调
export function onToolsReady(fn) {
  onConfigLoaded(() => {
    fn(getApiToolRegistry())
  })
}
