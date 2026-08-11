import * as Cesium from 'cesium'
import { reactive } from 'vue'

/**
 * 渲染增强管理器
 *
 * 解决问题：单色模型在默认渲染下"扁平化"，看不清局部几何细节
 * （对比犀牛8渲染能看清细节）。核心思路是引入三项关键效果：
 *   1. 环境光遮蔽 (Ambient Occlusion) —— 凹陷/缝隙变暗，凸显几何起伏
 *   2. 太阳光照                     —— 不同朝向面产生明暗对比
 *   3. 阴影                         —— 增加深度感与空间层次
 *
 * 用法：
 *   const m = createRenderEnhancementManager()
 *   m.attach(viewer)
 *   m.setEnabled(true)
 *   m.setEffectEnabled('ambientOcclusion', true)
 */

// 默认参数（参考 Cesium 官方推荐与工程模型场景调校）
export const DEFAULT_RENDER_ENHANCEMENT_CONFIG = {
  enabled: true, // 总开关
  ambientOcclusion: {
    enabled: true,
    intensity: 2.4,
    bias: 0.12,
    lengthCap: 0.04,
    stepSize: 1.0,
    blurStepSize: 0.86
  },
  lighting: {
    enabled: true,
    // 太阳位置由场景自动决定；这里保留亮度系数
    brightness: 1.0,
    dynamicAtmosphereLighting: false // 工业模型场景不需要大气散射
  },
  shadow: {
    // 默认关闭：3D Tiles 模型自阴影会产生条纹瑕疵（shadow acne）
    // 需要时可手动开启，但建议配合更大的 size 和 darkness 调节
    enabled: false,
    softShadows: true,
    size: 4096,
    darkness: 0.3
  }
}

const AO_STAGE_NAME = 'czm_ambient_occlusion_enhanced'

function isViewerValid(viewer) {
  return viewer && !viewer.isDestroyed?.() && viewer.scene
}

/**
 * 创建渲染增强管理器（单例由调用方保证）
 */
export function createRenderEnhancementManager() {
  const state = reactive({
    config: JSON.parse(JSON.stringify(DEFAULT_RENDER_ENHANCEMENT_CONFIG)),
    attached: false,
    available: false // 运行环境是否支持（如 WebGL2/扩展缺失会置 false）
  })

  let viewerRef = null
  let aoStage = null
  // 保存原始场景设置，便于卸载/关闭时回滚
  const originalSceneSettings = {
    enableLighting: null,
    dynamicAtmosphereLighting: null,
    dynamicAtmosphereLightingFromSun: null
  }
  const originalShadowSettings = {
    enabled: null,
    softShadows: null,
    size: null,
    darkness: null
  }

  function recordOriginal() {
    const scene = viewerRef?.scene
    if (!scene) return
    const globe = scene.globe
    const shadowMap = scene.shadowMap
    if (globe) {
      originalSceneSettings.enableLighting = globe.enableLighting
      originalSceneSettings.dynamicAtmosphereLighting = globe.dynamicAtmosphereLighting
      originalSceneSettings.dynamicAtmosphereLightingFromSun =
        globe.dynamicAtmosphereLightingFromSun
    }
    if (shadowMap) {
      originalShadowSettings.enabled = shadowMap.enabled
      originalShadowSettings.softShadows = shadowMap.softShadows
      originalShadowSettings.size = shadowMap.size
      originalShadowSettings.darkness = shadowMap.darkness
    }
  }

  function restoreOriginal() {
    const scene = viewerRef?.scene
    if (!scene) return
    if (scene.globe) {
      if (originalSceneSettings.enableLighting !== null)
        scene.globe.enableLighting = originalSceneSettings.enableLighting
      if (originalSceneSettings.dynamicAtmosphereLighting !== null)
        scene.globe.dynamicAtmosphereLighting =
          originalSceneSettings.dynamicAtmosphereLighting
      if (originalSceneSettings.dynamicAtmosphereLightingFromSun !== null)
        scene.globe.dynamicAtmosphereLightingFromSun =
          originalSceneSettings.dynamicAtmosphereLightingFromSun
    }
    if (scene.shadowMap) {
      if (originalShadowSettings.enabled !== null)
        scene.shadowMap.enabled = originalShadowSettings.enabled
      if (originalShadowSettings.softShadows !== null)
        scene.shadowMap.softShadows = originalShadowSettings.softShadows
      if (originalShadowSettings.size !== null)
        scene.shadowMap.size = originalShadowSettings.size
      if (originalShadowSettings.darkness !== null)
        scene.shadowMap.darkness = originalShadowSettings.darkness
    }
  }

  function ensureAoStage() {
    // AO 后处理在当前环境不可用（深度纹理问题导致 _setUniforms 崩溃）
    // 改用 CustomShader 的法线导数边缘检测方案替代
    return null
  }

  function removeAoStage() {
    const scene = viewerRef?.scene
    if (!scene || !aoStage) return
    if (scene.postProcessStages.contains(aoStage)) {
      scene.postProcessStages.remove(aoStage)
    }
    aoStage = null
  }

  function applyAoConfig() {
    if (!aoStage) return
    const cfg = state.config.ambientOcclusion
    aoStage.enabled = state.config.enabled && cfg.enabled
  }

  function applyLightingConfig() {
    const scene = viewerRef?.scene
    if (!scene?.globe) return
    const cfg = state.config.lighting
    const active = state.config.enabled && cfg.enabled

    // globe 光照（影响地形）
    scene.globe.enableLighting = active
    scene.globe.dynamicAtmosphereLighting =
      active && cfg.dynamicAtmosphereLighting
    if (active && !cfg.dynamicAtmosphereLighting) {
      scene.globe.dynamicAtmosphereLightingFromSun = false
    }

    // 3D Tiles 模型光照：设置固定方向的强光，产生明显明暗对比
    // 关键：默认 SunLight 方向可能从正上方照射，明暗对比不明显
    // 改为从侧上方斜射，让模型不同朝向的面有显著亮度差异
    if (active) {
      try {
        // 归一化方向向量（从光源指向场景的反方向）
        const dir = new Cesium.Cartesian3(-0.45, -0.55, -0.7)
        Cesium.Cartesian3.normalize(dir, dir)

        if (Cesium.DirectionalLight) {
          scene.light = new Cesium.DirectionalLight({
            direction: dir,
            color: Cesium.Color.WHITE,
            intensity: Math.max(0.1, cfg.brightness) * 2.0
          })
        }

        // CustomShader：法线导数边缘检测 + 保持明亮
        // 在几何边界处产生高光，凸显局部形状细节
        applyCustomLightingShader(cfg.brightness)

        // 提升 3D Tiles 的 IBL 因子，让环境光照更饱满
        const tileset = findTileset()
        if (tileset && tileset.imageBasedLightingFactor) {
          tileset.imageBasedLightingFactor = new Cesium.Cartesian2(1.0, 1.0)
        }
      } catch (e) {
        console.warn('[RenderEnhancement] 光照设置失败:', e)
      }
    } else {
      // 关闭时移除自定义 shader
      removeCustomLightingShader()
    }
  }

  // ---- 自定义光照 Shader ----
  // 直接在模型 fragment shader 中计算基于法线的漫反射光照
  // 解决 3D Tiles 模型不响应 scene.light 的问题
  let currentLightingShader = null

  function applyCustomLightingShader(brightness, explicitTileset) {
    const tileset = explicitTileset || findTileset()
    if (!tileset) return
    if (!Cesium.CustomShader) {
      console.warn('[RenderEnhancement] 当前 Cesium 版本不支持 CustomShader')
      return
    }

    // 检测外部 shader 覆盖（如应力分析热力图）：
    // 如果 tileset.customShader 已被其他模块设置，不覆盖它，仅重置内部状态
    // 这样在应力分析激活期间，applyAll 不会破坏热力图 shader
    if (
      tileset.customShader &&
      currentLightingShader &&
      tileset.customShader !== currentLightingShader
    ) {
      currentLightingShader = null
      return
    }

    // 已设置且未变化则跳过
    if (currentLightingShader && tileset.customShader === currentLightingShader) {
      // 只更新 uniform 值
      try {
        currentLightingShader.setUniform(
          'u_lightIntensity',
          Math.max(0.1, brightness) * 0.8
        )
      } catch (e) {
        // 安全忽略
      }
      return
    }

    try {
      const shader = new Cesium.CustomShader({
        fragmentShaderText: `
          void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
            // 用位置导数计算平面法线（flat normal）
            vec3 posEC = fsInput.attributes.positionEC;
            vec3 flatNormal = normalize(cross(dFdx(posEC), dFdy(posEC)));
            if (dot(flatNormal, vec3(0.0, 0.0, 1.0)) < 0.0) {
              flatNormal = -flatNormal;
            }

            vec3 originalColor = material.diffuse;

            // 主光照方向
            vec3 lightDir = normalize(vec3(0.5, 0.6, 0.6));
            float diffuse = max(dot(flatNormal, lightDir), 0.0);

            // 明暗对比：暗部 0.55，亮部 1.0（保持整体明亮）
            float lighting = 0.55 + diffuse * 0.45;
            material.diffuse = originalColor * lighting;

            // 柔和高光（降低强度，避免过白）
            float spec = pow(diffuse, 12.0) * 0.15;
            material.diffuse += originalColor * spec;

            // 柔和边缘光
            float rim = 1.0 - max(dot(flatNormal, vec3(0.0, 0.0, 1.0)), 0.0);
            rim = pow(rim, 2.5) * 0.35;
            material.diffuse += originalColor * rim;

            // 二次补光
            vec3 lightDir2 = normalize(vec3(-0.4, -0.3, 0.5));
            float diffuse2 = max(dot(flatNormal, lightDir2), 0.0);
            material.diffuse += originalColor * diffuse2 * 0.12;
          }
        `,
        uniforms: {
          u_lightIntensity: {
            type: Cesium.UniformType.FLOAT,
            value: Math.max(0.1, brightness) * 1.0
          }
        }
      })

      tileset.customShader = shader
      currentLightingShader = shader
    } catch (e) {
      console.warn('[RenderEnhancement] CustomShader 应用失败:', e)
    }
  }

  // 暴露给外部：直接传入 tileset 应用 shader
  function applyToTileset(tileset) {
    if (!tileset) return
    const cfg = state.config.lighting
    if (state.config.enabled && cfg.enabled) {
      applyCustomLightingShader(cfg.brightness, tileset)
    }
  }

  function removeCustomLightingShader() {
    const tileset = findTileset()
    if (tileset && currentLightingShader && tileset.customShader === currentLightingShader) {
      try {
        tileset.customShader = Cesium.CustomShader.fromCache({})
      } catch (e) {
        // 安全忽略
      }
    }
    currentLightingShader = null
  }

  function findTileset() {
    const scene = viewerRef?.scene
    if (!scene?.primitives) return null
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i)
      // 使用 instanceof 检测，避免打包后类名混淆
      if (p && p instanceof Cesium.Cesium3DTileset) {
        return p
      }
    }
    return null
  }

  function applyShadowConfig() {
    const scene = viewerRef?.scene
    if (!scene?.shadowMap) return
    const cfg = state.config.shadow
    const active = state.config.enabled && cfg.enabled
    scene.shadowMap.enabled = active
    if (active) {
      scene.shadowMap.softShadows = cfg.softShadows
      scene.shadowMap.size = cfg.size
      scene.shadowMap.darkness = cfg.darkness
      // 只有支持阴影的光源才能投射阴影
      // DirectionalLight 支持，确保模型投射并接收阴影
      scene.shadowMap.normalOffsetShadows = true
    }

    // 确保 3D Tiles 模型投射并接收阴影
    const tileset = findTileset()
    if (tileset) {
      try {
        tileset.shadows = active
          ? Cesium.ShadowMode.ENABLED
          : Cesium.ShadowMode.DISABLED
      } catch (e) {
        // 安全忽略
      }
    }
  }

  function applyAll() {
    if (!state.attached || !state.available) return
    applyAoConfig()

    // 检测外部 shader 覆盖（如应力分析热力图）：
    // 如果 tileset.customShader 已被其他模块设置，跳过光照和阴影配置，
    // 避免修改 scene.light / tileset.shadows 等状态导致冲突或 Vue 报错。
    // 仅保存 enabled 状态，等退出外部模块后由 applyToTileset 恢复。
    const tileset = findTileset()
    const externalShaderActive =
      tileset &&
      tileset.customShader &&
      currentLightingShader !== tileset.customShader

    if (!externalShaderActive) {
      applyLightingConfig()
      applyShadowConfig()
    }

    viewerRef?.scene?.requestRender?.()
  }

  function attach(viewer) {
    if (!isViewerValid(viewer)) {
      console.warn('[RenderEnhancement] 无效 viewer，attach 失败')
      return false
    }
    if (state.attached && viewerRef === viewer) return true
    detach() // 切换 viewer 先清理

    viewerRef = viewer
    recordOriginal()

    // 检测 AO 能力并创建阶段（AO 失败不影响光照/阴影）
    const stage = ensureAoStage()
    state.aoAvailable = !!stage
    // 整体可用：只要有 viewer 即可，AO 是可选增强
    state.available = true
    state.attached = true

    applyAll()
    return true
  }

  function detach() {
    if (!state.attached) return
    removeAoStage()
    restoreOriginal()
    viewerRef?.scene?.requestRender?.()
    viewerRef = null
    state.attached = false
    state.available = false
  }

  function setEnabled(enabled) {
    state.config.enabled = !!enabled
    applyAll()
  }

  function setEffectEnabled(effectKey, enabled) {
    const target = state.config[effectKey]
    if (!target) return
    target.enabled = !!enabled
    applyAll()
  }

  function setEffectParam(effectKey, paramKey, value) {
    const target = state.config[effectKey]
    if (!target || !(paramKey in target)) return
    target[paramKey] = value
    applyAll()
  }

  function setConfig(nextConfig) {
    if (!nextConfig) return
    if (nextConfig.enabled !== undefined) state.config.enabled = !!nextConfig.enabled
    mergeEffect('ambientOcclusion', nextConfig.ambientOcclusion)
    mergeEffect('lighting', nextConfig.lighting)
    mergeEffect('shadow', nextConfig.shadow)
    applyAll()
  }

  function mergeEffect(key, partial) {
    if (!partial) return
    const target = state.config[key]
    if (!target) return
    for (const k of Object.keys(partial)) {
      target[k] = partial[k]
    }
  }

  function reset() {
    state.config = JSON.parse(JSON.stringify(DEFAULT_RENDER_ENHANCEMENT_CONFIG))
    applyAll()
  }

  function getViewer() {
    return viewerRef
  }

  return {
    state,
    attach,
    detach,
    setEnabled,
    setEffectEnabled,
    setEffectParam,
    setConfig,
    reset,
    getViewer,
    applyToTileset,
    // 暴露内部方法便于面板调用
    applyAll
  }
}

// ---- 单例 ----
let sharedManager = null
export function getRenderEnhancementManager() {
  if (!sharedManager) sharedManager = createRenderEnhancementManager()
  return sharedManager
}
