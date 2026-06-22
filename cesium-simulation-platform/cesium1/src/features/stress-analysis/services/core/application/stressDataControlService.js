import { applyHeatmapDisplayToConfigObject, normalizeHeatmapDisplay } from '../render/index.js'
import { resolvePointRenderMode, resolvePointSourceStrategy } from '../shared/stressActionShared.js'
import { clampInt } from '../shared/stressMathUtils.js'
import { resolveColormapRamp } from '../../panel/stressHeatmapPanelState.js'

function applyRebuildResult(ctx, rebuilt) {
  if (rebuilt === false) return false
  ctx.applyToModel()
  ctx.recordHistory?.()
  return true
}

function mergeHeatmapDisplay(curr, next) {
  const resolveNumber = key =>
    Number.isFinite(Number(next?.[key])) ? Number(next[key]) : curr[key]
  const resolveBoolean = key => (next?.[key] !== undefined ? Boolean(next[key]) : curr[key])
  const resolveString = (key, fallback) =>
    next?.[key] !== undefined ? String(next[key] || fallback) : curr[key]
  return {
    contrast: resolveNumber('contrast'),
    gamma: resolveNumber('gamma'),
    cutoff: resolveNumber('cutoff'),
    lowRangeOpacity: resolveNumber('lowRangeOpacity'),
    forceVisible: resolveNumber('forceVisible'),
    diffuseMix: resolveNumber('diffuseMix'),
    emissiveMix: resolveNumber('emissiveMix'),
    anchorToModel: resolveBoolean('anchorToModel'),
    blendMode: resolveString('blendMode', 'max'),
    maskMode: resolveString('maskMode', 'none'),
    enableContour: resolveBoolean('enableContour'),
    enableGlow: resolveBoolean('enableGlow'),
    enableMarker: resolveBoolean('enableMarker'),
    colormapPreset: next?.colormapPreset || curr.colormapPreset || 'turbo32'
  }
}

function createPointInterpolationMutators(getPointDataset, rebuildConfig, recordHistory) {
  const updateInterpolation = async (key, value, payloadBuilder) => {
    const pd = getPointDataset()
    if (!pd) return payloadBuilder(false)
    const hasInterpolationObject = pd.interpolation && typeof pd.interpolation === 'object'
    const interpolation = hasInterpolationObject ? { ...pd.interpolation } : {}
    interpolation[key] = value
    pd.interpolation = interpolation
    const mode = String(pd.renderMode || 'points')
    const payload = payloadBuilder(true, value)
    if (mode === 'idw' || mode === 'kriging') {
      const rebuilt = await rebuildConfig()
      return { ...payload, applied: rebuilt !== false }
    }
    recordHistory?.()
    return { ...payload, applied: false }
  }

  return { updateInterpolation }
}

function createMaterialSetter(ctx, getGridDataset, rebuildConfigFromDataset, applyRebuild) {
  let pendingMaterialTimer = null
  return async (nextE, nextNu) => {
    const ds = getGridDataset()
    if (!ds) return
    const e = Number(nextE)
    const nu = Number(nextNu)
    if (!(e > 0) || !Number.isFinite(e)) return ctx.showMessage('弹性模量E 必须为正数', 'error')
    if (!Number.isFinite(nu) || nu <= -0.999 || nu >= 0.499) {
      return ctx.showMessage('泊松比nu 取值范围应为 (-1, 0.5)', 'error')
    }
    ds.material.E = e
    ds.material.nu = nu
    ctx.materialE.value = e
    ctx.materialNu.value = nu
    ctx.cachedScalarFields.clear()
    ctx.resetPick()
    if (pendingMaterialTimer) clearTimeout(pendingMaterialTimer)
    pendingMaterialTimer = setTimeout(async () => {
      pendingMaterialTimer = null
      applyRebuild(await rebuildConfigFromDataset())
    }, 120)
  }
}

function createHeatmapDisplaySetter(ctx) {
  return async next => {
    const curr = ctx.heatmapDisplay.value || {}
    const merged = mergeHeatmapDisplay(curr, next)
    const normalized = normalizeHeatmapDisplay(merged)
    ctx.heatmapDisplay.value = { ...normalized, colormapPreset: merged.colormapPreset }
    const rampInput =
      merged.colormapPreset && merged.colormapPreset !== (curr.colormapPreset || 'turbo32')
        ? resolveColormapRamp(merged.colormapPreset)
        : ctx.heatmapBaseRamp.value
    ctx.heatmapBaseRamp.value = applyHeatmapDisplayToConfigObject(
      ctx.config.value,
      rampInput,
      normalized
    ).baseRamp
    ctx.applyToModel()
    ctx.recordHistory?.()
  }
}

export function createStressDataControlService(ctx, rebuilders) {
  const { rebuildConfig, rebuildConfigFromDataset } = rebuilders
  const getPointDataset = () =>
    ctx.stressSource.value.kind === 'points' ? ctx.stressSource.value.data : null
  const getGridDataset = () =>
    ctx.stressSource.value.kind === 'grid' ? ctx.stressSource.value.data : null
  const applyRebuild = rebuilt => applyRebuildResult(ctx, rebuilt)
  const updatePointSetting = async (key, rawValue, resolve, syncRef) => {
    const pd = getPointDataset()
    if (!pd) return false
    const next = resolve(rawValue)
    const current =
      key === 'sourceStrategy' ? String(pd[key] || 'top4') : String(pd[key] || 'points')
    if (current === next) return false
    pd[key] = next
    if (syncRef) syncRef.value = next
    return applyRebuild(await rebuildConfig())
  }
  const { updateInterpolation } = createPointInterpolationMutators(
    getPointDataset,
    rebuildConfig,
    ctx.recordHistory
  )
  const setMaterial = createMaterialSetter(
    ctx,
    getGridDataset,
    rebuildConfigFromDataset,
    applyRebuild
  )

  const setMetric = async nextMetric => {
    ctx.metric.value = nextMetric
    ctx.resetPick()
    applyRebuild(await rebuildConfig())
  }

  const setDirection = async (azimuthDeg, dipDeg) => {
    ctx.directionAzimuth.value = Number(azimuthDeg) || 0
    ctx.directionDip.value = Number(dipDeg) || 0
    const effective = ctx.metric.value === 'snn' || ctx.metric.value === 'tau_n'
    if (!effective) return
    ctx.resetPick()
    applyRebuild(await rebuildConfig())
  }

  const setHeatmapDisplay = createHeatmapDisplaySetter(ctx)

  const setPointRenderMode = async mode => {
    await updatePointSetting('renderMode', mode, resolvePointRenderMode, ctx.pointRenderMode)
  }

  const setPointSourceStrategy = async strategy => {
    await updatePointSetting(
      'sourceStrategy',
      strategy,
      resolvePointSourceStrategy,
      ctx.pointSourceMode
    )
  }

  const setPointInterpolationGrid = async (width, height, depth) => {
    const pd = getPointDataset()
    if (!pd) return { changed: false, applied: false }
    const nextGrid = [clampInt(width, 1, 160), clampInt(height, 1, 160), clampInt(depth, 1, 96)]
    const current = Array.isArray(pd?.interpolation?.grid) ? pd.interpolation.grid : null
    const same =
      Array.isArray(current) &&
      current.length >= 3 &&
      Number(current[0]) === nextGrid[0] &&
      Number(current[1]) === nextGrid[1] &&
      Number(current[2]) === nextGrid[2]
    if (same) return { changed: false, applied: false, grid: nextGrid }
    const result = await updateInterpolation('grid', nextGrid, (changed, grid) => ({
      changed,
      applied: false,
      grid
    }))
    if (result.applied) ctx.applyToModel()
    return result
  }

  const setInterpolationPower = async powerVal => {
    const pd = getPointDataset()
    if (!pd) return { changed: false }
    const power = Math.max(1.0, Math.min(4.0, Number(powerVal) || 2.0))
    const current = Number(pd?.interpolation?.power)
    if (current === power) return { changed: false, power }
    const result = await updateInterpolation('power', power, (changed, value) => ({
      changed,
      applied: false,
      power: value
    }))
    if (result.applied) ctx.applyToModel()
    return result
  }

  return {
    setDirection,
    setHeatmapDisplay,
    setMaterial,
    setMetric,
    setPointRenderMode,
    setPointSourceStrategy,
    setPointInterpolationGrid,
    setInterpolationPower
  }
}
