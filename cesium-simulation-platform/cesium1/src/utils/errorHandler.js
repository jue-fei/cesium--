/**
 * 统一诊断日志工具。
 * DEV 模式下输出 console.warn；生产模式下静默。
 * 注意：本工具不替代 try/catch — 仅在不能向上抛出且需要留存诊断信息的 catch 块中使用。
 */

export function warn(scope, message, error) {
  if (import.meta.env.DEV) {
    const scopeText = String(scope || 'core')
    const msgText = String(message || '')
    const errInfo =
      error instanceof Error
        ? error.message || error.toString()
        : error !== undefined
          ? String(error)
          : ''
    console.warn(`[${scopeText}] ${msgText}`, errInfo || '')
  }
}

/**
 * 仅在 DEV 模式下输出错误详情。
 */
export function debugError(scope, message, error) {
  if (import.meta.env.DEV) {
    const scopeText = String(scope || 'core')
    const msgText = String(message || '')
    console.error(`[${scopeText}] ${msgText}`, error)
  }
}
