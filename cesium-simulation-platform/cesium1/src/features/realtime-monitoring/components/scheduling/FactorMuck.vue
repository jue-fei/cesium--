<template>
  <div
    class="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
  >
    <div class="flex items-center justify-between mb-3">
      <div
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-stone-400 before:rounded-sm"
      >
        采矿区任务 <span class="text-[10px] text-stone-300/70">作业对象 · 工作量可后端编辑</span>
      </div>
      <div class="text-[11px] text-gray-400">块度识别 ≥{{ recognitionReq * 100 }}%（&gt;10cm）</div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[28rem] overflow-y-auto pr-1">
      <div v-for="p in points" :key="p.id" class="rounded-md border border-white/10 bg-white/5 p-3">
        <div class="flex items-center justify-between">
          <div class="font-medium text-gray-100">
            {{ p.zone }} ({{ p.id }})
            <span class="text-[10px] text-gray-500 ml-1">{{ p.gantry }}</span>
          </div>
          <div class="flex items-center gap-1">
            <span v-if="p.blastCycle" class="text-[10px] text-gray-500">{{ p.blastCycle }}</span>
            <span class="text-[9px] px-1.5 py-0.5 rounded" :class="sourceCls(p.source)">{{
              sourceLabel(p.source)
            }}</span>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-2 mt-2 text-[11px]">
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div class="text-xs font-semibold text-gray-100">{{ p.requiredWorkT }}t</div>
            <div class="text-[9px] text-gray-500">需采矿工作量</div>
          </div>
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div
              class="text-xs font-semibold"
              :class="p.remainingWorkT > 0 ? 'text-gray-100' : 'text-red-300'"
            >
              {{ p.remainingWorkT }}t
            </div>
            <div class="text-[9px] text-gray-500">剩余工作量</div>
          </div>
          <div class="bg-black/20 rounded p-1.5 text-center">
            <div
              class="text-xs font-semibold"
              :class="p.bigBlockRatio > 5 ? 'text-amber-300' : 'text-gray-100'"
            >
              {{ p.bigBlockRatio }}%
            </div>
            <div class="text-[9px] text-gray-500">大块率</div>
          </div>
        </div>

        <div class="mt-2 flex items-center justify-between text-[10px] text-gray-500">
          <span>{{ p.shape }}</span>
          <span>品位 {{ p.gradePct }}%Cu · 铲装 {{ p.muckingEffortMin_perT }}min/t</span>
        </div>

        <!-- 块度特征（可来自爆破板块反哺） -->
        <div class="mt-2 grid grid-cols-4 gap-1 text-center">
          <div class="bg-black/20 rounded p-1">
            <div class="text-[10px] font-semibold text-gray-100">{{ fmtFrag(p.fragX50M) }}</div>
            <div class="text-[8px] text-gray-500">x50</div>
          </div>
          <div class="bg-black/20 rounded p-1">
            <div class="text-[10px] font-semibold text-gray-100">{{ fmtFrag(p.fragX80M) }}</div>
            <div class="text-[8px] text-gray-500">x80</div>
          </div>
          <div class="bg-black/20 rounded p-1">
            <div class="text-[10px] font-semibold text-gray-100">{{ fmtFrag(p.fragXmaxM) }}</div>
            <div class="text-[8px] text-gray-500">xmax</div>
          </div>
          <div class="bg-black/20 rounded p-1">
            <div class="text-[10px] font-semibold text-gray-100">{{ p.fragN }}</div>
            <div class="text-[8px] text-gray-500">n(均匀)</div>
          </div>
        </div>

        <!-- 块度分布 -->
        <div class="mt-2">
          <div class="text-[10px] text-gray-500 mb-1">块度分布</div>
          <div class="flex h-2.5 rounded overflow-hidden">
            <div
              v-for="(h, i) in p.sizeHist"
              :key="i"
              class="h-full"
              :style="{ width: h.pct + '%', background: histColor(i) }"
            ></div>
          </div>
          <div class="flex justify-between text-[9px] text-gray-500 mt-0.5">
            <span v-for="(h, i) in p.sizeHist" :key="'l' + i">{{ h.range }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  points: { type: Array, default: () => [] },
  recognitionReq: { type: Number, default: 0.9 }
})

const HIST_COLORS = ['#94a3b8', '#4ade80', '#facc15', '#fb923c', '#f87171']
function histColor(i) {
  return HIST_COLORS[i % HIST_COLORS.length]
}

// 数据来源：爆破板块反哺 / 手动编辑 / 场景兜底
function sourceLabel(src) {
  return { blasting: '爆破反哺', manual: '人工编辑', scenario: '场景兜底' }[src] || src || '—'
}
function sourceCls(src) {
  if (src === 'blasting') return 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
  if (src === 'manual') return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
  return 'bg-stone-500/20 text-stone-300 border border-stone-500/30'
}
function fmtFrag(v) {
  return v == null || !(v > 0) ? '—' : `${Number(v).toFixed(2)}m`
}
</script>
