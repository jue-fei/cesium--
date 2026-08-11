/**
 * 爆破模拟 WebSocket 连接器
 *
 * 对接后端 /ws/blasting/{event_id}/stream 端点，提供：
 * - JSON 文本帧双向通信（阶段一数据量小，无需 MessagePack）
 * - 心跳检测（15s ping/pong，30s 超时判定断线）
 * - 指数退避重连（1→2→4→8s，最多 5 次）
 * - 事件分发（按 type 注册处理器）
 *
 * 帧协议参见后端 app/routes/blasting_ws.py 文档注释。
 *
 * 降级策略：当 WS 不可用时，调用方应回退到本地 setInterval 播放
 * （见 useBlasting.js 的 startPlayback），本连接器不负责降级逻辑。
 */

const HEARTBEAT_INTERVAL_MS = 15000
const HEARTBEAT_TIMEOUT_MS = 30000
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 8000

/** 服务端推送帧类型枚举 */
export const FrameType = {
  BLAST_START: 'blast_start',
  PROGRESS: 'progress',
  BLAST_SEGMENT: 'blast_segment',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  PONG: 'pong',
  ERROR: 'error',
  // 二进制帧（与后端 blasting_ws.py / blast_physics.py 中 type_id 对应）
  PPV_FIELD: 'ppv_field', // 0x02 PPV 振动场（m/s, float32）
  STRESS_FIELD: 'stress_field', // 0x03 σ_vm 等效应力场（Pa, float32）
  DAMAGE_FIELD: 'damage_field' // 0x04 损伤分区（0~4, int8）
}

/**
 * 二进制帧 type_id ↔ FrameType 映射
 * 与后端 pack_ppv_binary / pack_stress_binary / pack_damage_binary 首字节一致
 */
const BINARY_TYPE_ID_MAP = {
  0x02: FrameType.PPV_FIELD,
  0x03: FrameType.STRESS_FIELD,
  0x04: FrameType.DAMAGE_FIELD
}

/** 二进制帧头部长度（三帧一致：1+4+4+4+4+4+6*4 = 45 字节） */
const PPV_HEADER_BYTES = 45

/** 客户端→服务端指令类型 */
export const CommandType = {
  START: 'start',
  STOP: 'stop',
  PING: 'ping'
}

export class BlastingWsConnector {
  /**
   * @param {string} eventId - 爆破事件 ID
   * @param {Object} [options]
   * @param {string} [options.url] - 完整 WS URL（覆盖默认构建逻辑）
   * @param {boolean} [options.autoReconnect=true] - 断线是否自动重连
   */
  constructor(eventId, options = {}) {
    this.eventId = eventId
    this._url = options.url || this._buildUrl(eventId)
    this._autoReconnect = options.autoReconnect !== false
    this.ws = null
    this._handlers = new Map()
    this._reconnectAttempts = 0
    this._shouldReconnect = false
    this._heartbeatTimer = null
    this._timeoutTimer = null
    this._lastPongTs = 0
  }

  /**
   * 构建 WS URL：基于当前页面协议与主机，走 vite 代理 /ws → 后端 3003
   */
  _buildUrl(eventId) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/ws/blasting/${encodeURIComponent(eventId)}/stream`
  }

  /** 建立连接 */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this._shouldReconnect = this._autoReconnect
    try {
      this.ws = new WebSocket(this._url)
    } catch (err) {
      console.error('[BlastingWs] connect failed:', err)
      this._scheduleReconnect()
      return
    }
    // 接收二进制帧为 ArrayBuffer（PPV 场等体积数据），默认为 ArrayBuffer
    this.ws.binaryType = 'arraybuffer'
    this.ws.onopen = this._onOpen.bind(this)
    this.ws.onmessage = this._onMessage.bind(this)
    this.ws.onclose = this._onClose.bind(this)
    this.ws.onerror = this._onError.bind(this)
  }

  _onOpen() {
    this._reconnectAttempts = 0
    this._lastPongTs = Date.now()
    this._startHeartbeat()
    this._handlers.get('_open')?.()
  }

  _onMessage(event) {
    const data = event.data
    // 二进制帧（PPV 振动场等体积数据）
    if (data instanceof ArrayBuffer) {
      this._handleBinaryFrame(data)
      return
    }
    // 兼容 Blob（理论上 binaryType='arraybuffer' 不会出现，但兜底处理）
    if (data && typeof data === 'object' && typeof data.arrayBuffer === 'function') {
      data.arrayBuffer().then((buf) => this._handleBinaryFrame(buf)).catch((err) => {
        console.error('[BlastingWs] blob→arraybuffer failed:', err)
      })
      return
    }
    // JSON 文本帧
    let msg
    try {
      msg = JSON.parse(data)
    } catch (err) {
      console.error('[BlastingWs] frame parse error:', err)
      return
    }
    // pong 帧重置超时计时器
    if (msg.type === FrameType.PONG) {
      this._lastPongTs = Date.now()
      this._resetTimeout()
      return
    }
    const fn = this._handlers.get(msg.type)
    if (fn) fn(msg)
    else this._handlers.get('_message')?.(msg)
  }

  /**
   * 处理二进制帧：按首字节 type_id 分发解析
   * @param {ArrayBuffer} buf
   */
  _handleBinaryFrame(buf) {
    if (buf.byteLength < 1) return
    const view = new DataView(buf)
    const typeId = view.getUint8(0)
    const frameType = BINARY_TYPE_ID_MAP[typeId]
    if (!frameType) {
      console.warn(`[BlastingWs] unknown binary type_id=0x${typeId.toString(16)}, skip`)
      return
    }
    let payload
    try {
      if (frameType === FrameType.PPV_FIELD) {
        payload = this._parsePpvField(view, buf)
      } else if (frameType === FrameType.STRESS_FIELD) {
        payload = this._parseStressField(view, buf)
      } else if (frameType === FrameType.DAMAGE_FIELD) {
        payload = this._parseDamageField(view, buf)
      } else {
        payload = { raw: buf }
      }
    } catch (err) {
      console.error('[BlastingWs] binary frame parse error:', err)
      return
    }
    const fn = this._handlers.get(frameType)
    if (fn) fn(payload)
    else this._handlers.get('_message')?.(payload)
  }

  /**
   * 通用：解析 float32 体素场二进制帧（PPV 0x02 / STRESS 0x03 共用头部与载荷格式）
   *
   * 帧格式（大端，与后端 pack_ppv_binary / pack_stress_binary 一致）：
   *   0  uint8   type_id
   *   1  uint32  sim_frame
   *   5  float32 t
   *   9  uint32  grid_w
   *  13  uint32  grid_h
   *  17  uint32  grid_d
   *  21  6×float32 bounds_min(xyz) + bounds_max(xyz)
   *  45  N×float32 体素数组
   *
   * @param {DataView} view
   * @param {ArrayBuffer} buf
   * @returns {Object} { frame, t, gridShape:[w,h,d], boundsMin, boundsMax, data: Float32Array }
   */
  _parseFloatFieldFrame(view, buf) {
    if (view.byteLength < PPV_HEADER_BYTES) {
      throw new Error(`float field frame too short: ${view.byteLength} < ${PPV_HEADER_BYTES}`)
    }
    // 所有多字节字段均为大端（后端 struct.pack '>...'）
    const frame = view.getUint32(1, false) // false = big-endian
    const t = view.getFloat32(5, false)
    const gridW = view.getUint32(9, false)
    const gridH = view.getUint32(13, false)
    const gridD = view.getUint32(17, false)
    const boundsMin = [
      view.getFloat32(21, false),
      view.getFloat32(25, false),
      view.getFloat32(29, false)
    ]
    const boundsMax = [
      view.getFloat32(33, false),
      view.getFloat32(37, false),
      view.getFloat32(41, false)
    ]

    const voxelCount = gridW * gridH * gridD
    const expectedBytes = PPV_HEADER_BYTES + voxelCount * 4
    if (view.byteLength < expectedBytes) {
      throw new Error(
        `float field payload size mismatch: got ${view.byteLength}, expected ${expectedBytes} ` +
        `(grid ${gridW}x${gridH}x${gridD}=${voxelCount} voxels)`
      )
    }

    // 拷贝为宿主字节序 Float32Array 供 WebGL Data3DTexture 直接使用。
    // 后端为大端，宿主通常为小端：使用 DataView.getFloat32(bigEndian=true)
    // 统一读取，避免逐字节翻转与逐元素分配，性能远优于手动 swap。
    const data = new Float32Array(voxelCount)
    const srcView = new DataView(buf, PPV_HEADER_BYTES, voxelCount * 4)
    for (let i = 0; i < voxelCount; i++) {
      data[i] = srcView.getFloat32(i * 4, false) // false = big-endian
    }

    return { frame, t, gridShape: [gridW, gridH, gridD], boundsMin, boundsMax, data }
  }

  /** 解析 PPV 振动场（0x02），载荷语义为质点速度 m/s */
  _parsePpvField(view, buf) {
    const r = this._parseFloatFieldFrame(view, buf)
    return { frame: r.frame, t: r.t, gridShape: r.gridShape, boundsMin: r.boundsMin, boundsMax: r.boundsMax, ppv: r.data }
  }

  /** 解析 σ_vm 等效应力场（0x03），载荷语义为 von Mises 应力 Pa */
  _parseStressField(view, buf) {
    const r = this._parseFloatFieldFrame(view, buf)
    return { frame: r.frame, t: r.t, gridShape: r.gridShape, boundsMin: r.boundsMin, boundsMax: r.boundsMax, sigmaVm: r.data }
  }

  /**
   * 解析损伤分区场（0x04，与后端 pack_damage_binary 对应）
   *
   * 头部格式与 float 帧一致；载荷为 N×int8 分区 id（0~4），单字节无字节序问题。
   * int8 直读（DataView.getInt8），轴序由后端 _webgl_flatten_3d 保证 x-最快。
   *
   * @returns {Object} { frame, t, gridShape, boundsMin, boundsMax, zones: Int8Array }
   */
  _parseDamageField(view, buf) {
    if (view.byteLength < PPV_HEADER_BYTES) {
      throw new Error(`damage field frame too short: ${view.byteLength} < ${PPV_HEADER_BYTES}`)
    }
    const frame = view.getUint32(1, false)
    const t = view.getFloat32(5, false)
    const gridW = view.getUint32(9, false)
    const gridH = view.getUint32(13, false)
    const gridD = view.getUint32(17, false)
    const boundsMin = [
      view.getFloat32(21, false),
      view.getFloat32(25, false),
      view.getFloat32(29, false)
    ]
    const boundsMax = [
      view.getFloat32(33, false),
      view.getFloat32(37, false),
      view.getFloat32(41, false)
    ]

    const voxelCount = gridW * gridH * gridD
    const expectedBytes = PPV_HEADER_BYTES + voxelCount // int8: 1 byte/voxel
    if (view.byteLength < expectedBytes) {
      throw new Error(
        `damage field payload size mismatch: got ${view.byteLength}, expected ${expectedBytes} ` +
        `(grid ${gridW}x${gridH}x${gridD}=${voxelCount} voxels)`
      )
    }

    // int8 单字节，无字节序；直接视图共享 buffer 避免拷贝（只读访问）
    const zones = new Int8Array(buf, PPV_HEADER_BYTES, voxelCount)
    return { frame, t, gridShape: [gridW, gridH, gridD], boundsMin, boundsMax, zones }
  }

  _onClose() {
    this._stopHeartbeat()
    this._handlers.get('_close')?.()
    if (this._shouldReconnect) {
      this._scheduleReconnect()
    }
  }

  _onError(err) {
    console.error('[BlastingWs] socket error:', err)
    // onclose 会随后触发，重连由 _onClose 处理
  }

  /**
   * 注册帧处理器
   * @param {string} type - FrameType 枚举值，或 '_open'/'_close'/'_message' 内部事件
   * @param {Function} fn - 处理函数，参数为解析后的消息对象
   */
  on(type, fn) {
    this._handlers.set(type, fn)
  }

  /** 移除处理器 */
  off(type) {
    this._handlers.delete(type)
  }

  /**
   * 发送指令到服务端
   * @param {Object} msg - { type: CommandType, ... }
   */
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /**
   * 启动模拟推送
   * @param {number} duration - 模拟总时长（秒）
   * @param {number} timestep - 时间步长（秒）
   * @param {Array} [holes] - 炮孔列表（含 delayMs/detonatorSeries/chargeKg/id）
   * @param {Object} [opts] - PPV 振动场计算参数
   * @param {number} [opts.chargeKg] - 装药量(kg)，驱动萨道夫斯基振幅
   * @param {number[]} [opts.blastCenter] - 爆心坐标 [x,y,z]（局部坐标系，m）
   * @param {number} [opts.tunnelWidth] - 隧道宽度(m)，决定采样网格横向范围
   * @param {number} [opts.tunnelHeight] - 隧道高度(m)，决定采样网格竖向范围
   */
  startStream(duration, timestep, holes, opts = {}) {
    const payload = { type: CommandType.START, duration, timestep, holes }
    // 仅在提供时透传 PPV 参数，后端 start_stream 有默认值兜底
    if (opts.chargeKg !== undefined) payload.chargeKg = Number(opts.chargeKg)
    if (Array.isArray(opts.blastCenter)) {
      payload.blastCenter = opts.blastCenter.map(Number)
    }
    if (opts.tunnelWidth !== undefined) payload.tunnelWidth = Number(opts.tunnelWidth)
    if (opts.tunnelHeight !== undefined) payload.tunnelHeight = Number(opts.tunnelHeight)
    this.send(payload)
  }

  /** 停止模拟推送 */
  stopStream() {
    this.send({ type: CommandType.STOP })
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      this.send({ type: CommandType.PING, t: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)
    this._resetTimeout()
  }

  _resetTimeout() {
    if (this._timeoutTimer) clearTimeout(this._timeoutTimer)
    this._timeoutTimer = setTimeout(() => {
      console.warn('[BlastingWs] heartbeat timeout, closing socket')
      this.ws?.close()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer)
      this._timeoutTimer = null
    }
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[BlastingWs] max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`)
      this._handlers.get('_giveup')?.()
      return
    }
    this._reconnectAttempts++
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this._reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS
    )
    console.info(`[BlastingWs] reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
    setTimeout(() => this.connect(), delay)
  }

  /** 主动断开连接（不触发重连） */
  disconnect() {
    this._shouldReconnect = false
    this._stopHeartbeat()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  /** 当前连接是否活跃 */
  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
