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

  return {
    activeTool,
    toggleTool,
    closeTool
  }
}
