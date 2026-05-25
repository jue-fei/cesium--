function createSeededRandom(seed = 20260309) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function metersToLonLatDelta(dx, dy, lat) {
  const latRad = (Number(lat || 0) * Math.PI) / 180
  const metersPerDegreeLat = 110540
  const metersPerDegreeLon = Math.max(1, 111320 * Math.cos(latRad))
  return {
    dLon: dx / metersPerDegreeLon,
    dLat: dy / metersPerDegreeLat
  }
}

function clampHeight(v) {
  return Math.max(0, Number.isFinite(v) ? v : 0)
}

export function generateBlastingFrames({
  center,
  fragmentCount = 18,
  frameCount = 80,
  timeStep = 0.1,
  gravity = 9.8,
  seed = 20260309
}) {
  const random = createSeededRandom(seed)
  const safeFrameCount = Math.max(2, Math.floor(frameCount))
  const safeCount = Math.max(1, Math.floor(fragmentCount))
  const cLon = Number(center?.lon ?? 116.3915)
  const cLat = Number(center?.lat ?? 39.9015)
  const cHeight = Number(center?.height ?? 0)
  const tracks = Array.from({ length: safeCount }, (_, index) => {
    const baseAngle = (Math.PI * 2 * index) / safeCount
    const jitterAngle = (random() - 0.5) * 0.6
    const azimuth = baseAngle + jitterAngle
    const speed = 18 + random() * 30
    const vHorizontal = speed * (0.65 + random() * 0.2)
    const vVertical = speed * (0.45 + random() * 0.5)
    const size = 0.2 + random() * 1.5
    const drag = 0.02 + random() * 0.06
    return {
      id: `F${String(index + 1).padStart(3, '0')}`,
      azimuth,
      vHorizontal,
      vVertical,
      size,
      drag,
      landedFrame: safeFrameCount - 1
    }
  })

  const frames = []
  for (let fi = 0; fi < safeFrameCount; fi++) {
    const t = fi * timeStep
    const fragments = tracks.map(track => {
      const effectiveT = Math.min(t, track.landedFrame * timeStep)
      const dragFactor = Math.exp(-track.drag * effectiveT)
      const horizontalDistance = track.vHorizontal * effectiveT * dragFactor
      const dx = Math.cos(track.azimuth) * horizontalDistance
      const dy = Math.sin(track.azimuth) * horizontalDistance
      const z = track.vVertical * effectiveT - 0.5 * gravity * effectiveT * effectiveT
      const { dLon, dLat } = metersToLonLatDelta(dx, dy, cLat)
      const height = clampHeight(cHeight + z)
      if (height <= cHeight + 1e-3 && fi > 0 && fi < track.landedFrame) {
        track.landedFrame = fi
      }
      return {
        id: track.id,
        size: Number(track.size.toFixed(3)),
        position: {
          lon: cLon + dLon,
          lat: cLat + dLat,
          height
        }
      }
    })
    const maxDistance = fragments.reduce((max, fragment) => {
      const dLonMeter = (fragment.position.lon - cLon) * 111320 * Math.cos((cLat * Math.PI) / 180)
      const dLatMeter = (fragment.position.lat - cLat) * 110540
      return Math.max(max, Math.sqrt(dLonMeter * dLonMeter + dLatMeter * dLatMeter))
    }, 0)
    frames.push({
      t: Number(t.toFixed(3)),
      waveRadius: Number((4 + maxDistance * 0.65).toFixed(2)),
      fragments
    })
  }

  return frames
}
