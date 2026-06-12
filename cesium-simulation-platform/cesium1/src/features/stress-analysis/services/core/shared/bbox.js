/**
 * 边界框计算公共函数
 * 消除 idwCore.js 中 crossValidationRMSE 和 estimateSmoothnessPenalty 的重复边界框计算逻辑
 */

export function computeBBox(points) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.z < minZ) minZ = p.z
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
    if (p.z > maxZ) maxZ = p.z
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    dx: Math.max(1e-6, maxX - minX),
    dy: Math.max(1e-6, maxY - minY),
    dz: Math.max(1e-6, maxZ - minZ)
  }
}

export function computeBBoxDiagonal(bbox) {
  return Math.sqrt(bbox.dx * bbox.dx + bbox.dy * bbox.dy + bbox.dz * bbox.dz)
}
