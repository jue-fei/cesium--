import { normalizeHeatmapDisplay, resolveOriginFromModelCenter } from '../render/index.js'
import { validateAndNormalizeStressFile } from '../data/index.js'
import { warn } from '@/utils/errorHandler.js'
import {
  resolvePlaybackSpeedMs,
  resolvePointRenderMode,
  resolvePointSourceStrategy,
  resolveTimeDimension
} from '../shared/stressActionShared.js'

export function createStressImportActions(ctx) {
  const isPointSource = normalized => normalized?.data?.sourceKind === 'points'
  const setStressSource = (kind, data) => (ctx.stressSource.value = { kind, data }).data
  const resetTimeline = frames => {
    ctx.currentTime.value = 0
    ctx.maxTime.value = Math.max(0, (frames || 1) - 1)
  }
  const clearRuntimeCaches = () => {
    ctx.cachedScalarFields.clear()
    ctx.cachedPointInterpolationFields?.clear?.()
  }
  const applyCommonImportState = data => {
    ctx.unitStress.value = data.unitStress || 'MPa'
    ctx.materialE.value = data.material?.E ?? null
    ctx.materialNu.value = data.material?.nu ?? null
    ctx.timeDimension.value = resolveTimeDimension(data.time?.dimension)
    ctx.playbackSpeed.value = resolvePlaybackSpeedMs(data.time?.speedMs)
    resetTimeline(data.time?.frames)
    clearRuntimeCaches()
  }
  const finishImport = ok => {
    const message = !ctx.tileset.value
      ? '当前未加载 3D Tiles 模型，无法应用热力图。请先加载模型再导入。'
      : ok
        ? '应力数据已导入并渲染'
        : '应力数据已导入，但未生成可渲染结果'
    ctx.importReport.value = {
      ok: Boolean(ctx.tileset.value && ok),
      title: ctx.tileset.value && ok ? '导入成功' : '导入完成',
      message,
      details: []
    }
    ctx.showMessage(message, ctx.importReport.value.ok ? 'success' : 'warning')
  }

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
    const normalized = validateAndNormalizeStressFile(json)
    if (!normalized.ok) {
      ctx.importReport.value = {
        ok: false,
        title: '导入失败',
        message: normalized.message,
        details: []
      }
      ctx.showMessage(ctx.importReport.value.message, 'error')
      return false
    }
    if (isPointSource(normalized)) {
      const pd = setStressSource('points', normalized.data)
      pd.sourceStrategy = resolvePointSourceStrategy(pd)
      pd.renderMode = resolvePointRenderMode(pd)
      if (ctx.pointSourceMode) ctx.pointSourceMode.value = pd.sourceStrategy
      if (ctx.pointRenderMode) ctx.pointRenderMode.value = pd.renderMode
      applyCommonImportState(pd)
      ctx.metric.value = 'von_mises'
      const rebuilt = await ctx.rebuildConfig()
      if (
        pd?.originMode === '模型中心' &&
        ctx.tileset.value &&
        !resolveOriginFromModelCenter(ctx.tileset.value)
      ) {
        try {
          const ready = ctx.tileset.value.readyPromise
          if (ready && typeof ready.then === 'function') {
            void ready.then(async () => {
              if (ctx.stressSource.value.kind !== 'points') return
              const rebuiltOnReady = await ctx.rebuildConfig()
              if (rebuiltOnReady !== false) ctx.applyToModel()
            })
          }
        } catch (e) {
          warn('stress', 'importActions', e)
        }
      }
      if (rebuilt !== false) ctx.applyToModel()
      ctx.resetHistory?.()
      const sources = Array.isArray(ctx.config.value?.sources) ? ctx.config.value.sources.length : 0
      finishImport(sources > 0)
      return true
    }
    const ds = setStressSource('grid', normalized.data)
    if (ds?.originMode === '模型中心') {
      const resolved = resolveOriginFromModelCenter(ctx.tileset.value)
      if (resolved) ds.origin = resolved
    }
    applyCommonImportState(ds)
    if (ds.render?.defaultMetric) {
      ctx.metric.value = ds.render.defaultMetric
    }
    if (ds.render?.heatmapDisplay) {
      ctx.heatmapDisplay.value = normalizeHeatmapDisplay(ds.render.heatmapDisplay)
    }
    await ctx.rebuildConfig()
    ctx.applyToModel()
    ctx.resetHistory?.()
    finishImport(true)
    return true
  }

  return { parseAndSetStressFile }
}
