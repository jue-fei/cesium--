<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 overflow-y-auto pr-1">
      <div v-for="section in objectControlSections" :key="section.key" class="mb-6">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-4 bg-primary rounded-sm"></div>
          <h4 class="text-sm font-semibold text-text-primary">{{ section.title }}</h4>
        </div>

        <div v-for="control in section.controls" :key="control.key" class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">{{ control.label }}</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{
              formatObjectControlValue(control)
            }}</span>
          </div>
          <div class="flex items-center gap-3">
            <input
              :value="getObjectControlValue(section.source, control.key)"
              type="range"
              :min="control.min"
              :max="control.max"
              :step="control.step"
              class="modern-slider flex-1"
              @input="updateObjectControl(section.source, control, $event, section.handler)"
            />
            <input
              :value="getObjectControlValue(section.source, control.key)"
              type="number"
              :min="control.min"
              :max="control.max"
              :step="control.step"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="updateObjectControl(section.source, control, $event, section.handler)"
            />
          </div>
        </div>
        <div v-if="section.showDivider" class="h-px bg-white/10 my-6"></div>
      </div>

      <div class="mb-6">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-4 bg-primary rounded-sm"></div>
          <h4 class="text-sm font-semibold text-text-primary">地下查看</h4>
        </div>

        <div class="mb-4 flex items-center justify-between">
          <span class="text-xs text-text-secondary">开启地下查看</span>
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input
              v-model="undergroundViewEnabled"
              type="checkbox"
              class="accent-blue-500"
              @change="onUndergroundToggle"
            />
            <span class="text-xs text-text-secondary">{{
              undergroundViewEnabled ? '开启' : '关闭'
            }}</span>
          </label>
        </div>

        <div v-for="control in alphaControls" :key="control.key" class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">{{ control.label }}</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              {{ formatRefControlValue(control) }}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <input
              :value="control.model.value"
              type="range"
              :min="control.min"
              :max="control.max"
              :step="control.step"
              class="modern-slider flex-1"
              @input="updateRefControl(control, $event, onGlobeAlphaChange)"
            />
            <input
              :value="control.model.value"
              type="number"
              :min="control.min"
              :max="control.max"
              :step="control.step"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="updateRefControl(control, $event, onGlobeAlphaChange)"
            />
          </div>
        </div>

        <div class="flex justify-end pt-1">
          <button
            class="px-4 py-1.5 bg-white/10 hover:bg-white/20 text-text-primary text-sm rounded shadow-sm transition-colors border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!undergroundViewEnabled"
            @click="enterUndergroundView"
          >
            进入地下视角
          </button>
        </div>
      </div>

      <div class="flex justify-end pt-2 gap-3">
        <button
          class="px-4 py-1.5 bg-primary hover:bg-primary-dark text-white text-sm rounded shadow-sm transition-colors"
          @click="resetView"
        >
          重置视角
        </button>
        <button
          class="px-4 py-1.5 bg-white/10 hover:bg-white/20 text-text-primary text-sm rounded shadow-sm transition-colors border border-white/10"
          @click="resetModel"
        >
          重置模型
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '模型控制面板' })
import { useModelTransformPanelController } from '../services/panel/useModelTransformPanelController.js'

const {
  modelPosition,
  modelTransform,
  resetView,
  resetModel,
  undergroundViewEnabled,
  globeFrontFaceAlpha,
  globeBackFaceAlpha,
  enterUndergroundView,
  onPositionChange,
  onTransformChange,
  onUndergroundToggle,
  onGlobeAlphaChange
} = useModelTransformPanelController()

const positionControls = [
  {
    key: 'longitude',
    label: '经度',
    min: 113.313,
    max: 113.333,
    step: 0.00001,
    format: value => Number(value).toFixed(5)
  },
  {
    key: 'latitude',
    label: '纬度',
    min: 23.096,
    max: 23.116,
    step: 0.00001,
    format: value => Number(value).toFixed(5)
  },
  {
    key: 'height',
    label: '高度 (米)',
    min: 0,
    max: 5000,
    step: 1,
    format: value => `${Math.round(Number(value) || 0)}`
  }
]

const rotationControls = [
  { key: 'rotationX', label: 'X轴旋转', min: -180, max: 180, step: 1, suffix: '°' },
  { key: 'rotationY', label: 'Y轴旋转', min: -180, max: 180, step: 1, suffix: '°' },
  { key: 'rotationZ', label: 'Z轴旋转', min: -180, max: 180, step: 1, suffix: '°' }
]

const objectControlSections = [
  {
    key: 'position',
    title: '位置控制',
    source: modelPosition,
    controls: positionControls,
    handler: onPositionChange,
    showDivider: true
  },
  {
    key: 'rotation',
    title: '旋转控制',
    source: modelTransform,
    controls: rotationControls,
    handler: onTransformChange,
    showDivider: true
  }
]

const alphaControls = [
  {
    key: 'front-face-alpha',
    label: '地表不透明度',
    min: 0,
    max: 100,
    step: 1,
    suffix: '%',
    model: globeFrontFaceAlpha
  },
  {
    key: 'back-face-alpha',
    label: '背面不透明度',
    min: 0,
    max: 100,
    step: 1,
    suffix: '%',
    model: globeBackFaceAlpha
  }
]

function formatObjectControlValue(control) {
  const source = control.key in modelPosition.value ? modelPosition.value : modelTransform.value
  const value = source[control.key]
  if (typeof control.format === 'function') return control.format(value)
  return `${Math.round(Number(value) || 0)}${control.suffix || ''}`
}

function formatRefControlValue(control) {
  return `${Math.round(Number(control.model.value) || 0)}${control.suffix || ''}`
}

function getObjectControlValue(sourceRef, key) {
  return sourceRef?.value?.[key] ?? 0
}

function updateObjectControl(source, control, event, handler) {
  if (!source?.value) return
  source.value[control.key] = Number(event?.target?.value ?? 0)
  handler()
}

function updateRefControl(control, event, handler) {
  control.model.value = Number(event?.target?.value ?? 0)
  handler()
}
</script>

<style scoped>
.model-controls-content {
  padding: 16px;
}

.panel-section {
  margin-bottom: 24px;
}

.panel-section-title {
  font-size: 14px;
  color: var(--text-secondary);
  font-weight: 600;
  margin-bottom: 16px;
  padding-left: 8px;
  border-left: 3px solid var(--primary-color);
}

.control-item {
  margin-bottom: 16px;
}

.control-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.control-label {
  font-size: 12px;
  color: var(--text-muted);
}

.control-value {
  font-size: 12px;
  color: var(--primary-color);
  font-family: monospace;
}

.control-body {
  display: flex;
  align-items: center;
  gap: 12px;
}

.divider {
  height: 1px;
  background: var(--border-primary);
  margin: 24px 0;
}

.action-buttons {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.primary-btn,
.secondary-btn {
  flex: 1;
  padding: 8px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.primary-btn {
  background: var(--primary-color);
  color: white;
}

.primary-btn:hover {
  background: var(--primary-light);
}

.secondary-btn {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.secondary-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>
