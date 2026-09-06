import { computed, ref, onMounted } from 'vue'
import useBlasting from '../useBlasting.js'
import useUI from '@/composables/useUI.js'
import useModel from '@/features/model-control/services/useModel.js'
import { useBlastingComparison } from './useBlastingComparison.js'

export function useBlastingPanelController() {
  const activeTab = ref('preview')
  const { closeTool } = useUI()
  const { resetView } = useModel()

  const blasting = useBlasting()
  const {
    dataset,
    dbEvents,
    kcoParams,
    playbackSpeedMs,
    saveSimulationResult,
    setFrame,
    clearSimulation,
    loadDbEvent,
    loadDbEvents
  } = blasting

  const comparison = useBlastingComparison(dbEvents)

  const eventName = computed(() => dataset.value?.event?.name || '-')

  onMounted(() => {
    loadDbEvents()
  })

  const onDbEventChange = async eventId => {
    if (!eventId) return
    await loadDbEvent(eventId, { autoPlay: false })
  }

  const exitBlasting = () => {
    clearSimulation()
    resetView?.()
    closeTool()
  }

  const onKcoParamsChange = nextParams => {
    if (!nextParams || typeof nextParams !== 'object') return
    kcoParams.value = { ...kcoParams.value, ...nextParams }
  }

  return {
    activeTab,
    ...blasting,
    ...comparison,
    eventName,
    onDbEventChange,
    exitBlasting,
    saveResult: () => saveSimulationResult(),
    onKcoParamsChange,
    onFrameChange: setFrame,
    onSpeedChange: v => {
      playbackSpeedMs.value = Number(v || 50)
    }
  }
}
