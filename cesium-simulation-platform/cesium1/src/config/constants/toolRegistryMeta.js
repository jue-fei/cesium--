export const TOOL_REGISTRY_META = [
  {
    id: 'model_control',
    name: '模型控制',
    icon: 'Location',
    componentPath: '@/features/model-control/components/ModelTransformPanel.vue'
  },
  {
    id: 'geology',
    name: '地质分析',
    icon: 'Monitor',
    componentPath: '@/features/geology-analysis/components/GeologyPanel.vue'
  },
  {
    id: 'measure',
    name: '测量分析',
    icon: 'Ruler',
    componentPath: '@/features/measurement-analysis/components/MeasurementPanel.vue'
  },
  {
    id: 'clipping',
    name: '模型切割',
    icon: 'Scissor',
    componentPath: '@/features/model-clipping/components/ClippingPanel.vue'
  },
  {
    id: 'monitoring',
    name: '现场调度中心',
    icon: 'DataLine',
    componentPath: '@/features/realtime-monitoring/components/MonitoringPanel.vue'
  },
  {
    id: 'blasting',
    name: '爆破模拟',
    icon: 'VideoPlay',
    componentPath: '@/features/blasting-simulation/components/BlastingPanel.vue'
  },
  {
    id: 'lod',
    name: 'LOD优化',
    icon: 'Odometer',
    componentPath: '@/features/lod-optimization/components/LodPanel.vue'
  },
  {
    id: 'stress',
    name: '应力分析',
    icon: 'Histogram',
    componentPath: '@/features/stress-analysis/components/StressPanel.vue'
  },
  {
    id: 'experiment',
    name: '实验分析',
    icon: 'DataAnalysis',
    componentPath: '@/features/experiment-analysis/components/ExperimentPanel.vue'
  },
  {
    id: 'system',
    name: '系统工具',
    icon: 'Setting',
    componentPath: '@/features/system-tools/components/SystemTools.vue'
  }
]

export function resolveToolLoader(id) {
  switch (id) {
    case 'model_control':
      return () => import('@/features/model-control/components/ModelTransformPanel.vue')
    case 'geology':
      return () => import('@/features/geology-analysis/components/GeologyPanel.vue')
    case 'measure':
      return () => import('@/features/measurement-analysis/components/MeasurementPanel.vue')
    case 'clipping':
      return () => import('@/features/model-clipping/components/ClippingPanel.vue')
    case 'monitoring':
      return () => import('@/features/realtime-monitoring/components/MonitoringPanel.vue')
    case 'blasting':
      return () => import('@/features/blasting-simulation/components/BlastingPanel.vue')
    case 'lod':
      return () => import('@/features/lod-optimization/components/LodPanel.vue')
    case 'stress':
      return () => import('@/features/stress-analysis/components/StressPanel.vue')
    case 'experiment':
      return () => import('@/features/experiment-analysis/components/ExperimentPanel.vue')
    case 'system':
      return () => import('@/features/system-tools/components/SystemTools.vue')
    default:
      return () => Promise.resolve(null)
  }
}

export function buildFallbackTools() {
  return TOOL_REGISTRY_META.map((tool, index) => ({
    tool_id: tool.id,
    name: tool.name,
    icon: tool.icon,
    component_path: tool.componentPath,
    sort_order: index + 1
  }))
}
