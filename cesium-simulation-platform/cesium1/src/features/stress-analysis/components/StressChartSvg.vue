<template>
  <svg
    :viewBox="`0 0 ${view.width} ${view.height}`"
    :class="isLarge ? 'w-full h-[80vh]' : 'w-full h-[220px]'"
  >
    <path :d="view.gridPath" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
    <path
      :d="view.axisPath"
      fill="none"
      :stroke="isLarge ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.38)'"
      stroke-width="1.2"
    />
    <path :d="view.linePath" fill="none" stroke="#4caf50" :stroke-width="isLarge ? '2.4' : '2.2'" />
    <circle
      v-for="(p, idx) in view.points"
      :key="`point-${idx}`"
      :cx="p.x"
      :cy="p.y"
      :r="isLarge ? 2.4 : 2"
      fill="#b6ff66"
    />
    <text
      :x="isLarge ? 10 : 8"
      :y="isLarge ? 22 : 18"
      :font-size="isLarge ? 18 : 12"
      fill="rgba(255,255,255,0.68)"
    >
      {{ title }}
    </text>
    <text
      v-for="(t, idx) in view.xTicks"
      :key="`xt-${idx}`"
      :x="t.x"
      :y="view.height - (isLarge ? 10 : 8)"
      :font-size="isLarge ? 16 : 11"
      text-anchor="middle"
      :fill="isLarge ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.66)'"
    >
      {{ t.label }}
    </text>
    <text
      v-for="(t, idx) in view.yTicks"
      :key="`yt-${idx}`"
      :x="isLarge ? 8 : 6"
      :y="t.y + 4"
      :font-size="isLarge ? 16 : 11"
      :fill="isLarge ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.66)'"
    >
      {{ t.label }}
    </text>
    <text
      :x="view.width - (isLarge ? 10 : 8)"
      :y="view.height - (isLarge ? 10 : 8)"
      :font-size="isLarge ? 16 : 11"
      text-anchor="end"
      :fill="isLarge ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.76)'"
    >
      {{ xLabel }}
    </text>
    <text
      :x="isLarge ? 12 : 10"
      :y="isLarge ? 38 : 30"
      :font-size="isLarge ? 16 : 11"
      :fill="isLarge ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.76)'"
    >
      {{ yLabel }}
    </text>
  </svg>
</template>

<script setup>
defineOptions({ name: '应力分析图表组件' })
import { computed } from 'vue'

const props = defineProps({
  view: { type: Object, required: true },
  title: { type: String, required: true },
  xLabel: { type: String, required: true },
  yLabel: { type: String, required: true },
  large: { type: Boolean, default: false }
})

const isLarge = computed(() => props.large)
</script>
