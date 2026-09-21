import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTimelineBus } from '../timelineController.js'

describe('4D 时间总线 createTimelineBus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const WINDOW = { start: 1000, end: 6000 }

  it('setWindow 后 progress=1（播放头钳在末端），getState 结构完整', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    const s = bus.getState()
    expect(s.start).toBe(1000)
    expect(s.end).toBe(6000)
    expect(s.ts).toBe(6000)
    expect(s.progress).toBe(1)
    expect(s.playing).toBe(false)
  })

  it('seek 钳入窗口并广播', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    const seen = []
    const off = bus.on(s => seen.push(s.ts))
    bus.seek(3000)
    bus.seek(99999)
    expect(seen).toEqual([3000, 6000])
    off()
    bus.seek(2000)
    expect(seen.length).toBe(2) // 退订后不再广播
  })

  it('play 推进播放头、到末端自动停止', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    bus.seek(1000)
    bus.play()
    expect(bus.getState().playing).toBe(true)
    vi.advanceTimersByTime(1000) // 4 tick × 250ms × 1x
    expect(bus.getState().ts).toBe(2000)
    vi.advanceTimersByTime(10000) // 越过末端
    expect(bus.getState().ts).toBe(6000)
    expect(bus.getState().playing).toBe(false) // 到末端自动停
  })

  it('末端再 play 从头播放', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    bus.seek(6000)
    bus.play()
    expect(bus.getState().ts).toBe(1000)
    bus.pause()
  })

  it('speed 加速播放', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    bus.seek(1000)
    bus.setSpeed(4)
    bus.play()
    vi.advanceTimersByTime(1000)
    expect(bus.getState().ts).toBe(5000) // 4 tick × 250ms × 4x = 4000ms
    bus.pause()
  })

  it('setWindow 保持相对进度', () => {
    const bus = createTimelineBus()
    bus.setWindow(0, 1000)
    bus.seek(500) // 50%
    bus.setWindow(0, 2000)
    expect(bus.getState().ts).toBe(1000) // 50% of 2000
  })

  it('订阅者异常不阻断广播', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    bus.on(() => {
      throw new Error('boom')
    })
    const seen = []
    bus.on(s => seen.push(s.ts))
    bus.seek(2000)
    expect(seen).toEqual([2000])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('destroy 后停止时钟并清空订阅', () => {
    const bus = createTimelineBus()
    bus.setWindow(WINDOW.start, WINDOW.end)
    bus.seek(1000)
    const seen = []
    bus.on(s => seen.push(s.ts))
    bus.play()
    bus.destroy()
    const n = seen.length
    vi.advanceTimersByTime(2000)
    expect(seen.length).toBe(n) // 时钟已停
    expect(bus.getState().playing).toBe(false)
  })
})
