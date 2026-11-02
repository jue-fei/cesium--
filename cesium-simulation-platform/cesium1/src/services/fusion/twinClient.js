/**
 * 孪生融合事件客户端（方案 WP2 T2.3）
 *
 * 后端契约见 backend-py/app/services/fusion/contracts.py：
 *   { type, proc, payload, ts, seq, source }
 *
 * 职责边界（方案 P0-2）：
 *   - 前端只「上报事件」与「执行动作」，不做规则匹配；
 *   - seq 由后端分配，本客户端仅用于去重与断线重放起点；
 *   - 动作以 `fusion:action` 事件下发，形如 { action, payload }。
 *
 * 事件类型约定 `<工序>:<对象>:<动作>`：
 *   blasting:event:completed  爆破事件回放完成（携带爆堆，触发 R4）
 *   optimization:adopted      方案被采纳（触发 R6）
 *   fusion:action             后端下发动作（前端执行，不回传）
 */
const WS_PATH = '/ws/twin/events'
const HTTP_PATH = '/api/twin/events'
const MAX_RECONNECT = 6
const RECONNECT_BASE_MS = 1000
const HEARTBEAT_MS = 25000

class TwinClient {
    constructor() {
        this._ws = null
        this._lastSeq = 0
        this._eventHandlers = new Set()
        this._actionHandlers = new Map()
        this._statusHandlers = new Set()
        this._reconnectAttempts = 0
        this._reconnectTimer = null
        this._heartbeatTimer = null
        this._manualClose = false
        this.status = 'idle'
    }

    // ---------- 连接管理 ----------
    connect() {
        if (this._ws || this._manualClose) return this
        this._setStatus('connecting')

        let ws
        try {
            ws = new WebSocket(this._buildUrl())
        } catch (error) {
            this._setStatus('error')
            this._scheduleReconnect()
            return this
        }

        this._ws = ws
        ws.onopen = () => {
            this._reconnectAttempts = 0
            this._setStatus('connected')
            this._startHeartbeat()
        }
        ws.onmessage = evt => {
            let msg
            try {
                msg = JSON.parse(evt.data)
            } catch (_) {
                return
            }
            this._handleMessage(msg)
        }
        ws.onclose = () => {
            this._stopHeartbeat()
            this._ws = null
            if (this._manualClose) return
            this._setStatus('disconnected')
            this._scheduleReconnect()
        }
        ws.onerror = () => {
            // 具体原因由 onclose 统一处理，避免重复计数
        }
        return this
    }

    disconnect() {
        this._manualClose = true
        this._stopHeartbeat()
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer)
            this._reconnectTimer = null
        }
        if (this._ws) {
            this._ws.close()
            this._ws = null
        }
        this._setStatus('idle')
    }

    _buildUrl() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        return `${proto}://${location.host}${WS_PATH}?since_seq=${this._lastSeq}`
    }

    _scheduleReconnect() {
        if (this._reconnectTimer) return
        if (this._reconnectAttempts >= MAX_RECONNECT) {
            this._setStatus('error')
            return
        }
        this._reconnectAttempts += 1
        const delay = RECONNECT_BASE_MS * Math.pow(1.6, this._reconnectAttempts - 1)
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null
            this.connect()
        }, delay)
    }

    _startHeartbeat() {
        this._stopHeartbeat()
        this._heartbeatTimer = setInterval(() => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                this._ws.send(JSON.stringify({ type: 'ping', t: Date.now() }))
            }
        }, HEARTBEAT_MS)
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer)
            this._heartbeatTimer = null
        }
    }

    // ---------- 消息处理 ----------
    _handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return
        if (msg.kind === 'ready') {
            this._setStatus('connected')
            return
        }
        // ping/pong 与未知类型一律忽略
        if (msg.kind !== 'event' || !msg.event) return

        const event = msg.event
        if (!this._acceptSeq(event)) return

        for (const handler of this._eventHandlers) {
            try {
                handler(event)
            } catch (error) {
                console.warn('[twin] 事件处理器异常', error)
            }
        }

        if (event.type === 'fusion:action') {
            this._dispatchAction(event.payload || {})
        }
    }

    /** 按 seq 去重（断线重放可能重复投递）；返回是否应继续分发 */
    _acceptSeq(event) {
        const seq = Number(event.seq || 0)
        if (seq && seq <= this._lastSeq) return false
        if (seq) this._lastSeq = seq
        return true
    }

    _dispatchAction(payload) {
        const action = payload.action
        if (!action) return
        const handlers = this._actionHandlers.get(action)
        if (!handlers || handlers.size === 0) return
        for (const handler of handlers) {
            try {
                handler(payload.payload || {}, payload)
            } catch (error) {
                console.warn(`[twin] 动作 ${action} 执行异常`, error)
            }
        }
    }

    _setStatus(status) {
        if (this.status === status) return
        this.status = status
        for (const handler of this._statusHandlers) {
            try {
                handler(status)
            } catch (_) {
                /* 状态回调失败不阻塞连接 */
            }
        }
    }

    // ---------- 对外 API ----------
    /** 订阅全部事件（用于调试或统一日志），返回取消函数。 */
    onEvent(handler) {
        this._eventHandlers.add(handler)
        return () => this._eventHandlers.delete(handler)
    }

    /** 订阅某个动作（如 haulage:refresh），返回取消函数。 */
    onAction(action, handler) {
        if (!this._actionHandlers.has(action)) {
            this._actionHandlers.set(action, new Set())
        }
        this._actionHandlers.get(action).add(handler)
        return () => {
            const set = this._actionHandlers.get(action)
            if (!set) return
            set.delete(handler)
            if (set.size === 0) this._actionHandlers.delete(action)
        }
    }

    onStatus(handler) {
        this._statusHandlers.add(handler)
        return () => this._statusHandlers.delete(handler)
    }

    /**
     * 上报事件（HTTP，单一入口）。
     * 注意：若后端启用 BLASTING_API_TOKEN，需在此统一补 x-api-token 头。
     */
    async publish({ type, proc, payload = {}, source = 'web', ts }) {
        if (!type || !proc) {
            return { code: 400, message: 'type/proc 不能为空' }
        }
        try {
            const body = { type, proc, payload, source }
            if (typeof ts === 'number') body.ts = ts
            const resp = await fetch(HTTP_PATH, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            return await resp.json()
        } catch (error) {
            return { code: 1, message: String((error && error.message) || error) }
        }
    }
}

export const twinClient = new TwinClient()

export default twinClient
