<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="blasting-panel">
      <div class="panel-section">
        <div class="panel-section-title">爆破数据导入</div>
        <div class="controls-row">
          <input
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="onFileChange"
          />
          <button class="compact-action-btn primary" @click="fileInput?.click()">选择文件</button>
          <button class="compact-action-btn" @click="loadExample">加载示例</button>
          <button class="compact-action-btn danger" :disabled="!dataset" @click="clearSimulation">
            清空
          </button>
        </div>
        <div class="hint-text">
          格式要求：event.center、design.faceBefore/faceAfter、design.holes、design.rockBlocks、frames。
        </div>
        <div class="hint-text">
          可选 visual 字段：fragmentRenderMode、fragmentModelUri、waveRings、trailWidth。
        </div>
        <div
          class="hint-text"
          :class="{ 'text-ok': importStatus?.ok, 'text-error': importStatus && !importStatus.ok }"
        >
          {{ importStatus?.message || '等待导入数据' }}
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">回放控制</div>
        <div class="controls-row">
          <button class="compact-action-btn primary" :disabled="!dataset" @click="togglePlayback">
            {{ isPlaying ? '暂停' : '播放' }}
          </button>
          <span class="status-text">帧 {{ currentFrame + 1 }} / {{ maxFrame + 1 }}</span>
        </div>
        <el-slider
          class="mt-2"
          :disabled="!dataset"
          :min="0"
          :max="maxFrame"
          :step="1"
          :model-value="currentFrame"
          @update:model-value="onFrameChange"
        />
        <div class="controls-row mt-2">
          <span class="status-text">播放间隔(ms)</span>
          <el-input-number
            :disabled="!dataset"
            :min="16"
            :max="2000"
            :step="20"
            :controls="false"
            :model-value="playbackSpeedMs"
            @update:model-value="onSpeedChange"
          />
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">仿真统计</div>
        <div class="stat-item">
          <span>事件名称</span><span class="stat-value">{{ eventName }}</span>
        </div>
        <div class="stat-item">
          <span>碎块数量</span><span class="stat-value">{{ summary.fragmentCount }}</span>
        </div>
        <div class="stat-item">
          <span>总帧数</span><span class="stat-value">{{ summary.frameCount }}</span>
        </div>
        <div class="stat-item">
          <span>持续时间</span><span class="stat-value">{{ summary.durationSec }} s</span>
        </div>
        <div class="stat-item">
          <span>最大冲击半径</span><span class="stat-value">{{ summary.maxWaveRadius }} m</span>
        </div>
        <div class="stat-item">
          <span>炮孔数量</span><span class="stat-value">{{ summary.holeCount || 0 }}</span>
        </div>
        <div class="stat-item">
          <span>落石设计数量</span><span class="stat-value">{{ summary.rockBlockCount || 0 }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '爆破模拟面板' })
import { useBlastingPanelController } from '../services/panel/useBlastingPanelController.js'

const {
  fileInput,
  dataset,
  importStatus,
  isPlaying,
  currentFrame,
  maxFrame,
  playbackSpeedMs,
  summary,
  loadExample,
  togglePlayback,
  clearSimulation,
  eventName,
  onFileChange,
  onFrameChange,
  onSpeedChange
} = useBlastingPanelController()
</script>

<style scoped>
.blasting-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.controls-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.hint-text {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.text-ok {
  color: var(--success-color);
}

.text-error {
  color: var(--danger-color);
}

.status-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.stat-item {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
}

.stat-value {
  font-family: monospace;
}
</style>
