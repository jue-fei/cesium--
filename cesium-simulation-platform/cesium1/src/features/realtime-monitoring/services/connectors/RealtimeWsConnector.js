import { DataConnector } from './DataConnector.js'
import { computeBackoffMs } from '../../../shared/realtime/backoff.js'
import { logger } from '@/utils/logger.js'

/**
 * RealtimeWsConnector —— 全域实时推送 /ws/realtime/{scope} 连接器
 *
 * 帧协议契约见 shared-consistency-baseline.json#realtimeWsCmps：
 *   server: {type:'telemetry', seq, ts, source, scope, equipment, fleet} / pong / error
 *   client: {type:'ping'} / {type:'set_interval', interval}
 * 心跳 15s ping（服务端 60s 收不到任何消息即断）；seq 单调递增，乱序/回退帧
 * 丢弃（重连后按服务端 seq 继续判定，同帧只派发一次）。
 * 退避策略复用 shared/realtime/backoff.js（与爆破连接器同源）。
 */
const HEARTBEAT_MS = 15000
const BASE_MS = 1000
const CAP_MS = 8000
const MAX_RECONNECTS = 5

/** 纯函数：遥测帧合法性 + 乱序过滤（导出便于单测）。 */
export function isAcceptableTelemetry(frame, lastSeq) {
  return (
    !!frame &&
    frame.type === 'telemetry' &&
    typeof frame.seq === 'number' &&
    frame.seq > (lastSeq ?? 0)
  )
}

export class RealtimeWsConnector extends DataConnector {
  constructor(config = {}) {
    super(config)
    this._scope = config.scope || 'equipment'
    this._url = config.url || `/ws/realtime/${this._scope}`
    this._interval = config.interval || 2.0
    this._heartbeatMs = config.heartbeatInterval || HEARTBEAT_MS
    this._maxReconnects = config.maxReconnects ?? MAX_RECONNECTS
    this._ws = null
    this._heartbeatTimer = null
    this._lastSeq = null
    this._source = null
  }

  get connectorType() {
    return 'realtime_ws'
  }

  /** 最近一帧的数据来源标签（'simulated' = 模拟数据源） */
  get source() {
    return this._source
  }

  connect() {
    if (
      this._ws &&
      (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    this.setStatus('connecting')
    try {
      this._ws = new WebSocket(this._url)
      this._ws.onopen = () => {
        this.setStatus('connected')
        this._reconnectAttempts = 0
        this._startHeartbeat()
        // 应用本地间隔偏好（重连后保持）
        this.send({ type: 'set_interval', interval: this._interval })
      }
      this._ws.onmessage = event => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          logger.warn('realtime-ws', '非法 JSON 帧已忽略')
          return
        }
        if (frame.type === 'pong') return
        if (frame.type === 'error') {
          logger.warn('realtime-ws', '服务端错误帧', { message: frame.message })
          return
        }
        if (!isAcceptableTelemetry(frame, this._lastSeq)) return
        this._lastSeq = frame.seq
        this._source = frame.source || null
        this.emitData(frame)
      }
      this._ws.onerror = () => {
        if (this._status === 'connecting') this.setStatus('error')
      }
      this._ws.onclose = () => {
        this._stopHeartbeat()
        this._ws = null
        if (this._status !== 'disconnecting') this._scheduleReconnect()
      }
    } catch (err) {
      logger.error('realtime-ws', '连接失败', { url: this._url }, err)
      this.setStatus('error')
      this._scheduleReconnect()
    }
  }

  /** 调整服务端推送间隔（0.5~30s，服务端钳制）。 */
  setInterval(interval) {
    this._interval = interval
    this.send({ type: 'set_interval', interval })
  }

  send(data) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  disconnect() {
    this.setStatus('disconnecting')
    this._stopHeartbeat()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
    super.disconnect()
  }

  _scheduleReconnect() {
    this._clearReconnectTimer()
    if (this._reconnectAttempts >= this._maxReconnects) {
      this.setStatus('disconnected')
      return
    }
    this._reconnectAttempts++
    this.setStatus('reconnecting')
    this._reconnectTimer = setTimeout(
      () => this.connect(),
      computeBackoffMs(this._reconnectAttempts, { baseMs: BASE_MS, capMs: CAP_MS })
    )
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, this._heartbeatMs)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }
}

export default RealtimeWsConnector
