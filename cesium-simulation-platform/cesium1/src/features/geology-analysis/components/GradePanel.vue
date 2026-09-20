<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <!-- 标题行：开关 + 仿真徽标 -->
    <div class="text-sm font-semibold text-blue-100 mb-3 flex items-center justify-between">
      <span
        class="flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
      >
        矿石品位层
      </span>
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <span
          v-if="data?.source === 'synthetic'"
          class="text-[10px] px-1.5 py-0.5 rounded-full text-yellow-300 bg-yellow-400/10 border border-yellow-400/30"
          title="当前品位数据由固定 seed 合成生成，非真实勘探品位"
        >
          {{ SYNTHETIC_BADGE_TEXT }}
        </span>
        <input v-model="visible" type="checkbox" class="accent-blue-500" />
        <span class="text-xs text-gray-400 font-normal">显示</span>
      </label>
    </div>

    <div v-if="error" class="text-[10px] text-red-400 mb-2">{{ error }}</div>
    <div v-else-if="loading" class="text-[10px] text-gray-500 mb-2">品位数据加载中…</div>

    <template v-if="data">
      <!-- 图例（与 3D 块段着色同源） -->
      <div class="flex flex-wrap gap-1.5 mb-3">
        <span
          v-for="it in legendItems"
          :key="it.label"
          class="flex items-center gap-1 text-[10px] text-gray-400"
        >
          <i
            class="w-3 h-3 rounded-sm inline-block"
            :style="{ background: it.color, opacity: 0.75 }"
          />
          {{ it.label }}%
        </span>
      </div>

      <!-- 采区过滤 -->
      <div class="flex flex-wrap gap-1.5 mb-3">
        <button
          class="text-[10px] px-2 py-0.5 rounded-full border transition-colors"
          :class="
            zoneFilter
              ? 'border-white/10 text-gray-400 hover:border-blue-400/40'
              : 'border-blue-400/60 text-blue-200 bg-blue-500/10'
          "
          @click="setFilter(null)"
        >
          全部采区
        </button>
        <button
          v-for="z in data.zones"
          :key="z"
          class="text-[10px] px-2 py-0.5 rounded-full border transition-colors"
          :class="
            zoneFilter === z
              ? 'border-blue-400/60 text-blue-200 bg-blue-500/10'
              : 'border-white/10 text-gray-400 hover:border-blue-400/40'
          "
          @click="setFilter(z)"
        >
          {{ z }}
        </button>
      </div>

      <!-- 摘要 + 直方图 -->
      <div class="flex gap-3 items-stretch">
        <div class="flex flex-col justify-center gap-1 text-[10px] text-gray-400 whitespace-nowrap">
          <span
            >块段 <span class="text-gray-200 font-mono">{{ stats.count }}</span> 个</span
          >
          <span
            >平均品位 <span class="text-gray-200 font-mono">{{ stats.meanGrade }}%</span></span
          >
          <span
            >矿石量 <span class="text-gray-200 font-mono">{{ stats.tonnage }}t</span></span
          >
        </div>
        <svg
          :viewBox="`0 0 ${bins.length * 24} 64`"
          class="flex-1 h-16"
          preserveAspectRatio="xMidYEnd meet"
        >
          <g v-for="(b, i) in bins" :key="b.label">
            <rect
              :x="i * 24 + 3"
              :y="60 - barHeight(b)"
              :width="18"
              :height="Math.max(barHeight(b), 0)"
              :fill="b.color"
              opacity="0.75"
              rx="1"
            >
              <title>{{ b.label }}%：{{ b.count }} 个块段</title>
            </rect>
            <text
              v-if="b.count > 0"
              :x="i * 24 + 12"
              :y="56 - barHeight(b)"
              text-anchor="middle"
              class="fill-gray-400"
              font-size="7"
            >
              {{ b.count }}
            </text>
          </g>
        </svg>
      </div>
    </template>
  </div>
</template>

<script setup>
defineOptions({ name: 'GradePanel' })
import { computed, onMounted, ref, watch } from 'vue'
import useViewer from '@/composables/useViewer.js'
import {
  SYNTHETIC_BADGE_TEXT,
  ensureLayer,
  fetchGradeData,
  getZoneFilter,
  setZoneFilter,
  setVisible
} from '../services/gradeLayerService.js'
import { gradeLegendItems, histogramBins } from '../services/gradeScale.js'

const VISIBLE_STORAGE_KEY = 'geology_grade_layer_visible'

const { viewer, getViewer } = useViewer()
const data = ref(null)
const loading = ref(true)
const error = ref('')
const visible = ref(localStorage.getItem(VISIBLE_STORAGE_KEY) !== '0')
const zoneFilter = ref(getZoneFilter() ? [...getZoneFilter()][0] : null)

const levels = computed(() => data.value?.gradeLevels || [])
const legendItems = computed(() => gradeLegendItems(levels.value))
const bins = computed(() => histogramBins(data.value?.blocks || [], levels.value))

const stats = computed(() => {
  const blocks = data.value?.blocks || []
  if (!blocks.length) return { count: 0, meanGrade: '-', tonnage: '-' }
  const grades = blocks.map(b => b.gradePct)
  const tonnage = blocks.reduce((s, b) => s + (b.tonnageT || 0), 0)
  return {
    count: blocks.length,
    meanGrade: (grades.reduce((a, b) => a + b, 0) / grades.length).toFixed(2),
    tonnage:
      tonnage >= 10000 ? `${(tonnage / 10000).toFixed(1)}万` : Math.round(tonnage).toLocaleString()
  }
})

function barHeight(bin) {
  const max = Math.max(...bins.value.map(b => b.count), 1)
  return (bin.count / max) * 46
}

function setFilter(zone) {
  zoneFilter.value = zone
  setZoneFilter(zone ? [zone] : null)
}

// 开关持久化（场景重建后状态保留，与板块其它小标识开关同口径）
watch(visible, v => {
  localStorage.setItem(VISIBLE_STORAGE_KEY, v ? '1' : '0')
  setVisible(v)
})

// 场景重建（viewer 替换）后零请求重挂图层
watch(viewer, async v => {
  if (v && visible.value && data.value) await ensureLayer(v)
})

onMounted(async () => {
  data.value = await fetchGradeData()
  loading.value = false
  if (!data.value) {
    error.value = '品位数据不可用（后端 /api/geology/grade-blocks）'
    return
  }
  setVisible(visible.value)
  await ensureLayer(getViewer())
})
// 注意：卸载时不清理图元——面板关闭≠图层销毁，图层随场景生命周期走
</script>
