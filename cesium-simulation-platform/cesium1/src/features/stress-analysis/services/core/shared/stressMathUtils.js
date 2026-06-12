/**
 * 应力分析模块公共数学工具函数
 * 集中管理被多个文件重复实现的基础数学工具，消除重复代码
 */

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

export function clamp01(value) {
  return clamp(value, 0, 1)
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : []
}

export function parseSizeArray(size, defaults = [200, 200, 100]) {
  return Array.isArray(size) && size.length >= 3
    ? [
        toNumberOrDefault(size[0], defaults[0]),
        toNumberOrDefault(size[1], defaults[1]),
        toNumberOrDefault(size[2], defaults[2])
      ]
    : defaults
}

export function fract(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return n - Math.floor(n)
}
