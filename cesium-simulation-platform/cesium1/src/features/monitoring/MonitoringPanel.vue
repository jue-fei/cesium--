<template>
  <div class="monitoring-panel">
    <div class="panel-section">
      <h4>实时监控控制</h4>
      <div class="control-group">
        <button
          class="compact-action-btn"
          :class="isMonitoring ? 'danger' : 'primary'"
          @click="toggleMonitoring"
        >
          {{ isMonitoring ? '停止监控' : '开始监控' }}
        </button>
        <div class="status-indicator" :class="{ active: isMonitoring }">
          <span class="dot"></span> {{ isMonitoring ? '实时数据接收中' : '离线' }}
        </div>
      </div>
    </div>

    <div class="panel-section">
      <h4>显示图层</h4>
      <div class="layer-list">
        <label class="layer-item">
          <input
            type="checkbox"
            :checked="activeLayers.equipment"
            @change="toggleLayer('equipment')"
          />
          <span class="layer-name">设备运行层 (轨迹/状态)</span>
        </label>
        <label class="layer-item">
          <input type="checkbox" :checked="activeLayers.risk" @change="toggleLayer('risk')" />
          <span class="layer-name">风险预警层 (应力/灾害)</span>
        </label>
      </div>
    </div>

    <div v-if="isMonitoring" class="panel-section">
      <h4>实时告警</h4>
      <div class="alert-list">
        <div class="alert-item warning">
          <span class="alert-icon">⚠️</span>
          <span class="alert-text">设备 E01 健康状态异常 (温度过高)</span>
        </div>
        <div v-if="activeLayers.risk" class="alert-item critical">
          <span class="alert-icon">🚫</span>
          <span class="alert-text">区域 Zone1 检测到高风险应力集中</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import useMonitoring from '../../composables/useMonitoring.js'

const { isMonitoring, activeLayers, startRealtimeMonitoring, stopMonitoring, toggleLayer } =
  useMonitoring()

const toggleMonitoring = () => {
  if (isMonitoring.value) {
    stopMonitoring()
  } else {
    startRealtimeMonitoring()
  }
}
</script>

<style scoped>
.monitoring-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.panel-section {
  background: rgba(255, 255, 255, 0.05);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
}

.control-group {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  margin-top: var(--spacing-sm);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.status-indicator.active {
  color: var(--success-color);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: currentColor;
}

.status-indicator.active .dot {
  box-shadow: 0 0 8px currentColor;
  animation: pulse 2s infinite;
}

.layer-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.layer-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  user-select: none;
}

.alert-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: var(--spacing-sm);
}

.alert-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  font-size: 12px;
}

.alert-item.warning {
  background: rgba(255, 165, 0, 0.1);
  color: #ffa500;
  border: 1px solid rgba(255, 165, 0, 0.3);
}

.alert-item.critical {
  background: rgba(255, 0, 0, 0.1);
  color: #ff4444;
  border: 1px solid rgba(255, 0, 0, 0.3);
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
</style>
