<template>
  <div class="panel-section">
    <div class="panel-section-title">块度分布</div>

    <div v-if="!hasData" class="hint-text">
      请先加载爆破事件并触发一次爆破生成，块度分布数据将基于实际生成的碎片物理尺寸统计。
    </div>

    <template v-else>
      <!-- 块度分布柱状图 -->
      <div class="dist-chart-block">
        <div v-for="b in buckets" :key="b.label" class="dist-chart-row">
          <div class="dist-chart-label" :title="b.label">{{ b.label }}</div>
          <div class="dist-chart-track">
            <div
              class="dist-chart-fill"
              :class="{ 'is-active': activeBucketLabel === b.label }"
              :style="{ width: barWidth(b.percentage) }"
            ></div>
          </div>
          <div class="dist-chart-pct">{{ b.percentage.toFixed(1) }}%</div>
        </div>
      </div>

      <!-- 块度区间列表（可点击高亮） -->
      <div class="panel-subtitle">区间明细（点击高亮）</div>
      <div class="dist-table">
        <div class="dist-table-head">
          <span>区间</span>
          <span>数量</span>
          <span>占比</span>
          <span>估算质量</span>
        </div>
        <div
          v-for="b in buckets"
          :key="'row-' + b.label"
          class="dist-table-row"
          :class="{ 'is-active': activeBucketLabel === b.label }"
          @click="onBucketClick(b)"
        >
          <span class="dist-col-label">{{ b.label }}</span>
          <span class="dist-col-num">{{ b.count }}</span>
          <span class="dist-col-num">{{ b.percentage.toFixed(1) }}%</span>
          <span class="dist-col-num">{{ formatMass(estimateMass(b)) }}</span>
        </div>
      </div>

      <!-- KCO 模型参数 -->
      <div class="panel-subtitle">KCO 模型参数</div>
      <div class="stat-item">
        <span>x50（中位粒径）</span>
        <span class="stat-value">{{ formatSize(kcoX50) }} m</span>
      </div>
      <div class="stat-item">
        <span>x80（80% 通过粒径）</span>
        <span class="stat-value">{{ formatSize(distribution?.x80) }} m</span>
      </div>
      <div class="stat-item">
        <span>xmax（最大粒径）</span>
        <span class="stat-value">{{ formatSize(kcoXmax) }} m</span>
      </div>
      <div class="stat-item">
        <span>n（均匀度指数）</span>
        <span class="stat-value">{{ formatNum(kcoN) }}</span>
      </div>
      <div class="stat-item">
        <span>b（曲线参数）</span>
        <span class="stat-value">{{ formatNum(kcoB) }}</span>
      </div>

      <!-- 爆破参数信息 -->
      <div class="panel-subtitle">爆破参数</div>
      <div class="stat-item">
        <span>炸药量</span>
        <span class="stat-value">{{ formatNum(chargeKg) }} kg</span>
      </div>
      <div class="stat-item">
        <span>单循环进尺</span>
        <span class="stat-value">{{ formatSize(advanceLength) }} m</span>
      </div>
      <div class="stat-item">
        <span>碎片总数</span>
        <span class="stat-value">{{ distribution?.total ?? 0 }}</span>
      </div>
      <div class="stat-item">
        <span>实测最大粒径</span>
        <span class="stat-value">{{ formatSize(distribution?.xmax) }} m</span>
      </div>
      <div class="stat-item">
        <span>生成质量</span>
        <span class="stat-value">{{ formatMass(threeStats?.fragmentMassGeneratedKg) }}</span>
      </div>

      <!-- 高亮操作提示 -->
      <div class="hint-text mt-2">
        点击区间行可在 3D 场景中高亮对应块度范围的碎片，再次点击同一行可取消高亮。
      </div>
      <div v-if="activeBucketLabel" class="controls-row mt-1">
        <button class="compact-action-btn danger" @click="clearHighlight">清除高亮</button>
        <span class="hint-text">当前高亮：{{ activeBucketLabel }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

defineOptions({ name: 'FragmentDistribution' })

const props = defineProps({
  dataset: { type: Object, default: null },
  distribution: { type: Object, default: null },
  threeStats: { type: Object, default: null }
})

const emit = defineEmits(['highlight-size', 'clear-highlight'])

// 当前高亮的区间 label（点击同一行切换高亮/取消）
const activeBucketLabel = ref(null)

const buckets = computed(() => props.distribution?.buckets || [])
const hasData = computed(
  () =>
    !!props.distribution &&
    Array.isArray(props.distribution.buckets) &&
    props.distribution.total > 0
)

// ─── KCO 模型参数来源：优先 threeStats（实际应用值），其次 dataset.result（设计值） ───
const kcoX50 = computed(
  () => props.threeStats?.x50Applied ?? props.dataset?.result?.fragmentX50 ?? null
)
const kcoXmax = computed(
  () => props.dataset?.result?.fragmentXmax ?? props.distribution?.xmax ?? null
)
const kcoN = computed(() => props.threeStats?.nApplied ?? props.dataset?.result?.fragmentN ?? null)
const kcoB = computed(() => props.dataset?.result?.fragmentB ?? null)

const chargeKg = computed(() => props.dataset?.event?.chargeKg ?? null)
const advanceLength = computed(() => {
  const design = props.dataset?.design
  if (!design) return null
  const adv = Number(design.advanceLength)
  if (Number.isFinite(adv) && adv > 0) return adv
  const holeDepth = Math.max(0.5, Number(design.holeDepth) || 2.5)
  const util = Math.max(0.3, Math.min(1.0, Number(design.utilization) || 0.85))
  return holeDepth * util
})

// 岩石密度（kg/m³），用于估算每个区间的质量
const ROCK_DENSITY = 2650

// 估算单个区间的总质量：用区间中位尺寸按球体近似
function estimateMass(bucket) {
  if (!bucket || bucket.count === 0) return 0
  let mid
  if (bucket.max == null) {
    // 1.0 m+ 区间：用 min 作为最小估计
    mid = Math.max(0.01, bucket.min)
  } else {
    mid = (bucket.min + bucket.max) / 2
  }
  // 球体体积 V = 4/3 * π * r³，r = mid / 2
  const radius = mid / 2
  const volume = (4 / 3) * Math.PI * radius * radius * radius
  return volume * ROCK_DENSITY * bucket.count
}

// 区间点击：同一区间再次点击则取消高亮
function onBucketClick(bucket) {
  if (activeBucketLabel.value === bucket.label) {
    activeBucketLabel.value = null
    emit('clear-highlight')
    return
  }
  activeBucketLabel.value = bucket.label
  // 上界为 null（1.0 m+）时，max 传一个较大值即可
  const max = bucket.max == null ? Infinity : bucket.max
  emit('highlight-size', { min: bucket.min, max })
}

function clearHighlight() {
  activeBucketLabel.value = null
  emit('clear-highlight')
}

// ─── 格式化辅助 ───
function barWidth(pct) {
  const v = Number(pct) || 0
  if (v <= 0) return '0%'
  return Math.min(100, v).toFixed(1) + '%'
}

function formatSize(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '--'
  if (Math.abs(n) < 0.01) return '0.000'
  if (Math.abs(n) < 1) return n.toFixed(3)
  if (Math.abs(n) < 100) return n.toFixed(2)
  return n.toFixed(1)
}

function formatNum(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '--'
  if (Math.abs(n) < 0.01) return '0.00'
  if (Math.abs(n) < 100) return n.toFixed(2)
  return n.toFixed(1)
}

function formatMass(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '--'
  if (n < 1) return n.toFixed(2) + ' kg'
  if (n < 1000) return n.toFixed(1) + ' kg'
  return (n / 1000).toFixed(2) + ' t'
}
</script>

<style scoped>
/* ─── 块度分布柱状图 ─── */
.dist-chart-block {
  margin-bottom: var(--spacing-md);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.dist-chart-row {
  display: grid;
  grid-template-columns: 90px 1fr 48px;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dist-chart-row:last-child {
  margin-bottom: 0;
}

.dist-chart-label {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-family: 'Consolas', 'Monaco', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dist-chart-track {
  height: 10px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 5px;
  overflow: hidden;
}

.dist-chart-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(64, 158, 255, 0.55), var(--primary-color));
  border-radius: 5px;
  transition:
    width 0.3s ease,
    background 0.2s ease;
}

.dist-chart-fill.is-active {
  background: linear-gradient(90deg, rgba(255, 154, 0, 0.6), #ff9a00);
}

.dist-chart-pct {
  font-size: var(--font-xs);
  color: var(--text-primary);
  font-family: 'Consolas', 'Monaco', monospace;
  text-align: right;
}

/* ─── 块度区间表格 ─── */
.dist-table {
  margin-top: var(--spacing-sm);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.dist-table-head,
.dist-table-row {
  display: grid;
  grid-template-columns: 1.4fr 0.8fr 0.9fr 1fr;
  gap: 8px;
  padding: 8px 12px;
  font-size: var(--font-xs);
  align-items: center;
}

.dist-table-head {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-muted);
  font-weight: 600;
}

.dist-table-row {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
  color: var(--text-primary);
}

.dist-table-row:hover {
  background: rgba(64, 158, 255, 0.08);
}

.dist-table-row.is-active {
  background: rgba(255, 154, 0, 0.14);
  border-color: rgba(255, 154, 0, 0.35);
}

.dist-col-num {
  font-family: 'Consolas', 'Monaco', monospace;
  text-align: right;
}

.dist-col-label {
  font-family: 'Consolas', 'Monaco', monospace;
  color: var(--text-secondary);
}

.mt-1 {
  margin-top: var(--spacing-sm);
}

.mt-2 {
  margin-top: var(--spacing-md);
}
</style>
