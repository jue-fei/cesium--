<template>
  <div>
    <!-- 炮孔布置图 -->
    <div class="section">
      <div class="section-title">炮孔布置（掌子面）</div>
      <div v-if="!blastDesign" class="hint">请先加载爆破数据以生成炮孔布置图。</div>
      <template v-else>
        <div class="hole-layout-wrap" @click="closeHolePopover">
          <svg
            :viewBox="`0 0 ${holeLayoutSize} ${holeLayoutSize}`"
            class="hole-layout-svg"
            @click="closeHolePopover"
          >
            <path :d="tunnelOutlinePath" fill="#1a1a1a" stroke="#888" stroke-width="1.5" />
            <circle
              v-for="(h, i) in blastDesign.holes"
              :key="i"
              :cx="holeToSvgX(h.x)"
              :cy="holeToSvgY(h.y)"
              :r="h.isEmpty ? 4 : 2.5"
              :fill="holeColor(h)"
              :stroke="h.isEmpty ? '#fff' : 'none'"
              :stroke-width="h.isEmpty ? 0.8 : 0"
              class="hole-point"
              @click.stop="onHoleClick(h, $event)"
            />
            <g class="hole-legend">
              <circle :cx="holeLayoutSize - 90" :cy="14" r="2.5" fill="#ff6b6b" />
              <text :x="holeLayoutSize - 82" :y="17" fill="#ccc" font-size="9">掏槽</text>
              <circle :cx="holeLayoutSize - 90" :cy="28" r="2.5" fill="#feca57" />
              <text :x="holeLayoutSize - 82" :y="31" fill="#ccc" font-size="9">辅助</text>
              <circle :cx="holeLayoutSize - 50" :cy="14" r="2.5" fill="#1dd1a1" />
              <text :x="holeLayoutSize - 42" :y="17" fill="#ccc" font-size="9">周边</text>
              <circle
                :cx="holeLayoutSize - 50"
                :cy="28"
                r="4"
                fill="#fff"
                stroke="#888"
                stroke-width="0.8"
              />
              <text :x="holeLayoutSize - 42" :y="31" fill="#ccc" font-size="9">空孔</text>
            </g>
          </svg>
          <el-popover
            :virtual-ref="holePopoverRef"
            virtual-triggering
            :visible="holePopoverVisible"
            placement="right"
            :width="200"
            trigger="click"
            @hide="closeHolePopover"
          >
            <template #reference><span></span></template>
            <div v-if="selectedHoleDetail" class="hole-detail-pop">
              <div class="hole-detail-title">炮孔参数</div>
              <div class="stat">
                <span>类型</span><span class="stat-val">{{ selectedHoleDetail.typeLabel }}</span>
              </div>
              <div class="stat">
                <span>装药量</span><span class="stat-val">{{ selectedHoleDetail.charge }} kg</span>
              </div>
              <div class="stat">
                <span>延时</span><span class="stat-val">{{ selectedHoleDetail.delay }} ms</span>
              </div>
              <div class="stat">
                <span>孔深</span><span class="stat-val">{{ selectedHoleDetail.depth }} m</span>
              </div>
              <div class="stat">
                <span>坐标</span
                ><span class="stat-val"
                  >({{ selectedHoleDetail.x.toFixed(2) }},
                  {{ selectedHoleDetail.y.toFixed(2) }})</span
                >
              </div>
            </div>
          </el-popover>
        </div>
        <div class="row mt-2" style="gap: 14px">
          <span class="hint"
            >总孔数 <b class="stat-val">{{ blastDesign.counts.total }}</b></span
          >
          <span class="hint"
            >掏槽 <b class="stat-val">{{ blastDesign.counts.cut }}</b></span
          >
          <span class="hint"
            >辅助 <b class="stat-val">{{ blastDesign.counts.auxiliary }}</b></span
          >
          <span class="hint"
            >周边 <b class="stat-val">{{ blastDesign.counts.perimeter }}</b></span
          >
          <span class="hint"
            >断面
            <b class="stat-val"
              >{{ blastDesign.section.W }}m × {{ blastDesign.section.totalH.toFixed(1) }}m</b
            ></span
          >
          <span class="hint"
            >面积 <b class="stat-val">{{ blastDesign.section.area.toFixed(2) }} m²</b></span
          >
        </div>
        <div class="row mt-1" style="gap: 14px">
          <span class="hint"
            >进尺 <b class="stat-val">{{ blastDesign.advanceDepth.toFixed(2) }} m</b></span
          >
          <span class="hint"
            >方量 <b class="stat-val">{{ blastDesign.volumePerRound.toFixed(2) }} m³</b></span
          >
          <span class="hint"
            >单耗 <b class="stat-val">{{ blastDesign.charge.specific.toFixed(3) }} kg/m³</b></span
          >
          <span class="hint"
            >总药量 <b class="stat-val">{{ blastDesign.charge.total.toFixed(1) }} kg</b></span
          >
        </div>
      </template>
    </div>

    <!-- 块度分布 -->
    <div v-if="hasDistribution" class="section">
      <div class="section-title">块度分布</div>
      <div class="chart-block">
        <div
          v-for="b in buckets"
          :key="b.label"
          class="chart-row"
          :class="{ active: activeBucketLabel === b.label }"
          @click="onBucketClick(b)"
        >
          <div class="chart-label" :title="b.label">{{ b.label }}</div>
          <div class="chart-track">
            <div
              class="chart-fill"
              :class="{ active: activeBucketLabel === b.label }"
              :style="{ width: barWidth(b.percentage) }"
            ></div>
          </div>
          <div class="chart-pct">{{ b.percentage.toFixed(1) }}%</div>
        </div>
      </div>
      <div class="hint-sm">点击区间行可在 3D 场景中高亮对应块度范围的碎片。</div>
      <div v-if="activeBucketLabel" class="row mt-1">
        <button class="btn danger" @click="clearHighlight">清除高亮</button>
        <span class="hint">当前：{{ activeBucketLabel }}</span>
      </div>
    </div>

    <!-- 块度分布对比：等质量采样直方图 vs Swebrec 理论曲线 -->
    <div v-if="cmpChart" class="section">
      <div class="section-title-row">
        <div class="section-title">块度分布（等质量采样 vs Swebrec 理论）</div>
        <div class="kl-chip" :class="klTone">
          <span class="kl-label">KL 散度</span>
          <span class="kl-val">{{ klValueDisplay }}</span>
          <span class="kl-note">{{ klNote }}</span>
        </div>
      </div>
      <div class="chart-compare-wrap">
        <svg :viewBox="`0 0 ${cmpChart.W} ${cmpChart.H}`" class="chart-compare-svg">
          <!-- 横向网格线 + y 轴刻度 -->
          <line
            v-for="(gy, gi) in cmpChart.yGrid"
            :key="'grid' + gi"
            :x1="cmpChart.left"
            :x2="cmpChart.W - cmpChart.padR"
            :y1="gy"
            :y2="gy"
            class="cmp-grid"
          />
          <g v-for="(yt, yi) in cmpChart.yTicks" :key="'ytick' + yi" class="cmp-tick-x">
            <text :x="cmpChart.left - 6" :y="yt.y + 3" class="cmp-tick-label">{{ yt.label }}</text>
          </g>
          <!-- 采样直方图 -->
          <rect
            v-for="(bar, i) in cmpChart.bars"
            :key="'bar' + i"
            :x="bar.x"
            :y="bar.y"
            :width="cmpChart.barW"
            :height="bar.height"
            class="cmp-bar sampled"
          />
          <!-- Swebrec 理论分布曲线 -->
          <polyline :points="cmpChart.theoryPoints" class="cmp-curve" />
          <circle
            v-for="(p, i) in cmpChart.curvePts"
            :key="'dot' + i"
            :cx="p.x"
            :cy="p.y"
            r="2.2"
            class="cmp-dot"
          />
          <!-- x 轴刻度（物理尺寸） -->
          <g v-for="(xt, xi) in cmpChart.xTicks" :key="'xtick' + xi" class="cmp-tick-y">
            <line
              :x1="xt.x"
              :x2="xt.x"
              :y1="cmpChart.baseline"
              :y2="cmpChart.baseline + 3"
              class="cmp-tick-mark"
            />
            <text :x="xt.x" :y="cmpChart.H - 8" class="cmp-tick-label" text-anchor="middle">
              {{ xt.label }}
            </text>
          </g>
          <!-- 坐标轴框 -->
          <line
            :x1="cmpChart.left"
            :x2="cmpChart.left"
            :y1="cmpChart.padT"
            :y2="cmpChart.baseline"
            class="cmp-frame"
          />
          <line
            :x1="cmpChart.left"
            :x2="cmpChart.W - cmpChart.padR"
            :y1="cmpChart.baseline"
            :y2="cmpChart.baseline"
            class="cmp-frame"
          />
          <!-- 轴标题 -->
          <text :x="12" :y="9" class="cmp-axis" text-anchor="middle" transform="rotate(-90 12 9)">
            质量占比 (%)
          </text>
          <text
            :x="cmpChart.left + cmpChart.plotW / 2"
            :y="cmpChart.H - 2"
            class="cmp-axis"
            text-anchor="middle"
          >
            块度尺寸 {{ cmpChart.unit }}
          </text>
        </svg>
        <div class="chart-legend">
          <span class="legend-item sampled"><i class="sw"></i>等质量采样直方图</span>
          <span class="legend-item theory"><i class="sw"></i>Swebrec 理论分布</span>
        </div>
      </div>
      <div class="hint-sm">
        KL 散度越小，等质量采样直方图越贴近 Swebrec 理论分布，采样质量越高。
      </div>
    </div>

    <!-- KCO 参数面板 -->
    <BlastKcoPanel
      :dataset="dataset"
      :blast-design="blastDesign"
      :kco-model="kcoModel"
      @update-kco="emit('update-kco', $event)"
      @replay-blast="emit('replay-blast')"
      @reset-kco="emit('reset-kco')"
      @update-section="emit('update-section', $event)"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import BlastKcoPanel from './BlastKcoPanel.vue'

defineOptions({ name: 'BlastDesign' })

const props = defineProps({
  dataset: { type: Object, default: null },
  blastDesign: { type: Object, default: null },
  kcoModel: { type: Object, required: true },
  distribution: { type: Object, default: null },
  threeStats: { type: Object, default: null }
})

const emit = defineEmits([
  'replay-blast',
  'reset-kco',
  'update-section',
  'update-kco',
  'highlight-size',
  'clear-highlight'
])

// ─── 炮孔布置图 SVG ──────────────────────
const holeLayoutSize = 220
const holeLayoutPadding = 16

const holeLayoutScale = computed(() => {
  if (!props.blastDesign) return 1
  const W = props.blastDesign.section.W
  const H = props.blastDesign.section.totalH
  const usable = holeLayoutSize - holeLayoutPadding * 2
  return Math.min(usable / W, usable / H)
})

const holeLayoutOffset = computed(() => {
  if (!props.blastDesign) return { x: 0, y: 0 }
  const W = props.blastDesign.section.W
  const H = props.blastDesign.section.totalH
  const s = holeLayoutScale.value
  return { x: (holeLayoutSize - W * s) / 2, y: (holeLayoutSize - H * s) / 2 }
})

function holeToSvgX(x) {
  const W = props.blastDesign?.section.W || 1
  const s = holeLayoutScale.value
  const off = holeLayoutOffset.value
  return off.x + (x + W / 2) * s
}
function holeToSvgY(y) {
  const s = holeLayoutScale.value
  const off = holeLayoutOffset.value
  const H = props.blastDesign?.section.totalH || 1
  return off.y + (H - y) * s
}

const tunnelOutlinePath = computed(() => {
  if (!props.blastDesign) return ''
  const { W, Hw } = props.blastDesign.section
  const xL = holeToSvgX(-W / 2)
  const xR = holeToSvgX(W / 2)
  const yBottom = holeToSvgY(0)
  const yWallTop = holeToSvgY(Hw)
  const rx = (xR - xL) / 2
  return `M ${xL} ${yBottom} L ${xL} ${yWallTop} A ${rx} ${rx} 0 0 1 ${xR} ${yWallTop} L ${xR} ${yBottom} Z`
})

function holeColor(h) {
  if (h.isEmpty) return '#ffffff'
  switch (h.type) {
    case 'cut':
      return '#ff6b6b'
    case 'auxiliary':
      return '#feca57'
    case 'perimeter':
      return '#1dd1a1'
    default:
      return '#888'
  }
}

// ─── 炮孔交互 ────────────────────────────
const HOLE_TYPE_LABELS = { cut: '掏槽孔', auxiliary: '辅助孔', perimeter: '周边孔' }
const selectedHole = ref(null)
const holePopoverRef = ref(null)
const holePopoverVisible = ref(false)

function calculateHoleCharge(hole, design) {
  if (!hole || hole.isEmpty || !design) return 0
  const charge = design.charge || {}
  const counts = design.counts || {}
  if (hole.type === 'cut' && counts.cut) return charge.cut / counts.cut
  if (hole.type === 'auxiliary' && counts.auxiliary) return charge.auxiliary / counts.auxiliary
  if (hole.type === 'perimeter' && counts.perimeter) return charge.perimeter / counts.perimeter
  return 0
}

const selectedHoleDetail = computed(() => {
  const h = selectedHole.value
  const d = props.blastDesign
  if (!h || !d) return null
  const typeLabel = h.isEmpty ? '空孔' : HOLE_TYPE_LABELS[h.type] || '未知'
  const depth = d.holeDepth ?? 0
  const charge = calculateHoleCharge(h, d)
  // 延时取孔位真实 delayMs（由设计数据/延时网络推导），空孔无装药延时为 0
  const delay = h.isEmpty ? 0 : Number(h.delayMs) || 0
  return {
    typeLabel,
    charge: charge.toFixed(2),
    delay,
    depth: depth.toFixed(2),
    isEmpty: !!h.isEmpty,
    x: Number.isFinite(Number(h.x)) ? Number(h.x) : 0,
    y: Number.isFinite(Number(h.y)) ? Number(h.y) : 0
  }
})

function onHoleClick(h, event) {
  // 再次点击同一孔洞，或弹窗已打开时点击任意孔洞，关闭弹窗
  if (holePopoverVisible.value) {
    closeHolePopover()
    return
  }
  selectedHole.value = h
  holePopoverRef.value = event?.target || null
  holePopoverVisible.value = true
}
function closeHolePopover() {
  holePopoverVisible.value = false
}

// ─── 块度分布 ────────────────────────────
const activeBucketLabel = ref(null)
const buckets = computed(() => props.distribution?.buckets || [])
const hasDistribution = computed(
  () =>
    !!props.distribution &&
    Array.isArray(props.distribution.buckets) &&
    props.distribution.total > 0
)

function barWidth(pct) {
  const v = Number(pct) || 0
  if (v <= 0) return '0%'
  return Math.min(100, v).toFixed(1) + '%'
}

function onBucketClick(bucket) {
  if (activeBucketLabel.value === bucket.label) {
    activeBucketLabel.value = null
    emit('clear-highlight')
    return
  }
  activeBucketLabel.value = bucket.label
  const max = bucket.max == null ? Infinity : bucket.max
  emit('highlight-size', { min: bucket.min, max })
}

function clearHighlight() {
  activeBucketLabel.value = null
  emit('clear-highlight')
}

// ─── 块度分布对比图（等质量采样直方图 vs Swebrec 理论曲线 + KL 散度） ─────
const CHART = { W: 320, H: 176, padL: 36, padR: 10, padT: 14, padB: 24 }

// 便于与三位 Stats 直接对齐：采样/理论直方图已由 fragmentSpecGenerator 在相同
// 分箱边界（0..xmax，20 箱）下生成，KL 散度即两者 pct 的形态差异。
const cmpChart = computed(() => {
  const s = props.threeStats?.sizeHistogramGenerated
  const t = props.threeStats?.sizeHistogramTarget
  if (!Array.isArray(s) || s.length === 0 || !Array.isArray(t) || t.length !== s.length) {
    return null
  }
  const n = s.length
  const W = CHART.W
  const H = CHART.H
  const padR = 10
  const left = CHART.padL
  const plotW = W - left - padR
  const plotH = H - CHART.padT - CHART.padB
  const maxRaw = Math.max(0.01, ...s.map(b => b.pct), ...t.map(b => b.pct))
  const maxY = maxRaw * 1.12 // 顶部留 12% 余量
  const baseline = CHART.padT + plotH
  const y = v => CHART.padT + (1 - v / maxY) * plotH
  const x = i => left + ((i + 0.5) / n) * plotW
  const barW = (plotW / n) * 0.66

  const bars = s.map((b, i) => {
    const v = Math.max(0, b.pct) * 100
    return { x: x(i) - barW / 2, y: y(v), height: Math.max(0, baseline - y(v)), pct: v }
  })
  const curvePts = t.map((b, i) => ({ x: x(i), y: y(Math.max(0, b.pct) * 100) }))
  const theoryPoints = curvePts
    .map((p, i) => `${p.x.toFixed(2)},${p.y.toFixed(2)}${i < curvePts.length - 1 ? ' ' : ''}`)
    .join('')
  // y 网格：0/25/50/75/100% maxY
  const yGrid = [0, 0.25, 0.5, 0.75, 1].map(k => y(k * maxY))
  const yTicks = [0, 0.25, 0.5, 0.75, 1]
    .map(k => ({ y: y(k * maxY), label: (k * maxY).toFixed(0) }))
    .slice(0, 5)
  // x 物理尺寸刻度：线性 0→xmax，均匀取 5 档；块度直方图为 0..xmax 等宽分箱
  const maxSize = Number(props.threeStats?.xmaxApplied) || 2.0
  const fmt = v => (v < 0.01 ? '0' : v.toFixed(v < 1 ? 2 : 1))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(k => ({
    x: left + k * plotW,
    label: fmt(maxSize * k)
  }))
  return {
    W,
    H,
    left,
    padR,
    plotW,
    baseline,
    barW,
    bars,
    curvePts,
    theoryPoints,
    yGrid,
    yTicks,
    xTicks,
    unit: '(m)'
  }
})

const klValue = computed(() => props.threeStats?.sizeKLDivergence)
const klValueDisplay = computed(() =>
  Number.isFinite(klValue.value) ? klValue.value.toFixed(4) : '—'
)
const klTone = computed(() => {
  if (!Number.isFinite(klValue.value)) return 'muted'
  const v = klValue.value
  if (v < 0.05) return 'ok'
  if (v < 0.2) return 'warn'
  return 'bad'
})
const klNote = computed(() => {
  if (!Number.isFinite(klValue.value)) return ''
  const v = klValue.value
  if (v < 0.05) return '贴合理论'
  if (v < 0.2) return '基本贴合'
  return '偏差较大'
})
</script>

<style scoped>
.hole-layout-wrap {
  padding: 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  display: flex;
  justify-content: center;
}
.hole-layout-svg {
  width: 100%;
  max-width: 240px;
  height: auto;
}
.hole-point {
  cursor: pointer;
  transition: r 0.12s ease;
}
.hole-point:hover {
  r: 5;
}
.hole-detail-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}
.chart-block {
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.chart-fill.active {
  background: linear-gradient(90deg, rgba(255, 154, 0, 0.6), #ff9a00);
}
.hole-detail-pop {
  line-height: 1.8;
}

/* ─── 块度分布对比图（采样 vs Swebrec 理论） ─── */
.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.chart-compare-wrap {
  padding: 8px 8px 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.chart-compare-svg {
  width: 100%;
  height: auto;
  display: block;
}
.cmp-grid {
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 1;
}
.cmp-frame {
  stroke: rgba(255, 255, 255, 0.28);
  stroke-width: 1;
}
.cmp-tick-mark {
  stroke: rgba(255, 255, 255, 0.4);
  stroke-width: 1;
}
.cmp-tick-label {
  font-size: 9px;
  fill: var(--text-muted);
  font-family: 'Consolas', monospace;
}
.cmp-bar {
  rx: 0.5;
}
.cmp-bar.sampled {
  fill: rgba(45, 200, 140, 0.55);
}
.cmp-curve {
  fill: none;
  stroke: #4aa3ff;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.cmp-dot {
  fill: #4aa3ff;
}
.cmp-axis {
  font-size: 9px;
  fill: var(--text-muted);
  font-family: 'Consolas', monospace;
}
.chart-legend {
  display: flex;
  gap: 14px;
  justify-content: center;
  padding: 6px 0 2px;
  font-size: 11px;
  color: var(--text-secondary);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend-item .sw {
  width: 12px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}
.legend-item.sampled .sw {
  background: rgba(45, 200, 140, 0.8);
}
.legend-item.theory .sw {
  background: #4aa3ff;
}
.kl-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-family: 'Consolas', monospace;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
}
.kl-chip .kl-label {
  font-size: 10px;
  color: var(--text-muted);
  font-family: inherit;
}
.kl-chip .kl-val {
  font-size: 12px;
  font-weight: 700;
}
.kl-chip .kl-note {
  font-size: 10px;
}
.kl-chip.ok {
  border-color: rgba(45, 200, 140, 0.5);
}
.kl-chip.ok .kl-val,
.kl-chip.ok .kl-note {
  color: #2dc88c;
}
.kl-chip.warn {
  border-color: rgba(240, 173, 78, 0.5);
}
.kl-chip.warn .kl-val,
.kl-chip.warn .kl-note {
  color: #f0ad4e;
}
.kl-chip.bad {
  border-color: rgba(231, 76, 60, 0.55);
}
.kl-chip.bad .kl-val,
.kl-chip.bad .kl-note {
  color: #e74c3c;
}
.kl-chip.muted .kl-val {
  color: var(--text-muted);
}
</style>
