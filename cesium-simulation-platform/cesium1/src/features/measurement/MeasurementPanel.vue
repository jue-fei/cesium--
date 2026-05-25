<template>
  <div class="measurement-container">
    <div class="panel-section">
      <div class="panel-section-title">测量工具</div>
      <div class="grid-2-col">
        <button class="tool-card" :class="{ active: isMeasuring }" @click="toggleMeasurement">
          <span class="icon">📏</span>
          <span class="label">距离测量</span>
          <div v-if="isMeasuring" class="status-indicator"></div>
        </button>
        <button
          class="tool-card"
          :class="{ active: isAreaMeasuring }"
          @click="toggleAreaMeasurement"
        >
          <span class="icon">📐</span>
          <span class="label">面积测量</span>
          <div v-if="isAreaMeasuring" class="status-indicator"></div>
        </button>
      </div>

      <div class="action-row mt-md">
        <button
          class="secondary-btn full-width"
          :disabled="!hasMeasurements"
          @click="clearAllMeasurements"
        >
          清除所有测量
        </button>
      </div>
    </div>

    <!-- 测量结果显示 -->
    <transition name="fade">
      <div v-if="hasCurrentMeasurements" class="panel-section result-card">
        <div v-if="measurementDistance > 0" class="result-row">
          <span class="label">当前距离</span>
          <span class="value">{{ formattedDistance }} m</span>
        </div>
        <div v-if="measurementArea > 0" class="result-row">
          <span class="label">当前面积</span>
          <span class="value">{{ formattedArea }} m²</span>
        </div>
      </div>
    </transition>

    <!-- 测量历史 -->
    <div v-if="hasMeasurementHistory" class="panel-section">
      <div class="panel-section-title">
        <span>测量历史</span>
        <button class="text-btn" @click="clearAllMeasurements">清空</button>
      </div>
      <div class="history-list">
        <div v-for="record in measurementHistory.slice(0, 5)" :key="record.id" class="history-item">
          <div class="history-icon">
            {{ record.type === 'distance' ? '📏' : '📐' }}
          </div>
          <div class="history-content">
            <div class="history-value">
              {{
                record.type === 'distance'
                  ? formatNumber(record.distance) + ' m'
                  : formatNumber(record.area) + ' m²'
              }}
            </div>
            <div class="history-time">{{ formatTime(record.timestamp) }}</div>
          </div>
          <button class="icon-btn small delete" @click="deleteMeasurementRecord(record.id)">
            ✕
          </button>
        </div>
      </div>
    </div>

    <!-- 分析工具 -->
    <div class="panel-section">
      <div class="panel-section-title">高级分析</div>
      <div class="grid-3-col">
        <button class="tool-card small" @click="showVolumeAnalysis">
          <span class="icon">📊</span>
          <span class="label">体积</span>
        </button>
        <button class="tool-card small" @click="showSlopeAnalysis">
          <span class="icon">⛰️</span>
          <span class="label">坡度</span>
        </button>
        <button class="tool-card small" @click="showVisibilityAnalysis">
          <span class="icon">👁️</span>
          <span class="label">可视域</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import useMeasurement from '../../composables/useMeasurement.js'
import useMessage from '@/composables/useMessage.js'

// 使用共享组合式函数
const {
  isMeasuring,
  isAreaMeasuring,
  measurementDistance,
  measurementArea,
  measurementHistory,
  toggleMeasurement,
  toggleAreaMeasurement,
  clearAllMeasurements,
  deleteMeasurementRecord
} = useMeasurement()

const { showOperationMessage } = useMessage()

// 计算属性
const hasCurrentMeasurements = computed(
  () => measurementDistance.value > 0 || measurementArea.value > 0
)

const hasMeasurements = computed(
  () =>
    measurementDistance.value > 0 ||
    measurementArea.value > 0 ||
    measurementHistory.value.length > 0
)

const hasMeasurementHistory = computed(() => measurementHistory.value.length > 0)

const formattedDistance = computed(() => formatNumber(measurementDistance.value))
const formattedArea = computed(() => formatNumber(measurementArea.value))

// 格式化数字显示
const formatNumber = value => {
  if (value === undefined || value === null) return '0'
  if (value === 0) return '0'
  if (value < 0.001) return value.toExponential(2)
  if (value < 1) return value.toFixed(3)
  if (value < 1000) return value.toFixed(2)
  return value.toFixed(0)
}

// 格式化时间显示
const formatTime = timestamp => {
  const date = new Date(timestamp)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

// 分析工具函数
const showVolumeAnalysis = () =>
  showOperationMessage('体积分析：请在场景中选择多个点，系统将自动计算围合体积。', 'info')

const showSlopeAnalysis = () =>
  showOperationMessage('坡度分析：已激活。请在地形上点击查看斜坡坡度信息。', 'info')

const showVisibilityAnalysis = () =>
  showOperationMessage('可视域分析：从当前视点计算可见范围。', 'info')
</script>

<style scoped>
.measurement-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xl);
  padding: 20px;
}

/* 覆盖面板区块标题样式 (如果需要) */
.panel-section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 布局网格 */
.grid-2-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-md);
}

.grid-3-col {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--spacing-sm);
}

/* 工具卡片按钮 */
.tool-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-lg);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
}

.tool-card:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--text-primary);
  transform: translateY(-2px);
}

.tool-card.active {
  background: rgba(64, 158, 255, 0.15);
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.tool-card.small {
  padding: var(--spacing-md);
  gap: 4px;
}

.tool-card .icon {
  font-size: 24px;
}

.tool-card.small .icon {
  font-size: 20px;
}

.tool-card .label {
  font-size: var(--font-sm);
  font-weight: 500;
}

.status-indicator {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success-color);
  box-shadow: 0 0 6px var(--success-color);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% {
    opacity: 1;
  }

  50% {
    opacity: 0.5;
  }

  100% {
    opacity: 1;
  }
}

/* 结果卡片 */
.result-card {
  background: rgba(64, 158, 255, 0.1);
  border: 1px solid rgba(64, 158, 255, 0.3);
  border-radius: var(--radius-md);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.result-row .label {
  color: var(--text-secondary);
  font-size: var(--font-sm);
}

.result-row .value {
  color: var(--text-primary);
  font-size: var(--font-lg);
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

/* 历史记录列表 */
.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: var(--radius-md);
  border: 1px solid transparent;
}

.history-item:hover {
  border-color: var(--border-secondary);
}

.history-icon {
  font-size: 18px;
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.history-content {
  flex: 1;
}

.history-value {
  font-size: var(--font-sm);
  color: var(--text-primary);
  font-weight: 500;
}

.history-time {
  font-size: 10px;
  color: var(--text-muted);
}

/* 按钮通用样式 (复用 GeologyAnalysis 的样式定义) */
.icon-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.icon-btn.small {
  font-size: 12px;
  padding: 4px;
}

.icon-btn.delete:hover {
  color: var(--secondary-color);
  background: rgba(245, 108, 108, 0.1);
}

.text-btn {
  background: transparent;
  border: none;
  color: var(--primary-color);
  font-size: var(--font-xs);
  cursor: pointer;
}

.text-btn:hover {
  text-decoration: underline;
}

.secondary-btn {
  padding: 8px 16px;
  border-radius: 4px;
  font-size: var(--font-sm);
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  transition: all 0.2s;
}

.secondary-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: var(--text-primary);
}

.secondary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.full-width {
  width: 100%;
}

.mt-md {
  margin-top: var(--spacing-md);
}

/* 动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
