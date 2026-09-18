<template>
  <div>
    <!-- 快照指标 -->
    <div v-if="snapshotRows.length" class="section">
      <div class="section-title">效果统计</div>
      <div class="snapshot-list">
        <div v-for="r in snapshotRows" :key="r.label" class="snapshot-row">
          <span class="snapshot-label">{{ r.label }}</span>
          <span class="snapshot-val" :class="r.tone">{{ r.value }}</span>
          <span class="snapshot-note">{{ r.note }}</span>
        </div>
      </div>
    </div>

    <!-- 视觉图层 -->
    <div class="section">
      <div class="section-title">视觉图层</div>
      <div class="layer-grid">
        <label
          v-for="layer in layerDefs"
          :key="layer.key"
          class="tag"
          :class="{ on: layerVisibility[layer.key] }"
          @click="onToggle(layer.key)"
        >
          {{ layer.label }}
        </label>
      </div>
      <div class="row mt-1">
        <button class="btn" @click="setAll(true)">全部显示</button>
        <button class="btn" @click="setAll(false)">仅场景</button>
        <button class="btn" @click="$emit('sync-visibility')">同步</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

defineOptions({ name: 'PlaybackControl' })

const props = defineProps({
  threeStats: Object,
  kcoParams: Object,
  layerDefs: { type: Array, default: () => [] },
  layerVisibility: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['set-layer-visible', 'sync-visibility'])

function onToggle(layer) {
  emit('set-layer-visible', layer, !props.layerVisibility[layer])
}
function setAll(v) {
  for (const def of props.layerDefs) emit('set-layer-visible', def.key, v)
}

// 快照指标：从 threeStats 提取关键数据，紧凑行列表
const snapshotRows = computed(() => {
  const s = props.threeStats
  if (!s) return []
  const rows = []
  if (Number.isFinite(s.fragmentCountGenerated)) {
    rows.push({ label: '碎片数', value: s.fragmentCountGenerated, note: '总', tone: 'info' })
  }
  if (Number.isFinite(s.alive)) {
    rows.push({ label: '空中碎片', value: s.alive, note: '未落', tone: 'info' })
  }
  if (Number.isFinite(s.landed)) {
    rows.push({ label: '已落地', value: s.landed, note: '堆积', tone: 'ok' })
  }
  if (Number.isFinite(s.throwDistancePredictedAvg)) {
    rows.push({
      label: '平均抛距',
      value: s.throwDistancePredictedAvg.toFixed(1) + ' m',
      note: '预测',
      tone: 'info'
    })
  }
  if (Number.isFinite(s.throwDistancePredictedMax)) {
    rows.push({
      label: '最大抛距',
      value: s.throwDistancePredictedMax.toFixed(1) + ' m',
      note: '预测',
      tone: 'warn'
    })
  }
  if (s.x50Applied != null) {
    rows.push({
      label: 'x50',
      value: Number(s.x50Applied).toFixed(3) + ' m',
      note: '中位粒径',
      tone: 'info'
    })
  }
  if (s.x80Applied != null) {
    rows.push({
      label: 'x80',
      value: Number(s.x80Applied).toFixed(3) + ' m',
      note: '80% 通过',
      tone: 'info'
    })
  }
  return rows
})
</script>
