<template>
  <div>
    <!-- KCO 模型输出 -->
    <div class="section">
      <div class="section-title">KCO 模型输出</div>
      <div class="kco-grid">
        <div class="kco-stat">
          <span class="kco-stat-label">口径</span
          ><span class="kco-stat-val">{{ kcoSourceLabel }}</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">岩石因子 A</span
          ><span class="kco-stat-val">{{ rockFactorA.toFixed(3) }}</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">x50 中位块度</span
          ><span class="kco-stat-val">{{ kcoX50.toFixed(3) }} m</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">x80 通过块度</span
          ><span class="kco-stat-val">{{ kcoX80.toFixed(3) }} m</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">xmax 最大块度</span
          ><span class="kco-stat-val">{{ kcoXmax.toFixed(3) }} m</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">均匀性 n</span
          ><span class="kco-stat-val">{{ kcoN.toFixed(3) }}</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">爆破方量</span
          ><span class="kco-stat-val">{{ brokenVolume.toFixed(2) }} m³</span>
        </div>
        <div class="kco-stat">
          <span class="kco-stat-label">预计碎片数</span
          ><span class="kco-stat-val">~{{ fragmentCountEst }}</span>
        </div>
      </div>
    </div>

    <!-- 趋势摘要 -->
    <div v-if="trendCards.length" class="section">
      <div class="section-title">趋势摘要</div>
      <div class="snapshot-list">
        <div
          v-for="card in trendCards"
          :key="card.title"
          class="snapshot-row dense"
          :class="card.tone"
        >
          <div class="snapshot-row-top">
            <span class="snapshot-label">{{ card.title }}</span>
            <span class="snapshot-extra" :class="card.tone">{{ card.extra }}</span>
          </div>
          <div class="snapshot-row-bottom">
            <span class="snapshot-val" :class="card.tone">{{ card.value }}</span>
            <span class="snapshot-note">{{ card.note }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作 -->
    <div class="row">
      <button
        class="btn primary"
        :disabled="!dataset || kcoReplaying"
        @click="$emit('apply-replay')"
      >
        {{ kcoReplaying ? '预览中…' : '立即重播' }}
      </button>
      <button class="btn" :disabled="kcoReplaying" @click="$emit('reset-kco')">恢复默认</button>
    </div>
    <div v-if="kcoReplaying" class="hint-sm ok">参数已变化，正在自动预览重播…</div>
    <div v-if="!dataset" class="hint-sm">请先加载数据后再应用 KCO 参数</div>

    <!-- 方案保存与加载 -->
    <div class="section">
      <div class="section-title">方案保存与加载</div>
      <div class="row">
        <input
          :value="presetName"
          class="input"
          style="flex: 1; min-width: 120px"
          placeholder="方案名称"
          @input="onPresetNameInput"
        />
        <button class="btn primary" @click="$emit('save-preset')">保存</button>
      </div>
      <div class="row mt-1">
        <select
          :value="selectedPresetId"
          class="sel"
          style="flex: 1; min-width: 120px"
          @change="onPresetChange"
        >
          <option value="">-- 选择已保存方案 --</option>
          <option v-for="preset in presetList" :key="preset.id" :value="preset.id">
            {{ preset.name }}（{{ preset.savedAt }}）
          </option>
        </select>
        <button class="btn" :disabled="!selectedPresetId" @click="$emit('load-preset')">
          加载
        </button>
        <button class="btn danger" :disabled="!selectedPresetId" @click="$emit('delete-preset')">
          删除
        </button>
      </div>
      <div v-if="presetList.length === 0" class="hint-sm">暂无已保存方案</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

defineOptions({ name: 'BlastKcoInsights' })

const props = defineProps({
  dataset: { type: Object, default: null },
  kcoParams: { type: Object, required: true },
  kcoSourceLabel: { type: String, default: '' },
  kcoX50: { type: Number, default: 0 },
  kcoN: { type: Number, default: 0 },
  kcoXmax: { type: Number, default: 0 },
  kcoX80: { type: Number, default: 0 },
  brokenVolume: { type: Number, default: 0 },
  fragmentCountEst: { type: Number, default: 0 },
  trendCards: { type: Array, default: () => [] },
  kcoReplaying: { type: Boolean, default: false },
  presetName: { type: String, default: '' },
  selectedPresetId: { type: String, default: '' },
  presetList: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'apply-replay',
  'reset-kco',
  'update:preset-name',
  'update:selected-preset-id',
  'save-preset',
  'load-preset',
  'delete-preset'
])

const rockFactorA = computed(
  () => 0.06 * ((props.kcoParams.RMD || 0) + (props.kcoParams.RDI || 0) + (props.kcoParams.HF || 0))
)

function onPresetNameInput(event) {
  emit('update:preset-name', event?.target?.value || '')
}
function onPresetChange(event) {
  emit('update:selected-preset-id', event?.target?.value || '')
}
</script>

<style scoped>
.kco-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.kco-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.kco-stat-label {
  font-size: 11px;
  color: var(--text-muted);
}
.kco-stat-val {
  font-size: 13px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
  color: var(--text-primary);
}
</style>
