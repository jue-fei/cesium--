/**
 * 统一时间轴单测（方案 WP3 T3.1 / T3.2 / T3.6）
 *
 * 只测纯逻辑：rAF 由浏览器提供，这里用 play/advance/pause 显式驱动。
 */
import { describe, expect, it, vi } from 'vitest'

import { CLOCK_MODE, TwinClock } from '../clockService.js'

function makeProvider(range = [0, 100]) {
    const seeks = []
    return {
        seeks,
        getRange: () => range,
        seek: t => seeks.push(t)
    }
}

describe('TwinClock 状态机', () => {
    it('无 provider 时为 idle：不可播放、区间为空', () => {
        const clock = new TwinClock()
        expect(clock.snapshot().mode).toBe(CLOCK_MODE.IDLE)
        expect(clock.getRange()).toBeNull()
        expect(clock.play()).toBe(false)
    })

    it('注册首个 provider 后进入 replay，注销后退回 idle', () => {
        const clock = new TwinClock()
        clock.registerProvider('blasting', makeProvider())
        expect(clock.mode).toBe(CLOCK_MODE.REPLAY)

        clock.unregisterProvider('blasting')
        expect(clock.mode).toBe(CLOCK_MODE.IDLE)
        expect(clock.t).toBe(0)
    })

    it('多 provider 区间取并集', () => {
        const clock = new TwinClock()
        clock.registerProvider('a', makeProvider([10, 20]))
        clock.registerProvider('b', makeProvider([0, 15]))
        expect(clock.getRange()).toEqual([0, 20])
    })
})

describe('TwinClock 推进与寻址', () => {
    it('advance 按速率推进并下发 seek', () => {
        const clock = new TwinClock()
        const provider = makeProvider([0, 100])
        clock.registerProvider('blasting', provider)

        clock.play()
        try {
            clock.advance(2)
            expect(clock.t).toBeCloseTo(2, 6)
            expect(provider.seeks.at(-1)).toBeCloseTo(2, 6)

            clock.setRate(2)
            clock.advance(1)
            expect(clock.t).toBeCloseTo(4, 6)
        } finally {
            clock.pause()
        }
    })

    it('到达上界自动暂停（不空转）', () => {
        const clock = new TwinClock()
        clock.registerProvider('blasting', makeProvider([0, 5]))
        clock.play()
        clock.advance(10)
        expect(clock.t).toBe(5)
        expect(clock.playing).toBe(false)
    })

    it('seek 钳制到区间并同步全部 provider', () => {
        const clock = new TwinClock()
        const a = makeProvider([0, 10])
        const b = makeProvider([0, 10])
        clock.registerProvider('a', a)
        clock.registerProvider('b', b)

        clock.seek(99)
        expect(clock.t).toBe(10)
        expect(a.seeks.at(-1)).toBe(10)
        expect(b.seeks.at(-1)).toBe(10)
    })

    it('直播态禁止 seek', () => {
        const clock = new TwinClock()
        clock.registerProvider('scheduling', makeProvider())
        clock.setMode(CLOCK_MODE.LIVE)
        expect(clock.seek(5)).toBe(false)
    })
})

describe('TwinClock 服务端对齐', () => {
    it('syncWithServer 计算偏斜并记录 epoch', async () => {
        const clock = new TwinClock()
        // 构造“服务端比本地快 2 秒”的真实时间基准，验证偏斜方向与量级
        const serverTime = Date.now() / 1000 + 2
        const fetcher = vi.fn(async () => ({ json: async () => ({ data: { serverTime } }) }))

        const result = await clock.syncWithServer(fetcher)
        expect(result).not.toBeNull()
        expect(result.serverTime).toBe(serverTime)
        expect(clock.epoch).toBe(serverTime)
        expect(clock.skewMs).toBeGreaterThan(1500)
        expect(clock.skewMs).toBeLessThan(2500)
        // 本地“现在”换算到服务端时间应落在 serverTime 附近
        expect(Math.abs(clock.toServerTime(Date.now()) - serverTime * 1000)).toBeLessThan(2500)
    })

    it('fetch 失败返回 null 且不影响原有状态', async () => {
        const clock = new TwinClock()
        clock.registerProvider('a', makeProvider())
        const result = await clock.syncWithServer(async () => {
            throw new Error('network')
        })
        expect(result).toBeNull()
        expect(clock.mode).toBe(CLOCK_MODE.REPLAY)
    })
})

describe('TwinClock 订阅', () => {
    it('状态变化会通知订阅者并携带快照', () => {
        const clock = new TwinClock()
        const seen = []
        const off = clock.subscribe(snapshot => seen.push(snapshot))

        clock.registerProvider('blasting', makeProvider())
        expect(seen.at(-1).providerCount).toBe(1)
        expect(seen.at(-1).mode).toBe(CLOCK_MODE.REPLAY)

        off()
        clock.unregisterProvider('blasting')
        expect(seen.length).toBe(1)
    })
})
