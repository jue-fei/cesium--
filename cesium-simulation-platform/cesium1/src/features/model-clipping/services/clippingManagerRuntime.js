import ClippingManager from './clippingManager.js'

let clippingManager = null

export function createClippingManagerRuntime({ getViewer, tilesetRef }) {
  function ensureClippingManager() {
    const viewer = getViewer()
    if (!viewer) return null

    const currentViewer = clippingManager?.viewer
    const currentViewerDestroyed =
      currentViewer &&
      typeof currentViewer.isDestroyed === 'function' &&
      currentViewer.isDestroyed()

    if (!clippingManager || !currentViewer || currentViewerDestroyed || currentViewer !== viewer) {
      destroyClippingManager()
      clippingManager = new ClippingManager(viewer)
      clippingManager.setTileset(tilesetRef.value || null)
    }

    return clippingManager
  }

  function destroyClippingManager() {
    try {
      if (clippingManager?.destroy) clippingManager.destroy()
    } catch (e) {
    }
    clippingManager = null
  }

  function syncManagerTileset() {
    const manager = ensureClippingManager()
    if (manager) manager.setTileset(tilesetRef.value || null)
    return manager
  }

  return {
    ensureClippingManager,
    destroyClippingManager,
    syncManagerTileset
  }
}
