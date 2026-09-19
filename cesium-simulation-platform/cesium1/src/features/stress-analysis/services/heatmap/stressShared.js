import * as Cesium from 'cesium'

/**
 * 应力热力图跨域共享常量与纯函数（stressShared）
 *
 * HeatmapManager 拆分出的各域（stressConfigDomain / shaderBuilder / textureLifecycle /
 * timeSeriesDomain）共同消费的常量与无状态纯函数统一收敛到本文件：域间互不引用，
 * 跨域取用要么经本模块（纯函数/常量），要么经门面实例 this.m（共享状态）。
 */

// 应力源数量上限（着色器源纹理宽度、直传源切片与 directSourceLimit 钳制的统一上限）
export const MAX_SOURCE_COUNT = 1000

/**
 * @typedef {{
 *   __STRESS_DEBUG__?: boolean,
 *   __STRESS_DEBUG_THROTTLE_MS__?: number
 * }} StressDebugWindow
 */

/**
 * @returns {StressDebugWindow | null}
 */
export function getStressDebugWindow() {
  if (typeof window === 'undefined') return null
  return /** @type {StressDebugWindow} */ (window)
}

export function isStressDebugEnabled() {
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

export function resolveModelWorldToLocal(model) {
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

function readStoredCenterMC(stored) {
  if (
    stored &&
    typeof stored === 'object' &&
    Number.isFinite(stored.x) &&
    Number.isFinite(stored.y) &&
    Number.isFinite(stored.z)
  ) {
    return new Cesium.Cartesian3(stored.x, stored.y, stored.z)
  }
  if (Array.isArray(stored) && stored.length >= 3 && stored.slice(0, 3).every(Number.isFinite)) {
    return new Cesium.Cartesian3(stored[0], stored[1], stored[2])
  }
  return null
}

function computeCenterMC(raw, stored, worldToLocal, source) {
  if (!worldToLocal) return new Cesium.Cartesian3(0, 0, 0)
  const computed = Cesium.Matrix4.multiplyByPoint(
    worldToLocal,
    source?.center || new Cesium.Cartesian3(0, 0, 0),
    new Cesium.Cartesian3()
  )
  if (raw && stored === null) raw.centerMC = { x: computed.x, y: computed.y, z: computed.z }
  return computed
}

export function createModelCenterResolver(rawSources, worldToLocal) {
  return source => {
    const idx = Number.isInteger(source?.idx) && source.idx >= 0 ? source.idx : null
    const raw = idx !== null ? rawSources[idx] : null
    const stored = raw?.centerMC ?? raw?.centerMc ?? raw?.center_model ?? null
    return readStoredCenterMC(stored) || computeCenterMC(raw, stored, worldToLocal, source)
  }
}
