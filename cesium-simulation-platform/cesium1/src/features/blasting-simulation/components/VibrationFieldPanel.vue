<template>
  <div>
    <!-- 模式选择 -->
    <div class="section">
      <div class="section-title">振动场模式</div>
      <div class="row">
        <button
          v-for="m in vibrationModes"
          :key="m.key"
          class="btn"
          :class="{ primary: vibrationMode === m.key }"
          :disabled="!isModeReady(m.key)"
          :title="m.label"
          @click="$emit('set-vibration-mode', m.key)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="hint-sm mt-1">三种热力图渲染模式，叠加显示于岩体表面。</div>
      <div class="row mt-1">
        <button
          class="btn"
          :class="{ primary: whiteModelEnabled }"
          @click="$emit('toggle-white-model', !whiteModelEnabled)"
        >
          {{ whiteModelEnabled ? '白模底材：开' : '白模底材：关' }}
        </button>
        <span class="pick-hint">开：热力色以白色底显示；关：保留岩石纹理底</span>
      </div>
    </div>

    <!-- 萨道夫斯基场地参数 -->
    <div class="section">
      <div class="section-title">萨道夫斯基参数（K, α）</div>
      <div class="row">
        <label class="param-field">
          <span class="param-label">K</span>
          <input
            v-model="kInput"
            class="param-input"
            type="number"
            min="1"
            step="5"
            placeholder="场地常数"
          />
        </label>
        <label class="param-field">
          <span class="param-label">α</span>
          <input
            v-model="alphaInput"
            class="param-input"
            type="number"
            min="0.5"
            max="3"
            step="0.1"
            placeholder="衰减指数"
          />
        </label>
        <button class="btn primary" :disabled="!hasEvent" @click="applySadosky">应用</button>
      </div>
      <div class="preset-row">
        <label class="param-field">
          <span class="param-label">文献标定集</span>
          <select v-model="presetKey" class="param-input" @change="applyPreset">
            <option value="__none__" disabled>选择现场标定参数…</option>
            <option v-for="p in sadoskyPresets" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
        </label>
      </div>
      <div class="hint-sm mt-1">
        PPV = K·(Q<sup>1/3</sup>/R)<sup>α</sup>，默认
        K=30、α=1.5（隧道局部尺度）。可选文献实测标定集快速反标定。
      </div>
    </div>

    <!-- 场点采样：点击场景内任意点查询该点 PPV / 应力 / 损伤 -->
    <div v-if="vibrationFieldInfo" class="section">
      <div class="section-title">场点采样</div>
      <div class="row">
        <button
          class="btn"
          :class="{ primary: ppvPickEnabled }"
          @click="$emit('toggle-ppv-pick', !ppvPickEnabled)"
        >
          {{ ppvPickEnabled ? '停止采样' : '启动采样' }}
        </button>
        <span class="pick-hint">启用后点击岩体任一点，显示该点实测值</span>
      </div>
      <div v-if="pickedPpv" class="pick-result" :class="{ miss: !pickedPpv.inside }">
        <template v-if="pickedPpv.inside">
          <div class="pick-line">
            <span>该点 PPV</span><b>{{ pickedPpv.ppvCmps.toFixed(2) }} cm/s</b>
          </div>
          <div class="pick-line">
            <span>等效应力 σ_vm</span><b>{{ fmtStress(pickedPpv.stressMPa) }}</b>
          </div>
          <div class="pick-line">
            <span>损伤分区</span><b>{{ zoneLabel }}</b>
          </div>
          <div class="pick-line sub">
            <span>网格坐标</span><b>{{ fmtGrid }}</b>
          </div>
        </template>
        <template v-else>
          <div class="pick-line"><span>命中点</span><b>场外（未在振动场内）</b></div>
        </template>
      </div>
      <div v-else class="hint-sm">尚未拾取。采样结果按当前 K/α 实时插值计算。</div>
    </div>

    <!-- 色阶图例 -->
    <div class="section">
      <div class="section-title">图例</div>
      <div v-if="vibrationFieldInfo" class="legend">
        <template v-if="vibrationMode === 'ppv'">
          <div class="legend-title">PPV 峰值速度 (cm/s)</div>
          <div
            class="legend-bar"
            :style="{ background: `linear-gradient(to right, ${ppvGradient})` }"
          ></div>
          <div class="legend-ticks">
            <span v-for="t in ppvTicks" :key="t">{{ t }}</span>
          </div>
        </template>
        <template v-else-if="vibrationMode === 'stress'">
          <div class="legend-title">σ_vm 等效应力 (MPa)</div>
          <div
            class="legend-bar"
            :style="{ background: `linear-gradient(to right, ${stressGradient})` }"
          ></div>
          <div class="legend-ticks">
            <span v-for="t in stressTicks" :key="t">{{ t }}</span>
          </div>
        </template>
        <template v-else>
          <div class="legend-title">损伤分区</div>
          <div class="damage-legend-grid">
            <span
              v-for="d in damageLegend"
              :key="d.zone"
              class="damage-swatch-item"
              :style="{ background: d.c, opacity: d.zone === 0 ? 0.35 : 1 }"
              >{{ d.zone }} {{ d.label }}</span
            >
          </div>
        </template>
      </div>
      <div v-else class="hint-sm">加载事件并启动推送后显示振动场</div>
    </div>

    <!-- 场数据查询 -->
    <div v-if="vibrationFieldInfo" class="section">
      <div class="section-title">场数据</div>
      <div class="field-grid">
        <div class="field-item">
          <span class="field-label">当前模式</span>
          <span class="field-value">{{ modeLabel }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">模拟时刻</span>
          <span class="field-value">{{ formatT(lastT) }} s</span>
        </div>
        <div class="field-item">
          <span class="field-label">帧号</span>
          <span class="field-value">{{ lastFrame }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">网格尺寸</span>
          <span class="field-value">{{ gridShapeText }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">体素总数</span>
          <span class="field-value">{{ voxelCountText }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">X 范围</span>
          <span class="field-value">{{ boundsX }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">Y 范围</span>
          <span class="field-value">{{ boundsY }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">Z 范围</span>
          <span class="field-value">{{ boundsZ }}</span>
        </div>
      </div>
    </div>

    <!-- 数据就绪状态 -->
    <div class="section">
      <div class="section-title">数据状态</div>
      <div class="ready-list">
        <div class="ready-row">
          <span class="ready-label">PPV 振动</span>
          <span class="ready-badge" :class="readyPpv ? 'ok' : 'pending'">{{
            readyPpv ? '已就绪' : '等待中'
          }}</span>
        </div>
        <div class="ready-row">
          <span class="ready-label">σ_vm 应力</span>
          <span class="ready-badge" :class="readyStress ? 'ok' : 'pending'">{{
            readyStress ? '已就绪' : '等待中'
          }}</span>
        </div>
        <div class="ready-row">
          <span class="ready-label">损伤分区</span>
          <span class="ready-badge" :class="readyDamage ? 'ok' : 'pending'">{{
            readyDamage ? '已就绪' : '等待中'
          }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  PPV_TICKS,
  STRESS_TICKS,
  DAMAGE_LEGEND,
  PPV_LEGEND_STOPS,
  PPV_LEGEND_MAX,
  STRESS_LEGEND_STOPS,
  STRESS_LEGEND_MAX,
  gradientCss
} from '../services/core/rendering/vibrationColorScales.js'

defineOptions({ name: 'VibrationFieldPanel' })

const props = defineProps({
  vibrationModes: { type: Array, default: () => [] },
  vibrationMode: { type: String, default: 'ppv' },
  vibrationFieldInfo: { type: Object, default: null },
  sadoskyParams: { type: Object, default: () => ({ k: 30, alpha: 1.5 }) },
  ppvPickEnabled: { type: Boolean, default: false },
  pickedPpv: { type: Object, default: null },
  // 振动场底材"白模"开关（true=白模底，false=保留岩石纹理底）
  whiteModelEnabled: { type: Boolean, default: false }
})

const emit = defineEmits([
  'set-vibration-mode',
  'update-sadosky-params',
  'toggle-ppv-pick',
  'toggle-white-model'
])

// 萨道夫斯基参数本地编辑态（外部 props 变化时同步）
const kInput = ref(30)
const alphaInput = ref(1.5)
watch(
  () => [props.sadoskyParams?.k, props.sadoskyParams?.alpha],
  ([k, alpha]) => {
    if (Number.isFinite(Number(k)) && Number(k) > 0) kInput.value = Number(k)
    if (Number.isFinite(Number(alpha)) && Number(alpha) > 0) alphaInput.value = Number(alpha)
  },
  { immediate: true }
)

const hasEvent = computed(() => !!props.vibrationFieldInfo)

function applySadosky() {
  const k = Number(kInput.value)
  const alpha = Number(alphaInput.value)
  if (!Number.isFinite(k) || k <= 0) return
  if (!Number.isFinite(alpha) || alpha <= 0) return
  emit('update-sadosky-params', { k, alpha })
}

// 文献实测的萨道夫斯基标定集（便于用真实场地参数反标定 PPV 场）
const sadoskyPresets = [
  { key: 'preset_default', label: '平台默认 · 中硬岩（K=200, α=1.5）', k: 200, alpha: 1.5 },
  {
    key: 'preset_tunnel_near_xu',
    label: '三棱山隧道近场 r<110m（K=19.3, α=1.082·徐言2020）',
    k: 19.3,
    alpha: 1.082
  },
  {
    key: 'preset_tunnel_far_xu',
    label: '三棱山隧道远场 r>110m（K=1.23, α=0.372·徐言2020）',
    k: 1.23,
    alpha: 0.372
  },
  {
    key: 'preset_open_300_yan',
    label: '露天铁矿 300°线（K=165.9, α=1.418·闫常陆2018）',
    k: 165.9,
    alpha: 1.418
  },
  {
    key: 'preset_open_285_yan',
    label: '露天铁矿 285°线（K=165.8, α=1.476·闫常陆2018）',
    k: 165.8,
    alpha: 1.476
  },
  {
    key: 'preset_open_m30_yan',
    label: '露天铁矿 -30m 平台（K=236.5, α=1.531·闫常陆2018）',
    k: 236.5,
    alpha: 1.531
  }
]
const presetKey = ref('__none__')
function applyPreset() {
  const p = sadoskyPresets.find(x => x.key === presetKey.value)
  if (!p) return
  kInput.value = p.k
  alphaInput.value = p.alpha
  applySadosky()
}

const ppvTicks = PPV_TICKS
const stressTicks = STRESS_TICKS
const damageLegend = DAMAGE_LEGEND
const ppvGradient = gradientCss(PPV_LEGEND_STOPS, PPV_LEGEND_MAX)
const stressGradient = gradientCss(STRESS_LEGEND_STOPS, STRESS_LEGEND_MAX)

const modeLabel = computed(() => {
  const m = (props.vibrationModes || []).find(x => x.key === props.vibrationMode)
  return m ? m.label : props.vibrationMode
})
const lastT = computed(() => props.vibrationFieldInfo?.lastT)
const lastFrame = computed(() => props.vibrationFieldInfo?.lastFrame ?? 0)
const gridShapeText = computed(() => (props.vibrationFieldInfo?.gridShape || []).join('×') || '-')
const voxelCountText = computed(() => {
  const v = props.vibrationFieldInfo?.voxelCount
  return v ? v.toLocaleString() : '-'
})
const boundsX = computed(() =>
  fmtBounds(props.vibrationFieldInfo?.boundsMin?.[0], props.vibrationFieldInfo?.boundsMax?.[0])
)
const boundsY = computed(() =>
  fmtBounds(props.vibrationFieldInfo?.boundsMin?.[1], props.vibrationFieldInfo?.boundsMax?.[1])
)
const boundsZ = computed(() =>
  fmtBounds(props.vibrationFieldInfo?.boundsMin?.[2], props.vibrationFieldInfo?.boundsMax?.[2])
)

const readyPpv = computed(() => !!props.vibrationFieldInfo?.hasPpv)
const readyStress = computed(() => !!props.vibrationFieldInfo?.hasStress)
const readyDamage = computed(() => !!props.vibrationFieldInfo?.hasDamage)

function fmtBounds(min, max) {
  if (min == null || max == null) return '-'
  return `${Number(min).toFixed(1)} ~ ${Number(max).toFixed(1)} m`
}
function isModeReady(key) {
  // 三种显示模式共用同一套萨道夫斯基解析场（岩体片元着色器逐片元解析计算，
  // 不依赖"某一场已收到纹理帧"），PPV/应力/损伤只有取色公式不同、无需等待
  // 后端推送即可渲染。故只要事件/场景已加载（vibrationFieldInfo 存在），
  // 三种模式即可自由切换；下方"数据状态"徽标仅作为纹理帧是否已到的信息提示。
  if (!props.vibrationFieldInfo) return false
  if (!props.vibrationModes?.some(m => m.key === key)) return false
  return true
}
function formatT(t) {
  const v = Number(t)
  return Number.isFinite(v) ? v.toFixed(3) : '0.000'
}

// 场点拾取结果的格式化/分区映射
function fmtStress(MPa) {
  if (MPa == null || !Number.isFinite(MPa)) return '—'
  return `${MPa.toFixed(2)} MPa`
}
const zoneLabel = computed(() => {
  const z = props.pickedPpv?.zone
  if (z == null) return '—'
  const d = damageLegend.find(x => x.zone === z)
  return d ? `${z} ${d.label}` : String(z)
})
const fmtGrid = computed(() => {
  const p = props.pickedPpv
  if (!p || p.gridX == null) return '—'
  return `${p.gridX.toFixed(1)}, ${p.gridY.toFixed(1)}, ${p.gridZ.toFixed(1)}`
})
</script>

<style scoped>
.mt-1 {
  margin-top: 6px;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.param-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 72px;
}
.param-label {
  font-size: 11px;
  color: var(--text-muted);
}
.param-input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
  font-size: 13px;
}
.param-input:focus {
  outline: none;
  border-color: var(--primary-color);
}
.legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.legend-title {
  font-size: 12px;
  color: var(--text-muted);
}
.legend-bar {
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.legend-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.damage-legend-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.damage-swatch-item {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  color: #fff;
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.field-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.field-label {
  font-size: 11px;
  color: var(--text-muted);
}
.field-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.ready-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ready-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.ready-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.ready-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
}
.ready-badge.ok {
  color: #67c23a;
  background: rgba(103, 194, 58, 0.15);
}
.ready-badge.pending {
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.15);
}

.preset-row {
  margin-top: 8px;
}
.font-face select,
select.param-input {
  appearance: none;
}
.pick-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
.pick-result {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(103, 194, 58, 0.08);
  border: 1px solid rgba(103, 194, 58, 0.25);
}
.pick-result.miss {
  background: rgba(230, 162, 60, 0.08);
  border-color: rgba(230, 162, 60, 0.25);
}
.pick-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 13px;
}
.pick-line span {
  color: var(--text-muted);
  font-size: 12px;
}
.pick-line b {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.pick-line.sub b {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}
</style>
