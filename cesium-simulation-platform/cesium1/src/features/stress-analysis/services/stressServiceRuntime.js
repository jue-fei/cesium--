import { createStressImportActions } from './core/application/stressImportActions.js'
import { createStressDataControlService } from './core/application/stressDataControlService.js'
import { createStressDataRebuildService } from './core/application/stressDataRebuildService.js'
import {
  createStressControllers,
  createStressCoreActions,
  refreshStressSafetyContext
} from './stressServiceHelpers.js'

function buildStressSharedActionDeps(runtime) {
  return {
    viewer: runtime.viewer,
    tileset: runtime.tileset,
    showMessage: runtime.showMessage,
    stressDebugLog: runtime.stressDebugLog,
    config: runtime.config,
    stressSource: runtime.stressSource,
    pointRenderMode: runtime.pointRenderMode,
    pointSourceMode: runtime.pointSourceMode,
    unitStress: runtime.unitStress,
    materialE: runtime.materialE,
    materialNu: runtime.materialNu,
    importReport: runtime.importReport,
    metric: runtime.metric,
    directionAzimuth: runtime.directionAzimuth,
    directionDip: runtime.directionDip,
    timeDimension: runtime.timeDimension,
    playbackSpeed: runtime.playbackSpeed,
    currentTime: runtime.currentTime,
    maxTime: runtime.maxTime,
    safetyContext: runtime.safetyContext
  }
}

function buildStressDataActions(runtime, sharedActionDeps, controllers, coreActions) {
  const dataActionCtx = {
    ...sharedActionDeps,
    overlayItems: runtime.overlayItems,
    heatmapDisplay: runtime.heatmapDisplay,
    heatmapBaseRamp: runtime.heatmapBaseRamp,
    cachedScalarFields: runtime.cachedScalarFields,
    cachedPointInterpolationFields: runtime.cachedPointInterpolationFields,
    setRenderProgress: runtime.setRenderProgress,
    resetPick: controllers.samplingActions.resetPick,
    applyToModel: coreActions.applyToModel,
    recordHistory: controllers.history.recordHistory,
    resetHistory: controllers.history.resetHistory
  }
  const rebuilders = createStressDataRebuildService(dataActionCtx)
  const controls = createStressDataControlService(dataActionCtx, rebuilders)
  return { ...rebuilders, ...controls }
}

function buildStressImportActions(
  runtime,
  sharedActionDeps,
  controllers,
  coreActions,
  dataActions
) {
  return createStressImportActions({
    ...sharedActionDeps,
    cachedScalarFields: runtime.cachedScalarFields,
    cachedPointInterpolationFields: runtime.cachedPointInterpolationFields,
    resetPick: controllers.samplingActions.resetPick,
    applyToModel: coreActions.applyToModel,
    heatmapDisplay: runtime.heatmapDisplay,
    resetHistory: controllers.history.resetHistory,
    rebuildConfig: dataActions.rebuildConfig
  })
}

export function createStressRuntimeServices(runtime) {
  const actionRefs = {
    rebuildConfig: () => false,
    applyToModel: () => {}
  }
  const controllers = createStressControllers({
    ...runtime,
    actionRefs
  })
  const coreActions = createStressCoreActions({
    manager: runtime.manager,
    tileset: runtime.tileset,
    config: runtime.config,
    currentTime: runtime.currentTime,
    updateKnownPointStressOverlay: controllers.overlay.updateKnownPointStressOverlay,
    stressSource: runtime.stressSource,
    importReport: runtime.importReport,
    unitStress: runtime.unitStress,
    materialE: runtime.materialE,
    materialNu: runtime.materialNu,
    cachedScalarFields: runtime.cachedScalarFields,
    cachedPointInterpolationFields: runtime.cachedPointInterpolationFields,
    safetyContext: runtime.safetyContext,
    historyPast: runtime.historyPast,
    historyFuture: runtime.historyFuture,
    setRenderProgress: runtime.setRenderProgress,
    knownPointStressVisible: runtime.knownPointStressVisible,
    clearKnownPointStressOverlay: controllers.overlay.clearKnownPointStressOverlay,
    samplingActions: controllers.samplingActions,
    heatmapBaseRamp: runtime.heatmapBaseRamp,
    heatmapDisplay: runtime.heatmapDisplay,
    timeDimension: runtime.timeDimension,
    maxTime: runtime.maxTime,
    playbackSpeed: runtime.playbackSpeed,
    geologyStore: runtime.geologyStore,
    viewer: runtime.viewer,
    refreshSafetyContext: refreshStressSafetyContext,
    playback: controllers.playback,
    showMessage: runtime.showMessage,
    createIdleRenderProgress: runtime.createIdleRenderProgress
  })
  const sharedActionDeps = buildStressSharedActionDeps(runtime)
  const dataActions = buildStressDataActions(runtime, sharedActionDeps, controllers, coreActions)
  actionRefs.rebuildConfig = () => dataActions.rebuildConfig()
  actionRefs.applyToModel = coreActions.applyToModel
  const importActions = buildStressImportActions(
    runtime,
    sharedActionDeps,
    controllers,
    coreActions,
    dataActions
  )

  return {
    ...controllers,
    coreActions,
    dataActions,
    importActions
  }
}
