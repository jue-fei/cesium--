/**
 * 爆破实时数据推送协议
 *
 * 支持两种数据源：
 * 1. WebSocket 实时推送 —— 传感器/计算节点实时上报
 * 2. 本地模拟推送 —— 内置数值模拟引擎按帧推送
 *
 * 数据协议格式：
 * {
 *   type: 'blasting_frame' | 'stress_update' | 'vibration_field' | 'status',
 *   timestamp: number,
 *   frameIndex: number,
 *   payload: { ... }
 * }
 */

const DEFAULT_FRAME_INTERVAL_MS = 50
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_DELAY = 2000

export const STREAM_MESSAGE_TYPES = {
  BLASTING_FRAME: 'blasting_frame',
  STRESS_UPDATE: 'stress_update',
  VIBRATION_FIELD: 'vibration_field',
  STATUS: 'status',
  COMPLETE: 'complete',
  ERROR: 'error'
}

export const STREAM_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  STREAMING: 'streaming',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  DISCONNECTED: 'disconnected',
  COMPLETE: 'complete'
}

export const STREAM_STATUS_LABELS = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  streaming: '推送中',
  reconnecting: '重连中',
  error: '连接异常',
  disconnected: '已断开',
  complete: '推送完成'
}

/**
 * 爆破数据流连接器
 *
 * 负责管理实时数据推送连接，
 * 将接收到的帧数据分发给注册的回调。
 */
export class BlastingStreamConnector {
  constructor(config = {}) {
    this.mode = config.mode || 'local' // 'websocket' | 'local'
    this.wsUrl = config.wsUrl || ''
    this.eventId = config.eventId || null // 订阅的事件 ID（用于 WebSocket 模式）
    this.frameInterval = config.frameInterval || DEFAULT_FRAME_INTERVAL_MS
    this.status = STREAM_STATUS.IDLE
    this._ws = null
    this._timer = null
    this._reconnectAttempts = 0
    this._callbacks = new Map()
    this._frameProvider = null
    this._currentFrame = 0
    this._totalFrames = 0
    this._heartbeatTimer = null
    this._heartbeatInterval = config.heartbeatInterval || 30000
  }

  /**
   * 注册数据回调
   * @param {string} type - 消息类型
   * @param {Function} callback - 回调函数
   */
  on(type, callback) {
    if (!this._callbacks.has(type)) {
      this._callbacks.set(type, [])
    }
    this._callbacks.get(type).push(callback)
    return this
  }

  /**
   * 取消注册
   */
  off(type, callback) {
    const callbacks = this._callbacks.get(type)
    if (callbacks) {
      const idx = callbacks.indexOf(callback)
      if (idx >= 0) callbacks.splice(idx, 1)
    }
    return this
  }

  _emit(type, data) {
    const callbacks = this._callbacks.get(type)
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(data)
        } catch (e) {
          // 回调异常不影响其他回调
        }
      }
    }
  }

  _setStatus(status) {
    if (this.status !== status) {
      this.status = status
      this._emit(STREAM_MESSAGE_TYPES.STATUS, { status, label: STREAM_STATUS_LABELS[status] })
    }
  }

  /**
   * 设置本地帧数据提供器（用于本地模拟模式）
   * @param {Function} provider - (frameIndex) => frameData
   * @param {number} totalFrames - 总帧数
   */
  setLocalFrameProvider(provider, totalFrames) {
    this._frameProvider = provider
    this._totalFrames = totalFrames
  }

  /**
   * 连接数据源
   */
  connect() {
    if (this.mode === 'websocket') {
      this._connectWebSocket()
    } else {
      this._startLocalStream()
    }
  }

  _connectWebSocket() {
    if (!this.wsUrl) {
      this._setStatus(STREAM_STATUS.ERROR)
      this._emit(STREAM_MESSAGE_TYPES.ERROR, { message: 'WebSocket URL 未配置' })
      return
    }

    this._setStatus(STREAM_STATUS.CONNECTING)

    try {
      this._ws = new WebSocket(this.wsUrl)

      this._ws.onopen = () => {
        this._setStatus(STREAM_STATUS.CONNECTED)
        this._reconnectAttempts = 0
        this._startHeartbeat()
        // 发送订阅消息，请求服务端推送指定事件的帧数据
        if (this.eventId) {
          this._ws.send(JSON.stringify({ action: 'subscribe', event_id: this.eventId }))
        }
        this._setStatus(STREAM_STATUS.STREAMING)
      }

      this._ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data)
          this._handleMessage(data)
        } catch {
          // 忽略非 JSON 数据
        }
      }

      this._ws.onerror = () => {
        if (this.status === STREAM_STATUS.CONNECTING) {
          this._setStatus(STREAM_STATUS.ERROR)
        }
      }

      this._ws.onclose = () => {
        this._stopHeartbeat()
        this._ws = null
        if (this.status !== STREAM_STATUS.DISCONNECTED && this.status !== STREAM_STATUS.COMPLETE) {
          this._scheduleReconnect()
        }
      }
    } catch (e) {
      this._setStatus(STREAM_STATUS.ERROR)
      this._emit(STREAM_MESSAGE_TYPES.ERROR, { message: String(e) })
    }
  }

  _startLocalStream() {
    if (!this._frameProvider) {
      this._setStatus(STREAM_STATUS.ERROR)
      this._emit(STREAM_MESSAGE_TYPES.ERROR, { message: '未设置本地帧数据提供器' })
      return
    }

    this._setStatus(STREAM_STATUS.CONNECTED)
    this._setStatus(STREAM_STATUS.STREAMING)
    this._currentFrame = 0

    this._timer = setInterval(() => {
      if (this._currentFrame >= this._totalFrames) {
        this._setStatus(STREAM_STATUS.COMPLETE)
        this._emit(STREAM_MESSAGE_TYPES.COMPLETE, { totalFrames: this._totalFrames })
        this.disconnect()
        return
      }

      const frame = this._frameProvider(this._currentFrame)
      this._emit(STREAM_MESSAGE_TYPES.BLASTING_FRAME, {
        frameIndex: this._currentFrame,
        totalFrames: this._totalFrames,
        timestamp: Date.now(),
        frame
      })
      this._currentFrame++
    }, this.frameInterval)
  }

  _handleMessage(data) {
    const type = data.type || STREAM_MESSAGE_TYPES.BLASTING_FRAME
    this._emit(type, data)

    if (type === STREAM_MESSAGE_TYPES.COMPLETE) {
      this._setStatus(STREAM_STATUS.COMPLETE)
      this.disconnect()
    }
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._setStatus(STREAM_STATUS.DISCONNECTED)
      return
    }
    this._reconnectAttempts++
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(1.5, this._reconnectAttempts - 1),
      30000
    )
    this._setStatus(STREAM_STATUS.RECONNECTING)
    setTimeout(() => this._connectWebSocket(), delay)
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, this._heartbeatInterval)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  /**
   * 发送控制指令
   */
  send(command) {
    if (this.mode === 'websocket' && this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(command))
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    this._stopHeartbeat()
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._ws) {
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
    if (this.status !== STREAM_STATUS.COMPLETE) {
      this._setStatus(STREAM_STATUS.DISCONNECTED)
    }
  }

  /**
   * 重置到指定帧
   */
  seekToFrame(frameIndex) {
    this._currentFrame = Math.max(0, Math.min(this._totalFrames - 1, frameIndex))
  }

  destroy() {
    this.disconnect()
    this._callbacks.clear()
    this._frameProvider = null
  }
}

export default BlastingStreamConnector
