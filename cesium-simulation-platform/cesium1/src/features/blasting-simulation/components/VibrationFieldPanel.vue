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
        <button
          class="btn"
          :class="{ primary: isoLineEnabled }"
          @click="$emit('toggle-iso-line', !isoLineEnabled)"
        >
          {{ isoLineEnabled ? '等力线：开' : '等力线：关' }}
        </button>
        <button
          class="btn"
          :class="{ primary: translucentEnabled }"
          @click="$emit('toggle-translucent', !translucentEnabled)"
        >
          {{ translucentEnabled ? '半透明：开' : '半透明：关' }}
        </button>
        <span class="pick-hint">开：热力色以白色底显示；关：保留岩石纹理底</span>
      </div>
    </div>

    <!-- 场渲染参数：标尺 / 等值线密度 / 提取诊断 -->
    <div class="section">
      <div class="section-title">场渲染参数</div>
      <!-- 物理诚实化说明（P1）：当前为解析叠加场，多孔干涉由各炮孔几何位置+微差
         延时按波动矢量叠加真实计算；隧道自由面采用"镜象源法"近似反射。非 FDTD
         全波解 → 无衍射/绕射/多次反射边界特征。如需真反射请启用后端 FDTD 待办项。 -->
      <div class="field-note">
        <span class="field-label">场算法</span>
        <span class="field-value">解析叠加场 · 多源几何+延时真实叠加</span>
        <div class="field-note-hint">
          界面自由面：镜象源近似反射；边界无衍射/绕射。FDTD 真边界为后端待办。
        </div>
      </div>
      <!-- 核心可视化开关（矢量箭头）-->
      <div class="row mt-1">
        <button
          class="btn"
          :class="{ primary: vectorFieldOn }"
          @click="$emit('toggle-vector-field', !vectorFieldOn)"
        >
          {{ vectorFieldOn ? '矢量箭头：开' : '矢量箭头：关' }}
        </button>
      </div>
      <div class="slider-row mt-1">
        <span class="slider-label">等值线密度</span>
        <input
          class="slider-input"
          type="range"
          min="4"
          max="24"
          step="1"
          :value="contourDensity"
          @input="$emit('set-contour-density', Number($event.target.value))"
        />
        <span class="slider-value">{{ contourDensity }} 档</span>
      </div>
      <!-- 波包载波频率：控制热力图干涉条纹的空间密度。载波波长 λ=visualCp/f，
           f 越高条纹越密——正面近距离/掠射角下即使 2Hz 也可能出现规则纹路。
           默认关闭（0=纯包络）；需要观察行波环时再手动开启。 -->
      <div class="slider-row mt-1">
        <span class="slider-label">波包频率</span>
        <input
          class="slider-input"
          type="range"
          min="0"
          max="30"
          step="0.5"
          :value="carrierHz"
          @input="$emit('set-carrier-hz', Number($event.target.value))"
        />
        <span class="slider-value">{{ carrierHz > 0 ? carrierHz + ' Hz' : '关' }}</span>
      </div>
      <div class="hint-sm">
        控制行波波环的疏密：0 = 关（纯包络云图，最平滑），2 = 单个波环清晰可见，
        再调高条纹变细、接近噪点。不影响损伤分区与等值线（它们取峰值包络）。
      </div>
      <div class="row mt-1">
        <span class="slider-label">色彩标尺</span>
        <button class="btn" :class="{ primary: normMode === 1 }" @click="$emit('set-norm-mode', 1)">
          对数
        </button>
        <button class="btn" :class="{ primary: normMode === 0 }" @click="$emit('set-norm-mode', 0)">
          线性
        </button>
        <span class="pick-hint">对数展开幂律衰减的动态范围</span>
      </div>
      <div v-if="contourStats" class="diag-row">
        等值线提取：{{ contourStats.loops + contourStats.openChains }} 条（闭环
        {{ contourStats.loops }} / 开链 {{ contourStats.openChains }}）· 滤碎环
        {{ contourStats.loopsFiltered }} · 滤碎链 {{ contourStats.chainsFiltered }} · 顶点
        {{ contourStats.totalPoints.toLocaleString() }} · 耗时
        {{ contourStats.extractMs.toFixed(1) }} ms
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
        峰值振速 v<sub>p</sub> = K·(Q<sup>1/3</sup>/R)<sup>α</sup>，热力图显示该峰值随
        波前到达后衰减的当前瞬时振速 v(t)。默认
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
            <span>该点瞬时振速 v(t)</span><b>{{ pickedPpv.ppvCmps.toFixed(2) }} cm/s</b>
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
          <div class="pick-line sub">
            <span>峰值矢量 (Vx/Vy/Vz)</span><b class="vec">{{ vecLabel }}</b>
          </div>
        </template>
        <template v-else>
          <div class="pick-line"><span>命中点</span><b>场外（未在振动场内）</b></div>
        </template>
      </div>
      <div v-else class="hint-sm">尚未拾取。采样结果按当前 K/α 实时插值计算。</div>
    </div>

    <!-- 场点全时程曲线（点击岩体任一点 → Vx/Vy/Vz/Vmag 时程） -->
    <div v-if="pointHistory" class="section">
      <div class="section-title">该点全时程曲线</div>
      <canvas ref="historyCanvasRef" class="chart-canvas"></canvas>
      <div class="chart-legend">
        <span class="lg"><i class="c1"></i>Vx</span>
        <span class="lg"><i class="c2"></i>Vy</span>
        <span class="lg"><i class="c3"></i>Vz</span>
        <span class="lg"><i class="c4"></i>|V|</span>
        <span class="lg-lg">PPV {{ pointPpvCmps }} cm/s</span>
      </div>
    </div>

    <!-- 仿真 vs 萨道夫斯基公式：PPV 衰减曲线对比（P2-8 验证） -->
    <div v-if="ppvDecayData" class="section">
      <div class="section-title">
        峰值振速衰减对比（仿真 vs 萨道夫斯基）
        <span class="legend-badge">K={{ ppvDecayData.K }}, α={{ ppvDecayData.alpha }}</span>
      </div>
      <canvas ref="decayCanvasRef" class="chart-canvas"></canvas>
      <div class="chart-legend">
        <span class="lg"><i class="c5"></i>仿真（多源叠加·全时程峰值）</span>
        <span class="lg"><i class="c6"></i>萨道夫斯基 K·(Q<sup>1/3</sup>/R)<sup>α</sup></span>
        <span class="lg-lg"
          >最大单响药量 {{ ppvMaxChargePerDelay }} kg（总 {{ ppvTotalQ }} kg）</span
        >
      </div>
    </div>

    <!-- 色阶图例 -->
    <div class="section">
      <div class="section-title">图例</div>
      <div v-if="vibrationFieldInfo" class="legend">
        <template v-if="vibrationMode === 'ppv'">
          <div class="legend-title">
            瞬时质点振速 v(t) — 满刻度 {{ ppvMaxCmps }} cm/s
            <span class="legend-badge">离散 {{ industrialBands }} 档</span>
            <span v-if="normMode === 1" class="legend-badge">对数刻度</span>
          </div>
          <div class="legend-discrete">
            <div v-for="it in ppvLegendItems" :key="'pi' + it.i" class="legend-cell">
              <span class="legend-swatch" :style="{ background: it.css }"></span>
              <span class="legend-range">{{ it.label }}</span>
            </div>
          </div>
        </template>
        <template v-else-if="vibrationMode === 'stress'">
          <div class="legend-title">
            σ_vm 等效应力 — 满刻度 {{ stressMaxMpa }} MPa
            <span class="legend-badge">离散 {{ industrialBands }} 档</span>
            <span v-if="normMode === 1" class="legend-badge">对数刻度</span>
          </div>
          <div class="legend-discrete">
            <div v-for="it in stressLegendItems" :key="'si' + it.i" class="legend-cell">
              <span class="legend-swatch" :style="{ background: it.css }"></span>
              <span class="legend-range">{{ it.label }}</span>
            </div>
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
          <span class="field-label">瞬时帧</span>
          <span class="field-value">{{ currentFrame }} / {{ maxFrame }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">显示状态</span>
          <span class="field-value">{{ displayState }}</span>
        </div>
        <div class="field-item">
          <span class="field-label">等值线来源</span>
          <span class="field-value">静置峰值场</span>
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
          <span class="ready-label">瞬时振速</span>
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  DAMAGE_LEGEND,
  PPV_LEGEND_MAX,
  STRESS_LEGEND_MAX,
  INDUSTRIAL_BANDS_DEFAULT,
  industrialBandCount,
  industrialLegendItems
} from '../services/core/rendering/vibrationColorScales.js'
import {
  LOCAL_SIM_DEFAULT_K,
  LOCAL_SIM_DEFAULT_ALPHA,
  SADOSKY_PRESETS
} from '../services/core/vibrationDefaults.js'

defineOptions({ name: 'VibrationFieldPanel' })

const props = defineProps({
  vibrationModes: { type: Array, default: () => [] },
  vibrationMode: { type: String, default: 'ppv' },
  vibrationFieldInfo: { type: Object, default: null },
  sadoskyParams: { type: Object, default: () => ({ k: 30, alpha: 1.5 }) },
  // 自动量程（绝对量程，仿真前解析扫描并固定）：{ ppvRefMps, stressRefMPa }，null 时回退固定刻度
  fieldRange: { type: Object, default: null },
  // 工业离散色阶档数（12~16）：与等值线密度 / shader uNormBands 同源
  bandCount: { type: Number, default: INDUSTRIAL_BANDS_DEFAULT },
  ppvPickEnabled: { type: Boolean, default: false },
  pickedPpv: { type: Object, default: null },
  // 振动场底材"白模"开关（true=白模底，false=保留岩石纹理底）
  whiteModelEnabled: { type: Boolean, default: false },
  // 等力线（等值线）开关（true=在热力图上叠加等值线）；默认关闭，
  // 避免正面近视角下叠加几何折线形成规则斜纹。
  isoLineEnabled: { type: Boolean, default: false },
  // 半透明渲染（true=热力场上限 0.55 露出岩底轮廓）
  translucentEnabled: { type: Boolean, default: false },
  // 播放帧计数（总帧 = Math.floor(duration/0.05)-1），用于明确当前"瞬时帧"位置
  currentFrame: { type: Number, default: 0 },
  maxFrame: { type: Number, default: 0 },
  // 色彩标尺：0=线性 1=对数（图例刻度与 shader uNormMode 同口径）
  normMode: { type: Number, default: 1 },
  // 等值线密度（色带分档数，条数 = density−1）
  contourDensity: { type: Number, default: 12 },
  // 波包载波频率（Hz，0=关）：热力图干涉条纹疏密；不影响峰值判据
  carrierHz: { type: Number, default: 2 },
  // 矢量箭头场开关（P1-6：展示波传播方向）
  vectorFieldOn: { type: Boolean, default: false },
  // 场点拾取全时程曲线数据（computeMonitorTimeHistory 输出，null=无拾取点）
  pointHistory: { type: Object, default: null },
  // 仿真 vs 萨道夫斯基 PPV 衰减对比数据（computePpvDecayProfile 输出，null=不可用）
  ppvDecayData: { type: Object, default: null },
  // 最近一次等值线提取诊断 stats（null=尚未提取）
  contourStats: { type: Object, default: null }
})

const emit = defineEmits([
  'set-vibration-mode',
  'update-sadosky-params',
  'toggle-ppv-pick',
  'toggle-white-model',
  'toggle-iso-line',
  'toggle-translucent',
  'set-norm-mode',
  'set-contour-density',
  'set-carrier-hz',
  'toggle-vector-field'
])

// 萨道夫斯基参数本地编辑态（外部 props 变化时同步；默认值单源于 vibrationDefaults.js）
const kInput = ref(LOCAL_SIM_DEFAULT_K)
const alphaInput = ref(LOCAL_SIM_DEFAULT_ALPHA)
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

// 文献实测的萨道夫斯基标定集（便于用真实场地参数反标定 PPV 场）：单源于 vibrationDefaults.js
const sadoskyPresets = SADOSKY_PRESETS
const presetKey = ref('__none__')
function applyPreset() {
  const p = sadoskyPresets.find(x => x.key === presetKey.value)
  if (!p) return
  kInput.value = p.k
  alphaInput.value = p.alpha
  applySadosky()
}

const damageLegend = DAMAGE_LEGEND

// ─── 工业离散图例（色块 + 数值区间）──────────────────────
// 满刻度来自绝对量程（仿真前解析扫描并固定，见 blastingManager._computeAutoFieldRefs），
// 区间边界 = 色阶边界（与等值线级别、shader 离散取色同一公式），三处严格对齐。
const ppvLegendItems = computed(() =>
  industrialLegendItems({
    ref: ppvMaxCmps.value / 100,
    unitScale: 100,
    normMode: props.normMode,
    bands: industrialBands.value
  }).map(it => ({
    ...it,
    label: `${fmtTickVal(it.lo)} ~ ${fmtTickVal(it.hi)}`
  }))
)
const stressLegendItems = computed(() =>
  industrialLegendItems({
    ref: stressMaxMpa.value,
    unitScale: 1,
    normMode: props.normMode,
    bands: industrialBands.value
  }).map(it => ({
    ...it,
    label: `${fmtTickVal(it.lo)} ~ ${fmtTickVal(it.hi)}`
  }))
)

// 自动量程图例：满刻度跟随岩体代表性峰值（fieldRange），否则回退固定刻度。
// 色带本身固定（LUT 绝对值），动态量程只重标刻度：等距分数点映射到 0~满刻度。
const ppvMaxCmps = computed(() =>
  props.fieldRange?.ppvRefMps > 0 ? props.fieldRange.ppvRefMps * 100 : PPV_LEGEND_MAX
)
const stressMaxMpa = computed(() =>
  props.fieldRange?.stressRefMPa > 0 ? props.fieldRange.stressRefMPa : STRESS_LEGEND_MAX
)
function fmtTickVal(v) {
  if (v >= 100) return String(Math.round(v))
  if (v >= 10) return String(Number(v.toFixed(1)))
  return String(Number(v.toPrecision(2)))
}
// 工业离散色阶档数（12~16）：与等值线密度（contourDensity）/ shader uNormBands 同源
const industrialBands = computed(() => industrialBandCount(props.contourDensity ?? props.bandCount))

const modeLabel = computed(() => {
  const m = (props.vibrationModes || []).find(x => x.key === props.vibrationMode)
  return m ? m.label : props.vibrationMode
})
const lastT = computed(() => props.vibrationFieldInfo?.lastT)
// 明确时间状态：热力图渲染的是当前模拟时刻 t 的瞬时振速场 v(t)。
// 多源矢量叠加（各炮孔延期差+路径差→相位差）本身产生物理干涉，平滑衰减包络显示。
const displayState = computed(() => '瞬时振速场 v(t) · 多源解析叠加')
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
// 峰值时刻的三分量速度矢量（与监测点时程同源，单位 m/s）
const vecLabel = computed(() => {
  const v = props.pickedPpv?.vector
  if (!v || !Number.isFinite(v.vmag)) return '—'
  return `Vx ${v.vx.toFixed(3)} / Vy ${v.vy.toFixed(3)} / Vz ${v.vz.toFixed(3)} m/s`
})

// ─── 图表绘制（Canvas 2D，无第三方依赖） ─────────────────────
const historyCanvasRef = ref(null)
const decayCanvasRef = ref(null)
const pointPpvCmps = computed(() => {
  const p = props.pointHistory?.ppv
  return Number(p) > 0 ? (p * 100).toFixed(2) : '—'
})
const ppvTotalQ = computed(() =>
  Number(props.ppvDecayData?.totalQ) > 0 ? Number(props.ppvDecayData.totalQ).toFixed(1) : '—'
)
// 理论线口径 = 最大单响药量（同段齐发窗内药量和，微差爆破振动预测规范口径）
const ppvMaxChargePerDelay = computed(() => {
  const v = Number(props.ppvDecayData?.maxChargePerDelay)
  return v > 0 ? v.toFixed(1) : ppvTotalQ.value
})

let histRaf = 0
let ro1 = null
let ro2 = null
function drawHistoryChart() {
  histRaf = 0
  const canvas = historyCanvasRef.value
  const h = props.pointHistory
  if (!canvas || !h) return
  const { t, vx, vy, vz, vmag } = h
  const n = t?.length || 0
  if (n < 2) return
  drawVibeCurves(canvas, { t, series: [vx, vy, vz, vmag], title: '' })
}
function drawDecayChart() {
  const canvas = decayCanvasRef.value
  const d = props.ppvDecayData
  if (!canvas || !d) return
  const { r, sim, theory } = d
  drawDecayCurves(canvas, { r, sim, theory })
}

function drawVibeCurves(canvas, { t, series, title }) {
  const parent = canvas.parentElement
  const w = parent.clientWidth || 320
  const h2 = 160
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h2 * dpr)
  canvas.style.width = w + 'px'
  canvas.style.height = h2 + 'px'
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h2)
  const padL = 10
  const padB = 16
  const plotW = w - padL - 8
  const plotH = h2 - 8 - padB
  const colors = ['#7aa2f7', '#e0af68', '#73daca', '#f7768e']
  let pmax = 1e-6
  for (const arr of series)
    for (let i = 0; i < t.length; i++) pmax = Math.max(pmax, Math.abs(arr[i]))
  const niceMax = _niceNum(pmax * 1.15)
  const tmax = Math.max(1e-6, t[t.length - 1])
  // 网格 + 左轴刻度
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '10px Consolas, monospace'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const x = padL + (i / 4) * plotW
    ctx.beginPath()
    ctx.moveTo(x, 8)
    ctx.lineTo(x, 8 + plotH)
    ctx.stroke()
    const y = 8 + (i / 4) * plotH
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + plotW, y)
    ctx.stroke()
    const val = niceMax * (1 - i / 4)
    ctx.fillText(val > 10 ? val.toFixed(0) : val.toFixed(2), 2, y + 3)
  }
  ctx.fillText(tmax.toFixed(2) + 's', padL + plotW - 28, 8 + plotH + 11)
  // 对称零轴
  const zeroY = 8 + plotH / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.beginPath()
  ctx.moveTo(padL, zeroY)
  ctx.lineTo(padL + plotW, zeroY)
  ctx.stroke()
  const toY = v => zeroY - (v / niceMax) * (plotH / 2)
  series.forEach((arr, si) => {
    ctx.strokeStyle = colors[si]
    ctx.lineWidth = si === 3 ? 2 : 1.3
    ctx.beginPath()
    for (let i = 0; i < t.length; i++) {
      const px = padL + (t[i] / tmax) * plotW
      const py = toY(arr[i])
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
  })
}

// 双对数坐标的 PPV 衰减对比（R 横轴、PPV 纵轴均取 log10 → 幂律衰减成直线，
// 仿真曲线与萨道夫斯基直线拟合贴近即验证算法可靠）
function drawDecayCurves(canvas, { r, sim, theory }) {
  const parent = canvas.parentElement
  const w = parent.clientWidth || 320
  const h2 = 160
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h2 * dpr)
  canvas.style.width = w + 'px'
  canvas.style.height = h2 + 'px'
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h2)
  const padL = 10
  const padB = 16
  const plotW = w - padL - 8
  const plotH = h2 - 8 - padB
  const rMin = Math.log10(Math.max(1e-3, r[0]))
  const rMax = Math.log10(r[r.length - 1])
  let vMin = Infinity
  let vMax = -Infinity
  for (let i = 0; i < r.length; i++) {
    if (sim[i] > 0) {
      vMin = Math.min(vMin, Math.log10(sim[i]))
      vMax = Math.max(vMax, Math.log10(sim[i]))
    }
    if (theory[i] > 0) {
      vMin = Math.min(vMin, Math.log10(theory[i]))
      vMax = Math.max(vMax, Math.log10(theory[i]))
    }
  }
  vMin = Math.floor(vMin - 0.3)
  vMax = Math.ceil(vMax + 0.3)
  if (rMax - rMin < 1e-6) return
  const X = x => padL + ((Math.log10(x) - rMin) / (rMax - rMin)) * plotW
  const Y = v => 8 + plotH - ((Math.log10(v) - vMin) / (vMax - vMin)) * plotH
  // 网格 + 刻轴（log10 刻度标签）
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = '10px Consolas, monospace'
  ctx.lineWidth = 1
  for (let i = 0; i <= 3; i++) {
    const x = padL + (i / 3) * plotW
    ctx.beginPath()
    ctx.moveTo(x, 8)
    ctx.lineTo(x, 8 + plotH)
    ctx.stroke()
    const y = 8 + (i / 3) * plotH
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + plotW, y)
    ctx.stroke()
  }
  // 标注轴：R(m) 与 V(cm/s)
  ctx.fillText('R(m)', padL + plotW - 24, 8 + plotH + 11)
  ctx.fillText('V(cm/s)', 4, 8 + plotH + 11)
  // 理论线（萨道夫斯基 K·(Q^1/3/R)^α · 0.01 → m/s → ×100 → cm/s 同轴）
  const tArr = []
  for (let i = 0; i < r.length; i++) tArr.push([r[i], theory[i]])
  _strokeLogLine(ctx, X, Y, tArr, 'rgba(254,202,87,0.95)', 2)
  // 仿真线（多源叠加全时程峰值）
  const sArr = []
  for (let i = 0; i < r.length; i++) sArr.push([r[i], sim[i]])
  _strokeLogLine(ctx, X, Y, sArr, 'rgba(122,162,247,0.95)', 1.6)
}

function _strokeLogLine(ctx, X, Y, pts, color, lw) {
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.beginPath()
  let started = false
  for (const [rx, v] of pts) {
    if (!(v > 0)) {
      started = false
      continue
    }
    const px = X(rx)
    const py = Y(v)
    if (!started) {
      ctx.moveTo(px, py)
      started = true
    } else ctx.lineTo(px, py)
  }
  ctx.stroke()
}

function _niceNum(v) {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const m = v / base
  const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return niceM * base
}

watch(
  () => props.pointHistory,
  () => {
    if (histRaf) cancelAnimationFrame(histRaf)
    histRaf = requestAnimationFrame(drawHistoryChart)
  },
  { deep: true }
)
watch(
  () => props.ppvDecayData,
  () => requestAnimationFrame(drawDecayChart),
  { deep: true }
)
onMounted(() => {
  ro1?.disconnect()
  ro1 = new ResizeObserver(() => {
    if (histRaf) cancelAnimationFrame(histRaf)
    histRaf = requestAnimationFrame(drawHistoryChart)
  })
  ro2?.disconnect()
  ro2 = new ResizeObserver(() => requestAnimationFrame(drawDecayChart))
  if (historyCanvasRef.value?.parentElement) ro1.observe(historyCanvasRef.value.parentElement)
  if (decayCanvasRef.value?.parentElement) ro2.observe(decayCanvasRef.value.parentElement)
  requestAnimationFrame(drawHistoryChart)
  requestAnimationFrame(drawDecayChart)
})
onBeforeUnmount(() => {
  if (histRaf) cancelAnimationFrame(histRaf)
  ro1?.disconnect()
  ro2?.disconnect()
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
.legend-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--primary-color);
  background: rgba(64, 158, 255, 0.12);
  border: 1px solid rgba(64, 158, 255, 0.25);
}
.legend-bar {
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
/* 工业离散图例：N 个色块 + 数值区间（无渐变条） */
.legend-discrete {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 2px 0 4px;
}
.legend-cell {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 104px;
}
.legend-swatch {
  width: 18px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  flex: none;
}
.legend-range {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.legend-ticks {
  position: relative;
  height: 16px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.legend-tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
}
.legend-tick:first-child {
  transform: translateX(0);
}
.legend-tick:last-child {
  transform: translateX(-100%);
}
.slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.slider-label {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 60px;
  flex-shrink: 0;
}
.slider-input {
  flex: 1;
  min-width: 0;
  accent-color: var(--primary-color);
}
.slider-value {
  font-size: 12px;
  color: var(--text-primary);
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.diag-row {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
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
.field-note {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--border-color, rgba(120, 160, 255, 0.25));
  border-radius: 6px;
  background: rgba(20, 30, 55, 0.4);
}
.field-note-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
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
.pick-line b.vec {
  color: var(--primary-light);
  font-family: 'Consolas', monospace;
  font-size: 12px;
  word-break: break-all;
}

/* 图表（时程曲线 / PPV 衰减对比） */
.chart-canvas {
  display: block;
  width: 100%;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.22);
}
.chart-legend {
  display: flex;
  gap: 10px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.chart-legend .lg {
  font-size: 11px;
  color: var(--text-muted);
}
.chart-legend .lg i {
  display: inline-block;
  width: 10px;
  height: 3px;
  border-radius: 2px;
  vertical-align: middle;
  margin-right: 4px;
}
.chart-legend .c1 {
  background: #7aa2f7;
}
.chart-legend .c2 {
  background: #e0af68;
}
.chart-legend .c3 {
  background: #73daca;
}
.chart-legend .c4 {
  background: #f7768e;
}
.chart-legend .c5 {
  background: #7aa2f7;
}
.chart-legend .c6 {
  background: #feca57;
}
.chart-legend .lg-lg {
  margin-left: auto;
  font-size: 11px;
  color: #f7768e;
  font-family: 'Consolas', monospace;
}
</style>
