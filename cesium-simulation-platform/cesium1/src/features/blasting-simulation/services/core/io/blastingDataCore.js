import { generateBlastingFrames } from '../computation/blastingTrajectoryCore.js'

export const DEFAULT_FRAGMENT_MODEL_URI =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb'

export const DEFAULT_BLASTING_SUMMARY = {
  frameCount: 0,
  fragmentCount: 0,
  durationSec: 0,
  maxWaveRadius: 0,
  holeCount: 0,
  rockBlockCount: 0
}

export const DEFAULT_PLAYBACK_SPEED_MS = 120

function normalizeCenter(input) {
  const center = input && typeof input === 'object' ? input : {}
  const lon = Number(center.lon)
  const lat = Number(center.lat)
  const height = Number(center.height ?? center.alt ?? 0)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { ok: false, message: '爆心坐标缺失，需提供 center.lon 与 center.lat' }
  }
  return {
    ok: true,
    value: { lon, lat, height: Number.isFinite(height) ? height : 0 }
  }
}

function normalizeFragments(rawFragments) {
  if (!Array.isArray(rawFragments) || rawFragments.length < 1) {
    return { ok: false, message: '每帧 fragments 不能为空' }
  }
  const fragments = rawFragments
    .map((item, index) => {
      const id = String(item?.id ?? `F${index + 1}`)
      const lon = Number(item?.position?.lon)
      const lat = Number(item?.position?.lat)
      const height = Number(item?.position?.height ?? 0)
      const size = Number(item?.size ?? 0.5)
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
      return {
        id,
        size: Number.isFinite(size) ? Math.max(0.05, size) : 0.5,
        position: {
          lon,
          lat,
          height: Number.isFinite(height) ? Math.max(0, height) : 0
        }
      }
    })
    .filter(Boolean)
  if (fragments.length < 1) {
    return { ok: false, message: '存在碎块坐标非法数据' }
  }
  return { ok: true, value: fragments }
}

function normalizeGeoPoint(point, fallback) {
  const lon = Number(point?.lon ?? fallback?.lon)
  const lat = Number(point?.lat ?? fallback?.lat)
  const height = Number(point?.height ?? point?.alt ?? fallback?.height ?? 0)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return {
    lon,
    lat,
    height: Number.isFinite(height) ? height : 0
  }
}

function normalizeFaceShape(shape, fallbackCenter) {
  const raw = shape && typeof shape === 'object' ? shape : {}
  const center = normalizeGeoPoint(raw.center, fallbackCenter) || fallbackCenter
  const width = Number(raw.width ?? 8)
  const height = Number(raw.height ?? 6)
  const thickness = Number(raw.thickness ?? 0.6)
  const headingDeg = Number(raw.headingDeg ?? 0)
  return {
    center,
    width: Number.isFinite(width) ? Math.max(0.5, width) : 8,
    height: Number.isFinite(height) ? Math.max(0.5, height) : 6,
    thickness: Number.isFinite(thickness) ? Math.max(0.1, thickness) : 0.6,
    headingDeg: Number.isFinite(headingDeg) ? headingDeg : 0
  }
}

function normalizeHoles(holes, fallbackCenter) {
  if (!Array.isArray(holes)) return []
  return holes
    .map((hole, index) => {
      const collar = normalizeGeoPoint(hole?.collar, fallbackCenter)
      const toe = normalizeGeoPoint(hole?.toe, collar || fallbackCenter)
      if (!collar || !toe) return null
      const diameter = Number(hole?.diameter ?? 0.09)
      const chargeKg = Number(hole?.chargeKg ?? 0)
      const delayMs = Number(hole?.delayMs ?? 0)
      return {
        id: String(hole?.id ?? `H${String(index + 1).padStart(3, '0')}`),
        row: Number(hole?.row ?? 0),
        column: Number(hole?.column ?? 0),
        collar,
        toe,
        diameter: Number.isFinite(diameter) ? Math.max(0.02, diameter) : 0.09,
        chargeKg: Number.isFinite(chargeKg) ? Math.max(0, chargeKg) : 0,
        delayMs: Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
      }
    })
    .filter(Boolean)
}

function normalizeRockBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks
    .map((block, index) => {
      const size = Number(block?.size ?? block?.diameter ?? 0)
      const weightKg = Number(block?.weightKg ?? 0)
      if (!Number.isFinite(size)) return null
      return {
        id: String(block?.id ?? `RB${String(index + 1).padStart(3, '0')}`),
        size: Math.max(0.05, size),
        weightKg: Number.isFinite(weightKg) ? Math.max(0, weightKg) : 0
      }
    })
    .filter(Boolean)
}

function normalizeDesign(rawDesign, fallbackCenter) {
  const design = rawDesign && typeof rawDesign === 'object' ? rawDesign : {}
  return {
    faceBefore: normalizeFaceShape(design?.faceBefore, fallbackCenter),
    faceAfter: normalizeFaceShape(design?.faceAfter, fallbackCenter),
    holes: normalizeHoles(design?.holes, fallbackCenter),
    rockBlocks: normalizeRockBlocks(design?.rockBlocks)
  }
}

function normalizeVisual(rawVisual) {
  const visual = rawVisual && typeof rawVisual === 'object' ? rawVisual : {}
  const renderMode = String(visual.fragmentRenderMode || 'model')
  const waveRings = Number(visual.waveRings ?? 2)
  const trailWidth = Number(visual.trailWidth ?? 2.5)
  const maxModelFragments = Number(visual.maxModelFragments ?? 48)
  return {
    fragmentRenderMode: renderMode === 'point' ? 'point' : 'model',
    fragmentModelUri: String(visual.fragmentModelUri || DEFAULT_FRAGMENT_MODEL_URI),
    fragmentMinPixelSize: Math.max(8, Number(visual.fragmentMinPixelSize ?? 24)),
    fragmentMaxScale: Math.max(1, Number(visual.fragmentMaxScale ?? 18)),
    waveRings: Number.isFinite(waveRings) ? Math.max(1, Math.min(4, Math.floor(waveRings))) : 2,
    trailWidth: Number.isFinite(trailWidth) ? Math.max(1, Math.min(8, trailWidth)) : 2.5,
    maxModelFragments: Number.isFinite(maxModelFragments)
      ? Math.max(4, Math.min(200, Math.floor(maxModelFragments)))
      : 48
  }
}

function hashString(input) {
  const text = String(input || '')
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function deriveSimulationConfig(raw, normalizedDesign, normalizedEvent) {
  const holes = Array.isArray(normalizedDesign?.holes) ? normalizedDesign.holes : []
  const rockBlocks = Array.isArray(normalizedDesign?.rockBlocks) ? normalizedDesign.rockBlocks : []
  const faceBefore = normalizedDesign?.faceBefore || { width: 8, height: 6 }
  const faceAfter = normalizedDesign?.faceAfter || { width: 8, height: 6 }

  const eventCharge = Number(normalizedEvent?.chargeKg ?? 0)
  const holeCharge = holes.reduce((sum, hole) => sum + Number(hole?.chargeKg || 0), 0)
  const totalCharge = Math.max(0, eventCharge + holeCharge)
  const faceDeltaArea = Math.abs(
    Number(faceAfter.width || 0) * Number(faceAfter.height || 0) -
      Number(faceBefore.width || 0) * Number(faceBefore.height || 0)
  )

  const designWeight =
    holes.length * 2.4 + rockBlocks.length * 3.1 + totalCharge / 22 + faceDeltaArea * 0.45
  const fragmentCount = Math.round(clampNumber(12 + designWeight, 12, 240, 48))
  const frameCount = Math.round(clampNumber(70 + designWeight * 1.6, 60, 420, 120))
  const timeStep = clampNumber(0.12 - designWeight / 2200, 0.04, 0.14, 0.1)
  const gravity = clampNumber(raw?.simulate?.gravity ?? 9.8, 1, 30, 9.8)
  const seedInput = [
    normalizedEvent?.id,
    normalizedEvent?.name,
    ...holes.map(hole => `${hole.id}:${hole.delayMs}:${hole.chargeKg}`),
    ...rockBlocks.map(block => `${block.id}:${block.size}:${block.weightKg}`),
    `${Number(faceBefore.width || 0)}-${Number(faceAfter.width || 0)}`
  ].join('|')
  const seed = Number(raw?.simulate?.seed ?? hashString(seedInput))

  return {
    fragmentCount: Math.round(
      clampNumber(raw?.simulate?.fragmentCount ?? fragmentCount, 1, 500, fragmentCount)
    ),
    frameCount: Math.round(
      clampNumber(raw?.simulate?.frameCount ?? frameCount, 2, 2000, frameCount)
    ),
    timeStep: clampNumber(raw?.simulate?.timeStep ?? timeStep, 0.01, 1, timeStep),
    gravity,
    seed,
    source: 'file-driven'
  }
}

function normalizeFrames(rawFrames) {
  if (!Array.isArray(rawFrames) || rawFrames.length < 2) {
    return { ok: false, message: 'frames 至少需要 2 帧' }
  }
  const frames = []
  for (let i = 0; i < rawFrames.length; i++) {
    const frame = rawFrames[i]
    const fragmentsRes = normalizeFragments(frame?.fragments)
    if (!fragmentsRes.ok) {
      return { ok: false, message: `第 ${i + 1} 帧错误：${fragmentsRes.message}` }
    }
    const t = Number(frame?.t ?? i * 0.1)
    const waveRadius = Number(frame?.waveRadius ?? 8 + i * 1.2)
    frames.push({
      t: Number.isFinite(t) ? t : i * 0.1,
      waveRadius: Number.isFinite(waveRadius) ? Math.max(1, waveRadius) : 8 + i * 1.2,
      fragments: fragmentsRes.value
    })
  }
  return { ok: true, value: frames }
}

function buildSummary(dataset) {
  const frameCount = dataset.frames.length
  const fragmentIds = new Set()
  let maxWaveRadius = 0
  dataset.frames.forEach(frame => {
    maxWaveRadius = Math.max(maxWaveRadius, frame.waveRadius)
    frame.fragments.forEach(fragment => fragmentIds.add(fragment.id))
  })
  return {
    frameCount,
    fragmentCount: fragmentIds.size,
    durationSec: dataset.frames[frameCount - 1].t,
    maxWaveRadius: Number(maxWaveRadius.toFixed(2)),
    holeCount: dataset?.design?.holes?.length || 0,
    rockBlockCount: dataset?.design?.rockBlocks?.length || 0
  }
}

export function buildExampleBlastingDataset() {
  const center = {
    lon: 116.3915,
    lat: 39.9015,
    height: 0
  }
  const frames = generateBlastingFrames({
    center,
    fragmentCount: 20,
    frameCount: 90,
    timeStep: 0.1,
    gravity: 9.8,
    seed: 20260309
  })
  const dataset = {
    meta: {
      coordinateSystem: 'WGS84',
      timeUnit: 's',
      lengthUnit: 'm'
    },
    event: {
      id: 'BLAST-DEMO-001',
      name: '示例爆破事件',
      center,
      chargeKg: 320
    },
    design: {
      faceBefore: {
        center,
        width: 10,
        height: 8,
        thickness: 0.8,
        headingDeg: 15
      },
      faceAfter: {
        center: { lon: center.lon + 0.00002, lat: center.lat + 0.00001, height: 0 },
        width: 10.6,
        height: 8.5,
        thickness: 0.8,
        headingDeg: 15
      },
      holes: Array.from({ length: 6 }, (_, i) => {
        const row = Math.floor(i / 3) + 1
        const column = (i % 3) + 1
        return {
          id: `H${i + 1}`,
          row,
          column,
          diameter: 0.09,
          chargeKg: 45 + i * 3,
          delayMs: i * 25,
          collar: {
            lon: center.lon + (column - 2) * 0.00002,
            lat: center.lat + (row - 1) * 0.000015,
            height: 1.8
          },
          toe: {
            lon: center.lon + (column - 2) * 0.00002 + 0.000005,
            lat: center.lat + (row - 1) * 0.000015 + 0.000006,
            height: 0.2
          }
        }
      }),
      rockBlocks: [
        { id: 'RB1', size: 0.35, weightKg: 60 },
        { id: 'RB2', size: 0.52, weightKg: 125 },
        { id: 'RB3', size: 0.9, weightKg: 360 }
      ]
    },
    visual: normalizeVisual({
      fragmentRenderMode: 'model',
      fragmentModelUri: DEFAULT_FRAGMENT_MODEL_URI,
      waveRings: 2,
      trailWidth: 2.4
    }),
    frames
  }
  return {
    ...dataset,
    summary: buildSummary(dataset)
  }
}

export function normalizeBlastingDataset(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const centerRes = normalizeCenter(raw?.event?.center)
  if (!centerRes.ok) return centerRes
  const normalizedDesign = normalizeDesign(raw?.design, centerRes.value)
  const normalizedEvent = {
    id: String(raw?.event?.id || 'BLAST-UNNAMED'),
    name: String(raw?.event?.name || '未命名爆破事件'),
    center: centerRes.value,
    chargeKg: Number(raw?.event?.chargeKg ?? 0)
  }
  const simulationConfig = deriveSimulationConfig(raw, normalizedDesign, normalizedEvent)

  let framesRes = normalizeFrames(raw.frames)
  if (!framesRes.ok) {
    const generated = generateBlastingFrames({
      center: centerRes.value,
      fragmentCount: simulationConfig.fragmentCount,
      frameCount: simulationConfig.frameCount,
      timeStep: simulationConfig.timeStep,
      gravity: simulationConfig.gravity,
      seed: simulationConfig.seed
    })
    framesRes = normalizeFrames(generated)
    if (!framesRes.ok) return framesRes
  }

  const dataset = {
    meta: {
      coordinateSystem: String(raw?.meta?.coordinateSystem || 'WGS84'),
      timeUnit: String(raw?.meta?.timeUnit || 's'),
      lengthUnit: String(raw?.meta?.lengthUnit || 'm')
    },
    event: normalizedEvent,
    design: normalizedDesign,
    simulation: simulationConfig,
    visual: normalizeVisual(raw?.visual),
    frames: framesRes.value
  }

  return {
    ok: true,
    dataset: {
      ...dataset,
      summary: buildSummary(dataset)
    }
  }
}
