import { ref, onScopeDispose } from 'vue'
import useModel from '../useModel.js'
import { blastingSceneTools } from '@/services/fusion/blastingSceneTools.js'

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

  // 爆破场景活跃状态（由工具桥订阅，面板据此把控件重定向到 three 场景）
  const blastingSceneActive = ref(blastingSceneTools.active)

  /** 进入爆破模式时，把两个 alpha 滑块初值同步为 three 场景当前透明度 */
  const syncOpacityFromScene = () => {
    if (!blastingSceneTools.active) return
    const rock = blastingSceneTools.getOpacity('rock')
    const tunnel = blastingSceneTools.getOpacity('tunnel')
    if (rock != null) globeFrontFaceAlpha.value = Math.round(rock * 100)
    if (tunnel != null) globeBackFaceAlpha.value = Math.round(tunnel * 100)
  }

  const unsubscribe = blastingSceneTools.subscribe(v => {
    blastingSceneActive.value = v
    if (v) syncOpacityFromScene()
  })
  onScopeDispose(unsubscribe)

  return {
    modelPosition,
    modelTransform,
    undergroundViewEnabled,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    blastingSceneActive,
    resetView,
    resetModel,
    enterUndergroundView,
    syncOpacityFromScene,
    onPositionChange: () => updatePosition(modelPosition.value),
    onTransformChange: () => updateTransform(modelTransform.value),
    onUndergroundToggle: () => setUndergroundViewEnabled(undergroundViewEnabled.value),
    onGlobeAlphaChange: () => {
      // 爆破模式：两个 alpha 滑块重定向到爆破 three 场景对象（岩体/巷道）透明度
      if (blastingSceneTools.active) {
        blastingSceneTools.setOpacity('rock', globeFrontFaceAlpha.value / 100)
        blastingSceneTools.setOpacity('tunnel', globeBackFaceAlpha.value / 100)
        return
      }
      updateGlobeTranslucency({
        frontFaceAlpha: globeFrontFaceAlpha.value,
        backFaceAlpha: globeBackFaceAlpha.value
      })
    }
  }
}
