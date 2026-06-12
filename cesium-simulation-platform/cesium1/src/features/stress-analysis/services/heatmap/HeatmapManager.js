import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'
import { buildColorLUTSpecFromRamp, cloneColorRamp } from '../core/render/index.js'
import { STRESS_TURBO_RAMP_32 } from '../core/render/stressColormap.js'

/**
 * @typedef {{
 *   __STRESS_DEBUG__?: boolean,
 *   __STRESS_DEBUG_THROTTLE_MS__?: number
 * }} StressDebugWindow
 */

/**
 * @returns {StressDebugWindow | null}
 */
function getStressDebugWindow() {
  if (typeof window === 'undefined') return null
  return /** @type {StressDebugWindow} */ (window)
}

function isStressDebugEnabled() {
  try {
    const debugWindow = getStressDebugWindow()
    if (!debugWindow) return false
    return debugWindow.__STRESS_DEBUG__ !== undefined
      ? Boolean(debugWindow.__STRESS_DEBUG__)
      : false
  } catch (e) {
    return false
  }
}

const clamp01 = v => Math.max(0, Math.min(1, v))

const MAX_FIELD_FRAME_TEXTURE_CACHE = 16
const MAX_SOURCE_TEXTURE_CACHE = 16

export function stressDebugLog(scope, title, payload) {
  if (!isStressDebugEnabled()) return
  const scopeText = String(scope || 'core')
  const titleText = String(title || 'log')
  try {
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[Stress:${scopeText}] ${titleText}`)
    // eslint-disable-next-line no-console
    // eslint-disable-next-line no-console
    console.groupEnd()
  } catch (e) {
    warn('heatmap', 'HeatmapManager', e)
  }
}

export class HeatmapManager {
  constructor(viewer) {
    this.viewer = viewer
    this.stressShaders = new Map()
    this.emptyTexture = null
    this.emptyColorLUTTexture = null
    this.emptySourceTexture = null
    this.debugState = new Map()
  }

  debugEnabled() {
    return isStressDebugEnabled()
  }

  debugLog(title, payload) {
    stressDebugLog('heatmap', title, payload)
  }

  applyStressConfig(model, config) {
    if (!model || !config) return

    let anchorToModel =
      config?.style?.anchorToModel === undefined ? true : Boolean(config.style.anchorToModel)
    const worldToLocal = anchorToModel ? this.resolveModelWorldToLocal(model) : null
    if (anchorToModel && !worldToLocal) anchorToModel = false

    const normalized = this.normalizeStressConfig(config)
    const field = this.prepareField(config.field)
    let fieldCenterMC = new Cesium.Cartesian3(0, 0, 0)
    try {
      if (anchorToModel && worldToLocal) {
        const origin = config?.field?.data?.origin || config?.field?.origin || null
        if (
          Array.isArray(origin) &&
          origin.length >= 2 &&
          origin.slice(0, 3).every(Number.isFinite)
        ) {
          const originWC = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
          fieldCenterMC = Cesium.Matrix4.multiplyByPoint(
            worldToLocal,
            originWC,
            new Cesium.Cartesian3()
          )
        }
      }
    } catch (e) {
      warn('heatmap', 'HeatmapManager', e)
    }
    const rawSources = Array.isArray(config.sources) ? config.sources.slice(0, 1000) : []
    const resolveCenterMC = s => {
      const idx = Number.isInteger(s?.idx) && s.idx >= 0 ? s.idx : null
      const raw = idx !== null ? rawSources[idx] : null
      const stored = raw?.centerMC ?? raw?.centerMc ?? raw?.center_model ?? null
      if (
        stored &&
        typeof stored === 'object' &&
        Number.isFinite(stored.x) &&
        Number.isFinite(stored.y) &&
        Number.isFinite(stored.z)
      ) {
        return new Cesium.Cartesian3(stored.x, stored.y, stored.z)
      }
      if (
        Array.isArray(stored) &&
        stored.length >= 3 &&
        stored.slice(0, 3).every(Number.isFinite)
      ) {
        return new Cesium.Cartesian3(stored[0], stored[1], stored[2])
      }
      if (!worldToLocal) return new Cesium.Cartesian3(0, 0, 0)
      const computed = Cesium.Matrix4.multiplyByPoint(
        worldToLocal,
        s?.center || new Cesium.Cartesian3(0, 0, 0),
        new Cesium.Cartesian3()
      )
      if (raw && stored === null) {
        raw.centerMC = { x: computed.x, y: computed.y, z: computed.z }
      }
      return computed
    }
    const useSourceTex = Boolean(normalized.sourceTex?.enabled)
    const directSources =
      !useSourceTex && Array.isArray(normalized.sourcesDirect) ? normalized.sourcesDirect : []
    const sourceCentersMC = anchorToModel
      ? directSources.map(resolveCenterMC)
      : directSources.map(() => new Cesium.Cartesian3(0, 0, 0))
    const sourceUniforms = useSourceTex
      ? {}
      : this.buildSourceUniforms(directSources, sourceCentersMC)
    const sourceAccessor = this.buildSourceAccessorShader(directSources.length)
    let sourceTex = this.getEmptySourceTexture()
    if (useSourceTex) {
      if (anchorToModel) {
        sourceTex = this.prepareSourceTexture(
          normalized.sources.map(s => ({ ...s, center: resolveCenterMC(s) }))
        )
      } else {
        sourceTex = normalized.sourceTex
      }
    }
    const maxShaderSources = useSourceTex ? 1000 : Math.max(1, directSources.length)
    this.debugLog('apply', {
      sourceCount: normalized.sourceCount,
      useSourceTex,
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
      uniforms: {
        u_lutTexture: { type: Cesium.UniformType.SAMPLER_2D, value: normalized.lut.texture },
        u_lutSize: { type: Cesium.UniformType.FLOAT, value: normalized.lut.size },
        u_useSourceTex: { type: Cesium.UniformType.FLOAT, value: useSourceTex ? 1.0 : 0.0 },
        u_sourceTex: { type: Cesium.UniformType.SAMPLER_2D, value: sourceTex.texture },
        u_sourceTexSize: { type: Cesium.UniformType.VEC2, value: sourceTex.size },
        u_cutoff: { type: Cesium.UniformType.FLOAT, value: normalized.cutoff },
        u_fieldMaskMode: { type: Cesium.UniformType.FLOAT, value: normalized.fieldMaskMode },
        u_fieldMaskPower: { type: Cesium.UniformType.FLOAT, value: normalized.fieldMaskPower },
        u_markerEnabled: { type: Cesium.UniformType.FLOAT, value: normalized.markerEnabled },
        u_markerRadius: { type: Cesium.UniformType.FLOAT, value: normalized.markerRadius },
        u_contourEnabled: { type: Cesium.UniformType.FLOAT, value: normalized.contourEnabled },
        u_contourLevels: { type: Cesium.UniformType.FLOAT, value: normalized.contourLevels },
        u_contourWidth: { type: Cesium.UniformType.FLOAT, value: normalized.contourWidth },
        u_glowEnabled: { type: Cesium.UniformType.FLOAT, value: normalized.glowEnabled },
        u_glowThreshold: { type: Cesium.UniformType.FLOAT, value: normalized.glowThreshold },
        u_glowStrength: { type: Cesium.UniformType.FLOAT, value: normalized.glowStrength },
        u_anchorToModel: { type: Cesium.UniformType.FLOAT, value: anchorToModel ? 1.0 : 0.0 },
        u_diffuseMix: { type: Cesium.UniformType.FLOAT, value: normalized.diffuseMix },
        u_emissiveMix: { type: Cesium.UniformType.FLOAT, value: normalized.emissiveMix },
        u_blendMode: { type: Cesium.UniformType.FLOAT, value: normalized.blendMode },
        u_forceVisible: { type: Cesium.UniformType.FLOAT, value: normalized.forceVisible },
        u_lowRangeOpacity: { type: Cesium.UniformType.FLOAT, value: normalized.lowRangeOpacity },
        u_modelRadius: {
          type: Cesium.UniformType.FLOAT,
          value: Number(model?.boundingSphere?.radius) || 1.0
        },
        u_sourceCount: { type: Cesium.UniformType.FLOAT, value: normalized.sourceCount },
        ...sourceUniforms,
        u_fieldEnabled: { type: Cesium.UniformType.FLOAT, value: field.enabled ? 1.0 : 0.0 },
        u_fieldCombine: { type: Cesium.UniformType.FLOAT, value: field.combine },
        u_fieldTexture: { type: Cesium.UniformType.SAMPLER_2D, value: field.texture },
        u_fieldTexSize: { type: Cesium.UniformType.VEC2, value: field.textureSize },
        u_fieldGridSize: { type: Cesium.UniformType.VEC3, value: field.gridSize },
        u_fieldEdgeFade: { type: Cesium.UniformType.FLOAT, value: normalized.fieldEdgeFade },
        u_fieldSize: { type: Cesium.UniformType.VEC3, value: field.size },
        u_fieldWorldToLocal: { type: Cesium.UniformType.MAT4, value: field.worldToLocal },
        u_fieldCenter_mc: { type: Cesium.UniformType.VEC3, value: fieldCenterMC }
      },
      lightingModel: Cesium.LightingModel.PBR,
      fragmentShaderText: `
        const int MAX_SOURCES = ${maxShaderSources};

        float computeContribution(vec3 pos, vec3 center, float radius, float intensity) {
          float dist = distance(pos, center);
          float base = 1.0 - smoothstep(0.0, radius, dist);
          return clamp(base * intensity, 0.0, 1.0);
        }

        float blendValue(float acc, float v, float mode) {
          if (mode < 0.5) {
            return max(acc, v);
          }
          if (mode < 1.5) {
            return clamp(acc + v, 0.0, 1.0);
          }
          float overlay = acc < 0.5 ? (2.0 * acc * v) : (1.0 - 2.0 * (1.0 - acc) * (1.0 - v));
          return clamp(overlay, 0.0, 1.0);
        }

        vec3 mapColor(float v) {
          float size = max(2.0, u_lutSize);
          float u = (clamp(v, 0.0, 1.0) * (size - 1.0) + 0.5) / size;
          return texture(u_lutTexture, vec2(u, 0.5)).rgb;
        }

        ${sourceAccessor}

        vec4 sampleSourceRow(float index, float row) {
          vec2 size = max(vec2(1.0), u_sourceTexSize);
          float u = (index + 0.5) / size.x;
          float v = (row + 0.5) / size.y;
          return texture(u_sourceTex, vec2(u, v));
        }

        float sampleField(vec3 positionWC, vec3 positionMC) {
          vec4 localPos = u_anchorToModel > 0.5 ? vec4(positionMC - u_fieldCenter_mc, 1.0) : (u_fieldWorldToLocal * vec4(positionWC, 1.0));
          vec3 p = localPos.xyz + u_fieldSize * 0.5;
          vec3 uvw = p / max(u_fieldSize, vec3(0.0001));
          if (uvw.x < 0.0 || uvw.y < 0.0 || uvw.z < 0.0 || uvw.x > 1.0 || uvw.y > 1.0 || uvw.z > 1.0) {
            return 0.0;
          }

          vec3 grid = u_fieldGridSize - vec3(1.0);
          vec3 g = uvw * grid;
          vec3 g0 = floor(g);
          vec3 f = fract(g);

          float texWidth = u_fieldTexSize.x;
          float texHeight = u_fieldTexSize.y;

          float sliceWidth = u_fieldGridSize.x;
          float x0 = g0.x;
          float y0 = g0.y;
          float z0 = g0.z;
          float x1 = min(x0 + 1.0, u_fieldGridSize.x - 1.0);
          float y1 = min(y0 + 1.0, u_fieldGridSize.y - 1.0);
          float z1 = min(z0 + 1.0, u_fieldGridSize.z - 1.0);

          float u00 = (x0 + z0 * sliceWidth + 0.5) / texWidth;
          float v00 = (y0 + 0.5) / texHeight;
          float u10 = (x1 + z0 * sliceWidth + 0.5) / texWidth;
          float v10 = (y1 + 0.5) / texHeight;
          float u01 = (x0 + z1 * sliceWidth + 0.5) / texWidth;
          float v01 = v00;
          float u11 = (x1 + z1 * sliceWidth + 0.5) / texWidth;
          float v11 = v10;

          float v000 = texture(u_fieldTexture, vec2(u00, v00)).r;
          float v100 = texture(u_fieldTexture, vec2(u10, v00)).r;
          float v010 = texture(u_fieldTexture, vec2(u00, v10)).r;
          float v110 = texture(u_fieldTexture, vec2(u10, v10)).r;
          float v001 = texture(u_fieldTexture, vec2(u01, v01)).r;
          float v101 = texture(u_fieldTexture, vec2(u11, v01)).r;
          float v011 = texture(u_fieldTexture, vec2(u01, v11)).r;
          float v111 = texture(u_fieldTexture, vec2(u11, v11)).r;

          float v00x = mix(v000, v100, f.x);
          float v01x = mix(v010, v110, f.x);
          float v10x = mix(v001, v101, f.x);
          float v11x = mix(v011, v111, f.x);

          float v0 = mix(v00x, v01x, f.y);
          float v1 = mix(v10x, v11x, f.y);
          float sampled = mix(v0, v1, f.z);
          float fadeWidth = 0.0;
          if (fadeWidth <= 0.0001) {
            return sampled;
          }
          float edgeDist = min(
            min(min(uvw.x, 1.0 - uvw.x), min(uvw.y, 1.0 - uvw.y)),
            min(uvw.z, 1.0 - uvw.z)
          );
          float edgeFade = smoothstep(0.0, fadeWidth, max(0.0, edgeDist));
          return sampled * edgeFade;
        }

        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          vec3 positionWC = fsInput.attributes.positionWC;
          vec3 positionMC = fsInput.attributes.positionMC;
          float sourcesAcc = 0.0;

          float dMin = 1e30;
          float mask = 0.0;

          if (u_fieldEnabled < 0.5 || u_fieldCombine >= 0.5) {
            for (int i = 0; i < MAX_SOURCES; i++) {
              float fi = float(i);
              if (fi + 0.5 > u_sourceCount) {
                continue;
              }
              vec3 cWC;
              vec3 cMC;
              float radius;
              float intensity;
              if (u_useSourceTex > 0.5) {
                vec4 r0 = sampleSourceRow(fi, 0.0);
                vec4 r1 = sampleSourceRow(fi, 1.0);
                cWC = r0.xyz;
                cMC = r0.xyz;
                radius = r0.w;
                intensity = r1.x;
              } else {
                getSource(i, cWC, cMC, radius, intensity);
              }
              vec3 c = u_anchorToModel > 0.5 ? cMC : cWC;
              vec3 samplePos = u_anchorToModel > 0.5 ? positionMC : positionWC;
              float r = max(0.0001, radius);
              float dist = distance(samplePos, c);
              float base = 1.0 - smoothstep(0.0, r, dist);
              dMin = min(dMin, dist);
              mask = max(mask, base);
              float v = clamp(base * clamp(intensity, 0.0, 1.0), 0.0, 1.0);
              sourcesAcc = blendValue(sourcesAcc, v, u_blendMode);
            }
          }

          mask = pow(clamp(mask, 0.0, 1.0), max(0.1, u_fieldMaskPower));

          float fieldValue = 0.0;
          if (u_fieldEnabled > 0.5) {
            fieldValue = sampleField(positionWC, positionMC);
            if (u_fieldMaskMode > 0.5) {
              fieldValue = fieldValue * mask;
            }
          }

          float acc = sourcesAcc;
          if (u_fieldCombine < 0.5) {
            acc = fieldValue;
          } else if (u_fieldCombine < 1.5) {
            acc = max(acc, fieldValue);
          } else {
            acc = clamp(acc + fieldValue, 0.0, 1.0);
          }

          // 应力值与颜色严格一一对应：displayW = colorW = acc（无 cutoff、无可视增强）
          float colorW = clamp(acc, 0.0, 1.0);
          float displayW = colorW;

          vec3 heatColor = mapColor(colorW);
          material.diffuse = mix(material.diffuse, heatColor, displayW * u_diffuseMix);

          float glow = 0.0;
          if (u_glowEnabled > 0.5) {
            glow = smoothstep(clamp(u_glowThreshold, 0.0, 1.0), 1.0, displayW) * clamp(u_glowStrength, 0.0, 1.0);
          }

          float emissiveW = clamp(displayW * u_emissiveMix + glow, 0.0, 1.0);
          material.emissive = mix(material.emissive, heatColor, emissiveW);

          if (u_contourEnabled > 0.5) {
            float levels = max(2.0, u_contourLevels);
            float f = abs(fract(displayW * levels) - 0.5);
            float lineW = clamp(u_contourWidth, 0.001, 0.12);
            float pixelAA = max(fwidth(f), 1e-7);
            float line = 1.0 - smoothstep(lineW, lineW + pixelAA, f);
            material.emissive = mix(material.emissive, vec3(1.0), line * 0.35 * displayW);
          }

          if (u_markerEnabled > 0.5) {
            float r = max(0.1, u_markerRadius);
            float core = 1.0 - smoothstep(0.0, r, dMin);
            material.emissive = mix(material.emissive, vec3(1.0), core);
          }
        }
      `
    })

    model.customShader = shader
    this.stressShaders.set(model, {
      shader,
      config: normalized,
      field,
      anchorToModel,
      lastTimeIndex: null,
      lastFieldTextureIndex: null
    })
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  updateStressConfig(model, config) {
    const entry = this.stressShaders.get(model)
    if (!entry?.shader || !model || !config) return false
    let anchorToModel =
      config?.style?.anchorToModel === undefined ? true : Boolean(config.style.anchorToModel)
    const worldToLocal = anchorToModel ? this.resolveModelWorldToLocal(model) : null
    if (anchorToModel && !worldToLocal) anchorToModel = false
    const normalized = this.normalizeStressConfig(config)
    const field = this.prepareField(config.field)
    if (!this.canIncrementallyUpdate(entry, normalized, field, anchorToModel)) return false

    const shader = entry.shader
    let fieldCenterMC = new Cesium.Cartesian3(0, 0, 0)
    try {
      if (anchorToModel && worldToLocal) {
        const origin = config?.field?.data?.origin || config?.field?.origin || null
        if (
          Array.isArray(origin) &&
          origin.length >= 2 &&
          origin.slice(0, 3).every(Number.isFinite)
        ) {
          const originWC = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
          fieldCenterMC = Cesium.Matrix4.multiplyByPoint(
            worldToLocal,
            originWC,
            new Cesium.Cartesian3()
          )
        }
      }
    } catch (e) {
      warn('heatmap', 'HeatmapManager', e)
    }

    const rawSources = Array.isArray(config.sources) ? config.sources.slice(0, 1000) : []
    const resolveCenterMC = s => {
      const idx = Number.isInteger(s?.idx) && s.idx >= 0 ? s.idx : null
      const raw = idx !== null ? rawSources[idx] : null
      const stored = raw?.centerMC ?? raw?.centerMc ?? raw?.center_model ?? null
      if (
        stored &&
        typeof stored === 'object' &&
        Number.isFinite(stored.x) &&
        Number.isFinite(stored.y) &&
        Number.isFinite(stored.z)
      ) {
        return new Cesium.Cartesian3(stored.x, stored.y, stored.z)
      }
      if (
        Array.isArray(stored) &&
        stored.length >= 3 &&
        stored.slice(0, 3).every(Number.isFinite)
      ) {
        return new Cesium.Cartesian3(stored[0], stored[1], stored[2])
      }
      if (!worldToLocal) return new Cesium.Cartesian3(0, 0, 0)
      const computed = Cesium.Matrix4.multiplyByPoint(
        worldToLocal,
        s?.center || new Cesium.Cartesian3(0, 0, 0),
        new Cesium.Cartesian3()
      )
      if (raw && stored === null) raw.centerMC = { x: computed.x, y: computed.y, z: computed.z }
      return computed
    }

    const useSourceTex = Boolean(normalized.sourceTex?.enabled)
    const directSources =
      !useSourceTex && Array.isArray(normalized.sourcesDirect) ? normalized.sourcesDirect : []
    const sourceCentersMC = anchorToModel
      ? directSources.map(resolveCenterMC)
      : directSources.map(() => new Cesium.Cartesian3(0, 0, 0))
    let sourceTex = this.getEmptySourceTexture()
    if (useSourceTex) {
      if (anchorToModel) {
        sourceTex = this.prepareSourceTexture(
          normalized.sources.map(s => ({ ...s, center: resolveCenterMC(s) }))
        )
      } else {
        sourceTex = normalized.sourceTex
      }
    }

    shader.setUniform('u_lutTexture', normalized.lut.texture)
    shader.setUniform('u_lutSize', normalized.lut.size)
    shader.setUniform('u_useSourceTex', useSourceTex ? 1.0 : 0.0)
    shader.setUniform('u_sourceTex', sourceTex.texture)
    shader.setUniform('u_sourceTexSize', sourceTex.size)
    shader.setUniform('u_cutoff', normalized.cutoff)
    shader.setUniform('u_fieldMaskMode', normalized.fieldMaskMode)
    shader.setUniform('u_fieldMaskPower', normalized.fieldMaskPower)
    shader.setUniform('u_markerEnabled', normalized.markerEnabled)
    shader.setUniform('u_markerRadius', normalized.markerRadius)
    shader.setUniform('u_contourEnabled', normalized.contourEnabled)
    shader.setUniform('u_contourLevels', normalized.contourLevels)
    shader.setUniform('u_contourWidth', normalized.contourWidth)
    shader.setUniform('u_glowEnabled', normalized.glowEnabled)
    shader.setUniform('u_glowThreshold', normalized.glowThreshold)
    shader.setUniform('u_glowStrength', normalized.glowStrength)
    shader.setUniform('u_anchorToModel', anchorToModel ? 1.0 : 0.0)
    shader.setUniform('u_diffuseMix', normalized.diffuseMix)
    shader.setUniform('u_emissiveMix', normalized.emissiveMix)
    shader.setUniform('u_blendMode', normalized.blendMode)
    shader.setUniform('u_forceVisible', normalized.forceVisible)
    shader.setUniform('u_lowRangeOpacity', normalized.lowRangeOpacity)
    shader.setUniform('u_sourceCount', normalized.sourceCount)
    if (!useSourceTex) {
      this.setSourceUniforms(shader, directSources, sourceCentersMC)
    }
    shader.setUniform('u_fieldEnabled', field.enabled ? 1.0 : 0.0)
    shader.setUniform('u_fieldCombine', field.combine)
    shader.setUniform('u_fieldTexture', field.texture || this.getEmptyTexture())
    shader.setUniform('u_fieldTexSize', field.textureSize)
    shader.setUniform('u_fieldGridSize', field.gridSize)
    shader.setUniform('u_fieldEdgeFade', normalized.fieldEdgeFade)
    shader.setUniform('u_fieldSize', field.size)
    shader.setUniform('u_fieldWorldToLocal', field.worldToLocal)
    shader.setUniform('u_fieldCenter_mc', fieldCenterMC)

    const previousConfig = entry.config
    const previousField = entry.field
    entry.config = normalized
    entry.field = field
    entry.anchorToModel = anchorToModel
    entry.lastTimeIndex = null
    entry.lastFieldTextureIndex = null
    if (entry.sourceTextureCache instanceof Map) {
      for (const tex of entry.sourceTextureCache.values()) {
        if (tex && tex !== this.emptySourceTexture?.texture) {
          this.destroyTextureUniform(tex)
        }
      }
      entry.sourceTextureCache.clear()
    }
    entry.sourceTextureOrder = []
    this.destroyConfigResources(previousConfig, previousField)
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
    return true
  }

  updateStressTime(model, timeIndex) {
    const entry = this.stressShaders.get(model)
    if (!entry) return
    const { shader, config, field, anchorToModel } = entry
    const safeTimeIndex = Number.isFinite(timeIndex) ? Math.max(0, Math.floor(timeIndex)) : 0
    const textureIndex =
      field.enabled && field.frameCount > 0 ? safeTimeIndex % field.frameCount : -1
    const hasSameFrame =
      entry.lastTimeIndex === safeTimeIndex && entry.lastFieldTextureIndex === textureIndex
    if (hasSameFrame) return
    const worldToLocal = anchorToModel ? this.resolveModelWorldToLocal(model) : null
    const updated = this.withTimeSeries(config, safeTimeIndex)
    const rawSources = Array.isArray(config.sources) ? config.sources.slice(0, 1000) : []
    const resolveCenterMC = s => {
      const idx = Number.isInteger(s?.idx) && s.idx >= 0 ? s.idx : null
      const raw = idx !== null ? rawSources[idx] : null
      const stored = raw?.centerMC ?? raw?.centerMc ?? raw?.center_model ?? null
      if (
        stored &&
        typeof stored === 'object' &&
        Number.isFinite(stored.x) &&
        Number.isFinite(stored.y) &&
        Number.isFinite(stored.z)
      ) {
        return new Cesium.Cartesian3(stored.x, stored.y, stored.z)
      }
      if (
        Array.isArray(stored) &&
        stored.length >= 3 &&
        stored.slice(0, 3).every(Number.isFinite)
      ) {
        return new Cesium.Cartesian3(stored[0], stored[1], stored[2])
      }
      if (!worldToLocal) return new Cesium.Cartesian3(0, 0, 0)
      const computed = Cesium.Matrix4.multiplyByPoint(
        worldToLocal,
        s?.center || new Cesium.Cartesian3(0, 0, 0),
        new Cesium.Cartesian3()
      )
      if (raw && stored === null) {
        raw.centerMC = { x: computed.x, y: computed.y, z: computed.z }
      }
      return computed
    }

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
        srcTex = this.prepareSourceTexture(srcForTex)
        entry.sourceTextureCache.set(safeTimeIndex, srcTex)
        entry.sourceTextureOrder.push(safeTimeIndex)
        while (entry.sourceTextureOrder.length > MAX_SOURCE_TEXTURE_CACHE) {
          const staleIndex = entry.sourceTextureOrder.shift()
          if (!Number.isInteger(staleIndex) || staleIndex === safeTimeIndex) continue
          const staleTexture = entry.sourceTextureCache.get(staleIndex)
          entry.sourceTextureCache.delete(staleIndex)
          if (staleTexture) this.destroyTextureUniform(staleTexture)
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
      this.setSourceUniforms(shader, directSources, centersMC)
    }
    if (field.enabled && textureIndex >= 0) {
      const frameTexture = this.getOrCreateFieldFrameTexture(field, textureIndex)
      shader.setUniform('u_fieldTexture', frameTexture || this.getEmptyTexture())
    } else if (field.texture) {
      shader.setUniform('u_fieldTexture', field.texture)
    }
    entry.lastTimeIndex = safeTimeIndex
    entry.lastFieldTextureIndex = textureIndex
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }

    if (this.debugEnabled()) {
      const now = Date.now()
      const prev = this.debugState.get(model) || { lastLogMs: 0, lastIndex: null }
      const debugWindow = getStressDebugWindow()
      const throttleMs =
        debugWindow && Number.isFinite(debugWindow.__STRESS_DEBUG_THROTTLE_MS__)
          ? Math.max(0, Number(debugWindow.__STRESS_DEBUG_THROTTLE_MS__))
          : 800
      if (prev.lastIndex !== safeTimeIndex && now - prev.lastLogMs >= throttleMs) {
        const stats = summarizeSources(updated.sources)
        this.debugLog('time', {
          timeIndex: safeTimeIndex,
          sourceCount: updated.sourceCount,
          useSourceTex,
          sources: stats,
          fieldEnabled: Boolean(field.enabled)
        })
        this.debugState.set(model, { lastLogMs: now, lastIndex: safeTimeIndex })
      }
    }
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

  destroyTextureUniform(textureUniform) {
    if (!textureUniform || typeof textureUniform.destroy !== 'function') return
    try {
      textureUniform.destroy()
    } catch (e) {
      warn('heatmap', 'HeatmapManager', e)
    }
  }

  destroyStressResources(entry) {
    if (!entry) return
    const { shader, config, field } = entry
    if (shader && typeof shader.destroy === 'function') {
      try {
        shader.destroy()
      } catch (e) {
        warn('heatmap', 'HeatmapManager', e)
      }
    }
    const lutTexture = config?.lut?.texture || null
    if (lutTexture && lutTexture !== this.emptyColorLUTTexture) {
      this.destroyTextureUniform(lutTexture)
    }
    const sourceTexture = config?.sourceTex?.texture || null
    if (sourceTexture && sourceTexture !== this.emptySourceTexture?.texture) {
      this.destroyTextureUniform(sourceTexture)
    }
    if (entry.sourceTextureCache instanceof Map) {
      for (const tex of entry.sourceTextureCache.values()) {
        if (tex && tex !== this.emptySourceTexture?.texture) {
          this.destroyTextureUniform(tex)
        }
      }
      entry.sourceTextureCache.clear()
    }
    const fieldTextures = Array.isArray(field?.textures) ? field.textures : []
    const cachedFrameTextures = field?.frameTextureCache
      ? Array.from(field.frameTextureCache.values())
      : []
    const textureSet = new Set([...fieldTextures, ...cachedFrameTextures, field?.texture])
    for (const tex of textureSet) {
      if (tex && tex !== this.emptyTexture) {
        this.destroyTextureUniform(tex)
      }
    }
  }

  destroyConfigResources(config, field) {
    const lutTexture = config?.lut?.texture || null
    if (lutTexture && lutTexture !== this.emptyColorLUTTexture) {
      this.destroyTextureUniform(lutTexture)
    }
    const sourceTexture = config?.sourceTex?.texture || null
    if (sourceTexture && sourceTexture !== this.emptySourceTexture?.texture) {
      this.destroyTextureUniform(sourceTexture)
    }
    const fieldTextures = Array.isArray(field?.textures) ? field.textures : []
    const cachedFrameTextures = field?.frameTextureCache
      ? Array.from(field.frameTextureCache.values())
      : []
    const textureSet = new Set([...fieldTextures, ...cachedFrameTextures, field?.texture])
    for (const tex of textureSet) {
      if (tex && tex !== this.emptyTexture) {
        this.destroyTextureUniform(tex)
      }
    }
  }

  getEmptySourceTexture() {
    if (this.emptySourceTexture) return this.emptySourceTexture
    const data = new Float32Array(8)
    this.emptySourceTexture = {
      enabled: false,
      texture: new Cesium.TextureUniform({
        typedArray: /** @type {any} */ (data),
        width: 1,
        height: 2,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.FLOAT,
        repeat: false,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
      }),
      size: new Cesium.Cartesian2(1, 2)
    }
    return this.emptySourceTexture
  }

  normalizeStressConfig(config) {
    const colorRamp = Array.isArray(config.colorRamp) ? config.colorRamp : []
    const fullRamp = colorRamp.length >= 4 ? colorRamp : cloneColorRamp(STRESS_TURBO_RAMP_32)

    // 始终使用 CIELAB 色彩空间从完整色带构建 LUT，消除 4 段降级路径
    const lutSpec = config.colorLUT
      ? config.colorLUT
      : buildColorLUTSpecFromRamp(fullRamp, { size: 256, colorSpace: 'cielab' })
    const lut = this.prepareColorLUT(lutSpec)

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

    const maxSources = 1000
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
      ? Math.max(1, Math.min(1000, Math.floor(directSourceLimitRaw)))
      : style.useSourceTexture
        ? 1000
        : 4
    const useSourceTex =
      (Boolean(style.useSourceTexture) || directSourceLimit > 32) && sources.length > 16
    const sourcesDirect = useSourceTex ? [] : selectTopSources(sources, directSourceLimit)
    const sourceTex = useSourceTex
      ? this.prepareSourceTexture(sources)
      : this.getEmptySourceTexture()
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
      ? Math.max(1, Math.min(1000, Math.floor(config.directSourceLimit)))
      : 4
    const useSourceTex = (Boolean(config?.useSourceTex) || sourceLimit > 32) && sources.length > 16
    const sourcesDirect = useSourceTex ? [] : selectTopSources(sources, sourceLimit)
    const sourceCount = useSourceTex ? sources.length : sourcesDirect.length
    return {
      ...config,
      sources,
      sourcesDirect,
      sourceCount,
      sourceTex: useSourceTex ? { enabled: true } : this.getEmptySourceTexture(),
      useSourceTex,
      directSourceLimit: sourceLimit
    }
  }

  prepareSourceTexture(sources) {
    const maxSources = 1000
    const width = maxSources
    const height = 2
    const data = new Float32Array(width * height * 4)
    const count = Math.min(maxSources, Array.isArray(sources) ? sources.length : 0)
    for (let i = 0; i < count; i++) {
      const s = sources[i]
      const center = s?.center
      const radius = Number(s?.radius) || 0
      const intensity = Number(s?.intensity) || 0
      const o0 = (0 * width + i) * 4
      data[o0] = Number.isFinite(center?.x) ? center.x : 0
      data[o0 + 1] = Number.isFinite(center?.y) ? center.y : 0
      data[o0 + 2] = Number.isFinite(center?.z) ? center.z : 0
      data[o0 + 3] = Number.isFinite(radius) ? radius : 0

      const o1 = (1 * width + i) * 4
      data[o1] = Number.isFinite(intensity) ? intensity : 0
      data[o1 + 1] = 0
      data[o1 + 2] = 0
      data[o1 + 3] = 0
    }

    return {
      enabled: true,
      texture: new Cesium.TextureUniform({
        typedArray: /** @type {any} */ (data),
        width,
        height,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.FLOAT,
        repeat: false,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
      }),
      size: new Cesium.Cartesian2(width, height)
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

  prepareField(field) {
    if (!field || field.type !== 'grid' || !field.data) {
      const texture = this.getEmptyTexture()
      return {
        enabled: false,
        combine: 1,
        texture,
        textures: [],
        textureSize: new Cesium.Cartesian2(1, 1),
        gridSize: new Cesium.Cartesian3(1, 1, 1),
        size: new Cesium.Cartesian3(1, 1, 1),
        worldToLocal: Cesium.Matrix4.IDENTITY
      }
    }

    const grid = field.data.grid || field.grid
    const frames = field.data.frames || []
    const origin = field.data.origin || field.origin
    const size = field.data.size || field.size

    if (!grid || !origin || !size || frames.length === 0) {
      const texture = this.getEmptyTexture()
      return {
        enabled: false,
        combine: 1,
        texture,
        textures: [],
        textureSize: new Cesium.Cartesian2(1, 1),
        gridSize: new Cesium.Cartesian3(1, 1, 1),
        size: new Cesium.Cartesian3(1, 1, 1),
        worldToLocal: Cesium.Matrix4.IDENTITY
      }
    }

    const gridSize = new Cesium.Cartesian3(grid.width, grid.height, grid.depth)
    const textureWidth = grid.width * grid.depth
    const textureHeight = grid.height
    const textureSize = new Cesium.Cartesian2(textureWidth, textureHeight)
    const worldToLocal = this.computeWorldToLocal(origin)
    const sizeVec = new Cesium.Cartesian3(size[0], size[1], size[2])
    const valueRange = field.data.valueRange || field.valueRange
    const frameTextureCache = new Map()
    const frameTextureOrder = []
    const baseTexture =
      frames.length > 0
        ? this.createFieldTexture(frames[0].values || [], grid, valueRange)
        : this.getEmptyTexture()
    if (frames.length > 0) {
      frameTextureCache.set(0, baseTexture)
      frameTextureOrder.push(0)
    }
    const combineMap = { replace: 0, max: 1, add: 2 }
    const combine = combineMap[field.combine] ?? 0

    return {
      enabled: true,
      combine,
      texture: baseTexture,
      textures: [],
      frameCount: frames.length,
      frameTextureCache,
      frameTextureOrder,
      frameValues: frames,
      textureSize,
      gridSize,
      size: sizeVec,
      worldToLocal,
      valueRange
    }
  }

  getOrCreateFieldFrameTexture(field, frameIndex) {
    if (!field?.enabled || !Number.isInteger(frameIndex) || frameIndex < 0) {
      return field?.texture || this.getEmptyTexture()
    }
    if (field.frameTextureCache?.has(frameIndex)) {
      this.bumpFieldFrameTextureOrder(field, frameIndex)
      return field.frameTextureCache.get(frameIndex)
    }
    const frame = Array.isArray(field.frameValues) ? field.frameValues[frameIndex] : null
    const values = frame?.values || []
    const texture = this.createFieldTexture(
      values,
      {
        width: Math.max(1, Math.round(field.gridSize?.x || 1)),
        height: Math.max(1, Math.round(field.gridSize?.y || 1)),
        depth: Math.max(1, Math.round(field.gridSize?.z || 1))
      },
      field.valueRange
    )
    if (!field.frameTextureCache) field.frameTextureCache = new Map()
    if (!Array.isArray(field.frameTextureOrder)) field.frameTextureOrder = []
    field.frameTextureCache.set(frameIndex, texture)
    field.frameTextureOrder.push(frameIndex)
    while (field.frameTextureOrder.length > MAX_FIELD_FRAME_TEXTURE_CACHE) {
      const staleIndex = field.frameTextureOrder.shift()
      if (!Number.isInteger(staleIndex) || staleIndex === frameIndex) continue
      const staleTexture = field.frameTextureCache.get(staleIndex)
      field.frameTextureCache.delete(staleIndex)
      if (staleTexture && staleTexture !== this.emptyTexture && staleTexture !== field.texture) {
        this.destroyTextureUniform(staleTexture)
      }
    }
    return texture
  }

  bumpFieldFrameTextureOrder(field, frameIndex) {
    if (!Array.isArray(field?.frameTextureOrder)) return
    const idx = field.frameTextureOrder.indexOf(frameIndex)
    if (idx >= 0) field.frameTextureOrder.splice(idx, 1)
    field.frameTextureOrder.push(frameIndex)
  }

  computeWorldToLocal(origin) {
    const position = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
    const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(position)
    return Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
  }

  buildSourceUniforms(sources, sourceCentersMC) {
    const uniforms = {}
    const list = Array.isArray(sources) ? sources : []
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {}
      uniforms[`u_source${i}_center`] = {
        type: Cesium.UniformType.VEC3,
        value: s.center || new Cesium.Cartesian3(0, 0, 0)
      }
      uniforms[`u_source${i}_center_mc`] = {
        type: Cesium.UniformType.VEC3,
        value: sourceCentersMC?.[i] || new Cesium.Cartesian3(0, 0, 0)
      }
      uniforms[`u_source${i}_radius`] = {
        type: Cesium.UniformType.FLOAT,
        value: Number(s.radius) || 0
      }
      uniforms[`u_source${i}_intensity`] = {
        type: Cesium.UniformType.FLOAT,
        value: Number(s.intensity) || 0
      }
    }
    return uniforms
  }

  setSourceUniforms(shader, sources, sourceCentersMC) {
    const list = Array.isArray(sources) ? sources : []
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {}
      shader.setUniform(`u_source${i}_center`, s.center || new Cesium.Cartesian3(0, 0, 0))
      shader.setUniform(
        `u_source${i}_center_mc`,
        sourceCentersMC?.[i] || new Cesium.Cartesian3(0, 0, 0)
      )
      shader.setUniform(`u_source${i}_radius`, Number(s.radius) || 0)
      shader.setUniform(`u_source${i}_intensity`, Number(s.intensity) || 0)
    }
  }

  buildSourceAccessorShader(sourceCount) {
    if (!Number.isFinite(sourceCount) || sourceCount <= 0) {
      return `
        void getSource(int index, out vec3 centerWC, out vec3 centerMC, out float radius, out float intensity) {
          centerWC = vec3(0.0);
          centerMC = vec3(0.0);
          radius = 0.0;
          intensity = 0.0;
        }
      `
    }
    const lines = []
    lines.push(
      'void getSource(int index, out vec3 centerWC, out vec3 centerMC, out float radius, out float intensity) {'
    )
    lines.push('  centerWC = vec3(0.0);')
    lines.push('  centerMC = vec3(0.0);')
    lines.push('  radius = 0.0;')
    lines.push('  intensity = 0.0;')
    for (let i = 0; i < sourceCount; i++) {
      lines.push(`  if (index == ${i}) {`)
      lines.push(`    centerWC = u_source${i}_center;`)
      lines.push(`    centerMC = u_source${i}_center_mc;`)
      lines.push(`    radius = u_source${i}_radius;`)
      lines.push(`    intensity = u_source${i}_intensity;`)
      lines.push('    return;')
      lines.push('  }')
    }
    lines.push('}')
    return lines.join('\n')
  }

  resolveModelWorldToLocal(model) {
    try {
      const modelMatrix = model?.modelMatrix || model?._modelMatrix || null
      const rootTransform = model?.root?.transform || model?._root?.transform || null
      const localToWorld =
        modelMatrix && rootTransform
          ? Cesium.Matrix4.multiply(modelMatrix, rootTransform, new Cesium.Matrix4())
          : modelMatrix || rootTransform || null
      if (!localToWorld) return null
      return Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
    } catch (e) {
      return null
    }
  }

  createFieldTexture(values, grid, valueRange) {
    const width = grid.width * grid.depth
    const height = grid.height
    const data = new Uint8Array(width * height)
    const range = this.normalizeRange(values, valueRange)
    const min = range.min
    const max = range.max
    const denom = Math.max(0.0001, max - min)

    for (let z = 0; z < grid.depth; z++) {
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          const valueIndex = z * grid.width * grid.height + y * grid.width + x
          const rawValue = values[valueIndex]
          const v = Number(rawValue ?? min)
          const n = Math.min(1, Math.max(0, (v - min) / denom))
          const col = z * grid.width + x
          const row = y
          const texIndex = row * width + col
          data[texIndex] = Math.round(n * 255)
        }
      }
    }

    return new Cesium.TextureUniform({
      typedArray: data,
      width,
      height,
      pixelFormat: Cesium.PixelFormat.LUMINANCE,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
    })
  }

  getEmptyTexture() {
    if (this.emptyTexture) return this.emptyTexture
    const data = new Uint8Array([0])
    this.emptyTexture = new Cesium.TextureUniform({
      typedArray: data,
      width: 1,
      height: 1,
      pixelFormat: Cesium.PixelFormat.LUMINANCE,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
    })
    return this.emptyTexture
  }

  getEmptyColorLUTTexture() {
    if (this.emptyColorLUTTexture) return this.emptyColorLUTTexture
    const data = new Uint8Array([0, 0, 0, 255])
    this.emptyColorLUTTexture = new Cesium.TextureUniform({
      typedArray: data,
      width: 1,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
    })
    return this.emptyColorLUTTexture
  }

  prepareColorLUT(spec) {
    if (!spec || typeof spec !== 'object') {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }

    const size = Number(spec.size ?? spec['级数'] ?? 0)
    if (!(Number.isInteger(size) && size >= 2)) {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }

    const table = Array.isArray(spec.table)
      ? spec.table
      : Array.isArray(spec['表'])
        ? spec['表']
        : null
    const preset = String(spec.preset ?? spec['色标'] ?? '')

    const rgba = new Uint8Array(size * 4)
    if (table) {
      if (table.length !== size) {
        return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
      }
      for (let i = 0; i < size; i++) {
        const c = table[i]
        const offset = i * 4
        if (Array.isArray(c) && c.length >= 3) {
          rgba[offset] = Math.max(0, Math.min(255, Math.round(Number(c[0]) || 0)))
          rgba[offset + 1] = Math.max(0, Math.min(255, Math.round(Number(c[1]) || 0)))
          rgba[offset + 2] = Math.max(0, Math.min(255, Math.round(Number(c[2]) || 0)))
          rgba[offset + 3] =
            c.length >= 4 ? Math.max(0, Math.min(255, Math.round(Number(c[3]) || 255))) : 255
          continue
        }
        if (typeof c === 'string') {
          const col = Cesium.Color.fromCssColorString(c)
          rgba[offset] = Math.round(col.red * 255)
          rgba[offset + 1] = Math.round(col.green * 255)
          rgba[offset + 2] = Math.round(col.blue * 255)
          rgba[offset + 3] = Math.round((Number.isFinite(col.alpha) ? col.alpha : 1) * 255)
          continue
        }
        rgba[offset] = 0
        rgba[offset + 1] = 0
        rgba[offset + 2] = 0
        rgba[offset + 3] = 255
      }
    } else if (preset) {
      const name = preset.toLowerCase()
      for (let i = 0; i < size; i++) {
        const t = size === 1 ? 0 : i / (size - 1)
        const [r, g, b] = name === 'rainbow' ? this.rainbowRGB(t) : this.jetRGB(t)
        const offset = i * 4
        rgba[offset] = Math.round(r * 255)
        rgba[offset + 1] = Math.round(g * 255)
        rgba[offset + 2] = Math.round(b * 255)
        rgba[offset + 3] = 255
      }
    } else {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }

    const texture = new Cesium.TextureUniform({
      typedArray: rgba,
      width: size,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
    })

    return { enabled: true, texture, size }
  }

  buildColorLUTFromRamp(ramp) {
    const list = (Array.isArray(ramp) ? ramp : [])
      .map(r => ({
        t: Math.max(0, Math.min(1, Number(r?.value ?? 0))),
        color: String(r?.color || '#000000')
      }))
      .sort((a, b) => a.t - b.t)
    if (list.length < 2) {
      return { enabled: false, texture: this.getEmptyColorLUTTexture(), size: 1 }
    }
    if (list[0].t > 0) list.unshift({ t: 0, color: list[0].color })
    if (list[list.length - 1].t < 1) list.push({ t: 1, color: list[list.length - 1].color })

    const lutSize = 256
    const rgba = new Uint8Array(lutSize * 4)
    let seg = 0
    for (let i = 0; i < lutSize; i++) {
      const t = i / (lutSize - 1)
      while (seg < list.length - 2 && list[seg + 1].t < t) seg++
      const a = list[seg]
      const b = list[Math.min(seg + 1, list.length - 1)]
      const span = Math.max(0.0001, b.t - a.t)
      const localT = Math.max(0, Math.min(1, (t - a.t) / span))
      const ca = Cesium.Color.fromCssColorString(a.color)
      const cb = Cesium.Color.fromCssColorString(b.color)
      const offset = i * 4
      rgba[offset] = Math.round(Cesium.Math.lerp(ca.red, cb.red, localT) * 255)
      rgba[offset + 1] = Math.round(Cesium.Math.lerp(ca.green, cb.green, localT) * 255)
      rgba[offset + 2] = Math.round(Cesium.Math.lerp(ca.blue, cb.blue, localT) * 255)
      rgba[offset + 3] = 255
    }

    const texture = new Cesium.TextureUniform({
      typedArray: rgba,
      width: lutSize,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: false,
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR
    })
    return { enabled: true, texture, size: lutSize }
  }

  jetRGB(t) {
    const clamp01 = v => Math.max(0, Math.min(1, v))
    const r = clamp01(1.5 - Math.abs(4 * t - 3))
    const g = clamp01(1.5 - Math.abs(4 * t - 2))
    const b = clamp01(1.5 - Math.abs(4 * t - 1))
    return [r, g, b]
  }

  rainbowRGB(t) {
    const clamp01 = v => Math.max(0, Math.min(1, v))
    const h = ((1 - clamp01(t)) * 0.75) % 1
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const q = 1 - f
    const m = 0
    const idx = i % 6
    if (idx === 0) return [1, f, m]
    if (idx === 1) return [q, 1, m]
    if (idx === 2) return [m, 1, f]
    if (idx === 3) return [m, q, 1]
    if (idx === 4) return [f, m, 1]
    return [1, m, q]
  }

  normalizeRange(values, valueRange, mapper = null) {
    if (Array.isArray(valueRange) && valueRange.length === 2) {
      const vMin = Number(valueRange[0])
      const vMax = Number(valueRange[1])
      if (Number.isFinite(vMin) && Number.isFinite(vMax) && vMax > vMin) {
        return { min: vMin, max: vMax }
      }
      return this.computeRobustRange(values, mapper)
    }
    return this.computeRobustRange(values, mapper)
  }

  /** 计算数据偏度 —— 正值=右偏（极端高值），负值=左偏 */
  computeSkewness(arr) {
    if (arr.length < 3) return 0
    const n = arr.length
    let sum = 0
    for (let i = 0; i < n; i++) sum += arr[i]
    const mean = sum / n
    let m2 = 0
    let m3 = 0
    for (let i = 0; i < n; i++) {
      const d = arr[i] - mean
      m2 += d * d
      m3 += d * d * d
    }
    if (m2 < 1e-12) return 0
    const variance = m2 / n
    const std = Math.sqrt(variance)
    return m3 / n / (std * std * std)
  }

  computeRobustRange(values, mapper = null, quantileOpts = null) {
    const arr = []
    if (Array.isArray(values)) {
      for (let i = 0; i < values.length; i++) {
        const raw = values[i]
        const v = typeof mapper === 'function' ? mapper(raw) : raw
        if (typeof v === 'number' && Number.isFinite(v)) arr.push(v)
      }
    } else if (values && typeof values[Symbol.iterator] === 'function') {
      for (const raw of values) {
        const v = typeof mapper === 'function' ? mapper(raw) : raw
        if (typeof v === 'number' && Number.isFinite(v)) arr.push(v)
      }
    }
    if (arr.length === 0) return { min: 0, max: 1 }
    if (arr.length === 1) {
      const v = arr[0]
      return { min: v, max: v === 0 ? 1 : v + Math.abs(v) * 0.1 || 1 }
    }
    arr.sort((a, b) => a - b)

    // 自适应分位数裁剪 —— 根据数据偏度动态调整裁剪比例
    let loQ = 0.02
    let hiQ = 0.98
    if (quantileOpts) {
      loQ = Number.isFinite(Number(quantileOpts.lo)) ? clamp01(Number(quantileOpts.lo)) : loQ
      hiQ = Number.isFinite(Number(quantileOpts.hi)) ? clamp01(Number(quantileOpts.hi)) : hiQ
    } else {
      const skew = this.computeSkewness(arr)
      if (skew > 1.5) {
        // 右偏分布（多数低应力，少数高应力）→ 保留更多上尾极端值
        loQ = 0.01
        hiQ = 0.995
      } else if (skew < -1.5) {
        // 左偏分布 → 保留更多下尾
        loQ = 0.005
        hiQ = 0.97
      }
      // 接近对称分布 → 标准 2%-98% 裁剪
    }

    const loIdx = Math.max(0, Math.floor(arr.length * loQ))
    const hiIdx = Math.min(arr.length - 1, Math.ceil(arr.length * hiQ))
    const lo = arr[loIdx]
    const hi = arr[hiIdx]
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
      const rawMin = arr[0]
      const rawMax = arr[arr.length - 1]
      return rawMin < rawMax ? { min: rawMin, max: rawMax } : { min: rawMin, max: rawMin + 1 }
    }
    const padding = Math.max(0.01, (hi - lo) * 0.05)
    return { min: lo - padding, max: hi + padding }
  }
}

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
