<template>
  <div class="rounded-md border border-border-primary/60 bg-bg-secondary/70 p-2">
    <div class="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
      <span v-for="line in view.paths" :key="line.code" class="flex items-center gap-1">
        <i class="inline-block h-2 w-2 rounded-sm" :style="{ backgroundColor: line.color }"></i>
        {{ line.name }}
      </span>
      <span v-if="!view.paths.length">暂无趋势数据</span>
      <span v-else class="ml-auto font-mono">{{ view.min }} ~ {{ view.max }}</span>
    </div>

    <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" class="h-[120px] w-full">
      <line
        v-for="tick in view.ticks"
        :key="`t-${tick.y}`"
        :x1="0"
        :x2="WIDTH"
        :y1="tick.y"
        :y2="tick.y"
        stroke="rgba(255,255,255,0.08)"
        stroke-width="1"
      />
      <path
        v-for="line in view.paths"
        :key="line.code"
        :d="line.d"
        fill="none"
        :stroke="line.color"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'

import { buildTrendPaths } from '../services/twinKpiFormat.js'

const WIDTH = 340
const HEIGHT = 120

const props = defineProps({
  series: { type: Array, default: () => [] }
})

const view = computed(() => buildTrendPaths(props.series, { width: WIDTH, height: HEIGHT }))
</script>
