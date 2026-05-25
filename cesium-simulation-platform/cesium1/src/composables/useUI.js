import { ref } from 'vue'

const activeTool = ref('')

export default function useUI() {
  const toggleTool = toolId => {
    if (activeTool.value === toolId) {
      activeTool.value = ''
    } else {
      activeTool.value = toolId
    }
  }

  const closeTool = () => {
    activeTool.value = ''
  }

  const tools = [
    { id: 'model_control', name: '模型控制', icon: 'Location' },
    { id: 'geology', name: '地质分析', icon: 'Monitor' },
    { id: 'measure', name: '测量分析', icon: 'Ruler' },
    { id: 'clipping', name: '模型切割', icon: 'Scissor' },
    { id: 'monitoring', name: '实时监控', icon: 'DataLine' },
    { id: 'blasting', name: '爆破模拟', icon: 'VideoPlay' },
    { id: 'scenario', name: '场景交互', icon: 'Mouse' },
    { id: 'lod', name: 'LOD优化', icon: 'Odometer' },
    { id: 'stress', name: '应力分析', icon: 'Histogram' },
    { id: 'system', name: '系统工具', icon: 'Setting' }
  ]

  return {
    activeTool,
    toggleTool,
    closeTool,
    tools
  }
}
