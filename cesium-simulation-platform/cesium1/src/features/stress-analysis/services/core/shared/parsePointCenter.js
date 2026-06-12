/**
 * 点位中心解析公共函数
 * 统一处理 UVW/ENU/WGS84 坐标解析，消除 utils.js 与 utilsWorker.js 中的重复代码
 */

import { clamp01 } from './stressMathUtils.js'

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
