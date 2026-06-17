import useMessage from '@/composables/useMessage.js'
import { logger } from './logger.js'

const NOTIFY_DEBOUNCE_MS = 3000

let installed = false
let cleanupHandlers = []
let lastNotification = {
  key: '',
  at: 0
}

function notifyError(message) {
  const now = Date.now()
  if (lastNotification.key === message && now - lastNotification.at < NOTIFY_DEBOUNCE_MS) {
    return
  }

  lastNotification = {
    key: message,
    at: now
  }

  const { showMessage } = useMessage()
  showMessage(message, 'error')
}

function buildUserFacingMessage(prefix, errorLike) {
  if (errorLike instanceof Error && errorLike.message) {
    return `${prefix}: ${errorLike.message}`
  }
  if (typeof errorLike === 'string' && errorLike) {
    return `${prefix}: ${errorLike}`
  }
  return prefix
}

export function installGlobalErrorCapture(app) {
  if (installed) {
    return () => {
      for (const cleanup of cleanupHandlers) cleanup()
      cleanupHandlers = []
      installed = false
    }
  }

  installed = true
  cleanupHandlers = []

  const previousVueErrorHandler = app?.config?.errorHandler
  if (app?.config) {
    app.config.errorHandler = (error, instance, info) => {
      logger.error(
        'vue',
        '组件渲染或生命周期出现异常',
        {
          info,
          component: instance?.type?.name || instance?.type?.__name || 'AnonymousComponent'
        },
        error
      )
      notifyError(buildUserFacingMessage('系统错误', error))
      if (typeof previousVueErrorHandler === 'function') {
        previousVueErrorHandler(error, instance, info)
      }
    }

    cleanupHandlers.push(() => {
      app.config.errorHandler = previousVueErrorHandler
    })
  }

  const onWindowError = event => {
    const error = event?.error || event?.message || '未知错误'
    logger.error(
      'window',
      '捕获到全局脚本错误',
      {
        filename: event?.filename || '',
        lineno: event?.lineno || 0,
        colno: event?.colno || 0
      },
      error
    )
    notifyError(buildUserFacingMessage('全局错误', error))
  }

  const onUnhandledRejection = event => {
    const reason = event?.reason || '未知异步错误'
    logger.error('promise', '捕获到未处理的异步异常', null, reason)
    notifyError(buildUserFacingMessage('异步错误', reason))
  }

  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)

  cleanupHandlers.push(() => window.removeEventListener('error', onWindowError))
  cleanupHandlers.push(() => window.removeEventListener('unhandledrejection', onUnhandledRejection))

  return () => {
    for (const cleanup of cleanupHandlers) cleanup()
    cleanupHandlers = []
    installed = false
  }
}
