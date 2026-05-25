import {
  renderHeatmapToCanvas,
  renderDifferenceHeatmap,
  heatmapToDataURL
} from './heatmapCanvasRenderer.js'
import { computeHeatmapGlobalRange } from './experimentVisualizationCore.js'

function idw2dGrid(dataset, gridResolution, power, neighborCount) {
  const { fieldSize, trainPoints, trainValues } = dataset
  const gridSize = Math.max(16, Math.min(80, gridResolution || 36))
  const aspectX = fieldSize[0] / Math.min(fieldSize[0], fieldSize[1], 1)
  const aspectY = fieldSize[1] / Math.min(fieldSize[0], fieldSize[1], 1)
  const nx = Math.max(12, Math.round(gridSize * aspectX))
  const ny = Math.max(12, Math.round(gridSize * aspectY))
  const zMid = fieldSize[2] / 2

  const values = new Float32Array(nx * ny)
  const eps = 1e-8

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (fieldSize[0] * i) / Math.max(1, nx - 1)
      const y = (fieldSize[1] * j) / Math.max(1, ny - 1)

      const distances = trainPoints.map((p, idx) => ({
        index: idx,
        d2: (x - p.x) ** 2 + (y - p.y) ** 2 + (zMid - p.z) ** 2
      }))
      distances.sort((a, b) => a.d2 - b.d2)
      const used = distances.slice(0, Math.min(neighborCount, distances.length))

      if (used.length > 0 && used[0].d2 <= eps * eps) {
        values[j * nx + i] = trainValues[used[0].index]
        continue
      }

      let weightSum = 0
      let valueSum = 0
      for (const item of used) {
        const w = 1 / Math.pow(Math.sqrt(item.d2) + eps, power)
        weightSum += w
        valueSum += w * trainValues[item.index]
      }
      values[j * nx + i] = weightSum > 0 ? valueSum / weightSum : 0
    }
  }

  return {
    grid: { width: nx, height: ny, depth: 1 },
    values
  }
}

function kriging2dGrid(dataset, gridResolution, modelName) {
  const { fieldSize, trainPoints, trainValues } = dataset
  const gridSize = Math.max(16, Math.min(80, gridResolution || 36))
  const aspectX = fieldSize[0] / Math.min(fieldSize[0], fieldSize[1], 1)
  const aspectY = fieldSize[1] / Math.min(fieldSize[0], fieldSize[1], 1)
  const nx = Math.max(12, Math.round(gridSize * aspectX))
  const ny = Math.max(12, Math.round(gridSize * aspectY))
  const zMid = fieldSize[2] / 2

  const n = trainPoints.length
  if (n < 3) return { grid: { width: nx, height: ny, depth: 1 }, values: new Float32Array(nx * ny) }

  const xs = trainPoints.map(p => p.x)
  const ys = trainPoints.map(p => p.y)
  const zs = trainPoints.map(p => p.z)

  let sum = 0,
    sumSq = 0
  for (let i = 0; i < n; i++) {
    sum += trainValues[i]
    sumSq += trainValues[i] ** 2
  }
  const mean = sum / n
  const variance = Math.max(1e-9, sumSq / n - mean * mean)

  const pairs = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const dx = xs[i] - xs[j],
        dy = ys[i] - ys[j],
        dz = zs[i] - zs[j]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      pairs.push([d, 0.5 * (trainValues[i] - trainValues[j]) ** 2])
    }
  }
  pairs.sort((a, b) => a[0] - b[0])
  const maxDist = pairs[pairs.length - 1]?.[0] || 1

  let modelFn
  if (modelName === 'gaussian') {
    modelFn = (h, nug, range, sill) =>
      h <= 0 ? 0 : nug + (sill - nug) * (1 - Math.exp(-3 * (h / Math.max(1e-9, range)) ** 2))
  } else if (modelName === 'spherical') {
    modelFn = (h, nug, range, sill) =>
      h <= 0
        ? 0
        : h >= range
          ? sill
          : nug + (sill - nug) * ((1.5 * h) / range - 0.5 * (h / range) ** 3)
  } else {
    modelFn = (h, nug, range, sill) =>
      h <= 0 ? 0 : nug + (sill - nug) * (1 - Math.exp((-3 * h) / Math.max(1e-9, range)))
  }

  const binCount = Math.max(6, Math.min(20, Math.round(Math.sqrt(pairs.length))))
  const binWidth = maxDist / binCount
  const bins = Array.from({ length: binCount }, () => ({ sumD: 0, sumG: 0, cnt: 0 }))
  for (const [d, g] of pairs) {
    if (d <= 0) continue
    const idx = Math.min(binCount - 1, Math.floor(d / binWidth))
    bins[idx].sumD += d
    bins[idx].sumG += g
    bins[idx].cnt++
  }
  const empirical = bins
    .filter(b => b.cnt > 0)
    .map(b => ({ distance: b.sumD / b.cnt, gamma: b.sumG / b.cnt, count: b.cnt }))
  const maxGamma = empirical.reduce((max, r) => Math.max(max, r.gamma), 0)
  const sillBase = Math.max(variance, maxGamma, 1e-9)

  let best = { nugget: 0, range: maxDist, sill: sillBase, error: Infinity }
  const ranges = [0.15, 0.3, 0.5, 0.7, 1.0].map(s => maxDist * s)
  const sills = [0.85, 1.0, 1.2, 1.4].map(s => sillBase * s)
  const nuggets = [0, sillBase * 0.1, sillBase * 0.2, sillBase * 0.3]
  for (const sill of sills) {
    for (const nugget of nuggets) {
      if (nugget >= sill) continue
      for (const range of ranges) {
        let err = 0,
          wSum = 0
        for (const row of empirical) {
          const pred = modelFn(row.distance, nugget, range, sill)
          err += (row.gamma - pred) ** 2 * (row.count / Math.max(0.01, row.distance / range))
          wSum += row.count / Math.max(0.01, row.distance / range)
        }
        err = wSum > 0 ? err / wSum : Infinity
        if (err < best.error) best = { nugget, range, sill, error: err }
      }
    }
  }

  const m = n + 1
  const A = new Array(m * m).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = xs[i] - xs[j],
        dy = ys[i] - ys[j],
        dz = zs[i] - zs[j]
      const h = Math.sqrt(dx * dx + dy * dy + dz * dz)
      A[i * m + j] = best.sill - modelFn(h, best.nugget, best.range, best.sill)
    }
    A[i * m + n] = 1
    A[n * m + i] = 1
  }
  A[n * m + n] = 0
  for (let i = 0; i < n; i++) A[i * m + i] += 1e-10

  const eps2 = 1e-12
  const ipiv = new Array(m).fill(0)
  const B = new Array(m * m).fill(0)
  for (let i = 0; i < m; i++) B[i * m + i] = 1

  for (let i = 0; i < m; i++) {
    let big = 0,
      irow = -1,
      icol = -1
    for (let j = 0; j < m; j++) {
      if (ipiv[j] !== 1) {
        for (let k = 0; k < m; k++) {
          if (ipiv[k] === 0) {
            const v = Math.abs(A[j * m + k])
            if (v >= big) {
              big = v
              irow = j
              icol = k
            }
          }
        }
      }
    }
    if (big <= eps2) break
    ipiv[icol]++
    if (irow !== icol) {
      for (let l = 0; l < m; l++) {
        ;[A[irow * m + l], A[icol * m + l]] = [A[icol * m + l], A[irow * m + l]]
        ;[B[irow * m + l], B[icol * m + l]] = [B[icol * m + l], B[irow * m + l]]
      }
    }
    const pivot = A[icol * m + icol]
    if (Math.abs(pivot) <= eps2) break
    const pivinv = 1 / pivot
    for (let l = 0; l < m; l++) {
      A[icol * m + l] *= pivinv
      B[icol * m + l] *= pivinv
    }
    for (let ll = 0; ll < m; ll++) {
      if (ll === icol) continue
      const dum = A[ll * m + icol]
      for (let l = 0; l < m; l++) {
        A[ll * m + l] -= A[icol * m + l] * dum
        B[ll * m + l] -= B[icol * m + l] * dum
      }
    }
  }

  const values = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (fieldSize[0] * i) / Math.max(1, nx - 1)
      const y = (fieldSize[1] * j) / Math.max(1, ny - 1)

      let pred = 0
      for (let p = 0; p < n; p++) {
        const dx = x - xs[p],
          dy = y - ys[p],
          dz = zMid - zs[p]
        const h = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const cov = best.sill - modelFn(h, best.nugget, best.range, best.sill)
        let wi = 0
        for (let q = 0; q < n; q++) wi += B[p * m + q] * cov
        wi += B[p * m + n]
        pred += wi * trainValues[p]
      }
      values[j * nx + i] = Number.isFinite(pred) ? pred : 0
    }
  }

  return {
    grid: { width: nx, height: ny, depth: 1 },
    values,
    variogram: { nugget: best.nugget, range: best.range, sill: best.sill }
  }
}

export function generateHeatmapSnapshots(dataset, idwParams, krigingModels, gridRes = 36) {
  const snapshots = []

  const power = Number.isFinite(idwParams?.power) ? idwParams.power : 1.6
  const nc = Number.isFinite(idwParams?.neighborCount)
    ? Math.max(1, idwParams.neighborCount)
    : Math.min(24, Math.round(dataset.trainPoints.length * 0.12))

  const idwGrid = idw2dGrid(dataset, gridRes, power, nc)
  const idwLabel = idwParams?.optimized
    ? `IDW-PSO (p=${power.toFixed(1)}, k=${nc})`
    : `IDW (p=${power.toFixed(1)}, k=${nc})`

  snapshots.push({
    methodKey: 'idw',
    label: idwLabel,
    gridData: idwGrid,
    params: { power, neighborCount: nc }
  })

  for (const modelName of krigingModels || ['exponential']) {
    const modelLabel =
      modelName === 'exponential'
        ? '指数模型'
        : modelName === 'gaussian'
          ? '高斯模型'
          : modelName === 'spherical'
            ? '球状模型'
            : modelName

    const krGrid = kriging2dGrid(dataset, gridRes, modelName)
    snapshots.push({
      methodKey: `kriging_${modelName}`,
      label: `Kriging（${modelLabel}）`,
      gridData: krGrid,
      variogram: krGrid.variogram
    })
  }

  return snapshots
}

export function renderSnapshotImages(snapshots, globalMin, globalMax, fieldSize) {
  const results = []

  for (const snap of snapshots) {
    const sizeLabel = `${fieldSize[0].toFixed(0)}×${fieldSize[1].toFixed(0)}×${fieldSize[2].toFixed(0)}m`
    const canvas = renderHeatmapToCanvas(snap.gridData, {
      width: 280,
      height: 220,
      vmin: globalMin,
      vmax: globalMax,
      colormap: null,
      title: snap.label,
      subtitle: `Z = ${(fieldSize[2] / 2).toFixed(0)}m   |   ${sizeLabel}   |   网格 ${snap.gridData.grid.width}×${snap.gridData.grid.height}`,
      bgColor: '#14181e'
    })

    results.push({
      ...snap,
      dataURL: heatmapToDataURL(canvas),
      vmin: globalMin,
      vmax: globalMax
    })
  }

  return results
}

export function computeGlobalRange(snapshots) {
  return computeHeatmapGlobalRange(snapshots)
}

export function renderDifferenceImage(snapA, snapB, globalRange, fieldSize) {
  if (!snapA?.gridData || !snapB?.gridData) return null

  const diffCanvas = renderDifferenceHeatmap(snapA.gridData, snapB.gridData, {
    width: 280,
    height: 220,
    title: 'IDW − Kriging（差值）',
    subtitle: `正值→IDW偏高  |  负值→IDW偏低  |   ${fieldSize[0].toFixed(0)}×${fieldSize[1].toFixed(0)}m`,
    bgColor: '#14181e'
  })

  return {
    dataURL: heatmapToDataURL(diffCanvas),
    label: `${snapA.label} − ${snapB.label}`
  }
}
