import { flyToUndergroundView } from './undergroundView.js'
import { surfaceAnchorLocal } from './modelTransform.js'

export function applyUndergroundView({
  undergroundViewController,
  tilesetRef,
  globeFrontFaceAlpha,
  globeBackFaceAlpha,
  enabled
}) {
  undergroundViewController.apply({
    tileset: tilesetRef.value,
    enabled: !!enabled,
    frontFaceAlphaPercent: globeFrontFaceAlpha.value,
    backFaceAlphaPercent: globeBackFaceAlpha.value
  })
}

export function syncUndergroundViewIfNeeded({
  undergroundViewEnabled,
  tilesetRef,
  undergroundViewController,
  globeFrontFaceAlpha,
  globeBackFaceAlpha
}) {
  if (!undergroundViewEnabled.value || !tilesetRef.value) return
  applyUndergroundView({
    undergroundViewController,
    tilesetRef,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    enabled: true
  })
}

export function setUndergroundViewEnabled({
  undergroundViewEnabled,
  undergroundViewController,
  tilesetRef,
  globeFrontFaceAlpha,
  globeBackFaceAlpha,
  enabled
}) {
  undergroundViewEnabled.value = !!enabled
  applyUndergroundView({
    undergroundViewController,
    tilesetRef,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    enabled: undergroundViewEnabled.value
  })
}

export function updateGlobeTranslucency({
  globeFrontFaceAlpha,
  globeBackFaceAlpha,
  undergroundViewEnabled,
  undergroundViewController,
  tilesetRef,
  frontFaceAlpha,
  backFaceAlpha
}) {
  if (typeof frontFaceAlpha === 'number') globeFrontFaceAlpha.value = frontFaceAlpha
  if (typeof backFaceAlpha === 'number') globeBackFaceAlpha.value = backFaceAlpha
  if (!undergroundViewEnabled.value) return
  applyUndergroundView({
    undergroundViewController,
    tilesetRef,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    enabled: true
  })
}

export function enterUndergroundView({
  getViewer,
  tilesetRef,
  undergroundViewEnabled,
  undergroundViewController,
  globeFrontFaceAlpha,
  globeBackFaceAlpha
}) {
  const viewer = getViewer()
  if (!viewer || !tilesetRef.value) return
  if (!undergroundViewEnabled.value) undergroundViewEnabled.value = true
  applyUndergroundView({
    undergroundViewController,
    tilesetRef,
    globeFrontFaceAlpha,
    globeBackFaceAlpha,
    enabled: true
  })
  flyToUndergroundView(viewer, tilesetRef.value, 0.8)
}

export async function resetView(tilesetRef, resetViewToModel) {
  if (tilesetRef.value) await resetViewToModel(tilesetRef.value)
}

function applyCurrentTransform({ applyModelTransform, tilesetRef, runtimeState, modelPosition }) {
  applyModelTransform(
    tilesetRef.value,
    runtimeState.originalModelMatrix,
    modelPosition.value,
    runtimeState.currentTransform,
    runtimeState.originalBoundingSphereCenter
  )
}

export function resetModel({
  tilesetRef,
  runtimeState,
  measurement,
  applyModelTransform,
  modelPosition,
  modelTransform,
  defaultPosition,
  defaultTransform,
  syncUndergroundViewIfNeeded,
  showOperationMessage
}) {
  if (!tilesetRef.value || !runtimeState.originalModelMatrix) return
  measurement.clearHistoryVisualization()

  // 自带地表锚点的模型（阿舍勒聚合 tileset）：
  // 重置目标 = 加载时的初始锚点（而不是 demo 的 DEFAULT_POSITION——
  // 那会把相对偏移算出 -878m，模型直接坠回原点）。
  if (surfaceAnchorLocal(tilesetRef.value) && runtimeState.initialPosition) {
    const resetPosition = { ...runtimeState.initialPosition }
    const resetTransform = { rotationX: 0, rotationY: 0, rotationZ: 0 }
    applyModelTransform(
      tilesetRef.value,
      runtimeState.originalModelMatrix,
      resetPosition,
      resetTransform,
      runtimeState.originalBoundingSphereCenter
    )
    runtimeState.currentTransform = { ...resetTransform }
    modelPosition.value = resetPosition
    modelTransform.value = { ...resetTransform }
    syncUndergroundViewIfNeeded()
    showOperationMessage('模型已重置到初始位置', 'success')
    return
  }

  applyModelTransform(
    tilesetRef.value,
    runtimeState.originalModelMatrix,
    { ...defaultPosition },
    { ...defaultTransform },
    runtimeState.originalBoundingSphereCenter
  )
  runtimeState.currentTransform = { ...defaultTransform }
  modelPosition.value = { ...defaultPosition }
  modelTransform.value = { ...defaultTransform }
  syncUndergroundViewIfNeeded()
  showOperationMessage('模型已重置到初始位置', 'success')
}

export function updatePosition({
  tilesetRef,
  runtimeState,
  measurement,
  modelPosition,
  applyModelTransform,
  syncUndergroundViewIfNeeded,
  newPosition
}) {
  if (!tilesetRef.value || !runtimeState.originalModelMatrix) return
  measurement.clearHistoryVisualization()
  modelPosition.value = { ...modelPosition.value, ...newPosition }
  applyCurrentTransform({
    applyModelTransform,
    tilesetRef,
    runtimeState,
    modelPosition
  })
  syncUndergroundViewIfNeeded()
}

export function updateTransform({
  tilesetRef,
  runtimeState,
  measurement,
  modelPosition,
  modelTransform,
  applyModelTransform,
  syncUndergroundViewIfNeeded,
  newTransform
}) {
  if (!tilesetRef.value || !runtimeState.originalModelMatrix) return
  measurement.clearHistoryVisualization()
  modelTransform.value = { ...modelTransform.value, ...newTransform }
  runtimeState.currentTransform = { ...newTransform }
  applyCurrentTransform({
    applyModelTransform,
    tilesetRef,
    runtimeState,
    modelPosition,
    modelTransform
  })
  syncUndergroundViewIfNeeded()
}
