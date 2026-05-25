/**
 * Worker安全工具函数（无Cesium依赖）
 * 这些函数可在Web Worker中使用
 */

// ============ 点位中心解析 ============

export function parsePointCenter(
  point,
  { clampUVW = false, allowCenterWGS84Alias = false, validateWgs84All = true } = {}
) {
  const uvw = Array.isArray(point?.['中心_UVW'])
    ? point['中心_UVW'].map(Number)
    : Array.isArray(point?.centerUVW)
      ? point.centerUVW.map(Number)
      : null
  if (uvw && uvw.length >= 3 && uvw.every(Number.isFinite)) {
    return {
      ok: true,
      data: {
        coordMode: 'UVW',
        center: clampUVW ? [clamp01(uvw[0]), clamp01(uvw[1]), clamp01(uvw[2])] : uvw.slice(0, 3)
      }
    }
  }

  const enu = Array.isArray(point?.['中心_ENU_m'])
    ? point['中心_ENU_m'].map(Number)
    : Array.isArray(point?.centerENU)
      ? point.centerENU.map(Number)
      : null
  if (enu && enu.length >= 3 && enu.every(Number.isFinite)) {
    return { ok: true, data: { coordMode: 'ENU', center: enu.slice(0, 3) } }
  }

  const wgs84Source = Array.isArray(point?.['中心_WGS84'])
    ? point['中心_WGS84']
    : Array.isArray(point?.centerWGS84)
      ? point.centerWGS84
      : allowCenterWGS84Alias && Array.isArray(point?.center)
        ? point.center
        : null
  const wgs84 = Array.isArray(wgs84Source) ? wgs84Source.map(Number) : null
  const validWgs84 = validateWgs84All
    ? wgs84 && wgs84.length >= 2 && wgs84.every(Number.isFinite)
    : wgs84 && wgs84.length >= 2 && wgs84.slice(0, 3).every(Number.isFinite)
  if (validWgs84) {
    return { ok: true, data: { coordMode: 'WGS84', center: [wgs84[0], wgs84[1], wgs84[2] || 0] } }
  }

  return { ok: false, data: null }
}

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

// ============ 基础数学工具 ============

export function toNumberOrDefault(value, defaultValue) {
  const n = Number(value)
  return Number.isFinite(n) ? n : defaultValue
}

export function toFiniteNumber(value, defaultValue = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : defaultValue
}

export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

export function clampInt(value, min, max) {
  const n = Math.round(Number(value) || 0)
  return Math.max(min, Math.min(max, n))
}
