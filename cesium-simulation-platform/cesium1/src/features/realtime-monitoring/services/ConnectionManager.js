import { WebSocketConnector } from './connectors/WebSocketConnector.js'
import { HttpPollConnector } from './connectors/HttpPollConnector.js'

const CONNECTOR_REGISTRY = {
  websocket: WebSocketConnector,
  http_poll: HttpPollConnector
}

const STATUS_LABELS = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  error: '连接异常',
  disconnecting: '断开中',
  disconnected: '已断开'
}

const STATUS_COLORS = {
  idle: '#9ca3af',
  connecting: '#fbbf24',
  connected: '#34d399',
  reconnecting: '#f59e0b',
  error: '#ef4444',
  disconnecting: '#9ca3af',
  disconnected: '#6b7280'
}

export class ConnectionManager {
  constructor(options = {}) {
    this._dataHandler = options.dataHandler || null
    this._statusHandler = options.statusHandler || null
    this._connector = null
    this._connectorType = null
    this._config = {}
    this._unsubscribe = []
  }

  get connectorType() {
    return this._connectorType
  }

  get isConnected() {
    return this._connector?.status === 'connected'
  }

  get status() {
    return this._connector?.status || 'idle'
  }

  get statusLabel() {
    return STATUS_LABELS[this.status] || '未知'
  }

  get statusColor() {
    return STATUS_COLORS[this.status] || '#9ca3af'
  }

  static get supportedTypes() {
    return [
      { value: 'websocket', label: 'WebSocket 实时推送' },
      { value: 'http_poll', label: 'HTTP 轮询获取' }
    ]
  }

  async switchTo(connectorType, config = {}) {
    if (this._connectorType === connectorType) return

    this.disconnect()
    this._connectorType = connectorType
    this._config = config

    const ConnectorClass = CONNECTOR_REGISTRY[connectorType]
    if (!ConnectorClass) {
      return
    }

    this._connector = new ConnectorClass(config)
      .onData(data => {
        if (Array.isArray(data)) {
          data.forEach(item => this._dataHandler?.(item))
        } else {
          this._dataHandler?.(data)
        }
      })
      .onStatusChange(status => {
        this._statusHandler?.(status)
      })

    this._connector.connect()
  }

  disconnect() {
    this._connector?.destroy()
    this._connector = null
  }

  destroy() {
    this.disconnect()
    this._unsubscribe.forEach(fn => fn())
    this._unsubscribe = []
    this._dataHandler = null
    this._statusHandler = null
  }
}

export default ConnectionManager
