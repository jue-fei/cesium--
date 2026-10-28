export function buildModelServiceApi({
  modelConfigFiles,
  currentConfigFile,
  modelList,
  globalOpacity,
  modelPosition,
  modelTransform,
  modelLoadStatus,
  loading,
  selectedModel,
  undergroundViewEnabled,
  globeFrontFaceAlpha,
  globeBackFaceAlpha,
  onConfigChange,
  interaction,
  toggleFollowModel,
  followedModelId,
  fitToModel,
  resetView,
  resetModel,
  setUndergroundViewEnabled,
  updateGlobeTranslucency,
  enterUndergroundView,
  updatePosition,
  updateTransform,
  updateModelId,
  reloadCurrentConfig,
  reloadCurrentModelWithLodConfig,
  saveModelConfig,
  initModel,
  destroyModel,
  lodConfig,
  getLodStats,
  updateLodConfig,
  applyLodPreset,
  resetLodConfig,
  defaultLodConfig,
  lodRuntime,
  adaptiveLoad,
  lodVisualizationState,
  applyLodVisualizationMode,
  tilesetRef,
  getOriginalModelMatrix
}) {
  return {
    modelConfigFiles,
    currentConfigFile,
    modelList,
    globalOpacity,
    modelPosition,
    modelTransform,
    modelLoadStatus,
    loading,
    selectedModel,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    onConfigChange,
    toggleModelVisibility: model => interaction.toggleModelVisibility(model),
    setModelsVisibility: (models, visible) => interaction.setModelsVisibility(models, visible),
    updateModelOpacity: model => interaction.updateModelOpacity(model),
    updateGlobalOpacity: newOpacity => {
      globalOpacity.value = Number(newOpacity)
      interaction.updateGlobalOpacity(globalOpacity.value, modelList)
    },
    resetAllOpacity: () => interaction.resetAllOpacity(modelList),
    showAllModels: () => interaction.showAllModels(modelList),
    hideAllModels: () => interaction.hideAllModels(modelList),
    fitToModel,
    fitToModels: fitToModel,
    resetView,
    resetModel,
    setUndergroundViewEnabled,
    updateGlobeTranslucency,
    enterUndergroundView,
    updatePosition,
    updateTransform,
    syncModelInfo: model => {
      selectedModel.value = model
    },
    highlightModel: model => interaction.highlightModel(model),
    // 选中模型的包围球（世界坐标）：取要素所在瓦片的包围球，供切割面等需要
    // “模型级基准”的功能使用；要素尚未加载时返回 null（调用方回退整场景）
    getModelBounds: model => {
      const featureId = model && (model.featureId || model.id)
      if (!featureId) return null
      const feature = interaction.featureManager.featureMap.get(featureId)
      const tile = feature && feature.content && feature.content.tile
      const sphere = tile && tile.boundingSphere
      if (!sphere || !sphere.center || !(sphere.radius > 0)) return null
      return { center: sphere.center, radius: sphere.radius }
    },
    toggleFollowModel,
    followedModelId,
    showModelProperties: model => {
      selectedModel.value = model
    },
    showOnlyModel: model => interaction.showOnlyModel(model, modelList),
    updateModelId,
    reloadCurrentConfig,
    reloadCurrentModelWithLodConfig,
    saveModelConfig,
    disableSelection: () => interaction.disableSelection(),
    enableSelection: () => interaction.enableSelection(),
    initModel,
    destroyModel,
    lodConfig,
    getLodStats,
    updateLodConfig,
    applyLodPreset,
    resetLodConfig,
    DEFAULT_LOD_CONFIG: defaultLodConfig,
    lodRuntime,
    adaptiveLoadState: adaptiveLoad.adaptiveLoadState,
    lodVisualizationState,
    applyLodVisualizationMode,
    tilesetRef,
    tileset: tilesetRef,
    modelClickHandler: () => interaction.modelClickHandler(),
    getOriginalModelMatrix,
    fps: adaptiveLoad.fps,
    startGlobalFpsMonitoring: () =>
      adaptiveLoad.startGlobalFpsMonitoring(tilesetRef, lodConfig, lodRuntime),
    stopGlobalFpsMonitoring: () => adaptiveLoad.stopGlobalFpsMonitoring(tilesetRef, lodConfig)
  }
}
