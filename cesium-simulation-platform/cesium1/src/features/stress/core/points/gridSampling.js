import * as Cesium from 'cesium'
import { stressFromStrain, isFiniteStressTensor, buildStressDetails } from './stressTensorUtils.js'
import { buildDirectionVector } from '../computation/stressComputation.js'

/**
 * 构建用于三线性插值的采样上下文。
 */
export function buildGridSampleContext(positionWC, grid, origin, size) {
  const w = Number(grid.width)
  const h = Number(grid.height)
  const d = Number(grid.depth)
  if (!(w > 1 && h > 1 && d > 1)) return null

  const position = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(position)
  const worldToLocal = Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
  const local = Cesium.Matrix4.multiplyByPoint(worldToLocal, positionWC, new Cesium.Cartesian3())

  const sx = Number(size[0])
  const sy = Number(size[1])
  const sz = Number(size[2])
  const px = local.x + sx * 0.5
  const py = local.y + sy * 0.5
  const pz = local.z + sz * 0.5
  if (px < 0 || py < 0 || pz < 0 || px > sx || py > sy || pz > sz) return null

  const u = px / Math.max(1e-6, sx)
  const v = py / Math.max(1e-6, sy)
  const u3 = pz / Math.max(1e-6, sz)

  const gx = u * (w - 1)
  const gy = v * (h - 1)
  const gz = u3 * (d - 1)

  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const z0 = Math.floor(gz)
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const z1 = Math.min(z0 + 1, d - 1)

  const fx = gx - x0
  const fy = gy - y0
  const fz = gz - z0

  const idx = (x, y, z) => z * w * h + y * w + x
  const i000 = idx(x0, y0, z0)
  const i100 = idx(x1, y0, z0)
  const i010 = idx(x0, y1, z0)
  const i110 = idx(x1, y1, z0)
  const i001 = idx(x0, y0, z1)
  const i101 = idx(x1, y0, z1)
  const i011 = idx(x0, y1, z1)
  const i111 = idx(x1, y1, z1)

  const w000 = (1 - fx) * (1 - fy) * (1 - fz)
  const w100 = fx * (1 - fy) * (1 - fz)
  const w010 = (1 - fx) * fy * (1 - fz)
  const w110 = fx * fy * (1 - fz)
  const w001 = (1 - fx) * (1 - fy) * fz
  const w101 = fx * (1 - fy) * fz
  const w011 = (1 - fx) * fy * fz
  const w111 = fx * fy * fz

  return {
    total: w * h * d,
    i000,
    i100,
    i010,
    i110,
    i001,
    i101,
    i011,
    i111,
    w000,
    w100,
    w010,
    w110,
    w001,
    w101,
    w011,
    w111
  }
}

/**
 * 使用采样上下文对数值数组进行三线性插值。
 */
export function sampleWithContext(values, ctx) {
  if (!ctx || !Array.isArray(values) || values.length !== ctx.total) return null
  return (
    values[ctx.i000] * ctx.w000 +
    values[ctx.i100] * ctx.w100 +
    values[ctx.i010] * ctx.w010 +
    values[ctx.i110] * ctx.w110 +
    values[ctx.i001] * ctx.w001 +
    values[ctx.i101] * ctx.w101 +
    values[ctx.i011] * ctx.w011 +
    values[ctx.i111] * ctx.w111
  )
}

/**
 * 对单个时间帧的六分量张量数组进行采样，返回张量对象。
 */
export function sampleTensor6AtContext(src, ctx) {
  const xx = sampleWithContext(src.xx, ctx)
  const yy = sampleWithContext(src.yy, ctx)
  const zz = sampleWithContext(src.zz, ctx)
  const xy = sampleWithContext(src.xy, ctx)
  const yz = sampleWithContext(src.yz, ctx)
  const zx = sampleWithContext(src.zx, ctx)
  if (![xx, yy, zz, xy, yz, zx].every(Number.isFinite)) return null
  return { xx, yy, zz, xy, yz, zx }
}

/**
 * 将采样的张量（可能是应变）转换为应力张量。
 */
export function toStressTensor(ds, tensor6) {
  if (!tensor6) return null
  if (ds.data.type === '应变') {
    return stressFromStrain(tensor6, ds.material)
  }
  return {
    sxx: tensor6.xx,
    syy: tensor6.yy,
    szz: tensor6.zz,
    sxy: tensor6.xy,
    syz: tensor6.yz,
    szx: tensor6.zx
  }
}

/**
 * 在指定时间和位置采样应力张量。
 */
export function sampleStressAtTime(ds, positionWC, timeIndex) {
  if (!ds) return null
  const src = ds.data?.frames?.[Math.max(0, Math.min(ds.data.frames.length - 1, timeIndex))]
  if (!src) return null

  const ctx = buildGridSampleContext(positionWC, ds.grid, ds.origin, ds.size)
  if (!ctx) return null

  const xx = sampleWithContext(src.xx, ctx)
  const yy = sampleWithContext(src.yy, ctx)
  const zz = sampleWithContext(src.zz, ctx)
  const xy = sampleWithContext(src.xy, ctx)
  const yz = sampleWithContext(src.yz, ctx)
  const zx = sampleWithContext(src.zx, ctx)
  if (![xx, yy, zz, xy, yz, zx].every(Number.isFinite)) return null

  if (ds.data.type === '应变') {
    return stressFromStrain({ xx, yy, zz, xy, yz, zx }, ds.material)
  }

  return { sxx: xx, syy: yy, szz: zz, sxy: xy, syz: yz, szx: zx }
}

/**
 * 计算指定位置和时间点的详细应力信息。
 */
export function computePointDetailsAtTime(ds, positionWC, timeIndex, direction) {
  if (!ds || !positionWC) return null
  const s = sampleStressAtTime(ds, positionWC, timeIndex)
  if (!isFiniteStressTensor(s)) return null

  const n = buildDirectionVector(direction || { azimuthDeg: 0, dipDeg: 0 })
  const details = buildStressDetails(s, n)

  return {
    tensor: s,
    principal: details.principal,
    invariants: details.invariants,
    traction: details.traction
  }
}

/**
 * 从网格数据中采样标量值（例如某一分量的数值数组）。
 */
export function sampleGridScalarAt(positionWC, values, grid, origin, size) {
  const ctx = buildGridSampleContext(positionWC, grid, origin, size)
  return sampleWithContext(values, ctx)
}
