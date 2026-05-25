/**
 * 点插值配置集中管理。
 *
 * 这里统一约束插值参数的默认值、取值范围和派生策略，避免 power / neighborCount /
 * anisotropy / worker 策略分散在多个函数中难以维护。
 */

import {
  clampInt as baseClampInt,
  resolveAnisotropyParams as baseResolveAnisotropyParams
} from './config.js'

export const POINT_INTERPOLATION_CONSTANTS = {
  maxKrigingPoints: 180,
  maxIdwPoints: 500,
  maxSampleCount: 200000,
  maxGrid: { width: 160, height: 160, depth: 96 },
  defaultGridResolution: 72,
  defaultProgressStep: 1,
  defaultWorkerMinOps: 120000,
  defaultMaxMainThreadOps: 4500000,
  defaultPower: 2.0,
  defaultNeighborCountMin: 6,
  defaultNeighborCountMax: 24,
  defaultNeighborPolicy: 'sector',
  defaultSectorCount: 8,
  defaultEpsilon: 1e-4,
  defaultGrid: {
    low: [96, 96, 64],
    medium: [80, 80, 56],
    high: [72, 72, 48]
  },
  optimization: {
    particleCount: 30,
    maxIterations: 100,
    inertiaWeight: 0.729,
    cognitiveWeight: 1.49445,
    socialWeight: 1.49445,
    seed: 1337,
    crossValidationFolds: 5,
    crossValidationMode: 'spatial',
    adaptivePower: true,
    adaptiveNeighborCount: 8,
    maxFitnessSamples: 160,
    objectiveWeights: {
      rmse: 0.55,
      bias: 0.2,
      variance: 0.1,
      smoothness: 0.15
    }
  }
}

function clampInt(v, min, max) {
  return baseClampInt(v, min, max)
}

export function resolveInterpolationMethod(options) {
  return String(options?.method || 'idw')
}

export function resolveInterpolationGrid(size, spec) {
  const sx = Number(size?.[0]) || 200
  const sy = Number(size?.[1]) || 200
  const sz = Number(size?.[2]) || 100
  const { maxGrid, defaultGridResolution } = POINT_INTERPOLATION_CONSTANTS

  const user = spec && typeof spec === 'object' ? spec.grid : null
  if (Array.isArray(user) && user.length >= 3) {
    return {
      width: clampInt(user[0], 1, maxGrid.width),
      height: clampInt(user[1], 1, maxGrid.height),
      depth: clampInt(user[2], 1, maxGrid.depth)
    }
  }

  const base = Math.max(1, Math.min(sx, sy, sz))
  const target = clampInt(spec?.resolution || defaultGridResolution, 16, 120)
  return {
    width: clampInt((sx / base) * target, 16, maxGrid.width),
    height: clampInt((sy / base) * target, 16, maxGrid.height),
    depth: clampInt((sz / base) * Math.max(10, target * 0.6), 10, maxGrid.depth)
  }
}

export function buildGridPositions(size, grid) {
  const sx = Number(size?.[0]) || 200
  const sy = Number(size?.[1]) || 200
  const sz = Number(size?.[2]) || 100
  const w = Math.max(1, grid.width)
  const h = Math.max(1, grid.height)
  const d = Math.max(1, grid.depth)
  const xs = new Float32Array(w)
  const ys = new Float32Array(h)
  const zs = new Float32Array(d)
  for (let i = 0; i < w; i++) {
    const u = w === 1 ? 0.5 : i / (w - 1)
    xs[i] = (u - 0.5) * sx
  }
  for (let j = 0; j < h; j++) {
    const v = h === 1 ? 0.5 : j / (h - 1)
    ys[j] = (v - 0.5) * sy
  }
  for (let k = 0; k < d; k++) {
    const t = d === 1 ? 0.5 : k / (d - 1)
    zs[k] = (t - 0.5) * sz
  }
  return { xs, ys, zs }
}

export function resolveDefaultGrid(frameCount) {
  const { defaultGrid } = POINT_INTERPOLATION_CONSTANTS
  const frames = Math.max(1, Number(frameCount) || 1)
  if (frames > 80) return [...defaultGrid.high]
  if (frames > 40) return [...defaultGrid.medium]
  return [...defaultGrid.low]
}

export function resolveDefaultKrigingFitMode(options, frames) {
  if (typeof options?.fitMode === 'string' && options.fitMode.trim()) {
    return String(options.fitMode)
  }
  return frames > 1 ? 'mean' : 'first'
}

export function resolveAnisotropyParams(options) {
  return baseResolveAnisotropyParams(options)
}

/**
 * power:
 * - IDW 距离衰减指数，常用范围 1.0 ~ 3.0。
 * - 越大越偏向局部点，越小越平滑。
 *
 * neighborCount:
 * - 参与插值的最近邻点数。
 * - 越大越稳定但更平滑，越小越强调局部细节。
 */
export function resolveIdwRuntimeParams(options, pointCount) {
  const requested =
    options?.neighborCount !== undefined
      ? Number(options.neighborCount)
      : Number(options?.neighbors)
  const neighborCount = Number.isFinite(requested)
    ? Math.max(1, Math.min(pointCount, Math.floor(requested)))
    : pointCount <= 6
      ? pointCount
      : Math.max(
          POINT_INTERPOLATION_CONSTANTS.defaultNeighborCountMin,
          Math.min(
            pointCount,
            Math.min(
              POINT_INTERPOLATION_CONSTANTS.defaultNeighborCountMax,
              Math.round(pointCount * 0.12)
            )
          )
        )

  return {
    power: Math.max(0.1, Number(options?.power) || POINT_INTERPOLATION_CONSTANTS.defaultPower),
    neighborCount,
    neighborPolicy:
      String(options?.neighborPolicy || POINT_INTERPOLATION_CONSTANTS.defaultNeighborPolicy) ===
      'nearest'
        ? 'nearest'
        : 'sector',
    sectorCount: clampInt(
      options?.sectorCount || POINT_INTERPOLATION_CONSTANTS.defaultSectorCount,
      1,
      16
    ),
    radius: Number.isFinite(Number(options?.radius))
      ? Number(options.radius)
      : Number.POSITIVE_INFINITY,
    adaptivePower: Boolean(options?.adaptivePower),
    adaptiveNeighborCount: clampInt(options?.adaptiveNeighborCount || 8, 3, 16),
    epsilon: Math.max(
      1e-8,
      Number(options?.epsilon) || POINT_INTERPOLATION_CONSTANTS.defaultEpsilon
    )
  }
}

export function resolveInterpolationPointLimit(method, requestedMaxPoints, pointCount) {
  const cap =
    method === 'kriging'
      ? POINT_INTERPOLATION_CONSTANTS.maxKrigingPoints
      : POINT_INTERPOLATION_CONSTANTS.maxIdwPoints
  return Number.isFinite(Number(requestedMaxPoints))
    ? Math.max(2, Math.min(cap, Math.floor(requestedMaxPoints), pointCount))
    : pointCount
}

export function resolveOptimizationConfig(options) {
  const base = POINT_INTERPOLATION_CONSTANTS.optimization
  return {
    particleCount: Number(options?.optimizationParticles) || base.particleCount,
    maxIterations: Number(options?.optimizationIterations) || base.maxIterations,
    inertiaWeight: base.inertiaWeight,
    cognitiveWeight: base.cognitiveWeight,
    socialWeight: base.socialWeight,
    seed: Number.isFinite(Number(options?.optimizationSeed))
      ? Number(options.optimizationSeed)
      : base.seed,
    crossValidationFolds: Number.isFinite(Number(options?.crossValidationFolds))
      ? Math.max(2, Math.floor(Number(options.crossValidationFolds)))
      : base.crossValidationFolds,
    crossValidationMode:
      String(options?.crossValidationMode || base.crossValidationMode).toLowerCase() === 'random'
        ? 'random'
        : 'spatial',
    adaptivePower:
      options?.adaptivePower !== undefined ? Boolean(options.adaptivePower) : base.adaptivePower,
    adaptiveNeighborCount: clampInt(
      options?.adaptiveNeighborCount || base.adaptiveNeighborCount,
      3,
      16
    ),
    maxFitnessSamples: Number(options?.optimizationMaxFitnessSamples) || base.maxFitnessSamples,
    neighborPolicy:
      String(options?.neighborPolicy || POINT_INTERPOLATION_CONSTANTS.defaultNeighborPolicy) ===
      'nearest'
        ? 'nearest'
        : 'sector',
    sectorCount: clampInt(
      options?.sectorCount || POINT_INTERPOLATION_CONSTANTS.defaultSectorCount,
      1,
      16
    ),
    objectiveWeights: {
      rmse: Number(options?.optimizationRmseWeight) || base.objectiveWeights.rmse,
      bias: Number(options?.optimizationBiasWeight) || base.objectiveWeights.bias,
      variance: Number(options?.optimizationVarianceWeight) || base.objectiveWeights.variance,
      smoothness: Number(options?.optimizationSmoothnessWeight) || base.objectiveWeights.smoothness
    }
  }
}

export function resolveInterpolationWorkerPolicy(pd, options = {}) {
  const preferWorker = options?.preferWorker !== undefined ? Boolean(options.preferWorker) : true
  const allowMainThreadFallback =
    options?.allowMainThreadFallback !== undefined ? Boolean(options.allowMainThreadFallback) : true
  const method = resolveInterpolationMethod(options)
  const isBrowserRuntime =
    typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof URL !== 'undefined'
  const gridSpec = Array.isArray(options?.grid) ? options.grid : null
  const gw = Math.max(1, Number(gridSpec?.[0]) || 0)
  const gh = Math.max(1, Number(gridSpec?.[1]) || 0)
  const gd = Math.max(1, Number(gridSpec?.[2]) || 0)
  const frames = Math.max(1, Number(pd?.time?.frames) || 1)
  const estimatedOps = gw > 0 && gh > 0 && gd > 0 ? gw * gh * gd * frames : 0
  const pointCount = Math.max(1, Math.min(1000, Array.isArray(pd?.points) ? pd.points.length : 1))
  const complexityScale = Math.max(1, Math.min(24, Math.ceil(pointCount / 12)))
  const weightedOps = estimatedOps * complexityScale
  const maxMainThreadOps = Math.max(
    0,
    Number(options?.maxMainThreadOps) || POINT_INTERPOLATION_CONSTANTS.defaultMaxMainThreadOps
  )

  return {
    method,
    preferWorker,
    allowMainThreadFallback,
    weightedOps,
    canFallbackToMainThread:
      allowMainThreadFallback &&
      !isBrowserRuntime &&
      weightedOps > 0 &&
      weightedOps <= maxMainThreadOps,
    shouldUseMainThread: !preferWorker || !isBrowserRuntime
  }
}

export function createInterpolationProgressReporter(options, frames, grid) {
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null
  const progressStep = Math.max(
    1,
    Number(options?.progressStep) || POINT_INTERPOLATION_CONSTANTS.defaultProgressStep
  )
  const totalSlices = Math.max(1, frames * Math.max(1, grid.depth))
  let finishedSlices = 0

  function emit(stage) {
    if (!onProgress) return
    const percent = Math.max(0, Math.min(100, (finishedSlices / totalSlices) * 100))
    onProgress({ percent, stage })
  }

  return {
    onProgress,
    nextSlice(stage) {
      finishedSlices += 1
      if (finishedSlices % progressStep === 0 || finishedSlices === totalSlices) emit(stage)
    }
  }
}

export function createValueTracker(options, pd) {
  const maxSamples = POINT_INTERPOLATION_CONSTANTS.maxSampleCount
  const valueRangePolicy = options?.valueRangePolicy || pd?.render?.valueRange || null
  const samples = []
  let globalIndex = 0
  let nextSampleIndex = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  const totalValuesEstimate = Number(options?.totalValuesEstimate) || 0
  const step = Math.max(1, Math.floor(totalValuesEstimate / maxSamples) || 1)

  return {
    track(v) {
      if (!Number.isFinite(v)) return
      if (v < min) min = v
      if (v > max) max = v
      if (globalIndex === nextSampleIndex && samples.length < maxSamples) {
        samples.push(v)
        nextSampleIndex += step
      }
      globalIndex += 1
    },
    snapshot() {
      return { min, max, samples, valueRangePolicy }
    }
  }
}
