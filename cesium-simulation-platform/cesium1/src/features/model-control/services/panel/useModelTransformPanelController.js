import useModel from '../useModel.js'

export function useModelTransformPanelController() {
  const {
    modelPosition,
    modelTransform,
    updatePosition,
    updateTransform,
    resetView,
    resetModel,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    setUndergroundViewEnabled,
    updateGlobeTranslucency,
    enterUndergroundView
  } = useModel()

  return {
    modelPosition,
    modelTransform,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    resetView,
    resetModel,
    enterUndergroundView,
    onPositionChange: () => updatePosition(modelPosition.value),
    onTransformChange: () => updateTransform(modelTransform.value),
    onUndergroundToggle: () => setUndergroundViewEnabled(undergroundViewEnabled.value),
    onGlobeAlphaChange: () =>
      updateGlobeTranslucency({
        frontFaceAlpha: globeFrontFaceAlpha.value,
        backFaceAlpha: globeBackFaceAlpha.value
      })
  }
}
