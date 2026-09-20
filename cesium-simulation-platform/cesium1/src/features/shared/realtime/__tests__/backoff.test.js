import { describe, expect, it } from 'vitest'
import { computeBackoffMs } from '../backoff.js'

describe('WS 重连退避策略（全库单源）', () => {
  it('指数退避：1s 起步倍增，封顶 8s', () => {
    expect(computeBackoffMs(1)).toBe(1000)
    expect(computeBackoffMs(2)).toBe(2000)
    expect(computeBackoffMs(3)).toBe(4000)
    expect(computeBackoffMs(4)).toBe(8000)
    expect(computeBackoffMs(5)).toBe(8000)
    expect(computeBackoffMs(99)).toBe(8000)
  })

  it('自定义基值与封顶', () => {
    expect(computeBackoffMs(2, { baseMs: 300, capMs: 900 })).toBe(600)
    expect(computeBackoffMs(5, { baseMs: 300, capMs: 900 })).toBe(900)
  })

  it('非法输入回退第一次', () => {
    expect(computeBackoffMs(0)).toBe(1000)
    expect(computeBackoffMs(-3)).toBe(1000)
    expect(computeBackoffMs(NaN)).toBe(1000)
  })
})
