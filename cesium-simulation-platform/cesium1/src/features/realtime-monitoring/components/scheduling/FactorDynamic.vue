<template>
  <div
    class="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
  >
    <div class="flex items-center justify-between mb-3">
      <div
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-amber-500 before:rounded-sm"
      >
        动态环境与感知 <span class="text-[10px] text-amber-300/70">实时扰动</span>
      </div>
      <div class="flex items-center gap-3 text-[11px] text-gray-400">
        <span class="flex items-center gap-1"
          ><span class="w-2 h-2 rounded-full bg-red-400"></span>堵塞</span
        >
        <span class="flex items-center gap-1"
          ><span class="w-2 h-2 rounded-full bg-amber-400"></span>岩爆</span
        >
        <span class="flex items-center gap-1"
          ><span class="w-2 h-2 rounded-full bg-gray-400"></span>炮烟</span
        >
      </div>
    </div>

    <div class="grid grid-cols-2 gap-2 mb-3">
      <div class="bg-black/20 rounded p-2.5 border border-white/5">
        <div class="text-[10px] text-gray-500 mb-1">
          作业点位定位误差 <span class="text-blue-300">&lt;0.3m</span>
        </div>
        <div
          class="text-base font-semibold"
          :class="(posSpec?.workM ?? 0) <= 0.3 ? 'text-emerald-300' : 'text-red-300'"
        >
          {{ (posSpec?.workM ?? 0).toFixed(2) }}m
        </div>
        <div class="text-[10px] text-gray-500 mt-1">定位置信度 ≧{{ posWorkConf }}%</div>
      </div>
      <div class="bg-black/20 rounded p-2.5 border border-white/5">
        <div class="text-[10px] text-gray-500 mb-1">
          行进定位误差 <span class="text-blue-300">&lt;0.8m</span>
        </div>
        <div
          class="text-base font-semibold"
          :class="(posSpec?.travelM ?? 0) <= 0.8 ? 'text-emerald-300' : 'text-red-300'"
        >
          {{ (posSpec?.travelM ?? 0).toFixed(2) }}m
        </div>
        <div class="text-[10px] text-gray-500 mt-1">炮烟/粉尘导致视距受限→降速</div>
      </div>
    </div>

    <!-- 巷道段动态 -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[26rem] overflow-y-auto pr-1">
      <div
        v-for="s in segs"
        :key="s.id"
        class="rounded-md border px-3 py-2 text-[11px]"
        :class="s.blocked ? 'bg-red-500/10 border-red-500/40' : 'bg-white/5 border-white/10'"
      >
        <div class="flex items-center justify-between">
          <span class="font-medium text-gray-100">{{ cnId(s.id) }}</span>
          <span v-if="s.blocked" class="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300"
            >封 {{ s.blockReason }}</span
          >
          <span
            v-else-if="s.rockburst > ROCKBURST_ALERT_THRESHOLD"
            class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
          >
            岩爆高发
          </span>
          <span v-else class="text-gray-500">{{ s.name }}</span>
        </div>
        <div class="mt-1.5 space-y-1">
          <div :class="'flex items-center gap-1'">
            <span class="w-16 text-gray-500">炮烟{{ smokeLabel(s.smoke) }}</span>
            <div class="flex-1 h-1.5 rounded bg-black/40 overflow-hidden">
              <div
                class="h-full rounded"
                :class="
                  s.smoke > 0.6 ? 'bg-red-400' : s.smoke > 0.3 ? 'bg-amber-400' : 'bg-gray-400'
                "
                :style="{ width: pct(s.smoke) }"
              ></div>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <span class="w-16 text-gray-500">拥堵{{ pctNum(s.congestion) }}</span>
            <div class="flex-1 h-1.5 rounded bg-black/40 overflow-hidden">
              <div
                class="h-full rounded"
                :class="
                  s.congestion > 0.6
                    ? 'bg-red-400'
                    : s.congestion > 0.3
                      ? 'bg-amber-400'
                      : 'bg-gray-400'
                "
                :style="{ width: pct(s.congestion) }"
              ></div>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <span class="w-16 text-gray-500">岩爆{{ pctNum(s.rockburst) }}</span>
            <div class="flex-1 h-1.5 rounded bg-black/40 overflow-hidden">
              <div
                class="h-full rounded"
                :class="s.rockburst > 0.6 ? 'bg-orange-400' : 'bg-yellow-600/50'"
                :style="{ width: pct(s.rockburst) }"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
// 岩爆高发阈值单源：useMultiObjectiveLhdTunnel.js 模块级导出（与 3D 渲染/综合评级同口径）
import { ROCKBURST_ALERT_THRESHOLD } from '../useMultiObjectiveLhdTunnel.js'

const props = defineProps({
  dynamic: { type: Object, default: () => null }
})

const segs = computed(() => props.dynamic?.segments || [])
const posSpec = computed(() => props.dynamic?.posErrorSpec || { workM: 0, travelM: 0 })

const posWorkConf = computed(() =>
  Math.max(0, Math.round((1 - (posSpec.value.workM ?? 0) / 0.3) * 40 + 60))
)

function pct(v) {
  return Math.round(Math.max(0, Math.min(1, v || 0)) * 100) + '%'
}
function pctNum(v) {
  return Math.round((v || 0) * 100) + '%'
}
function smokeLabel(v) {
  const x = v || 0
  return x > 0.6 ? '浓' : x > 0.3 ? '中' : '低'
}
function cnId(id) {
  return String(id || '')
    .replace(/^LHD-?/i, '铲运机')
    .replace(/^SEG-?/i, '路段')
}
</script>
