export function createStressPlaybackController(deps) {
  const {
    manager,
    tileset,
    currentTime,
    maxTime,
    isPlaying,
    playbackSpeed,
    pickedPoint,
    pickedPointValue,
    pickedPointDetails,
    pickedPointSeries,
    samplingActions,
    updateKnownPointStressOverlay,
    runtime
  } = deps

  const setTime = t => {
    currentTime.value = t
    if (runtime.setTimeRafId) cancelAnimationFrame(runtime.setTimeRafId)
    runtime.setTimeRafId = requestAnimationFrame(() => {
      runtime.setTimeRafId = null
      if (manager.value && tileset.value) manager.value.updateStressTime(tileset.value, t)
    })
    if (pickedPoint.value) {
      const sampled = samplingActions.samplePickedPoint(pickedPoint.value, t)
      pickedPointValue.value = sampled.value
      pickedPointDetails.value = sampled.details
      pickedPointSeries.value = sampled.series
    }
    updateKnownPointStressOverlay()
  }

  const play = () => {
    isPlaying.value = true
    runtime.lastFrameTime = performance.now()
    runtime.lastTimeIndex = currentTime.value
    const tick = () => {
      if (!isPlaying.value) return
      runtime.rafId = requestAnimationFrame(tick)
      const now = performance.now()
      const elapsed = now - runtime.lastFrameTime
      if (elapsed < playbackSpeed.value) return
      const framesToAdvance = Math.max(1, Math.floor(elapsed / playbackSpeed.value))
      runtime.lastFrameTime += framesToAdvance * playbackSpeed.value
      if (runtime.lastFrameTime < now - playbackSpeed.value * 2) {
        runtime.lastFrameTime = now
      }
      let next = runtime.lastTimeIndex + 1
      if (next > maxTime.value) next = 0
      runtime.lastTimeIndex = next
      setTime(next)
    }
    runtime.rafId = requestAnimationFrame(tick)
  }

  const pause = () => {
    isPlaying.value = false
    if (runtime.timer) clearInterval(runtime.timer)
    runtime.timer = null
    if (runtime.rafId) cancelAnimationFrame(runtime.rafId)
    runtime.rafId = null
  }

  const cleanupPlayback = () => {
    pause()
    if (runtime.setTimeRafId) cancelAnimationFrame(runtime.setTimeRafId)
    runtime.setTimeRafId = null
  }

  return {
    setTime,
    play,
    pause,
    cleanupPlayback,
    togglePlayback: () => (isPlaying.value ? pause() : play())
  }
}
