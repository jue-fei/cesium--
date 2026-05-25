<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="measurement-container">
      <div class="panel-section">
        <div class="panel-section-title">
          <span class="title-dot"></span>
          测量工具
        </div>
        <div class="grid-3-col">
          <button
            class="tool-card"
            :class="{ active: isMeasuring && distanceMode === 'straight' }"
            @click="toggleStraightMeasurement"
          >
            <span class="icon">━</span>
            <span class="label">直线距离</span>
            <div v-if="isMeasuring && distanceMode === 'straight'" class="status-dot"></div>
          </button>
          <button
            class="tool-card"
            :class="{ active: isMeasuring && distanceMode === 'terrain' }"
            @click="toggleTerrainMeasurement"
          >
            <span class="icon">〰</span>
            <span class="label">路途距离</span>
            <div v-if="isMeasuring && distanceMode === 'terrain'" class="status-dot"></div>
          </button>
          <button
            class="tool-card"
            :class="{ active: isAreaMeasuring }"
            @click="toggleAreaMeasurement"
          >
            <span class="icon">◫</span>
            <span class="label">面积测量</span>
            <div v-if="isAreaMeasuring" class="status-dot"></div>
          </button>
        </div>
        <button v-if="hasCurrentMeasurements" class="exit-btn-inline" @click="exitMeasurement">
          <span class="exit-icon-inline">⏹</span>
          退出测量
        </button>
        <button class="clear-btn" :disabled="!hasMeasurements" @click="clearAllMeasurements">
          <span class="clear-icon">↺</span>
          清除所有测量
        </button>
      </div>

      <transition name="slide-fade">
        <div v-if="hasCurrentMeasurements" class="panel-section result-panel">
          <div class="result-header">
            <span class="title-dot active"></span>
            <span class="panel-section-title">当前测量</span>
          </div>
          <div class="result-grid">
            <div v-if="activeDistance > 0" class="result-card">
              <div class="result-label">{{ activeLabel }}</div>
              <div class="result-value">{{ formattedActiveDistance }}</div>
              <div class="result-unit">m</div>
            </div>
            <div v-if="measurementArea > 0" class="result-card">
              <div class="result-label">当前面积</div>
              <div class="result-value">{{ formattedArea }}</div>
              <div class="result-unit">m²</div>
            </div>
          </div>
        </div>
      </transition>

      <transition name="slide-fade">
        <div v-if="hasMeasurementHistory" class="panel-section history-panel">
          <div class="panel-section-title">
            <span class="title-dot"></span>
            测量记录
            <span class="history-count">{{ allHistoryCount }}</span>
          </div>
          <div v-for="group in categorizedHistory" :key="group.key" class="history-group">
            <div class="group-header" :style="{ borderLeftColor: group.color }">
              <span class="group-icon">{{ group.icon }}</span>
              <span class="group-label">{{ group.label }}</span>
              <span class="group-count">{{ group.items.length }}</span>
            </div>
            <div class="group-items">
              <div
                v-for="record in group.items.slice(0, 8)"
                :key="record.id"
                class="history-item"
                :class="{ highlighted: highlightedRecordId === record.id }"
                @click="showHistoryOnScene(record)"
              >
                <div class="item-left">
                  <div class="item-value">{{ getRecordLabel(record) }}</div>
                  <div class="item-time">{{ formatTime(record.timestamp) }}</div>
                </div>
                <button
                  class="item-delete"
                  title="删除记录"
                  @click.stop="deleteMeasurementRecord(record.id)"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <div class="panel-section">
        <div class="panel-section-title"><span class="title-dot"></span>高级分析</div>
        <div class="grid-3-col">
          <button class="tool-card small" @click="showVolumeAnalysis">
            <span class="icon">◈</span><span class="label">体积</span>
          </button>
          <button class="tool-card small" @click="showSlopeAnalysis">
            <span class="icon">△</span><span class="label">坡度</span>
          </button>
          <button class="tool-card small" @click="showVisibilityAnalysis">
            <span class="icon">◎</span><span class="label">可视域</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
defineOptions({ name: '�����������' })
import { useMeasurementPanelController } from '../services/panel/useMeasurementPanelController.js'

const {
  isMeasuring,
  isAreaMeasuring,
  distanceMode,
  measurementArea,
  highlightedRecordId,
  toggleStraightMeasurement,
  toggleTerrainMeasurement,
  toggleAreaMeasurement,
  exitMeasurement,
  clearAllMeasurements,
  deleteMeasurementRecord,
  showHistoryOnScene,
  hasCurrentMeasurements,
  hasMeasurements,
  hasMeasurementHistory,
  activeDistance,
  activeLabel,
  formattedActiveDistance,
  formattedArea,
  formatTime,
  categorizedHistory,
  allHistoryCount,
  getRecordLabel,
  showVolumeAnalysis,
  showSlopeAnalysis,
  showVisibilityAnalysis
} = useMeasurementPanelController()
</script>

<style scoped>
.measurement-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.panel-section {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-lg);
  padding: 14px;
}

.panel-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.title-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.title-dot.active {
  background: var(--primary-color);
  box-shadow: 0 0 6px rgba(64, 158, 255, 0.6);
}

.grid-3-col {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--spacing-sm);
}

.tool-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 6px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}

.tool-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.15);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.tool-card.active {
  background: rgba(64, 158, 255, 0.12);
  border-color: rgba(64, 158, 255, 0.4);
  color: var(--primary-color);
  box-shadow: 0 0 12px rgba(64, 158, 255, 0.1);
}

.tool-card .icon {
  font-size: 18px;
  line-height: 1;
}

.tool-card .label {
  font-size: var(--font-xs);
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
}

.tool-card.small {
  padding: 10px 6px;
}

.tool-card.small .icon {
  font-size: 15px;
}

.tool-card.small .label {
  font-size: 10px;
}

.status-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary-color);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 2px var(--primary-color);
  }

  50% {
    opacity: 0.4;
    box-shadow: 0 0 8px var(--primary-color);
  }
}

.exit-btn-inline {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 10px;
  padding: 8px;
  background: rgba(239, 83, 80, 0.1);
  border: 1px solid rgba(239, 83, 80, 0.2);
  border-radius: var(--radius-md);
  color: #ef5350;
  font-size: var(--font-xs);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.exit-btn-inline:hover {
  background: rgba(239, 83, 80, 0.2);
  border-color: rgba(239, 83, 80, 0.4);
}

.exit-icon-inline {
  font-size: 12px;
}

.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 8px;
  background: transparent;
  border: 1px dashed rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: all 0.2s;
}

.clear-btn:hover:not(:disabled) {
  border-color: rgba(239, 83, 80, 0.4);
  color: #ef5350;
  background: rgba(239, 83, 80, 0.05);
}

.clear-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.clear-icon {
  font-size: 14px;
}

.result-panel {
  background: rgba(64, 158, 255, 0.04);
  border-color: rgba(64, 158, 255, 0.15);
}

.result-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-sm);
}

.result-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.result-label {
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.result-value {
  font-size: var(--font-xl);
  font-weight: 700;
  color: var(--primary-color);
  font-variant-numeric: tabular-nums;
}

.result-unit {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}

.history-panel {
  background: rgba(255, 255, 255, 0.02);
}

.history-count {
  background: rgba(64, 158, 255, 0.15);
  color: var(--primary-color);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  margin-left: auto;
}

.history-group {
  margin-bottom: 10px;
}

.history-group:last-child {
  margin-bottom: 0;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0 4px 8px;
  border-left: 2px solid;
  margin-bottom: 6px;
}

.group-icon {
  font-size: 12px;
}

.group-label {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-primary);
}

.group-count {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: auto;
  padding-right: 4px;
}

.group-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.history-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-sm);
  transition: background 0.15s;
  cursor: pointer;
}

.history-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.history-item.highlighted {
  background: rgba(255, 152, 0, 0.12);
  border: 1px solid rgba(255, 152, 0, 0.3);
}

.item-left {
  flex: 1;
  min-width: 0;
}

.item-value {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.item-time {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 1px;
}

.item-delete {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.item-delete:hover {
  background: rgba(239, 83, 80, 0.15);
  color: #ef5350;
}

.slide-fade-enter-active {
  transition: all 0.3s ease;
}

.slide-fade-leave-active {
  transition: all 0.2s ease;
}

.slide-fade-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.slide-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
