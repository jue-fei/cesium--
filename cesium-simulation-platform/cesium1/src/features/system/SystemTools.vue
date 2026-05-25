<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-3">
      <h4
        class="text-sm font-semibold text-text-primary flex items-center gap-2 before:content-[''] before:w-1 before:h-4 before:bg-primary before:rounded-sm"
      >
        数据导出
      </h4>
      <div class="grid grid-cols-2 gap-3">
        <button
          class="flex flex-col items-center justify-center p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 hover:border-primary/50 transition-all group"
          @click="showExportDialog('json')"
        >
          <span class="text-xs text-text-secondary group-hover:text-text-primary transition-colors"
            >JSON数据</span
          >
        </button>
        <button
          class="flex flex-col items-center justify-center p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 hover:border-primary/50 transition-all group"
          @click="showExportDialog('report')"
        >
          <span class="text-xs text-text-secondary group-hover:text-text-primary transition-colors"
            >HTML报告</span
          >
        </button>
        <button
          class="flex flex-col items-center justify-center p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 hover:border-primary/50 transition-all group"
          @click="showExportDialog('screenshot')"
        >
          <span class="text-xs text-text-secondary group-hover:text-text-primary transition-colors"
            >场景截图</span
          >
        </button>
        <button
          class="flex flex-col items-center justify-center p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 hover:border-primary/50 transition-all group"
          @click="showExportDialog('csv')"
        >
          <span class="text-xs text-text-secondary group-hover:text-text-primary transition-colors"
            >CSV数据</span
          >
        </button>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <h4
        class="text-sm font-semibold text-text-primary flex items-center gap-2 before:content-[''] before:w-1 before:h-4 before:bg-primary before:rounded-sm"
      >
        系统设置
      </h4>
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <label class="text-sm text-text-secondary">显示质量:</label>
          <select
            :value="displayQuality"
            class="w-32 px-2 py-1.5 bg-white/5 border border-white/10 rounded text-xs text-text-primary outline-none focus:border-primary focus:bg-white/10 transition-all appearance-none cursor-pointer hover:bg-white/10"
            @change="e => updateDisplayQuality(e.target.value)"
          >
            <option value="low" class="bg-bg-secondary text-text-primary">低质量</option>
            <option value="medium" class="bg-bg-secondary text-text-primary">中等质量</option>
            <option value="high" class="bg-bg-secondary text-text-primary">高质量</option>
          </select>
        </div>
        <div class="flex items-center justify-between">
          <label class="text-sm text-text-secondary">地形精度:</label>
          <select
            :value="terrainQuality"
            class="w-32 px-2 py-1.5 bg-white/5 border border-white/10 rounded text-xs text-text-primary outline-none focus:border-primary focus:bg-white/10 transition-all appearance-none cursor-pointer hover:bg-white/10"
            @change="e => updateTerrainQuality(e.target.value)"
          >
            <option value="low" class="bg-bg-secondary text-text-primary">低精度</option>
            <option value="medium" class="bg-bg-secondary text-text-primary">中等精度</option>
            <option value="high" class="bg-bg-secondary text-text-primary">高精度</option>
          </select>
        </div>
        <div class="flex items-center justify-between">
          <label class="text-sm text-text-secondary">坐标显示:</label>
          <select
            :value="coordinateSystem"
            class="w-32 px-2 py-1.5 bg-white/5 border border-white/10 rounded text-xs text-text-primary outline-none focus:border-primary focus:bg-white/10 transition-all appearance-none cursor-pointer hover:bg-white/10"
            @change="e => updateCoordinateSystem(e.target.value)"
          >
            <option value="wgs84" class="bg-bg-secondary text-text-primary">WGS84</option>
            <option value="cgcs2000" class="bg-bg-secondary text-text-primary">CGCS2000</option>
            <option value="local" class="bg-bg-secondary text-text-primary">本地坐标系</option>
          </select>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <h4
        class="text-sm font-semibold text-text-primary flex items-center gap-2 before:content-[''] before:w-1 before:h-4 before:bg-primary before:rounded-sm"
      >
        系统工具
      </h4>
      <div class="flex flex-col gap-2">
        <button
          class="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-sm text-text-primary transition-all flex items-center justify-center gap-2"
          @click="resetView"
        >
          <span class="text-xs font-semibold text-text-primary drop-shadow-sm">重置视角</span>
        </button>
        <button
          class="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-sm text-text-primary transition-all flex items-center justify-center gap-2"
          @click="fitToModels"
        >
          <span class="text-xs font-semibold text-text-primary drop-shadow-sm">适配模型</span>
        </button>
        <button
          class="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-sm text-text-primary transition-all flex items-center justify-center gap-2"
          @click="toggleFullscreen"
        >
          <span class="text-xs font-semibold text-text-primary drop-shadow-sm">全屏显示</span>
        </button>
      </div>
    </div>
  </div>

  <ExportDialog
    :visible="dialogVisible"
    :export-type="currentExportType"
    :model-count="modelCount"
    :measurement-count="measurementCount"
    :clipping-count="clippingCount"
    @close="dialogVisible = false"
    @confirm="handleExportConfirm"
  />
</template>

<script setup>
import { ref, computed } from 'vue'
import ExportDialog from '../export/ExportPanel.vue'
import useViewer from '@/composables/useViewer.js'
import useModel from '@/composables/useModel.js'
import useMeasurement from '@/composables/useMeasurement.js'
import useClipping from '@/composables/useClipping.js'
import useExport from '@/composables/useExport.js'

const {
  displayQuality,
  terrainQuality,
  coordinateSystem,
  updateDisplayQuality,
  updateTerrainQuality,
  updateCoordinateSystem,
  toggleFullscreen
} = useViewer()

const { modelList, fitToModels, resetView } = useModel()
const { measurementHistory } = useMeasurement()
const { clippingPlanes } = useClipping()
const { handleExportData } = useExport()

const modelCount = computed(() => modelList.value.length)
const measurementCount = computed(() => measurementHistory.value.length)
const clippingCount = computed(() => clippingPlanes.value.length)

const dialogVisible = ref(false)
const currentExportType = ref('json')

const showExportDialog = type => {
  currentExportType.value = type
  dialogVisible.value = true
}

const handleExportConfirm = options => {
  handleExportData({
    type: currentExportType.value,
    options
  })
  dialogVisible.value = false
}
</script>
