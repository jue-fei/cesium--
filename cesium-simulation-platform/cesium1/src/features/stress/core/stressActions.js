import * as Cesium from 'cesium'
import {
  applyHeatmapDisplayToConfigObject,
  buildCacheKey,
  buildDefaultStressConfig,
  buildHeatmapConfigFromPointDataset,
  buildShaderConfigFromScalarField,
  cloneColorRamp,
  computeRadiusScaleFactor,
  emitConsoleRenderProbe,
  normalizeHeatmapDisplay,
  resolveOriginFromModelCenter,
  resolveOriginFromViewer,
  resolveRuntimeRenderHints,
  resolveTilesetCenterInfo
} from './render/stressRenderCore.js'
import { computeScalarField } from './computation/stressComputation.js'
import {
  buildAllMetricsRowsFromTensor6,
  buildPointConfigDetails,
  buildPointConfigSeries,
  buildRenderablePointsFromPointDataset,
  buildPointAllMetricsSeries as buildPointAllMetricsSeriesCore,
  buildPointSeriesForMetric as buildPointSeriesForMetricCore,
  computePointDetailsAtTime,
  findNearestPointConfig,
  getPositionFromClick,
  sampleGridScalarAt
} from './points/stressPointCore.js'
import {
  buildImportDiagnostics,
  inferMissingHints,
  validateAndNormalizeStressFile
} from './io/stressDataCore.js'

export function createStressDataActions(ctx) {
  const rebuildConfigFromPointDataset = async () => {
    if (!ctx.pointDataset.value) return
    const pd = ctx.pointDataset.value
    let origin = pd.origin
    if (pd.originMode === '模型中心') {
      const resolved = resolveOriginFromModelCenter(ctx.tileset.value)
      if (resolved) origin = resolved
      else origin = resolveOriginFromViewer(ctx.viewer.value)
    }
    if (!origin) {
      ctx.config.value = buildDefaultStressConfig()
      ctx.stressDebugLog('rebuild:point_config_failed', {
        reason: 'origin_not_resolved',
        originMode: pd.originMode,
        originProvided: pd.origin,
        hasTileset: Boolean(ctx.tileset.value),
        hasViewer: Boolean(ctx.viewer.value)
      })
      return
    }
    const scale = computeRadiusScaleFactor(ctx.tileset.value, pd.size)
    const pointsForRender = buildRenderablePointsFromPointDataset(
      pd,
      ctx.metric.value,
      { azimuthDeg: ctx.directionAzimuth.value, dipDeg: ctx.directionDip.value },
      ctx.overlayItems.value
    )
    ctx.config.value = buildHeatmapConfigFromPointDataset(
      { ...pd, origin, points: pointsForRender },
      { radiusScaleFactor: scale, tileset: ctx.tileset.value }
    )
    ctx.heatmapBaseRamp.value = cloneColorRamp(ctx.config.value?.colorRamp)
    ctx.heatmapBaseRamp.value = applyHeatmapDisplayToConfigObject(
      ctx.config.value,
      ctx.heatmapBaseRamp.value,
      ctx.heatmapDisplay.value
    ).baseRamp
    try {
      const sources = Array.isArray(ctx.config.value?.sources) ? ctx.config.value.sources : []
      const t = Number(ctx.currentTime.value) || 0
      let maxFactor = 0
      let active = 0
      for (const s of sources) {
        const f = Number(Array.isArray(s?.timeSeries) ? s.timeSeries[t] : 1)
        if (Number.isFinite(f)) {
          if (f > maxFactor) maxFactor = f
          if (f > 0.001) active += 1
        }
      }
      let centerInfo = null
      let dist = null
      try {
        centerInfo = resolveTilesetCenterInfo(ctx.tileset.value)
        const cwc = centerInfo?.worldCenter
        const s0 = sources[0]
        if (cwc) {
          const s0wc =
            s0?.centerCartesian && typeof s0.centerCartesian === 'object'
              ? s0.centerCartesian
              : Array.isArray(s0?.center) && s0.center.length >= 2
                ? Cesium.Cartesian3.fromDegrees(s0.center[0], s0.center[1], s0.center[2] || 0)
                : null
          if (s0wc) dist = Cesium.Cartesian3.distance(cwc, s0wc)
        }
      } catch (e) {
        void e
      }
      ctx.stressDebugLog('rebuild:point_sources_preview', {
        timeIndex: t,
        sources: sources.length,
        active,
        maxFactor,
        originResolved: origin,
        tilesetCenterMode: centerInfo?.mode || null,
        firstSourceDistanceToModelCenter: dist,
        firstSource: sources[0] || null
      })
    } catch (e) {
      void e
    }
    ctx.stressDebugLog('rebuild:point_config', {
      originMode: pd.originMode,
      originResolved: origin,
      radiusScaleFactor: scale,
      sources: Array.isArray(ctx.config.value?.sources) ? ctx.config.value.sources.length : 0
    })
  }

  const rebuildConfigFromDataset = async () => {
    if (!ctx.dataset.value) return
    const cacheKey = buildCacheKey(
      ctx.metric.value,
      ctx.directionAzimuth.value,
      ctx.directionDip.value
    )
    let scalarField = ctx.cachedScalarFields.get(cacheKey)
    const cacheHit = Boolean(scalarField)
    if (!scalarField) {
      scalarField = computeScalarField(
        ctx.dataset.value,
        ctx.metric.value,
        { azimuthDeg: ctx.directionAzimuth.value, dipDeg: ctx.directionDip.value },
        ctx.dataset.value.render?.valueRange
      )
      ctx.cachedScalarFields.set(cacheKey, scalarField)
    }
    ctx.config.value = buildShaderConfigFromScalarField(ctx.dataset.value, scalarField, {
      unitStress: ctx.unitStress.value,
      render: ctx.dataset.value.render
    })
    ctx.heatmapBaseRamp.value = cloneColorRamp(ctx.config.value?.colorRamp)
    ctx.heatmapBaseRamp.value = applyHeatmapDisplayToConfigObject(
      ctx.config.value,
      ctx.heatmapBaseRamp.value,
      ctx.heatmapDisplay.value
    ).baseRamp
    ctx.stressDebugLog('rebuild:grid_config', {
      metric: ctx.metric.value,
      cacheHit,
      valueRange: scalarField?.valueRange || null,
      frames: ctx.dataset.value?.time?.frames || 0
    })
  }

  let pendingMaterialTimer = null
  const setMaterial = async (nextE, nextNu) => {
    if (!ctx.dataset.value) return
    const e = Number(nextE)
    const nu = Number(nextNu)
    if (!(e > 0) || !Number.isFinite(e)) return ctx.showMessage('弹性模量E 必须为正数', 'error')
    if (!Number.isFinite(nu) || nu <= -0.999 || nu >= 0.499)
      return ctx.showMessage('泊松比nu 取值范围应为 (-1, 0.5)', 'error')
    ctx.dataset.value.material.E = e
    ctx.dataset.value.material.nu = nu
    ctx.materialE.value = e
    ctx.materialNu.value = nu
    ctx.cachedScalarFields.clear()
    ctx.resetPick()
    if (pendingMaterialTimer) clearTimeout(pendingMaterialTimer)
    pendingMaterialTimer = setTimeout(async () => {
      pendingMaterialTimer = null
      await rebuildConfigFromDataset()
      ctx.applyToModel()
    }, 120)
  }

  const setMetric = async nextMetric => {
    ctx.metric.value = nextMetric
    ctx.resetPick()
    if (ctx.pointDataset.value) {
      await rebuildConfigFromPointDataset()
      ctx.applyToModel()
      return
    }
    if (!ctx.dataset.value) return
    await rebuildConfigFromDataset()
    ctx.applyToModel()
  }

  const setDirection = async (azimuthDeg, dipDeg) => {
    ctx.directionAzimuth.value = Number(azimuthDeg) || 0
    ctx.directionDip.value = Number(dipDeg) || 0
    const effective = ctx.metric.value === 'snn' || ctx.metric.value === 'tau_n'
    if (!effective) return
    ctx.resetPick()
    if (ctx.pointDataset.value) {
      await rebuildConfigFromPointDataset()
      ctx.applyToModel()
      return
    }
    if (!ctx.dataset.value) return
    await rebuildConfigFromDataset()
    ctx.applyToModel()
  }

  const setHeatmapDisplay = next => {
    const curr = ctx.heatmapDisplay.value || {}
    const merged = {
      contrast: Number.isFinite(Number(next?.contrast)) ? Number(next.contrast) : curr.contrast,
      gamma: Number.isFinite(Number(next?.gamma)) ? Number(next.gamma) : curr.gamma,
      cutoff: Number.isFinite(Number(next?.cutoff)) ? Number(next.cutoff) : curr.cutoff,
      forceVisible: Number.isFinite(Number(next?.forceVisible))
        ? Number(next.forceVisible)
        : curr.forceVisible,
      enableContour:
        next?.enableContour !== undefined ? Boolean(next.enableContour) : curr.enableContour,
      enableGlow: next?.enableGlow !== undefined ? Boolean(next.enableGlow) : curr.enableGlow,
      enableMarker:
        next?.enableMarker !== undefined ? Boolean(next.enableMarker) : curr.enableMarker
    }
    const normalized = normalizeHeatmapDisplay(merged)
    ctx.heatmapDisplay.value = normalized
    ctx.heatmapBaseRamp.value = applyHeatmapDisplayToConfigObject(
      ctx.config.value,
      ctx.heatmapBaseRamp.value,
      normalized
    ).baseRamp
    ctx.applyToModel()
  }

  return {
    rebuildConfigFromDataset,
    rebuildConfigFromPointDataset,
    setMaterial,
    setMetric,
    setDirection,
    setHeatmapDisplay
  }
}

export function createStressImportActions(ctx) {
  const readFileText = file =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('读取失败'))
      reader.readAsText(file)
    })

  const parseAndSetStressFile = async file => {
    ctx.importReport.value = null
    ctx.resetPick()
    const text = await readFileText(file)
    let json = null
    try {
      json = JSON.parse(text)
    } catch (e) {
      ctx.importReport.value = {
        ok: false,
        title: '导入失败',
        message: '文件解析失败：不是有效的 JSON',
        details: []
      }
      ctx.showMessage(ctx.importReport.value.message, 'error')
      return false
    }
    let normalized = null
    try {
      normalized = validateAndNormalizeStressFile(json)
    } catch (e) {
      ctx.importReport.value = {
        ok: false,
        title: '导入失败',
        message: '导入校验异常：请查看控制台定位具体字段',
        details: []
      }
      ctx.stressDebugLog('import:validate_exception', {
        fileName: file?.name || '',
        version: json?.['格式版本'],
        exception: {
          message: String(e?.message || ''),
          name: String(e?.name || ''),
          stack: String(e?.stack || '')
        },
        diagnostics: buildImportDiagnostics(json)
      })
      ctx.showMessage(ctx.importReport.value.message, 'error')
      return false
    }
    if (!normalized.ok) {
      ctx.importReport.value = {
        ok: false,
        title: '导入失败',
        message: normalized.message,
        details: inferMissingHints(normalized.message)
      }
      ctx.showMessage(ctx.importReport.value.message, 'error')
      return false
    }
    if (normalized.data?.__type === 'point_config') {
      ctx.pointDataset.value = normalized.data
      ctx.dataset.value = null
      ctx.unitStress.value = normalized.data.unitStress || 'MPa'
      ctx.materialE.value = normalized.data.material?.E ?? null
      ctx.materialNu.value = normalized.data.material?.nu ?? null
      ctx.timeDimension.value = normalized.data.time?.dimension || '秒'
      ctx.playbackSpeed.value = normalized.data.time?.speedMs || 500
      ctx.metric.value = 'von_mises'
      ctx.currentTime.value = 0
      ctx.maxTime.value = Math.max(0, (normalized.data.time?.frames || 1) - 1)
      ctx.cachedScalarFields.clear()
      await ctx.rebuildConfigFromPointDataset()
      if (
        ctx.pointDataset.value?.originMode === '模型中心' &&
        ctx.tileset.value &&
        !resolveOriginFromModelCenter(ctx.tileset.value)
      ) {
        try {
          const ready = ctx.tileset.value.readyPromise
          if (ready && typeof ready.then === 'function') {
            void ready.then(async () => {
              if (!ctx.pointDataset.value) return
              await ctx.rebuildConfigFromPointDataset()
              ctx.applyToModel()
            })
          }
        } catch (e) {
          void e
        }
      }
      ctx.applyToModel()
      const sources = Array.isArray(ctx.config.value?.sources) ? ctx.config.value.sources.length : 0
      const origin =
        resolveOriginFromModelCenter(ctx.tileset.value) || resolveOriginFromViewer(ctx.viewer.value)
      const originOk = Array.isArray(origin) && origin.length >= 2
      const renderHints = resolveRuntimeRenderHints(ctx.tileset.value, ctx.config.value)
      ctx.importReport.value = {
        ok: true,
        title: '导入成功',
        message: sources > 0 ? '应力点数据已导入并渲染' : '应力点数据已导入，但未生成可渲染点',
        details: [
          `模式：应力点-1.0`,
          `点数量（原始/渲染）：${normalized.data.sourceCountRaw || 0} / ${normalized.data.points?.length || 0}`,
          `可渲染点：${sources}`,
          `模型是否加载：${ctx.tileset.value ? '是' : '否'}`,
          `原点是否可解析：${originOk ? '是' : '否'}`,
          `首点到模型中心距离：${renderHints.distanceText}`,
          `首点半径：${renderHints.radiusText}`
        ]
      }
      if (!ctx.tileset.value) {
        ctx.importReport.value.ok = false
        ctx.importReport.value.title = '导入完成但无法渲染'
        ctx.importReport.value.message =
          '当前未加载 3D Tiles 模型，无法应用热力图。请先加载模型再导入。'
      } else if (sources < 1) {
        ctx.importReport.value.ok = false
        ctx.importReport.value.title = '导入完成但无法渲染'
        ctx.importReport.value.message = '未生成可渲染点（请检查 点 数组与 von_mises 序列是否正确）'
      }
      emitConsoleRenderProbe({
        fileName: file?.name || '',
        tileset: ctx.tileset.value,
        cfg: ctx.config.value,
        hints: renderHints,
        sourceCountRaw: normalized.data.sourceCountRaw || 0,
        sourceCountRendered: sources
      })
      ctx.showMessage(
        ctx.importReport.value.message,
        ctx.importReport.value.ok ? 'success' : 'warning'
      )
      return true
    }
    ctx.pointDataset.value = null
    ctx.dataset.value = normalized.data
    if (ctx.dataset.value?.originMode === '模型中心') {
      const resolved = resolveOriginFromModelCenter(ctx.tileset.value)
      if (resolved) ctx.dataset.value.origin = resolved
    }
    ctx.unitStress.value = normalized.data.unitStress || 'MPa'
    ctx.materialE.value = normalized.data.material.E
    ctx.materialNu.value = normalized.data.material.nu
    ctx.timeDimension.value = normalized.data.time.dimension || '秒'
    ctx.playbackSpeed.value = normalized.data.time.speedMs || 500
    if (normalized.data.render?.defaultMetric)
      ctx.metric.value = normalized.data.render.defaultMetric
    ctx.currentTime.value = 0
    ctx.maxTime.value = Math.max(0, normalized.data.time.frames - 1)
    ctx.cachedScalarFields.clear()
    await ctx.rebuildConfigFromDataset()
    ctx.applyToModel()
    ctx.importReport.value = {
      ok: true,
      title: '导入成功',
      message: '应力数据已导入并渲染',
      details: [
        `模式：应力分析-1.0`,
        `帧数：${normalized.data.time?.frames || 0}`,
        `模型是否加载：${ctx.tileset.value ? '是' : '否'}`
      ]
    }
    if (!ctx.tileset.value) {
      ctx.importReport.value.ok = false
      ctx.importReport.value.title = '导入完成但无法渲染'
      ctx.importReport.value.message =
        '当前未加载 3D Tiles 模型，无法应用热力图。请先加载模型再导入。'
      ctx.showMessage(ctx.importReport.value.message, 'warning')
    } else {
      ctx.showMessage(ctx.importReport.value.message, 'success')
    }
    return true
  }

  return { parseAndSetStressFile }
}

export function createStressSamplingActions(ctx) {
  const buildDirection = dirOverride =>
    dirOverride || {
      azimuthDeg: ctx.directionAzimuth.value,
      dipDeg: ctx.directionDip.value
    }

  const resolvePointDatasetOrigin = () => {
    if (!ctx.pointDataset.value) return null
    const pd = ctx.pointDataset.value
    let origin = pd.origin
    if (pd.originMode === '模型中心') {
      origin =
        ctx.resolveOriginFromModelCenter(ctx.tileset.value) ||
        ctx.resolveOriginFromViewer(ctx.viewer.value)
    }
    return origin
  }

  const sampleScalarAtPoint = (pointWC, timeIndex) => {
    const field = ctx.config.value?.field
    const data = field?.data
    if (!field || field.type !== 'grid' || !data) return null
    const grid = data.grid
    const origin = data.origin
    const size = data.size
    const frames = data.frames || []
    if (!grid || !origin || !size || frames.length === 0) return null
    const frame = frames[Math.max(0, Math.min(frames.length - 1, timeIndex))]
    const values = frame?.values
    if (!Array.isArray(values)) return null
    return sampleGridScalarAt(pointWC, values, grid, origin, size)
  }

  const buildSeriesAtPoint = pointWC => {
    const field = ctx.config.value?.field
    const data = field?.data
    if (!field || field.type !== 'grid' || !data) return []
    const grid = data.grid
    const origin = data.origin
    const size = data.size
    const frames = data.frames || []
    const timePoints = data.timePoints || null
    if (!grid || !origin || !size || frames.length === 0) return []
    const series = []
    for (let i = 0; i < frames.length; i++) {
      const t = Array.isArray(timePoints) ? timePoints[i] : i
      const values = frames[i]?.values
      if (!Array.isArray(values)) continue
      const v = sampleGridScalarAt(pointWC, values, grid, origin, size)
      series.push({ t, v })
    }
    return series
  }

  const samplePickedPoint = (pointWC, timeIndex) => {
    if (ctx.pointDataset.value) {
      const pd = ctx.pointDataset.value
      const origin = resolvePointDatasetOrigin()
      const size = Array.isArray(pd.size) && pd.size.length >= 3 ? pd.size : [200, 200, 100]
      const points = Array.isArray(pd.points) ? pd.points : []
      if (!origin || points.length < 1) return { value: null, details: null, series: [] }
      const dir = { azimuthDeg: ctx.directionAzimuth.value, dipDeg: ctx.directionDip.value }
      const nearest = findNearestPointConfig(
        points,
        origin,
        size,
        pointWC,
        ctx.tileset.value,
        resolveTilesetCenterInfo
      )
      if (!nearest) return { value: null, details: null, series: [] }
      const series = buildPointConfigSeries(
        nearest.point,
        pd,
        ctx.metric.value,
        dir,
        ctx.overlayItems.value
      )
      const idx = Math.max(0, Math.min(series.length - 1, timeIndex))
      const v = series[idx]?.v ?? null
      const details = buildPointConfigDetails(nearest.point, timeIndex, dir)
      return { value: v, details, series }
    }
    const value = sampleScalarAtPoint(pointWC, timeIndex)
    const details = computePointDetailsAtTime(ctx.dataset.value, pointWC, timeIndex, {
      azimuthDeg: ctx.directionAzimuth.value,
      dipDeg: ctx.directionDip.value
    })
    const series = buildSeriesAtPoint(pointWC)
    return { value, details, series }
  }

  const resolvePointDatasetSelection = pointWC => {
    const pd = ctx.pointDataset.value
    if (!pd) return null
    const origin = resolvePointDatasetOrigin()
    const size = Array.isArray(pd.size) && pd.size.length >= 3 ? pd.size : [200, 200, 100]
    const points = Array.isArray(pd.points) ? pd.points : []
    if (!origin || points.length < 1) return null
    const nearest = findNearestPointConfig(
      points,
      origin,
      size,
      pointWC,
      ctx.tileset.value,
      resolveTilesetCenterInfo
    )
    if (!nearest) return null
    return { pd, nearest }
  }

  const resetPick = () => {
    ctx.pickedPoint.value = null
    ctx.pickedPointValue.value = null
    ctx.pickedPointDetails.value = null
    ctx.pickedPointSeries.value = []
  }

  const getCurrentValueRange = () => {
    const range = ctx.config.value?.field?.data?.valueRange
    if (!Array.isArray(range) || range.length !== 2) return null
    const min = Number(range[0])
    const max = Number(range[1])
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return { min, max }
  }

  const pickPointOnModel = async () => {
    const v = ctx.viewer.value
    if (!v) return null
    const previousCursor = v.canvas?.style?.cursor
    if (v.canvas) v.canvas.style.cursor = 'crosshair'
    return await new Promise(resolve => {
      const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
      handler.setInputAction(evt => {
        const pos = getPositionFromClick(v, evt.position, ctx.tileset.value)
        if (pos) {
          ctx.pickedPoint.value = pos
          const sampled = samplePickedPoint(pos, ctx.currentTime.value)
          ctx.pickedPointValue.value = sampled.value
          ctx.pickedPointDetails.value = sampled.details
          ctx.pickedPointSeries.value = sampled.series
        }
        try {
          handler.destroy()
        } catch (e) {
          void e
        }
        if (v.canvas && previousCursor !== undefined) v.canvas.style.cursor = previousCursor || ''
        resolve(pos || null)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
      handler.setInputAction(() => {
        try {
          handler.destroy()
        } catch (e) {
          void e
        }
        if (v.canvas && previousCursor !== undefined) v.canvas.style.cursor = previousCursor || ''
        resolve(null)
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
    })
  }

  const buildPointSeriesForMetric = (pointWC, metricKey, dirOverride) => {
    const dir = buildDirection(dirOverride)
    if (ctx.pointDataset.value) {
      const selected = resolvePointDatasetSelection(pointWC)
      if (!selected) return []
      return buildPointConfigSeries(
        selected.nearest.point,
        selected.pd,
        metricKey,
        dir,
        ctx.overlayItems.value
      )
    }
    if (!ctx.dataset.value) return []
    return buildPointSeriesForMetricCore(pointWC, ctx.dataset.value, metricKey, dir)
  }

  const buildPointAllMetricsSeries = (pointWC, dirOverride) => {
    const dir = buildDirection(dirOverride)
    if (ctx.pointDataset.value) {
      const selected = resolvePointDatasetSelection(pointWC)
      if (!selected?.nearest?.point?.tensor6) return []
      return buildAllMetricsRowsFromTensor6(selected.nearest.point.tensor6, selected.pd, dir)
    }
    if (!ctx.dataset.value) return []
    return buildPointAllMetricsSeriesCore(pointWC, ctx.dataset.value, dir)
  }

  return {
    resetPick,
    samplePickedPoint,
    getCurrentValueRange,
    pickPointOnModel,
    buildPointSeriesForMetric,
    buildPointAllMetricsSeries
  }
}
