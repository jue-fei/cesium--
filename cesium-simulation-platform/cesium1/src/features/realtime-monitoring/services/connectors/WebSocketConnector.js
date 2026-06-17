import { DataConnector } from './DataConnector.js'
import { logger } from '@/utils/logger.js'

export class WebSocketConnector extends DataConnector {
  constructor(config = {}) {
    super(config)
    this._url = config.url || ''
    this._ws = null
    this._protocols = config.protocols || []
    this._heartbeatInterval = config.heartbeatInterval || 30000
    this._heartbeatTimer = null
    this._heartbeatMessage = config.heartbeatMessage || JSON.stringify({ type: 'ping' })
  }

  get connectorType() {
    return 'websocket'
  }

  setUrl(url) {
    this._url = url
  }

  connect() {
    if (!this._url) {
      return
    }

    if (
      this._ws &&
      (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    this.setStatus('connecting')
    try {
      this._ws = new WebSocket(this._url, this._protocols)
      this._ws.onopen = () => {
        this.setStatus('connected')
        this._reconnectAttempts = 0
        this._startHeartbeat()
      }
      this._ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'pong') return
          this.emitData(data)
        } catch {
          this.emitData(event.data)
        }
      }
      this._ws.onerror = () => {
        if (this._status === 'connecting') {
          this.setStatus('error')
        }
      }
      this._ws.onclose = () => {
        this._stopHeartbeat()
        this._ws = null
        if (this._status !== 'disconnecting') {
          this._scheduleReconnect()
        }
      }
    } catch (err) {
      logger.error('websocket-connector', '连接失败', { url: this._url }, err)
      this.setStatus('error')
      this._scheduleReconnect()
    }
  }

  send(data) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data)
      this._ws.send(payload)
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

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(this._heartbeatMessage)
      }
    }, this._heartbeatInterval)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }
}

export default WebSocketConnector
