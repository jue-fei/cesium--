/**
 * 统一时间轴（方案 WP3 T3.1 / T3.2 / T3.4 / T3.6）
 *
 * 设计约束（方案 P1-3）：
 *   - 只有「一个时间源」，模块不得各自建播放定时器；
 *   - 渲染用的 requestAnimationFrame 不计入该约束（Cesium/three 各有渲染循环）；
 *   - 模块通过 provider 注册自己的可寻址区间，clock 只做「呈现映射」，不反向读取模块时钟。
 *
 * 状态机（T3.6）：
 *   idle   未接入任何模块：时间轴显示「未接入」，禁止播放；
 *   replay 回放态：可拖动/倍速/A-B 循环，时间由本服务推进；
 *   live   直播态：跟随后端最新事件，禁止拖动。
 *
 * 与现有播放器的关系：默认不接管（影子时钟）。仅当调用方显式注册 provider
 * 并驱动 clock 时，模块才受控；未注册时该模块行为完全不变。
 */
export const CLOCK_MODE = Object.freeze({
    IDLE: 'idle',
    REPLAY: 'replay',
    LIVE: 'live'
})

const DEFAULT_RATE = 1
const MIN_RATE = 0.1
const MAX_RATE = 16

export class TwinClock {
    constructor() {
        this.mode = CLOCK_MODE.IDLE
        /** 相对秒：统一历元起的秒数，是全部模块的唯一真值 */
        this.t = 0
        this.rate = DEFAULT_RATE
        this.playing = false
        /** 统一历元（epoch 秒，服务端时间） */
        this.epoch = 0
        /** 服务端时间 - 本地时间（毫秒） */
        this.skewMs = 0

        this._providers = new Map()
        this._listeners = new Set()
        this._raf = 0
        this._timer = 0
        this._lastTs = 0
    }

    // ---------- provider 注册（T3.3）----------
    /**
     * 注册一个可寻址模块。
     * @param {string} id 模块标识，如 'blasting' / 'stress' / 'scheduling'
     * @param {{getRange:()=>[number,number]|null, seek:(t:number)=>void, label?:string}} provider
     */
    registerProvider(id, provider) {
        if (!id || !provider || typeof provider.seek !== 'function') return false
        this._providers.set(id, provider)
        if (this.mode === CLOCK_MODE.IDLE) {
            // 首个模块接入：进入回放态（空态由 UI 依据 providerCount 展示）
            this.mode = CLOCK_MODE.REPLAY
        }
        this._emit('provider')
        return true
    }

    unregisterProvider(id) {
        const removed = this._providers.delete(id)
        if (removed && this._providers.size === 0) {
            this.mode = CLOCK_MODE.IDLE
            this.playing = false
            this._stop()
            this.t = 0
        }
        if (removed) this._emit('provider')
        return removed
    }

    getProviderIds() {
        return [...this._providers.keys()]
    }

    /** 汇聚全部模块的可寻址区间；无 provider 返回 null（T3.6 空态） */
    getRange() {
        let lo = null
        let hi = null
        for (const provider of this._providers.values()) {
            let range = null
            try {
                range = provider.getRange?.() || null
            } catch (_) {
                range = null
            }
            if (!Array.isArray(range) || range.length !== 2) continue
            const [a, b] = [Number(range[0]), Number(range[1])]
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue
            lo = lo === null ? Math.min(a, b) : Math.min(lo, a, b)
            hi = hi === null ? Math.max(a, b) : Math.max(hi, a, b)
        }
        return lo === null ? null : [lo, hi]
    }

    // ---------- 状态控制 ----------
    setMode(mode, { epoch } = {}) {
        if (!Object.values(CLOCK_MODE).includes(mode)) return false
        this.mode = mode
        if (mode === CLOCK_MODE.IDLE) {
            this.playing = false
            this.t = 0
            this._stop()
        }
        if (mode === CLOCK_MODE.LIVE) {
            // 直播态不推进本地时间：t 由事件流更新
            this.playing = false
            this._stop()
        }
        if (typeof epoch === 'number' && Number.isFinite(epoch)) this.epoch = epoch
        this._emit('mode')
        return true
    }

    play() {
        if (this.mode !== CLOCK_MODE.REPLAY) return false
        if (this.playing) return true
        this.playing = true
        this._lastTs = 0
        this._start()
        this._emit('play')
        return true
    }

    pause() {
        if (!this.playing) return false
        this.playing = false
        this._stop()
        this._emit('pause')
        return true
    }

    setRate(rate) {
        const value = Number(rate)
        if (!Number.isFinite(value)) return false
        this.rate = Math.min(MAX_RATE, Math.max(MIN_RATE, value))
        this._emit('rate')
        return true
    }

    /** 跳转到相对秒 t，并同步全部 provider（禁止在 live 态拖动） */
    seek(t) {
        if (this.mode === CLOCK_MODE.LIVE) return false
        const value = Number(t)
        if (!Number.isFinite(value)) return false
        const range = this.getRange()
        this.t = range ? Math.min(range[1], Math.max(range[0], value)) : value
        this._applySeek()
        this._emit('seek')
        return true
    }

    /**
     * 纯推进（可测）：按 dt 秒与速率推进内部时间并下发 seek。
     * rAF 循环只负责提供 dt，不直接改时间，保证逻辑可单测。
     */
    advance(dtSeconds) {
        if (!this.playing || this.mode !== CLOCK_MODE.REPLAY) return this.t
        const dt = Number(dtSeconds)
        if (!Number.isFinite(dt) || dt <= 0) return this.t
        const range = this.getRange()
        this.t += dt * this.rate
        if (range) {
            this.t = Math.min(range[1], Math.max(range[0], this.t))
            if (this.t >= range[1]) {
                // 到末尾自动暂停，行为与既有播放器一致，避免空转
                this.playing = false
                this._stop()
            }
        }
        this._applySeek()
        this._emit('tick')
        return this.t
    }

    // ---------- 服务端时间对齐（T3.4）----------
    /**
     * 用一次往返采样估算偏斜：skew = serverTime - (t0 + t1) / 2。
     * 返回 {skewMs, serverTime, rttMs}，失败返回 null。
     */
    async syncWithServer(fetcher = globalThis.fetch) {
        if (typeof fetcher !== 'function') return null
        const t0 = Date.now()
        try {
            const resp = await fetcher('/api/twin/clock')
            const json = await resp.json()
            const t1 = Date.now()
            const data = json?.data
            if (!data || !Number.isFinite(Number(data.serverTime))) return null
            const serverMs = Number(data.serverTime) * 1000
            this.skewMs = serverMs - (t0 + t1) / 2
            this.epoch = Number(data.serverTime)
            this._emit('sync')
            return { skewMs: this.skewMs, serverTime: Number(data.serverTime), rttMs: t1 - t0 }
        } catch (_) {
            return null
        }
    }

    /** 本地时间戳（ms）换算为服务端时间（ms） */
    toServerTime(localMs = Date.now()) {
        return localMs + this.skewMs
    }

    // ---------- 订阅与快照 ----------
    snapshot() {
        return {
            mode: this.mode,
            t: this.t,
            rate: this.rate,
            playing: this.playing,
            epoch: this.epoch,
            skewMs: this.skewMs,
            providerCount: this._providers.size,
            providerIds: this.getProviderIds(),
            range: this.getRange()
        }
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => { }
        this._listeners.add(listener)
        return () => this._listeners.delete(listener)
    }

    // ---------- 内部 ----------
    _applySeek() {
        for (const provider of this._providers.values()) {
            try {
                provider.seek(this.t)
            } catch (error) {
                console.warn('[twin-clock] provider seek 失败', error)
            }
        }
    }

    _emit(reason) {
        if (this._listeners.size === 0) return
        const snapshot = this.snapshot()
        for (const listener of this._listeners) {
            try {
                listener(snapshot, reason)
            } catch (error) {
                console.warn('[twin-clock] 订阅者异常', error)
            }
        }
    }

    _start() {
        if (this._raf || this._timer) return
        if (typeof requestAnimationFrame === 'function') {
            const step = ts => {
                this._raf = 0
                if (!this.playing) return
                const last = this._lastTs || ts
                this._lastTs = ts
                const dt = Math.max(0, (ts - last) / 1000)
                if (dt > 0) this.advance(dt)
                if (this.playing) this._raf = requestAnimationFrame(step)
            }
            this._raf = requestAnimationFrame(step)
        } else {
            // 非浏览器环境（单测/SSR）退化：由调用方显式 advance
            this._timer = setInterval(() => this.advance(0.016), 16)
        }
    }

    _stop() {
        if (this._raf && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._raf)
        }
        this._raf = 0
        if (this._timer) {
            clearInterval(this._timer)
            this._timer = 0
        }
        this._lastTs = 0
    }
}

// 进程级单例：驾驶舱、播放器、情境切换共用
export const twinClock = new TwinClock()

export default twinClock
