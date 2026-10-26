/**
 * 融合事件总线 —— 工序间数据联动的唯一通道
 *
 * 三条核心数据链路：
 *   链路① blasting:vibration:updated  → 爆破振动场 → 应力分析模块
 *   链路② geology:boreholes:loaded     → 钻孔岩性数据 → 安全评估参数体系
 *   链路③ blasting:zone:changed        → 爆破危险区域 → 运输路径禁行约束
 *
 * 使用方式：
 *   import { fusionBus } from '@/services/fusion/FusionBus.js'
 *   fusionBus.publish('channel', payload)
 *   const unsub = fusionBus.subscribe('channel', (payload) => { ... })
 */

const CHANNELS = Object.freeze({
  // 链路①：爆破 → 应力
  BLASTING_VIBRATION_UPDATED: 'blasting:vibration:updated',
  BLASTING_STRESS_UPDATED: 'blasting:stress:updated',
  BLASTING_EVENT_STARTED: 'blasting:event:started',
  BLASTING_EVENT_COMPLETED: 'blasting:event:completed',

  // 链路②：地质 → 安全评估
  GEOLOGY_BOREHOLES_LOADED: 'geology:boreholes:loaded',
  GEOLOGY_SAFETY_CONTEXT_READY: 'geology:safety:context:ready',

  // 链路③：爆破 → 运输路径
  BLASTING_ZONE_CHANGED: 'blasting:zone:changed',

  // 通用
  FUSION_ERROR: 'fusion:error'
})

class FusionBus {
  constructor() {
    this._handlers = new Map()
    this._history = new Map() // 记录最近一次发布，供延迟订阅者回放
  }

  /**
   * 发布事件到指定通道
   * @param {string} channel - 通道名，使用 CHANNELS 常量
   * @param {*} payload - 数据载荷
   */
  publish(channel, payload) {
    const handlers = this._handlers.get(channel)
    // 保存最近一次载荷，供延迟订阅者使用
    this._history.set(channel, { payload, timestamp: Date.now() })
    if (!handlers || handlers.length === 0) return
    for (const handler of handlers) {
      try {
        handler(payload)
      } catch (err) {
        console.error(`[FusionBus] ${channel} handler error:`, err)
        this.publish(CHANNELS.FUSION_ERROR, { channel, error: err, payload })
      }
    }
  }

  /**
   * 订阅通道
   * @param {string} channel
   * @param {Function} handler
   * @param {Object} [options]
   * @param {boolean} [options.replay=true] - 是否立即回放最近一次历史载荷
   * @returns {Function} 取消订阅函数
   */
  subscribe(channel, handler, { replay = false } = {}) {
    if (!this._handlers.has(channel)) {
      this._handlers.set(channel, [])
    }
    this._handlers.get(channel).push(handler)

    // 回放：如果订阅时已有历史数据，立即触发一次
    if (replay) {
      const history = this._history.get(channel)
      if (history) {
        try {
          handler(history.payload)
        } catch (_) { /* 回放失败不影响订阅 */ }
      }
    }

    return () => {
      const list = this._handlers.get(channel)
      if (!list) return
      const idx = list.indexOf(handler)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  /**
   * 获取通道最近一次载荷
   */
  lastPayload(channel) {
    const h = this._history.get(channel)
    return h ? h.payload : undefined
  }

  /**
   * 清空指定通道（调试用）
   */
  clear(channel) {
    this._handlers.delete(channel)
    this._history.delete(channel)
  }

  /** 获取所有已注册的通道名 */
  get channels() {
    return [...this._handlers.keys()]
  }

  /** 获取通道订阅者数量 */
  subscriberCount(channel) {
    const handlers = this._handlers.get(channel)
    return handlers ? handlers.length : 0
  }
}

export const fusionBus = new FusionBus()
export { CHANNELS }
