/**
 * 井下铲运机(LHD)现场调度数据服务
 *
 * 消费后端地下巷道调度仿真数据：
 *   - 实时流：WebSocket /ws/scheduling/stream（相对路径，经 Vite 代理到 3003）
 *   - 降级：HTTP轮询 GET /api/scheduling/state
 *
 * 暴露的响应式状态来自快照：schema / factors.hardConstraints
 * / factors.dynamicEnvironment / factors.muckPile / factors.equipment。
 */
import { shallowRef, onUnmounted } from 'vue'

const DEFAULT_POLL_MS = 3000
const MAX_RECONNECT = 6
const RECONNECT_BASE_MS = 1000

export function useScheduling({
  mode = 'websocket',
  pollInterval = DEFAULT_POLL_MS,
  autoStart = true,
  scenario = 'ashale'
} = {}) {
  // 场景化：巷道/装载点/设备等"可替换内容"由后端 config/scenario_<名>.json 驱动，
  // 前端数据流与配置下发统一携带场景参数（缺省 ashale）。
  const WS_URL = `/ws/scheduling/stream?scenario=${encodeURIComponent(scenario)}`
  const HTTP_URL = `/api/scheduling/state?scenario=${encodeURIComponent(scenario)}`
  const RESET_URL = `/api/scheduling/reset?scenario=${encodeURIComponent(scenario)}`
  const ASSIGN_URL = `/api/scheduling/apply_assignment?scenario=${encodeURIComponent(scenario)}`
  const BLASTPILE_URL = `/api/scheduling/blastpile?scenario=${encodeURIComponent(scenario)}`

  function buildWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}${WS_URL}`
  }
  // 顶层快照：完整四类因素 + 装备 + 调度方案
  const snapshot = shallowRef(null)
  const connectionStatus = shallowRef('idle')

  let ws = null
  let pollTimer = null
  let reconnectTimer = null
  let reconnectAttempts = 0

  const statusLabel = {
    idle: '未连接',
    connecting: '连接中',
    connected: '已连接',
    reconnecting: '重连中',
    disconnected: '已断开',
    error: '异常'
  }

  function applySnapshot(data) {
    if (data && data.schema) snapshot.value = data
  }

  function setStatus(s) {
    connectionStatus.value = s
  }

  // ---------- WebSocket 连接 ----------
  function clearPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    if (reconnectAttempts >= MAX_RECONNECT) {
      setStatus('disconnected')
      return
    }
    reconnectAttempts++
    setStatus('reconnecting')
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null
        connectWs()
      },
      RECONNECT_BASE_MS * Math.pow(1.6, reconnectAttempts - 1)
    )
  }

  function connectWs() {
    clearPoll()
    setStatus('connecting')
    try {
      ws = new WebSocket(buildWsUrl())
    } catch (e) {
      setStatus('error')
      startPoll()
      return
    }
    ws.onopen = () => {
      reconnectAttempts = 0
      setStatus('connected')
      // 心跳，避免服务端 60s 超时踢线
      ws._hb = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', t: Date.now() }))
        }
      }, 25000)
    }
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'snapshot' && msg.data) {
          applySnapshot(msg.data)
          reconnectAttempts = 0
          setStatus('connected')
        }
      } catch (e) {
        /* 忽略坏帧 */
      }
    }
    ws.onclose = () => {
      clearWsHeartbeat(ws)
      if (modeRef === 'websocket') scheduleReconnect()
    }
    ws.onerror = () => {
      try {
        ws && ws.close()
      } catch (e) {
        /* noop */
      }
    }
  }

  function clearWsHeartbeat(sock) {
    if (sock && sock._hb) {
      clearInterval(sock._hb)
      sock._hb = null
    }
  }

  // ---------- HTTP 轮询（降级） ----------
  async function pollOnce() {
    try {
      const res = await fetch(HTTP_URL)
      const json = await res.json()
      if (json && json.code === 0 && json.data) {
        applySnapshot(json.data)
        setStatus('connected')
      }
    } catch (e) {
      setStatus('error')
    }
  }

  function startPoll() {
    clearPoll()
    setStatus('connecting')
    pollTimer = setInterval(pollOnce, pollInterval)
    pollOnce()
  }

  // ---------- 生命周期 ----------
  const modeRef = { current: mode }

  function start() {
    if (!autoStart) return
    if (modeRef.current === 'websocket') {
      connectWs()
      // 若长时间未连上则降级为轮询
      window.setTimeout(() => {
        if (connectionStatus.value !== 'connected') {
          stopWs()
          startPoll()
        }
      }, 15000)
    } else {
      startPoll()
    }
  }

  function stopWs() {
    clearWsHeartbeat(ws)
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.close()
      ws = null
    }
  }

  function stop() {
    stopWs()
    clearPoll()
    setStatus('idle')
  }

  function reset() {
    return fetch(RESET_URL, { method: 'POST' })
      .then(r => r.json())
      .then(json => {
        if (json && json.code === 0) applySnapshot(json.data)
      })
      .catch(() => {})
  }

  // ---------- NSGA-III 多目标选解提交 ----------
  /** 提交 NSGA-III 选解（[{equipId, target, path}]），后端 _dispatch 优先消费。 */
  function applyAssignment(assignments) {
    return fetch(ASSIGN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assignments)
    })
      .then(r => r.json())
      .catch(e => ({ code: 1, message: String(e && e.message) }))
  }

  /** 向某装载点注入爆破板块产生的爆堆信息（BlastPileInfo 契约）。 */
  function injectBlastPile(pile) {
    return fetch(BLASTPILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pile)
    })
      .then(r => r.json())
      .catch(e => ({ code: 1, message: String(e && e.message) }))
  }

  function setInterval(seconds) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_interval', seconds }))
    }
    if (modeRef.current === 'http_poll' && seconds >= 0.5) {
      clearPoll()
      pollTimer = setInterval(pollOnce, seconds * 1000)
    }
  }

  onUnmounted(stop)

  if (autoStart) start()

  return {
    snapshot,
    connectionStatus,
    statusLabel,
    mode: modeRef,
    reset,
    setInterval,
    stop,
    start,
    applyAssignment,
    injectBlastPile
  }
}
