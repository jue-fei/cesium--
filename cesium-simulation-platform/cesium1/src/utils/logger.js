const LOG_BUFFER_LIMIT = 100
const LOG_EVENT_NAME = 'app:log'
const LOG_LEVEL_STYLES = {
  debug: 'color:#94a3b8',
  info: 'color:#38bdf8',
  warn: 'color:#f59e0b',
  error: 'color:#f87171'
}

let externalReporter = null

function getRuntimeBuffer() {
  if (typeof window === 'undefined') return []
  if (!Array.isArray(window.__APP_LOG_BUFFER__)) {
    window.__APP_LOG_BUFFER__ = []
  }
  return window.__APP_LOG_BUFFER__
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || ''
    }
  }
  if (error === undefined || error === null) return null
  return { message: String(error) }
}

function createEntry(level, scope, message, meta, error) {
  return {
    level,
    scope: String(scope || 'app'),
    message: String(message || ''),
    meta: meta && typeof meta === 'object' ? meta : meta === undefined ? null : { value: meta },
    error: normalizeError(error),
    timestamp: new Date().toISOString()
  }
}

function emitToConsole(entry) {
  if (!import.meta.env.DEV) return

  const style = LOG_LEVEL_STYLES[entry.level] || LOG_LEVEL_STYLES.info
  const summary = `[${entry.scope}] ${entry.message}`
  const detail = {}

  if (entry.meta) detail.meta = entry.meta
  if (entry.error) detail.error = entry.error

  if (entry.level === 'error') {
    console.error(`%c${summary}`, style, detail)
    return
  }
  if (entry.level === 'warn') {
    console.warn(`%c${summary}`, style, detail)
    return
  }
  if (entry.level === 'debug') {
    console.debug(`%c${summary}`, style, detail)
    return
  }
  console.info(`%c${summary}`, style, detail)
}

function pushToBuffer(entry) {
  const buffer = getRuntimeBuffer()
  buffer.push(entry)
  if (buffer.length > LOG_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - LOG_BUFFER_LIMIT)
  }
}

function dispatchLogEvent(entry) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(LOG_EVENT_NAME, { detail: entry }))
}

function reportExternally(entry) {
  if (typeof externalReporter !== 'function') return
  try {
    externalReporter(entry)
  } catch (reportError) {
    if (import.meta.env.DEV) {
      console.warn('[logger] 外部日志上报失败', reportError)
    }
  }
}

function write(level, scope, message, meta, error) {
  const entry = createEntry(level, scope, message, meta, error)
  emitToConsole(entry)
  pushToBuffer(entry)
  dispatchLogEvent(entry)
  reportExternally(entry)
  return entry
}

export function setExternalLogReporter(reporter) {
  externalReporter = typeof reporter === 'function' ? reporter : null
}

export function getBufferedLogs() {
  return [...getRuntimeBuffer()]
}

export const logger = {
  debug(scope, message, meta, error) {
    return write('debug', scope, message, meta, error)
  },
  info(scope, message, meta, error) {
    return write('info', scope, message, meta, error)
  },
  warn(scope, message, meta, error) {
    return write('warn', scope, message, meta, error)
  },
  error(scope, message, meta, error) {
    return write('error', scope, message, meta, error)
  }
}

export { LOG_EVENT_NAME }
