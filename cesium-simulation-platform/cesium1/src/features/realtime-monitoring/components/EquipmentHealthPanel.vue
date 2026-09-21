<template>
  <div
    class="bg-white/5 rounded-lg border border-white/5 transition-all duration-300"
    :class="expanded ? 'p-4' : 'px-4 py-3 cursor-pointer hover:border-blue-400/30'"
    @click="!expanded && (expanded = true)"
  >
    <!-- 折叠头：概要 -->
    <div class="flex items-center justify-between" :class="{ 'mb-3': expanded }">
      <div class="flex items-center gap-2">
        <span
          class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
          >设备健康</span
        >
        <span v-if="fleet" class="text-[10px] text-gray-400 font-mono">
          均分 {{ fleet.avgScore }} · 告警 {{ fleet.alarmCount }} · 关注 {{ fleet.watchCount }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="source === 'simulated'"
          class="text-[10px] px-1.5 py-0.5 rounded-full text-yellow-300 bg-yellow-400/10 border border-yellow-400/30"
        >
          仿真数据源
        </span>
        <button
          class="text-[10px] text-gray-400 hover:text-blue-200 px-1.5 py-0.5 rounded border border-white/10"
          @click.stop="expanded = !expanded"
        >
          {{ expanded ? '收起' : '展开' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="text-[10px] text-red-400">{{ error }}</div>
    <div v-else-if="loading && !frame" class="text-[10px] text-gray-500">健康数据加载中…</div>

    <template v-if="expanded && frame">
      <!-- 设备列表：健康分条 + 等级 + 告警 -->
      <div class="flex flex-col gap-1.5 mb-3">
        <button
          v-for="e in frame.equipment"
          :key="e.equipId"
          class="w-full text-left bg-white/5 border border-white/10 rounded-md px-2.5 py-2 transition-colors hover:border-blue-400/30"
          :class="selectedId === e.equipId ? 'border-blue-400/50' : ''"
          @click="selectDevice(e.equipId)"
        >
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs text-gray-200 font-mono">{{ e.equipId }}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded-full" :style="levelChipStyle(e.level)">{{
              LEVEL_LABELS[e.level]
            }}</span>
            <span class="text-[10px] text-gray-500">{{ e.state }}</span>
            <span class="ml-auto text-xs font-mono" :style="{ color: levelColor(e.level) }">
              {{ e.score }}
            </span>
          </div>
          <div class="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-500"
              :style="{ width: `${e.score}%`, background: levelColor(e.level) }"
            />
          </div>
          <div v-if="e.alerts.length" class="mt-1 flex flex-wrap gap-1">
            <span
              v-for="a in e.alerts"
              :key="a.code"
              class="text-[10px] px-1.5 py-0.5 rounded text-red-300 bg-red-500/10 border border-red-400/20"
              :title="a.message"
              >{{ a.message }}</span
            >
          </div>
        </button>
      </div>

      <!-- 健康分趋势（2.1 时序层：equipment.health 指标） -->
      <div v-if="selectedId" class="border-t border-white/5 pt-2">
        <div class="text-[10px] text-gray-400 mb-1">
          健康分趋势 · <span class="font-mono text-gray-300">{{ selectedId }}</span>
          <span class="ml-2 text-gray-600">（时序指标 equipment.health）</span>
        </div>
        <svg viewBox="0 0 200 40" class="w-full h-10" preserveAspectRatio="none">
          <polyline
            :points="sparklinePoints"
            fill="none"
            :stroke="selectedColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </svg>
        <div v-if="!trend.length" class="text-[10px] text-gray-600">
          暂无历史点（面板开启期间按轮询持续积累）
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * EquipmentHealthPanel.vue —— 设备健康面板（2.3）
 *
 * 数据链路：GET /api/equipment/health（5s 轮询，健康分模型后端单源，
 * 阈值契约 baseline#equipmentHealthCmps 与前端 monitoringAlerts 同源）
 * → 设备列表（健康分条/分级/告警明细）→ 选中设备健康分趋势
 * （GET /api/timeseries?metric=equipment.health，2.1 时序层联动）。
 */
defineOptions({ name: 'EquipmentHealthPanel' })
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchTimeseries } from '../../shared/services/timeSeriesClient.js'

const POLL_MS = 5000
const LEVEL_LABELS = { normal: '正常', watch: '关注', alarm: '告警' }
const LEVEL_COLORS = { normal: '#34d399', watch: '#f59e0b', alarm: '#ef4444' }

const expanded = ref(false)
const loading = ref(true)
const error = ref('')
const frame = ref(null)
const selectedId = ref('')
const trend = ref([])

let pollTimer = null
const source = computed(() => frame.value?.source ?? null)
const fleet = computed(() => frame.value?.fleet ?? null)
const selectedColor = computed(() => {
  const e = frame.value?.equipment?.find(x => x.equipId === selectedId.value)
  return e ? levelColor(e.level) : '#38bdf8'
})

function levelColor(level) {
  return LEVEL_COLORS[level] ?? '#9ca3af'
}
function levelChipStyle(level) {
  const c = levelColor(level)
  return { color: c, background: `${c}1a`, border: `1px solid ${c}44` }
}

const sparklinePoints = computed(() => {
  if (trend.value.length < 2) return ''
  const pts = trend.value.slice(-60)
  const min = 0
  const max = 100
  return pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * 200
      const y = 38 - ((p.v - min) / (max - min)) * 36 - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

async function refresh() {
  try {
    const res = await fetch('/api/equipment/health')
    const json = await res.json()
    if (json?.code !== 0 || !json.data) throw new Error(json?.message || '健康帧响应为空')
    frame.value = json.data
    error.value = ''
    if (!selectedId.value && frame.value.equipment.length) {
      selectDevice(frame.value.equipment[0].equipId)
    } else if (selectedId.value) {
      loadTrend(selectedId.value)
    }
  } catch (e) {
    error.value = e.message || String(e)
  } finally {
    loading.value = false
  }
}

async function loadTrend(equipId) {
  try {
    const json = await fetchTimeseries({
      metric: 'equipment.health',
      tags: `equipId=${equipId}`,
      downsample: 'raw'
    })
    if (json?.code === 0) trend.value = json.data.points
  } catch {
    /* 趋势查询失败不阻塞面板 */
  }
}

function selectDevice(equipId) {
  selectedId.value = equipId
  trend.value = []
  loadTrend(equipId)
}

onMounted(() => {
  refresh()
  pollTimer = setInterval(refresh, POLL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
})
</script>
