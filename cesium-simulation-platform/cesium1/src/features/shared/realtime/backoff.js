/**
 * backoff.js —— WS 重连退避策略（全库单源）
 *
 * 消费方：blastingWsConnector（爆破二进制流）、RealtimeWsConnector（全域遥测）。
 * 策略：指数退避 delay = min(capMs, baseMs * 2^(attempt-1))，attempt 从 1 起。
 * 契约参数见 shared-consistency-baseline.json#realtimeWsCmps.backoff。
 */

/**
 * 计算第 attempt 次重连的延迟毫秒数。
 * @param {number} attempt 重连尝试序号（从 1 开始）
 * @param {{baseMs?:number, capMs?:number}} [opts]
 * @returns {number} 延迟毫秒
 */
export function computeBackoffMs(attempt, { baseMs = 1000, capMs = 8000 } = {}) {
  const n = Math.max(1, Math.floor(attempt || 1))
  return Math.min(baseMs * 2 ** (n - 1), capMs)
}
