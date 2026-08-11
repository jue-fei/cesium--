<template>
  <div class="panel-section">
    <div class="panel-section-title">一致性诊断</div>

    <div v-if="!dataset || !diagnostics" class="hint-text">
      请先加载爆破事件并触发一次爆破生成，诊断面板会显示当前块度、数量、质量和抛距闭合情况。
    </div>

    <template v-else>
      <div class="diagnostic-summary" :class="`is-${diagnostics.summary.overallStatus}`">
        <div class="diagnostic-summary-title">
          <span>总体状态</span>
          <span class="diagnostic-badge" :class="`is-${diagnostics.summary.overallStatus}`">
            {{ summaryLabel }}
          </span>
        </div>
        <div class="diagnostic-summary-text">{{ diagnostics.summary.summaryText }}</div>
        <div class="diagnostic-summary-meta">
          <span>OK {{ diagnostics.summary.counts.ok }}</span>
          <span>警告 {{ diagnostics.summary.counts.warning }}</span>
          <span>高风险 {{ diagnostics.summary.counts.error }}</span>
        </div>
      </div>

      <div class="panel-subtitle">核心指标</div>
      <div v-for="section in diagnostics.sections" :key="section.title" class="diagnostic-block">
        <div class="diagnostic-block-head">
          <div class="diagnostic-block-title">{{ section.title }}</div>
          <div class="hint-text">{{ section.description }}</div>
        </div>
        <div v-for="metric in section.metrics" :key="metric.label" class="diagnostic-metric">
          <div class="diagnostic-metric-main">
            <span>{{ metric.label }}</span>
            <span class="diagnostic-badge" :class="`is-${metric.status}`">
              {{ statusLabel(metric.status) }}
            </span>
          </div>
          <div class="diagnostic-metric-values">
            <span>目标 {{ formatValue(metric.target, metric.unit) }}</span>
            <span>实际 {{ formatValue(metric.actual, metric.unit) }}</span>
            <span v-if="metric.deltaPercent != null">
              偏差 {{ metric.deltaPercent > 0 ? '+' : '' }}{{ metric.deltaPercent.toFixed(1) }}%
            </span>
          </div>
        </div>
      </div>

      <!-- 分布直方图 -->
      <template v-if="hasHistograms">
        <div class="panel-subtitle">分布直方图</div>

        <!-- 块度分布双系列柱状图 -->
        <div v-if="sizeChartBins.length" class="histogram-block">
          <div class="histogram-block-head">
            <span class="histogram-block-title">块度分布</span>
            <span class="diagnostic-badge" :class="`is-${klStatus}`">
              KL {{ formatKL(diagnostics.stats.sizeKLDivergence) }}
            </span>
          </div>
          <div class="histogram-chart">
            <div
              v-for="(bin, i) in sizeChartBins"
              :key="'size-' + i"
              class="histogram-bin-group"
            >
              <div class="histogram-bar actual" :style="{ height: barHeight(bin.pct, sizeMaxPct) }"></div>
              <div class="histogram-bar target" :style="{ height: barHeight(sizeTargetPcts[i], sizeMaxPct) }"></div>
            </div>
          </div>
          <div class="histogram-legend">
            <span class="legend-item"><span class="legend-dot actual"></span>实际采样</span>
            <span class="legend-item"><span class="legend-dot target"></span>目标 (Swebrec)</span>
          </div>
        </div>

        <!-- 速度分布单系列柱状图 -->
        <div v-if="velocityChartBins.length" class="histogram-block">
          <div class="histogram-block-head">
            <span class="histogram-block-title">速度分布</span>
            <span class="histogram-hint">
              均值 {{ formatVal(diagnostics.stats.velocityMean) }} m/s ·
              P95 {{ formatVal(diagnostics.stats.velocityP95) }} m/s
            </span>
          </div>
          <div class="histogram-chart histogram-single">
            <div
              v-for="(bin, i) in velocityChartBins"
              :key="'vel-' + i"
              class="histogram-bar single"
              :style="{ height: barHeight(bin.pct, velocityMaxPct) }"
            ></div>
            <!-- 均值竖线 -->
            <div
              v-if="velocityMeanPos != null"
              class="histogram-marker mean"
              :style="{ left: velocityMeanPos + '%' }"
              title="均值"
            ></div>
            <!-- P95竖线 -->
            <div
              v-if="velocityP95Pos != null"
              class="histogram-marker p95"
              :style="{ left: velocityP95Pos + '%' }"
              title="P95"
            ></div>
          </div>
        </div>
      </template>

      <!-- 能量与堆积 -->
      <template v-if="hasEnergyStats">
        <div class="panel-subtitle">能量与堆积</div>

        <!-- 堆积质量比 -->
        <div class="histogram-block">
          <div class="histogram-block-head">
            <span class="histogram-block-title">堆积质量比</span>
            <span class="diagnostic-badge" :class="`is-${settledStatus}`">
              {{ formatPercent(settledRatio) }}
            </span>
          </div>
          <div class="energy-bar-container">
            <div class="energy-bar-fill" :class="`is-${settledStatus}`" :style="{ width: barWidth(settledRatio) }"></div>
          </div>
          <div class="histogram-hint">
            目标 ≥90% · {{ settledRatio >= 0.9 ? '达标' : settledRatio >= 0.75 ? '待收敛' : '高风险' }}
          </div>
        </div>

        <!-- 总动能衰减曲线 -->
        <div v-if="energyPoints.length > 1" class="histogram-block">
          <div class="histogram-block-head">
            <span class="histogram-block-title">总动能衰减</span>
            <span class="histogram-hint">
              峰值 {{ formatVal(peakEnergy) }} J
            </span>
          </div>
          <svg class="energy-chart" viewBox="0 0 200 60" preserveAspectRatio="none">
            <polyline
              :points="energyPolyline"
              fill="none"
              stroke="var(--primary-color, #409eff)"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <div class="histogram-hint">横轴: 时间(s) · 纵轴: 总动能(J)</div>
        </div>
      </template>

      <div class="panel-subtitle">运行时摘要</div>
      <div class="stat-item">
        <span>KCO 来源模式</span>
        <span class="stat-value">{{
          diagnostics.stats.kcoSourceMode === 'result' ? '结果驱动' : '设计驱动'
        }}</span>
      </div>
      <div v-if="diagnostics.stats.velocityMean != null" class="stat-item">
        <span>速度均值</span>
        <span class="stat-value">{{ diagnostics.stats.velocityMean.toFixed(2) }} m/s</span>
      </div>
      <div v-if="diagnostics.stats.velocityP95 != null" class="stat-item">
        <span>速度 P95</span>
        <span class="stat-value">{{ diagnostics.stats.velocityP95.toFixed(2) }} m/s</span>
      </div>
      <div v-if="diagnostics.stats.velocityScaleApplied != null" class="stat-item">
        <span>速度校准系数</span>
        <span class="stat-value">{{ diagnostics.stats.velocityScaleApplied.toFixed(2) }}</span>
      </div>
      <div v-if="diagnostics.stats.fragmentMassCoverage != null" class="stat-item">
        <span>质量覆盖率</span>
        <span class="stat-value"
          >{{ (diagnostics.stats.fragmentMassCoverage * 100).toFixed(1) }}%</span
        >
      </div>

      <div v-if="diagnostics.findings.length" class="mt-3">
        <div class="panel-subtitle">偏差提示</div>
        <div v-for="finding in diagnostics.findings" :key="finding" class="diagnostic-finding">
          {{ finding }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'

defineOptions({ name: 'ConsistencyDiagnostics' })

const props = defineProps({
  dataset: { type: Object, default: null },
  diagnostics: { type: Object, default: null }
})

const summaryLabel = computed(() =>
  statusLabel(props.diagnostics?.summary?.overallStatus || 'neutral')
)

function statusLabel(status) {
  if (status === 'ok') return '正常'
  if (status === 'warning') return '待收敛'
  if (status === 'error') return '高风险'
  return '信息'
}

function formatValue(value, unit) {
  if (value == null) return '--'
  if (Math.abs(value) >= 1000) return `${value.toFixed(0)} ${unit}`.trim()
  if (Math.abs(value) >= 100) return `${value.toFixed(1)} ${unit}`.trim()
  return `${value.toFixed(2)} ${unit}`.trim()
}

// ─── 分布直方图相关 ───
// 是否有直方图数据
const hasHistograms = computed(() => {
  const s = props.diagnostics?.stats
  if (!s) return false
  return (Array.isArray(s.sizeHistogramGenerated) && s.sizeHistogramGenerated.length > 0) ||
         (Array.isArray(s.velocityHistogramGenerated) && s.velocityHistogramGenerated.length > 0)
})

// 块度分布数据
const sizeChartBins = computed(() => props.diagnostics?.stats?.sizeHistogramGenerated || [])
const sizeTargetPcts = computed(() => props.diagnostics?.stats?.sizeHistogramTarget?.map(b => b.pct) || [])
const sizeMaxPct = computed(() => {
  const actual = sizeChartBins.value.map(b => b.pct)
  const target = sizeTargetPcts.value
  return Math.max(...actual, ...target, 0.001)
})

// KL散度状态
const klStatus = computed(() => {
  const kl = props.diagnostics?.stats?.sizeKLDivergence
  if (kl == null) return 'neutral'
  if (kl <= 0.1) return 'ok'
  if (kl <= 0.3) return 'warning'
  return 'error'
})

// 速度分布数据
const velocityChartBins = computed(() => props.diagnostics?.stats?.velocityHistogramGenerated || [])
const velocityMaxPct = computed(() => {
  const pcts = velocityChartBins.value.map(b => b.pct)
  return Math.max(...pcts, 0.001)
})

// 速度均值/P95 在横轴上的位置百分比（0-100）
const velocityMeanPos = computed(() => {
  const mean = props.diagnostics?.stats?.velocityMean
  const bins = velocityChartBins.value
  if (mean == null || !bins.length) return null
  const maxSpeed = bins[bins.length - 1].max
  if (!maxSpeed) return null
  return Math.min(100, Math.max(0, (mean / maxSpeed) * 100))
})

const velocityP95Pos = computed(() => {
  const p95 = props.diagnostics?.stats?.velocityP95
  const bins = velocityChartBins.value
  if (p95 == null || !bins.length) return null
  const maxSpeed = bins[bins.length - 1].max
  if (!maxSpeed) return null
  return Math.min(100, Math.max(0, (p95 / maxSpeed) * 100))
})

// 柱状图高度（百分比字符串）
function barHeight(pct, maxPct) {
  const h = maxPct > 0 ? (pct / maxPct) * 100 : 0
  return Math.max(1, h) + '%'
}

function formatKL(val) {
  if (val == null) return '--'
  return val.toFixed(3)
}

function formatVal(val) {
  if (val == null) return '--'
  return val.toFixed(2)
}

// ─── 能量与堆积相关 ───
const hasEnergyStats = computed(() => {
  const e = props.diagnostics?.stats?.energyStats
  return e != null && (e.settledMassRatio != null || Array.isArray(e.timeSeries))
})

const settledRatio = computed(() => props.diagnostics?.stats?.energyStats?.settledMassRatio ?? null)
const settledStatus = computed(() => {
  const r = settledRatio.value
  if (r == null) return 'neutral'
  if (r >= 0.90) return 'ok'
  if (r >= 0.75) return 'warning'
  return 'error'
})

const energyPoints = computed(() => props.diagnostics?.stats?.energyStats?.timeSeries || [])
const peakEnergy = computed(() => {
  if (!energyPoints.value.length) return 0
  return Math.max(...energyPoints.value.map(p => p.kineticEnergy || 0))
})

// SVG 折线点坐标
const energyPolyline = computed(() => {
  const pts = energyPoints.value
  if (pts.length < 2) return ''
  const maxT = pts[pts.length - 1].t || 1
  const maxE = Math.max(...pts.map(p => p.kineticEnergy || 0), 0.001)
  return pts.map(p => {
    const x = ((p.t || 0) / maxT) * 200
    const y = 60 - ((p.kineticEnergy || 0) / maxE) * 55
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
})

function formatPercent(val) {
  if (val == null) return '--'
  return (val * 100).toFixed(1) + '%'
}

function barWidth(ratio) {
  if (ratio == null) return '0%'
  return Math.min(100, ratio * 100) + '%'
}
</script>

<style scoped>
.diagnostic-summary {
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.diagnostic-summary.is-ok {
  border-color: rgba(103, 194, 58, 0.35);
  background: rgba(103, 194, 58, 0.08);
}

.diagnostic-summary.is-warning {
  border-color: rgba(230, 162, 60, 0.35);
  background: rgba(230, 162, 60, 0.08);
}

.diagnostic-summary.is-error {
  border-color: rgba(245, 108, 108, 0.35);
  background: rgba(245, 108, 108, 0.08);
}

.diagnostic-summary-title,
.diagnostic-metric-main,
.diagnostic-summary-meta,
.diagnostic-block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-sm);
}

.diagnostic-summary-text,
.diagnostic-summary-meta,
.diagnostic-metric-values,
.diagnostic-finding {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.diagnostic-summary-text {
  margin-top: 6px;
  line-height: 1.5;
}

.diagnostic-summary-meta {
  margin-top: 8px;
  flex-wrap: wrap;
}

.diagnostic-block + .diagnostic-block {
  margin-top: var(--spacing-md);
}

.diagnostic-block-title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.diagnostic-metric {
  margin-top: var(--spacing-sm);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.diagnostic-metric-values {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.diagnostic-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.diagnostic-badge.is-ok {
  color: #67c23a;
  background: rgba(103, 194, 58, 0.14);
}

.diagnostic-badge.is-warning {
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.14);
}

.diagnostic-badge.is-error {
  color: #f56c6c;
  background: rgba(245, 108, 108, 0.14);
}

.diagnostic-badge.is-neutral {
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.08);
}

.diagnostic-finding {
  padding: 8px 10px;
  border-left: 3px solid rgba(245, 108, 108, 0.45);
  background: rgba(245, 108, 108, 0.06);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.diagnostic-finding + .diagnostic-finding {
  margin-top: 8px;
}

/* ─── 分布直方图 ─── */
.histogram-block {
  margin-top: var(--spacing-md);
  padding: 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.histogram-block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-sm);
}

.histogram-block-title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.histogram-hint {
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'Consolas', 'Monaco', monospace;
}

.histogram-chart {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 80px;
  padding: 4px 0;
  position: relative;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.histogram-chart.histogram-single {
  gap: 3px;
}

.histogram-bin-group {
  flex: 1;
  display: flex;
  gap: 1px;
  align-items: flex-end;
  height: 100%;
  min-width: 0;
}

.histogram-bar {
  flex: 1;
  min-height: 1px;
  border-radius: 2px 2px 0 0;
  transition: height 0.2s ease;
  min-width: 0;
}

.histogram-bar.actual {
  background: linear-gradient(180deg, var(--primary-light), var(--primary-color));
  opacity: 0.9;
}

.histogram-bar.target {
  background: rgba(230, 162, 60, 0.5);
  border: 1px solid rgba(230, 162, 60, 0.7);
  border-bottom: none;
}

.histogram-bar.single {
  flex: 1;
  background: linear-gradient(180deg, rgba(103, 194, 58, 0.8), rgba(103, 194, 58, 0.4));
  border-radius: 2px 2px 0 0;
}

.histogram-legend {
  margin-top: 6px;
  display: flex;
  gap: var(--spacing-md);
  font-size: 11px;
  color: var(--text-muted);
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.legend-dot.actual {
  background: var(--primary-color);
}

.legend-dot.target {
  background: rgba(230, 162, 60, 0.5);
  border: 1px solid rgba(230, 162, 60, 0.7);
}

/* 均值/P95 竖线标记 */
.histogram-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  pointer-events: none;
  z-index: 1;
}

.histogram-marker.mean {
  background: rgba(64, 158, 255, 0.8);
  box-shadow: 0 0 4px rgba(64, 158, 255, 0.5);
}

.histogram-marker.p95 {
  background: rgba(245, 108, 108, 0.8);
  box-shadow: 0 0 4px rgba(245, 108, 108, 0.5);
}

/* ─── 能量与堆积 ─── */
.energy-bar-container {
  height: 12px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  overflow: hidden;
  margin-top: 6px;
}

.energy-bar-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.3s ease;
}

.energy-bar-fill.is-ok { background: linear-gradient(90deg, #67c23a, #4e9e2e); }
.energy-bar-fill.is-warning { background: linear-gradient(90deg, #e6a23c, #c4852e); }
.energy-bar-fill.is-error { background: linear-gradient(90deg, #f56c6c, #c94e4e); }

.energy-chart {
  width: 100%;
  height: 60px;
  margin-top: 6px;
  display: block;
}
</style>
