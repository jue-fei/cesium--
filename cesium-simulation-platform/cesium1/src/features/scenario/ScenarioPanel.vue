<template>
  <div class="scenario-panel">
    <div class="panel-section">
      <h4>虚拟场景仿真</h4>
      <div class="control-group">
        <label class="toggle-switch">
          <input v-model="isEditing" type="checkbox" @change="handleModeChange" />
          <span class="slider round"></span>
        </label>
        <span class="status-text">{{ isEditing ? '编辑模式开启 (可拖拽)' : '浏览模式' }}</span>
      </div>
    </div>

    <div v-if="isEditing" class="panel-section">
      <h4>设备部署</h4>
      <div class="equipment-grid">
        <button class="equip-btn" @click="deploy('Excavator')">
          <span class="icon">🚜</span>
          <span class="name">挖掘机</span>
        </button>
        <button class="equip-btn" @click="deploy('Truck')">
          <span class="icon">🚛</span>
          <span class="name">矿卡</span>
        </button>
        <button class="equip-btn" @click="deploy('Drill')">
          <span class="icon">🔨</span>
          <span class="name">钻机</span>
        </button>
      </div>
    </div>

    <div class="panel-section">
      <h4>场景统计</h4>
      <div class="stat-item">
        <span>已部署设备:</span>
        <span class="stat-value">{{ deployedCount }}</span>
      </div>
      <button class="compact-action-btn danger full-width" @click="clearScenario">清空场景</button>
    </div>
  </div>
</template>

<script setup>
import useScenario from '../../composables/useScenario.js'

const { isEditing, deployedCount, toggleEditMode, deployEquipment, clearScenario } = useScenario()

const handleModeChange = () => {
  toggleEditMode(isEditing.value)
}

const deploy = type => {
  deployEquipment(type)
}
</script>

<style scoped>
.scenario-panel {
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

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 20px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  transition: 0.4s;
}

.slider:before {
  position: absolute;
  content: '';
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background-color: white;
  transition: 0.4s;
}

input:checked + .slider {
  background-color: var(--primary-color);
}

input:checked + .slider:before {
  transform: translateX(20px);
}

.slider.round {
  border-radius: 20px;
}

.slider.round:before {
  border-radius: 50%;
}

.equipment-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: var(--spacing-sm);
}

.equip-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-primary);
}

.equip-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.equip-btn .icon {
  font-size: 20px;
}

.equip-btn .name {
  font-size: 10px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  margin-bottom: var(--spacing-sm);
  font-size: 12px;
}

.full-width {
  width: 100%;
  margin-top: var(--spacing-sm);
}
</style>
