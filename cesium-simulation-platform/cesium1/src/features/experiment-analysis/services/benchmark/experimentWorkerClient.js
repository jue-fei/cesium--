/**
 * Web Worker 客户端封装
 *
 * 职责：
 * 1. 创建并管理 Web Worker 生命周期
 * 2. 转发 progress / complete / error 事件
 * 3. 提供 cancel() 取消正在运行的实验
 * 4. 内建超时保护（默认 30 秒）
 * 5. Worker 异常的自动恢复（重建 Worker）
 */
import {
  renderHeatmapToCanvas,
  renderDifferenceHeatmap,
  heatmapToDataURL
} from './heatmapCanvasRenderer.js'

const DEFAULT_TIMEOUT_MS = 60000
const MAX_RETRIES = 2

let nextRunId = 1

export function createExperimentWorkerClient(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  let worker = null
  let currentRunId = null
  let timeoutTimer = null
  let retryCount = 0

  const callbacks = {
    onProgress: options.onProgress || (() => {}),
    onComplete: options.onComplete || (() => {}),
    onError: options.onError || (() => {}),
    onCancelled: options.onCancelled || (() => {}),
    onTimeout: options.onTimeout || (() => {})
  }

  function createWorker() {
    try {
      const w = new Worker(new URL('./experimentWorker.js', import.meta.url), { type: 'module' })

      w.addEventListener('message', handleWorkerMessage)
      w.addEventListener('error', handleWorkerError)

      return w
    } catch (err) {
      console.error('[ExperimentWorkerClient] 无法创建 Worker:', err)
      return null
    }
  }

  function ensureWorker() {
    if (!worker) {
      worker = createWorker()
    }
    return worker
  }

  function handleWorkerMessage(e) {
    const msg = e.data
    if (msg.runId !== currentRunId) return

    if (msg.type === 'progress') {
      clearTimeoutTimer()
      startTimeoutTimer()
      callbacks.onProgress(msg)
    } else if (msg.type === 'complete') {
      clearTimeoutTimer()
      retryCount = 0
      callbacks.onComplete(msg.result)
      if (runResolve) {
        runResolve(msg.result)
        runResolve = null
        runReject = null
      }
      finishWorkerMessage()
    } else if (msg.type === 'error') {
      clearTimeoutTimer()
      const err = new Error(msg.message)
      callbacks.onError(err)
      if (runReject) {
        runReject(err)
        runResolve = null
        runReject = null
      }
      finishWorkerMessage()
    } else if (msg.type === 'cancelled') {
      clearTimeoutTimer()
      callbacks.onCancelled()
      if (runResolve) {
        runResolve(null)
        runResolve = null
        runReject = null
      }
      finishWorkerMessage()
    }
  }

  function handleWorkerError(err) {
    if (currentRunId) {
      handleRunError(new Error('Worker意外终止'))
    }
    destroyWorker()
  }

  function handleRunError(err) {
    if (err.message === 'CANCELLED' || err.message === 'TIMEOUT') {
      return
    }

    if (retryCount < MAX_RETRIES) {
      retryCount++
      destroyWorker()
      const w = createWorker()
      if (w) {
        worker = w
        const runId = currentRunId
        w.postMessage({ type: 'run', config: lastConfig, runId })
      } else {
        finishWorkerMessage()
        callbacks.onError(err)
      }
    } else {
      finishWorkerMessage()
      callbacks.onError(err)
    }
  }

  function startTimeoutTimer() {
    clearTimeoutTimer()
    timeoutTimer = setTimeout(() => {
      cancel()
      const timeoutErr = new Error('TIMEOUT')
      callbacks.onTimeout()
      if (runReject) {
        runReject(timeoutErr)
        runResolve = null
        runReject = null
      }
      finishWorkerMessage()
    }, timeoutMs)
  }

  function clearTimeoutTimer() {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
  }

  function finishWorkerMessage() {
    currentRunId = null
    runResolve = null
    runReject = null
    clearTimeoutTimer()
  }

  let lastConfig = null
  let runResolve = null
  let runReject = null

  function run(config) {
    const w = ensureWorker()
    if (!w) {
      const err = new Error('无法创建Web Worker，请刷新页面后重试')
      callbacks.onError(err)
      return Promise.reject(err)
    }

    // 如果已有实验在运行，先取消
    if (currentRunId) {
      cancel()
    }

    return new Promise((resolve, reject) => {
      currentRunId = `exp_${nextRunId++}_${Date.now()}`
      lastConfig = config
      runResolve = resolve
      runReject = reject
      retryCount = 0

      // 发送任务给 Worker
      w.postMessage({ type: 'run', config, runId: currentRunId })

      // 启动超时定时器
      startTimeoutTimer()
    })
  }

  function cancel() {
    if (!currentRunId) return

    const w = worker
    if (w) {
      w.postMessage({ type: 'cancel', runId: currentRunId })
    }

    clearTimeoutTimer()
    finishWorkerMessage()
  }

  function destroyWorker() {
    if (worker) {
      worker.removeEventListener('message', handleWorkerMessage)
      worker.removeEventListener('error', handleWorkerError)
      try {
        worker.terminate()
      } catch (_) {
        /* ignore */
      }
      worker = null
    }
  }

  function destroy() {
    cancel()
    destroyWorker()
    clearTimeoutTimer()
  }

  const isRunning = () => currentRunId !== null

  return { run, cancel, destroy, isRunning }
}

/**
 * 在主线程完成热力图 Canvas 渲染
 *
 * Worker 返回原始的 heatmapSnapshots（Float32Array 网格数据），
 * 由本函数在主线程用 DOM Canvas 渲染为 dataURL。
 */
export function renderHeatmapsOnMainThread(heatmapSnapshots, gloRange, fieldSize) {
  if (!heatmapSnapshots || !heatmapSnapshots.length)
    return { images: [], diffImage: null, hasDiff: false }

  const images = heatmapSnapshots.map(snap => {
    const sizeLabel = `${fieldSize[0].toFixed(0)}×${fieldSize[1].toFixed(0)}×${fieldSize[2].toFixed(0)}m`
    const canvas = renderHeatmapToCanvas(snap.gridData, {
      width: 280,
      height: 220,
      vmin: gloRange.min,
      vmax: gloRange.max,
      title: snap.label,
      subtitle: `Z = ${(fieldSize[2] / 2).toFixed(0)}m   |   ${sizeLabel}`,
      bgColor: '#14181e'
    })

    return {
      methodKey: snap.methodKey,
      label: snap.label,
      dataURL: heatmapToDataURL(canvas),
      vmin: gloRange.min,
      vmax: gloRange.max
    }
  })

  let diffImage = null
  if (heatmapSnapshots.length >= 2) {
    const diffCanvas = renderDifferenceHeatmap(
      heatmapSnapshots[0].gridData,
      heatmapSnapshots[1].gridData,
      {
        width: 280,
        height: 220,
        title: 'IDW − Kriging（差值）',
        subtitle: `正值→IDW偏高  |  负值→IDW偏低`,
        bgColor: '#14181e'
      }
    )
    diffImage = {
      dataURL: heatmapToDataURL(diffCanvas),
      label: `${heatmapSnapshots[0].label} − ${heatmapSnapshots[1].label}`
    }
  }

  return {
    images,
    diffImage,
    fieldSize,
    globalRange: gloRange,
    hasDiff: diffImage !== null
  }
}
