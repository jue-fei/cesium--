import { buildInterpolatedScalarFieldFromPointDataset } from '../data/pointCore.js'

self.onmessage = event => {
  const payload = event?.data || {}
  try {
    const options = {
      ...(payload.options || {}),
      onProgress: prog => {
        const percent = Number(prog?.percent)
        self.postMessage({
          type: 'progress',
          requestId: payload.requestId,
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
          stage: prog?.stage || ''
        })
      }
    }
    const result = buildInterpolatedScalarFieldFromPointDataset(
      payload.pd,
      payload.metricKey,
      payload.direction,
      payload.overlayItems,
      options
    )
    const transferables = []
    if (result && Array.isArray(result.frames)) {
      for (const frame of result.frames) {
        if (frame && frame.values && frame.values.buffer) {
          transferables.push(frame.values.buffer)
        }
      }
    }
    self.postMessage({ ok: true, result, requestId: payload.requestId }, transferables)
  } catch (e) {
    self.postMessage({
      ok: false,
      requestId: payload.requestId,
      error: {
        message: String(e?.message || 'worker_interpolation_failed'),
        name: String(e?.name || 'Error')
      }
    })
  }
}
