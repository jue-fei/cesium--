<template>
  <div class="twin-bar">
    <div class="brand" :title="online ? '孪生服务在线' : '孪生服务离线'">
      <span class="dot" :class="{ off: !online }"></span>
      数智孪生
      <span class="muted">{{ online ? '在线' : '离线' }}</span>
    </div>

    <span class="sep"></span>

    <div class="chip" title="已启用规则 / 规则总数">
      <span>联动</span>
      <span class="v">{{ enabledRules }}/{{ rules.length || '—' }}</span>
    </div>
    <div class="chip" title="规则累计命中次数">
      <span>命中</span>
      <span class="v">{{ ruleHits }}</span>
    </div>

    <template v-if="kpiChips.length">
      <span class="sep"></span>
      <div v-for="item in kpiChips" :key="item.code" class="chip chip-kpi">
        <span>{{ item.name }}</span>
        <span class="v">{{ formatValue(item.value, item.unit) }}</span>
      </div>
    </template>

    <span class="sep"></span>

    <div class="chip" title="已连通数据源 / 已登记数据源">
      <span>数据源</span>
      <span class="v">{{ connectedSources }}/{{ sources.length }}</span>
    </div>
    <div class="chip" :title="clockTitle">
      <span>时钟</span>
      <span class="v">{{ clockLabel }}</span>
    </div>

    <button class="open-btn" @click="$emit('open-cockpit')">驾驶舱</button>
  </div>
</template>

<script setup>
defineOptions({ name: '孪生状态栏' })
defineEmits(['open-cockpit'])

import { computed, onMounted, onUnmounted, ref } from 'vue'

import { twinClock } from '@/services/fusion/clockService.js'
import { useTwinGlance } from '../services/useTwinGlance.js'
import { formatValue } from '../services/twinKpiFormat.js'

const { kpis, rules, sources, online } = useTwinGlance({ intervalMs: 10000 })

// 常驻展示 3 个跨工序指标：设备利用率（运搬）、品位（地质/运搬）、危险指数（防控）
const PINNED = ['equip_utilization', 'grade_avg', 'hazard_index']
const kpiChips = computed(() => {
  const byCode = new Map(kpis.value.map(item => [item.code, item]))
  const pinned = PINNED.map(code => byCode.get(code)).filter(Boolean)
  const list = pinned.length ? pinned : kpis.value
  return list.filter(item => item.value !== null && item.value !== undefined).slice(0, 3)
})

const enabledRules = computed(() => rules.value.filter(rule => rule.enabled).length)
const ruleHits = computed(() =>
  rules.value.reduce((sum, rule) => sum + Number((rule.stats && rule.stats.fired) || 0), 0)
)
const connectedSources = computed(
  () => sources.value.filter(item => item.status === 'connected').length
)

const clock = ref(twinClock.snapshot())
let offClock = null

onMounted(() => {
  offClock = twinClock.subscribe(next => {
    clock.value = next
  })
})

onUnmounted(() => {
  if (offClock) offClock()
  offClock = null
})

const clockLabel = computed(() => {
  const mode = clock.value.mode
  if (mode === 'idle') return '未接入'
  if (mode === 'live') return '直播'
  return `回放·${clock.value.providerCount} 模块`
})

const clockTitle = computed(
  () =>
    `mode=${clock.value.mode} t=${clock.value.t.toFixed(2)}s 偏斜=${Math.round(clock.value.skewMs)}ms`
)
</script>

<style scoped>
.twin-bar {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2001;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100vw - 220px);
  padding: 5px 8px 5px 12px;
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(9, 15, 23, 0.94), rgba(7, 12, 18, 0.88));
  border: 1px solid rgba(103, 232, 249, 0.18);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(12px);
  animation: twinBarIn 0.35s ease-out;
}

.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: #dbe6ef;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.8);
}

.dot.off {
  background: #f59e0b;
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.7);
}

.muted {
  font-size: 11px;
  color: #8fa3b8;
}

.sep {
  width: 1px;
  height: 16px;
  background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.16), transparent);
}

.chip {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  color: #8fa3b8;
  white-space: nowrap;
}

.chip .v {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: #dbe6ef;
}

.open-btn {
  margin-left: 2px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: #7ee7ff;
  background: rgba(103, 232, 249, 0.1);
  border: 1px solid rgba(103, 232, 249, 0.35);
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.open-btn:hover {
  background: rgba(103, 232, 249, 0.18);
  border-color: rgba(103, 232, 249, 0.55);
}

@keyframes twinBarIn {
  from {
    opacity: 0;
    transform: translate(-50%, -6px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@media (max-width: 1100px) {
  .chip-kpi {
    display: none;
  }
}
</style>
