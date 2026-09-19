import * as Cesium from 'cesium'
import { MAX_SOURCE_COUNT } from './stressShared.js'

/**
 * 应力着色器构造域（ShaderBuilder）
 *
 * 从 HeatmapManager 拆出的"着色器构造"职责：
 *  - 直传源着色器上下文（prepareShaderSourceContext）：按是否启用源纹理派生
 *    sourceUniforms / sourceAccessor / sourceTex / maxShaderSources；
 *  - uniform 取值表（createStressUniformEntries，单一事实源、表驱动）：首次创建
 *    （buildStressShaderUniforms）与增量更新（stressConfigDomain.updateStressConfig）
 *    两处共用，保证两条路径的 uniform 集合与取值完全一致；
 *  - 片元着色器源码拼装（STRESS_FRAGMENT_SHADER_BODY / buildStressFragmentShader）；
 *  - 直传源 uniform 与 getSource GLSL 访问器（buildSourceUniforms / setSourceUniforms /
 *    buildSourceAccessorShader）。
 * 构造逻辑不持有状态；跨域能力经门面实例（this.m）访问。
 */

export function prepareShaderSourceContext(manager, normalized, anchorToModel, resolveCenterMC) {
  const useSourceTex = Boolean(normalized.sourceTex?.enabled)
  const directSources =
    !useSourceTex && Array.isArray(normalized.sourcesDirect) ? normalized.sourcesDirect : []
  const sourceCentersMC = anchorToModel
    ? directSources.map(resolveCenterMC)
    : directSources.map(() => new Cesium.Cartesian3(0, 0, 0))
  const sourceUniforms = useSourceTex
    ? {}
    : manager.buildSourceUniforms(directSources, sourceCentersMC)
  const sourceAccessor = manager.buildSourceAccessorShader(directSources.length)
  let sourceTex = manager.getEmptySourceTexture()
  if (useSourceTex) {
    sourceTex = anchorToModel
      ? manager.prepareSourceTexture(
          normalized.sources.map(source => ({ ...source, center: resolveCenterMC(source) }))
        )
      : normalized.sourceTex
  }
  return {
    useSourceTex,
    sourceUniforms,
    sourceAccessor,
    sourceTex,
    maxShaderSources: useSourceTex ? MAX_SOURCE_COUNT : Math.max(1, directSources.length)
  }
}

/**
 * 应力着色器 uniform 取值表（单一事实源，表驱动）。
 * buildStressShaderUniforms（首次创建着色器）与 updateStressConfig（增量更新）共用，
 * 保证两条路径的 uniform 集合与取值完全一致。
 *
 * 注意：u_whiteModel 有意不在此表中 —— 首次创建时初始化为 0，
 * 增量更新时必须保留当前白模状态，由 applyStressConfig / setWhiteModel 单独写入。
 *
 * @returns {Array<[string, number, *]>} [uniformName, uniformType, value]
 */
export function createStressUniformEntries({
  normalized,
  sourceTex,
  model,
  field,
  anchorToModel,
  fieldCenterMC,
  emptyTexture
}) {
  return [
    ['u_lutTexture', Cesium.UniformType.SAMPLER_2D, normalized.lut.texture],
    ['u_lutSize', Cesium.UniformType.FLOAT, normalized.lut.size],
    ['u_useSourceTex', Cesium.UniformType.FLOAT, sourceTex.enabled ? 1.0 : 0.0],
    ['u_sourceTex', Cesium.UniformType.SAMPLER_2D, sourceTex.texture],
    ['u_sourceTexSize', Cesium.UniformType.VEC2, sourceTex.size],
    ['u_cutoff', Cesium.UniformType.FLOAT, normalized.cutoff],
    ['u_fieldMaskMode', Cesium.UniformType.FLOAT, normalized.fieldMaskMode],
    ['u_fieldMaskPower', Cesium.UniformType.FLOAT, normalized.fieldMaskPower],
    ['u_markerEnabled', Cesium.UniformType.FLOAT, normalized.markerEnabled],
    ['u_markerRadius', Cesium.UniformType.FLOAT, normalized.markerRadius],
    ['u_contourEnabled', Cesium.UniformType.FLOAT, normalized.contourEnabled],
    ['u_contourLevels', Cesium.UniformType.FLOAT, normalized.contourLevels],
    ['u_contourWidth', Cesium.UniformType.FLOAT, normalized.contourWidth],
    ['u_glowEnabled', Cesium.UniformType.FLOAT, normalized.glowEnabled],
    ['u_glowThreshold', Cesium.UniformType.FLOAT, normalized.glowThreshold],
    ['u_glowStrength', Cesium.UniformType.FLOAT, normalized.glowStrength],
    ['u_anchorToModel', Cesium.UniformType.FLOAT, anchorToModel ? 1.0 : 0.0],
    ['u_diffuseMix', Cesium.UniformType.FLOAT, normalized.diffuseMix],
    ['u_emissiveMix', Cesium.UniformType.FLOAT, normalized.emissiveMix],
    ['u_blendMode', Cesium.UniformType.FLOAT, normalized.blendMode],
    ['u_forceVisible', Cesium.UniformType.FLOAT, normalized.forceVisible],
    ['u_lowRangeOpacity', Cesium.UniformType.FLOAT, normalized.lowRangeOpacity],
    ['u_modelRadius', Cesium.UniformType.FLOAT, Number(model?.boundingSphere?.radius) || 1.0],
    ['u_sourceCount', Cesium.UniformType.FLOAT, normalized.sourceCount],
    ['u_fieldEnabled', Cesium.UniformType.FLOAT, field.enabled ? 1.0 : 0.0],
    ['u_fieldCombine', Cesium.UniformType.FLOAT, field.combine],
    ['u_fieldTexture', Cesium.UniformType.SAMPLER_2D, field.texture || emptyTexture],
    ['u_fieldTexSize', Cesium.UniformType.VEC2, field.textureSize],
    ['u_fieldGridSize', Cesium.UniformType.VEC3, field.gridSize],
    ['u_fieldEdgeFade', Cesium.UniformType.FLOAT, normalized.fieldEdgeFade],
    ['u_fieldSize', Cesium.UniformType.VEC3, field.size],
    ['u_fieldWorldToLocal', Cesium.UniformType.MAT4, field.worldToLocal],
    ['u_fieldCenter_mc', Cesium.UniformType.VEC3, fieldCenterMC]
  ]
}

export function buildStressShaderUniforms({
  normalized,
  sourceUniforms,
  sourceTex,
  model,
  field,
  anchorToModel,
  fieldCenterMC,
  emptyTexture
}) {
  const entries = createStressUniformEntries({
    normalized,
    sourceTex,
    model,
    field,
    anchorToModel,
    fieldCenterMC,
    emptyTexture
  })
  const uniforms = {}
  for (const [name, type, value] of entries) {
    uniforms[name] = { type, value }
  }
  // u_whiteModel 默认关闭；白模状态由 applyStressConfig / setWhiteModel 单独写入
  uniforms.u_whiteModel = { type: Cesium.UniformType.FLOAT, value: 0.0 }
  return { ...uniforms, ...sourceUniforms }
}

const STRESS_FRAGMENT_SHADER_BODY = `
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
          // ---- 渲染增强：法线导数光照（与 renderEnhancementManager 保持一致）----
          // 白模开关通过 u_whiteModel 控制，开启时基础色替换为白色
          vec3 posEC_re = fsInput.attributes.positionEC;
          vec3 flatNormal_re = normalize(cross(dFdx(posEC_re), dFdy(posEC_re)));
          if (dot(flatNormal_re, vec3(0.0, 0.0, 1.0)) < 0.0) {
            flatNormal_re = -flatNormal_re;
          }
          vec3 originalColor_re = material.diffuse;
          vec3 baseColor = mix(originalColor_re, vec3(1.0), u_whiteModel);
          vec3 lightDir_re = normalize(vec3(0.5, 0.6, 0.6));
          float diffuse_re = max(dot(flatNormal_re, lightDir_re), 0.0);
          float lighting_re = 0.55 + diffuse_re * 0.45;
          material.diffuse = baseColor * lighting_re;
          float spec_re = pow(diffuse_re, 12.0) * 0.15;
          material.diffuse += baseColor * spec_re;
          float rim_re = 1.0 - max(dot(flatNormal_re, vec3(0.0, 0.0, 1.0)), 0.0);
          rim_re = pow(rim_re, 2.5) * 0.35;
          material.diffuse += baseColor * rim_re;
          vec3 lightDir2_re = normalize(vec3(-0.4, -0.3, 0.5));
          float diffuse2_re = max(dot(flatNormal_re, lightDir2_re), 0.0);
          material.diffuse += baseColor * diffuse2_re * 0.12;
          // ---- 渲染增强结束 ----

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

export function buildStressFragmentShader(maxShaderSources, sourceAccessor) {
  return `const int MAX_SOURCES = ${maxShaderSources};\n\n${sourceAccessor}\n${STRESS_FRAGMENT_SHADER_BODY}`
}

export class ShaderBuilder {
  /** @param {import('./HeatmapManager.js').HeatmapManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
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
}
