<template>
  <div>
    <!-- 对比选择 -->
    <div class="section">
      <div class="section-title">方案对比</div>
      <div class="row">
        <button class="btn" :disabled="!currentEventId" @click="addCurrentEvent">加入当前事件</button>
        <button class="btn primary" :disabled="compareEventIds.length < 2 || comparing" @click="$emit('compare')">
          {{ comparing ? '对比中…' : '生成对比' }}
        </button>
        <span class="hint" style="margin-left:auto">至少选择 2 个事件</span>
      </div>
      <div class="row mt-1">
        <el-select
          :model-value="compareEventIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="选择需要对比的事件"
          style="flex:1;min-width:160px"
          @update:model-value="val => $emit('update:compare-event-ids', val)"
        >
          <el-option v-for="ev in dbEvents" :key="ev.eventId" :label="`${ev.eventId} - ${ev.name}`" :value="ev.eventId" />
        </el-select>
      </div>
      <div v-if="selectedEventChips.length" class="row mt-1">
        <button
          v-for="chip in selectedEventChips"
          :key="chip.eventId"
          class="tag"
          :class="{ on: chip.eventId === currentEventId }"
          @click="removeEvent(chip.eventId)"
        >
          {{ chip.label }} <span style="opacity:0.6">×</span>
        </button>
      </div>
      <div v-else class="hint-sm">还没有选中对比对象。</div>
    </div>

    <!-- 对比结果 -->
    <template v-if="comparisonData.length">
      <div v-if="summaryRows.length" class="section">
        <div class="section-title">结论</div>
        <div class="snapshot-list">
          <div v-for="row in summaryRows" :key="row.title" class="snapshot-row" :class="row.tone">
            <span class="snapshot-label">{{ row.title }}</span>
            <span class="snapshot-val" :class="row.tone">{{ formatNum(row.value) }}{{ row.unit }}</span>
            <span class="snapshot-note">{{ row.name }} · {{ row.note }}</span>
          </div>
        </div>
      </div>

      <div v-if="comparisonCharts.length" class="section">
        <div class="section-title">指标对比</div>
        <div v-for="chart in comparisonCharts" :key="chart.label" class="section" style="margin-bottom:8px">
          <div class="row">
            <span class="hint" style="font-weight:600;color:var(--text-primary)">{{ chart.label }}</span>
            <span class="hint" style="margin-left:auto">最大 {{ formatNum(chart.max) }}{{ chart.unit }}</span>
          </div>
          <div class="cmp-list mt-1">
            <div v-for="(item, index) in chart.items" :key="item.name" class="cmp-row">
              <div class="cmp-rank">{{ index + 1 }}</div>
              <div class="hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="item.name">{{ item.name }}</div>
              <div class="cmp-track"><div class="cmp-fill" :style="{ width: item.percent + '%' }"></div></div>
              <span class="hint" style="font-family:'Consolas',monospace">{{ formatNum(item.value) }}{{ chart.unit }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="tableRows.length" class="section">
        <div class="section-title">指标明细</div>
        <div class="cmp-table">
          <div class="cmp-table-head">
            <span>方案</span><span>x50</span><span>x80</span><span>抛距</span><span>振动峰值</span><span>漏斗</span><span>评价</span>
          </div>
          <div v-for="row in tableRows" :key="row.name" class="cmp-table-row">
            <span class="hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="row.name">{{ row.name }}</span>
            <span class="hint" style="font-family:'Consolas',monospace">{{ formatNum(row.fragmentX50) }}m</span>
            <span class="hint" style="font-family:'Consolas',monospace">{{ formatNum(row.fragmentX80) }}m</span>
            <span class="hint" style="font-family:'Consolas',monospace">{{ formatNum(row.throwDistanceMax) }}m</span>
            <span class="hint" style="font-family:'Consolas',monospace">{{ formatNum(row.vibrationPeak) }}cm/s</span>
            <span class="hint" style="font-family:'Consolas',monospace">{{ formatNum(row.craterDepth) }}×{{ formatNum(row.craterRadius) }}m</span>
            <span class="row" style="gap:4px">
              <span v-for="tag in row.tags" :key="tag" class="tag" style="padding:1px 6px;font-size:10px">{{ tag }}</span>
            </span>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="!comparing" class="section">
      <div class="hint">还没有生成对比结果。建议先把当前事件加入，再选 1-2 个历史事件一起比较。</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

defineOptions({ name: 'HistoryCompare' })

const props = defineProps({
  dbEvents: { type: Array, default: () => [] },
  compareEventIds: { type: Array, default: () => [] },
  comparisonData: { type: Array, default: () => [] },
  comparisonCharts: { type: Array, default: () => [] },
  comparing: { type: Boolean, default: false },
  currentEventId: { type: [String, Number], default: null },
  currentEventName: { type: String, default: '' }
})

const emit = defineEmits(['compare', 'update:compare-event-ids'])

const selectedEventChips = computed(() => {
  const nameMap = Object.fromEntries(props.dbEvents.map(ev => [ev.eventId, `${ev.eventId} - ${ev.name || ev.eventId}`]))
  return props.compareEventIds.map(eventId => ({
    eventId,
    label: eventId === props.currentEventId && props.currentEventName
      ? `${eventId} - ${props.currentEventName}`
      : nameMap[eventId] || String(eventId)
  }))
})

const summaryRows = computed(() => {
  if (!props.comparisonData.length) return []
  const rows = props.comparisonData
    .map(row => ({
      name: row.name || row.eventId || '-',
      fragmentX50: Number(row.fragmentX50) || 0,
      fragmentX80: Number(row.fragmentX80) || 0,
      throwDistanceMax: Number(row.throwDistanceMax) || 0,
      vibrationPeak: Number(row.vibrationPeak) || 0,
      craterDepth: Number(row.craterDepth) || 0
    }))
    .filter(row => row.name)
  if (!rows.length) return []

  const minX50 = rows.reduce((best, row) => (row.fragmentX50 < best.fragmentX50 ? row : best), rows[0])
  const maxThrow = rows.reduce((best, row) => (row.throwDistanceMax > best.throwDistanceMax ? row : best), rows[0])
  const minVibration = rows.reduce((best, row) => (row.vibrationPeak < best.vibrationPeak ? row : best), rows[0])
  const maxCrater = rows.reduce((best, row) => (row.craterDepth > best.craterDepth ? row : best), rows[0])

  return [
    { title: '细碎倾向最强', name: minX50.name, value: minX50.fragmentX50, unit: 'm', note: 'x50 最小', tone: 'info' },
    { title: '飞散最强', name: maxThrow.name, value: maxThrow.throwDistanceMax, unit: 'm', note: '抛距最高', tone: 'warn' },
    { title: '扰动最保守', name: minVibration.name, value: minVibration.vibrationPeak, unit: 'cm/s', note: '振动最低', tone: 'ok' },
    { title: '爆腔最充分', name: maxCrater.name, value: maxCrater.craterDepth, unit: 'm', note: '漏斗最深', tone: 'info' }
  ]
})

const tableRows = computed(() => {
  if (!props.comparisonData.length) return []
  const x50Values = props.comparisonData.map(row => Number(row.fragmentX50) || 0)
  const throwValues = props.comparisonData.map(row => Number(row.throwDistanceMax) || 0)
  const vibrationValues = props.comparisonData.map(row => Number(row.vibrationPeak) || 0)
  const avgX50 = average(x50Values)
  const avgThrow = average(throwValues)
  const avgVibration = average(vibrationValues)

  return props.comparisonData.map(row => {
    const fragmentX50 = Number(row.fragmentX50) || 0
    const fragmentX80 = Number(row.fragmentX80) || 0
    const throwDistanceMax = Number(row.throwDistanceMax) || 0
    const vibrationPeak = Number(row.vibrationPeak) || 0
    const craterDepth = Number(row.craterDepth) || 0
    const craterRadius = Number(row.craterRadius) || 0
    const tags = []
    if (fragmentX50 > 0 && fragmentX50 <= avgX50 * 0.92) tags.push('更细碎')
    else if (fragmentX50 >= avgX50 * 1.08) tags.push('更大块')
    if (throwDistanceMax >= avgThrow * 1.08) tags.push('外抛更强')
    else if (throwDistanceMax > 0 && throwDistanceMax <= avgThrow * 0.92) tags.push('收敛更快')
    if (vibrationPeak > 0 && vibrationPeak <= avgVibration * 0.92) tags.push('振动更低')
    else if (vibrationPeak >= avgVibration * 1.08) tags.push('振动更高')
    if (craterDepth >= 2.5) tags.push('爆腔充分')
    else if (craterDepth > 0 && craterDepth < 1.5) tags.push('爆腔偏浅')
    if (!tags.length) tags.push('接近均值')
    return { name: row.name || row.eventId || '-', fragmentX50, fragmentX80, throwDistanceMax, vibrationPeak, craterDepth, craterRadius, tags }
  })
})

function addCurrentEvent() {
  if (!props.currentEventId) return
  if (props.compareEventIds.includes(props.currentEventId)) return
  emit('update:compare-event-ids', [...props.compareEventIds, props.currentEventId])
}
function removeEvent(eventId) {
  emit('update:compare-event-ids', props.compareEventIds.filter(id => id !== eventId))
}
function formatNum(v) {
  const n = Number(v)
  if (!isFinite(n) || n === 0) return '0'
  if (Math.abs(n) < 0.01) return n.toFixed(4)
  if (Math.abs(n) < 1) return n.toFixed(3)
  if (Math.abs(n) < 100) return n.toFixed(2)
  return n.toFixed(1)
}
function average(values) {
  const valid = values.filter(v => Number.isFinite(v))
  if (!valid.length) return 0
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}
</script>

<style scoped>
.cmp-list { display: flex; flex-direction: column; gap: 6px; }
.cmp-table { display: flex; flex-direction: column; gap: 6px; }
.cmp-table-head,
.cmp-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.55fr) minmax(0, 0.55fr) minmax(0, 0.6fr) minmax(0, 0.7fr) minmax(0, 0.9fr) minmax(0, 1.6fr);
  gap: 6px;
  align-items: center;
}
.cmp-table-head > *,
.cmp-table-row > * {
  min-width: 0;
  overflow: hidden;
}
.cmp-table-head > * {
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmp-table-row .row {
  flex-wrap: wrap;
}
.cmp-table-head {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  color: var(--text-muted);
  font-size: 11px;
}
.cmp-table-row {
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.03);
}
</style>