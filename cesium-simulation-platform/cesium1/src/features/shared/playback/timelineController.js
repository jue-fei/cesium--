/**
 * timelineController.js —— 4D 时间总线（全板块共享回放时钟）
 *
 * 定位：各图层（设备轨迹回放/品位中段推进/将来的应力场历史帧/爆破事件流）
 * 共用一个播放时钟：单一 window + playhead，tick 广播给所有订阅者，实现
 * "拖动时间轴，多图层同步跳转同一时刻"。
 *
 * 现有板块的回放机制通过桥接接入（如设备层 useMonitoring.handleTimelineTimeChange、
 * 品位层 gradeLayerService.setTimelineProgress），不替代板块内部逻辑：
 *   - 设备层：dataEngine.getTruckStateAtTime + isHistoricalPlayback（已有）
 *   - 爆破层：服务端事件流自带 seek（保持零回归，暂不并入）
 *
 * 纯逻辑无框架依赖；createTimelineBus 供测试实例化，默认用单例 timelineBus。
 */

/** 播放头推进周期（ms）：250ms 一 tick，足够顺滑且开销可忽略 */
export const TICK_MS = 250

export function createTimelineBus({ tickMs = TICK_MS } = {}) {
  let start = 0
  let end = 0
  let ts = 0
  let speed = 1
  let playing = false
  let timer = null
  const subscribers = new Set()

  function clamp(t) {
    if (end <= start) return start
    return Math.min(end, Math.max(start, t))
  }

  function getState() {
    const span = end - start
    const clamped = clamp(ts)
    return {
      start,
      end,
      ts: clamped,
      speed,
      playing,
      progress: span > 0 ? (clamped - start) / span : 0
    }
  }

  function publish() {
    const state = getState()
    subscribers.forEach(fn => {
      try {
        fn(state)
      } catch (e) {
        // 订阅者异常不阻断广播（图层渲染失败不能拖垮时钟）
        console.error('[TimelineBus] 订阅者异常', e)
      }
    })
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function play() {
    if (playing || end <= start) return
    if (ts >= end) ts = start // 播放头在末端 → 从头播放
    playing = true
    timer = setInterval(() => {
      ts += tickMs * speed
      if (ts >= end) {
        ts = end
        playing = false
        stopTimer()
      }
      publish()
    }, tickMs)
    publish()
  }

  function pause() {
    playing = false
    stopTimer()
    publish()
  }

  function seek(t) {
    ts = clamp(t)
    publish()
  }

  /** 设置时间窗口（ms epoch）；播放头钳入新窗口。窗口变化时保持相对进度。 */
  function setWindow(newStart, newEnd) {
    if (!(newEnd > newStart)) return
    const prevSpan = end - start
    const ratio = prevSpan > 0 ? (clamp(ts) - start) / prevSpan : 1
    start = newStart
    end = newEnd
    ts = start + ratio * (end - start)
    publish()
  }

  function setSpeed(v) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) speed = n
    publish()
  }

  /** 订阅 tick；返回退订函数。 */
  function on(fn) {
    if (typeof fn !== 'function') return () => {}
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function destroy() {
    stopTimer()
    playing = false
    subscribers.clear()
  }

  return { play, pause, seek, setWindow, setSpeed, on, getState, destroy }
}

/** 全局单例：所有图层与控制条绑定同一时钟 */
export const timelineBus = createTimelineBus()

export default timelineBus
