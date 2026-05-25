import { computed, ref } from 'vue'
import { BlastingManager } from './blastingManager.js'
import {
  buildExampleBlastingDataset,
  normalizeBlastingDataset,
  DEFAULT_BLASTING_SUMMARY,
  DEFAULT_PLAYBACK_SPEED_MS
} from './core/io/blastingDataCore.js'
import useMessage from '@/composables/useMessage.js'

let blastingManager = null
let playbackTimer = null

const dataset = ref(null)
const isPlaying = ref(false)
const currentFrame = ref(0)
const playbackSpeedMs = ref(DEFAULT_PLAYBACK_SPEED_MS)
const importStatus = ref(null)

export default function useBlasting() {
  const { showMessage } = useMessage()

  const maxFrame = computed(() => {
    const frameCount = Number(dataset.value?.summary?.frameCount || 0)
    return Math.max(0, frameCount - 1)
  })

  const summary = computed(() => {
    return dataset.value?.summary || DEFAULT_BLASTING_SUMMARY
  })

  const setFrame = frame => {
    if (!dataset.value) return
    const clamped = Math.max(0, Math.min(maxFrame.value, Number(frame) || 0))
    currentFrame.value = clamped
    blastingManager?.setFrame(clamped)
  }

  const pausePlayback = () => {
    if (playbackTimer) clearInterval(playbackTimer)
    playbackTimer = null
    isPlaying.value = false
  }

  const startPlayback = () => {
    if (!dataset.value || isPlaying.value) return
    isPlaying.value = true
    playbackTimer = setInterval(
      () => {
        const next = currentFrame.value >= maxFrame.value ? 0 : currentFrame.value + 1
        setFrame(next)
      },
      Math.max(16, Number(playbackSpeedMs.value || DEFAULT_PLAYBACK_SPEED_MS))
    )
  }

  const togglePlayback = () => {
    if (isPlaying.value) pausePlayback()
    else startPlayback()
  }

  const clearSimulation = () => {
    pausePlayback()
    blastingManager?.clearScene()
    dataset.value = null
    currentFrame.value = 0
    importStatus.value = null
  }

  const applyDataset = (nextDataset, options = {}) => {
    const autoPlay = Boolean(options?.autoPlay)
    pausePlayback()
    dataset.value = nextDataset
    currentFrame.value = 0
    blastingManager?.setDataset(nextDataset)
    blastingManager?.setFrame(0)
    if (autoPlay) startPlayback()
  }

  const loadExample = () => {
    const example = buildExampleBlastingDataset()
    applyDataset(example, { autoPlay: true })
    importStatus.value = { ok: true, message: '示例数据已加载' }
    showMessage('爆破示例已加载', 'success')
  }

  const importFromText = rawText => {
    try {
      const json = JSON.parse(rawText)
      const normalized = normalizeBlastingDataset(json)
      if (!normalized.ok) {
        importStatus.value = { ok: false, message: normalized.message }
        showMessage(normalized.message, 'error')
        return false
      }
      applyDataset(normalized.dataset, { autoPlay: true })
      importStatus.value = { ok: true, message: '数据导入成功' }
      showMessage('爆破数据导入成功', 'success')
      return true
    } catch (error) {
      importStatus.value = { ok: false, message: '文件解析失败，请确认是合法 JSON' }
      showMessage('文件解析失败，请确认是合法 JSON', 'error')
      return false
    }
  }

  const initBlastingManager = viewer => {
    if (!blastingManager && viewer) {
      blastingManager = new BlastingManager(viewer)
    }
  }

  return {
    dataset,
    importStatus,
    isPlaying,
    currentFrame,
    maxFrame,
    playbackSpeedMs,
    summary,
    initBlastingManager,
    importFromText,
    loadExample,
    setFrame,
    togglePlayback,
    clearSimulation
  }
}
