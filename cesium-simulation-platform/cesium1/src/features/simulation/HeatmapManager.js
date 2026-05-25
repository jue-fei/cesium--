import * as Cesium from 'cesium'

export function isStressDebugEnabled() {
  try {
    if (typeof window === 'undefined') return false
    return window.__STRESS_DEBUG__ !== undefined ? Boolean(window.__STRESS_DEBUG__) : true
  } catch (e) {
    return false
  }
}

export function stressDebugLog(scope, title, payload) {
  if (!isStressDebugEnabled()) return
  const scopeText = String(scope || 'core')
  const titleText = String(title || 'log')
  try {
    // eslint-disable-next-line no-console
    console.groupCollapsed(`[Stress:${scopeText}] ${titleText}`)
    // eslint-disable-next-line no-console
    console.log(payload)
    // eslint-disable-next-line no-console
    console.groupEnd()
  } catch (e) {
    void e
  }
}

export class HeatmapManager {
  constructor(viewer) {
    this.viewer = viewer
    this.activeShaders = new Map() // 模型对象 -> 自定义着色器
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

  /**
   * 将应力热力图应用到三维瓦片集或模型
   * @param {Cesium.Cesium3DTileset | Cesium.Model} model
   * @param {Cesium.Cartesian3} center - 应力源中心点
   * @param {number} radius - 影响半径
   * @param {number} maxStress - 最大应力值
   */
  applyHeatmap(model, center, radius = 50.0, maxStress = 1.0) {
    if (!model) return

    // 创建自定义着色器，并通过距离衰减模拟传播效果

    const customShader = new Cesium.CustomShader({
      uniforms: {
        u_stressCenter: {
          type: Cesium.UniformType.VEC3,
          value: center
        },
        u_stressRadius: {
          type: Cesium.UniformType.FLOAT,
          value: radius
        },
        u_maxStress: {
          type: Cesium.UniformType.FLOAT,
          value: maxStress
        },
        u_time: {
          type: Cesium.UniformType.FLOAT,
          value: 0.0
        },
        u_displacementFactor: {
          type: Cesium.UniformType.FLOAT,
          value: 0.0
        },
        u_mappingType: {
          type: Cesium.UniformType.FLOAT,
          value: 0.0
        },
        u_fieldScale: {
          type: Cesium.UniformType.FLOAT,
          value: 1.0
        }
      },
      lightingModel: Cesium.LightingModel.PBR,
      vertexShaderText: `
        void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
            // 在模型坐标与世界坐标之间计算距离
            // 位置输入为模型坐标，中心点为世界坐标，因此需要做坐标变换
            
            // 将位置转换到世界坐标
            vec4 positionWC = czm_model * vec4(vsInput.attributes.positionMC, 1.0);
            float dist = distance(positionWC.xyz, u_stressCenter);
            
            // 使用正弦波模拟向外传播的波纹，沿法线方向产生位移
            
            if (dist < u_stressRadius + 20.0 && u_displacementFactor > 0.001) {
                // 波函数：sin(k * dist - w * time)
                float wave = sin(0.5 * dist - 10.0 * u_time);
                
                // 衰减
                float attenuation = 1.0 - smoothstep(0.0, u_stressRadius + 20.0, dist);
                
                // 位移幅度
                float disp = wave * u_displacementFactor * attenuation;
                
                // 沿法线方向对世界坐标位置施加位移，需要将法线从模型坐标转换到世界坐标
                vec3 normalMC = vsInput.attributes.normalMC;
                vec3 normalWC = normalize((czm_model * vec4(normalMC, 0.0)).xyz);
                
                positionWC.xyz += normalWC * disp;
                
                // 最终输出需要写回模型坐标，这里使用逆模型矩阵将世界坐标转换回模型坐标
                
                vsOutput.positionMC = (czm_inverseModel * positionWC).xyz;
            }
        }
      `,
      fragmentShaderText: `
        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
            vec3 positionWC = fsInput.attributes.positionWC;
            float dist = distance(positionWC, u_stressCenter);
            
            // 1. 应力场（梯度）
            float stress = 1.0 - smoothstep(0.0, u_stressRadius, dist);
            float value = clamp(stress * u_fieldScale, 0.0, 1.0);
            if (u_mappingType > 0.5) {
                value = log(1.0 + value * 9.0) / log(10.0);
            }
            
            // 2. 动态波纹（仅用于视觉增强）
            float ripple = sin(dist * 0.5 - u_time * 10.0);
            float rippleMask = smoothstep(0.8, 1.0, ripple) * value;
            
            if (value > 0.01) {
                vec3 lowColor = vec3(0.0, 0.0, 1.0);
                vec3 midColor = vec3(0.0, 1.0, 0.0);
                vec3 highColor = vec3(1.0, 0.0, 0.0);
                
                vec3 heatColor;
                if (value < 0.5) {
                    heatColor = mix(lowColor, midColor, value * 2.0);
                } else {
                    heatColor = mix(midColor, highColor, (value - 0.5) * 2.0);
                }
                
                // 叠加波纹亮度
                heatColor += vec3(0.3) * rippleMask;
                
                // 混合到材质
                material.diffuse = mix(material.diffuse, heatColor, value * 0.8);
                material.emissive = mix(material.emissive, heatColor, value * 0.5);
            }
        }
      `
    })

    model.customShader = customShader
    this.activeShaders.set(model, customShader)
  }

  updateHeatmap(model, radius, time, displacement, mappingType, fieldScale) {
    const shader = this.activeShaders.get(model)
    if (shader) {
      shader.setUniform('u_stressRadius', radius)
      if (time !== undefined) shader.setUniform('u_time', time)
      if (displacement !== undefined) shader.setUniform('u_displacementFactor', displacement)
      if (mappingType !== undefined) shader.setUniform('u_mappingType', mappingType)
      if (fieldScale !== undefined) shader.setUniform('u_fieldScale', fieldScale)
    }
  }

  updateAll(radius, time, displacement, mappingType, fieldScale) {
    this.activeShaders.forEach(shader => {
      shader.setUniform('u_stressRadius', radius)
      if (time !== undefined) shader.setUniform('u_time', time)
      if (displacement !== undefined) shader.setUniform('u_displacementFactor', displacement)
      if (mappingType !== undefined) shader.setUniform('u_mappingType', mappingType)
      if (fieldScale !== undefined) shader.setUniform('u_fieldScale', fieldScale)
    })
  }

  updateAllRadius(radius) {
    this.updateAll(radius)
  }

  clearHeatmap(model) {
    if (model) {
      model.customShader = undefined
      this.activeShaders.delete(model)
    }
  }

  applyStressConfig(model, config) {
    if (!model || !config) return

    const normalized = this.normalizeStressConfig(config)
    const field = this.prepareField(config.field)
    const sourceCentersMC = this.resolveSourcesModelCenters(model, normalized.sourcesFixed4)
    this.debugLog('apply', {
      sourceCount: normalized.sourceCount,
      useSourceTex: Boolean(normalized.sourceTex?.enabled),
      sourceTexSize: normalized.sourceTex?.size,
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
        u_useLUT: { type: Cesium.UniformType.FLOAT, value: normalized.lut.enabled ? 1.0 : 0.0 },
        u_lutTexture: { type: Cesium.UniformType.SAMPLER_2D, value: normalized.lut.texture },
        u_lutSize: { type: Cesium.UniformType.FLOAT, value: normalized.lut.size },
        u_useSourceTex: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourceTex.enabled ? 1.0 : 0.0
        },
        u_sourceTex: { type: Cesium.UniformType.SAMPLER_2D, value: normalized.sourceTex.texture },
        u_sourceTexSize: { type: Cesium.UniformType.VEC2, value: normalized.sourceTex.size },
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
        u_color0: { type: Cesium.UniformType.VEC3, value: normalized.colors[0] },
        u_color1: { type: Cesium.UniformType.VEC3, value: normalized.colors[1] },
        u_color2: { type: Cesium.UniformType.VEC3, value: normalized.colors[2] },
        u_color3: { type: Cesium.UniformType.VEC3, value: normalized.colors[3] },
        u_threshold0: { type: Cesium.UniformType.FLOAT, value: normalized.thresholds[0] },
        u_threshold1: { type: Cesium.UniformType.FLOAT, value: normalized.thresholds[1] },
        u_threshold2: { type: Cesium.UniformType.FLOAT, value: normalized.thresholds[2] },
        u_threshold3: { type: Cesium.UniformType.FLOAT, value: normalized.thresholds[3] },
        u_diffuseMix: { type: Cesium.UniformType.FLOAT, value: normalized.diffuseMix },
        u_emissiveMix: { type: Cesium.UniformType.FLOAT, value: normalized.emissiveMix },
        u_blendMode: { type: Cesium.UniformType.FLOAT, value: normalized.blendMode },
        u_forceVisible: { type: Cesium.UniformType.FLOAT, value: normalized.forceVisible },
        u_modelRadius: {
          type: Cesium.UniformType.FLOAT,
          value: Number(model?.boundingSphere?.radius) || 1.0
        },
        u_sourceCount: { type: Cesium.UniformType.FLOAT, value: normalized.sources.length },
        u_source0_center: {
          type: Cesium.UniformType.VEC3,
          value: normalized.sourcesFixed4[0].center
        },
        u_source0_center_mc: {
          type: Cesium.UniformType.VEC3,
          value: sourceCentersMC[0]
        },
        u_source0_radius: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[0].radius
        },
        u_source0_intensity: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[0].intensity
        },
        u_source1_center: {
          type: Cesium.UniformType.VEC3,
          value: normalized.sourcesFixed4[1].center
        },
        u_source1_center_mc: {
          type: Cesium.UniformType.VEC3,
          value: sourceCentersMC[1]
        },
        u_source1_radius: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[1].radius
        },
        u_source1_intensity: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[1].intensity
        },
        u_source2_center: {
          type: Cesium.UniformType.VEC3,
          value: normalized.sourcesFixed4[2].center
        },
        u_source2_center_mc: {
          type: Cesium.UniformType.VEC3,
          value: sourceCentersMC[2]
        },
        u_source2_radius: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[2].radius
        },
        u_source2_intensity: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[2].intensity
        },
        u_source3_center: {
          type: Cesium.UniformType.VEC3,
          value: normalized.sourcesFixed4[3].center
        },
        u_source3_center_mc: {
          type: Cesium.UniformType.VEC3,
          value: sourceCentersMC[3]
        },
        u_source3_radius: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[3].radius
        },
        u_source3_intensity: {
          type: Cesium.UniformType.FLOAT,
          value: normalized.sourcesFixed4[3].intensity
        },
        u_fieldEnabled: { type: Cesium.UniformType.FLOAT, value: field.enabled ? 1.0 : 0.0 },
        u_fieldCombine: { type: Cesium.UniformType.FLOAT, value: field.combine },
        u_fieldTexture: { type: Cesium.UniformType.SAMPLER_2D, value: field.texture },
        u_fieldTexSize: { type: Cesium.UniformType.VEC2, value: field.textureSize },
        u_fieldGridSize: { type: Cesium.UniformType.VEC3, value: field.gridSize },
        u_fieldSize: { type: Cesium.UniformType.VEC3, value: field.size },
        u_fieldWorldToLocal: { type: Cesium.UniformType.MAT4, value: field.worldToLocal }
      },
      lightingModel: Cesium.LightingModel.PBR,
      fragmentShaderText: `
        const int MAX_SOURCES = 100;

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
          if (u_useLUT > 0.5) {
            float size = max(2.0, u_lutSize);
            float i = clamp(v, 0.0, 1.0) * (size - 1.0);
            float u = (floor(i) + 0.5) / size;
            return texture(u_lutTexture, vec2(u, 0.5)).rgb;
          }

          vec3 c0 = u_color0;
          vec3 c1 = u_color1;
          vec3 c2 = u_color2;
          vec3 c3 = u_color3;
          float t0 = u_threshold0;
          float t1 = u_threshold1;
          float t2 = u_threshold2;
          float t3 = u_threshold3;

          if (v <= t0) return c0;
          if (v <= t1) return mix(c0, c1, (v - t0) / max(0.0001, (t1 - t0)));
          if (v <= t2) return mix(c1, c2, (v - t1) / max(0.0001, (t2 - t1)));
          if (v <= t3) return mix(c2, c3, (v - t2) / max(0.0001, (t3 - t2)));
          return c3;
        }

        vec4 sampleSourceRow(float index, float row) {
          vec2 size = max(vec2(1.0), u_sourceTexSize);
          float u = (index + 0.5) / size.x;
          float v = (row + 0.5) / size.y;
          return texture(u_sourceTex, vec2(u, v));
        }

        float sampleField(vec3 positionWC) {
          vec4 localPos = u_fieldWorldToLocal * vec4(positionWC, 1.0);
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
          return mix(v0, v1, f.z);
        }

        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          vec3 positionWC = fsInput.attributes.positionWC;
          vec3 positionMC = fsInput.attributes.positionMC;
          float sourcesAcc = 0.0;

          float dMin = 1e30;
          float mask = 0.0;

          if (u_useSourceTex > 0.5) {
            for (int i = 0; i < MAX_SOURCES; i++) {
              float fi = float(i);
              if (fi + 0.5 > u_sourceCount) {
                continue;
              }

              vec4 r0 = sampleSourceRow(fi, 0.0);
              vec4 r1 = sampleSourceRow(fi, 1.0);
              vec3 c = r0.xyz;
              float radius = max(0.0001, r0.w);
              float dist = distance(positionWC, c);
              dMin = min(dMin, dist);
              float intensity = clamp(r1.x, 0.0, 1.0);
              if (intensity <= 0.0) {
                continue;
              }

              float base = 1.0 - smoothstep(0.0, radius, dist);
              float v = clamp(base * intensity, 0.0, 1.0);
              sourcesAcc = blendValue(sourcesAcc, v, u_blendMode);

              mask = max(mask, base);

              if (u_blendMode < 0.5 && sourcesAcc > 0.999) {
                continue;
              }
            }
          } else {
            float dist0 = distance(positionWC, u_source0_center);
            float dist1 = distance(positionWC, u_source1_center);
            float dist2 = distance(positionWC, u_source2_center);
            float dist3 = distance(positionWC, u_source3_center);
            float dist0m = distance(positionMC, u_source0_center_mc);
            float dist1m = distance(positionMC, u_source1_center_mc);
            float dist2m = distance(positionMC, u_source2_center_mc);
            float dist3m = distance(positionMC, u_source3_center_mc);
            dMin = min(min(min(dist0, dist1), min(dist2, dist3)), min(min(dist0m, dist1m), min(dist2m, dist3m)));

            float v0w = computeContribution(positionWC, u_source0_center, u_source0_radius, u_source0_intensity);
            float v0m = computeContribution(positionMC, u_source0_center_mc, u_source0_radius, u_source0_intensity);
            float v0 = max(v0w, v0m);
            sourcesAcc = blendValue(sourcesAcc, v0, u_blendMode);
            float v1w = computeContribution(positionWC, u_source1_center, u_source1_radius, u_source1_intensity);
            float v1m = computeContribution(positionMC, u_source1_center_mc, u_source1_radius, u_source1_intensity);
            float v1 = max(v1w, v1m);
            sourcesAcc = blendValue(sourcesAcc, v1, u_blendMode);
            float v2w = computeContribution(positionWC, u_source2_center, u_source2_radius, u_source2_intensity);
            float v2m = computeContribution(positionMC, u_source2_center_mc, u_source2_radius, u_source2_intensity);
            float v2 = max(v2w, v2m);
            sourcesAcc = blendValue(sourcesAcc, v2, u_blendMode);
            float v3w = computeContribution(positionWC, u_source3_center, u_source3_radius, u_source3_intensity);
            float v3m = computeContribution(positionMC, u_source3_center_mc, u_source3_radius, u_source3_intensity);
            float v3 = max(v3w, v3m);
            sourcesAcc = blendValue(sourcesAcc, v3, u_blendMode);

            float m0 = 1.0 - smoothstep(0.0, max(0.0001, u_source0_radius), dist0);
            float m1 = 1.0 - smoothstep(0.0, max(0.0001, u_source1_radius), dist1);
            float m2 = 1.0 - smoothstep(0.0, max(0.0001, u_source2_radius), dist2);
            float m3 = 1.0 - smoothstep(0.0, max(0.0001, u_source3_radius), dist3);
            float m0m = 1.0 - smoothstep(0.0, max(0.0001, u_source0_radius), dist0m);
            float m1m = 1.0 - smoothstep(0.0, max(0.0001, u_source1_radius), dist1m);
            float m2m = 1.0 - smoothstep(0.0, max(0.0001, u_source2_radius), dist2m);
            float m3m = 1.0 - smoothstep(0.0, max(0.0001, u_source3_radius), dist3m);
            mask = max(max(max(m0, m1), max(m2, m3)), max(max(m0m, m1m), max(m2m, m3m)));
          }

          mask = pow(clamp(mask, 0.0, 1.0), max(0.1, u_fieldMaskPower));

          float fieldValue = 0.0;
          if (u_fieldEnabled > 0.5) {
            fieldValue = sampleField(positionWC);
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

          float cutoff = clamp(u_cutoff, 0.0, 0.95);
          float colorW = acc <= cutoff ? 0.0 : (acc - cutoff) / max(0.0001, (1.0 - cutoff));
          colorW = clamp(colorW, 0.0, 1.0);
          float baseRadius = max(max(u_source0_radius, u_source1_radius), max(u_source2_radius, u_source3_radius));
          float fallbackRadius = max(baseRadius, max(1.0, u_modelRadius * 0.18));
          float fallback = 1.0 - smoothstep(0.0, fallbackRadius, dMin);
          float displayW = max(colorW, clamp(fallback * clamp(u_forceVisible, 0.0, 1.0), 0.0, 1.0));

          vec3 heatColor = mapColor(displayW);
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
            float line = 1.0 - smoothstep(0.0, clamp(u_contourWidth, 0.001, 0.2), f);
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
    this.stressShaders.set(model, { shader, config: normalized, field })
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  updateStressTime(model, timeIndex) {
    const entry = this.stressShaders.get(model)
    if (!entry) return
    const { shader, config, field } = entry
    const updated = this.withTimeSeries(config, timeIndex)

    shader.setUniform('u_sourceCount', updated.sourceCount)
    if (updated.sourceTex?.enabled) {
      const srcTex = this.prepareSourceTexture(updated.sources)
      shader.setUniform('u_useSourceTex', 1.0)
      shader.setUniform('u_sourceTex', srcTex.texture)
      shader.setUniform('u_sourceTexSize', srcTex.size)
    } else {
      shader.setUniform('u_useSourceTex', 0.0)
      shader.setUniform('u_source0_intensity', updated.sourcesFixed4[0].intensity)
      shader.setUniform('u_source1_intensity', updated.sourcesFixed4[1].intensity)
      shader.setUniform('u_source2_intensity', updated.sourcesFixed4[2].intensity)
      shader.setUniform('u_source3_intensity', updated.sourcesFixed4[3].intensity)
      shader.setUniform('u_source0_radius', updated.sourcesFixed4[0].radius)
      shader.setUniform('u_source1_radius', updated.sourcesFixed4[1].radius)
      shader.setUniform('u_source2_radius', updated.sourcesFixed4[2].radius)
      shader.setUniform('u_source3_radius', updated.sourcesFixed4[3].radius)
    }
    if (field.enabled && field.textures.length > 0) {
      const index = timeIndex % field.textures.length
      shader.setUniform('u_fieldTexture', field.textures[index])
    } else if (field.texture) {
      shader.setUniform('u_fieldTexture', field.texture)
    }
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }

    if (this.debugEnabled()) {
      const now = Date.now()
      const prev = this.debugState.get(model) || { lastLogMs: 0, lastIndex: null }
      const throttleMs =
        typeof window !== 'undefined' && Number.isFinite(window.__STRESS_DEBUG_THROTTLE_MS__)
          ? Math.max(0, window.__STRESS_DEBUG_THROTTLE_MS__)
          : 800
      if (prev.lastIndex !== timeIndex && now - prev.lastLogMs >= throttleMs) {
        const stats = summarizeSources(updated.sources)
        this.debugLog('time', {
          timeIndex,
          sourceCount: updated.sourceCount,
          useSourceTex: Boolean(updated.sourceTex?.enabled),
          sources: stats,
          fieldEnabled: Boolean(field.enabled)
        })
        this.debugState.set(model, { lastLogMs: now, lastIndex: timeIndex })
      }
    }
  }

  clearStress(model) {
    if (!model) return
    model.customShader = null
    this.stressShaders.delete(model)
    this.debugState.delete(model)
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  clearAllStress() {
    for (const model of this.stressShaders.keys()) {
      if (!model) continue
      model.customShader = null
    }
    this.stressShaders.clear()
    this.debugState.clear()
    if (this.viewer?.scene?.requestRender) {
      this.viewer.scene.requestRender()
    }
  }

  getEmptySourceTexture() {
    if (this.emptySourceTexture) return this.emptySourceTexture
    const data = new Float32Array(8)
    this.emptySourceTexture = {
      enabled: false,
      texture: new Cesium.TextureUniform({
        typedArray: data,
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
    const defaults = [
      { value: 0.25, color: '#4caf50' },
      { value: 0.5, color: '#ffeb3b' },
      { value: 0.75, color: '#ff9800' },
      { value: 1.0, color: '#f44336' }
    ]
    const ramp = [...colorRamp, ...defaults].slice(0, 4)
    const thresholds = ramp.map(r => r.value)
    const colors = ramp.map(r => Cesium.Color.fromCssColorString(r.color))

    const lut = this.prepareColorLUT(config.colorLUT)

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

    const contourEnabled = style.contourEnabled ? 1.0 : 0.0
    const contourLevels = Number.isFinite(style.contourLevels)
      ? Math.max(2, style.contourLevels)
      : 12
    const contourWidth = Number.isFinite(style.contourWidth)
      ? Math.max(0.001, Math.min(0.2, style.contourWidth))
      : 0.06

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

    const maxSources = 100
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
    const sources = (config.sources || []).slice(0, maxSources).map(s => ({
      id: s.id || '',
      name: s.name || '',
      center: resolveCenterCartesian(s),
      radius: s.radius || 50,
      base: s.base ?? 1,
      timeSeries: Array.isArray(s.timeSeries) ? s.timeSeries : [],
      radiusSeries: Array.isArray(s.radiusSeries) ? s.radiusSeries : [],
      intensity: s.base ?? 1
    }))

    const enableSourceTex = Boolean(style.useSourceTexture) && sources.length > 4
    const sourcesFixed4 = selectTopSources(sources, 4)
    while (sourcesFixed4.length < 4) {
      sourcesFixed4.push({
        id: '',
        name: '',
        center: new Cesium.Cartesian3(0, 0, 0),
        radius: 1,
        base: 0,
        timeSeries: [],
        radiusSeries: [],
        intensity: 0
      })
    }

    const sourceTex = enableSourceTex
      ? this.prepareSourceTexture(sources)
      : this.getEmptySourceTexture()

    return {
      thresholds,
      colors,
      lut,
      blendMode,
      sources,
      sourcesFixed4,
      sourceCount: sources.length,
      sourceTex,
      diffuseMix,
      emissiveMix,
      cutoff,
      fieldMaskMode,
      fieldMaskPower,
      contourEnabled,
      contourLevels,
      contourWidth,
      glowEnabled,
      glowThreshold,
      glowStrength,
      markerEnabled,
      markerRadius,
      forceVisible,
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
    const sourcesFixed4 = selectTopSources(sources, 4)
    while (sourcesFixed4.length < 4) {
      sourcesFixed4.push({
        id: '',
        name: '',
        center: new Cesium.Cartesian3(0, 0, 0),
        radius: 1,
        base: 0,
        timeSeries: [],
        radiusSeries: [],
        intensity: 0
      })
    }
    return {
      ...config,
      sources,
      sourcesFixed4,
      sourceCount: sources.length,
      sourceTex: config.sourceTex
    }
  }

  prepareSourceTexture(sources) {
    const maxSources = 100
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
        typedArray: data,
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

  prepareField(field) {
    if (!field || field.type !== 'grid' || !field.data) {
      const texture = this.getEmptyTexture()
      return {
        enabled: false,
        combine: 0,
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
        combine: 0,
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
    const textures = frames.map(frame =>
      this.createFieldTexture(frame.values || [], grid, valueRange)
    )
    const baseTexture = textures[0] || this.getEmptyTexture()
    const combineMap = { replace: 0, max: 1, add: 2 }
    const combine = combineMap[field.combine] ?? 0

    return {
      enabled: true,
      combine,
      texture: baseTexture,
      textures,
      textureSize,
      gridSize,
      size: sizeVec,
      worldToLocal
    }
  }

  computeWorldToLocal(origin) {
    const position = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
    const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(position)
    return Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
  }

  resolveSourcesModelCenters(model, sourcesFixed4) {
    const worldToLocal = this.resolveModelWorldToLocal(model)
    return (sourcesFixed4 || []).map(s => {
      if (!s?.center) return new Cesium.Cartesian3(0, 0, 0)
      if (!worldToLocal) return new Cesium.Cartesian3(s.center.x, s.center.y, s.center.z)
      return Cesium.Matrix4.multiplyByPoint(worldToLocal, s.center, new Cesium.Cartesian3())
    })
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
          const v = values[valueIndex] ?? min
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
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST
    })

    return { enabled: true, texture, size }
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

  normalizeRange(values, valueRange) {
    if (Array.isArray(valueRange) && valueRange.length === 2) {
      return { min: valueRange[0], max: valueRange[1] }
    }
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const v of values) {
      if (typeof v !== 'number') continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: 0, max: 1 }
    }
    if (min === max) {
      return { min, max: min + 1 }
    }
    return { min, max }
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
