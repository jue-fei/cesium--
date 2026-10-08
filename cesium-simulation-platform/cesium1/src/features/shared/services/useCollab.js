/**
 * useCollab.js —— 跨终端协作状态（3.2.2 · 应用级单例）
 *
 * 订阅 /ws/collab 协作事件：他端操作实时可见。所有消费方共享同一连接与事件缓冲——
 *   - App.vue 启动一次（全局 Toast 提示他端操作，提供应用级生命周期）
 *   - AuditPanel 订阅后把事件实时插入时间线（本机/他端标注）
 * 回声抑制：事件 clientId === 本机 terminal id 时只入缓冲、不弹提示。
 * 跨面板联动：事件发布到 FusionBus#COLLAB_OPERATION，面板可 opt-in 刷新。
 * 契约见 shared-consistency-baseline.json#collabCmps（collabContract.test.js 锁定）。
 */
import { ref } from 'vue'
import { CollabWsConnector } from '../realtime/collabWsConnector.js'
import { getClientId } from './collabIdentity.js'
import { ACTIVE_SCENARIO } from './activeScenario.js'
import useMessage from '@/composables/useMessage.js'
import { fusionBus, CHANNELS } from '@/services/fusion/FusionBus.js'

const MAX_EVENTS = 50

// 模块级单例状态（App 与面板共享）
const connected = ref(false)
const events = ref([]) // 倒序：最新在前
const lastEvent = ref(null)

let connector = null
const _handlers = new Set()

function _onStatus(status) {
  connected.value = status === 'connected'
}

function _onEvent(evt) {
  if (!evt || evt.id == null) return
  if (events.value.some(e => e.id === evt.id)) return // 去重（连接即 hello / 重连补发）
  events.value.unshift(evt)
  if (events.value.length > MAX_EVENTS) events.value.length = MAX_EVENTS
  lastEvent.value = evt
  // 跨面板联动（opt-in 刷新）
  fusionBus.publish(CHANNELS.COLLAB_OPERATION, evt)
  // 他端操作 → 全局提示（本机回声抑制）
  if (evt.clientId !== getClientId()) {
    useMessage().showMessage(`其他终端 · ${evt.actor || ''}：${evt.summary || evt.action}`, 'info')
  }
  for (const handler of _handlers) {
    try {
      handler(evt)
    } catch (err) {
      // 单个订阅者异常不影响其他订阅者
      console.error('[collab] handler error', err)
    }
  }
}

export default function useCollab() {
  /** 启动协作订阅（幂等：已启动则忽略）。缺省订阅平台运行场景（单一真源）。 */
  function start(scenario = ACTIVE_SCENARIO) {
    if (connector) return
    connector = new CollabWsConnector({ scenario, onEvent: _onEvent, onStatus: _onStatus })
    connector.connect()
  }

  /** 停止协作订阅（释放连接）。 */
  function stop() {
    connector?.disconnect()
    connector = null
    connected.value = false
  }

  /** 订阅协作事件；返回取消订阅函数。订阅时会按时间顺序回放已缓冲事件。 */
  function subscribe(handler) {
    _handlers.add(handler)
    for (const e of [...events.value].reverse()) {
      try {
        handler(e)
      } catch (_) {
        /* 回放失败不影响订阅 */
      }
    }
    return () => _handlers.delete(handler)
  }

  return { connected, events, lastEvent, start, stop, subscribe }
}
