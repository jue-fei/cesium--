import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

function createPointRenderState(sourceKind, stressSource) {
  const getPointDataset = () => (sourceKind.value === 'points' ? stressSource.value?.data : null)
  const renderMode = ref('points')
  const renderModeApplying = ref(false)
  const renderModeApplyStatus = ref('')
  const sourceMode = ref('top4')
  const interpolationGridWidth = ref(96)
  const interpolationGridHeight = ref(96)
  const interpolationGridDepth = ref(64)
  const interpolationApplying = ref(false)
  const interpolationApplyStatus = ref('')
  const idwPower = ref(2.0)
  const idwPowerApplying = ref(false)

  return {
    getPointDataset,
    renderMode,
    renderModeApplying,
    renderModeApplyStatus,
    sourceMode,
    interpolationGridWidth,
    interpolationGridHeight,
    interpolationGridDepth,
    interpolationApplying,
    interpolationApplyStatus,
    idwPower,
    idwPowerApplying
  }
}

function createPointRenderComputed({
  sourceKind,
  renderMode,
  renderProgress,
  interpolationGridWidth,
  interpolationGridHeight,
  interpolationGridDepth
}) {
  const isPointMode = computed(() => sourceKind.value === 'points')
  const pointSourceModeOptions = [
    { value: 'full', label: '全点优先' },
    { value: 'top4', label: '性能优先(Top4)' }
  ]
  const isInterpolationMode = computed(
    () => renderMode.value === 'idw' || renderMode.value === 'kriging'
  )
  const interpolationNeedsConfirm = computed(
    () => renderMode.value === 'kriging' && Boolean(renderProgress?.value?.requiresConfirm)
  )
  const interpolationFallbackText = computed(() => {
    const fallbackMode = String(renderProgress?.value?.fallbackMode || '')
    const fallbackReason = String(renderProgress?.value?.fallbackReason || '')
    if (fallbackMode === 'idw') {
      return fallbackReason === 'insufficient_points'
        ? '采样点不足，当前结果已自动回退到 IDW'
        : 'Kriging 训练失败，当前结果已自动回退到 IDW'
    }
    if (fallbackMode === 'points') {
      return '插值场不可用，当前结果已回退到点扩散热力图'
    }
    return ''
  })
  const interpolationGridHint = computed(() => {
    const modeText = renderMode.value === 'kriging' ? 'Kriging' : 'IDW'
    const voxels =
      Math.max(1, Number(interpolationGridWidth.value) || 1) *
      Math.max(1, Number(interpolationGridHeight.value) || 1) *
      Math.max(1, Number(interpolationGridDepth.value) || 1)
    return `当前 ${modeText} 网格：${interpolationGridWidth.value} × ${interpolationGridHeight.value} × ${interpolationGridDepth.value}（体素 ${voxels.toLocaleString()}）`
  })

  return {
    isPointMode,
    pointSourceModeOptions,
    isInterpolationMode,
    interpolationNeedsConfirm,
    interpolationFallbackText,
    interpolationGridHint
  }
}

function setupPointRenderWatchers({
  stressSource,
  sourceKind,
  config,
  renderMode,
  pointRenderModeRef,
  pointSourceMode,
  sourceMode,
  getPointDataset,
  idwPower,
  interpolationGridWidth,
  interpolationGridHeight,
  interpolationGridDepth,
  interpolationGridMaxWidth,
  interpolationGridMaxHeight,
  interpolationGridMaxDepth
}) {
  watch(
    [stressSource, sourceKind],
    () => {
      const pointDataset = getPointDataset()
      const saved = Number(pointDataset?.interpolation?.power)
      if (Number.isFinite(saved) && saved >= 1.0 && saved <= 4.0) {
        idwPower.value = saved
      }
    },
    { immediate: true }
  )

  watch(
    () => pointRenderModeRef?.value,
    next => {
      renderMode.value = next === 'kriging' ? 'kriging' : next === 'idw' ? 'idw' : 'points'
    },
    { immediate: true }
  )

  watch(
    () => pointSourceMode?.value,
    next => {
      sourceMode.value = next === 'full' ? 'full' : 'top4'
    },
    { immediate: true }
  )

  watch(
    [stressSource, sourceKind, config, renderMode],
    () => {
      const pointDataset = getPointDataset()
      const customGrid = Array.isArray(pointDataset?.interpolation?.grid)
        ? pointDataset.interpolation.grid
        : null
      const fieldGrid = config.value?.field?.data?.grid
      const gridWidth = Number(customGrid?.[0] ?? fieldGrid?.width)
      const gridHeight = Number(customGrid?.[1] ?? fieldGrid?.height)
      const gridDepth = Number(customGrid?.[2] ?? fieldGrid?.depth)
      if (Number.isFinite(gridWidth) && gridWidth > 0) {
        interpolationGridWidth.value = Math.max(
          1,
          Math.min(interpolationGridMaxWidth, Math.round(gridWidth))
        )
      }
      if (Number.isFinite(gridHeight) && gridHeight > 0) {
        interpolationGridHeight.value = Math.max(
          1,
          Math.min(interpolationGridMaxHeight, Math.round(gridHeight))
        )
      }
      if (Number.isFinite(gridDepth) && gridDepth > 0) {
        interpolationGridDepth.value = Math.max(
          1,
          Math.min(interpolationGridMaxDepth, Math.round(gridDepth))
        )
      }
    },
    { immediate: true, deep: true }
  )
}

function createPointRenderActions({
  renderMode,
  renderModeApplying,
  renderModeApplyStatus,
  sourceMode,
  interpolationGridWidth,
  interpolationGridHeight,
  interpolationGridDepth,
  interpolationApplying,
  interpolationApplyStatus,
  interpolationGridMaxWidth,
  interpolationGridMaxHeight,
  interpolationGridMaxDepth,
  idwPower,
  idwPowerApplying,
  setPointRenderMode,
  setPointSourceMode,
  setPointInterpolationGrid,
  setInterpolationPower,
  confirmPointInterpolationFinalPass,
  keepPointInterpolationPreview
}) {
  const applyIdwPower = async () => {
    if (!setInterpolationPower) return
    const value = Math.max(1.0, Math.min(4.0, Number(idwPower.value) || 2.0))
    idwPower.value = value
    idwPowerApplying.value = true
    try {
      await setInterpolationPower(value)
    } finally {
      idwPowerApplying.value = false
    }
  }

  const onRenderModeChange = async value => {
    const next = value === 'kriging' ? 'kriging' : value === 'idw' ? 'idw' : 'points'
    if (next === renderMode.value) {
      renderModeApplyStatus.value = '渲染方式未变化'
      ElMessage.info('渲染方式未变化')
      return
    }
    renderModeApplying.value = true
    renderModeApplyStatus.value = '渲染方式切换中...'
    renderMode.value = next
    try {
      await setPointRenderMode(next)
      const label = next === 'kriging' ? '插值(Kriging)' : next === 'idw' ? '插值(IDW)' : '点扩散'
      const text = `渲染方式已切换：${label}`
      renderModeApplyStatus.value = text
      ElMessage.success(text)
    } catch (error) {
      renderModeApplyStatus.value = '渲染方式切换失败'
      ElMessage.error('渲染方式切换失败')
      throw error
    } finally {
      renderModeApplying.value = false
    }
  }

  const onPointSourceModeChange = async value => {
    const next = value === 'top4' ? 'top4' : 'full'
    sourceMode.value = next
    await setPointSourceMode(next)
  }
  const interpolationActions = createInterpolationGridActions({
    interpolationGridWidth,
    interpolationGridHeight,
    interpolationGridDepth,
    interpolationApplying,
    interpolationApplyStatus,
    interpolationGridMaxWidth,
    interpolationGridMaxHeight,
    interpolationGridMaxDepth,
    setPointInterpolationGrid,
    confirmPointInterpolationFinalPass,
    keepPointInterpolationPreview,
    renderModeApplyStatus
  })

  return {
    applyIdwPower,
    onRenderModeChange,
    onPointSourceModeChange,
    ...interpolationActions
  }
}

function createInterpolationGridActions({
  interpolationGridWidth,
  interpolationGridHeight,
  interpolationGridDepth,
  interpolationApplying,
  interpolationApplyStatus,
  interpolationGridMaxWidth,
  interpolationGridMaxHeight,
  interpolationGridMaxDepth,
  setPointInterpolationGrid,
  confirmPointInterpolationFinalPass,
  keepPointInterpolationPreview,
  renderModeApplyStatus
}) {
  const applyGrid = async () => {
    const result = await setPointInterpolationGrid(
      interpolationGridWidth.value,
      interpolationGridHeight.value,
      interpolationGridDepth.value
    )
    if (result?.changed) {
      const text = `插值网格已应用：${interpolationGridWidth.value} × ${interpolationGridHeight.value} × ${interpolationGridDepth.value}`
      interpolationApplyStatus.value = text
      ElMessage.success(text)
      return
    }
    interpolationApplyStatus.value = '插值网格参数未变化'
    ElMessage.info('插值网格参数未变化')
  }
  const runInterpolationApply = async applyAction => {
    interpolationApplying.value = true
    interpolationApplyStatus.value = '插值网格应用中...'
    try {
      await applyAction()
    } catch (error) {
      interpolationApplyStatus.value = '插值网格应用失败'
      ElMessage.error('插值网格应用失败')
      throw error
    } finally {
      interpolationApplying.value = false
    }
  }

  const applyInterpolationGrid = async nextGrid => {
    if (!Array.isArray(nextGrid) || nextGrid.length < 3) return
    interpolationGridWidth.value = nextGrid[0]
    interpolationGridHeight.value = nextGrid[1]
    interpolationGridDepth.value = nextGrid[2]
    await runInterpolationApply(applyGrid)
  }
  const onApplyInterpolationGrid = async () => {
    const width = Number(interpolationGridWidth.value) || 1
    const height = Number(interpolationGridHeight.value) || 1
    const depth = Number(interpolationGridDepth.value) || 1
    await applyInterpolationGrid([
      Math.max(1, Math.min(interpolationGridMaxWidth, Math.round(width))),
      Math.max(1, Math.min(interpolationGridMaxHeight, Math.round(height))),
      Math.max(1, Math.min(interpolationGridMaxDepth, Math.round(depth)))
    ])
  }
  const onApplyInterpolationGridPreset = async (key, interpolationGridPresets) => {
    const preset = interpolationGridPresets.find(item => item.key === key)
    if (!preset) return
    await applyInterpolationGrid(preset.grid)
  }
  const onConfirmInterpolationFinalPass = async () => {
    try {
      renderModeApplyStatus.value = 'Kriging 精细场生成中...'
      const ok = await confirmPointInterpolationFinalPass()
      if (ok) {
        const text = 'Kriging 精细场已生成'
        renderModeApplyStatus.value = text
        ElMessage.success(text)
        return
      }
      renderModeApplyStatus.value = '当前没有待确认的精细计算任务'
      ElMessage.info('当前没有待确认的精细计算任务')
    } catch (error) {
      renderModeApplyStatus.value = 'Kriging 精细场生成失败'
      ElMessage.error('Kriging 精细场生成失败')
      throw error
    }
  }
  const onKeepInterpolationPreview = () => {
    const kept = keepPointInterpolationPreview()
    if (!kept) {
      ElMessage.info('当前没有待保留的预览结果')
      return
    }
    renderModeApplyStatus.value = '已保留 Kriging 预览结果'
    ElMessage.success('已保留 Kriging 预览结果')
  }

  return {
    onApplyInterpolationGrid,
    onApplyInterpolationGridPreset,
    onConfirmInterpolationFinalPass,
    onKeepInterpolationPreview
  }
}

export function useStressPanelPointRender({
  stressSource,
  sourceKind,
  config,
  renderProgress,
  pointRenderModeRef,
  pointSourceMode,
  setPointRenderMode,
  setPointSourceMode,
  setPointInterpolationGrid,
  setInterpolationPower,
  confirmPointInterpolationFinalPass,
  keepPointInterpolationPreview
}) {
  const state = createPointRenderState(sourceKind, stressSource)
  const interpolationGridMaxWidth = 160
  const interpolationGridMaxHeight = 160
  const interpolationGridMaxDepth = 96
  const interpolationGridPresets = [
    { key: 'balanced', label: '均衡 96×96×64', grid: [96, 96, 64] },
    { key: 'clear', label: '清晰 128×128×80', grid: [128, 128, 80] },
    { key: 'ultra', label: '超清 160×160×96', grid: [160, 160, 96] }
  ]
  const computedState = createPointRenderComputed({
    sourceKind,
    renderMode: state.renderMode,
    renderProgress,
    interpolationGridWidth: state.interpolationGridWidth,
    interpolationGridHeight: state.interpolationGridHeight,
    interpolationGridDepth: state.interpolationGridDepth
  })
  setupPointRenderWatchers({
    stressSource,
    sourceKind,
    config,
    renderMode: state.renderMode,
    pointRenderModeRef,
    pointSourceMode,
    sourceMode: state.sourceMode,
    getPointDataset: state.getPointDataset,
    idwPower: state.idwPower,
    interpolationGridWidth: state.interpolationGridWidth,
    interpolationGridHeight: state.interpolationGridHeight,
    interpolationGridDepth: state.interpolationGridDepth,
    interpolationGridMaxWidth,
    interpolationGridMaxHeight,
    interpolationGridMaxDepth
  })
  const pointRenderActions = createPointRenderActions({
    renderMode: state.renderMode,
    renderModeApplying: state.renderModeApplying,
    renderModeApplyStatus: state.renderModeApplyStatus,
    sourceMode: state.sourceMode,
    interpolationGridWidth: state.interpolationGridWidth,
    interpolationGridHeight: state.interpolationGridHeight,
    interpolationGridDepth: state.interpolationGridDepth,
    interpolationApplying: state.interpolationApplying,
    interpolationApplyStatus: state.interpolationApplyStatus,
    interpolationGridMaxWidth,
    interpolationGridMaxHeight,
    interpolationGridMaxDepth,
    idwPower: state.idwPower,
    idwPowerApplying: state.idwPowerApplying,
    setPointRenderMode,
    setPointSourceMode,
    setPointInterpolationGrid,
    setInterpolationPower,
    confirmPointInterpolationFinalPass,
    keepPointInterpolationPreview
  })

  return {
    isPointMode: computedState.isPointMode,
    renderMode: state.renderMode,
    renderModeApplying: state.renderModeApplying,
    renderModeApplyStatus: state.renderModeApplyStatus,
    onRenderModeChange: pointRenderActions.onRenderModeChange,
    sourceMode: state.sourceMode,
    pointSourceModeOptions: computedState.pointSourceModeOptions,
    onPointSourceModeChange: pointRenderActions.onPointSourceModeChange,
    isInterpolationMode: computedState.isInterpolationMode,
    interpolationGridWidth: state.interpolationGridWidth,
    interpolationGridHeight: state.interpolationGridHeight,
    interpolationGridDepth: state.interpolationGridDepth,
    interpolationApplying: state.interpolationApplying,
    interpolationApplyStatus: state.interpolationApplyStatus,
    interpolationGridMaxWidth,
    interpolationGridMaxHeight,
    interpolationGridMaxDepth,
    interpolationGridPresets,
    interpolationGridHint: computedState.interpolationGridHint,
    interpolationNeedsConfirm: computedState.interpolationNeedsConfirm,
    interpolationFallbackText: computedState.interpolationFallbackText,
    onApplyInterpolationGrid: pointRenderActions.onApplyInterpolationGrid,
    onApplyInterpolationGridPreset: key =>
      pointRenderActions.onApplyInterpolationGridPreset(key, interpolationGridPresets),
    onConfirmInterpolationFinalPass: pointRenderActions.onConfirmInterpolationFinalPass,
    onKeepInterpolationPreview: pointRenderActions.onKeepInterpolationPreview,
    idwPower: state.idwPower,
    idwPowerApplying: state.idwPowerApplying,
    applyIdwPower: pointRenderActions.applyIdwPower
  }
}
