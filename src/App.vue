<template>
  <div id="cesiumContainer" ref="cesiumContainer"></div>

  <!-- 模型控制面板 -->
  <ModelControls :initial-position="modelPosition" :initial-transform="modelTransform"
    @position-change="updateModelPosition" @transform-change="updateModelTransform" @reset-view="resetView"
    @reset-model="resetModel" />

  <!-- 专业面板组件 -->
  <ProfessionalPanel :is-collapsed="isCollapsed" :active-tab="activeTab" :model-config-files="modelConfigFiles"
    :current-config-file="currentConfigFile" :model-list="modelList" :global-opacity="globalOpacity"
    :coordinate-system="coordinateSystem" :is-measuring="isMeasuring" :is-area-measuring="isAreaMeasuring"
    :measurement-distance="measurementDistance" :measurement-area="measurementArea"
    :measurement-history="measurementHistory" :init-boreholes="initBoreholes"
    :show-borehole-details="showBoreholeDetails" :create-geological-section="createGeologicalSection"
    :calculate-ore-reserve="calculateOreReserve" :generate-geology-report="generateGeologyReport"
    :export-borehole-data="exportBoreholeData" :calculate-stratigraphy-stats="calculateStratigraphyStats"
    :selected-model="selectedModel" :sync-model-info="syncModelInfo" :show-operation-message="showOperationMessage"
    :viewer="viewerRef" :display-quality="displayQuality" :terrain-quality="terrainQuality"
    @toggle-collapse="toggleCollapse" @tab-change="activeTab = $event" @load-config="onConfigChange"
    @update-global-opacity="updateGlobalOpacity" @toggle-model-visibility="toggleModelVisibility"
    @update-model-opacity="updateModelOpacity" @show-all-models="showAllModels" @hide-all-models="hideAllModels"
    @reset-all-opacity="resetAllOpacity" @toggle-measurement="toggleMeasurement"
    @toggle-area-measurement="toggleAreaMeasurement" @clear-all-measurements="clearAllMeasurements"
    @delete-measurement-record="deleteMeasurementRecord" @export-scene-data="exportSceneData"
    @export-report="exportReport" @export-screenshot="exportScreenshot" @reset-view="resetView"
    @fit-to-models="fitToModels" @toggle-fullscreen="toggleFullscreen" @highlight-model="highlightModel" />

  <!-- 模型加载状态提示 -->
  <div v-if="modelLoadStatus" class="load-status" :class="modelLoadStatus.type">
    {{ modelLoadStatus.message }}
  </div>
</template>

<script setup>
import { onMounted, ref, onUnmounted } from 'vue'
import ModelControls from './components/ModelControls.vue'
import ProfessionalPanel from './components/ProfessionalPanel.vue'
import useCesiumApp from './composables/useCesiumApp.js'

// 使用Cesium应用组合函数
const {
  // 状态
  isCollapsed,
  activeTab,
  modelPosition,
  modelTransform,
  modelLoadStatus,
  modelList,
  selectedModel,
  globalOpacity,
  coordinateSystem,
  modelConfigFiles,
  currentConfigFile,
  measurementDistance,
  measurementArea,
  measurementHistory,
  isMeasuring,
  isAreaMeasuring,
  viewerRef,
  displayQuality,
  terrainQuality,

  // 方法
  toggleCollapse,
  onConfigChange,
  updateGlobalOpacity,
  toggleModelVisibility,
  updateModelOpacity,
  showAllModels,
  hideAllModels,
  resetAllOpacity,
  toggleMeasurement,
  toggleAreaMeasurement,
  clearAllMeasurements,
  deleteMeasurementRecord,
  exportSceneData,
  exportReport,
  exportScreenshot,
  resetView,
  fitToModels,
  toggleFullscreen,
  highlightModel,
  initBoreholes,
  showBoreholeDetails,
  createGeologicalSection,
  calculateOreReserve,
  generateGeologyReport,
  exportBoreholeData,
  calculateStratigraphyStats,
  syncModelInfo,
  showOperationMessage,

  // 更新方法
  updateModelPosition,
  updateModelTransform,
  resetModel
} = useCesiumApp()

// 组件生命周期钩子由useCesiumApp内部处理
</script>

<style>
html,
body,
* {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

#cesiumContainer {
  width: 100vw;
  height: 100vh;
  position: fixed;
  top: 0;
  left: 0;
}

.load-status {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  z-index: 1001;
  backdrop-filter: blur(10px);
}

.load-status.loading {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
  border: 1px solid #ffc107;
}

.load-status.success {
  background: rgba(40, 167, 69, 0.2);
  color: #28a745;
  border: 1px solid #28a745;
}

.load-status.warning {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
  border: 1px solid #ffc107;
}

.load-status.error {
  background: rgba(220, 53, 69, 0.2);
  color: #dc3545;
  border: 1px solid #dc3545;
}
</style>