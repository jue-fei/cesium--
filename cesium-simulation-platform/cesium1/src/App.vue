<template>
  <div id="cesiumContainer" class="w-full h-screen relative overflow-hidden bg-black"></div>

  <RightSidebar />

  <!-- 浮动爆破播放器：独立于面板挂载，面板隐藏时依然保留，不随 activeTool 收起 -->
  <PlaybackFloatingPanel
    v-if="dataset"
    :dataset="dataset"
    :is-playing="isPlaying"
    :current-frame="currentFrame"
    :max-frame="maxFrame"
    :playback-speed-ms="playbackSpeedMs"
    :playback-rate="playbackRate"
    :playback-rates="playbackRates"
    :is-looping="isLooping"
    :ab-loop="abLoop"
    :replay-ready="replayReady"
    :replay-precompute="replayPrecompute"
    @toggle-playback="togglePlayback"
    @step-frame="stepFrame"
    @rate-change="setPlaybackRate"
    @replay-blast="replayBlast"
    @frame-change="(_f) => setFrame(_f, true)"
    @speed-change="onSpeedChange"
    @toggle-loop="toggleLoop"
    @mark-ab-loop="markAbLoopPoint"
    @clear-ab-loop="clearAbLoop"
    @save-result="saveSimulationResult"
  />

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
import PlaybackFloatingPanel from './features/blasting-simulation/components/PlaybackFloatingPanel.vue'
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
import { restoreUIState, attachSessionSave } from './composables/useSessionPersist.js'
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
const {
  dataset,
  isPlaying,
  currentFrame,
  maxFrame,
  playbackSpeedMs,
  playbackRate,
  isLooping,
  abLoop,
  replayReady,
  replayPrecompute,
  togglePlayback,
  stepFrame,
  setPlaybackRate,
  playbackRates,
  replayBlast,
  setFrame,
  toggleLoop,
  markAbLoopPoint,
  clearAbLoop,
  saveSimulationResult
} = useBlasting()
const onSpeedChange = v => {
  playbackSpeedMs.value = Number(v || 50)
}
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

let sessionDetach = null

const componentMap = Object.fromEntries(
  TOOL_REGISTRY.map(t => [t.id, defineAsyncComponent(t.loader)])
)
const activeComponent = computed(() => componentMap[activeTool.value] || null)
const activeToolName = computed(
  () => TOOL_REGISTRY.find(t => t.id === activeTool.value)?.name || '功能面板'
)

onMounted(async () => {
  let viewerInstance = null
  try {
    viewerInstance = await bootstrap.start('cesiumContainer')
  } catch (err) {
    logger.error('app', '应用初始化失败', null, err)
    notify('应用初始化失败', 'error')
  }
  // 浏览器回收标签页重新加载后，恢复离开时的工具面板与相机视角
  restoreUIState({
    getViewer: () => viewerInstance,
    setActiveTool: id => {
      activeTool.value = id
    },
    isToolIdValid: id => TOOL_REGISTRY.some(t => t.id === id)
  })
  sessionDetach = attachSessionSave({
    getViewer: () => viewerInstance,
    getActiveTool: () => activeTool.value
  })
})

onUnmounted(() => {
  sessionDetach?.()
  bootstrap.stop()
})
</script>
