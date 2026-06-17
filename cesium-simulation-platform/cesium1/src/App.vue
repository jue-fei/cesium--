<template>
  <div id="cesiumContainer" class="w-full h-screen relative overflow-hidden bg-black"></div>

  <RightSidebar />

  <!-- 工具面板 -->
  <transition
    enter-active-class="transition ease-out duration-300"
    enter-from-class="opacity-0 translate-x-4"
    enter-to-class="opacity-100 translate-x-0"
    leave-active-class="transition ease-in duration-200"
    leave-from-class="opacity-100 translate-x-0"
    leave-to-class="opacity-0 translate-x-4"
  >
    <BasePanel v-if="activeTool" :title="activeToolName" @close="closeTool">
      <component :is="activeComponent" />
    </BasePanel>
  </transition>

  <div
    class="fixed top-2.5 left-2.5 z-[1000] px-2.5 py-1 bg-black/50 backdrop-blur text-white rounded text-xs font-mono flex gap-2 pointer-events-none select-none"
    :class="fps >= 55 ? 'text-green-400' : fps >= 30 ? 'text-yellow-400' : 'text-red-400'"
  >
    <span class="text-white/70">FPS</span>
    <span class="font-bold min-w-[20px] text-right">{{ fps }}</span>
    <span class="text-white/40">|</span>
    <span class="text-white/70">AUTO</span>
    <span
      class="font-bold"
      :class="adaptiveLoadState.level > 0 ? 'text-orange-300' : 'text-cyan-300'"
    >
      {{ adaptiveLoadState.level > 0 ? adaptiveLoadState.appliedStepLabel : '基线' }}
    </span>
  </div>

  <GlobalMessage />
</template>

<script setup>
import { onMounted, onUnmounted, computed, defineAsyncComponent } from 'vue'
import './assets/styles/app.css'
import { createAppBootstrap } from './app/createAppBootstrap.js'
import { logger } from './utils/logger.js'

import RightSidebar from './components/RightSidebar.vue'
import BasePanel from './components/BasePanel.vue'
import GlobalMessage from './components/GlobalMessage.vue'
import {
  TOOL_REGISTRY,
  useBlasting,
  useClipping,
  useGeologyAnalysis,
  useMeasurement,
  useModel,
  useMonitoring
} from '@/features/shared/index.js'

import useViewer from './composables/useViewer.js'
import useMessage from './composables/useMessage.js'
import useUI from './composables/useUI.js'
import { useLifecycle } from './composables/useLifecycle.js'
import { useCesiumSceneLabels } from './composables/useCesiumSceneLabels.js'
import { useDepthRuler } from './composables/useDepthRuler.js'

const viewer = useViewer()
const model = useModel()
useCesiumSceneLabels()
useDepthRuler()
const { initClippingManager } = useClipping()
const { initGeologyManager } = useGeologyAnalysis()
const { loadMeasurementHistory } = useMeasurement()
const { showMessage: notify } = useMessage()
const { initMonitoringManager, destroyMonitoringManager } = useMonitoring()
const { initBlastingManager } = useBlasting()
const { activeTool, closeTool } = useUI()

const lifecycle = useLifecycle()
const fps = model.fps
const adaptiveLoadState = model.adaptiveLoadState
const bootstrap = createAppBootstrap({
  viewer,
  model,
  clipping: { initClippingManager },
  geology: { initGeologyManager },
  monitoring: { initMonitoringManager, destroyMonitoringManager },
  blasting: { initBlastingManager },
  measurement: { loadMeasurementHistory },
  lifecycle
})

const componentMap = Object.fromEntries(
  TOOL_REGISTRY.map(t => [t.id, defineAsyncComponent(t.loader)])
)
const activeComponent = computed(() => componentMap[activeTool.value] || null)
const activeToolName = computed(
  () => TOOL_REGISTRY.find(t => t.id === activeTool.value)?.name || '功能面板'
)

onMounted(async () => {
  try {
    await bootstrap.start('cesiumContainer')
  } catch (err) {
    logger.error('app', '应用初始化失败', null, err)
    notify('应用初始化失败', 'error')
  }
})

onUnmounted(() => {
  bootstrap.stop()
})
</script>
