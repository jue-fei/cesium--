/**
 * 孪生状态栏数据（轻量汇总，不参与驾驶舱的趋势计算）
 *
 * 只取三处「一眼可见」的状态，避免与驾驶舱的 useTwinKpi 重复拉趋势：
 *   /api/twin/kpi/latest   自动采集 KPI 最新值
 *   /api/twin/rules        规则启用数与命中数
 *   /api/datasource        数据源台账连通数
 */
import { onMounted, onUnmounted, ref } from 'vue'

const API = {
  latest: '/api/twin/kpi/latest',
  rules: '/api/twin/rules',
  sources: '/api/datasource'
}

async function getJson(url) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export function useTwinGlance({ intervalMs = 10000 } = {}) {
  const kpis = ref([])
  const rules = ref([])
  const sources = ref([])
  const online = ref(false)
  const updatedAt = ref(0)

  let timer = null

  async function refresh() {
    try {
      const [kpi, rule, source] = await Promise.all([
        getJson(API.latest),
        getJson(API.rules),
        getJson(API.sources)
      ])
      kpis.value = kpi?.data?.items || []
      rules.value = rule?.data?.rules || []
      sources.value = source?.data?.sources || []
      online.value = true
      updatedAt.value = Date.now()
    } catch (_) {
      online.value = false
    }
  }

  onMounted(() => {
    refresh()
    timer = setInterval(refresh, Math.max(3000, intervalMs))
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
    timer = null
  })

  return { kpis, rules, sources, online, updatedAt, refresh }
}
