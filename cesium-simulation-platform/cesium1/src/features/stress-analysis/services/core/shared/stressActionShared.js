export const resolvePointSourceStrategy = value =>
  (typeof value === 'string' ? value : value?.sourceStrategy) === 'full' ? 'full' : 'top4'

export const resolvePointRenderMode = value => {
  const mode = typeof value === 'string' ? value : value?.renderMode
  if (mode === 'kriging') return 'kriging'
  if (mode === 'idw') return 'idw'
  return 'points'
}

export const resolveTimeDimension = value => {
  const s = String(value || '').trim()
  return s || '秒'
}

export const resolvePlaybackSpeedMs = value => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 500
}

export function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function resolveLinearElasticMaterial(material) {
  const E = Number(material?.E)
  const nu = Number(material?.nu)
  if (!(Number.isFinite(E) && E > 0)) {
    throw new Error('应力计算失败：材料参数 E 必须为正数')
  }
  if (!(Number.isFinite(nu) && nu > -1 + 1e-6 && nu < 0.5 - 1e-6)) {
    throw new Error('应力计算失败：泊松比 ν 必须满足 -1 < ν < 0.5')
  }
  return { E, nu }
}

export function buildStrainStressCoefficients(material) {
  const { E, nu } = resolveLinearElasticMaterial(material)
  return {
    lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)),
    mu: E / (2 * (1 + nu)),
    shearIsEngineering: material?.shearDef === '工程'
  }
}

export function stressFromStrainByCoefficients(tensor6, coeffs) {
  const lambda = Number(coeffs?.lambda) || 0
  const mu = Number(coeffs?.mu) || 0
  const shearIsEngineering = Boolean(coeffs?.shearIsEngineering)
  const exx = Number(tensor6?.xx) || 0
  const eyy = Number(tensor6?.yy) || 0
  const ezz = Number(tensor6?.zz) || 0
  const exy = shearIsEngineering ? (Number(tensor6?.xy) || 0) * 0.5 : Number(tensor6?.xy) || 0
  const eyz = shearIsEngineering ? (Number(tensor6?.yz) || 0) * 0.5 : Number(tensor6?.yz) || 0
  const ezx = shearIsEngineering ? (Number(tensor6?.zx) || 0) * 0.5 : Number(tensor6?.zx) || 0
  const tr = exx + eyy + ezz
  return {
    sxx: 2 * mu * exx + lambda * tr,
    syy: 2 * mu * eyy + lambda * tr,
    szz: 2 * mu * ezz + lambda * tr,
    sxy: 2 * mu * exy,
    syz: 2 * mu * eyz,
    szx: 2 * mu * ezx
  }
}

export function stressFromStrainTensor(tensor6, material) {
  return stressFromStrainByCoefficients(tensor6, buildStrainStressCoefficients(material))
}

// 统一的方向和叠加签名工具函数（消除重复）
export function buildDirectionSignature(direction) {
  if (!direction || typeof direction !== 'object') return '0|0'
  const azimuth = Number(direction.azimuthDeg)
  const dip = Number(direction.dipDeg)
  return `${Number.isFinite(azimuth) ? azimuth : 0}|${Number.isFinite(dip) ? dip : 0}`
}

export function buildOverlaySignature(overlayItems) {
  if (!Array.isArray(overlayItems) || overlayItems.length < 1) return ''
  return overlayItems
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const metric = String(item.metric || '')
      const weight = Number(item.weight)
      return `${metric}:${Number.isFinite(weight) ? weight : 0}`
    })
    .join(',')
}

export function resolvePointOffset(point, size) {
  const sx = Number(size?.[0]) || 200
  const sy = Number(size?.[1]) || 200
  const sz = Number(size?.[2]) || 100
  if (point?.coordMode === 'ENU') {
    return {
      dx: Number(point.center?.[0] || 0),
      dy: Number(point.center?.[1] || 0),
      dz: Number(point.center?.[2] || 0)
    }
  }
  const u = Number(point?.center?.[0] || 0.5)
  const v = Number(point?.center?.[1] || 0.5)
  const w = Number(point?.center?.[2] || 0.5)
  return {
    dx: (clamp01(u) - 0.5) * sx,
    dy: (clamp01(v) - 0.5) * sy,
    dz: (clamp01(w) - 0.5) * sz
  }
}
