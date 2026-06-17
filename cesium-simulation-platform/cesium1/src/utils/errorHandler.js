/**
 * 统一诊断日志工具。
 * 统一收口到 logger，便于后续接入 Sentry 或远端日志平台。
 * 注意：本工具不替代 try/catch — 仅在不能向上抛出且需要留存诊断信息的 catch 块中使用。
 */

import { logger } from './logger.js'

export function warn(scope, message, error) {
  logger.warn(String(scope || 'core'), String(message || ''), null, error)
}

/**
 * 仅在 DEV 模式下输出错误详情。
 */
export function debugError(scope, message, error) {
  if (import.meta.env.DEV) {
    logger.debug(String(scope || 'core'), String(message || ''), null, error)
  }
}
