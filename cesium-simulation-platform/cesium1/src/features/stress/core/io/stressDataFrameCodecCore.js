function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

export function buildFramesFromData(data, { framesCount, total, requiredKeys }) {
  const generator = data?.['生成']
  const framesRaw = Array.isArray(data?.['帧']) ? data['帧'] : null

  if (generator) {
    const generated = generateFrames(generator, framesCount, total, requiredKeys)
    if (!generated.ok) return generated
    return { ok: true, frames: generated.frames }
  }

  if (!framesRaw || framesRaw.length < 1) {
    return { ok: false, message: '数据.帧 不能为空（或提供 数据.生成）' }
  }
  if (framesCount && framesRaw.length !== framesCount) {
    return { ok: false, message: '数据帧数量与时间信息不一致' }
  }

  const frames = []
  for (let i = 0; i < framesRaw.length; i++) {
    const f = framesRaw[i]
    if (!f || typeof f !== 'object') {
      return { ok: false, message: `第 ${i + 1} 帧数据格式错误` }
    }
    const out = { t: f.t ?? i }
    for (const k of requiredKeys) {
      const decoded = decodeComponentArray(f[k], total)
      if (!decoded.ok) return { ok: false, message: `第 ${i + 1} 帧分量 ${k}：${decoded.message}` }
      out[k] = decoded.values
    }
    frames.push(out)
  }

  return { ok: true, frames }
}

export function decodeComponentArray(spec, total) {
  if (Array.isArray(spec)) {
    if (spec.length !== total) return { ok: false, message: `长度必须为 ${total}` }
    for (const v of spec) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, message: '存在非数字' }
    }
    return { ok: true, values: spec }
  }

  if (spec && typeof spec === 'object') {
    const encoding = String(spec['编码'] || '')
    if (encoding === 'RLE') {
      const pairs = Array.isArray(spec['值']) ? spec['值'] : null
      if (!pairs) return { ok: false, message: 'RLE 编码需要 值=[[数值,次数],...]' }
      const out = new Array(total)
      let idx = 0
      for (const p of pairs) {
        const v = Number(p?.[0])
        const c = Number(p?.[1])
        if (!Number.isFinite(v) || !Number.isFinite(c) || c <= 0)
          return { ok: false, message: 'RLE 值非法' }
        const count = Math.floor(c)
        for (let i = 0; i < count && idx < total; i++) {
          out[idx++] = v
        }
        if (idx >= total) break
      }
      if (idx !== total) return { ok: false, message: `RLE 展开长度不等于 ${total}` }
      return { ok: true, values: out }
    }
  }

  return { ok: false, message: '需要数组或 { 编码: RLE, 值: [[v,count],...] }' }
}

export function generateFrames(generator, framesCount, total, requiredKeys) {
  if (!generator || typeof generator !== 'object') {
    return { ok: false, message: '数据.生成 格式错误：需要对象' }
  }
  const type = String(generator['类型'] || '')
  if (type !== '三维高斯' && type !== '复合载荷场') {
    return { ok: false, message: '数据.生成.类型 目前仅支持“三维高斯/复合载荷场”' }
  }
  if (!Number.isInteger(framesCount) || framesCount < 1) {
    return { ok: false, message: '时间信息错误：生成模式需要 时间.时间点 或 时间.帧数' }
  }

  const dims = generator['网格']
  const w = Number(dims?.['宽'])
  const h = Number(dims?.['高'])
  const d = Number(dims?.['深'])
  if (![w, h, d].every(n => Number.isInteger(n) && n > 1)) {
    return { ok: false, message: '数据.生成.网格 需要 {宽,高,深} 且均>1' }
  }
  if (w * h * d !== total) {
    return { ok: false, message: '数据.生成.网格 必须与顶层 网格 一致' }
  }

  if (type === '复合载荷场') {
    return generateFramesCompositeLoad(generator, framesCount, { w, h, d, total, requiredKeys })
  }

  const center = Array.isArray(generator['中心']) ? generator['中心'].map(Number) : [0.5, 0.5, 0.5]
  const sigma = Array.isArray(generator['尺度'])
    ? generator['尺度'].map(Number)
    : [0.18, 0.18, 0.18]
  const base = generator['基准'] && typeof generator['基准'] === 'object' ? generator['基准'] : {}
  const peak = generator['峰值'] && typeof generator['峰值'] === 'object' ? generator['峰值'] : {}
  const time =
    generator['时间函数'] && typeof generator['时间函数'] === 'object' ? generator['时间函数'] : {}

  const period = Math.max(1, Number(time['周期'] || framesCount))
  const bias = Number(time['偏置'] ?? 0.6)
  const amp = Number(time['幅值'] ?? 0.4)

  const safeSigma = sigma.map(v => Math.max(1e-6, Number.isFinite(v) ? v : 0.18))
  const safeCenter = [
    clamp01(Number.isFinite(center[0]) ? center[0] : 0.5),
    clamp01(Number.isFinite(center[1]) ? center[1] : 0.5),
    clamp01(Number.isFinite(center[2]) ? center[2] : 0.5)
  ]

  const frames = []
  for (let t = 0; t < framesCount; t++) {
    const f = { t }
    const tf = clamp01(bias + amp * Math.sin((2 * Math.PI * t) / period))

    for (const k of requiredKeys) {
      const b = Number(base[k] ?? 0)
      const p = Number(peak[k] ?? (k === 'xx' || k === 'yy' || k === 'zz' ? 1 : 0.3))
      const out = new Array(total)
      let idx = 0
      for (let zz = 0; zz < d; zz++) {
        const nz = zz / (d - 1)
        for (let yy = 0; yy < h; yy++) {
          const ny = yy / (h - 1)
          for (let xx = 0; xx < w; xx++) {
            const nx = xx / (w - 1)
            const gx = (nx - safeCenter[0]) / safeSigma[0]
            const gy = (ny - safeCenter[1]) / safeSigma[1]
            const gz = (nz - safeCenter[2]) / safeSigma[2]
            const g = Math.exp(-(gx * gx + gy * gy + gz * gz))
            const s = b + p * g * tf
            const sign = (xx + yy + zz) % 2 === 0 ? 1 : -1
            out[idx++] = k === 'xy' || k === 'yz' || k === 'zx' ? s * sign : s
          }
        }
      }
      f[k] = out
    }
    frames.push(f)
  }
  return { ok: true, frames }
}

export function generateFramesCompositeLoad(
  generator,
  framesCount,
  { w, h, d, total, requiredKeys }
) {
  const time =
    generator['时间函数'] && typeof generator['时间函数'] === 'object' ? generator['时间函数'] : {}
  const period = Math.max(2, Number(time['周期'] || framesCount))

  const loads = generator['载荷'] && typeof generator['载荷'] === 'object' ? generator['载荷'] : {}
  const axial = loads['轴向'] && typeof loads['轴向'] === 'object' ? loads['轴向'] : {}
  const bendY = loads['弯曲Y'] && typeof loads['弯曲Y'] === 'object' ? loads['弯曲Y'] : {}
  const bendZ = loads['弯曲Z'] && typeof loads['弯曲Z'] === 'object' ? loads['弯曲Z'] : {}
  const torsion = loads['扭转'] && typeof loads['扭转'] === 'object' ? loads['扭转'] : {}
  const hotspots = Array.isArray(loads['热点']) ? loads['热点'] : []

  const aAx = Number.isFinite(axial['幅值']) ? Number(axial['幅值']) : 8e-5
  const aBy = Number.isFinite(bendY['幅值']) ? Number(bendY['幅值']) : 6e-5
  const aBz = Number.isFinite(bendZ['幅值']) ? Number(bendZ['幅值']) : 4e-5
  const aTor = Number.isFinite(torsion['幅值']) ? Number(torsion['幅值']) : 5e-5

  const phaseAx = (Number(axial['相位'] || 0) * Math.PI) / 180
  const phaseBy = (Number(bendY['相位'] || 90) * Math.PI) / 180
  const phaseBz = (Number(bendZ['相位'] || 180) * Math.PI) / 180
  const phaseTor = (Number(torsion['相位'] || 45) * Math.PI) / 180

  const biasAx = Number.isFinite(axial['偏置']) ? Number(axial['偏置']) : 0
  const biasBy = Number.isFinite(bendY['偏置']) ? Number(bendY['偏置']) : 0
  const biasBz = Number.isFinite(bendZ['偏置']) ? Number(bendZ['偏置']) : 0
  const biasTor = Number.isFinite(torsion['偏置']) ? Number(torsion['偏置']) : 0

  const clamp = v => (Number.isFinite(v) ? v : 0)
  const safeHotspots = hotspots
    .map(hs => {
      const c = Array.isArray(hs?.['中心']) ? hs['中心'].map(Number) : null
      const s = Array.isArray(hs?.['尺度']) ? hs['尺度'].map(Number) : null
      const wgt = hs?.['权重'] && typeof hs['权重'] === 'object' ? hs['权重'] : {}
      if (!c || c.length < 3 || !s || s.length < 3) return null
      const center = [clamp01(Number(c[0])), clamp01(Number(c[1])), clamp01(Number(c[2]))]
      const sigma = [
        Math.max(1e-6, clamp(s[0])),
        Math.max(1e-6, clamp(s[1])),
        Math.max(1e-6, clamp(s[2]))
      ]
      return {
        center,
        sigma,
        weights: {
          xx: clamp(wgt['xx']),
          yy: clamp(wgt['yy']),
          zz: clamp(wgt['zz']),
          xy: clamp(wgt['xy']),
          yz: clamp(wgt['yz']),
          zx: clamp(wgt['zx'])
        }
      }
    })
    .filter(Boolean)

  const frames = []
  for (let t = 0; t < framesCount; t++) {
    const tt = (2 * Math.PI * t) / period
    const fAx = biasAx + aAx * Math.sin(tt + phaseAx)
    const fBy = biasBy + aBy * Math.sin(tt + phaseBy)
    const fBz = biasBz + aBz * Math.sin(tt + phaseBz)
    const fTor = biasTor + aTor * Math.sin(tt + phaseTor)

    const out = { t }
    for (const k of requiredKeys) out[k] = new Array(total)

    let idx = 0
    for (let zz = 0; zz < d; zz++) {
      const nz01 = zz / (d - 1)
      const nz = nz01 * 2 - 1
      for (let yy = 0; yy < h; yy++) {
        const ny01 = yy / (h - 1)
        const ny = ny01 * 2 - 1
        for (let xx = 0; xx < w; xx++) {
          const nx01 = xx / (w - 1)
          const nx = nx01 * 2 - 1

          let exx = fAx * (1 + 0.15 * nz) + fBy * ny + fBz * nz
          let eyy = -0.35 * exx + 0.25 * fBy * -ny + 0.08 * fBz * nx
          let ezz = -0.25 * exx + 0.1 * fBy * nx + 0.2 * fBz * -nz
          let exy = fTor * -nz * (0.8 + 0.2 * Math.cos(Math.PI * nx))
          let eyz = fTor * nx * (0.8 + 0.2 * Math.cos(Math.PI * ny))
          let ezx = fTor * ny * (0.8 + 0.2 * Math.cos(Math.PI * nz))

          for (const hs of safeHotspots) {
            const gx = (nx01 - hs.center[0]) / hs.sigma[0]
            const gy = (ny01 - hs.center[1]) / hs.sigma[1]
            const gz = (nz01 - hs.center[2]) / hs.sigma[2]
            const g = Math.exp(-(gx * gx + gy * gy + gz * gz))
            exx += hs.weights.xx * g
            eyy += hs.weights.yy * g
            ezz += hs.weights.zz * g
            exy += hs.weights.xy * g
            eyz += hs.weights.yz * g
            ezx += hs.weights.zx * g
          }

          out.xx[idx] = exx
          out.yy[idx] = eyy
          out.zz[idx] = ezz
          out.xy[idx] = exy
          out.yz[idx] = eyz
          out.zx[idx] = ezx
          idx++
        }
      }
    }

    frames.push(out)
  }
  return { ok: true, frames }
}

export function buildTimeAxis(time) {
  const frames = Number(time?.frames ?? time?.['帧数'] ?? 0)
  const timePoints = Array.isArray(time?.timePoints)
    ? time.timePoints.map(Number)
    : Array.isArray(time?.['时间点'])
      ? time['时间点'].map(Number)
      : null
  const n = Number.isInteger(frames) && frames > 0 ? frames : timePoints?.length || 0
  return {
    frames: n,
    timePoints:
      timePoints && timePoints.length === n ? timePoints : Array.from({ length: n }, (_, i) => i)
  }
}
