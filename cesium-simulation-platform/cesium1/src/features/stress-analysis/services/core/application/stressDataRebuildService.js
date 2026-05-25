import {
  applyHeatmapDisplayToConfigObject,
  buildCacheKey,
  buildDefaultStressConfig,
  buildHeatmapConfigFromPointDataset,
  buildShaderConfigFromScalarField,
  cloneColorRamp,
  computeRadiusScaleFactor,
  resolveModelCoverSize,
  resolveOriginFromModelCenter,
  resolveOriginFromViewer
} from '../render/index.js'
import { computeScalarField } from '../computation/index.js'
import {
  buildInterpolatedScalarFieldFromPointDatasetAsync,
  buildRenderablePointsFromPointDataset
} from '../data/index.js'
import { resolveDefaultGrid } from '../interpolation/index.js'
import {
  resolvePointSourceStrategy,
  buildDirectionSignature,
  buildOverlaySignature
} from '../shared/stressActionShared.js'
import { buildSafetyColorRamp, isSafetyMetric } from '../safety/index.js'

export function createStressDataRebuildService(ctx) {
  let pointRebuildToken = 0
  let pendingPointInterpolationFinalPass = null
  const defaultInterpolationCacheTtlMs = 120000
  const getPointDataset = () =>
    ctx.stressSource?.value?.kind === 'points' ? ctx.stressSource.value.data : null
  const getGridDataset = () =>
    ctx.stressSource?.value?.kind === 'grid' ? ctx.stressSource.value.data : null
  const syncHeatmapDisplay = () => {
    ctx.heatmapBaseRamp.value = cloneColorRamp(ctx.config.value?.colorRamp)
    ctx.heatmapBaseRamp.value = applyHeatmapDisplayToConfigObject(
      ctx.config.value,
      ctx.heatmapBaseRamp.value,
      ctx.heatmapDisplay.value
    ).baseRamp
  }
  const applySafetyPaletteIfNeeded = config => {
    if (!config || !isSafetyMetric(ctx.metric.value)) return config
    config.colorRamp = buildSafetyColorRamp()
    return config
  }

  const resolveInterpolationFieldSize = pd => {
    const baseSize = Array.isArray(pd?.size) && pd.size.length >= 3 ? pd.size : [200, 200, 100]
    const points = Array.isArray(pd?.points) ? pd.points : []
    const hasUVWPoint = points.some(point => String(point?.coordMode || '') === 'UVW')
    if (hasUVWPoint) return baseSize
    const coverSize = resolveModelCoverSize(ctx.tileset.value, baseSize)
    return Array.isArray(coverSize) && coverSize.length >= 3 ? coverSize : baseSize
  }

  const getPointInterpolationDatasetCache = dataset => {
    if (!dataset || typeof dataset !== 'object' || !ctx.cachedPointInterpolationFields) return null
    let cache = ctx.cachedPointInterpolationFields.get(dataset)
    if (!cache) {
      cache = new Map()
      ctx.cachedPointInterpolationFields.set(dataset, cache)
    }
    return cache
  }

  const buildPointInterpolationCacheKey = (
    dataset,
    metricKey,
    direction,
    overlayItems,
    options = {}
  ) => {
    const grid = Array.isArray(options.grid) ? options.grid.slice(0, 3) : []
    const gridKey = grid.map(v => Math.max(1, Math.round(Number(v) || 1))).join('x')
    const method = String(options.method || dataset?.renderMode || 'idw')
    const power = Number.isFinite(Number(options.power)) ? Number(options.power) : 1.6
    const radius =
      Number.isFinite(Number(options.radius)) && Number(options.radius) >= 0
        ? Number(options.radius)
        : 'inf'
    const maxPoints = Number.isFinite(Number(options.maxPoints))
      ? Math.floor(Number(options.maxPoints))
      : ''
    const frames = Math.max(1, Number(dataset?.time?.frames) || 1)
    const fitMode = String(options.fitMode || (frames > 1 ? 'mean' : 'first'))
    const model = String(options.model || 'exponential')
    const sigma2 = Number.isFinite(Number(options.sigma2)) ? Number(options.sigma2) : 1e-6
    const neighborCount =
      Number.isFinite(Number(options.neighborCount)) || Number.isFinite(Number(options.neighbors))
        ? Math.floor(Number(options.neighborCount ?? options.neighbors))
        : ''
    const hotspotRatio = Number.isFinite(Number(options.hotspotRatio))
      ? Number(options.hotspotRatio)
      : ''
    const stressRef = Number(dataset?.algo?.stressRef) || 1
    return [
      String(metricKey || 'von_mises'),
      buildDirectionSignature(direction),
      buildOverlaySignature(overlayItems),
      stressRef,
      method,
      gridKey,
      power,
      radius,
      maxPoints,
      neighborCount,
      hotspotRatio,
      fitMode,
      model,
      sigma2
    ].join('::')
  }

  const getCachedPointInterpolationField = (dataset, cacheKey) => {
    const cache = getPointInterpolationDatasetCache(dataset)
    if (!cache || !cacheKey) return null
    const now = Date.now()
    for (const [key, entry] of cache.entries()) {
      const expiresAt = Number(entry?.expiresAt) || 0
      if (expiresAt > 0 && expiresAt <= now) cache.delete(key)
    }
    const cached = cache.get(cacheKey)
    if (!cached || !cached.field) return null
    return cached.field
  }

  const setCachedPointInterpolationField = (dataset, cacheKey, field, ttlMs) => {
    if (!field || !cacheKey) return
    const cache = getPointInterpolationDatasetCache(dataset)
    if (!cache) return
    const ttl = Math.max(1000, Number(ttlMs) || defaultInterpolationCacheTtlMs)
    cache.set(cacheKey, {
      field,
      expiresAt: Date.now() + ttl
    })
  }

  const clearPendingPointInterpolationFinalPass = () => {
    pendingPointInterpolationFinalPass = null
  }

  const keepPointInterpolationPreview = () => {
    if (!pendingPointInterpolationFinalPass) return false
    clearPendingPointInterpolationFinalPass()
    if (typeof ctx.setRenderProgress === 'function') {
      ctx.setRenderProgress({
        active: false,
        phase: 'preview_kept',
        requiresConfirm: false,
        text: '已保留 Kriging 预览结果，可继续调整参数或重新生成',
        fallbackMode: '',
        fallbackReason: ''
      })
    }
    return true
  }

  const confirmPointInterpolationFinalPass = async () => {
    const task = pendingPointInterpolationFinalPass
    if (!task || typeof task.run !== 'function') return false
    clearPendingPointInterpolationFinalPass()
    return task.run()
  }

  const rebuildConfigFromPointDataset = async () => {
    const pd = getPointDataset()
    if (!pd) return false
    const rebuildToken = ++pointRebuildToken
    clearPendingPointInterpolationFinalPass()
    if (!pd || !Array.isArray(pd.points) || pd.points.length < 1) {
      ctx.config.value = buildDefaultStressConfig()
      if (typeof ctx.setRenderProgress === 'function') {
        ctx.setRenderProgress({
          active: false,
          percent: 0,
          text: '当前裁剪范围内无可用应力采样点',
          phase: 'idle',
          requiresConfirm: false,
          fallbackMode: '',
          fallbackReason: ''
        })
      }
      return true
    }
    let origin = pd.origin
    if (pd.originMode === '模型中心') {
      const resolved = resolveOriginFromModelCenter(ctx.tileset.value)
      if (resolved) origin = resolved
      else origin = resolveOriginFromViewer(ctx.viewer.value)
    }
    if (!origin) {
      ctx.config.value = buildDefaultStressConfig()
      ctx.stressDebugLog('rebuild:point_source_failed', {
        reason: 'origin_not_resolved',
        originMode: pd.originMode,
        originProvided: pd.origin,
        hasTileset: Boolean(ctx.tileset.value),
        hasViewer: Boolean(ctx.viewer.value)
      })
      return true
    }
    const scale = computeRadiusScaleFactor(ctx.tileset.value, pd.size)
    const direction = { azimuthDeg: ctx.directionAzimuth.value, dipDeg: ctx.directionDip.value }
    const mode = String(pd.renderMode || 'points')
    const interpolationFieldSize =
      mode === 'idw' || mode === 'kriging' ? resolveInterpolationFieldSize(pd) : pd.size
    let hasDeferredFinalPass = false
    const updateProgress = (percent, text, active = true) => {
      if (rebuildToken !== pointRebuildToken) return false
      if (typeof ctx.setRenderProgress === 'function') {
        ctx.setRenderProgress({ active, percent, text })
      }
      return true
    }
    const sourceStrategy = resolvePointSourceStrategy(pd)
    const pointsForFallback = () =>
      buildRenderablePointsFromPointDataset(pd, ctx.metric.value, direction, ctx.overlayItems.value)
    const buildPointFieldConfig = field => {
      if (!field) {
        return buildHeatmapConfigFromPointDataset(
          { ...pd, origin, points: pointsForFallback() },
          { radiusScaleFactor: scale, tileset: ctx.tileset.value, sourceStrategy }
        )
      }
      const base = buildHeatmapConfigFromPointDataset(
        { ...pd, origin, points: pointsForFallback() },
        { radiusScaleFactor: scale, tileset: ctx.tileset.value, sourceStrategy }
      )
      base.sources = []
      if (base.style) {
        base.style.fieldMaskMode = 'none'
      }
      base.field = {
        type: 'grid',
        combine: 'replace',
        data: {
          grid: field.grid,
          origin,
          size:
            Array.isArray(interpolationFieldSize) && interpolationFieldSize.length >= 3
              ? interpolationFieldSize
              : [200, 200, 100],
          frames: field.frames,
          valueRange: field.valueRange,
          timePoints: field.timePoints,
          metric: String(ctx.metric.value || ''),
          unitStress: ctx.unitStress.value
        }
      }
      return applySafetyPaletteIfNeeded(base)
    }
    const resolveInterpolationField = async (options, stage) => {
      const cacheKey = buildPointInterpolationCacheKey(
        pd,
        ctx.metric.value,
        direction,
        ctx.overlayItems.value,
        options
      )
      const cachedField = getCachedPointInterpolationField(pd, cacheKey)
      if (cachedField) {
        return { field: cachedField, cacheHit: true }
      }
      const field = await buildInterpolatedScalarFieldFromPointDatasetAsync(
        { ...pd, size: interpolationFieldSize },
        ctx.metric.value,
        direction,
        ctx.overlayItems.value,
        options
      )
      if (field) {
        setCachedPointInterpolationField(
          pd,
          cacheKey,
          field,
          Number(options?.cacheTtlMs) ||
            Number(pd?.interpolation?.cacheTtlMs) ||
            defaultInterpolationCacheTtlMs
        )
      }
      ctx.stressDebugLog('rebuild:point_interpolation_cache', {
        mode: options?.method || mode,
        stage,
        cacheHit: false,
        grid: Array.isArray(options?.grid) ? options.grid.slice(0, 3) : null
      })
      return { field, cacheHit: false }
    }
    const applyInterpolationField = (field, stageLabel) => {
      ctx.config.value = buildPointFieldConfig(field)
      if (!field) {
        updateProgress(100, `${stageLabel}失败，已回退至点扩散热力图`, false)
        ctx.stressDebugLog('rebuild:point_interpolation_fallback', {
          mode,
          stage: stageLabel,
          fallbackMode: 'points'
        })
        return
      }
      const fallbackMode = String(field?.fallback?.to || '')
      const fallbackReason = String(field?.fallback?.reason || '')
      if (fallbackMode === 'idw') {
        const fallbackText =
          fallbackReason === 'insufficient_points'
            ? '采样点不足，Kriging 已回退至 IDW'
            : 'Kriging 训练失败，已回退至 IDW'
        updateProgress(88, fallbackText, true)
      }
      if (typeof ctx.setRenderProgress === 'function') {
        ctx.setRenderProgress({
          fallbackMode,
          fallbackReason
        })
      }
    }
    if (mode === 'idw' || mode === 'kriging') {
      updateProgress(8, mode === 'kriging' ? 'Kriging 渲染准备中...' : 'IDW 渲染准备中...')
      const interpolationOptions = {
        ...(pd.interpolation || {}),
        method: mode,
        preferWorker: true,
        optimizeParameters: pd.interpolation?.optimizeParameters !== false
      }
      const interpolationProgressRange = { start: 40, end: 86 }
      interpolationOptions.onProgress = progress => {
        const raw = Number(progress?.percent)
        const basePercent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0
        const mappedPercent =
          interpolationProgressRange.start +
          ((interpolationProgressRange.end - interpolationProgressRange.start) * basePercent) / 100
        const text = mode === 'kriging' ? 'Kriging 计算中...' : 'IDW 计算中...'
        updateProgress(mappedPercent, text)
      }
      if (!Number.isFinite(Number(interpolationOptions.progressStep))) {
        interpolationOptions.progressStep = 2
      }
      const frameCount = Math.max(1, Number(pd?.time?.frames) || 1)
      if (
        !(
          Array.isArray(interpolationOptions.grid) &&
          interpolationOptions.grid.length >= 3 &&
          interpolationOptions.grid
            .slice(0, 3)
            .every(v => Number.isFinite(Number(v)) && Number(v) > 0)
        )
      ) {
        interpolationOptions.grid = resolveDefaultGrid(frameCount)
      }
      if (mode === 'idw' && !Number.isFinite(Number(interpolationOptions.power))) {
        interpolationOptions.power = 2.0
      }
      if (!Number.isFinite(Number(interpolationOptions.cacheTtlMs))) {
        interpolationOptions.cacheTtlMs = defaultInterpolationCacheTtlMs
      }
      if (!Number.isFinite(Number(interpolationOptions.workerMinOps))) {
        interpolationOptions.workerMinOps = mode === 'kriging' ? 90000 : 180000
      }
      if (!Number.isFinite(Number(interpolationOptions.maxPoints))) {
        const gridSpec = Array.isArray(interpolationOptions.grid) ? interpolationOptions.grid : null
        const gw = Math.max(1, Number(gridSpec?.[0]) || 96)
        const gh = Math.max(1, Number(gridSpec?.[1]) || 96)
        const gd = Math.max(1, Number(gridSpec?.[2]) || 64)
        const voxelCount = gw * gh * gd
        if (mode === 'kriging') {
          interpolationOptions.maxPoints =
            voxelCount > 350000 ? 96 : voxelCount > 180000 ? 120 : 160
        } else {
          interpolationOptions.maxPoints =
            voxelCount > 900000 ? 240 : voxelCount > 500000 ? 300 : 380
        }
      }
      if (mode === 'kriging') {
        interpolationOptions.computeVariance = true
        const finalGridSpec = Array.isArray(interpolationOptions.grid)
          ? interpolationOptions.grid
          : resolveDefaultGrid(frameCount)
        const finalGrid = [
          Math.max(1, Number(finalGridSpec?.[0]) || 72),
          Math.max(1, Number(finalGridSpec?.[1]) || 72),
          Math.max(1, Number(finalGridSpec?.[2]) || 48)
        ]
        const previewGrid = [
          Math.max(24, Math.min(finalGrid[0] - 8, Math.round(finalGrid[0] * 0.65))),
          Math.max(24, Math.min(finalGrid[1] - 8, Math.round(finalGrid[1] * 0.65))),
          Math.max(16, Math.min(finalGrid[2] - 6, Math.round(finalGrid[2] * 0.65)))
        ]
        const needPreview =
          previewGrid[0] < finalGrid[0] ||
          previewGrid[1] < finalGrid[1] ||
          previewGrid[2] < finalGrid[2]
        if (needPreview) {
          hasDeferredFinalPass = true
          updateProgress(28, 'Kriging 预览场计算中...')
          interpolationProgressRange.start = 28
          interpolationProgressRange.end = 58
          const previewOptions = {
            ...interpolationOptions,
            grid: previewGrid,
            maxPoints: Math.min(Number(interpolationOptions.maxPoints) || 120, 96)
          }
          const previewResult = await resolveInterpolationField(previewOptions, 'preview')
          if (rebuildToken !== pointRebuildToken) return false
          applyInterpolationField(previewResult.field, 'Kriging 预览场')
          if (previewResult.cacheHit) {
            ctx.stressDebugLog('rebuild:point_interpolation_cache', {
              mode,
              stage: 'preview',
              cacheHit: true,
              grid: previewGrid
            })
          }
          if (!previewResult.field) {
            hasDeferredFinalPass = false
          } else {
            updateProgress(62, 'Kriging 预览场已生成，请确认后开始精细计算', false)
            if (typeof ctx.setRenderProgress === 'function') {
              ctx.setRenderProgress({
                phase: 'preview_ready',
                requiresConfirm: true,
                fallbackMode: String(previewResult.field?.fallback?.to || ''),
                fallbackReason: String(previewResult.field?.fallback?.reason || '')
              })
            }
            pendingPointInterpolationFinalPass = {
              token: rebuildToken,
              async run() {
                if (rebuildToken !== pointRebuildToken) return false
                updateProgress(72, 'Kriging 精细场计算中...')
                interpolationProgressRange.start = 72
                interpolationProgressRange.end = 96
                if (typeof ctx.setRenderProgress === 'function') {
                  ctx.setRenderProgress({
                    phase: 'final_running',
                    requiresConfirm: false,
                    fallbackMode: '',
                    fallbackReason: ''
                  })
                }
                const finalResult = await resolveInterpolationField(interpolationOptions, 'final')
                if (rebuildToken !== pointRebuildToken) return false
                applyInterpolationField(finalResult.field, 'Kriging 精细场')
                if (finalResult.cacheHit) {
                  ctx.stressDebugLog('rebuild:point_interpolation_cache', {
                    mode,
                    stage: 'final',
                    cacheHit: true,
                    grid: interpolationOptions.grid
                  })
                }
                syncHeatmapDisplay()
                if (typeof ctx.applyToModel === 'function') ctx.applyToModel()
                updateProgress(100, '渲染完成', false)
                if (typeof ctx.setRenderProgress === 'function') {
                  ctx.setRenderProgress({
                    phase: 'completed',
                    requiresConfirm: false
                  })
                }
                return true
              }
            }
          }
        } else {
          updateProgress(40, 'Kriging 计算中...')
          interpolationProgressRange.start = 40
          interpolationProgressRange.end = 86
          const result = await resolveInterpolationField(interpolationOptions, 'final')
          if (rebuildToken !== pointRebuildToken) return false
          applyInterpolationField(result.field, 'Kriging 插值')
          if (result.cacheHit) {
            ctx.stressDebugLog('rebuild:point_interpolation_cache', {
              mode,
              stage: 'final',
              cacheHit: true,
              grid: interpolationOptions.grid
            })
          }
          updateProgress(88, 'Kriging 结果应用中...')
        }
      } else {
        updateProgress(40, 'IDW 计算中...')
        interpolationProgressRange.start = 40
        interpolationProgressRange.end = 86
        const result = await resolveInterpolationField(interpolationOptions, 'final')
        if (rebuildToken !== pointRebuildToken) return false
        applyInterpolationField(result.field, 'IDW 插值')
        if (result.cacheHit) {
          ctx.stressDebugLog('rebuild:point_interpolation_cache', {
            mode,
            stage: 'final',
            cacheHit: true,
            grid: interpolationOptions.grid
          })
        }
        updateProgress(88, 'IDW 结果应用中...')
      }
    } else {
      if (typeof ctx.setRenderProgress === 'function') {
        ctx.setRenderProgress({
          active: false,
          percent: 0,
          text: '',
          phase: 'idle',
          requiresConfirm: false,
          fallbackMode: '',
          fallbackReason: ''
        })
      }
      const pointsForRender = buildRenderablePointsFromPointDataset(
        pd,
        ctx.metric.value,
        direction,
        ctx.overlayItems.value
      )
      ctx.config.value = applySafetyPaletteIfNeeded(
        buildHeatmapConfigFromPointDataset(
          { ...pd, origin, points: pointsForRender },
          { radiusScaleFactor: scale, tileset: ctx.tileset.value, sourceStrategy }
        )
      )
    }
    syncHeatmapDisplay()
    ctx.stressDebugLog('rebuild:point_source', {
      originMode: pd.originMode,
      originResolved: origin,
      radiusScaleFactor: scale,
      interpolationFieldSize,
      sources: Array.isArray(ctx.config.value?.sources) ? ctx.config.value.sources.length : 0
    })
    if ((mode === 'idw' || mode === 'kriging') && !hasDeferredFinalPass) {
      updateProgress(100, '渲染完成', false)
    }
    return true
  }

  const rebuildConfigFromDataset = async () => {
    const ds = getGridDataset()
    if (!ds) return
    const cacheKey = buildCacheKey(
      ctx.metric.value,
      ctx.directionAzimuth.value,
      ctx.directionDip.value
    )
    let scalarField = ctx.cachedScalarFields.get(cacheKey)
    const cacheHit = Boolean(scalarField)
    if (!scalarField) {
      scalarField = computeScalarField(
        ds,
        ctx.metric.value,
        { azimuthDeg: ctx.directionAzimuth.value, dipDeg: ctx.directionDip.value },
        ds.render?.valueRange,
        { safetyContext: ctx.safetyContext?.value || null }
      )
      ctx.cachedScalarFields.set(cacheKey, scalarField)
    }
    ctx.config.value = applySafetyPaletteIfNeeded(
      buildShaderConfigFromScalarField(ds, scalarField, {
        metric: ctx.metric.value,
        unitStress: ctx.unitStress.value,
        render: ds.render
      })
    )
    syncHeatmapDisplay()
    ctx.stressDebugLog('rebuild:grid_config', {
      metric: ctx.metric.value,
      safetyMetric: isSafetyMetric(ctx.metric.value),
      cacheHit,
      valueRange: scalarField?.valueRange || null,
      frames: ds?.time?.frames || 0
    })
  }

  const rebuildConfig = async () => {
    if ((ctx.stressSource?.value?.kind || '') === 'points') return rebuildConfigFromPointDataset()
    if ((ctx.stressSource?.value?.kind || '') === 'grid') return rebuildConfigFromDataset()
    return false
  }

  return {
    confirmPointInterpolationFinalPass,
    keepPointInterpolationPreview,
    rebuildConfig,
    rebuildConfigFromDataset,
    rebuildConfigFromPointDataset
  }
}
