import { toRaw } from 'vue'
import { resolveInterpolationWorkerPolicy } from './pointInterpolationConfig.js'
import { warn } from '@/utils/errorHandler.js'

let interpolationWorker = null
let interpolationWorkerRequestId = 0
const interpolationWorkerPending = new Map()

function resetInterpolationWorker() {
  if (interpolationWorker) {
    try {
      interpolationWorker.terminate()
    } catch (e) {
      warn('stress', 'workerRuntime', e)
    }
  }
  interpolationWorker = null
}

function resolveAndClearPendingInterpolationJobs(value) {
  if (interpolationWorkerPending.size < 1) return
  const pending = Array.from(interpolationWorkerPending.values())
  interpolationWorkerPending.clear()
  pending.forEach(job => {
    if (!job || typeof job.resolve !== 'function') return
    job.resolve(value)
  })
}

function resolveAndClearPendingInterpolationJobsByFallback() {
  if (interpolationWorkerPending.size < 1) return
  const pending = Array.from(interpolationWorkerPending.values())
  interpolationWorkerPending.clear()
  pending.forEach(job => {
    if (!job || typeof job.resolve !== 'function') return
    if (typeof job.fallbackOrNull === 'function') {
      job.resolve(job.fallbackOrNull())
      return
    }
    job.resolve(null)
  })
}

function sanitizeInterpolationWorkerOptions(options) {
  if (!options || typeof options !== 'object') return {}
  const normalized = { ...options }
  if (Array.isArray(options.grid)) {
    normalized.grid = options.grid.slice(0, 3).map(v => Number(v) || 1)
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'onProgress')) {
    delete normalized.onProgress
  }
  return normalized
}

function ensureInterpolationWorker() {
  if (interpolationWorker) return interpolationWorker
  interpolationWorker = new Worker(new URL('./pointDataInterpolation.worker.js', import.meta.url), {
    type: 'module'
  })
  interpolationWorker.onmessage = evt => {
    const payload = evt?.data || {}
    const requestId = payload?.requestId
    if (!interpolationWorkerPending.has(requestId)) return
    const job = interpolationWorkerPending.get(requestId)
    if (payload?.type === 'progress') {
      if (typeof job?.onProgress === 'function') {
        job.onProgress({
          percent: Number(payload.percent) || 0,
          stage: payload.stage || '',
          text: payload.text || ''
        })
      }
      return
    }
    interpolationWorkerPending.delete(requestId)
    if (payload.ok) {
      job.resolve(payload.result || null)
    } else {
      if (typeof job.fallbackOrNull === 'function') {
        job.resolve(job.fallbackOrNull())
      } else {
        job.resolve(null)
      }
    }
  }
  interpolationWorker.onerror = () => {
    resolveAndClearPendingInterpolationJobsByFallback()
    resetInterpolationWorker()
  }
  return interpolationWorker
}

export function buildInterpolatedScalarFieldAsync(
  buildSyncField,
  pd,
  metricKey,
  direction,
  overlayItems,
  options = {}
) {
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null
  const workerPolicy = resolveInterpolationWorkerPolicy(pd, options)

  if (workerPolicy.shouldUseMainThread) {
    return Promise.resolve(buildSyncField(pd, metricKey, direction, overlayItems, options))
  }

  return new Promise(resolve => {
    const fallbackOrNull = () =>
      workerPolicy.canFallbackToMainThread
        ? buildSyncField(pd, metricKey, direction, overlayItems, options)
        : null

    let worker = null
    try {
      const cancelPreviousTask = options?.cancelPreviousTask !== false
      if (cancelPreviousTask && interpolationWorkerPending.size > 0) {
        resolveAndClearPendingInterpolationJobs(null)
        resetInterpolationWorker()
      }
      worker = ensureInterpolationWorker()
      const requestId = ++interpolationWorkerRequestId
      interpolationWorkerPending.set(requestId, { resolve, fallbackOrNull, onProgress })
      worker.postMessage({
        requestId,
        pd: toRaw(pd),
        metricKey,
        direction: toRaw(direction || {}),
        overlayItems: toRaw(overlayItems || []),
        options: sanitizeInterpolationWorkerOptions(toRaw(options || {}))
      })
    } catch (e) {
      console.error('Worker postMessage error:', e)
      if (worker) {
        resolveAndClearPendingInterpolationJobs(fallbackOrNull())
        resetInterpolationWorker()
      }
      resolve(fallbackOrNull())
    }
  })
}
