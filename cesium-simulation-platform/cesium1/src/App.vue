<template>
  <div id="cesiumContainer" class="w-full h-screen relative overflow-hidden bg-black"></div>

  <!-- 侧边栏 -->
  <RightSidebar />

  <!-- 动态面板 -->
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

  <!-- 全局 FPS 显示 -->
  <div
    class="fixed top-2.5 left-2.5 z-[1000] px-2.5 py-1 bg-black/50 backdrop-blur text-white rounded text-xs font-mono flex gap-2 pointer-events-none select-none"
    :class="getFpsClass(fps)"
  >
    <span class="text-white/70">FPS</span>
    <span class="font-bold min-w-[20px] text-right">{{ fps }}</span>
  </div>

  <!-- 全局消息提示 -->
  <GlobalMessage />
</template>

<script setup>
import { onMounted, onUnmounted, computed, defineAsyncComponent } from 'vue'
import * as Cesium from 'cesium'
import './assets/styles/app.css'

// 界面组件
import RightSidebar from './components/RightSidebar.vue'
import BasePanel from './components/BasePanel.vue'
import GlobalMessage from './components/GlobalMessage.vue'

const ModelTransformPanel = defineAsyncComponent(
  () => import('./features/model/transform/ModelTransformPanel.vue')
)
const GeologyPanel = defineAsyncComponent(() => import('./features/geology/GeologyPanel.vue'))
const MeasurementPanel = defineAsyncComponent(
  () => import('./features/measurement/MeasurementPanel.vue')
)
const ClippingPanel = defineAsyncComponent(
  () => import('./features/model/clipping/ClippingPanel.vue')
)
const LodPanel = defineAsyncComponent(() => import('./features/optimization/LodPanel.vue'))
const StressPanel = defineAsyncComponent(() => import('./features/stress/StressPanel.vue'))
const BlastingPanel = defineAsyncComponent(() => import('./features/blasting/BlastingPanel.vue'))
const MonitoringPanel = defineAsyncComponent(
  () => import('./features/monitoring/MonitoringPanel.vue')
)
const ScenarioPanel = defineAsyncComponent(() => import('./features/scenario/ScenarioPanel.vue'))
const SystemTools = defineAsyncComponent(() => import('./features/system/SystemTools.vue'))

// 组合式函数
import useViewer from './composables/useViewer.js'
import useModel from './composables/useModel.js'
import useClipping from './composables/useClipping.js'
import useGeologyAnalysis from './composables/useGeologyAnalysis.js'
import useMeasurement from './composables/useMeasurement.js'
import useMessage from './composables/useMessage.js'
import useMonitoring from './composables/useMonitoring.js'
import useBlasting from './composables/useBlasting.js'
import useUI from './composables/useUI.js'

// 使用组合式函数
const { initViewer, destroyViewer } = useViewer()
const { initModel, fps, startGlobalFpsMonitoring, stopGlobalFpsMonitoring } = useModel()
const { handlePolygonMouseClick, initClippingManager } = useClipping()
const { initGeologyManager } = useGeologyAnalysis()
const { loadMeasurementHistory } = useMeasurement()
const { showOperationMessage } = useMessage()
const { initMonitoringManager } = useMonitoring()
const { initBlastingManager } = useBlasting()
const { activeTool, closeTool, tools } = useUI()

// 组件映射表
const componentMap = {
  model_control: ModelTransformPanel,
  geology: GeologyPanel,
  measure: MeasurementPanel,
  clipping: ClippingPanel,
  monitoring: MonitoringPanel,
  blasting: BlastingPanel,
  scenario: ScenarioPanel,
  lod: LodPanel,
  stress: StressPanel,
  system: SystemTools
}

const activeComponent = computed(() => componentMap[activeTool.value] || null)
const activeToolName = computed(() => {
  const tool = tools.find(t => t.id === activeTool.value)
  return tool ? tool.name : '功能面板'
})

const getFpsClass = val => {
  if (val >= 55) return 'text-green-400'
  if (val >= 30) return 'text-yellow-400'
  return 'text-red-400'
}

onMounted(async () => {
  try {
    const viewer = await initViewer('cesiumContainer')
    if (viewer) {
      await initModel(viewer)
      initClippingManager(viewer)
      initGeologyManager(viewer)
      initMonitoringManager(viewer)
      initBlastingManager(viewer)
      loadMeasurementHistory()

      startGlobalFpsMonitoring()

      // 注册全局点击事件
      viewer.screenSpaceEventHandler.setInputAction(click => {
        handlePolygonMouseClick(viewer, click)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }
  } catch (error) {
    console.error('App init error:', error)
    showOperationMessage('应用初始化失败', 'error')
  }
})

onUnmounted(() => {
  stopGlobalFpsMonitoring()
  destroyViewer()
})
</script>
