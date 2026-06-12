import { DataConnector } from './DataConnector.js'

export class HttpPollConnector extends DataConnector {
  constructor(config = {}) {
    super(config)
    this._url = config.url || ''
    this._pollInterval = config.pollInterval || 2000
    this._pollTimer = null
    this._headers = config.headers || { 'Content-Type': 'application/json' }
    this._lastTimestamp = 0
  }

  get connectorType() {
    return 'http_poll'
  }

  setUrl(url) {
    this._url = url
  }

  connect() {
    if (!this._url) {
      return
    }

    this.setStatus('connected')
    this._reconnectAttempts = 0
    this._doPoll()
  }

  disconnect() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
    super.disconnect()
  }

  async _doPoll() {
    if (this._status !== 'connected') return

    try {
      const url = this._lastTimestamp
        ? `${this._url}${this._url.includes('?') ? '&' : '?'}_t=${this._lastTimestamp}`
        : this._url

      const response = await fetch(url, {
        headers: this._headers,
        signal: AbortSignal.timeout(10000)
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const result = await response.json()
      const data = result.data || result

      if (Array.isArray(data)) {
        data.forEach(item => {
          this._lastTimestamp = Math.max(this._lastTimestamp, item.timestamp || 0)
          this.emitData(item)
        })
      } else if (data) {
        this._lastTimestamp = Math.max(this._lastTimestamp, data.timestamp || 0)
        this.emitData(data)
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.setStatus('error')
        this._scheduleReconnect()
        return
      }
    }

    this._pollTimer = setTimeout(() => this._doPoll(), this._pollInterval)
  }
}

export default HttpPollConnector
