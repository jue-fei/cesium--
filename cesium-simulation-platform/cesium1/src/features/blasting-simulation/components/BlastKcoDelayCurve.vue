<template>
  <div class="section kco-delay-curve">
    <div class="section-title">
      随延时变化的块度分布族
      <label
        class="curve-toggle"
        title="切换为刘步青2026哑巴岭标定工况（B=4 S=6 H=12 d=140mm Q=141.6kg），并叠加实测 D50/D80 数据点（表7）"
      >
        <input v-model="showCalib" type="checkbox" />
        标定工况+实测点
      </label>
    </div>

    <svg
      class="curve-svg"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      aria-label="随延时变化的 Swebrec 质量通过率曲线族"
    >
      <!-- 横向网格 + y 刻度 -->
      <g v-for="t in yTicks" :key="`y${t.p}`">
        <line :x1="PAD.l" :y1="t.y" :x2="W - PAD.r" :y2="t.y" class="grid-line" />
        <text :x="PAD.l - 5" :y="t.y + 3" class="tick-text" text-anchor="end">{{ t.label }}</text>
      </g>
      <!-- 纵向网格 + x 刻度 -->
      <g v-for="t in xTicks" :key="`x${t.v}`">
        <line :x1="t.x" :y1="PAD.t" :x2="t.x" :y2="H - PAD.b" class="grid-line" />
        <text :x="t.x" :y="H - PAD.b + 12" class="tick-text" text-anchor="middle">{{ t.label }}</text>
      </g>
      <!-- 50% / 80% 通过率参考线（实测 D50/D80 的纵坐标位置） -->
      <g v-for="r in refLines" :key="`r${r.p}`">
        <line :x1="PAD.l" :y1="r.y" :x2="W - PAD.r" :y2="r.y" class="ref-line" />
        <text :x="W - PAD.r - 3" :y="r.y - 3" class="ref-text" text-anchor="end">{{ r.label }}</text>
      </g>
      <!-- 轴标题 -->
      <text :x="PAD.l" :y="PAD.t - 5" class="axis-title">质量通过率</text>
      <text :x="W - PAD.r" :y="H - 2" class="axis-title" text-anchor="end">块度 x (mm)</text>
      <!-- 延时分布族曲线（蓝=8ms 细 → 红=32ms 粗） -->
      <path
        v-for="c in curves"
        :key="`c${c.dt}`"
        :d="c.d"
        fill="none"
        :stroke="c.color"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
        class="curve-path"
      >
        <title>{{ c.title }}</title>
      </path>
      <!-- 当前延时曲线（虚线高亮，随面板 Δt 实时更新） -->
      <path v-if="currentCurve" :d="currentCurve.d" fill="none" class="curve-current">
        <title>{{ currentCurve.title }}</title>
      </path>
      <!-- 实测数据点（仅标定工况模式）：圆点=D50（50% 通过率），方块=D80（80% 通过率） -->
      <g v-for="(p, i) in measuredPoints" :key="`m${i}`">
        <circle v-if="p.type === 'd50'" :cx="p.x" :cy="p.y" r="3.2" :fill="p.color" class="point">
          <title>{{ p.title }}</title>
        </circle>
        <rect v-else :x="p.x - 3" :y="p.y - 3" width="6" height="6" :fill="p.color" class="point">
          <title>{{ p.title }}</title>
        </rect>
      </g>
    </svg>

    <div class="legend-row">
      <span class="legend-hint">← 短延时·细</span>
      <span class="legend-ramp" :style="{ background: rampCss }"></span>
      <span class="legend-hint">长延时·粗 →</span>
      <span class="legend-range">Δt 8~32ms</span>
    </div>

    <div class="curve-note">
      <template v-if="showCalib">
        标定工况 B=4 S=6 H=12 d=140mm Q=141.6kg（刘步青2026）；实测点 ● D50 ■ D80（表7），
        修正后预测 D50 RMS 13.8% / D80 RMS 24.5%
      </template>
      <template v-else>按当前面板参数实时预览；勾选"标定工况+实测点"切换到回归标定语境</template>
      <br />
      横轴显示 0~{{ xViewMaxMm }} mm（xmax = {{ xmaxMm }} mm，超出段渐近 100%）
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { calculateKCOParams } from '../services/core/computation/kcoModelCore.js'
import { swebrecCdf } from '../services/core/computation/kcoFormulas.js'

defineOptions({ name: 'BlastKcoDelayCurve' })

const props = defineProps({
  kcoParams: { type: Object, required: true }
})

// 画布与内边距（viewBox 坐标，SVG 宽度 100% 自适应面板）
const W = 360
const H = 236
const PAD = { l: 42, r: 14, t: 18, b: 30 }
const IW = W - PAD.l - PAD.r
const IH = H - PAD.t - PAD.b

// 代表性延时档与配色（蓝→红：短延时细 / 长延时粗）
const DELAY_STEPS = [8, 12, 17, 22, 25, 28, 32]
const STEP_COLORS = ['#3b82f6', '#06b6d4', '#10b981', '#a3e635', '#eab308', '#f97316', '#ef4444']

// 刘步青2026 表7 实测（鞍钢哑巴岭采区，孔间微差 7 组，mm → m）
const MEASURED = [
  { dt: 8, d50: 0.03593, d80: 0.07738 },
  { dt: 12, d50: 0.06042, d80: 0.13778 },
  { dt: 17, d50: 0.07276, d80: 0.17295 },
  { dt: 22, d50: 0.07753, d80: 0.16835 },
  { dt: 25, d50: 0.10105, d80: 0.29797 },
  { dt: 28, d50: 0.1087, d80: 0.20899 },
  { dt: 32, d50: 0.17677, d80: 0.49307 }
]

// 标定工况（与 kcoModelCore.delay.test.js 的 YABALING 工况一致）
const CALIB_PARAMS = {
  Q: 141.6,
  B: 4,
  S: 6,
  H: 12,
  d: 140,
  Ltot: 8,
  drillDeviation: 0.2,
  RMD: 20,
  RDI: 15,
  HF: 25,
  SANFO: 100,
  xmax: 2.0,
  b: 2.0
}

const showCalib = ref(false)

/**
 * 数值化并清洗面板参数：非有限数值直接丢弃（回落 DEFAULT_KCO_PARAMS），
 * 字符串字段（sourceMode/explosiveType）原样保留。
 */
function numericize(src) {
  const out = {}
  for (const key of Object.keys(src || {})) {
    if (key === 'sourceMode' || key === 'explosiveType') {
      out[key] = src[key]
      continue
    }
    const num = Number(src[key])
    if (Number.isFinite(num)) out[key] = num
  }
  return out
}

const effectiveParams = computed(() =>
  showCalib.value ? { ...CALIB_PARAMS } : numericize(props.kcoParams)
)

function buildCurve(dt, params) {
  const p = calculateKCOParams({ ...params, interHoleDelayMs: dt })
  return { dt, x50: p.x50, x80: p.x80, n: p.n, b: p.b, xmax: p.xmax }
}

const stepCurves = computed(() =>
  DELAY_STEPS.map((dt, i) => ({ ...buildCurve(dt, effectiveParams.value), color: STEP_COLORS[i] }))
)

/** 横轴显示上限：覆盖全部曲线的 x80 关键区段（×1.75），不超过 xmax */
const xViewMax = computed(() => {
  const xmax = stepCurves.value[0]?.xmax || 2
  const x80max = Math.max(...stepCurves.value.map(c => c.x80 || 0))
  return Math.max(0.05, Math.min(xmax, x80max * 1.75))
})

const sx = x => PAD.l + (x / xViewMax.value) * IW
const sy = p => PAD.t + (1 - p) * IH

function pathFor(c) {
  const N = 72
  const parts = []
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * xViewMax.value
    const raw = swebrecCdf(x, c.x50, c.xmax, c.n, c.b)
    const p = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    parts.push(`${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)},${sy(p).toFixed(2)}`)
  }
  return parts.join(' ')
}

function fmtMm(v) {
  const mm = (v || 0) * 1000
  return mm >= 10 ? mm.toFixed(0) : mm.toFixed(1)
}

const curves = computed(() =>
  stepCurves.value.map(c => ({
    dt: c.dt,
    d: pathFor(c),
    color: c.color,
    title: `Δt=${c.dt}ms  x50=${fmtMm(c.x50)}mm  x80=${fmtMm(c.x80)}mm`
  }))
)

const currentDelay = computed(() => {
  const v = Number(props.kcoParams?.interHoleDelayMs)
  return Number.isFinite(v) && v > 0 ? v : 0
})

const currentCurve = computed(() => {
  if (!currentDelay.value) return null
  const c = buildCurve(currentDelay.value, effectiveParams.value)
  return {
    d: pathFor(c),
    title: `当前延时 Δt=${currentDelay.value}ms  x50=${fmtMm(c.x50)}mm  x80=${fmtMm(c.x80)}mm`
  }
})

const yTicks = computed(() =>
  [0, 0.25, 0.5, 0.75, 1].map(p => ({ p, y: sy(p), label: `${Math.round(p * 100)}%` }))
)

const refLines = computed(() =>
  [0.5, 0.8].map(p => ({ p, y: sy(p), label: `${Math.round(p * 100)}%` }))
)

/** 1-2-5 nice 刻度 */
function niceTicks(max, count = 4) {
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
  const ticks = []
  for (let v = 0; v <= max * (1 + 1e-9); v += step) ticks.push(v)
  return ticks
}

const xTicks = computed(() =>
  niceTicks(xViewMax.value).map(v => ({
    v,
    x: sx(v),
    label: v === 0 ? '0' : (v * 1000) >= 10 ? String(Math.round(v * 1000)) : (v * 1000).toFixed(1)
  }))
)

const measuredPoints = computed(() => {
  if (!showCalib.value) return []
  const out = []
  for (const m of MEASURED) {
    const color = STEP_COLORS[DELAY_STEPS.indexOf(m.dt)] || '#ffffff'
    if (m.d50 <= xViewMax.value) {
      out.push({
        type: 'd50',
        x: sx(m.d50),
        y: sy(0.5),
        color,
        title: `Δt=${m.dt}ms 实测 D50=${(m.d50 * 1000).toFixed(2)}mm`
      })
    }
    if (m.d80 <= xViewMax.value) {
      out.push({
        type: 'd80',
        x: sx(m.d80),
        y: sy(0.8),
        color,
        title: `Δt=${m.dt}ms 实测 D80=${(m.d80 * 1000).toFixed(2)}mm`
      })
    }
  }
  return out
})

const xViewMaxMm = computed(() => (xViewMax.value * 1000).toFixed(0))
const xmaxMm = computed(() => ((stepCurves.value[0]?.xmax || 2) * 1000).toFixed(0))
const rampCss = computed(() => `linear-gradient(90deg, ${STEP_COLORS.join(',')})`)
</script>

<style scoped>
.kco-delay-curve {
  margin-top: 10px;
}
.curve-toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
}
.curve-toggle input {
  accent-color: var(--primary-color);
  cursor: pointer;
  margin: 0;
}
.curve-svg {
  display: block;
  width: 100%;
}
.grid-line {
  stroke: rgba(128, 128, 128, 0.16);
  stroke-width: 1;
}
.tick-text {
  font-size: 9px;
  fill: var(--text-muted);
  font-family: Consolas, monospace;
}
.ref-line {
  stroke: rgba(128, 128, 128, 0.35);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}
.ref-text {
  font-size: 9px;
  fill: var(--text-muted);
}
.axis-title {
  font-size: 10px;
  fill: var(--text-muted);
}
.curve-path {
  opacity: 0.92;
}
.curve-current {
  stroke: var(--text-primary);
  stroke-width: 2;
  stroke-dasharray: 6 3;
}
.point {
  stroke: var(--text-primary);
  stroke-width: 0.8;
}
.legend-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.legend-hint {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
.legend-ramp {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  opacity: 0.9;
}
.legend-range {
  font-size: 10px;
  color: var(--text-muted);
  font-family: Consolas, monospace;
  white-space: nowrap;
}
.curve-note {
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.5;
}
</style>
