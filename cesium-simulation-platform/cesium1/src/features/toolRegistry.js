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
