<template>
  <Teleport to="body">
    <div v-if="visible" class="cockpit">
      <div class="cockpit-bar">
        <span class="cockpit-title">数智孪生驾驶舱</span>
        <span class="cockpit-sub">KPI · 趋势 · 工序联动</span>
        <span class="cockpit-spacer"></span>
        <span class="cockpit-stamp">{{ updatedLabel }}</span>
        <el-button size="small" :loading="loading" @click="refresh">刷新</el-button>
        <el-button size="small" type="primary" @click="$emit('close')">关闭</el-button>
      </div>

      <div class="cockpit-body">
        <aside class="cockpit-col cockpit-left">
          <div class="sec-title">工序视角</div>
          <button
            v-for="proc in PROCS"
            :key="proc.id"
            class="proc"
            :class="{ active: activeProc === proc.id }"
            @click="activeProc = proc.id"
          >
            <span class="proc-dot"></span>
            {{ proc.label }}
          </button>
          <div class="hint">情境切换（WP4）接入后，此处将驱动图层与相机</div>

          <div class="sec-title sec-gap">联动规则</div>
          <div v-for="rule in rules" :key="rule.id" class="rule">
            <span class="rule-id">{{ rule.id }}</span>
            <span class="rule-name" :title="rule.name">{{ rule.name }}</span>
            <span class="rule-state" :class="rule.enabled ? 'on' : 'off'">
              {{ rule.enabled ? '启用' : '占位' }}
            </span>
            <span class="rule-hit">{{ (rule.stats && rule.stats.fired) || 0 }}</span>
          </div>
          <div v-if="!rules.length" class="hint">规则未加载</div>
        </aside>

        <main class="cockpit-center"></main>

        <aside class="cockpit-col cockpit-right">
          <div class="sec-title">关键指标</div>
          <div class="kpi-grid">
            <KpiCard v-for="item in cards" :key="item.code" :item="item" />
          </div>
          <div v-if="!cards.length" class="hint">暂无指标（等待调度推进采样）</div>

          <div class="sec-title sec-gap trend-head">
            <span>变化趋势（近 {{ activeRange.label }}）</span>
            <span class="range-group">
              <button
                v-for="r in RANGES"
                :key="r.id"
                class="range-btn"
                :class="{ active: activeRange.id === r.id }"
                @click="selectRange(r.id)"
              >
                {{ r.label }}
              </button>
            </span>
          </div>
          <TrendPanel :series="series" />

          <div class="sec-title sec-gap">联动日志</div>
          <div class="log">
            <div v-for="ev in events" :key="ev.seq" class="log-row">
              <span class="log-seq">#{{ ev.seq }}</span>
              <span class="log-type">{{ ev.label }}</span>
              <span class="log-proc">{{ ev.proc }}</span>
            </div>
            <div v-if="!events.length" class="hint">暂无事件</div>
          </div>

          <div v-if="degraded || error" class="hint warn">
            {{ error ? `数据异常：${error}` : '数据库不可用，KPI 仅可读内存实时值' }}
          </div>
        </aside>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref } from 'vue'

import KpiCard from './KpiCard.vue'
import TrendPanel from './TrendPanel.vue'
import { useTwinKpi } from '../services/useTwinKpi.js'

defineProps({
  visible: { type: Boolean, default: false }
})
defineEmits(['close'])

const PROCS = [
  { id: 'overview', label: '全景总览' },
  { id: 'geology', label: '地质条件' },
  { id: 'blasting', label: '爆破作业' },
  { id: 'haulage', label: '运搬工艺' },
  { id: 'safety', label: '安全防控' }
]

// 趋势档位：服务端 minutes 上限 10080（7 天），分桶步长按档位放大
const RANGES = [
  { id: '1h', label: '1h', minutes: 60, step: 60 },
  { id: '24h', label: '24h', minutes: 1440, step: 300 },
  { id: '7d', label: '7d', minutes: 10080, step: 3600 }
]

const activeRange = ref(RANGES[0])
const { latest, series, rules, events, loading, degraded, updatedAt, error, refresh, setRange } =
  useTwinKpi({ intervalMs: 5000, minutes: RANGES[0].minutes, step: RANGES[0].step })

const activeProc = ref('overview')
// 12 项 KPI 全量展示：无采样项保留占位（显示 —），不隐藏也不造数
const cards = computed(() => latest.value.slice(0, 12))
const updatedLabel = computed(() => {
  if (!updatedAt.value) return '尚未刷新'
  const date = new Date(updatedAt.value)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss} 更新`
})

function selectRange(id) {
  const next = RANGES.find(item => item.id === id)
  if (!next || next.id === activeRange.value.id) return
  activeRange.value = next
  setRange(next.minutes, next.step)
}
</script>

<style scoped>
.cockpit {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: flex;
  flex-direction: column;
  pointer-events: none;
  color: #dbe6ef;
}

.cockpit-bar {
  flex: 0 0 46px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  background: rgba(6, 10, 16, 0.92);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  pointer-events: auto;
}

.cockpit-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.cockpit-sub {
  font-size: 11px;
  color: #8fa3b8;
}

.cockpit-spacer {
  flex: 1;
}

.cockpit-stamp {
  font:
    11px/1.4 Consolas,
    monospace;
  color: #8fa3b8;
}

.cockpit-body {
  flex: 1;
  display: flex;
  min-height: 0;
  gap: 10px;
  padding: 10px;
}

.cockpit-center {
  flex: 1;
  /* 中间留空给三维场景，鼠标事件穿透到 Cesium */
  pointer-events: none;
}

.cockpit-col {
  pointer-events: auto;
  background: rgba(8, 13, 20, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 10px;
  overflow-y: auto;
}

.cockpit-left {
  width: 248px;
}

.cockpit-right {
  width: 380px;
}

.sec-title {
  font-size: 11px;
  color: #8fa3b8;
  letter-spacing: 0.06em;
  margin-bottom: 6px;
}

.sec-gap {
  margin-top: 12px;
}

.trend-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.range-group {
  display: inline-flex;
  gap: 4px;
}

.range-btn {
  padding: 1px 6px;
  font-size: 10px;
  line-height: 16px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: transparent;
  color: #8fa3b8;
  cursor: pointer;
}

.range-btn:hover {
  color: #dbe6ef;
  border-color: rgba(255, 255, 255, 0.28);
}

.range-btn.active {
  color: #7ee7ff;
  border-color: rgba(103, 232, 249, 0.5);
  background: rgba(103, 232, 249, 0.12);
}

.proc {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: 6px;
  font-size: 12px;
  color: #b9c8d6;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: left;
}

.proc:hover {
  background: rgba(255, 255, 255, 0.05);
}

.proc.active {
  color: #7ee7ff;
  border-color: rgba(103, 232, 249, 0.35);
  background: rgba(103, 232, 249, 0.08);
}

.proc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.8;
}

.rule {
  display: grid;
  grid-template-columns: 30px 1fr 40px 28px;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  padding: 3px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
}

.rule-id {
  color: #7ee7ff;
  font-family: Consolas, monospace;
}

.rule-name {
  color: #b9c8d6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rule-state.on {
  color: #86efac;
}

.rule-state.off {
  color: #94a3b8;
}

.rule-hit {
  text-align: right;
  font-family: Consolas, monospace;
  color: #fbbf24;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.log {
  max-height: 180px;
  overflow-y: auto;
}

.log-row {
  display: grid;
  grid-template-columns: 44px 1fr 60px;
  gap: 6px;
  font-size: 11px;
  padding: 2px 0;
  color: #b9c8d6;
}

.log-seq {
  color: #64748b;
  font-family: Consolas, monospace;
}

.log-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-proc {
  text-align: right;
  color: #8fa3b8;
}

.hint {
  font-size: 11px;
  color: #64748b;
  line-height: 1.6;
  margin-top: 6px;
}

.hint.warn {
  color: #fbbf24;
}
</style>
