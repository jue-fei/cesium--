<template>
  <div>
    <div class="section-title">
      KCO 碎块分布参数
      <span class="hint" style="font-weight: 400">调整后点击「立即重播」生效</span>
    </div>

    <div class="section">
      <div class="section-title">断面与掏槽</div>
      <div class="grid-auto">
        <label class="field">
          <span class="field-label">断面形状</span>
          <select v-model="sectionForm.shape" class="sel">
            <option value="horseshoe">马蹄形</option>
            <option value="circular">圆形</option>
            <option value="rectangular">矩形</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">宽度 W (m)</span>
          <el-input-number
            v-model="sectionForm.width"
            :min="4"
            :max="30"
            :step="0.5"
            :precision="1"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">直墙高 (m)</span>
          <el-input-number
            v-model="sectionForm.wallHeight"
            :min="2"
            :max="15"
            :step="0.5"
            :precision="1"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">拱半径 (m)</span>
          <el-input-number
            v-model="sectionForm.archRadius"
            :min="2"
            :max="15"
            :step="0.5"
            :precision="1"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">掏槽形式</span>
          <select :value="cutPattern" class="sel" @change="onCutPatternChange">
            <option value="diamond">菱形掏槽</option>
            <option value="spiral">螺旋掏槽</option>
            <option value="wedge">楔形掏槽</option>
          </select>
        </label>
      </div>
      <div class="row mt-1">
        <span class="hint"
          >总高 {{ sectionDerived.totalH.toFixed(1) }}m · 面积
          {{ sectionDerived.area.toFixed(2) }}m²</span
        >
        <button class="btn primary" style="margin-left: auto" @click="$emit('apply-section')">
          应用断面并重布孔
        </button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">场地预设</div>
      <div class="row">
        <select
          :value="selectedPresetKey"
          class="sel"
          style="flex: 1; min-width: 140px"
          @change="onPresetKeyChange"
        >
          <option value="">-- 选择场地预设 --</option>
          <option v-for="(preset, key) in sitePresets" :key="key" :value="key">
            {{ preset.label }}
          </option>
        </select>
        <button class="btn primary" :disabled="!selectedPresetKey" @click="$emit('apply-preset')">
          应用
        </button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">爆破设计与炸药</div>
      <div class="grid-auto">
        <label class="field">
          <span class="field-label">Q 单孔药量 (kg)</span>
          <el-input-number
            v-model="kcoParams.Q"
            :min="1"
            :max="2000"
            :step="10"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">q 单耗 (kg/m³)</span>
          <el-input-number
            v-model="kcoParams.q"
            :min="0.1"
            :max="5"
            :step="0.05"
            :precision="3"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">B 抵抗线 (m)</span>
          <el-input-number
            v-model="kcoParams.B"
            :min="0.3"
            :max="5"
            :step="0.1"
            :precision="2"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">S 孔间距 (m)</span>
          <el-input-number
            v-model="kcoParams.S"
            :min="0.3"
            :max="6"
            :step="0.1"
            :precision="2"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">炸药类型</span>
          <select :value="explosiveType" class="sel" @change="onExplosiveSelect">
            <option v-for="(explosive, key) in explosiveTypes" :key="key" :value="key">
              {{ explosive.label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">SANFO 威力 (%)</span>
          <el-input-number
            v-model="kcoParams.SANFO"
            :min="50"
            :max="200"
            :step="5"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">d 孔径 (mm)</span>
          <el-input-number
            v-model="kcoParams.d"
            :min="30"
            :max="300"
            :step="5"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">H 台阶高 (m)</span>
          <el-input-number
            v-model="kcoParams.H"
            :min="1"
            :max="15"
            :step="0.1"
            :precision="2"
            :controls="false"
            size="small"
          />
        </label>
      </div>
    </div>

    <div class="section">
      <div class="section-title">岩石与岩体（A = 0.06×(RMD+RDI+HF)）</div>
      <div class="grid-auto">
        <label class="field">
          <span class="field-label">RMD 岩体描述 (0-30)</span>
          <el-input-number
            v-model="kcoParams.RMD"
            :min="0"
            :max="30"
            :step="1"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">RDI 密度影响 (0-20)</span>
          <el-input-number
            v-model="kcoParams.RDI"
            :min="0"
            :max="20"
            :step="1"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">HF 硬度因子 (0-30)</span>
          <el-input-number
            v-model="kcoParams.HF"
            :min="0"
            :max="30"
            :step="1"
            :controls="false"
            size="small"
          />
        </label>
      </div>
    </div>

    <div class="section">
      <div class="section-title">分布参数</div>
      <div class="grid-auto">
        <label class="field">
          <span class="field-label">xmax 最大块度 (m)</span>
          <el-input-number
            v-model="kcoParams.xmax"
            :min="0.2"
            :max="5"
            :step="0.1"
            :precision="2"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">b 弯曲参数</span>
          <el-input-number
            v-model="kcoParams.b"
            :min="1.0"
            :max="5.0"
            :step="0.1"
            :precision="2"
            :controls="false"
            size="small"
          />
        </label>
      </div>
      <div class="row mt-2">
        <button class="btn" @click="$emit('toggle-advanced')">
          {{ advancedOpen ? '▼' : '▶' }} 高级参数
        </button>
      </div>
      <div v-show="advancedOpen" class="grid-auto mt-2">
        <label class="field">
          <span class="field-label">η 能量耦合 (Persson)</span>
          <el-input-number
            v-model="kcoParams.eta"
            :min="0.05"
            :max="0.4"
            :step="0.01"
            :precision="3"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label" title="1.0=纯物理量级（默认）；调小收缩抛距、爆堆更贴掌子面"
            >抛掷速度收缩</span
          >
          <el-input-number
            v-model="kcoParams.velocityScale"
            :min="0.05"
            :max="3"
            :step="0.05"
            :precision="2"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">W_abs 钻孔偏差 (m)</span>
          <el-input-number
            v-model="kcoParams.drillDeviation"
            :min="0"
            :max="0.5"
            :step="0.01"
            :precision="3"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">碎片渲染上限</span>
          <el-input-number
            v-model="kcoParams.fragmentCountRenderLimit"
            :min="40"
            :max="20000"
            :step="100"
            :controls="false"
            size="small"
          />
        </label>
        <label class="field">
          <span class="field-label">速度校准</span>
          <el-switch v-model="kcoParams.enableVelocityCalibration" />
        </label>
        <label class="field">
          <span class="field-label">Persson 速度模型</span>
          <el-switch
            :model-value="kcoParams.usePerssonVelocity !== false"
            @update:model-value="kcoParams.usePerssonVelocity = $event"
          />
        </label>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: 'BlastKcoEditor' })

const sectionForm = defineModel('sectionForm', { type: Object, required: true })
const kcoParams = defineModel('kcoParams', { type: Object, required: true })

defineProps({
  cutPattern: { type: String, default: 'diamond' },
  sectionDerived: { type: Object, required: true },
  selectedPresetKey: { type: String, default: '' },
  sitePresets: { type: Object, required: true },
  explosiveTypes: { type: Object, required: true },
  explosiveType: { type: String, default: 'emulsion' },
  advancedOpen: { type: Boolean, default: false }
})

const emit = defineEmits([
  'apply-section',
  'update:cut-pattern',
  'update:selected-preset-key',
  'apply-preset',
  'explosive-select',
  'toggle-advanced'
])

function onCutPatternChange(event) {
  emit('update:cut-pattern', event?.target?.value || 'diamond')
}
function onPresetKeyChange(event) {
  emit('update:selected-preset-key', event?.target?.value || '')
}
function onExplosiveSelect(event) {
  emit('explosive-select', event)
}
</script>
