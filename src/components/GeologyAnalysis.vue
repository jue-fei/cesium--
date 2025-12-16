<template>
    <div class="geology-analysis-container">
        <!-- 模型管理部分 -->
        <div class="panel-section">
            <h4>模型管理</h4>

            <!-- 配置文件管理 - 默认隐藏，通过设置按钮打开 -->
            <div class="config-control" v-if="isConfigPanelOpen">
                <div class="config-header">
                    <span class="control-label">模型配置文件:</span>
                    <button @click="toggleConfigPanel" class="compact-action-btn" title="隐藏配置面板">隐藏</button>
                </div>
                <div class="config-inputs">
                    <div class="config-file-selector">
                        <label>选择配置文件:</label>
                        <select v-model="currentConfigFileLocal" @change="loadSelectedConfig" class="config-select">
                            <option value="">请选择配置文件</option>
                            <option v-for="file in modelConfigFiles" :key="file.path" :value="file.path">
                                {{ file.name }}
                            </option>
                        </select>
                    </div>
                    <div class="config-actions">
                        <button @click="uploadConfigFile" class="compact-action-btn secondary">上传配置文件</button>
                        <button @click="reloadCurrentConfig" class="compact-action-btn secondary">重新加载</button>
                    </div>
                </div>
            </div>

            <!-- 配置文件设置按钮 - 当面板关闭时显示 -->
            <div class="config-control" v-if="!isConfigPanelOpen">
                <div class="config-header">
                    <span class="control-label">模型配置:</span>
                    <button @click="toggleConfigPanel" class="compact-action-btn" title="管理配置文件">设置</button>
                </div>
            </div>

            <!-- 全局控制 -->
            <div class="global-control">
                <span class="control-label">全局透明度:</span>
                <div class="control-inputs">
                    <input type="range" min="0" max="100" step="1" v-model="globalOpacityLocal"
                        @change="updateGlobalOpacity" class="slider">
                    <span class="value-display">{{ globalOpacityLocal }}%</span>
                </div>
            </div>

            <!-- 模型列表 -->
            <div class="compact-model-list">
                <div v-for="model in modelList" :key="model.id" class="compact-model-item"
                    :class="{ 'hover-highlight': hoveredModelId === model.id }" @mouseenter="hoveredModelId = model.id"
                    @mouseleave="hoveredModelId = null">
                    <label class="compact-model-checkbox">
                        <input type="checkbox" v-model="model.visible" @change="toggleModelVisibility(model)">
                        <span class="checkmark"></span>
                        <span class="compact-model-name">{{ model.name }}</span>
                    </label>
                    <div class="compact-model-controls">
                        <div class="compact-opacity-control">
                            <span class="opacity-label">透明度:</span>
                            <input type="range" min="0" max="100" step="1" v-model="model.opacity"
                                @change="updateModelOpacity(model)" class="compact-opacity-slider">
                            <span class="compact-opacity-value">{{ model.opacity }}%</span>
                        </div>
                        <div class="compact-action-buttons">
                            <button @click="highlightModel(model)" class="compact-action-btn" title="高亮显示">🔆</button>
                            <button @click="showModelProperties(model)" class="compact-action-btn"
                                title="查看属性">📋</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 模型操作按钮 -->
            <div class="compact-action-buttons-group">
                <button @click="showAllModels" class="compact-action-btn secondary">显示全部</button>
                <button @click="hideAllModels" class="compact-action-btn secondary">隐藏全部</button>
                <button @click="resetAllOpacity" class="compact-action-btn secondary">重置透明度</button>
            </div>
        </div>

        <!-- 属性查看器 - 只在选择模型时显示 -->
        <div class="panel-section property-section" v-if="selectedModel">
            <h4>模型属性 - {{ selectedModel.name }}</h4>
            <div class="compact-property-content">
                <div class="compact-property-group">
                    <h5>基本信息</h5>
                    <div class="compact-property-item">
                        <span class="compact-property-label">模型ID:</span>
                        <span class="compact-property-value">{{ selectedModel.id }}</span>
                    </div>
                    <div class="compact-property-item">
                        <span class="compact-property-label">模型类型:</span>
                        <span class="compact-property-value">{{ selectedModel.type || '未知' }}</span>
                    </div>
                    <div class="compact-property-item">
                        <span class="compact-property-label">显示状态:</span>
                        <span class="compact-property-value">{{ selectedModel.visible ? '显示' : '隐藏' }}</span>
                    </div>
                    <div class="compact-property-item">
                        <span class="compact-property-label">透明度:</span>
                        <span class="compact-property-value">{{ selectedModel.opacity }}%</span>
                    </div>
                </div>

                <!-- 地质属性 -->
                <div class="compact-property-group" v-if="selectedModel.geologyProperties">
                    <h5>地质属性</h5>
                    <div v-for="(value, key) in selectedModel.geologyProperties" :key="key"
                        class="compact-property-item">
                        <span class="compact-property-label">{{ key }}:</span>
                        <span class="compact-property-value">{{ value }}</span>
                    </div>
                </div>

                <!-- 属性操作按钮 -->
                <div class="compact-property-actions" v-if="selectedModel.geologyProperties">
                    <button @click="exportModelProperties(selectedModel)"
                        class="compact-action-btn secondary">导出属性</button>
                    <button @click="copyPropertiesToClipboard(selectedModel)"
                        class="compact-action-btn secondary">复制属性</button>
                </div>
            </div>
        </div>

        <!-- 统计信息和查询合并显示 -->
        <div class="panel-section combined-section">
            <h4>地质信息</h4>

            <!-- 统计信息 -->
            <div class="stats-container">
                <div class="stat-card" v-for="stat in geologicalStats" :key="stat.id">
                    <div class="stat-card-icon">{{ stat.icon }}</div>
                    <div class="stat-card-content">
                        <div class="stat-card-value">{{ stat.value }}{{ stat.unit }}</div>
                        <div class="stat-card-label">{{ stat.label }}</div>
                    </div>
                </div>
            </div>

            <!-- 钻孔查询 -->
            <div class="query-container">
                <div class="query-input">
                    <label>钻孔编号:</label>
                    <select v-model="selectedBorehole" class="query-select">
                        <option value="">请选择钻孔</option>
                        <option v-for="borehole in boreholes" :key="borehole.id" :value="borehole.id">
                            {{ borehole.name }}
                        </option>
                    </select>
                    <button @click="queryBoreholeInfo" class="compact-action-btn primary" :disabled="!selectedBorehole">
                        查询
                    </button>
                </div>

                <!-- 钻孔信息 -->
                <div class="borehole-info" v-if="currentBorehole">
                    <div class="borehole-details">
                        <div class="borehole-detail">
                            <span class="detail-label">孔深:</span>
                            <span class="detail-value">{{ currentBorehole.depth }}米</span>
                        </div>
                        <div class="borehole-detail">
                            <span class="detail-label">方位角:</span>
                            <span class="detail-value">{{ currentBorehole.azimuth }}°</span>
                        </div>
                        <div class="borehole-detail">
                            <span class="detail-label">倾角:</span>
                            <span class="detail-value">{{ currentBorehole.dip }}°</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 矿体信息 -->
        <div class="panel-section orebody-section">
            <h4>矿体信息</h4>
            <div class="orebody-container">
                <div class="orebody-card" v-for="orebody in orebodies" :key="orebody.id">
                    <div class="orebody-card-header">
                        <div class="orebody-card-name">{{ orebody.name }}</div>
                        <div class="orebody-card-grade" :class="getGradeClass(orebody.grade)">
                            {{ orebody.grade }}%
                        </div>
                    </div>
                    <div class="orebody-card-details">
                        <div class="orebody-card-detail">
                            <span class="detail-label">厚度:</span>
                            <span class="detail-value">{{ orebody.thickness }}米</span>
                        </div>
                        <div class="orebody-card-detail">
                            <span class="detail-label">储量:</span>
                            <span class="detail-value">{{ orebody.reserves }}万吨</span>
                        </div>
                        <div class="orebody-card-detail">
                            <span class="detail-label">金属:</span>
                            <span class="detail-value">{{ orebody.metal }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

// Props定义
const props = defineProps({
    modelConfigFiles: { type: Array, default: () => [] },
    currentConfigFile: { type: String, default: '' },
    modelList: { type: Array, default: () => [] },
    globalOpacity: { type: Number, default: 0 },
    selectedModel: { type: Object, default: null },
    viewer: { type: Object, default: null }
})

// 定义事件发射器
const emit = defineEmits([
    'load-config',
    'upload-config',
    'reload-config',
    'update-global-opacity',
    'toggle-model-visibility',
    'update-model-opacity',
    'highlight-model',
    'show-model-properties',
    'show-all-models',
    'hide-all-models',
    'reset-all-opacity',
    'export-model-properties',
    'copy-properties-to-clipboard'
])

// 本地状态
const isConfigPanelOpen = ref(false)
const hoveredModelId = ref(null)
const selectedBorehole = ref('')
const currentBorehole = ref(null)
const currentConfigFileLocal = ref(props.currentConfigFile)
const globalOpacityLocal = ref(props.globalOpacity)

// 监听props变化，同步本地状态
watch(() => props.currentConfigFile, (newVal) => {
    currentConfigFileLocal.value = newVal
})

watch(() => props.globalOpacity, (newVal) => {
    globalOpacityLocal.value = newVal
})

// 地质统计数据
const geologicalStats = ref([
    { id: 1, icon: '📏', label: '平均厚度', value: 15.2, unit: '米' },
    { id: 2, icon: '📊', label: '矿化强度', value: 68, unit: '%' },
    { id: 3, icon: '⛏️', label: '预测储量', value: 1250, unit: '万吨' },
    { id: 4, icon: '💰', label: '平均品位', value: 2.8, unit: '%' }
])

// 钻孔数据
const boreholes = ref([
    { id: 'ZK001', name: 'ZK-001', depth: 245.5, azimuth: 180, dip: -75 },
    { id: 'ZK002', name: 'ZK-002', depth: 312.8, azimuth: 175, dip: -80 },
    { id: 'ZK003', name: 'ZK-003', depth: 187.3, azimuth: 185, dip: -70 },
    { id: 'ZK004', name: 'ZK-004', depth: 278.6, azimuth: 178, dip: -78 }
])

// 矿体数据
const orebodies = ref([
    { id: 1, name: '主矿体', grade: 3.2, thickness: 18.5, reserves: 850, metal: '铜' },
    { id: 2, name: '东矿体', grade: 2.5, thickness: 12.3, reserves: 320, metal: '铜' },
    { id: 3, name: '西矿体', grade: 1.8, thickness: 8.7, reserves: 180, metal: '铜' }
])

// 方法
const toggleConfigPanel = () => {
    isConfigPanelOpen.value = !isConfigPanelOpen.value
}

const loadSelectedConfig = () => {
    emit('load-config', currentConfigFileLocal.value)
}

const uploadConfigFile = () => {
    emit('upload-config')
}

const reloadCurrentConfig = () => {
    emit('reload-config')
}

const updateGlobalOpacity = () => {
    emit('update-global-opacity', globalOpacityLocal.value)
}

const toggleModelVisibility = (model) => {
    emit('toggle-model-visibility', model)
}

const updateModelOpacity = (model) => {
    emit('update-model-opacity', model)
}

const highlightModel = (model) => {
    emit('highlight-model', model)
}

const showModelProperties = (model) => {
    emit('show-model-properties', model)
}

const showAllModels = () => {
    emit('show-all-models')
}

const hideAllModels = () => {
    emit('hide-all-models')
}

const resetAllOpacity = () => {
    emit('reset-all-opacity')
}

const exportModelProperties = (model) => {
    emit('export-model-properties', model)
}

const copyPropertiesToClipboard = (model) => {
    emit('copy-properties-to-clipboard', model)
}

const queryBoreholeInfo = () => {
    currentBorehole.value = boreholes.value.find(b => b.id === selectedBorehole.value)
}

const getGradeClass = (grade) => {
    if (grade >= 3) return 'high-grade'
    if (grade >= 2) return 'medium-grade'
    return 'low-grade'
}
</script>

<style scoped>
.geology-analysis-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

/* 面板区块样式 */
.panel-section {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 10px;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.05);
}

.panel-section h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: #ffffff;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
}

.panel-section h4::before {
    content: '';
    display: block;
    width: 4px;
    height: 14px;
    background: linear-gradient(to bottom, #60A5FA, #3B82F6);
    border-radius: 2px;
}

.panel-section h5 {
    margin: 12px 0 8px 0;
    font-size: 12px;
    color: #94A3B8;
    font-weight: 500;
}

/* 配置控制 */
.config-control {
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.config-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.config-inputs {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.config-file-selector {
    display: flex;
    align-items: center;
    gap: 8px;
}

.config-file-selector label {
    font-size: 12px;
    color: #94A3B8;
    white-space: nowrap;
}

.config-select {
    flex: 1;
    padding: 6px 8px;
    background: rgba(45, 55, 72, 0.8);
    color: #e2e8f0;
    border: 1px solid #718096;
    border-radius: 4px;
    font-size: 12px;
}

.config-actions {
    display: flex;
    gap: 8px;
}

/* 全局控制 */
.global-control {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
    overflow: visible;
}

.control-label {
    font-size: 12px;
    color: #94A3B8;
    white-space: nowrap;
}

.control-inputs {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: visible;
}

.slider {
    flex: 1;
    height: 8px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    outline: none;
    cursor: pointer;
    overflow: visible;
}

.slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #60A5FA, #3B82F6);
    cursor: pointer;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
    margin-top: -5px;
    transition: all 0.2s ease;
    z-index: 100;
}

.slider::-webkit-slider-thumb:hover {
    transform: scale(1.15);
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.95), 0 4px 15px rgba(0, 0, 0, 0.5);
    background: linear-gradient(135deg, #3B82F6, #60A5FA);
}

.slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #60A5FA, #3B82F6);
    cursor: pointer;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
    z-index: 100;
}

.slider::-moz-range-track {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    border: none;
}

.value-display {
    min-width: 40px;
    text-align: center;
    font-size: 12px;
    color: #E2E8F0;
    font-weight: 500;
}

/* 紧凑模型列表 */
.compact-model-list {
    max-height: 200px;
    overflow-y: auto;
    margin: 12px 0;
    padding-right: 4px;
}

.compact-model-list::-webkit-scrollbar {
    width: 4px;
}

.compact-model-list::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 2px;
}

.compact-model-list::-webkit-scrollbar-thumb {
    background: rgba(96, 165, 250, 0.5);
    border-radius: 2px;
}

.compact-model-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    transition: background 0.2s ease;
}

.compact-model-item:last-child {
    border-bottom: none;
}

.compact-model-item.hover-highlight {
    background: rgba(96, 165, 250, 0.1);
}

.compact-model-checkbox {
    display: flex;
    align-items: center;
    cursor: pointer;
}

.checkmark {
    position: relative;
    width: 16px;
    height: 16px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    margin-right: 8px;
    transition: all 0.2s ease;
    flex-shrink: 0;
}

input[type="checkbox"] {
    display: none;
}

input[type="checkbox"]:checked+.checkmark {
    background: #60A5FA;
    border-color: #60A5FA;
}

input[type="checkbox"]:checked+.checkmark:after {
    content: '✓';
    position: absolute;
    color: white;
    font-size: 10px;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
}

.compact-model-name {
    font-size: 12px;
    font-weight: 500;
    color: #e2e8f0;
}

.compact-model-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-left: 24px;
    overflow: visible;
}

.compact-opacity-control {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    overflow: visible;
}

.opacity-label {
    color: #94A3B8;
    white-space: nowrap;
}

.compact-opacity-slider {
    width: 60px;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    overflow: visible;
    outline: none;
}

.compact-opacity-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(135deg, #60A5FA, #3B82F6);
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    margin-top: -4px;
    transition: all 0.2s ease;
    z-index: 100;
}

.compact-opacity-slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.95), 0 3px 8px rgba(0, 0, 0, 0.4);
    background: linear-gradient(135deg, #3B82F6, #60A5FA);
}

.compact-opacity-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: linear-gradient(135deg, #60A5FA, #3B82F6);
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    z-index: 100;
}

.compact-opacity-slider::-moz-range-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    border: none;
}

.compact-opacity-value {
    color: #94A3B8;
    font-size: 10px;
    min-width: 28px;
}

.compact-action-buttons {
    display: flex;
    gap: 4px;
}

.compact-action-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #94A3B8;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 10px;
    padding: 4px 8px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.compact-action-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    color: #e2e8f0;
}

.compact-action-btn.primary {
    background: linear-gradient(135deg, #60A5FA, #3B82F6);
    border-color: #60A5FA;
    color: white;
}

.compact-action-btn.primary:hover {
    background: linear-gradient(135deg, #3B82F6, #2563EB);
}

.compact-action-btn.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.compact-action-btn.secondary {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.1);
}

.compact-action-buttons-group {
    display: flex;
    gap: 8px;
    margin-top: 12px;
}

.compact-action-buttons-group .compact-action-btn {
    flex: 1;
    font-size: 11px;
    padding: 8px;
}

/* 属性查看器 */
.compact-property-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.compact-property-group {
    padding: 10px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
}

.compact-property-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    font-size: 11px;
}

.compact-property-label {
    color: #94A3B8;
}

.compact-property-value {
    color: #e2e8f0;
    font-weight: 500;
}

.compact-property-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}

/* 统计卡片 */
.stats-container {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 16px;
}

.stat-card {
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.6), rgba(51, 65, 85, 0.6));
    border-radius: 8px;
    padding: 12px;
    display: flex;
    gap: 10px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    transition: all 0.3s ease;
}

.stat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
}

.stat-card-icon {
    font-size: 16px;
    background: linear-gradient(135deg, #60A5FA, #3B82F6);
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: white;
    box-shadow: 0 2px 6px rgba(96, 165, 250, 0.4);
}

.stat-card-content {
    flex: 1;
}

.stat-card-value {
    font-size: 14px;
    font-weight: 700;
    color: #60A5FA;
}

.stat-card-label {
    font-size: 10px;
    color: #94A3B8;
    font-weight: 500;
}

/* 查询容器 */
.query-container {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.05);
}

.query-input {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
}

.query-input label {
    font-size: 12px;
    color: #94A3B8;
    min-width: 70px;
}

.query-select {
    flex: 1;
    padding: 6px 8px;
    background: rgba(45, 55, 72, 0.8);
    color: #e2e8f0;
    border: 1px solid #718096;
    border-radius: 4px;
    font-size: 12px;
}

/* 钻孔信息 */
.borehole-info {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.borehole-details {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
}

.borehole-detail {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 4px;
}

.detail-label {
    font-size: 10px;
    color: #94A3B8;
    margin-bottom: 4px;
}

.detail-value {
    font-size: 12px;
    font-weight: 500;
    color: #e2e8f0;
}

/* 矿体信息 */
.orebody-container {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.orebody-card {
    padding: 12px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    border-left: 3px solid #4299e1;
    transition: all 0.3s ease;
}

.orebody-card:hover {
    background: rgba(255, 255, 255, 0.08);
    transform: translateX(4px);
}

.orebody-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}

.orebody-card-name {
    font-size: 13px;
    font-weight: 600;
    color: #e2e8f0;
}

.orebody-card-grade {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 12px;
    font-weight: 500;
}

.orebody-card-grade.high-grade {
    background: rgba(72, 187, 120, 0.2);
    color: #48bb78;
}

.orebody-card-grade.medium-grade {
    background: rgba(246, 173, 85, 0.2);
    color: #f6ad55;
}

.orebody-card-grade.low-grade {
    background: rgba(160, 174, 192, 0.2);
    color: #a0aec0;
}

.orebody-card-details {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
}

.orebody-card-detail {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
}
</style>
