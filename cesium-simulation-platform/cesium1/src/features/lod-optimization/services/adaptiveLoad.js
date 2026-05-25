export function createAdaptiveLoadRuntime() {
  return {
    enabled: true,
    level: 0,
    branch: 'standard',
    lowFpsStreak: 0,
    recoverStreak: 0,
    pressure: 'low',
    lastActionMs: 0,
    lastReason: '',
    lastFps: 0
  }
}

export function getAdaptiveLoadStep(config, level) {
  if (!config || !Array.isArray(config.steps)) return null
  return config.steps[level - 1] || null
}

export function getAdaptivePressure(metrics, config) {
  const pendingRequests = Number(metrics?.pendingRequests) || 0
  const tilesProcessing = Number(metrics?.tilesProcessing) || 0
  const memoryBytes = Number(metrics?.totalMemoryUsageInBytes) || 0
  const pendingThreshold = Number(config?.pendingRequestsThreshold) || 0
  const processingThreshold = Number(config?.tilesProcessingThreshold) || 0
  const memoryThresholdMb = Number(config?.memoryThresholdMb) || 0
  const memoryThresholdBytes = memoryThresholdMb > 0 ? memoryThresholdMb * 1024 * 1024 : 0

  if (
    (pendingThreshold > 0 && pendingRequests >= pendingThreshold) ||
    (processingThreshold > 0 && tilesProcessing >= processingThreshold) ||
    (memoryThresholdBytes > 0 && memoryBytes >= memoryThresholdBytes)
  ) {
    return 'high'
  }

  if (
    (pendingThreshold > 0 && pendingRequests >= Math.max(1, Math.floor(pendingThreshold * 0.5))) ||
    (processingThreshold > 0 &&
      tilesProcessing >= Math.max(1, Math.floor(processingThreshold * 0.5))) ||
    (memoryThresholdBytes > 0 && memoryBytes >= memoryThresholdBytes * 0.75)
  ) {
    return 'medium'
  }

  return 'low'
}

export function evaluateAdaptiveLoad(metrics, runtime, config, now = Date.now()) {
  const fps = Number(metrics?.fps) || 0
  const currentRuntime = runtime || createAdaptiveLoadRuntime()
  const stepsCount = Array.isArray(config?.steps) ? config.steps.length : 0
  const pressure = getAdaptivePressure(metrics, config)
  const nextRuntimePatch = {
    pressure,
    lastFps: fps
  }

  if (!currentRuntime.enabled || !config?.enabled || fps <= 0) {
    return { action: 'none', nextLevel: currentRuntime.level || 0, nextRuntimePatch }
  }

  const lowFpsThreshold = Number(config?.lowFpsThreshold) || 25
  const pressureFpsThreshold = Number(config?.pressureFpsThreshold) || lowFpsThreshold
  const recoverFpsThreshold = Number(config?.recoverFpsThreshold) || 45
  const degradeAfterSamples = Math.max(1, Number(config?.degradeAfterSamples) || 3)
  const recoverAfterSamples = Math.max(1, Number(config?.recoverAfterSamples) || 5)
  const cooldownMs = Math.max(0, Number(config?.cooldownMs) || 0)
  const lowFps = fps < lowFpsThreshold || (pressure === 'high' && fps < pressureFpsThreshold)
  const recoverable = fps >= recoverFpsThreshold && pressure !== 'high'
  const lowFpsStreak = lowFps ? Number(currentRuntime.lowFpsStreak || 0) + 1 : 0
  const recoverStreak = recoverable ? Number(currentRuntime.recoverStreak || 0) + 1 : 0

  Object.assign(nextRuntimePatch, {
    lowFpsStreak,
    recoverStreak
  })

  if (now - Number(currentRuntime.lastActionMs || 0) < cooldownMs) {
    return { action: 'none', nextLevel: currentRuntime.level || 0, nextRuntimePatch }
  }

  if (lowFpsStreak >= degradeAfterSamples && (currentRuntime.level || 0) < stepsCount) {
    return {
      action: 'degrade',
      nextLevel: (currentRuntime.level || 0) + 1,
      nextRuntimePatch: {
        ...nextRuntimePatch,
        lowFpsStreak: 0,
        recoverStreak: 0,
        lastActionMs: now
      }
    }
  }

  if (recoverStreak >= recoverAfterSamples && (currentRuntime.level || 0) > 0) {
    return {
      action: 'recover',
      nextLevel: (currentRuntime.level || 0) - 1,
      nextRuntimePatch: {
        ...nextRuntimePatch,
        lowFpsStreak: 0,
        recoverStreak: 0,
        lastActionMs: now
      }
    }
  }

  return { action: 'none', nextLevel: currentRuntime.level || 0, nextRuntimePatch }
}
