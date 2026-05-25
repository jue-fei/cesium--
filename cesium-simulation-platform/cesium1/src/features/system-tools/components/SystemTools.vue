<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <div class="panel-section">
        <div class="panel-section-title">数据导出</div>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="item in exportActions"
            :key="item.type"
            class="flex flex-col items-center justify-center p-3 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 hover:border-primary/50 transition-all group"
            @click="showExportDialog(item.type)"
          >
            <span
              class="text-xs text-text-secondary group-hover:text-text-primary transition-colors"
              >{{ item.label }}</span
            >
          </button>
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-section-title">系统设置</div>
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
          <div class="flex items-center justify-between">
            <div class="flex flex-col gap-0.5">
              <span class="text-sm text-text-secondary">模型深度标尺:</span>
              <span class="text-[11px] text-text-secondary/70">在模型侧边显示深度刻度</span>
            </div>
            <button
              type="button"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
              :class="depthRulerEnabled ? 'bg-primary' : 'bg-white/10'"
              @click="toggleDepthRuler"
            >
              <span
                class="inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform"
                :class="depthRulerEnabled ? 'translate-x-5' : 'translate-x-1'"
              ></span>
            </button>
          </div>
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-section-title">快捷操作</div>
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
  </div>

  <ExportDialog
    :visible="dialogVisible"
    :export-type="currentExportType"
    :model-count="modelCount"
    :measurement-count="measurementCount"
    :clipping-count="clippingCount"
    @close="closeDialog"
    @confirm="handleExportConfirm"
  />
</template>

<script setup>
defineOptions({ name: '系统工具面板' })
import ExportDialog from './ExportPanel.vue'
import { useSystemToolsPanelController } from '../services/panel/useSystemToolsPanelController.js'
import { EXPORT_ACTIONS } from '../types/exportConstants.js'

const exportActions = EXPORT_ACTIONS

const {
  displayQuality,
  terrainQuality,
  coordinateSystem,
  updateDisplayQuality,
  updateTerrainQuality,
  updateCoordinateSystem,
  toggleFullscreen,
  fitToModels,
  resetView,
  depthRulerEnabled,
  toggleDepthRuler,
  modelCount,
  measurementCount,
  clippingCount,
  dialogVisible,
  currentExportType,
  showExportDialog,
  closeDialog,
  handleExportConfirm
} = useSystemToolsPanelController()
</script>
