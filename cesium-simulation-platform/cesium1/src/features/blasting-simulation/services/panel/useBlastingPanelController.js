import { computed, ref } from 'vue'
import useBlasting from '../useBlasting.js'

export function useBlastingPanelController() {
  const fileInput = ref(null)
  const {
    dataset,
    importStatus,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    summary,
    importFromText,
    loadExample,
    setFrame,
    togglePlayback,
    clearSimulation
  } = useBlasting()

  const eventName = computed(() => dataset.value?.event?.name || '-')

  const onFileChange = async event => {
    const file = event?.target?.files?.[0]
    if (!file) return
    const text = await file.text()
    importFromText(text)
    if (event.target) event.target.value = ''
  }

  return {
    fileInput,
    dataset,
    importStatus,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    summary,
    eventName,
    loadExample,
    togglePlayback,
    clearSimulation,
    onFileChange,
    onFrameChange: setFrame,
    onSpeedChange: v => {
      playbackSpeedMs.value = Number(v || 120)
    }
  }
}
