export class DataConnector {
  constructor(config = {}) {
    this.config = config
    this._status = 'idle'
    this._onData = null
    this._onStatusChange = null
    this._reconnectAttempts = 0
    this._maxReconnects = config.maxReconnects ?? 5
    this._reconnectDelay = config.reconnectDelay ?? 3000
    this._reconnectTimer = null
  }

  get status() {
    return this._status
  }

  get connectorType() {
    return 'base'
  }

  onData(callback) {
    this._onData = callback
    return this
  }

  onStatusChange(callback) {
    this._onStatusChange = callback
    return this
  }

  setStatus(status) {
    if (this._status !== status) {
      this._status = status
      this._onStatusChange?.(status)
    }
  }

  emitData(data) {
    this._onData?.(data)
  }

  connect() {
    throw new Error('connect() must be implemented by subclass')
  }

  disconnect() {
    this._clearReconnectTimer()
    this._reconnectAttempts = 0
  }

  destroy() {
    this.disconnect()
    this._onData = null
    this._onStatusChange = null
  }

  _scheduleReconnect() {
    this._clearReconnectTimer()
    if (this._reconnectAttempts >= this._maxReconnects) {
      this.setStatus('disconnected')
      return
    }
    this._reconnectAttempts++
    const delay = Math.min(this._reconnectDelay * Math.pow(1.5, this._reconnectAttempts - 1), 30000)
    this.setStatus('reconnecting')
    this._reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }
}

export default DataConnector
