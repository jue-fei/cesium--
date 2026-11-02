/**
 * 驾驶舱数据服务（方案 WP5 T5.2 / T5.3 / T2.6）
 *
 * 数据来源全部走后端孪生接口，不在前端做业务计算：
 *   /api/twin/kpi/defs      KPI 字典（补 source，用于区分自动/人工项）
 *   /api/twin/kpi/latest    卡片最新值
 *   /api/twin/kpi           趋势分桶序列
 *   /api/twin/rules         规则清单与命中统计（联动可观测）
 *   /api/twin/events        最近事件（联动日志）
 */
import { onMounted, onUnmounted, ref } from 'vue'

import { formatEventLabel } from './twinKpiFormat.js'

const API = {
    defs: '/api/twin/kpi/defs',
    latest: '/api/twin/kpi/latest',
    series: '/api/twin/kpi',
    rules: '/api/twin/rules',
    events: '/api/twin/events'
}

async function getJson(url) {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
}

export function useTwinKpi({ intervalMs = 5000, minutes = 60, step = 60 } = {}) {
    const defs = ref([])
    const latest = ref([])
    const series = ref([])
    const rules = ref([])
    const events = ref([])
    const loading = ref(false)
    const degraded = ref(false)
    const updatedAt = ref(0)
    const error = ref('')

    let timer = null
    // 趋势回看窗口：1h / 24h / 7d 由驾驶舱切换，服务端 minutes 支持 1..10080
    let viewMinutes = minutes
    let viewStep = step

    async function refresh() {
        loading.value = true
        error.value = ''
        try {
            const [d, l, r, e] = await Promise.all([
                getJson(API.defs),
                getJson(API.latest),
                getJson(API.rules),
                getJson(`${API.events}?limit=20`)
            ])

            defs.value = d?.data?.defs || []
            // 字典优先：12 项 KPI 即使暂无采样也要出现在卡片区（显示 —，不造数）
            const items = l?.data?.items || []
            const byCode = new Map(items.map(item => [item.code, item]))
            const merged = defs.value.map(def => {
                const hit = byCode.get(def.code)
                return {
                    code: def.code,
                    name: def.name,
                    unit: def.unit,
                    proc: def.proc,
                    value: hit ? hit.value : null,
                    ts: hit ? hit.ts : null,
                    source: def.source || ''
                }
            })
            const unknown = items.filter(
                item => !defs.value.some(def => def.code === item.code)
            )
            latest.value = [...merged, ...unknown]
            degraded.value = Boolean(l?.data?.degraded)

            rules.value = r?.data?.rules || []
            events.value = (e?.data?.events || [])
                .slice(-20)
                .reverse()
                .map(ev => ({ ...ev, label: formatEventLabel(ev.type) }))

            updatedAt.value = Date.now()
        } catch (err) {
            error.value = String((err && err.message) || err)
        } finally {
            loading.value = false
        }
    }

    /** 拉取指定指标的趋势（缺省取前两个自动采集项，避免图上线太多） */
    async function refreshSeries(codes) {
        const selected =
            Array.isArray(codes) && codes.length
                ? codes
                : defs.value
                    .filter(item => String(item.source || '').startsWith('auto:'))
                    .slice(0, 2)
                    .map(item => item.code)
        if (!selected.length) {
            series.value = []
            return
        }
        try {
            const resp = await getJson(
                `${API.series}?codes=${encodeURIComponent(selected.join(','))}&minutes=${viewMinutes}&step=${viewStep}`
            )
            series.value = resp?.data?.series || []
            degraded.value = degraded.value || Boolean(resp?.data?.degraded)
        } catch (err) {
            error.value = String((err && err.message) || err)
            series.value = []
        }
    }

    /** 切换趋势档位（分钟数 + 分桶步长），立即重取序列 */
    function setRange(nextMinutes, nextStep) {
        viewMinutes = Math.max(1, Number(nextMinutes) || viewMinutes)
        viewStep = Math.max(5, Number(nextStep) || viewStep)
        return refreshSeries()
    }

    function start() {
        stop()
        refresh().then(() => refreshSeries())
        timer = setInterval(
            () => {
                refresh().then(() => refreshSeries())
            },
            Math.max(2000, intervalMs)
        )
    }

    function stop() {
        if (timer) {
            clearInterval(timer)
            timer = null
        }
    }

    onMounted(start)
    onUnmounted(stop)

    return {
        defs,
        latest,
        series,
        rules,
        events,
        loading,
        degraded,
        updatedAt,
        error,
        refresh,
        refreshSeries,
        setRange,
        start,
        stop
    }
}
