import { buildTimeAxis } from './stressDataFrameCodecCore.js'

function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

export function computePointTensor6FromEngineering(input) {
  const json = input && typeof input === 'object' ? input : {}
  const timeAxis = buildTimeAxis(json['时间'] || json.time)
  const frames = timeAxis.frames
  const points = Array.isArray(json['点'])
    ? json['点']
    : Array.isArray(json.points)
      ? json.points
      : []
  const geometry = json['几何'] || json.geometry || null
  const loads = Array.isArray(json['载荷工况'])
    ? json['载荷工况']
    : Array.isArray(json.loads)
      ? json.loads
      : []

  if (!(frames > 0)) return { ok: false, message: '时间轴无效：无法计算' }
  if (points.length < 1) return { ok: false, message: '点数组为空：无法计算' }

  const section = geometry?.['截面'] || geometry?.section || null
  const area = Number(
    section?.['面积_m2'] ??
      section?.area_m2 ??
      geometry?.['截面积_m2'] ??
      geometry?.area_m2 ??
      geometry?.['截面积'] ??
      geometry?.area
  )
  if (!(Number.isFinite(area) && area > 0)) {
    return { ok: false, message: '几何信息缺少有效截面积：无法计算简化应力' }
  }

  const axialLoads = loads.filter(
    l => (l && typeof l === 'object' ? String(l['类型'] ?? l.type ?? '') : '') === '端面力'
  )
  const baseLoad = axialLoads[0] || null
  if (!baseLoad) return { ok: false, message: '载荷工况缺少“端面力”：无法计算简化应力' }
  const amplitudeN = Number(
    baseLoad['幅值_N'] ?? baseLoad.amplitude_N ?? baseLoad['幅值'] ?? baseLoad.amplitude
  )
  if (!(Number.isFinite(amplitudeN) && amplitudeN !== 0)) {
    return { ok: false, message: '载荷工况幅值无效：无法计算简化应力' }
  }

  const dir = Array.isArray(baseLoad['方向_ENU'] ?? baseLoad.direction_ENU)
    ? (baseLoad['方向_ENU'] ?? baseLoad.direction_ENU).map(Number)
    : [1, 0, 0]
  const dx = Number(dir[0])
  const dy = Number(dir[1])
  const dz = Number(dir[2])
  const dNorm = Math.hypot(dx, dy, dz) || 1
  const ux = dx / dNorm

  const tf = baseLoad['时间函数'] ?? baseLoad.timeFunction ?? {}
  const type = String(tf['类型'] ?? tf.type ?? '常数')
  const factors =
    type === '线性'
      ? timeAxis.timePoints.map(t => {
          const t0 = Number(tf['起始'] ?? tf.t0 ?? timeAxis.timePoints[0] ?? 0)
          const t1 = Number(tf['结束'] ?? tf.t1 ?? timeAxis.timePoints[frames - 1] ?? frames - 1)
          const a0 = clamp01(Number(tf['起始系数'] ?? tf.a0 ?? 0))
          const a1 = clamp01(Number(tf['结束系数'] ?? tf.a1 ?? 1))
          const denom = Math.max(1e-9, t1 - t0)
          const u = clamp01((Number(t) - t0) / denom)
          return a0 + (a1 - a0) * u
        })
      : type === '正弦'
        ? timeAxis.timePoints.map(t => {
            const base = clamp01(Number(tf['基值'] ?? tf.base ?? 0.5))
            const amp = clamp01(Number(tf['幅值'] ?? tf.amp ?? 0.5))
            const w = Number(tf['角频率'] ?? tf.w ?? (Math.PI * 2) / Math.max(1, frames - 1))
            const phi = Number(tf['相位'] ?? tf.phi ?? 0)
            return clamp01(base + amp * Math.sin(w * Number(t) + phi))
          })
        : Array.from({ length: frames }, () => 1)

  const perPoint = points.map(p => {
    const id = String(p?.id ?? p?.ID ?? '')
    const name = String(p?.['名称'] ?? p?.name ?? '')
    const xx = new Array(frames)
    const yy = new Array(frames)
    const zz = new Array(frames)
    const xy = new Array(frames)
    const yz = new Array(frames)
    const zx = new Array(frames)
    for (let i = 0; i < frames; i++) {
      const F = amplitudeN * factors[i]
      const sigma = (F / area) * 1e-6
      xx[i] = sigma * ux
      yy[i] = 0
      zz[i] = 0
      xy[i] = 0
      yz[i] = 0
      zx[i] = 0
    }
    return { id, name, tensor6: { xx, yy, zz, xy, yz, zx } }
  })

  return { ok: true, data: { frames, timePoints: timeAxis.timePoints, points: perPoint } }
}
