import * as Cesium from 'cesium'
import {
  MAX_SOURCE_COUNT,
  createModelCenterResolver,
  getStressDebugWindow,
  resolveModelWorldToLocal
} from './stressShared.js'

/**
 * 时序帧更新域（TimeSeriesDomain）
 *
 * 从 HeatmapManager 拆出的"时序帧更新"职责：updateStressTime 按帧索引驱动
 * 应力源（源纹理按帧 LRU 缓存或直传 uniform）与网格场帧纹理的逐帧切换，
 * 并在调试开启时按节流窗口输出源统计。配置的时序派生复用配置域 withTimeSeries、
 * 纹理能力复用纹理域（均经门面实例 this.m），自身仅持有模块级缓存上限常量。
 */

// 单个 entry 的应力源纹理按帧缓存上限（超出按 LRU 驱逐）
const MAX_SOURCE_TEXTURE_CACHE = 16

function summarizeSources(sources) {
  const list = Array.isArray(sources) ? sources : []
  let active = 0
  let minIntensity = Number.POSITIVE_INFINITY
  let maxIntensity = Number.NEGATIVE_INFINITY
  let minRadius = Number.POSITIVE_INFINITY
  let maxRadius = Number.NEGATIVE_INFINITY
  for (const s of list) {
    const intensity = Number(s?.intensity)
    const radius = Number(s?.radius)
    if (Number.isFinite(intensity)) {
      minIntensity = Math.min(minIntensity, intensity)
      maxIntensity = Math.max(maxIntensity, intensity)
      if (intensity > 0) active += 1
    }
    if (Number.isFinite(radius)) {
      minRadius = Math.min(minRadius, radius)
      maxRadius = Math.max(maxRadius, radius)
    }
  }
  return {
    total: list.length,
    active,
    intensity: {
      min: Number.isFinite(minIntensity) ? minIntensity : null,
      max: Number.isFinite(maxIntensity) ? maxIntensity : null
    },
    radius: {
      min: Number.isFinite(minRadius) ? minRadius : null,
      max: Number.isFinite(maxRadius) ? maxRadius : null
    }
  }
}

export class TimeSeriesDomain {
  /** @param {import('./HeatmapManager.js').HeatmapManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
  }

  updateStressTime(model, timeIndex) {
    const entry = this.m.stressShaders.get(model)
    if (!entry) return
    const { shader, config, field, anchorToModel } = entry
    const safeTimeIndex = Number.isFinite(timeIndex) ? Math.max(0, Math.floor(timeIndex)) : 0
    const textureIndex =
      field.enabled && field.frameCount > 0 ? safeTimeIndex % field.frameCount : -1
    const hasSameFrame =
      entry.lastTimeIndex === safeTimeIndex && entry.lastFieldTextureIndex === textureIndex
    if (hasSameFrame) return
    const worldToLocal = anchorToModel ? resolveModelWorldToLocal(model) : null
    const updated = this.m.withTimeSeries(config, safeTimeIndex)
    const rawSources = Array.isArray(config.sources)
      ? config.sources.slice(0, MAX_SOURCE_COUNT)
      : []
    const resolveCenterMC = createModelCenterResolver(rawSources, worldToLocal)

    const useSourceTex = Boolean(updated.sourceTex?.enabled)
    const directSources = Array.isArray(updated.sourcesDirect) ? updated.sourcesDirect : []
    shader.setUniform('u_sourceCount', updated.sourceCount)
    if (useSourceTex) {
      if (!entry.sourceTextureCache) entry.sourceTextureCache = new Map()
      if (!Array.isArray(entry.sourceTextureOrder)) entry.sourceTextureOrder = []
      let srcTex = entry.sourceTextureCache.get(safeTimeIndex)
      if (!srcTex) {
        const srcForTex = anchorToModel
          ? updated.sources.map(s => ({ ...s, center: resolveCenterMC(s) }))
          : updated.sources
        srcTex = this.m.prepareSourceTexture(srcForTex)
        entry.sourceTextureCache.set(safeTimeIndex, srcTex)
        entry.sourceTextureOrder.push(safeTimeIndex)
        while (entry.sourceTextureOrder.length > MAX_SOURCE_TEXTURE_CACHE) {
          const staleIndex = entry.sourceTextureOrder.shift()
          if (!Number.isInteger(staleIndex) || staleIndex === safeTimeIndex) continue
          const staleTexture = entry.sourceTextureCache.get(staleIndex)
          entry.sourceTextureCache.delete(staleIndex)
          if (staleTexture) this.m.destroyTextureUniform(staleTexture)
        }
      } else if (entry.sourceTextureOrder.indexOf(safeTimeIndex) >= 0) {
        entry.sourceTextureOrder.splice(entry.sourceTextureOrder.indexOf(safeTimeIndex), 1)
        entry.sourceTextureOrder.push(safeTimeIndex)
      }
      shader.setUniform('u_useSourceTex', 1.0)
      shader.setUniform('u_sourceTex', srcTex.texture)
      shader.setUniform('u_sourceTexSize', srcTex.size)
    } else {
      const centersMC = anchorToModel
        ? directSources.map(resolveCenterMC)
        : directSources.map(() => new Cesium.Cartesian3(0, 0, 0))
      shader.setUniform('u_useSourceTex', 0.0)
      this.m.setSourceUniforms(shader, directSources, centersMC)
    }
    if (field.enabled && textureIndex >= 0) {
      const frameTexture = this.m.getOrCreateFieldFrameTexture(field, textureIndex)
      shader.setUniform('u_fieldTexture', frameTexture || this.m.getEmptyTexture())
    } else if (field.texture) {
      shader.setUniform('u_fieldTexture', field.texture)
    }
    entry.lastTimeIndex = safeTimeIndex
    entry.lastFieldTextureIndex = textureIndex
    if (this.m.viewer?.scene?.requestRender) {
      this.m.viewer.scene.requestRender()
    }

    if (this.m.debugEnabled()) {
      const now = Date.now()
      const prev = this.m.debugState.get(model) || { lastLogMs: 0, lastIndex: null }
      const debugWindow = getStressDebugWindow()
      const throttleMs =
        debugWindow && Number.isFinite(debugWindow.__STRESS_DEBUG_THROTTLE_MS__)
          ? Math.max(0, Number(debugWindow.__STRESS_DEBUG_THROTTLE_MS__))
          : 800
      if (prev.lastIndex !== safeTimeIndex && now - prev.lastLogMs >= throttleMs) {
        const stats = summarizeSources(updated.sources)
        this.m.debugLog('time', {
          timeIndex: safeTimeIndex,
          sourceCount: updated.sourceCount,
          useSourceTex,
          sources: stats,
          fieldEnabled: Boolean(field.enabled)
        })
        this.m.debugState.set(model, { lastLogMs: now, lastIndex: safeTimeIndex })
      }
    }
  }
}
