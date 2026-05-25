<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 overflow-y-auto pr-1">
      <!-- 位置控制 -->
      <div class="mb-6">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-4 bg-primary rounded-sm"></div>
          <h4 class="text-sm font-semibold text-text-primary">位置控制</h4>
        </div>

        <!-- 经度 -->
        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">经度</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{
              modelPosition.longitude.toFixed(5)
            }}</span>
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="modelPosition.longitude"
              type="range"
              :min="113.313"
              :max="113.333"
              :step="0.00001"
              class="modern-slider flex-1"
              @input="onPositionChange"
            />
            <input
              v-model.number="modelPosition.longitude"
              type="number"
              :step="0.00001"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onPositionChange"
            />
          </div>
        </div>

        <!-- 纬度 -->
        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">纬度</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{
              modelPosition.latitude.toFixed(5)
            }}</span>
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="modelPosition.latitude"
              type="range"
              :min="23.096"
              :max="23.116"
              :step="0.00001"
              class="modern-slider flex-1"
              @input="onPositionChange"
            />
            <input
              v-model.number="modelPosition.latitude"
              type="number"
              :step="0.00001"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onPositionChange"
            />
          </div>
        </div>

        <!-- 高度 -->
        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">高度 (米)</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{
              modelPosition.height
            }}</span>
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="modelPosition.height"
              type="range"
              :min="0"
              :max="5000"
              :step="1"
              class="modern-slider flex-1"
              @input="onPositionChange"
            />
            <input
              v-model.number="modelPosition.height"
              type="number"
              :step="1"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onPositionChange"
            />
          </div>
        </div>
      </div>

      <div class="h-px bg-white/10 my-6"></div>

      <!-- 旋转控制 -->
      <div class="mb-6">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-1 h-4 bg-primary rounded-sm"></div>
          <h4 class="text-sm font-semibold text-text-primary">旋转控制</h4>
        </div>

        <!-- X轴 -->
        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">X轴旋转</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded"
              >{{ modelTransform.rotationX }}°</span
            >
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="modelTransform.rotationX"
              type="range"
              :min="-180"
              :max="180"
              :step="1"
              class="modern-slider flex-1"
              @input="onTransformChange"
            />
            <input
              v-model.number="modelTransform.rotationX"
              type="number"
              :min="-180"
              :max="180"
              :step="1"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onTransformChange"
            />
          </div>
        </div>

        <!-- Y轴 -->
        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">Y轴旋转</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded"
              >{{ modelTransform.rotationY }}°</span
            >
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="modelTransform.rotationY"
              type="range"
              :min="-180"
              :max="180"
              :step="1"
              class="modern-slider flex-1"
              @input="onTransformChange"
            />
            <input
              v-model.number="modelTransform.rotationY"
              type="number"
              :min="-180"
              :max="180"
              :step="1"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onTransformChange"
            />
          </div>
        </div>

        <!-- Z轴 -->
        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">Z轴旋转</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded"
              >{{ modelTransform.rotationZ }}°</span
            >
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="modelTransform.rotationZ"
              type="range"
              :min="-180"
              :max="180"
              :step="1"
              class="modern-slider flex-1"
              @input="onTransformChange"
            />
            <input
              v-model.number="modelTransform.rotationZ"
              type="number"
              :min="-180"
              :max="180"
              :step="1"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onTransformChange"
            />
          </div>
        </div>
      </div>

      <div class="h-px bg-white/10 my-6"></div>

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

        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">地表不透明度</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded"
              >{{ globeFrontFaceAlpha }}%</span
            >
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="globeFrontFaceAlpha"
              type="range"
              min="0"
              max="100"
              step="1"
              class="modern-slider flex-1"
              @input="onGlobeAlphaChange"
            />
            <input
              v-model.number="globeFrontFaceAlpha"
              type="number"
              min="0"
              max="100"
              step="1"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onGlobeAlphaChange"
            />
          </div>
        </div>

        <div class="mb-4">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-text-secondary">背面不透明度</span>
            <span class="text-[10px] font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded"
              >{{ globeBackFaceAlpha }}%</span
            >
          </div>
          <div class="flex items-center gap-3">
            <input
              v-model.number="globeBackFaceAlpha"
              type="range"
              min="0"
              max="100"
              step="1"
              class="modern-slider flex-1"
              @input="onGlobeAlphaChange"
            />
            <input
              v-model.number="globeBackFaceAlpha"
              type="number"
              min="0"
              max="100"
              step="1"
              class="w-20 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-center focus:border-primary focus:bg-white/10 outline-none transition-colors"
              @change="onGlobeAlphaChange"
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
import useModel from '../../../composables/useModel.js'

// 使用模型组合式函数
const {
  modelPosition,
  modelTransform,
  updatePosition,
  updateTransform,
  resetView,
  resetModel,
  undergroundViewEnabled,
  globeFrontFaceAlpha,
  globeBackFaceAlpha,
  setUndergroundViewEnabled,
  updateGlobeTranslucency,
  enterUndergroundView
} = useModel()

// 位置变化处理
const onPositionChange = () => {
  updatePosition(modelPosition.value)
}

// 变换变化处理
const onTransformChange = () => {
  updateTransform(modelTransform.value)
}

const onUndergroundToggle = () => {
  setUndergroundViewEnabled(undergroundViewEnabled.value)
}

const onGlobeAlphaChange = () => {
  updateGlobeTranslucency({
    frontFaceAlpha: globeFrontFaceAlpha.value,
    backFaceAlpha: globeBackFaceAlpha.value
  })
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
