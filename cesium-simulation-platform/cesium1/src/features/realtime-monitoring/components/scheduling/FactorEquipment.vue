<template>
  <div
    class="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
  >
    <div class="flex items-center justify-between mb-3">
      <div
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
      >
        装备性能与能耗 <span class="text-[10px] text-blue-300/70">经济性 · 调度方案</span>
      </div>
      <div class="flex items-center gap-2 text-[11px]">
        <span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
          <template v-if="savePct === null || savePct === undefined">运营成本核算中…</template>
          <template v-else>运营成本节省 {{ savePct }}%（目标 {{ targetPct }}%）</template>
        </span>
      </div>
    </div>

    <div class="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
      <div v-for="e in items" :key="e.id" class="rounded-md border border-white/10 bg-white/5 p-3">
        <div class="flex items-center justify-between">
          <div class="font-medium text-gray-100">
            {{ cnId(e.id) }}
            <span class="text-[10px] text-gray-500 ml-1">{{ e.model }}</span>
          </div>
          <span
            class="px-2 py-0.5 rounded-full text-[10px] font-medium"
            :class="stateClass(e.state)"
          >
            {{ stateText(e.state) }}
          </span>
        </div>

        <div class="grid grid-cols-4 gap-2 mt-2 text-[11px]">
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div class="text-xs font-semibold text-gray-100">
              {{ e.payloadT }}/{{ e.capacityT }}t
            </div>
            <div class="text-[9px] text-gray-500">
              {{ e.loadMode === 'loaded' ? '重载' : '空载' }} · {{ e.speedKmh }}km/h
            </div>
          </div>
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div class="text-xs font-semibold text-emerald-300">{{ e.energyCostRMB }}元</div>
            <div class="text-[9px] text-gray-500">
              {{ e.energyUsed }}{{ e.energyType === 'electric' ? 'kWh' : 'L' }}
            </div>
          </div>
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div
              class="text-xs font-semibold"
              :class="e.health > 0.7 ? 'text-blue-300' : 'text-amber-300'"
            >
              健康 {{ (e.health * 100).toFixed(0) }}%
            </div>
            <div
              class="text-[9px] text-gray-500"
              :class="e.faultRatePerH > 2 ? 'text-red-300' : ''"
            >
              故障率 {{ e.faultRatePerH }}/h
            </div>
          </div>
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div class="text-xs font-semibold text-gray-100">
              {{ (e.posConf * 100).toFixed(0) }}%
            </div>
            <div class="text-[9px] text-gray-500">定位 {{ (e.posErrorM * 100).toFixed(0) }}cm</div>
          </div>
        </div>

        <!-- 派单/路径 -->
        <div
          v-if="onRoute(e.assigned)"
          class="mt-2 rounded bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5 text-[11px]"
        >
          <span class="text-blue-300">调度 → {{ e.assigned.goal || '目标' }}</span>
          <span class="text-gray-200"> {{ e.assigned.target }}</span>
          <span class="text-gray-400 mx-1">·</span>
          <span class="text-gray-300">{{ pathText(e.assigned.path) }}</span>
          <span class="text-gray-400 mx-1">·</span>
          <span class="text-gray-300"
            >{{ e.assigned.timeMin }}min / {{ e.assigned.energyTotal }}能耗</span
          >
          <div class="text-[10px] text-gray-500 mt-0.5">
            危险暴露 {{ e.assigned.hazard }} · {{ e.assigned.reason || '硬约束通过+动态代价最小' }}
            <span v-if="e.assigned.refEnergyTotal" class="text-gray-600">
              · 最近距离盲派基准 {{ e.assigned.refEnergyTotal }}
            </span>
          </div>
        </div>
        <div
          v-else-if="e.assigned && e.assigned.goal === '装载点'"
          class="mt-2 rounded bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          已在装载点 {{ e.assigned.target }} 铲装中
        </div>
        <div
          v-else
          class="mt-2 rounded bg-black/20 border border-white/5 px-2.5 py-1.5 text-[11px] text-gray-500"
        >
          空闲待命，等待派单
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] },
  savePct: { type: [Number, null], default: null },
  targetPct: { type: Number, default: 10 }
})

function stateText(s) {
  const map = { idle: '待命', loading: '铲装', hauling: '运输', dumping: '卸载' }
  return map[s] || s
}
function stateClass(s) {
  const map = {
    idle: 'bg-gray-500/20 text-gray-300',
    loading: 'bg-amber-500/20 text-amber-300',
    hauling: 'bg-blue-500/20 text-blue-300',
    dumping: 'bg-emerald-500/20 text-emerald-300'
  }
  return map[s] || 'bg-white/10 text-gray-300'
}
function pathText(path) {
  const p = path || []
  return p.length ? p.map(cnId).join('→') : '--'
}
function cnId(id) {
  return String(id || '')
    .replace(/^LHD-?/i, '铲运机')
    .replace(/^SEG-?/i, '路段')
}
function onRoute(a) {
  return !!(a && a.path && a.path.length)
}
</script>
