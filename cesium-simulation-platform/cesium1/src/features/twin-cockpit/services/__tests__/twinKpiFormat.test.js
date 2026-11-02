/**
 * 驾驶舱展示纯函数单测（方案 WP5 T5.2 / T5.3）
 *
 * 重点防回归：
 *   - formatValue 曾把整数 1000 误删成 1（尾零正则吃掉了整数零）；
 *   - buildTrendPaths 在单点/常量序列下不得除零或贴边。
 */
import { describe, expect, it } from 'vitest'

import {
    buildTrendPaths,
    formatEventLabel,
    formatValue,
    pickDisplayKpis
} from '../twinKpiFormat.js'

describe('formatValue', () => {
    it('按量级保留有效小数', () => {
        expect(formatValue(0.775)).toBe('0.775')
        expect(formatValue(1.5)).toBe('1.5')
        expect(formatValue(42.256)).toBe('42.26')
        expect(formatValue(1510)).toBe('1510')
        expect(formatValue(12345)).toBe('12.3k')
    })

    it('整数尾零不得被误删', () => {
        expect(formatValue(1000)).toBe('1000')
        expect(formatValue(200)).toBe('200')
        expect(formatValue(10)).toBe('10')
    })

    it('空值返回占位符，单位拼接正确', () => {
        expect(formatValue(null)).toBe('—')
        expect(formatValue(undefined)).toBe('—')
        expect(formatValue(Number.NaN)).toBe('—')
        expect(formatValue(100, '%')).toBe('100 %')
    })
})

describe('pickDisplayKpis', () => {
    it('过滤无值项，自动采集项优先', () => {
        const items = [
            { code: 'a', value: null, source: 'auto:scheduling' },
            { code: 'b', value: 1, source: 'manual' },
            { code: 'c', value: 2, source: 'auto:scheduling' }
        ]
        const picked = pickDisplayKpis(items, 8)
        expect(picked.map(i => i.code)).toEqual(['c', 'b'])
    })

    it('限制卡片数量', () => {
        const items = Array.from({ length: 12 }, (_, i) => ({
            code: `k${i}`,
            value: i,
            source: 'auto:scheduling'
        }))
        expect(pickDisplayKpis(items, 8)).toHaveLength(8)
    })
})

describe('buildTrendPaths', () => {
    it('空序列返回空路径', () => {
        expect(buildTrendPaths([])).toEqual({ paths: [], min: 0, max: 0, ticks: [] })
        expect(buildTrendPaths([{ code: 'a', points: [] }]).paths).toEqual([])
    })

    it('单点序列撑开值域并生成 M 开头路径', () => {
        const view = buildTrendPaths([{ code: 'a', name: 'A', points: [{ ts: 100, value: 5 }] }])
        expect(view.paths).toHaveLength(1)
        expect(view.paths[0].d.startsWith('M')).toBe(true)
        expect(view.max).toBeGreaterThan(view.min)
        expect(view.ticks).toHaveLength(3)
    })

    it('多点序列按时间与值域映射坐标', () => {
        const view = buildTrendPaths(
            [
                {
                    code: 'a',
                    name: 'A',
                    points: [
                        { ts: 0, value: 10 },
                        { ts: 60, value: 20 }
                    ]
                }
            ],
            { width: 320, height: 120, padding: 18 }
        )
        const points = view.paths[0].points
        // 第一个点在最左，第二个点在最右；值大的点更靠上（y 更小）
        expect(points[0].x).toBe(18)
        expect(points[1].x).toBe(302)
        expect(points[0].y).toBeGreaterThan(points[1].y)
    })

    it('多序列共用坐标系且颜色不同', () => {
        const view = buildTrendPaths([
            {
                code: 'a',
                points: [
                    { ts: 0, value: 1 },
                    { ts: 60, value: 2 }
                ]
            },
            {
                code: 'b',
                points: [
                    { ts: 0, value: 3 },
                    { ts: 60, value: 4 }
                ]
            }
        ])
        expect(view.paths).toHaveLength(2)
        expect(view.paths[0].color).not.toBe(view.paths[1].color)
    })
})

describe('formatEventLabel', () => {
    it('已知事件映射为中文短标签', () => {
        expect(formatEventLabel('blasting:event:completed')).toBe('爆破完成')
        expect(formatEventLabel('fusion:action')).toBe('联动动作')
    })

    it('未知事件退化为 工序·对象', () => {
        expect(formatEventLabel('geology:boreholes:loaded')).toBe('geology·boreholes')
        expect(formatEventLabel('lonely')).toBe('lonely')
    })
})
