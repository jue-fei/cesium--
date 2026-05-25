<template>
  <div v-if="hasWarnings" class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <span class="text-sm text-text-primary">预警列表</span>
        <span :class="summaryBadgeClass" class="text-[11px] px-2 py-0.5 rounded-full">
          {{ summary.counts.total }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <el-button
          size="small"
          :plain="filterLevel !== 'all'"
          :type="filterLevel === 'all' ? 'primary' : 'default'"
          class="!text-[11px]"
          @click="filterLevel = 'all'"
        >
          全部
        </el-button>
        <el-button
          v-for="lv in levels"
          :key="lv.key"
          size="small"
          :plain="filterLevel !== lv.key"
          class="!text-[11px]"
          :style="filterLevel === lv.key ? { borderColor: lv.color, color: lv.color } : {}"
          @click="filterLevel = lv.key"
        >
          {{ lv.label }} {{ summary.counts[lv.key] || 0 }}
        </el-button>
      </div>
    </div>

    <div class="flex items-center justify-between text-[11px] text-text-muted">
      <span>{{ summary.topLevelLabel }}</span>
      <el-button link class="!text-[11px] !text-primary" @click="expanded = !expanded">
        {{ expanded ? '收起' : '展开全部' }}
      </el-button>
    </div>

    <div
      v-if="expanded"
      class="flex flex-col gap-1 max-h-[320px] overflow-y-auto rounded-lg border border-border-primary/60"
    >
      <div
        v-for="w in displayWarnings"
        :key="w.id"
        class="flex items-start gap-2 px-3 py-2 border-b border-border-primary/30 last:border-b-0 hover:bg-black/5 cursor-pointer"
        :style="{ borderLeft: `3px solid ${levelColor(w.level)}` }"
        @click="w._detailOpen = !w._detailOpen"
      >
        <div
          class="mt-0.5 w-2 h-2 rounded-full shrink-0"
          :style="{ backgroundColor: levelColor(w.level) }"
        ></div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm text-text-primary truncate">{{ w.title }}</div>
            <span
              class="text-[10px] px-1.5 py-0.5 rounded shrink-0"
              :style="{ color: levelColor(w.level), backgroundColor: levelBg(w.level) }"
            >
              {{ levelLabel(w.level) }}
            </span>
          </div>
          <div v-if="w._detailOpen" class="mt-1.5 text-xs text-text-muted leading-5">
            {{ w.description }}
          </div>
          <div class="flex items-center gap-2 mt-1 text-[10px] text-text-muted">
            <span v-if="w.region">{{ w.region }}</span>
            <span v-if="w.metric" class="font-mono">{{ w.metric }}</span>
            <span v-if="Number.isFinite(w.value)" class="font-mono">
              {{ Number(w.value).toFixed(2) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!expanded" class="flex flex-col gap-1">
      <div
        v-for="w in displayWarnings.slice(0, 3)"
        :key="w.id"
        class="flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted truncate"
        :style="{ borderLeft: `2px solid ${levelColor(w.level)}` }"
      >
        <div
          class="w-1.5 h-1.5 rounded-full shrink-0"
          :style="{ backgroundColor: levelColor(w.level) }"
        ></div>
        <span class="truncate">{{ w.title }}</span>
        <span class="text-[10px] shrink-0" :style="{ color: levelColor(w.level) }">
          {{ levelLabel(w.level) }}
        </span>
      </div>
      <div v-if="displayWarnings.length > 3" class="text-[11px] text-text-muted px-2">
        还有 {{ displayWarnings.length - 3 }} 条预警...
      </div>
    </div>
  </div>

  <div v-else class="rounded-lg border border-border-primary/60 px-3 py-3 bg-black/10">
    <div class="text-sm text-text-muted">当前无预警</div>
    <div class="mt-1 text-[11px] text-text-muted">所有监测区域安全评分和应力指标均在正常范围</div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { WARNING_LEVELS } from '../services/core/safety/warningEngine.js'

const props = defineProps({
  warnings: { type: Array, default: () => [] },
  summary: {
    type: Object,
    default: () => ({
      counts: { red: 0, orange: 0, yellow: 0, total: 0 },
      topLevel: null,
      topLevelLabel: '无预警',
      hasWarnings: false
    })
  }
})

const levels = Object.values(WARNING_LEVELS)
const expanded = ref(false)
const filterLevel = ref('all')

const hasWarnings = computed(() => props.summary?.hasWarnings ?? false)

const displayWarnings = computed(() => {
  let list = props.warnings || []
  if (filterLevel.value !== 'all') {
    list = list.filter(w => w.level === filterLevel.value)
  }
  return list
})

const summaryBadgeClass = computed(() => {
  const top = props.summary?.topLevel
  if (top === 'red') return 'bg-red-500/20 text-red-400'
  if (top === 'orange') return 'bg-orange-500/20 text-orange-400'
  if (top === 'yellow') return 'bg-yellow-500/20 text-yellow-400'
  return 'bg-gray-500/20 text-gray-400'
})

function levelColor(lv) {
  return WARNING_LEVELS[lv]?.color || '#888'
}
function levelBg(lv) {
  return WARNING_LEVELS[lv]?.bg || 'rgba(136,136,136,0.12)'
}
function levelLabel(lv) {
  return WARNING_LEVELS[lv]?.label || lv
}
</script>
