<template>
  <div class="panel-section">
    <div class="panel-section-title">炮孔布置图（掌子面正视图）</div>
    <div v-if="!blastDesign" class="hint-text">请先加载爆破数据以生成炮孔布置图。</div>
    <div v-else class="hole-layout-wrap">
      <svg :viewBox="`0 0 ${holeLayoutSize} ${holeLayoutSize}`" class="hole-layout-svg">
        <path :d="tunnelOutlinePath" fill="#1a1a1a" stroke="#888" stroke-width="1.5" />
        <circle v-for="(h, i) in blastDesign.holes" :key="i" :cx="holeToSvgX(h.x)" :cy="holeToSvgY(h.y)"
          :r="h.isEmpty ? 4 : 2.5" :fill="holeColor(h)" :stroke="h.isEmpty ? '#fff' : 'none'"
          :stroke-width="h.isEmpty ? 0.8 : 0" class="hole-point" @click.stop="onHoleClick(h, $event)" />
        <g class="hole-legend">
          <circle :cx="holeLayoutSize - 90" :cy="14" r="2.5" fill="#ff6b6b" />
          <text :x="holeLayoutSize - 82" :y="17" fill="#ccc" font-size="9">掏槽孔</text>
          <circle :cx="holeLayoutSize - 90" :cy="28" r="2.5" fill="#feca57" />
          <text :x="holeLayoutSize - 82" :y="31" fill="#ccc" font-size="9">辅助孔</text>
          <circle :cx="holeLayoutSize - 50" :cy="14" r="2.5" fill="#1dd1a1" />
          <text :x="holeLayoutSize - 42" :y="17" fill="#ccc" font-size="9">周边孔</text>
          <circle :cx="holeLayoutSize - 50" :cy="28" r="4" fill="#fff" stroke="#888" stroke-width="0.8" />
          <text :x="holeLayoutSize - 42" :y="31" fill="#ccc" font-size="9">空孔</text>
        </g>
      </svg>
      <el-popover :virtual-ref="holePopoverRef" virtual-triggering :visible="holePopoverVisible" placement="right"
        :width="220" trigger="click" @hide="closeHolePopover">
        <template #reference><span></span></template>
        <div v-if="selectedHoleDetail" class="hole-detail-pop">
          <div class="hole-detail-title">炮孔参数</div>
          <div class="stat-item">
            <span>类型</span><span class="stat-value">{{ selectedHoleDetail.typeLabel }}</span>
          </div>
          <div class="stat-item">
            <span>装药量</span><span class="stat-value">{{ selectedHoleDetail.charge }} kg</span>
          </div>
          <div class="stat-item">
            <span>典型延时</span><span class="stat-value">{{ selectedHoleDetail.delay }} ms</span>
          </div>
          <div class="stat-item">
            <span>钻孔深度</span><span class="stat-value">{{ selectedHoleDetail.depth }} m</span>
          </div>
          <div class="stat-item">
            <span>坐标</span><span class="stat-value">({{ selectedHoleDetail.x.toFixed(2) }}, {{
              selectedHoleDetail.y.toFixed(2)
              }})</span>
          </div>
        </div>
      </el-popover>
    </div>

    <div v-if="blastDesign" class="mt-3">
      <div class="panel-subtitle">钻孔统计</div>
      <div class="stat-item">
        <span>总孔数</span><span class="stat-value">{{ blastDesign.counts.total }}</span>
      </div>
      <div class="stat-item">
        <span>掏槽孔（含空孔）</span><span class="stat-value">{{ blastDesign.counts.cut }} (空孔 {{ blastDesign.counts.empty
          }})</span>
      </div>
      <div class="stat-item">
        <span>辅助孔</span><span class="stat-value">{{ blastDesign.counts.auxiliary }}</span>
      </div>
      <div class="stat-item">
        <span>周边孔</span><span class="stat-value">{{ blastDesign.counts.perimeter }}</span>
      </div>
      <div class="stat-item">
        <span>钻孔深度</span><span class="stat-value">{{ blastDesign.holeDepth }} m</span>
      </div>
    </div>

    <div v-if="blastDesign" class="mt-3">
      <div class="panel-subtitle">掘进与爆破参数</div>
      <div class="stat-item">
        <span>断面尺寸</span><span class="stat-value">{{ blastDesign.section.W }}m × {{
          blastDesign.section.totalH.toFixed(1)
          }}m</span>
      </div>
      <div class="stat-item">
        <span>断面面积</span><span class="stat-value">{{ blastDesign.section.area.toFixed(2) }} m²</span>
      </div>
      <div class="stat-item">
        <span>单循环进尺</span><span class="stat-value">{{ blastDesign.advanceDepth.toFixed(2) }} m</span>
      </div>
      <div class="stat-item">
        <span>单循环爆破方量</span><span class="stat-value">{{ blastDesign.volumePerRound.toFixed(2) }} m³</span>
      </div>
      <div class="stat-item">
        <span>爆破漏斗深度</span><span class="stat-value">{{ blastDesign.craterDepth?.toFixed(2) }} m</span>
      </div>
      <div class="stat-item">
        <span>掌子面平整度</span><span class="stat-value">{{ blastDesign.faceSmoothness }}% (半孔率)</span>
      </div>
    </div>

    <div v-if="blastDesign" class="mt-3">
      <div class="panel-subtitle">装药参数</div>
      <div class="stat-item">
        <span>掏槽孔药量</span><span class="stat-value">{{ blastDesign.charge.cut.toFixed(1) }} kg</span>
      </div>
      <div class="stat-item">
        <span>辅助孔药量</span><span class="stat-value">{{ blastDesign.charge.auxiliary.toFixed(1) }} kg</span>
      </div>
      <div class="stat-item">
        <span>周边孔药量</span><span class="stat-value">{{ blastDesign.charge.perimeter.toFixed(1) }} kg</span>
      </div>
      <div class="stat-item">
        <span>总装药量</span><span class="stat-value">{{ blastDesign.charge.total.toFixed(1) }} kg</span>
      </div>
      <div class="stat-item">
        <span>炸药单耗</span><span class="stat-value">{{ blastDesign.charge.specific.toFixed(3) }} kg/m³</span>
      </div>
    </div>

    <!-- KCO 模型参数输入 -->
    <div class="mt-3 kco-panel">
      <div class="panel-subtitle">
        KCO 碎块分布模型参数
        <span class="kco-hint">动态调整后点击「应用并重播」生效</span>
      </div>
      <div class="hint-text kco-desc">
        KCO = Kuznetsov-Cunningham 中位块度 x50 + Ouchterlony Swebrec 分布。
        调整参数后碎片尺寸与抛掷效果将动态更新。
      </div>

      <div class="kco-group-title">断面尺寸与掏槽形式</div>
      <div class="kco-grid">
        <label class="kco-field">
          <span class="kco-label">断面形状</span>
          <select v-model="sectionForm.shape" class="db-event-select">
            <option value="horseshoe">马蹄形</option>
            <option value="circular">圆形</option>
            <option value="rectangular">矩形</option>
          </select>
        </label>
        <label class="kco-field">
          <span class="kco-label">宽度 W (m)</span>
          <el-input-number v-model="sectionForm.width" :min="4" :max="30" :step="0.5" :precision="1" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">直墙高 (m)</span>
          <el-input-number v-model="sectionForm.wallHeight" :min="2" :max="15" :step="0.5" :precision="1"
            :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">拱半径 (m)</span>
          <el-input-number v-model="sectionForm.archRadius" :min="2" :max="15" :step="0.5" :precision="1"
            :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">掏槽形式</span>
          <select v-model="cutPattern" class="db-event-select">
            <option value="diamond">菱形掏槽</option>
            <option value="spiral">螺旋掏槽</option>
            <option value="wedge">楔形掏槽</option>
          </select>
        </label>
      </div>
      <div class="hint-text kco-desc">
        总高度 {{ sectionDerived.totalH.toFixed(1) }}m · 断面积
        {{ sectionDerived.area.toFixed(2) }}m²
        <button class="compact-action-btn primary" style="margin-left: 12px" @click="applySection">
          应用断面并重布孔
        </button>
      </div>

      <div class="kco-group-title mt-3">场地预设</div>
      <div class="controls-row">
        <select v-model="selectedPresetKey" class="db-event-select">
          <option value="">-- 选择场地预设 --</option>
          <option v-for="(p, key) in SITE_PRESETS" :key="key" :value="key">{{ p.label }}</option>
        </select>
        <button class="compact-action-btn primary" :disabled="!selectedPresetKey" @click="applyPreset">
          应用预设
        </button>
      </div>
      <div class="hint-text kco-desc">一键填充岩石因子 + 装药 + 孔网典型值，覆盖当前参数。</div>

      <div class="kco-group-title mt-3">爆破设计与炸药参数</div>
      <div class="kco-grid">
        <label class="kco-field">
          <span class="kco-label">Q 单孔装药量 (kg)</span>
          <el-input-number v-model="kcoParams.Q" :min="1" :max="2000" :step="10" :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">q 炸药单耗 (kg/m³)</span>
          <el-input-number v-model="kcoParams.q" :min="0.1" :max="5" :step="0.05" :precision="3" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">B 抵抗线 (m)</span>
          <el-input-number v-model="kcoParams.B" :min="0.3" :max="5" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">S 孔间距 (m)</span>
          <el-input-number v-model="kcoParams.S" :min="0.3" :max="6" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">炸药类型</span>
          <select :value="explosiveType" class="db-event-select"
            @change="explosiveType = $event.target.value; onExplosiveChange()">
            <option v-for="(e, key) in EXPLOSIVE_TYPES" :key="key" :value="key">
              {{ e.label }}
            </option>
          </select>
        </label>
        <label class="kco-field">
          <span class="kco-label">SANFO 相对ANFO威力 (%)</span>
          <el-input-number v-model="kcoParams.SANFO" :min="50" :max="200" :step="5" :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">d 炮孔直径 (mm)</span>
          <el-input-number v-model="kcoParams.d" :min="30" :max="300" :step="5" :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">Lb 底部装药长度 (m)</span>
          <el-input-number v-model="kcoParams.Lb" :min="0.2" :max="8" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">Lc 柱状装药长度 (m)</span>
          <el-input-number v-model="kcoParams.Lc" :min="0.2" :max="10" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">Ltot 总装药长度 (m)</span>
          <el-input-number v-model="kcoParams.Ltot" :min="0.5" :max="15" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">H 台阶高度 (m)</span>
          <el-input-number v-model="kcoParams.H" :min="1" :max="15" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">SD 钻孔精度标准差 (m)</span>
          <el-input-number v-model="kcoParams.SD" :min="0" :max="2" :step="0.05" :precision="3" :controls="false"
            size="small" />
        </label>
      </div>

      <div class="kco-group-title mt-3">岩石与岩体参数（A = 0.06×(RMD+RDI+HF)）</div>
      <div class="kco-grid">
        <label class="kco-field">
          <span class="kco-label">RMD 岩体描述因子 (0-30)</span>
          <el-input-number v-model="kcoParams.RMD" :min="0" :max="30" :step="1" :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">RDI 岩石密度影响 (0-20)</span>
          <el-input-number v-model="kcoParams.RDI" :min="0" :max="20" :step="1" :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">HF 硬度因子 (0-30)</span>
          <el-input-number v-model="kcoParams.HF" :min="0" :max="30" :step="1" :controls="false" size="small" />
        </label>
      </div>

      <div class="kco-group-title mt-3">模型输出与分布参数</div>
      <div class="kco-grid">
        <label class="kco-field">
          <span class="kco-label">xmax 最大块度尺寸 (m)</span>
          <el-input-number v-model="kcoParams.xmax" :min="0.2" :max="5" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">b Swebrec 曲线弯曲参数</span>
          <el-input-number v-model="kcoParams.b" :min="1.0" :max="5.0" :step="0.1" :precision="2" :controls="false"
            size="small" />
        </label>
      </div>

      <div class="kco-group-title mt-3">
        <button class="compact-action-btn" @click="advancedOpen = !advancedOpen">
          {{ advancedOpen ? '▼' : '▶' }} 高级参数（Persson η / 钻孔偏差 / 速度校准开关）
        </button>
      </div>
      <div v-show="advancedOpen" class="kco-grid mt-2">
        <label class="kco-field">
          <span class="kco-label">η 能量耦合系数 (Persson 速度模型)</span>
          <el-input-number v-model="kcoParams.eta" :min="0.05" :max="0.4" :step="0.01" :precision="3" :controls="false"
            size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">W_abs 钻孔偏差 (m)</span>
          <el-input-number v-model="kcoParams.drillDeviation" :min="0" :max="0.5" :step="0.01" :precision="3"
            :controls="false" size="small" />
        </label>
        <label class="kco-field">
          <span class="kco-label">启用速度校准（默认关）</span>
          <el-switch v-model="kcoParams.enableVelocityCalibration" />
        </label>
        <label class="kco-field">
          <span class="kco-label">Persson 速度模型（默认开）</span>
          <el-switch :model-value="kcoParams.usePerssonVelocity !== false"
            @update:model-value="kcoParams.usePerssonVelocity = $event" />
        </label>
      </div>

      <div class="kco-preview mt-3">
        <div class="stat-item">
          <span>当前口径</span><span class="stat-value">{{ kcoSourceLabel }}</span>
        </div>
        <div class="stat-item">
          <span>岩石因子 A</span><span class="stat-value">{{
            (0.06 * (kcoParams.RMD + kcoParams.RDI + kcoParams.HF)).toFixed(3)
            }}</span>
        </div>
        <div class="stat-item">
          <span>单孔爆破体积 V (m³)</span><span class="stat-value">{{
            (kcoParams.B * kcoParams.S * kcoParams.H).toFixed(2)
            }}</span>
        </div>
        <div class="stat-item">
          <span>中位块度 x50 (m)</span><span class="stat-value">{{ kcoX50.toFixed(3) }}</span>
        </div>
        <div class="stat-item">
          <span>均匀性指数 n</span><span class="stat-value">{{ kcoN.toFixed(3) }}</span>
        </div>
        <div class="stat-item">
          <span>最大块度 xmax (m)</span><span class="stat-value">{{ kcoXmax.toFixed(3) }}</span>
        </div>
        <div class="stat-item">
          <span>x80 块度 (m)</span><span class="stat-value">{{ kcoX80.toFixed(3) }}</span>
        </div>
        <div class="stat-item">
          <span>单循环爆破方量 (m³)</span><span class="stat-value">{{ brokenVolume.toFixed(2) }}</span>
        </div>
        <div class="stat-item">
          <span>预计碎片数</span><span class="stat-value">~{{ fragmentCountEst }}</span>
        </div>
      </div>

      <!-- 孔型权重只读展示 -->
      <div class="mt-3 hole-weight-panel">
        <div class="panel-subtitle">孔型权重（只读）</div>
        <div class="hint-text kco-desc">
          不同孔型对碎石速度、粒径与方向的工程经验影响系数，由系统固定。
        </div>
        <table class="hole-weight-table">
          <thead>
            <tr>
              <th>孔型</th>
              <th>速度系数</th>
              <th>粒径系数</th>
              <th>轴向偏置</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>掏槽孔 (cut)</td>
              <td>{{ HOLE_TYPE_WEIGHTS.cut.velocityFactor.toFixed(2) }}</td>
              <td>{{ HOLE_TYPE_WEIGHTS.cut.sizeFactor.toFixed(2) }}</td>
              <td>{{ formatSignedBias(HOLE_TYPE_WEIGHTS.cut.axialBias) }}</td>
            </tr>
            <tr>
              <td>辅助孔 (auxiliary)</td>
              <td>{{ HOLE_TYPE_WEIGHTS.auxiliary.velocityFactor.toFixed(2) }}</td>
              <td>{{ HOLE_TYPE_WEIGHTS.auxiliary.sizeFactor.toFixed(2) }}</td>
              <td>{{ formatSignedBias(HOLE_TYPE_WEIGHTS.auxiliary.axialBias) }}</td>
            </tr>
            <tr>
              <td>周边孔 (perimeter)</td>
              <td>{{ HOLE_TYPE_WEIGHTS.perimeter.velocityFactor.toFixed(2) }}</td>
              <td>{{ HOLE_TYPE_WEIGHTS.perimeter.sizeFactor.toFixed(2) }}</td>
              <td>{{ formatSignedBias(HOLE_TYPE_WEIGHTS.perimeter.axialBias) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="controls-row mt-3">
        <button class="compact-action-btn primary" :disabled="!dataset || kcoReplaying" @click="applyKcoAndReplay">
          {{ kcoReplaying ? '预览中…' : '立即重播' }}
        </button>
        <button class="compact-action-btn" :disabled="kcoReplaying" @click="$emit('reset-kco')">
          恢复默认
        </button>
      </div>
      <div v-if="kcoReplaying" class="hint-text text-ok mt-2">参数已变化，正在自动预览重播…</div>
      <div v-if="!dataset" class="hint-text mt-2">请先加载数据后再应用 KCO 参数</div>

      <!-- 方案保存与加载 -->
      <div class="preset-section mt-3">
        <div class="panel-subtitle">方案保存与加载</div>
        <div class="controls-row">
          <input v-model="presetName" class="preset-name-input" placeholder="方案名称（如：硬岩深孔）" />
          <button class="compact-action-btn primary" @click="savePreset">保存当前方案</button>
        </div>
        <div class="controls-row mt-2">
          <select v-model="selectedPresetId" class="db-event-select" @change="onPresetSelect">
            <option value="">-- 选择已保存方案 --</option>
            <option v-for="p in presetList" :key="p.id" :value="p.id">
              {{ p.name }}（{{ p.savedAt }}）
            </option>
          </select>
          <button class="compact-action-btn" :disabled="!selectedPresetId" @click="loadPreset">
            加载
          </button>
          <button class="compact-action-btn danger" :disabled="!selectedPresetId" @click="deletePreset">
            删除
          </button>
        </div>
        <div v-if="presetList.length === 0" class="hint-text">暂无已保存方案</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  KCO_SOURCE_MODE,
  calculateKCOParams,
  SITE_PRESETS,
  EXPLOSIVE_TYPES
} from '../services/core/computation/kcoModelCore.js'
import { HOLE_TYPE_WEIGHTS } from '../services/core/rendering/fragmentSpecGenerator'

defineOptions({ name: 'BlastDesign' })

const props = defineProps({
  dataset: { type: Object, default: null },
  blastDesign: { type: Object, default: null },
  kcoParams: { type: Object, required: true }
})

const emit = defineEmits(['replay-blast', 'reset-kco', 'update-section'])

// ─── 断面尺寸编辑 ───────────────────────
const sectionForm = ref({
  width: 12,
  wallHeight: 5,
  archRadius: 6,
  shape: 'horseshoe'
})
const cutPattern = ref('diamond')

// 从 blastDesign.section 同步初始值（外部更新时跟随）
watch(
  () => props.blastDesign?.section,
  (s) => {
    if (!s) return
    if (s.W != null) sectionForm.value.width = s.W
    if (s.wallHeight != null) sectionForm.value.wallHeight = s.wallHeight
    if (s.archRadius != null) sectionForm.value.archRadius = s.archRadius
    if (s.shape != null) sectionForm.value.shape = s.shape
  },
  { immediate: true }
)

// 派生值：总高度 + 断面积（马蹄形 = 直墙矩形 + 半圆拱）
const sectionDerived = computed(() => {
  const { width: w, wallHeight: hw, archRadius: r } = sectionForm.value
  const totalH = hw + r
  const area = w * hw + (Math.PI * r * r) / 2
  return { totalH, area }
})

function applySection() {
  emit('update-section', {
    width: Number(sectionForm.value.width),
    wallHeight: Number(sectionForm.value.wallHeight),
    archRadius: Number(sectionForm.value.archRadius),
    shape: sectionForm.value.shape,
    cutPattern: cutPattern.value
  })
}

// 格式化带符号的轴向偏置（正数前加 +，零与负数原样输出）
function formatSignedBias(n) {
  const v = Number(n) || 0
  if (v > 0) return `+${v.toFixed(2)}`
  return v.toFixed(2)
}

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
  return {
    x: (holeLayoutSize - W * s) / 2,
    y: (holeLayoutSize - H * s) / 2
  }
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
  const { W, Hw, R, totalH } = props.blastDesign.section
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
const HOLE_TYPE_DELAY_MS = { cut: 0, auxiliary: 100, perimeter: 250 }
const selectedHole = ref(null)
const holePopoverRef = ref(null)
const holePopoverVisible = ref(false)

const selectedHoleDetail = computed(() => {
  const h = selectedHole.value
  const d = props.blastDesign
  if (!h || !d) return null
  const typeLabel = h.isEmpty ? '空孔' : HOLE_TYPE_LABELS[h.type] || '未知'
  const depth = d.holeDepth ?? 0
  let charge = 0
  if (!h.isEmpty) {
    const c = d.charge || {}
    const n = d.counts || {}
    if (h.type === 'cut' && n.cut) charge = c.cut / n.cut
    else if (h.type === 'auxiliary' && n.auxiliary) charge = c.auxiliary / n.auxiliary
    else if (h.type === 'perimeter' && n.perimeter) charge = c.perimeter / n.perimeter
  }
  const delay = h.isEmpty ? 0 : (HOLE_TYPE_DELAY_MS[h.type] ?? 0)
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
  selectedHole.value = h
  holePopoverRef.value = event?.target || null
  holePopoverVisible.value = true
}
function closeHolePopover() {
  holePopoverVisible.value = false
}

// ─── KCO 模型计算预览 ────────────────────
const kcoPreview = computed(() => {
  const params = {}
  for (const k of Object.keys(props.kcoParams || {})) {
    params[k] = k === 'sourceMode' ? props.kcoParams[k] : Number(props.kcoParams[k])
  }
  return calculateKCOParams(params)
})

const kcoSourceLabel = computed(() => {
  return kcoPreview.value?.sourceMode === KCO_SOURCE_MODE.RESULT ? '结果驱动' : '设计驱动'
})

const kcoX50 = computed(() => {
  const x50 = kcoPreview.value?.x50
  return isFinite(x50) ? x50 : 0
})

const kcoN = computed(() => {
  const n = kcoPreview.value?.n
  return isFinite(n) ? n : 0.5
})

const kcoXmax = computed(() => {
  const v = Number(props.kcoParams.xmax)
  return Math.max(0.2, Math.min(5.0, isFinite(v) ? v : 2.0))
})

// ─── 场地预设 ───────────────────────────
const selectedPresetKey = ref('')

function applyPreset() {
  const key = selectedPresetKey.value
  const preset = SITE_PRESETS[key]
  if (!preset) return
  // 仅覆盖预设内含的字段，不触碰 Lb/Lc/Ltot/SD 等
  for (const k of Object.keys(preset)) {
    if (k === 'label') continue
    props.kcoParams[k] = preset[k]
  }
  // 联动炸药类型：根据 SANFO 反推
  const matchedType = Object.keys(EXPLOSIVE_TYPES).find(
    (t) => EXPLOSIVE_TYPES[t].SANFO === preset.SANFO
  )
  if (matchedType) props.kcoParams.explosiveType = matchedType
  ElMessage.success(`已应用预设：${preset.label}`)
}

// ─── 炸药类型 ───────────────────────────
const explosiveType = computed({
  get: () => props.kcoParams.explosiveType || 'emulsion',
  set: (v) => {
    props.kcoParams.explosiveType = v
  }
})

function onExplosiveChange() {
  const info = EXPLOSIVE_TYPES[explosiveType.value]
  if (info) {
    props.kcoParams.SANFO = info.SANFO
    // Eg 由 fragmentSpecGenerator 读取，存入 kcoParams 供其使用
    props.kcoParams.Eg = info.Eg
  }
}

// ─── 高级参数面板 ───────────────────────
const advancedOpen = ref(false)

// ─── 扩展预览：x80 / 破碎量 / 碎片数估算 ──
const kcoX80 = computed(() => {
  const x80 = kcoPreview.value?.x80
  return isFinite(x80) ? x80 : 0
})

// 单循环爆破体积 V = B × S × H（与预览卡片一致）
const brokenVolume = computed(() => {
  const B = Number(props.kcoParams.B) || 0
  const S = Number(props.kcoParams.S) || 0
  const H = Number(props.kcoParams.H) || 0
  return B * S * H
})

// 碎片数估算：V × 0.8 / E[physSize³]，E[physSize³] = π/6 × x50³（Swebrec 期望体积近似）
const fragmentCountEst = computed(() => {
  const x50 = kcoX50.value
  if (x50 <= 0 || brokenVolume.value <= 0) return 0
  const avgFragVol = (Math.PI / 6) * Math.pow(x50, 3)
  if (avgFragVol <= 0) return 0
  const count = (brokenVolume.value * 0.8) / avgFragVol
  // 与 fragmentSpecGenerator 的 soft cap 3000 / floor 60 对齐
  return Math.max(60, Math.min(3000, Math.round(count)))
})

// ─── KCO 重播 ─────────────────────────────
const kcoReplaying = ref(false)
let kcoDebounceTimer = null
let kcoNeedsReplay = false

function applyKcoAndReplay() {
  if (!props.dataset) return
  props.kcoParams.sourceMode = KCO_SOURCE_MODE.DESIGN
  kcoReplaying.value = true
  emit('replay-blast')
  setTimeout(() => {
    kcoReplaying.value = false
  }, 600)
}

watch(
  () => {
    const p = props.kcoParams
    if (!p) return p
    // 排除 sourceMode：watch 回调内会修改 sourceMode，deep watch 会捕获该修改形成循环
    const { sourceMode, ...rest } = p
    return JSON.stringify(rest)
  },
  () => {
    if (!props.dataset) return
    if (kcoReplaying.value) {
      kcoNeedsReplay = true
      return
    }
    if (kcoDebounceTimer) clearTimeout(kcoDebounceTimer)
    kcoDebounceTimer = setTimeout(() => {
      kcoReplaying.value = true
      props.kcoParams.sourceMode = KCO_SOURCE_MODE.DESIGN
      emit('replay-blast')
      setTimeout(() => {
        kcoReplaying.value = false
        if (kcoNeedsReplay) {
          kcoNeedsReplay = false
          kcoDebounceTimer = setTimeout(() => {
            kcoReplaying.value = true
            props.kcoParams.sourceMode = KCO_SOURCE_MODE.DESIGN
            emit('replay-blast')
            setTimeout(() => {
              kcoReplaying.value = false
            }, 600)
          }, 200)
        }
      }, 600)
    }, 800)
  }
)

// ─── 方案保存与加载 ───────────────────────
const PRESET_STORAGE_KEY = 'blasting_presets'
const presetName = ref('')
const selectedPresetId = ref('')
const presetList = ref([])

function formatPresetTime(ts) {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function loadPresetList() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY)
    presetList.value = raw ? JSON.parse(raw) : []
  } catch (e) {
    presetList.value = []
  }
}

function persistPresets() {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presetList.value))
  } catch (e) {
    ElMessage.error('方案保存失败：本地存储不可用')
  }
}

function savePreset() {
  const name = presetName.value.trim()
  if (!name) {
    ElMessage.warning('请输入方案名称')
    return
  }
  const preset = {
    id: `preset_${Date.now()}`,
    name,
    savedAt: formatPresetTime(Date.now()),
    params: { ...props.kcoParams }
  }
  presetList.value.unshift(preset)
  persistPresets()
  presetName.value = ''
  ElMessage.success(`方案「${name}」已保存`)
}

function onPresetSelect() { }

function loadPreset() {
  const preset = presetList.value.find(p => p.id === selectedPresetId.value)
  if (!preset) {
    ElMessage.warning('未找到该方案')
    return
  }
  // 通过 v-model 绑定的 kcoParams 是引用类型，直接修改 key 即可
  Object.assign(props.kcoParams, preset.params)
  ElMessage.success(`方案「${preset.name}」已加载`)
}

function deletePreset() {
  const idx = presetList.value.findIndex(p => p.id === selectedPresetId.value)
  if (idx < 0) return
  const name = presetList.value[idx].name
  presetList.value.splice(idx, 1)
  persistPresets()
  selectedPresetId.value = ''
  ElMessage.success(`方案「${name}」已删除`)
}

loadPresetList()
</script>

<style scoped>
.hole-weight-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 6px;
}

.hole-weight-table th,
.hole-weight-table td {
  padding: 4px 8px;
  text-align: center;
  border: 1px solid #3a3a3a;
}

.hole-weight-table th {
  background: #2a2a2a;
  color: #ddd;
  font-weight: 600;
}

.hole-weight-table td {
  color: #ccc;
}

.hole-weight-table td:first-child {
  text-align: left;
}
</style>
