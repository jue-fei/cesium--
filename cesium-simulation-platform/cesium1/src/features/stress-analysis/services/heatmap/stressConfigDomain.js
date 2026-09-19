import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'
import { buildColorLUTSpecFromRamp, cloneColorRamp } from '../core/render/index.js'
import { STRESS_TURBO_RAMP_32 } from '../core/render/stressColormap.js'
import {
  MAX_SOURCE_COUNT,
  createModelCenterResolver,
  resolveModelWorldToLocal
} from './stressShared.js'
import {
  buildStressFragmentShader,
  buildStressShaderUniforms,
  createStressUniformEntries,
  prepareShaderSourceContext
} from './shaderBuilder.js'

/**
 * 应力配置域（StressConfigDomain）
 *
 * 从 HeatmapManager 拆出的"应力场配置"职责：
 *  - 锚定上下文解析（resolveAnchorContext / resolveFieldCenterMC）：模型锚定开关与
 *    worldToLocal 矩阵解析、场中心 MC 坐标推导；
 *  - 配置归一化（normalizeStressConfig）：色带/LUT 构建、混合模式映射、样式参数钳制、
 *    应力源排序切片与"源纹理/直传"双路径派生；
 *  - 时序派生（withTimeSeries）：按帧索引重算源强度/半径与直传切片；
 *  - 增量更新判据（canIncrementallyUpdate）与两条配置应用流程：
 *    applyStressConfig（经 shaderBuilder 构造着色器并挂载）与 updateStressConfig
 *    （增量 setUniform，复用 createStressUniformEntries 单源取值表）。
 * 经门面实例（this.m）访问共享状态（stressShaders、empty* 纹理、whiteModelEnabled、
 * viewer 等）与纹理/直传源 uniform 能力，自身不持有状态。
 */

function resolveAnchorContext(model, config) {
  let anchorToModel =
    config?.style?.anchorToModel === undefined ? true : Boolean(config.style.anchorToModel)
  const worldToLocal = anchorToModel ? resolveModelWorldToLocal(model) : null
  if (anchorToModel && !worldToLocal) anchorToModel = false
  return { anchorToModel, worldToLocal }
}

function resolveFieldCenterMC(config, anchorToModel, worldToLocal) {
  let fieldCenterMC = new Cesium.Cartesian3(0, 0, 0)
  try {
    if (!anchorToModel || !worldToLocal) return fieldCenterMC
    const origin = config?.field?.data?.origin || config?.field?.origin || null
    if (
      !(Array.isArray(origin) && origin.length >= 2 && origin.slice(0, 3).every(Number.isFinite))
    ) {
      return fieldCenterMC
    }
    const originWC = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
    fieldCenterMC = Cesium.Matrix4.multiplyByPoint(worldToLocal, originWC, new Cesium.Cartesian3())
  } catch (e) {
    warn('heatmap', 'HeatmapManager', e)
  }
  return fieldCenterMC
}

export class StressConfigDomain {
  /** @param {import('./HeatmapManager.js').HeatmapManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
  }

  applyStressConfig(model, config) {
    if (!model || !config) return
    const { anchorToModel, worldToLocal } = resolveAnchorContext(model, config)
    const normalized = this.normalizeStressConfig(config)
    const field = this.m.prepareField(config.field)
    const fieldCenterMC = resolveFieldCenterMC(config, anchorToModel, worldToLocal)
    const rawSources = Array.isArray(config.sources)
      ? config.sources.slice(0, MAX_SOURCE_COUNT)
      : []
    const resolveCenterMC = createModelCenterResolver(rawSources, worldToLocal)
    const sourceContext = prepareShaderSourceContext(
      this.m,
      normalized,
      anchorToModel,
      resolveCenterMC
    )
    this.m.debugLog('apply', {
      sourceCount: normalized.sourceCount,
      useSourceTex: sourceContext.useSourceTex,
      anchorToModel,
      blendMode: normalized.blendMode,
      cutoff: normalized.cutoff,
      forceVisible: normalized.forceVisible,
      lut: { enabled: Boolean(normalized.lut?.enabled), size: normalized.lut?.size },
      field: {
        enabled: Boolean(field.enabled),
        combine: field.combine,
        textureSize: field.textureSize,
        gridSize: field.gridSize,
        size: field.size
      }
    })
    const shader = new Cesium.CustomShader({
      uniforms: buildStressShaderUniforms({
        normalized,
        sourceUniforms: sourceContext.sourceUniforms,
        sourceTex: {
          enabled: sourceContext.useSourceTex,
          texture: sourceContext.sourceTex.texture,
          size: sourceContext.sourceTex.size
        },
        model,
        field,
        anchorToModel,
        fieldCenterMC,
        emptyTexture: this.m.getEmptyTexture()
      }),
      lightingModel: Cesium.LightingModel.PBR,
      fragmentShaderText: buildStressFragmentShader(
        sourceContext.maxShaderSources,
        sourceContext.sourceAccessor
      )
    })

    model.customShader = shader
    if (this.m.whiteModelEnabled) {
      shader.setUniform('u_whiteModel', 1.0)
    }
    this.m.stressShaders.set(model, {
      shader,
      config: normalized,
      field,
      anchorToModel,
      lastTimeIndex: null,
      lastFieldTextureIndex: null
    })
    if (this.m.viewer?.scene?.requestRender) {
      this.m.viewer.scene.requestRender()
    }
  }

  updateStressConfig(model, config) {
    const entry = this.m.stressShaders.get(model)
    if (!entry?.shader || !model || !config) return false
    let anchorToModel =
      config?.style?.anchorToModel === undefined ? true : Boolean(config.style.anchorToModel)
    const worldToLocal = anchorToModel ? resolveModelWorldToLocal(model) : null
    if (anchorToModel && !worldToLocal) anchorToModel = false
    const normalized = this.normalizeStressConfig(config)
    const field = this.m.prepareField(config.field)
    if (!this.canIncrementallyUpdate(entry, normalized, field, anchorToModel)) return false

    const shader = entry.shader
    const fieldCenterMC = resolveFieldCenterMC(config, anchorToModel, worldToLocal)

    const rawSources = Array.isArray(config.sources)
      ? config.sources.slice(0, MAX_SOURCE_COUNT)
      : []
    const resolveCenterMC = createModelCenterResolver(rawSources, worldToLocal)

    const useSourceTex = Boolean(normalized.sourceTex?.enabled)
    const directSources =
      !useSourceTex && Array.isArray(normalized.sourcesDirect) ? normalized.sourcesDirect : []
    const sourceCentersMC = anchorToModel
      ? directSources.map(resolveCenterMC)
      : directSources.map(() => new Cesium.Cartesian3(0, 0, 0))
    let sourceTex = this.m.getEmptySourceTexture()
    if (useSourceTex) {
      if (anchorToModel) {
        sourceTex = this.m.prepareSourceTexture(
          normalized.sources.map(s => ({ ...s, center: resolveCenterMC(s) }))
        )
      } else {
        sourceTex = normalized.sourceTex
      }
    }

    // 复用与 buildStressShaderUniforms 相同的 uniform 取值表，消除双源定义
    const uniformEntries = createStressUniformEntries({
      normalized,
      sourceTex,
      model,
      field,
      anchorToModel,
      fieldCenterMC,
      emptyTexture: this.m.getEmptyTexture()
    })
    for (const [name, , value] of uniformEntries) {
      shader.setUniform(name, value)
    }
    if (!useSourceTex) {
      this.m.setSourceUniforms(shader, directSources, sourceCentersMC)
    }

    const previousConfig = entry.config
    const previousField = entry.field
    entry.config = normalized
    entry.field = field
    entry.anchorToModel = anchorToModel
    entry.lastTimeIndex = null
    entry.lastFieldTextureIndex = null
    this.m.clearSourceTextureCache(entry)
    entry.sourceTextureOrder = []
    this.m.destroyConfigResources(previousConfig, previousField)
    if (this.m.viewer?.scene?.requestRender) {
      this.m.viewer.scene.requestRender()
    }
    return true
  }

  normalizeStressConfig(config) {
    const colorRamp = Array.isArray(config.colorRamp) ? config.colorRamp : []
    const fullRamp = colorRamp.length >= 4 ? colorRamp : cloneColorRamp(STRESS_TURBO_RAMP_32)

    // 始终使用 CIELAB 色彩空间从完整色带构建 LUT，消除 4 段降级路径
    const lutSpec = config.colorLUT
      ? config.colorLUT
      : buildColorLUTSpecFromRamp(fullRamp, { size: 256, colorSpace: 'cielab' })
    const lut = this.m.prepareColorLUT(lutSpec)

    const blendMap = { max: 0, add: 1, overlay: 2 }
    const blendMode = blendMap[config.blendMode] ?? 0

    const style = config.style || {}
    const diffuseMix = Number.isFinite(style.diffuseMix)
      ? Math.max(0, Math.min(1, style.diffuseMix))
      : 0.85
    const emissiveMix = Number.isFinite(style.emissiveMix)
      ? Math.max(0, Math.min(1, style.emissiveMix))
      : 0.7

    const cutoff = Number.isFinite(style.cutoff) ? Math.max(0, Math.min(0.95, style.cutoff)) : 0.02
    const fieldMaskMode = style.fieldMaskMode === 'points' ? 1.0 : 0.0
    const fieldMaskPower = Number.isFinite(style.fieldMaskPower)
      ? Math.max(0.1, style.fieldMaskPower)
      : 2.0
    const fieldEdgeFade = Number.isFinite(style.fieldEdgeFade)
      ? Math.max(0, Math.min(0.45, style.fieldEdgeFade))
      : 0.08

    const contourEnabled = style.contourEnabled ? 1.0 : 0.0
    const contourLevels = Number.isFinite(style.contourLevels)
      ? Math.max(2, style.contourLevels)
      : 24
    const contourWidth = Number.isFinite(style.contourWidth)
      ? Math.max(0.001, Math.min(0.12, style.contourWidth))
      : 0.015

    const glowEnabled = style.glowEnabled === undefined ? 0.0 : style.glowEnabled ? 1.0 : 0.0
    const glowThreshold = Number.isFinite(style.glowThreshold)
      ? Math.max(0, Math.min(1, style.glowThreshold))
      : 0.8
    const glowStrength = Number.isFinite(style.glowStrength)
      ? Math.max(0, Math.min(1, style.glowStrength))
      : 0.35

    const markerEnabled = style.markerEnabled === undefined ? 0.0 : style.markerEnabled ? 1.0 : 0.0
    const markerRadius = Number.isFinite(style.markerRadius) ? Math.max(0.1, style.markerRadius) : 6
    const forceVisible = Number.isFinite(style.forceVisible)
      ? Math.max(0, Math.min(1, Number(style.forceVisible)))
      : 0.35
    const lowRangeOpacity = Number.isFinite(style.lowRangeOpacity)
      ? Math.max(0, Math.min(0.6, Number(style.lowRangeOpacity)))
      : 0.18

    const maxSources = MAX_SOURCE_COUNT
    const selectTopSources = (list, limit) => {
      const arr = Array.isArray(list) ? list.slice() : []
      arr.sort((a, b) => {
        const ai = Number(a?.intensity) || 0
        const bi = Number(b?.intensity) || 0
        if (bi !== ai) return bi - ai
        const ar = Number(a?.radius) || 0
        const br = Number(b?.radius) || 0
        return br - ar
      })
      return arr.slice(0, limit)
    }
    const resolveCenterCartesian = s => {
      const c = s?.center
      if (
        c &&
        typeof c === 'object' &&
        Number.isFinite(c.x) &&
        Number.isFinite(c.y) &&
        Number.isFinite(c.z)
      ) {
        return new Cesium.Cartesian3(c.x, c.y, c.z)
      }
      const cc = s?.centerCartesian
      if (Array.isArray(cc) && cc.length >= 3 && cc.slice(0, 3).every(Number.isFinite)) {
        return new Cesium.Cartesian3(cc[0], cc[1], cc[2])
      }
      if (
        cc &&
        typeof cc === 'object' &&
        Number.isFinite(cc.x) &&
        Number.isFinite(cc.y) &&
        Number.isFinite(cc.z)
      ) {
        return new Cesium.Cartesian3(cc.x, cc.y, cc.z)
      }
      if (Array.isArray(c) && c.length >= 2 && c.slice(0, 3).every(Number.isFinite)) {
        return Cesium.Cartesian3.fromDegrees(c[0], c[1], c[2] || 0)
      }
      return new Cesium.Cartesian3(0, 0, 0)
    }
    const sources = (config.sources || []).slice(0, maxSources).map((s, idx) => ({
      idx,
      id: s.id || '',
      name: s.name || '',
      center: resolveCenterCartesian(s),
      radius: s.radius || 50,
      base: s.base ?? 1,
      timeSeries: Array.isArray(s.timeSeries) ? s.timeSeries : [],
      radiusSeries: Array.isArray(s.radiusSeries) ? s.radiusSeries : [],
      intensity: s.base ?? 1
    }))

    const directSourceLimitRaw = Number(style.sourceLimit)
    const directSourceLimit = Number.isFinite(directSourceLimitRaw)
      ? Math.max(1, Math.min(MAX_SOURCE_COUNT, Math.floor(directSourceLimitRaw)))
      : style.useSourceTexture
        ? MAX_SOURCE_COUNT
        : 4
    const useSourceTex =
      (Boolean(style.useSourceTexture) || directSourceLimit > 32) && sources.length > 16
    const sourcesDirect = useSourceTex ? [] : selectTopSources(sources, directSourceLimit)
    const sourceTex = useSourceTex
      ? this.m.prepareSourceTexture(sources)
      : this.m.getEmptySourceTexture()
    const sourceCount = useSourceTex ? sources.length : sourcesDirect.length

    return {
      lut,
      blendMode,
      sources,
      sourcesDirect,
      sourceCount,
      sourceTex,
      useSourceTex,
      directSourceLimit,
      diffuseMix,
      emissiveMix,
      cutoff,
      fieldMaskMode,
      fieldMaskPower,
      fieldEdgeFade,
      contourEnabled,
      contourLevels,
      contourWidth,
      glowEnabled,
      glowThreshold,
      glowStrength,
      markerEnabled,
      markerRadius,
      forceVisible,
      lowRangeOpacity,
      time: config.time || { frames: 1 }
    }
  }

  withTimeSeries(config, timeIndex) {
    const selectTopSources = (list, limit) => {
      const arr = Array.isArray(list) ? list.slice() : []
      arr.sort((a, b) => {
        const ai = Number(a?.intensity) || 0
        const bi = Number(b?.intensity) || 0
        if (bi !== ai) return bi - ai
        const ar = Number(a?.radius) || 0
        const br = Number(b?.radius) || 0
        return br - ar
      })
      return arr.slice(0, limit)
    }
    const sources = config.sources.map(s => {
      const factor = s.timeSeries[timeIndex] ?? 1
      const radius = Array.isArray(s.radiusSeries)
        ? Number(s.radiusSeries[timeIndex] ?? s.radius)
        : Number(s.radius)
      return {
        ...s,
        intensity: Math.max(0, Math.min(1, s.base * factor)),
        radius: Number.isFinite(radius) && radius > 0 ? radius : s.radius
      }
    })
    const sourceLimit = Number.isFinite(config?.directSourceLimit)
      ? Math.max(1, Math.min(MAX_SOURCE_COUNT, Math.floor(config.directSourceLimit)))
      : 4
    const useSourceTex = (Boolean(config?.useSourceTex) || sourceLimit > 32) && sources.length > 16
    const sourcesDirect = useSourceTex ? [] : selectTopSources(sources, sourceLimit)
    const sourceCount = useSourceTex ? sources.length : sourcesDirect.length
    return {
      ...config,
      sources,
      sourcesDirect,
      sourceCount,
      sourceTex: useSourceTex ? { enabled: true } : this.m.getEmptySourceTexture(),
      useSourceTex,
      directSourceLimit: sourceLimit
    }
  }

  canIncrementallyUpdate(entry, normalized, field, anchorToModel) {
    const previousConfig = entry?.config || null
    const previousField = entry?.field || null
    const previousUseSourceTex = Boolean(previousConfig?.useSourceTex)
    const nextUseSourceTex = Boolean(normalized?.useSourceTex)
    if (previousUseSourceTex !== nextUseSourceTex) return false
    if (!previousUseSourceTex) {
      const prevDirectCount = Array.isArray(previousConfig?.sourcesDirect)
        ? previousConfig.sourcesDirect.length
        : 0
      const nextDirectCount = Array.isArray(normalized?.sourcesDirect)
        ? normalized.sourcesDirect.length
        : 0
      if (prevDirectCount !== nextDirectCount) return false
    }
    if (Boolean(entry?.anchorToModel) !== Boolean(anchorToModel)) return false
    const prevFieldEnabled = Boolean(previousField?.enabled)
    const nextFieldEnabled = Boolean(field?.enabled)
    if (prevFieldEnabled !== nextFieldEnabled) return false
    if (prevFieldEnabled) {
      if (
        previousField?.combine !== field?.combine ||
        previousField?.textureSize?.x !== field?.textureSize?.x ||
        previousField?.textureSize?.y !== field?.textureSize?.y ||
        previousField?.gridSize?.x !== field?.gridSize?.x ||
        previousField?.gridSize?.y !== field?.gridSize?.y ||
        previousField?.gridSize?.z !== field?.gridSize?.z
      ) {
        return false
      }
    }
    return true
  }
}
