<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div class="flex justify-between items-center mb-3">
      <span
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
        >模型管理</span
      >
      <button
        v-if="!isConfigPanelOpen"
        class="p-1 rounded bg-transparent text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
        title="配置"
        @click="toggleConfigPanel"
      >
        <span class="text-sm">⚙️</span>
      </button>
    </div>

    <!-- 配置文件管理 -->
    <transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="max-h-0 opacity-0 overflow-hidden"
      enter-to-class="max-h-[200px] opacity-100"
      leave-active-class="transition-all duration-300 ease-in"
      leave-from-class="max-h-[200px] opacity-100"
      leave-to-class="max-h-0 opacity-0 overflow-hidden"
    >
      <div v-if="isConfigPanelOpen" class="mb-3 bg-black/20 rounded p-3 border border-white/5">
        <div class="mb-2">
          <div class="flex justify-between items-center mb-1 text-xs text-gray-400">
            <span>配置文件</span>
            <button
              class="text-blue-400 hover:text-blue-300 hover:underline"
              @click="toggleConfigPanel"
            >
              收起
            </button>
          </div>
          <select
            v-model="currentConfigFileLocal"
            class="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
            @change="handleLoadConfig"
          >
            <option value="">请选择配置文件</option>
            <option v-for="file in modelConfigFiles" :key="file.path" :value="file.path">
              {{ file.name }}{{ isModelCached(file.path) ? ' ⚡' : '' }}
            </option>
          </select>
        </div>
        <div class="flex gap-2">
          <button
            class="px-3 py-1 rounded bg-white/10 border border-white/20 text-xs text-gray-200 hover:bg-white/20 hover:text-white transition-colors"
            @click="reloadCurrentConfig"
          >
            {{ switching ? '切换中...' : '刷新' }}
          </button>
        </div>
      </div>
    </transition>

    <!-- 全局透明度 -->
    <div class="mb-3">
      <div class="flex justify-between items-center mb-1 text-xs text-gray-400">
        <span>全局透明度</span>
        <span class="text-blue-400 font-mono">{{ globalOpacityLocal }}%</span>
      </div>
      <div>
        <input
          v-model.number="globalOpacityLocal"
          type="range"
          min="0"
          max="100"
          step="1"
          class="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-blue-500/50 accent-blue-500 transition-colors"
          @change="handleGlobalOpacityChange"
        />
      </div>
    </div>

    <!-- 模型列表 -->
    <div
      class="max-h-[200px] overflow-y-auto border border-white/10 rounded-md bg-black/20 custom-scrollbar"
    >
      <div
        v-for="model in modelList"
        :key="model.id"
        class="p-2 border-b border-white/5 transition-colors last:border-0"
        :class="{ 'bg-white/5': hoveredModelId === model.id }"
        @mouseenter="hoveredModelId = model.id"
        @mouseleave="hoveredModelId = null"
      >
        <div class="flex justify-between items-center">
          <label class="flex items-center gap-2 cursor-pointer group">
            <div class="relative flex items-center">
              <input
                v-model="model.visible"
                type="checkbox"
                class="peer appearance-none w-3.5 h-3.5 border border-gray-500 rounded-sm bg-transparent checked:bg-blue-500 checked:border-blue-500 transition-colors"
                @change="toggleModelVisibility(model)"
              />
              <svg
                class="absolute w-3.5 h-3.5 pointer-events-none hidden peer-checked:block text-white"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="4"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <span class="text-xs text-gray-300 group-hover:text-white transition-colors">{{
              model.name
            }}</span>
          </label>
          <div
            class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            :class="{ 'opacity-100': hoveredModelId === model.id }"
          >
            <button
              class="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-yellow-300 transition-colors"
              title="高亮"
              @click="highlightModel(model)"
            >
              🔆
            </button>
            <button
              class="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-blue-300 transition-colors"
              title="属性"
              @click="showModelProperties(model)"
            >
              📋
            </button>
          </div>
        </div>

        <!-- 单个模型透明度 -->
        <div v-if="hoveredModelId === model.id || model.opacity < 100" class="mt-1.5 px-1">
          <input
            v-model="model.opacity"
            type="range"
            min="0"
            max="100"
            step="1"
            class="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-blue-500/50 accent-blue-500 transition-colors"
            @change="updateModelOpacity(model)"
          />
        </div>
      </div>
    </div>

    <!-- 批量操作 -->
    <div class="flex gap-2 mt-3 pt-3 border-t border-white/5">
      <button
        class="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        @click="showAllModels"
      >
        全显
      </button>
      <button
        class="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        @click="hideAllModels"
      >
        全隐
      </button>
      <button
        class="px-2 py-1 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        @click="resetAllOpacity"
      >
        重置
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import useModel from '../../model-control/services/useModel.js'
import { hasCachedTileset } from '../../model-control/services/modelCache.js'

const {
  modelConfigFiles,
  currentConfigFile,
  modelList,
  globalOpacity,
  onConfigChange,
  reloadCurrentConfig,
  updateGlobalOpacity,
  toggleModelVisibility,
  updateModelOpacity,
  highlightModel,
  showModelProperties,
  showAllModels,
  hideAllModels,
  resetAllOpacity
} = useModel()

const isConfigPanelOpen = ref(false)
const hoveredModelId = ref(null)
const currentConfigFileLocal = ref('')
const globalOpacityLocal = ref(100)
const switching = ref(false)

const isModelCached = path => hasCachedTileset(path)

// 同步全局状态
watch(
  currentConfigFile,
  val => {
    currentConfigFileLocal.value = val
  },
  { immediate: true }
)

watch(
  globalOpacity,
  val => {
    globalOpacityLocal.value = val
  },
  { immediate: true }
)

// 方法
const toggleConfigPanel = () => {
  isConfigPanelOpen.value = !isConfigPanelOpen.value
}

const handleLoadConfig = () => {
  if (!currentConfigFileLocal.value) return
  switching.value = true
  onConfigChange(currentConfigFileLocal.value).finally(() => {
    switching.value = false
  })
}

const handleGlobalOpacityChange = () => {
  updateGlobalOpacity(globalOpacityLocal.value)
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
