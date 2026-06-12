import {
  applyHeatmapDisplayToConfigObject,
  cloneColorRamp,
  normalizeHeatmapDisplay
} from '../render/index.js'
import { resolvePointRenderMode, resolvePointSourceStrategy } from '../shared/stressActionShared.js'
import { clampInt } from '../shared/stressMathUtils.js'
import { resolveColormapRamp } from '../../panel/stressHeatmapPanelState.js'

export function createStressDataControlService(ctx, rebuilders) {
  const { rebuildConfig, rebuildConfigFromDataset } = rebuilders
  const getPointDataset = () =>
    ctx.stressSource.value.kind === 'points' ? ctx.stressSource.value.data : null
  const getGridDataset = () =>
    ctx.stressSource.value.kind === 'grid' ? ctx.stressSource.value.data : null
  const applyRebuildResult = rebuilt => {
    if (rebuilt === false) return false
    ctx.applyToModel()
    ctx.recordHistory?.()
    return true
  }
  const updatePointSetting = async (key, rawValue, resolve, syncRef) => {
    const pd = getPointDataset()
    if (!pd) return false
    const next = resolve(rawValue)
    const current =
      key === 'sourceStrategy' ? String(pd[key] || 'top4') : String(pd[key] || 'points')
    if (current === next) return false
    pd[key] = next
    if (syncRef) syncRef.value = next
    return applyRebuildResult(await rebuildConfig())
  }

  let pendingMaterialTimer = null
  const setMaterial = async (nextE, nextNu) => {
    const ds = getGridDataset()
    if (!ds) return
    const e = Number(nextE)
    const nu = Number(nextNu)
    if (!(e > 0) || !Number.isFinite(e)) return ctx.showMessage('弹性模量E 必须为正数', 'error')
    if (!Number.isFinite(nu) || nu <= -0.999 || nu >= 0.499)
      return ctx.showMessage('泊松比nu 取值范围应为 (-1, 0.5)', 'error')
    ds.material.E = e
    ds.material.nu = nu
    ctx.materialE.value = e
    ctx.materialNu.value = nu
    ctx.cachedScalarFields.clear()
    ctx.resetPick()
    if (pendingMaterialTimer) clearTimeout(pendingMaterialTimer)
    pendingMaterialTimer = setTimeout(async () => {
      pendingMaterialTimer = null
      applyRebuildResult(await rebuildConfigFromDataset())
    }, 120)
  }

  const setMetric = async nextMetric => {
    ctx.metric.value = nextMetric
    ctx.resetPick()
    applyRebuildResult(await rebuildConfig())
  }

  const setDirection = async (azimuthDeg, dipDeg) => {
    ctx.directionAzimuth.value = Number(azimuthDeg) || 0
    ctx.directionDip.value = Number(dipDeg) || 0
    const effective = ctx.metric.value === 'snn' || ctx.metric.value === 'tau_n'
    if (!effective) return
    ctx.resetPick()
    applyRebuildResult(await rebuildConfig())
  }

  const setHeatmapDisplay = async next => {
    const curr = ctx.heatmapDisplay.value || {}
    const merged = {
      contrast: Number.isFinite(Number(next?.contrast)) ? Number(next.contrast) : curr.contrast,
      gamma: Number.isFinite(Number(next?.gamma)) ? Number(next.gamma) : curr.gamma,
      cutoff: Number.isFinite(Number(next?.cutoff)) ? Number(next.cutoff) : curr.cutoff,
      lowRangeOpacity: Number.isFinite(Number(next?.lowRangeOpacity))
        ? Number(next.lowRangeOpacity)
        : curr.lowRangeOpacity,
      forceVisible: Number.isFinite(Number(next?.forceVisible))
        ? Number(next.forceVisible)
        : curr.forceVisible,
      diffuseMix: Number.isFinite(Number(next?.diffuseMix))
        ? Number(next.diffuseMix)
        : curr.diffuseMix,
      emissiveMix: Number.isFinite(Number(next?.emissiveMix))
        ? Number(next.emissiveMix)
        : curr.emissiveMix,
      anchorToModel:
        next?.anchorToModel !== undefined ? Boolean(next.anchorToModel) : curr.anchorToModel,
      blendMode: next?.blendMode !== undefined ? String(next.blendMode || 'max') : curr.blendMode,
      maskMode: next?.maskMode !== undefined ? String(next.maskMode || 'none') : curr.maskMode,
      enableContour:
        next?.enableContour !== undefined ? Boolean(next.enableContour) : curr.enableContour,
      enableGlow: next?.enableGlow !== undefined ? Boolean(next.enableGlow) : curr.enableGlow,
      enableMarker:
        next?.enableMarker !== undefined ? Boolean(next.enableMarker) : curr.enableMarker,
      colormapPreset: next?.colormapPreset || curr.colormapPreset || 'turbo32'
    }
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
    const hasInterpolationObject = pd.interpolation && typeof pd.interpolation === 'object'
    const interpolation = hasInterpolationObject ? { ...pd.interpolation } : {}
    interpolation.grid = nextGrid
    pd.interpolation = interpolation
    const mode = String(pd.renderMode || 'points')
    if (mode === 'idw' || mode === 'kriging') {
      return { changed: true, applied: applyRebuildResult(await rebuildConfig()), grid: nextGrid }
    }
    ctx.recordHistory?.()
    return { changed: true, applied: false, grid: nextGrid }
  }

  const setInterpolationPower = async powerVal => {
    const pd = getPointDataset()
    if (!pd) return { changed: false }
    const power = Math.max(1.0, Math.min(4.0, Number(powerVal) || 2.0))
    const current = Number(pd?.interpolation?.power)
    if (current === power) return { changed: false, power }
    const hasInterpolationObject = pd.interpolation && typeof pd.interpolation === 'object'
    const interpolation = hasInterpolationObject ? { ...pd.interpolation } : {}
    interpolation.power = power
    pd.interpolation = interpolation
    const mode = String(pd.renderMode || 'points')
    if (mode === 'idw' || mode === 'kriging') {
      return { changed: true, applied: applyRebuildResult(await rebuildConfig()), power }
    }
    ctx.recordHistory?.()
    return { changed: true, applied: false, power }
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
