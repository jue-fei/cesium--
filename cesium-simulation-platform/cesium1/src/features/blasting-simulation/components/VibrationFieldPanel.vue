<template>
  <div>
    <!-- 振动场独立开关：与视觉图层开关解耦，开启/退出不随切割、断面更新等
         场景重建操作丢失（状态存于 vibrationFieldEnabled） -->
    <div class="section">
      <div class="section-title">振动场</div>
      <div class="row">
        <button
          class="btn field-toggle"
          :class="{ primary: vibrationFieldEnabled }"
          @click="$emit('toggle-vibration-field', !vibrationFieldEnabled)"
        >
          {{ vibrationFieldEnabled ? '退出振动场' : '开启振动场' }}
        </button>
        <span class="pick-hint">{{
          vibrationFieldEnabled ? '热力图叠加显示于岩体表面' : '开启后可在岩体表面渲染热力图'
        }}</span>
      </div>
    </div>

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
      <!-- 波包载波频率：控制热力图干涉条纹的空间密度。载波空间波长 λ=visualCp/f
           （visualCp=35 m/s）——f 越高条纹越密，8Hz 以上在屏幕尺度上接近噪点；
           0 = 纯包络（无行波环，最平滑）。默认 0，与原版观感一致。 -->
      <div class="row mt-1">
        <span class="pick-hint" style="min-width: 64px">波包频率</span>
        <input
          type="range"
          min="0"
          max="30"
          step="0.5"
          style="flex: 1; min-width: 90px; accent-color: #409eff"
          :value="carrierHz"
          @input="$emit('set-carrier-hz', Number($event.target.value))"
        />
        <span class="pick-hint" style="min-width: 52px; text-align: right">
          {{ carrierHz > 0 ? carrierHz + ' Hz' : '关' }}
        </span>
      </div>
      <div class="hint-sm">
        控制行波波环的疏密：0 = 关（纯包络云图，最平滑），2 = 单个波环清晰可见，
        越高条纹越细密。不影响损伤分区（其取峰值包络）。
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
        <!-- K/α 为会话级参数（随时可应用，切事件后保留语义由 useBlasting 管理），不随场元信息置灰 -->
        <button class="btn primary" @click="applySadosky">应用</button>
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
        </template>
        <template v-else>
          <div class="pick-line"><span>命中点</span><b>场外（未在振动场内）</b></div>
        </template>
      </div>
      <div v-else class="hint-sm">尚未拾取。采样结果按当前 K/α 实时插值计算。</div>
    </div>

    <!-- 探测点全时程曲线：该点振速随模拟时间的二维图 -->
    <div v-if="vibrationFieldInfo" class="section">
      <div class="section-title">探测点时程曲线</div>
      <canvas ref="historyCanvasRef" class="history-canvas"></canvas>
      <div class="history-legend">
        <span><i class="lg lg-vx"></i>Vx</span>
        <span><i class="lg lg-vy"></i>Vy</span>
        <span><i class="lg lg-vz"></i>Vz</span>
        <span><i class="lg lg-vm"></i>|V|</span>
      </div>
      <div v-if="pointHistory" class="hint-sm">
        峰值 {{ (pointHistory.ppv * 100).toFixed(1) }} cm/s @ {{ pointHistory.peakT.toFixed(2) }} s
        · 与热力图同口径（同源 / 同 K,α / 同载波）
      </div>
      <div v-else class="hint-sm">
        启用"场点采样"后点击岩体任意点，显示该点振速随时间的变化曲线。
      </div>
    </div>

    <!-- 色阶图例 -->
    <div class="section">
      <div class="section-title">图例</div>
      <div v-if="vibrationFieldInfo" class="legend">
        <template v-if="vibrationMode === 'ppv'">
          <div class="legend-title">瞬时质点振速 v(t) (cm/s)</div>
          <div
            class="legend-bar"
            :style="{ background: `linear-gradient(to right, ${ppvGradient})` }"
          ></div>
          <div class="legend-ticks">
            <span v-for="t in ppvTicks" :key="t" :style="{ left: normPos(t, ppvMax) + '%' }">{{
              t
            }}</span>
          </div>
        </template>
        <template v-else-if="vibrationMode === 'stress'">
          <div class="legend-title">σ_vm 等效应力 (MPa)</div>
          <div
            class="legend-bar"
            :style="{ background: `linear-gradient(to right, ${stressGradient})` }"
          ></div>
          <div class="legend-ticks">
            <span
              v-for="t in stressTicks"
              :key="t"
              :style="{ left: normPos(t, stressMax) + '%' }"
              >{{ t }}</span
            >
          </div>
        </template>
        <template v-else>
          <div class="legend-title">损伤分区（峰值 PPV, cm/s）</div>
          <div class="damage-legend-grid">
            <span
              v-for="d in damageLegend"
              :key="d.zone"
              class="damage-swatch-item"
              :style="{ background: d.c, opacity: d.zone === 0 ? 0.35 : 1 }"
              >{{ d.zone }} {{ d.label }} {{ d.range }}</span
            >
          </div>
          <div class="hint-sm">
            zone 0
            表示波前已到且低于损伤阈值（保留岩面原色）；未到达、无数据或场外不叠加损伤色。
            阈值参考 Bauer-Calder (1971) 与 Persson et al. (1997)。25/63.5/254 cm/s 对应裂纹与破碎；≥15
            m/s 为近炮腔粉碎。GB 6722-2014 保护对象限值是另一口径，不能与岩体损伤阈值混用。
            抛掷由碎片系统模拟，不属 PPV 分区。
          </div>
          <div v-if="influenceText" class="hint-sm influence-stat">
            影响范围（振动安全允许距离，GB 6722-2014/文献口径：Q0={{ influenceText.q0 }}kg）：
            巷道 <b>{{ influenceText.tunnel }} m</b>（V0={{ influenceText.v0Tunnel }} cm/s）·
            边坡 <b>{{ influenceText.slope }} m</b>（V0={{ influenceText.v0Slope }} cm/s）；
            与岩体损伤圈（Bauer-Calder 判据）为两个不同物理量。
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
import { computed, ref, watch, onMounted, nextTick } from 'vue'
import {
  PPV_TICKS,
  STRESS_TICKS,
  DAMAGE_LEGEND,
  PPV_LEGEND_STOPS,
  PPV_LEGEND_MAX,
  STRESS_LEGEND_STOPS,
  STRESS_LEGEND_MAX,
  gradientCss,
  valueToNorm
} from '../services/core/rendering/vibrationColorScales.js'
import {
  SADOSKY_PRESETS,
  LOCAL_SIM_DEFAULT_K,
  LOCAL_SIM_DEFAULT_ALPHA
} from '../services/core/vibrationDefaults.js'

defineOptions({ name: 'VibrationFieldPanel' })

const props = defineProps({
  vibrationModes: { type: Array, default: () => [] },
  vibrationMode: { type: String, default: 'ppv' },
  vibrationFieldInfo: { type: Object, default: null },
  // 振动场独立开关状态（与视觉图层开关解耦；true=场渲染中）
  vibrationFieldEnabled: { type: Boolean, default: false },
  sadoskyParams: { type: Object, default: () => ({ k: 30, alpha: 1.5 }) },
  ppvPickEnabled: { type: Boolean, default: false },
  pickedPpv: { type: Object, default: null },
  // 振动场底材"白模"开关（true=白模底，false=保留岩石纹理底）
  whiteModelEnabled: { type: Boolean, default: false },
  // 波包载波频率（Hz，0=关）：控制热力图干涉条纹疏密，0=纯包络
  carrierHz: { type: Number, default: 0 },
  // 探测点全时程曲线：{ t,vx,vy,vz,vmag,ppv,peakT,local } | null
  pointHistory: { type: Object, default: null }
})

const emit = defineEmits([
  'set-vibration-mode',
  'update-sadosky-params',
  'toggle-ppv-pick',
  'toggle-white-model',
  'set-carrier-hz',
  'toggle-vibration-field'
])

// 萨道夫斯基参数本地编辑态（外部 props 变化时同步；初始值与本地模拟器默认同源）
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

function applySadosky() {
  const k = Number(kInput.value)
  const alpha = Number(alphaInput.value)
  if (!Number.isFinite(k) || k <= 0) return
  if (!Number.isFinite(alpha) || alpha <= 0) return
  emit('update-sadosky-params', { k, alpha })
}

// 文献实测的萨道夫斯基标定集（单源在 vibrationDefaults.js，便于用真实场地参数反标定 PPV 场）
const sadoskyPresets = SADOSKY_PRESETS
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
const ppvMax = PPV_LEGEND_MAX
const stressMax = STRESS_LEGEND_MAX
// 影响范围（振动安全允许距离，GB 6722-2014/文献口径）：manager 按事件 K/α/Q0 计算，
// 随 vibrationFieldInfo 下发；同时驱动场景中的青/橙两圈（threeBlastingRenderer）
const influenceText = computed(() => {
  const r = props.vibrationFieldInfo?.influenceRanges
  if (!r || !(r.tunnel > 0)) return null
  return {
    tunnel: r.tunnel.toFixed(2),
    slope: r.slope.toFixed(2),
    v0Tunnel: r.v0Tunnel,
    v0Slope: r.v0Slope,
    q0: Math.round(r.q0 * 10) / 10
  }
})
// 图例色带为对数标尺（与 shader 同源），刻度须按归一化位置定位，
// 否则刻度值与其所在色带位置不符（线性等距分布会整体错位）。
const normPos = (v, max) => (valueToNorm(v, max) * 100).toFixed(2)
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
  // PPV/应力使用解析瞬时场；损伤读取已分类的 DAMAGE 纹理，首帧前会显示 no-data。
  // 切割/断面更新后 vibrationFieldInfo 可能短暂为 null，不据此禁用模式按钮；
  // 选择损伤模式时自动开启场图层，收到有效 DAMAGE 帧后覆盖域内着色。
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
  if (z === -1) return '未到达/未分类'
  const d = damageLegend.find(x => x.zone === z)
  return d ? `${z} ${d.label}` : String(z)
})
const fmtGrid = computed(() => {
  const p = props.pickedPpv
  if (!p || p.gridX == null) return '—'
  return `${p.gridX.toFixed(1)}, ${p.gridY.toFixed(1)}, ${p.gridZ.toFixed(1)}`
})

// ─── 探测点全时程曲线 ─────────────────────────────────
// 与热力图同口径的解析时程（manager.computePointTimeHistory），故曲线上任意时刻的
// |V| 就等于该时刻热力图在该点所代表颜色的振速；峰值线 = 损伤分区判据。
const historyCanvasRef = ref(null)

/** 绘制探测点时程曲线：|V| 主曲线（红）+ 三分量（蓝/绿/黄）+ 峰值参考线 */
function drawHistory() {
  const cvs = historyCanvasRef.value
  if (!cvs) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cssW = cvs.clientWidth || 320
  const cssH = 168
  if (cvs.width !== Math.round(cssW * dpr) || cvs.height !== Math.round(cssH * dpr)) {
    cvs.width = Math.round(cssW * dpr)
    cvs.height = Math.round(cssH * dpr)
  }
  const ctx = cvs.getContext('2d')
  if (!ctx) return
  const W = cvs.width
  const Hc = cvs.height
  ctx.fillStyle = '#0d1220'
  ctx.fillRect(0, 0, W, Hc)
  const h = props.pointHistory
  if (!h || !h.t || !h.t.length) {
    ctx.fillStyle = '#7a8699'
    ctx.font = 12 * dpr + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('启用"场点采样"后点击岩体，显示该点振速时程', W / 2, Hc / 2)
    return
  }
  const pad = { l: 54 * dpr, r: 10 * dpr, t: 14 * dpr, b: 22 * dpr }
  const pw = W - pad.l - pad.r
  const ph = Hc - pad.t - pad.b
  const tMax = h.t[h.t.length - 1] || 1
  let vMax = 0
  for (let i = 0; i < h.vmag.length; i++) if (h.vmag[i] > vMax) vMax = h.vmag[i]
  if (!(vMax > 0)) vMax = 1e-6
  const xOf = t => pad.l + (t / tMax) * pw
  const yOf = v => pad.t + ph - (v / vMax) * ph
  // 横向网格 + 纵轴刻度
  ctx.strokeStyle = '#222c3c'
  ctx.lineWidth = 1
  ctx.fillStyle = '#7a8699'
  ctx.font = 10 * dpr + 'px monospace'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4
    ctx.beginPath()
    ctx.moveTo(pad.l, y)
    ctx.lineTo(pad.l + pw, y)
    ctx.stroke()
    ctx.fillText((vMax * (1 - i / 4)).toExponential(1), pad.l - 5 * dpr, y + 3 * dpr)
  }
  // 横轴端点
  ctx.fillStyle = '#7a8699'
  ctx.textAlign = 'center'
  ctx.fillText('0', pad.l, Hc - 6 * dpr)
  ctx.fillText(tMax.toFixed(2) + ' s', pad.l + pw, Hc - 6 * dpr)
  // 峰值参考线（与损伤分区判据同口径：不含载波的包络峰值）
  if (h.ppv > 0) {
    const yP = yOf(h.ppv)
    ctx.strokeStyle = '#ff8787'
    ctx.setLineDash([4 * dpr, 4 * dpr])
    ctx.beginPath()
    ctx.moveTo(pad.l, yP)
    ctx.lineTo(pad.l + pw, yP)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ff8787'
    ctx.textAlign = 'left'
    ctx.fillText('峰值 ' + (h.ppv * 100).toFixed(1) + ' cm/s', pad.l + 4 * dpr, yP - 4 * dpr)
  }
  const line = (arr, color, w) => {
    if (!arr || !arr.length) return
    ctx.strokeStyle = color
    ctx.lineWidth = w * dpr
    ctx.beginPath()
    for (let i = 0; i < arr.length; i++) {
      const x = xOf(h.t[i])
      const y = yOf(Math.abs(arr[i]))
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  line(h.vx, '#4dabf7', 1)
  line(h.vy, '#69db7c', 1)
  line(h.vz, '#ffd43b', 1)
  line(h.vmag, '#ff6b6b', 1.8)
}

watch(
  () => props.pointHistory,
  () => nextTick(drawHistory)
)
watch(
  () => props.ppvPickEnabled,
  () => nextTick(drawHistory)
)
onMounted(() => nextTick(drawHistory))
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
  /* 对数标尺下刻度位置不等距 → 绝对定位（left 由 normPos 计算） */
  position: relative;
  height: 14px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.legend-ticks span {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
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

/* ─── 探测点时程曲线 ───────────────────────────────── */
.history-canvas {
  display: block;
  width: 100%;
  height: 168px;
  border: 1px solid var(--border-color, #2a3444);
  border-radius: 4px;
  background: #0d1220;
}
.history-legend {
  display: flex;
  gap: 14px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.history-legend .lg {
  display: inline-block;
  width: 14px;
  height: 3px;
  margin-right: 4px;
  vertical-align: middle;
  border-radius: 2px;
}
.history-legend .lg-vx {
  background: #4dabf7;
}
.history-legend .lg-vy {
  background: #69db7c;
}
.history-legend .lg-vz {
  background: #ffd43b;
}
.history-legend .lg-vm {
  background: #ff6b6b;
}
</style>
