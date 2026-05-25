import useGeologyAnalysis from '../useGeologyAnalysis.js'
import { onMounted, onUnmounted } from 'vue'

export function useGeologyPanelController() {
  const { destroy, initGeologyManager, geologicalStats } = useGeologyAnalysis()

  onMounted(() => initGeologyManager())
  onUnmounted(() => destroy())

  return { geologicalStats }
}
