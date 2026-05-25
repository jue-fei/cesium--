import { ref } from 'vue'

export function createFpsMonitor(getViewer) {
  const fps = ref(0)
  let frameCount = 0
  let lastTime = Date.now()
  let removePostRenderListener = null

  const start = () => {
    const viewer = typeof getViewer === 'function' ? getViewer() : null
    if (!viewer || removePostRenderListener) return
    const scene = viewer.scene
    if (!scene) return

    frameCount = 0
    lastTime = Date.now()
    fps.value = 0

    removePostRenderListener = scene.postRender.addEventListener(() => {
      const now = Date.now()
      frameCount++
      if (now - lastTime >= 1000) {
        fps.value = frameCount
        frameCount = 0
        lastTime = now
      }
    })
  }

  const stop = () => {
    if (removePostRenderListener) {
      removePostRenderListener()
      removePostRenderListener = null
    }
  }

  return { fps, start, stop }
}
