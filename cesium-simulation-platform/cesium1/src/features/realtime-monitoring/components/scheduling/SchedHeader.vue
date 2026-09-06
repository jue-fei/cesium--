<template>
  <div
    class="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-cyan-400/30"
  >
    <div class="flex items-center justify-between mb-3">
      <div
        class="text-sm font-semibold text-cyan-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-cyan-500 before:rounded-sm before:shadow-[0_0_6px_rgba(34,211,238,0.7)]"
      >
        实时概览
      </div>
      <div class="flex items-center gap-2">
        <span
          class="px-2.5 py-1 rounded-full text-[11px] font-medium flex items-center gap-1.5"
          :class="connClass"
        >
          <span class="w-1.5 h-1.5 rounded-full" :class="connDot"></span>
          {{ statusText }}
        </span>
        <button
          class="px-2.5 py-1 rounded bg-white/5 border border-white/10 text-[11px] text-gray-300 hover:bg-white/10 transition-all"
          title="重置仿真"
          @click="$emit('reset')"
        >
          ↻ 重置
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3">
      <div class="bg-black/20 rounded p-2.5 border border-white/5 min-h-[64px]">
        <div class="text-[10px] text-gray-500 mb-1">场景 · 工程背景</div>
        <div class="text-[13px] text-gray-100 font-semibold truncate" :title="scenarioName">
          {{ scenarioName }}
        </div>
        <div class="text-[10px] text-gray-400 mt-1 truncate" :title="engine">{{ engine }}</div>
      </div>
      <div class="bg-black/20 rounded p-2.5 border border-white/5 min-h-[64px]">
        <div class="text-[10px] text-gray-500 mb-1">模拟时间</div>
        <div class="text-[15px] text-gray-100 font-semibold">{{ simMinutes }}</div>
        <div class="text-[10px] text-gray-400 mt-1">运行号 {{ runIdShort }}</div>
      </div>
      <div class="bg-black/20 rounded p-2.5 border border-white/5 min-h-[64px]">
        <div class="text-[10px] text-gray-500 mb-1">运营成本优化</div>
        <div class="text-base font-semibold leading-tight" :class="opexClass">
          <template v-if="opexSavePct === '--'">核算中…</template>
          <template v-else>−{{ opexSavePct }}%</template>
        </div>
        <div class="text-[10px] text-gray-400 mt-1">目标 −{{ opexTargetPct }}%</div>
      </div>
      <div class="bg-black/20 rounded p-2.5 border border-white/5 min-h-[64px]">
        <div class="text-[10px] text-gray-500 mb-1">作业装备</div>
        <div class="text-base font-semibold text-gray-100 leading-tight">
          {{ equipOnline }} 在役
        </div>
        <div class="text-[10px] text-gray-400 mt-1">{{ equipCount }} 台铲运机</div>
      </div>
    </div>

    <div
      class="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 px-3 py-2 rounded bg-blue-500/10 border border-blue-500/20 text-[11px] text-gray-300"
    >
      <span class="text-gray-400">项目指标要求</span>
      <span class="px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">定位误差&lt;0.3m</span>
      <span class="px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">行进定位&lt;0.8m</span>
      <span class="px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">&gt;10cm 块度识别≥90%</span>
      <span class="px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">岩爆偏差≤5m</span>
      <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">运营成本降低10%</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  schema: { type: Object, default: () => null },
  equipment: { type: Array, default: () => [] },
  opexSavePct: { type: [Number, null], default: null },
  opexTargetPct: { type: Number, default: 10 },
  connectionStatus: { type: String, default: 'idle' }
})
defineEmits(['reset'])

const scenario = computed(() => props.schema?.scenario || '--')
const engine = computed(() => props.schema?.engine || '')
// 场景 id → 可读名称（避免直接展示长原始 id）；未知 id 智能截断美化
const SCENARIO_NAMES = {
  'underground-LHD-ashale': '页岩巷道矿 · 小型',
  'underground-LHD-large-mine': '大型矿 · 多中段多采场'
}
const scenarioName = computed(() => {
  const id = scenario.value
  if (!id || id === '--') return '--'
  if (SCENARIO_NAMES[id]) return SCENARIO_NAMES[id]
  const pretty = id
    .replace(/^underground-LHD-/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return pretty || id
})
const runIdShort = computed(() => {
  const id = props.schema?.runId || ''
  return id.length > 6 ? id.slice(-6) : id || '--'
})
const simMinutes = computed(() => {
  const sec = props.schema?.simTimeSec || 0
  return `${Math.floor(sec / 60)}分${Math.round(sec % 60)}s`
})
const equipCount = computed(() => props.equipment.length)
const equipOnline = computed(() => props.equipment.length)

const opexSavePct = computed(() =>
  props.opexSavePct == null ? '--' : Math.max(0, Math.round(props.opexSavePct))
)
const opexClass = computed(
  () =>
    (Number(opexSavePct.value) >= props.opexTargetPct ? 'text-emerald-300' : 'text-blue-300') +
    ' leading-none'
)

const statusMap = {
  connected: {
    cls: 'bg-green-500/20 text-green-400 border border-green-500/30',
    dot: 'bg-green-400'
  },
  connecting: {
    cls: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    dot: 'bg-yellow-400 animate-pulse'
  },
  reconnecting: {
    cls: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
    dot: 'bg-orange-400 animate-pulse'
  },
  disconnected: { cls: 'bg-red-500/20 text-red-400 border border-red-500/30', dot: 'bg-red-400' },
  error: { cls: 'bg-red-500/20 text-red-400 border border-red-500/30', dot: 'bg-red-400' },
  idle: { cls: 'bg-gray-500/20 text-gray-400 border border-gray-500/30', dot: 'bg-gray-400' }
}
const statusLabel = {
  connected: '实时已连',
  connecting: '连接中',
  reconnecting: '重连中',
  disconnected: '已断开',
  error: '轮询降级',
  idle: '未连接'
}
const connClass = computed(() => statusMap[props.connectionStatus]?.cls || statusMap.idle.cls)
const connDot = computed(() => statusMap[props.connectionStatus]?.dot || statusMap.idle.dot)
const statusText = computed(() => statusLabel[props.connectionStatus] || props.connectionStatus)
</script>
