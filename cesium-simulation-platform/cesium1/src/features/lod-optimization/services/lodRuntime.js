import { warn } from '@/utils/errorHandler.js'

export function createLodRuntimeState() {
  return {
    pendingRequests: 0,
    tilesProcessing: 0,
    initialTilesLoaded: false,
    allTilesLoaded: false,
    lastUpdatedMs: 0
  }
}

export function bindTilesetLodRuntimeEvents(tileset, onPatch) {
  if (!tileset) return () => null

  const emit = patch => {
    if (typeof onPatch === 'function') onPatch(patch)
  }

  const onLoadProgress = (pendingRequests, tilesProcessing) => {
    emit({
      pendingRequests: Number(pendingRequests) || 0,
      tilesProcessing: Number(tilesProcessing) || 0
    })
  }

  const onInitialTilesLoaded = () => {
    emit({ initialTilesLoaded: true })
  }

  const onAllTilesLoaded = () => {
    emit({ allTilesLoaded: true })
  }

  tileset.loadProgress.addEventListener(onLoadProgress)
  tileset.initialTilesLoaded.addEventListener(onInitialTilesLoaded)
  tileset.allTilesLoaded.addEventListener(onAllTilesLoaded)

  return () => {
    try {
      tileset.loadProgress.removeEventListener(onLoadProgress)
      tileset.initialTilesLoaded.removeEventListener(onInitialTilesLoaded)
      tileset.allTilesLoaded.removeEventListener(onAllTilesLoaded)
    } catch (e) {
      warn('lod', 'lodRuntime', e)
    }
  }
}

const RUNTIME_UNSAFE_PROPS = ['cacheBytes', 'maximumCacheOverflowBytes']

export function applyLodConfigToTileset(tileset, config, requestRender) {
  if (!tileset || !config) return false
  Object.keys(config).forEach(prop => {
    if (RUNTIME_UNSAFE_PROPS.includes(prop)) return
    if (prop in tileset && typeof tileset[prop] !== 'function') {
      try {
        tileset[prop] = config[prop]
      } catch (e) {
        console.warn(`Failed to set property ${prop} on tileset`, e)
      }
    }
  })
  if (typeof requestRender === 'function') requestRender()
  return true
}

export function getTilesetMemoryUsageBytes(tileset) {
  return tileset ? Number(tileset.totalMemoryUsageInBytes) || 0 : 0
}
