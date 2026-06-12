/**
 * 对称3×3矩阵特征值求解 (Jacobi方法)
 * 集中管理 eigenvaluesSymmetric3 实现，消除 safety/index.js 与 computation/index.js 的重复
 */

export function eigenvaluesSymmetric3(m) {
  const eps = 1e-12
  const a00 = Number(m?.m00) || Number(m?.sxx) || 0
  const a11 = Number(m?.m11) || Number(m?.syy) || 0
  const a22 = Number(m?.m22) || Number(m?.szz) || 0
  const a01 = Number(m?.m01) || Number(m?.sxy) || 0
  const a02 = Number(m?.m02) || Number(m?.szx) || 0
  const a12 = Number(m?.m12) || Number(m?.syz) || 0

  const p1 = a01 * a01 + a02 * a02 + a12 * a12
  if (p1 <= eps) return [a00, a11, a22].sort((x, y) => y - x)

  const q = (a00 + a11 + a22) / 3
  const b00 = a00 - q
  const b11 = a11 - q
  const b22 = a22 - q
  const p2 = b00 * b00 + b11 * b11 + b22 * b22 + 2 * p1
  const p = Math.sqrt(p2 / 6)
  if (!(p > eps)) return [a00, a11, a22].sort((x, y) => y - x)

  const invP = 1 / p
  const c00 = b00 * invP
  const c11 = b11 * invP
  const c22 = b22 * invP
  const c01 = a01 * invP
  const c02 = a02 * invP
  const c12 = a12 * invP
  const detC =
    c00 * (c11 * c22 - c12 * c12) - c01 * (c01 * c22 - c12 * c02) + c02 * (c01 * c12 - c11 * c02)
  const r = Math.max(-1, Math.min(1, detC / 2))
  const phi = r <= -1 ? Math.PI / 3 : r >= 1 ? 0 : Math.acos(r) / 3
  const eig1 = q + 2 * p * Math.cos(phi)
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
  const eig2 = 3 * q - eig1 - eig3
  return [eig1, eig2, eig3].sort((x, y) => y - x)
}
