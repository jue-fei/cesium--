import * as Cesium from 'cesium'
import {
  buildSafetyContext,
  resolveLithologyRiskFactor,
  resolvePointLocalPosition
} from './index.js'

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function buildDatasetSignature(sourceKind, data) {
  if (sourceKind === 'points') {
    const count = Array.isArray(data?.points) ? data.points.length : 0
    const frames = Number(data?.time?.frames) || 0
    return `p:${count}:${frames}:${Number(data?.material?.yieldStrength) || 0}:${Number(data?.algo?.stressRef) || 0}`
  }
  if (sourceKind === 'grid') {
    const grid = data?.grid || {}
    const frames = Number(data?.time?.frames) || 0
    return `g:${Number(grid.width) || 0}x${Number(grid.height) || 0}x${Number(grid.depth) || 0}:${frames}:${Number(data?.material?.yieldStrength) || 0}`
  }
  return 'none'
}

function resolveDatasetOrigin(
  sourceKind,
  data,
  { tileset, viewer, resolveOriginFromModelCenter, resolveOriginFromViewer }
) {
  if (!data) return null
  if (Array.isArray(data.origin) && data.origin.length >= 2 && data.originMode !== '模型中心') {
    return data.origin.slice(0, 3)
  }
  if (data.originMode === '模型中心') {
    const byModel = resolveOriginFromModelCenter?.(tileset)
    if (Array.isArray(byModel) && byModel.length >= 2) return byModel
    const byViewer = resolveOriginFromViewer?.(viewer)
    if (Array.isArray(byViewer) && byViewer.length >= 2) return byViewer
  }
  return Array.isArray(data.origin) && data.origin.length >= 2 ? data.origin.slice(0, 3) : null
}

function createOriginTransforms(origin) {
  if (!Array.isArray(origin) || origin.length < 2) return null
  const cartesian = Cesium.Cartesian3.fromDegrees(origin[0], origin[1], origin[2] || 0)
  const localToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(cartesian)
  const worldToLocal = Cesium.Matrix4.inverse(localToWorld, new Cesium.Matrix4())
  return { localToWorld, worldToLocal }
}

function projectDegreesToLocalPos(degrees, size, transforms) {
  if (!Array.isArray(degrees) || degrees.length < 2 || !transforms) return null
  const cartesian = Cesium.Cartesian3.fromDegrees(degrees[0], degrees[1], degrees[2] || 0)
  const local = Cesium.Matrix4.multiplyByPoint(
    transforms.worldToLocal,
    cartesian,
    new Cesium.Cartesian3()
  )
  const sx = Math.max(1e-6, Number(size?.[0]) || 1)
  const sy = Math.max(1e-6, Number(size?.[1]) || 1)
  const sz = Math.max(1e-6, Number(size?.[2]) || 1)
  return [clamp01(local.x / sx + 0.5), clamp01(local.y / sy + 0.5), clamp01(local.z / sz + 0.5)]
}

function sampleVonMisesFromTensor(s) {
  const p = (Number(s.sxx) + Number(s.syy) + Number(s.szz)) / 3
  const dxx = Number(s.sxx) - p
  const dyy = Number(s.syy) - p
  const dzz = Number(s.szz) - p
  const j2 =
    0.5 * (dxx * dxx + dyy * dyy + dzz * dzz) +
    (Number(s.sxy) ** 2 + Number(s.syz) ** 2 + Number(s.szx) ** 2)
  return Math.sqrt(Math.max(0, 3 * j2))
}

function computeStressReferenceForPoints(data) {
  const yieldStrength = Number(data?.material?.yieldStrength)
  if (Number.isFinite(yieldStrength) && yieldStrength > 0) return yieldStrength
  const stressRef = Number(data?.algo?.stressRef)
  if (Number.isFinite(stressRef) && stressRef > 0) return stressRef
  const samples = []
  for (const point of Array.isArray(data?.points) ? data.points : []) {
    if (Array.isArray(point?.stressSeries)) {
      for (const value of point.stressSeries) {
        const n = Number(value)
        if (Number.isFinite(n) && n > 0) samples.push(n)
      }
    }
  }
  if (samples.length < 1) return 1
  samples.sort((a, b) => a - b)
  return samples[Math.max(0, Math.min(samples.length - 1, Math.floor(samples.length * 0.9)))] || 1
}

function computeStressReferenceForGrid(data) {
  const yieldStrength = Number(data?.material?.yieldStrength)
  if (Number.isFinite(yieldStrength) && yieldStrength > 0) return yieldStrength
  const frames = Array.isArray(data?.data?.frames) ? data.data.frames : []
  const grid = data?.grid || {}
  const total = Math.max(
    1,
    (Number(grid.width) || 1) *
      (Number(grid.height) || 1) *
      (Number(grid.depth) || 1) *
      Math.max(1, frames.length)
  )
  const step = Math.max(1, Math.floor(total / 6000))
  const samples = []
  let globalIndex = 0
  for (const frame of frames) {
    const frameLength = Array.isArray(frame?.xx) ? frame.xx.length : 0
    for (let i = 0; i < frameLength; i++) {
      if (globalIndex % step === 0) {
        samples.push(
          sampleVonMisesFromTensor({
            sxx: frame.xx[i],
            syy: frame.yy[i],
            szz: frame.zz[i],
            sxy: frame.xy[i],
            syz: frame.yz[i],
            szx: frame.zx[i]
          })
        )
      }
      globalIndex++
    }
  }
  const valid = samples.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (valid.length < 1) return 1
  return valid[Math.max(0, Math.min(valid.length - 1, Math.floor(valid.length * 0.9)))] || 1
}

function attachPointLocalPositions(data, transforms) {
  if (!data || !Array.isArray(data.points)) return
  for (const point of data.points) {
    if (!point || typeof point !== 'object') continue
    if (point.coordMode === 'WGS84' && Array.isArray(point.center) && point.center.length >= 2) {
      const localPos = projectDegreesToLocalPos(point.center, data.size, transforms)
      if (localPos) point.localPos = localPos
      continue
    }
    point.localPos = resolvePointLocalPosition(point, data.size)
  }
}

function buildGeologySamples(boreholes, size, transforms) {
  const list = []
  for (const borehole of Array.isArray(boreholes) ? boreholes : []) {
    if (!borehole || !Number.isFinite(Number(borehole.x)) || !Number.isFinite(Number(borehole.y)))
      continue
    const localPos = projectDegreesToLocalPos(
      [Number(borehole.x), Number(borehole.y), Number(borehole.z) || 0],
      size,
      transforms
    )
    if (!localPos) continue
    const layers = Array.isArray(borehole.stratigraphy) ? borehole.stratigraphy : []
    if (layers.length < 1) {
      list.push({
        localPos,
        lithology: '未知岩性',
        thickness: Number(borehole.depth) || 0,
        risk: 0.5
      })
      continue
    }
    for (const layer of layers) {
      const lithology = String(layer?.lithology || '未知岩性')
      const thickness = Math.max(0, Number(layer?.thickness) || 0)
      list.push({
        localPos,
        lithology,
        thickness,
        risk: resolveLithologyRiskFactor(lithology, thickness)
      })
    }
  }
  return list
}

export function buildStressSafetyContext(sourceKind, data, options = {}) {
  if (!data || typeof data !== 'object') return buildSafetyContext({ signature: 'none' })
  const origin = resolveDatasetOrigin(sourceKind, data, options)
  const transforms = createOriginTransforms(origin)
  if (sourceKind === 'points') attachPointLocalPositions(data, transforms)
  const geologySamples = buildGeologySamples(options.boreholes, data.size, transforms)
  const stressReference =
    sourceKind === 'points'
      ? computeStressReferenceForPoints(data)
      : computeStressReferenceForGrid(data)
  const geologySignature = geologySamples
    .slice(0, 32)
    .map(sample => `${sample.lithology}:${sample.risk}:${sample.localPos.join(',')}`)
    .join('|')

  return buildSafetyContext({
    signature: `${buildDatasetSignature(sourceKind, data)}::${geologySignature}`,
    stressReference,
    yieldStrength: Number(data?.material?.yieldStrength),
    geologySamples,
    defaultGeologyRisk: geologySamples.length > 0 ? 0.52 : 0.45
  })
}
