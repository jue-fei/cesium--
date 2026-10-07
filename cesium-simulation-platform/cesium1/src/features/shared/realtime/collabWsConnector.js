/**
 * collabWsConnector.js —— 协作事件流连接器（/ws/collab · 3.2.2）
 *
 * 帧协议契约见 shared-consistency-baseline.json#collabCmps：
 *   server：{type:'hello', clientId} / {type:'collab_event', data} / {type:'pong'} / {type:'error'}
 *   client：{type:'ping'} / {type:'hello'}
 * 心跳 15s ping（服务端 60s 收不到任何消息即断）；断线指数退避重连
 * （复用 shared/realtime/backoff.js，与爆破/遥测连接器同源）。
 *
 * 终端 id 经查询参数上送——浏览器 WebSocket 无法自定义请求头（不同于 REST 的 X-Client-Id）。
 */
import { computeBackoffMs } from './backoff.js'
import { logger } from '@/utils/logger.js'
import { getClientId } from '../services/collabIdentity.js'

const HEARTBEAT_MS = 15000
const BASE_MS = 1000
const CAP_MS = 8000
const MAX_RECONNECTS = 6

/** 构造协作流 URL（scenario + clientId 查询参数）。 */
export function buildCollabUrl(scenario = 'ashale', clientId = getClientId()) {
  return `/ws/collab?scenario=${encodeURIComponent(scenario)}&clientId=${encodeURIComponent(clientId)}`
}

/** 纯函数：协作事件帧合法性（导出便于单测）。 */
export function isCollabEvent(frame) {
  return !!frame && frame.type === 'collab_event' && !!frame.data && typeof frame.data === 'object'
}

export class CollabWsConnector {
  constructor({ scenario = 'ashale', onEvent, onStatus } = {}) {
    this._scenario = scenario
    this._onEvent = onEvent
    this._onStatus = onStatus
    this._url = buildCollabUrl(scenario)
    this._ws = null
    this._status = 'idle'
    this._heartbeatTimer = null
    this._reconnectTimer = null
    this._attempts = 0
    this._closedByUser = false
  }

  get url() {
    return this._url
  }

  get status() {
    return this._status
  }

  connect() {
    if (
      this._ws &&
      (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    this._closedByUser = false
    this._setStatus('connecting')
    try {
      this._ws = new WebSocket(this._url)
      this._ws.onopen = () => {
        this._attempts = 0
        this._setStatus('connected')
        this._startHeartbeat()
      }
      this._ws.onmessage = event => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          logger.warn('collab-ws', '非法 JSON 帧已忽略')
          return
        }
        if (frame.type === 'pong') return
        if (frame.type === 'error') {
          logger.warn('collab-ws', '服务端错误帧', { message: frame.message })
          return
        }
        if (isCollabEvent(frame)) this._onEvent?.(frame.data)
      }
      this._ws.onerror = () => {
        if (this._status === 'connecting') this._setStatus('error')
      }
      this._ws.onclose = () => {
        this._stopHeartbeat()
        this._ws = null
        if (!this._closedByUser) this._scheduleReconnect()
      }
    } catch (err) {
      logger.error('collab-ws', '连接失败', { url: this._url }, err)
      this._setStatus('error')
      this._scheduleReconnect()
    }
  }

  disconnect() {
    this._closedByUser = true
    this._stopHeartbeat()
    this._clearReconnect()
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
    this._setStatus('disconnected')
  }

  send(data) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  _setStatus(status) {
    this._status = status
    this._onStatus?.(status)
  }

  _scheduleReconnect() {
    this._clearReconnect()
    if (this._attempts >= MAX_RECONNECTS) {
      this._setStatus('disconnected')
      return
    }
    this._attempts += 1
    this._setStatus('reconnecting')
    this._reconnectTimer = setTimeout(
      () => this.connect(),
      computeBackoffMs(this._attempts, { baseMs: BASE_MS, capMs: CAP_MS })
    )
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }
}

export default CollabWsConnector
