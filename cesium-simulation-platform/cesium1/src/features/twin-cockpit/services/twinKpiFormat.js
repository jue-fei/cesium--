/**
 * 驾驶舱展示纯函数（方案 WP5 T5.2 / T5.3）
 *
 * 抽成纯函数的原因：
 *   - 趋势图的坐标计算是数值逻辑，可在 node 环境单测（本项目无 DOM 测试环境）；
 *   - 组件只负责布局与样式，避免"路径算错但看不出来"。
 */

/** 数值格式化：按量级保留小数，避免 0.7750000001 这类噪声 */
export function formatValue(value, unit = '') {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
    const num = Number(value)
    let text
    if (Math.abs(num) >= 10000) text = `${(num / 1000).toFixed(1)}k`
    else if (Math.abs(num) >= 1000) text = num.toFixed(0)
    else if (Math.abs(num) >= 100) text = num.toFixed(1)
    else if (Math.abs(num) >= 1) text = num.toFixed(2)
    else text = num.toFixed(3)
    // 去掉无意义的尾零（1.50 → 1.5，2.00 → 2）；整数（如 1000）不得被误删
    if (text.includes('.')) {
        text = text.replace(/0+$/, '').replace(/\.$/, '')
    }
    return unit ? `${text} ${unit}` : text
}

/**
 * 选出驾驶舱卡片展示的指标：
 * 优先展示有值的自动采集项，manual 项若已有值也保留；最多 limit 张卡。
 */
export function pickDisplayKpis(items = [], limit = 8) {
    const withValue = items.filter(item => item && item.value !== null && item.value !== undefined)
    const auto = withValue.filter(item => item.code && !String(item.source || '').includes('manual'))
    const rest = withValue.filter(item => !auto.includes(item))
    return [...auto, ...rest].slice(0, Math.max(1, limit))
}

/**
 * 生成趋势折线路径（多序列共用一个坐标系）。
 * @param {Array<{code:string, points:Array<{ts:number,value:number}>}>} series
 * @param {{width:number,height:number,padding?:number}} options
 * @returns {{paths:Array<{code:string,d:string,color:string,points:Array}>, min:number, max:number, ticks:Array}}
 */
export function buildTrendPaths(series = [], { width = 320, height = 120, padding = 18 } = {}) {
    const colors = ['#67e8f9', '#a3e635', '#fbbf24']
    const usable = (series || []).filter(
        item => item && Array.isArray(item.points) && item.points.length > 0
    )
    if (usable.length === 0) {
        return { paths: [], min: 0, max: 0, ticks: [] }
    }

    const allPoints = usable.flatMap(item => item.points)
    const values = allPoints.map(p => Number(p.value)).filter(v => Number.isFinite(v))
    if (values.length === 0) {
        return { paths: [], min: 0, max: 0, ticks: [] }
    }

    let min = Math.min(...values)
    let max = Math.max(...values)
    if (min === max) {
        // 单点/常量序列：人为撑开值域，避免除零与贴边
        min -= 1
        max += 1
    }

    const tsValues = allPoints.map(p => Number(p.ts)).filter(v => Number.isFinite(v))
    const tsMin = Math.min(...tsValues)
    const tsMax = Math.max(...tsValues)
    const tsSpan = tsMax - tsMin || 1

    const innerW = width - padding * 2
    const innerH = height - padding * 2
    const span = max - min || 1

    const toXY = point => {
        const x = padding + ((Number(point.ts) - tsMin) / tsSpan) * innerW
        const y = padding + innerH - ((Number(point.value) - min) / span) * innerH
        return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) }
    }

    const paths = usable.map((item, index) => {
        const coords = item.points.map(toXY)
        const d = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
        return {
            code: item.code,
            name: item.name || item.code,
            unit: item.unit || '',
            color: colors[index % colors.length],
            d,
            points: coords
        }
    })

    // 3 条水平参考线（上/中/下）与对应数值标签
    const ticks = [0, 0.5, 1].map(ratio => ({
        y: Number((padding + innerH * ratio).toFixed(2)),
        value: Number((max - span * ratio).toFixed(2))
    }))

    return { paths, min: Number(min.toFixed(2)), max: Number(max.toFixed(2)), ticks }
}

/** 事件类型 → 中文短标签（联动日志用） */
export function formatEventLabel(type = '') {
    const map = {
        'blasting:event:completed': '爆破完成',
        'blasting:zone:changed': '危险区变化',
        'scheduling:tick': '调度推进',
        'optimization:adopted': '方案采纳',
        'fusion:action': '联动动作'
    }
    if (map[type]) return map[type]
    const parts = String(type).split(':')
    return parts.length >= 2 ? `${parts[0]}·${parts[1]}` : String(type)
}
