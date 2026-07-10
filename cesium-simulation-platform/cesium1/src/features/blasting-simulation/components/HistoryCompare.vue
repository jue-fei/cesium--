<template>
  <div class="panel-section">
    <div class="panel-section-title">历史对比</div>
    <div class="hint-text">
      选择多个爆破事件，对比其碎块中位粒径、最大抛掷距离与振动峰值。
    </div>
    <div class="controls-row mt-2">
      <el-select :model-value="compareEventIds" @update:model-value="val => $emit('update:compare-event-ids', val)"
        multiple collapse-tags collapse-tags-tooltip placeholder="选择需要对比的事件" class="compare-event-select">
        <el-option v-for="ev in dbEvents" :key="ev.eventId" :label="`${ev.eventId} - ${ev.name}`" :value="ev.eventId" />
      </el-select>
      <button class="compact-action-btn primary" :disabled="compareEventIds.length < 2 || comparing"
        @click="$emit('compare')">
        {{ comparing ? '对比中…' : '生成对比' }}
      </button>
    </div>
    <div v-if="comparisonData.length === 0 && !comparing" class="hint-text mt-2">
      请至少选择 2 个事件并点击「生成对比」
    </div>

    <div v-for="chart in comparisonCharts" :key="chart.label" class="compare-chart-block mt-3">
      <div class="panel-subtitle">
        {{ chart.label }}
        <span class="compare-max-hint">最大值：{{ formatNum(chart.max) }}{{ chart.unit }}</span>
      </div>
      <div class="compare-bar-list">
        <div v-for="item in chart.items" :key="item.name" class="compare-bar-row">
          <div class="compare-bar-name" :title="item.name">{{ item.name }}</div>
          <div class="compare-bar-track">
            <div class="compare-bar-fill" :style="{ width: item.percent + '%' }"></div>
          </div>
          <div class="compare-bar-value">{{ formatNum(item.value) }}{{ chart.unit }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: 'HistoryCompare' })

defineProps({
  dbEvents: { type: Array, default: () => [] },
  compareEventIds: { type: Array, default: () => [] },
  comparisonData: { type: Array, default: () => [] },
  comparisonCharts: { type: Array, default: () => [] },
  comparing: { type: Boolean, default: false }
})

defineEmits(['compare', 'update:compare-event-ids'])

function formatNum(v) {
  const n = Number(v)
  if (!isFinite(n) || n === 0) return '0'
  if (Math.abs(n) < 0.01) return n.toFixed(4)
  if (Math.abs(n) < 1) return n.toFixed(3)
  if (Math.abs(n) < 100) return n.toFixed(2)
  return n.toFixed(1)
}
</script>
