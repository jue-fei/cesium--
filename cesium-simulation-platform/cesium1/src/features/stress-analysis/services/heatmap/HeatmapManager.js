import { warn } from '@/utils/errorHandler.js'
import { isStressDebugEnabled, resolveModelWorldToLocal } from './stressShared.js'
import { StressConfigDomain } from './stressConfigDomain.js'
import { ShaderBuilder } from './shaderBuilder.js'
import { TextureLifecycle } from './textureLifecycle.js'
import { TimeSeriesDomain } from './timeSeriesDomain.js'

/**
 * 应力热力图管理器（门面）
 *
 * 职责拆分见 services/heatmap/ 各域文件；本文件保留对外公共 API（签名不变，
 * 一行委托）与跨域共享状态（stressShaders / empty* 纹理缓存 / debugState /
 * whiteModelEnabled）。导出的 stressDebugLog 供 useStress 等调用方直接使用。
 */

export function stressDebugLog(scope, title, payload) {
  if (!isStressDebugEnabled()) return
  const scopeText = String(scope || 'core')
  const titleText = String(title || 'log')
  try {
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[Stress:${scopeText}] ${titleText}`)
    // eslint-disable-next-line no-console
    if (payload !== undefined) console.log(payload)
    // eslint-disable-next-line no-console
    // eslint-disable-next-line no-console
    console.groupEnd()
  } catch (e) {
    warn('heatmap', 'HeatmapManager', e)
  }
}

// ─── 组合域对象（职责拆分，见 services/heatmap/）────────────────────
// HeatmapManager 保留为门面：公共 API 逐个保留（一行委托），具体职责由域对象承担——
//   · StressConfigDomain  应力配置域（stressConfigDomain.js）：配置归一化/校验/派生，
//                         首次应用与增量更新两条配置应用流程
//   · ShaderBuilder       着色器构造域（shaderBuilder.js）：源码拼装、uniform 表构建、
//                         直传源 uniform 与 getSource 访问器
//   · TextureLifecycle    纹理与资源生命周期域（textureLifecycle.js）：纹理创建/更新/
//                         销毁、LUT 与场纹理构建、值域统计
//   · TimeSeriesDomain    时序帧更新域（timeSeriesDomain.js）：updateStressTime 逐帧驱动
// 域对象懒创建并缓存在实例字段上（不占原型成员）：兼容测试用
// Object.create(HeatmapManager.prototype) 裸实例（不运行构造函数），首次委托时才创建；
// 域对象经 this.m 反向访问门面共享状态，域间互不引用；跨域共享纯函数见 stressShared.js。
function domainOf(mgr, slot, Ctor) {
  return mgr[slot] || (mgr[slot] = new Ctor(mgr))
}

export class HeatmapManager {
  constructor(viewer) {
    this.viewer = viewer
    this.stressShaders = new Map()
    this.emptyTexture = null
    this.emptyColorLUTTexture = null
    this.emptySourceTexture = null
    this.debugState = new Map()
    this.whiteModelEnabled = false
  }

  debugEnabled() {
    return isStressDebugEnabled()
  }

  debugLog(title, payload) {
    stressDebugLog('heatmap', title, payload)
  }

  applyStressConfig(model, config) {
    return domainOf(this, '_stressConfig', StressConfigDomain).applyStressConfig(model, config)
  }

  updateStressConfig(model, config) {
    return domainOf(this, '_stressConfig', StressConfigDomain).updateStressConfig(model, config)
  }

  updateStressTime(model, timeIndex) {
    return domainOf(this, '_timeSeries', TimeSeriesDomain).updateStressTime(model, timeIndex)
  }

  clearStress(model) {
    if (!model) return
    const entry = this.stressShaders.get(model)
    this.destroyStressResources(entry)
    model.customShader = null
    this.stressShaders.delete(model)
    this.debugState.delete(model)
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  clearAllStress() {
    for (const [model, entry] of this.stressShaders.entries()) {
      if (!model) continue
      this.destroyStressResources(entry)
      model.customShader = null
    }
    this.stressShaders.clear()
    this.debugState.clear()
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  setWhiteModel(model, enabled) {
    this.whiteModelEnabled = !!enabled
    const entry = this.stressShaders.get(model)
    if (entry?.shader) {
      entry.shader.setUniform('u_whiteModel', this.whiteModelEnabled ? 1.0 : 0.0)
    }
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  getWhiteModel() {
    return this.whiteModelEnabled
  }

  destroyTextureUniform(textureUniform) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).destroyTextureUniform(
      textureUniform
    )
  }

  clearSourceTextureCache(entry) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).clearSourceTextureCache(entry)
  }

  destroyStressResources(entry) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).destroyStressResources(entry)
  }

  destroyConfigResources(config, field) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).destroyConfigResources(
      config,
      field
    )
  }

  getEmptySourceTexture() {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).getEmptySourceTexture()
  }

  normalizeStressConfig(config) {
    return domainOf(this, '_stressConfig', StressConfigDomain).normalizeStressConfig(config)
  }

  withTimeSeries(config, timeIndex) {
    return domainOf(this, '_stressConfig', StressConfigDomain).withTimeSeries(config, timeIndex)
  }

  prepareSourceTexture(sources) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).prepareSourceTexture(sources)
  }

  canIncrementallyUpdate(entry, normalized, field, anchorToModel) {
    return domainOf(this, '_stressConfig', StressConfigDomain).canIncrementallyUpdate(
      entry,
      normalized,
      field,
      anchorToModel
    )
  }

  static createMutableIdentityMatrix() {
    return TextureLifecycle.createMutableIdentityMatrix()
  }

  prepareField(field) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).prepareField(field)
  }

  getOrCreateFieldFrameTexture(field, frameIndex) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).getOrCreateFieldFrameTexture(
      field,
      frameIndex
    )
  }

  bumpFieldFrameTextureOrder(field, frameIndex) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).bumpFieldFrameTextureOrder(
      field,
      frameIndex
    )
  }

  computeWorldToLocal(origin) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).computeWorldToLocal(origin)
  }

  buildSourceUniforms(sources, sourceCentersMC) {
    return domainOf(this, '_shaderBuilder', ShaderBuilder).buildSourceUniforms(
      sources,
      sourceCentersMC
    )
  }

  setSourceUniforms(shader, sources, sourceCentersMC) {
    return domainOf(this, '_shaderBuilder', ShaderBuilder).setSourceUniforms(
      shader,
      sources,
      sourceCentersMC
    )
  }

  buildSourceAccessorShader(sourceCount) {
    return domainOf(this, '_shaderBuilder', ShaderBuilder).buildSourceAccessorShader(sourceCount)
  }

  resolveModelWorldToLocal(model) {
    return resolveModelWorldToLocal(model)
  }

  createFieldTexture(values, grid, valueRange) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).createFieldTexture(
      values,
      grid,
      valueRange
    )
  }

  getEmptyTexture() {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).getEmptyTexture()
  }

  getEmptyColorLUTTexture() {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).getEmptyColorLUTTexture()
  }

  prepareColorLUT(spec) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).prepareColorLUT(spec)
  }

  jetRGB(t) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).jetRGB(t)
  }

  rainbowRGB(t) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).rainbowRGB(t)
  }

  normalizeRange(values, valueRange, mapper = null) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).normalizeRange(
      values,
      valueRange,
      mapper
    )
  }

  computeSkewness(arr) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).computeSkewness(arr)
  }

  computeRobustRange(values, mapper = null, quantileOpts = null) {
    return domainOf(this, '_textureLifecycle', TextureLifecycle).computeRobustRange(
      values,
      mapper,
      quantileOpts
    )
  }
}
