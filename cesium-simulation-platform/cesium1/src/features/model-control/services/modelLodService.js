import {
  applyLodConfigToTileset,
  createLodRuntimeState,
  getTilesetMemoryUsageBytes
} from '../../lod-optimization/services/lodRuntime.js'
import { getPreset } from './modelServiceHelpers.js'

export function createModelLodService({
  lodRuntime,
  lodVisualizationState,
  tilesetRef,
  getViewer,
  lodConfig,
  adaptiveLoad,
  defaultLodConfig
}) {
  const resetLodRuntime = () => {
    lodRuntime.value = createLodRuntimeState()
    lodVisualizationState.mode = 'off'
  }

  const updateLodRuntime = patch => {
    if (!lodRuntime.value || typeof lodRuntime.value !== 'object') {
      resetLodRuntime()
    }
    Object.assign(lodRuntime.value, patch, { lastUpdatedMs: Date.now() })
  }

  const applyLodVisualizationMode = mode => {
    const normalized = [
      'off',
      'stage_color',
      'stage_wireframe',
      'random_tiles',
      'random_wireframe'
    ].includes(mode)
      ? mode
      : 'off'
    const viewer = getViewer()
    const tileset = tilesetRef.value
    if (tileset) {
      tileset.__lodVisualizationMode = normalized
      tileset.debugColorizeTiles =
        normalized === 'random_tiles' || normalized === 'random_wireframe'
      tileset.debugWireframe = normalized === 'stage_wireframe' || normalized === 'random_wireframe'
      if (viewer) viewer.scene.requestRender()
    }
    lodVisualizationState.mode = normalized
    if (lodRuntime.value && typeof lodRuntime.value === 'object') {
      lodRuntime.value.visualizationMode = normalized
    }
  }

  const applyConfigToTileset = config => {
    const viewer = getViewer()
    const requestRender = () => {
      if (viewer) viewer.scene.requestRender()
    }
    return applyLodConfigToTileset(tilesetRef.value, { ...config }, requestRender)
  }

  const updateLodConfig = newConfig => {
    lodConfig.value = { ...lodConfig.value, ...newConfig }
    if (tilesetRef.value) {
      const ok = applyConfigToTileset(lodConfig.value)
      if (adaptiveLoad.adaptiveLoadState.level === 0) {
        adaptiveLoad.syncAdaptiveBaseline(lodConfig.value)
      }
      return ok
    }
    if (adaptiveLoad.adaptiveLoadState.level === 0) {
      adaptiveLoad.syncAdaptiveBaseline(lodConfig.value)
    }
    return false
  }

  const applyLodPreset = presetName => {
    const preset = getPreset(presetName)
    if (preset) updateLodConfig(preset.config)
  }

  const resetLodConfig = () => {
    lodConfig.value = { ...defaultLodConfig }
    if (tilesetRef.value) {
      applyConfigToTileset(lodConfig.value)
    }
  }

  const getLodStats = () => ({
    ...lodRuntime.value,
    totalMemoryUsageInBytes: getTilesetMemoryUsageBytes(tilesetRef.value)
  })

  return {
    resetLodRuntime,
    updateLodRuntime,
    applyLodVisualizationMode,
    applyConfigToTileset,
    updateLodConfig,
    applyLodPreset,
    resetLodConfig,
    getLodStats
  }
}
