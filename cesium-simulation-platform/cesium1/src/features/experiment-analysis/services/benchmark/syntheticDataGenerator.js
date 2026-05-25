function createSeededRng(seed) {
  let s = (Number(seed) || 0) >>> 0
  return function rng() {
    s = (1664525 * s + 1013904223) >>> 0
    return s / 4294967296
  }
}

function gaussianKernel(x, y, z, cx, cy, cz, sx, sy, sz, amplitude) {
  const dx = (x - cx) / Math.max(1e-6, sx)
  const dy = (y - cy) / Math.max(1e-6, sy)
  const dz = (z - cz) / Math.max(1e-6, sz)
  return amplitude * Math.exp(-0.5 * (dx * dx + dy * dy + dz * dz))
}

function linearGradient(x, y, z, size, gradientVec) {
  return (
    (x / Math.max(1e-6, size[0])) * gradientVec[0] +
    (y / Math.max(1e-6, size[1])) * gradientVec[1] +
    (z / Math.max(1e-6, size[2])) * gradientVec[2]
  )
}

export function generateGaussianMixtureField({
  size = [200, 200, 100],
  peakCount = 5,
  seed = 2026,
  baseAmplitude = 50,
  minAmplitude = 8,
  peakSigmaRange = [15, 60]
} = {}) {
  const rng = createSeededRng(seed)
  const peaks = []

  for (let i = 0; i < peakCount; i++) {
    peaks.push({
      cx: rng() * size[0],
      cy: rng() * size[1],
      cz: rng() * size[2],
      sx: peakSigmaRange[0] + rng() * (peakSigmaRange[1] - peakSigmaRange[0]),
      sy: peakSigmaRange[0] + rng() * (peakSigmaRange[1] - peakSigmaRange[0]),
      sz: peakSigmaRange[0] * 0.5 + rng() * (peakSigmaRange[1] - peakSigmaRange[0]) * 0.5,
      amplitude: minAmplitude + rng() * (baseAmplitude - minAmplitude)
    })
  }

  return function sampleField(x, y, z) {
    let value = 0
    for (const peak of peaks) {
      value += gaussianKernel(
        x,
        y,
        z,
        peak.cx,
        peak.cy,
        peak.cz,
        peak.sx,
        peak.sy,
        peak.sz,
        peak.amplitude
      )
    }
    return value
  }
}

export function generateGradientPeakField({
  size = [200, 200, 100],
  seed = 2026,
  gradientVec = [30, 15, -10],
  peakCount = 4,
  peakAmplitude = 40
} = {}) {
  const rng = createSeededRng(seed)
  const peaks = []

  for (let i = 0; i < peakCount; i++) {
    peaks.push({
      cx: 0.2 * size[0] + rng() * 0.6 * size[0],
      cy: 0.2 * size[1] + rng() * 0.6 * size[1],
      cz: 0.1 * size[2] + rng() * 0.5 * size[2],
      sx: 25 + rng() * 40,
      sy: 25 + rng() * 40,
      sz: 12 + rng() * 25,
      amplitude: peakAmplitude * (0.5 + rng() * 0.5)
    })
  }

  return function sampleField(x, y, z) {
    let value = linearGradient(x, y, z, size, gradientVec)
    for (const peak of peaks) {
      value += gaussianKernel(
        x,
        y,
        z,
        peak.cx,
        peak.cy,
        peak.cz,
        peak.sx,
        peak.sy,
        peak.sz,
        peak.amplitude
      )
    }
    return Math.max(0, value)
  }
}

export function generateTestDataset(config = {}) {
  const {
    fieldSize = [200, 200, 100],
    pointCount = 150,
    testRatio = 0.3,
    seed = 2026,
    noiseLevel = 0.05,
    anomalyCount = 8,
    anomalyMagnitude = 3.0,
    trendType = 'gaussian_mixture'
  } = config

  const rng = createSeededRng(seed)

  const fieldFn =
    trendType === 'gradient_peak'
      ? generateGradientPeakField({ size: fieldSize, seed })
      : generateGaussianMixtureField({ size: fieldSize, seed })

  const totalPoints = pointCount + anomalyCount
  const positions = []
  const trueValues = []

  for (let i = 0; i < totalPoints; i++) {
    let x, y, z
    if (i < pointCount) {
      // 拉丁超立方启发式分布
      x = ((i * 1.618033988749895) % 1) * fieldSize[0]
      y = ((i * 2.718281828459045) % 1) * fieldSize[1]
      z = rng() * fieldSize[2]
    } else {
      x = rng() * fieldSize[0]
      y = rng() * fieldSize[1]
      z = rng() * fieldSize[2]
    }

    positions.push({ x, y, z })
    trueValues.push(Math.max(0, fieldFn(x, y, z)))
  }

  const globalMax = Math.max(...trueValues, 1)
  const noisyValues = trueValues.map((v, i) => {
    if (i < pointCount) {
      const noise = (rng() - 0.5) * 2 * noiseLevel * globalMax
      return Math.max(0, v + noise)
    }
    return Math.max(0, v * anomalyMagnitude * (0.7 + rng() * 0.6))
  })

  const allIndices = Array.from({ length: totalPoints }, (_, i) => i)
  for (let i = allIndices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[allIndices[i], allIndices[j]] = [allIndices[j], allIndices[i]]
  }

  const testCount = Math.max(1, Math.floor(totalPoints * testRatio))
  const testIndices = new Set(allIndices.slice(0, testCount))

  const trainPoints = []
  const trainValues = []
  const testPoints = []
  const testValues = []
  const testTrueValues = []

  for (let i = 0; i < totalPoints; i++) {
    if (testIndices.has(i)) {
      testPoints.push(positions[i])
      testValues.push(noisyValues[i])
      testTrueValues.push(trueValues[i])
    } else {
      trainPoints.push(positions[i])
      trainValues.push(noisyValues[i])
    }
  }

  return {
    fieldSize,
    fieldFn,
    trainPoints,
    trainValues,
    testPoints,
    testValues,
    testTrueValues,
    globalMax,
    config: {
      pointCount,
      testRatio,
      seed,
      noiseLevel,
      anomalyCount,
      anomalyMagnitude,
      trendType
    }
  }
}

export function generateGridGroundTruth(fieldFn, size, gridResolution) {
  const gridSize = Math.max(16, Math.min(160, gridResolution || 48))
  const aspectX = size[0] / Math.min(size[0], size[1], size[2])
  const aspectY = size[1] / Math.min(size[0], size[1], size[2])
  const aspectZ = size[2] / Math.min(size[0], size[1], size[2])

  const nx = Math.max(8, Math.round(gridSize * aspectX * 0.8))
  const ny = Math.max(8, Math.round(gridSize * aspectY * 0.8))
  const nz = Math.max(6, Math.round(gridSize * aspectZ * 0.5))

  const grid = { width: nx, height: ny, depth: nz }
  const values = new Float32Array(nx * ny * nz)

  const xs = new Float32Array(nx)
  const ys = new Float32Array(ny)
  const zs = new Float32Array(nz)

  for (let i = 0; i < nx; i++) xs[i] = (size[0] * i) / Math.max(1, nx - 1)
  for (let i = 0; i < ny; i++) ys[i] = (size[1] * i) / Math.max(1, ny - 1)
  for (let i = 0; i < nz; i++) zs[i] = (size[2] * i) / Math.max(1, nz - 1)

  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        values[idx++] = fieldFn(xs[i], ys[j], zs[k])
      }
    }
  }

  return { grid, values, xs, ys, zs }
}
