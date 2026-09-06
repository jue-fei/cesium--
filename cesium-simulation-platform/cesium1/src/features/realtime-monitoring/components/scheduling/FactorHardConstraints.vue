<template>
  <div
    class="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
  >
    <div class="flex items-center justify-between mb-3">
      <div
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-orange-500 before:rounded-sm"
      >
        巷道物理通过性 <span class="text-[10px] text-orange-300/70">硬约束</span>
      </div>
      <div class="flex items-center gap-2 text-[11px]">
        <span class="text-orange-300">禁行 {{ blockedCount(segments) }}</span>
        <span class="text-gray-400">净宽/净高 / 坡度 / 转弯半径</span>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
      <div
        v-for="seg in segments"
        :key="seg.id"
        class="rounded-md border px-3 py-2 text-xs transition-colors"
        :class="
          seg.passableLoaded
            ? 'bg-white/5 border-white/10 hover:bg-white/10'
            : 'bg-red-500/10 border-red-500/30'
        "
      >
        <div class="flex items-center justify-between">
          <div class="font-medium text-gray-100">
            {{ cnId(seg.id) }}
            <span class="text-[10px] text-gray-500 ml-1">{{ seg.name }}</span>
          </div>
          <span
            class="px-2 py-0.5 rounded-full text-[10px] font-medium"
            :class="
              seg.passableLoaded
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-red-500/20 text-red-300'
            "
          >
            {{ seg.passableLoaded ? '重载可通' : '重载禁行' }}
          </span>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-gray-400">
          <span
            >净宽
            <b :class="seg.clearWidthM <= 3.0 ? 'text-red-300' : 'text-gray-200'"
              >{{ seg.clearWidthM }}m</b
            ></span
          >
          <span
            >净高 <b class="text-gray-200">{{ seg.clearHeightM }}m</b></span
          >
          <span
            >坡度 <b class="text-gray-200">{{ seg.maxGradePct }}%</b></span
          >
          <span
            >弯径 <b class="text-gray-200">{{ seg.minTurnRadiusM }}m</b></span
          >
          <span
            >长 <b class="text-gray-200">{{ seg.lengthM }}m</b></span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  segments: { type: Array, default: () => [] }
})

function blockedCount(segs) {
  return segs.filter(s => !s.passableLoaded).length
}
function cnId(id) {
  return String(id || '')
    .replace(/^LHD-?/i, '铲运机')
    .replace(/^SEG-?/i, '路段')
}
</script>
