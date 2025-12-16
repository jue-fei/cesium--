<template>
    <div class="professional-panel-container" :class="{ collapsed: isCollapsed }">
        <!-- 收起时的状态 -->
        <div class="collapsed-header" @click="$emit('toggle-collapse')">
            <div class="logo">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" />
                </svg>
                <span>专业分析</span>
            </div>
            <div class="collapse-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z" />
                </svg>
            </div>
        </div>

        <!-- 展开时的内容 -->
        <div class="controls-content" v-if="!isCollapsed">
            <div class="content-header">
                <h3>专业分析</h3>
                <button class="close-btn" @click="$emit('toggle-collapse')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path
                            d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" />
                    </svg>
                </button>
            </div>
            <div class="panel-content">
                <!-- 功能标签导航 -->
                <div class="function-tabs">
                    <div class="tab-list">
                        <button v-for="tab in tabs" :key="tab.id" class="tab-button"
                            :class="{ active: activeTab === tab.id }" @click="switchTab(tab.id)">
                            <span class="tab-icon">{{ tab.icon }}</span>
                            <span class="tab-text">{{ tab.name }}</span>
                        </button>
                    </div>
                </div>



                <!-- 地质分析内容 -->
                <div class="tab-content" v-show="activeTab === 'geology'">
                    <GeologyAnalysis :model-config-files="modelConfigFiles" :current-config-file="currentConfigFile"
                        :model-list="modelList" :global-opacity="globalOpacity" :selected-model="selectedModel"
                        :viewer="viewer" @load-config="$emit('load-config', $event)"
                        @upload-config="$emit('upload-config')" @reload-config="$emit('reload-config')"
                        @update-global-opacity="$emit('update-global-opacity', $event)"
                        @toggle-model-visibility="$emit('toggle-model-visibility', $event)"
                        @update-model-opacity="$emit('update-model-opacity', $event)"
                        @highlight-model="$emit('highlight-model', $event)"
                        @show-model-properties="$emit('show-model-properties', $event)"
                        @show-all-models="$emit('show-all-models')" @hide-all-models="$emit('hide-all-models')"
                        @reset-all-opacity="$emit('reset-all-opacity')"
                        @export-model-properties="$emit('export-model-properties', $event)"
                        @copy-properties-to-clipboard="$emit('copy-properties-to-clipboard', $event)" />
                </div>

                <!-- 测量分析内容 -->
                <div class="tab-content" v-show="activeTab === 'measure'">
                    <MeasurementAnalysis :is-measuring="isMeasuring" :is-area-measuring="isAreaMeasuring"
                        :measurement-distance="measurementDistance" :measurement-area="measurementArea"
                        :measurement-history="measurementHistory" @toggle-measurement="$emit('toggle-measurement')"
                        @toggle-area-measurement="$emit('toggle-area-measurement')"
                        @clear-all-measurements="$emit('clear-all-measurements')"
                        @delete-measurement-record="$emit('delete-measurement-record', $event)"
                        @show-volume-analysis="$emit('show-volume-analysis')"
                        @show-slope-analysis="$emit('show-slope-analysis')"
                        @show-visibility-analysis="$emit('show-visibility-analysis')" />
                </div>

                <!-- 其他功能内容 -->
                <div class="tab-content" v-show="activeTab === 'other'">
                    <OtherFunctions :coordinate-system="coordinateSystem" :display-quality="displayQuality"
                        :terrain-quality="terrainQuality" @export-scene-data="$emit('export-scene-data')"
                        @export-report="$emit('export-report')" @export-screenshot="$emit('export-screenshot')"
                        @reset-view="$emit('reset-view')" @fit-to-models="$emit('fit-to-models')"
                        @toggle-fullscreen="$emit('toggle-fullscreen')"
                        @update-display-quality="$emit('update-display-quality', $event)"
                        @update-terrain-quality="$emit('update-terrain-quality', $event)"
                        @update-coordinate-system="$emit('update-coordinate-system', $event)" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref } from 'vue'
import GeologyAnalysis from './GeologyAnalysis.vue'
import MeasurementAnalysis from './MeasurementAnalysis.vue'
import OtherFunctions from './OtherFunctions.vue'

// 定义组件属性
const props = defineProps({
    isCollapsed: Boolean,
    activeTab: { type: String, default: 'geology' },
    modelConfigFiles: Array,
    currentConfigFile: String,
    modelList: Array,
    globalOpacity: Number,
    coordinateSystem: { type: String, default: 'wgs84' },
    isMeasuring: Boolean,
    selectedModel: Object,
    isAreaMeasuring: Boolean,
    measurementDistance: Number,
    measurementArea: Number,
    measurementHistory: Array,
    viewer: Object,
    displayQuality: { type: String, default: 'medium' },
    terrainQuality: { type: String, default: 'medium' }
})

// 定义事件发射器
const emit = defineEmits([
    'toggle-collapse', 'tab-change', 'toggle-measurement',
    'toggle-area-measurement', 'clear-all-measurements', 'delete-measurement-record',
    'export-scene-data', 'export-report', 'export-screenshot', 'reset-view',
    'fit-to-models', 'toggle-fullscreen',
    // 地质分析事件
    'load-config', 'upload-config', 'reload-config', 'update-global-opacity',
    'toggle-model-visibility', 'update-model-opacity', 'highlight-model',
    'show-model-properties', 'show-all-models', 'hide-all-models', 'reset-all-opacity',
    'export-model-properties', 'copy-properties-to-clipboard',
    // 系统设置事件
    'update-display-quality', 'update-terrain-quality', 'update-coordinate-system'
])

// 标签页数据
const tabs = ref([
    { id: 'geology', name: '地质分析', icon: '🪨' },
    { id: 'measure', name: '测量分析', icon: '📏' },
    { id: 'other', name: '其他功能', icon: '⚙️' }
])

// 切换标签页
const switchTab = (tabId) => emit('tab-change', tabId)
</script>

<style scoped>
/* 专业面板容器 - 与左侧面板保持一致的样式 */
.professional-panel-container {
    position: absolute;
    top: var(--spacing-3xl);
    right: var(--spacing-3xl);
    z-index: 9;
    transition: all var(--transition-base);
}

/* 收起头部 - 与左侧面板保持一致 */
.collapsed-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg-secondary);
    color: var(--text-primary);
    padding: var(--spacing-xl) var(--spacing-2xl);
    border-radius: var(--radius-lg);
    cursor: pointer;
    min-width: 160px;
    backdrop-filter: blur(10px);
    border: 1px solid var(--border-primary);
    box-shadow: var(--shadow-sm);
    transition: all var(--transition-base);
    user-select: none;
}

.collapsed-header:hover {
    background: var(--bg-hover);
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
}

.logo {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    font-size: var(--font-base);
    font-weight: 500;
}

.collapse-icon {
    transition: transform var(--transition-base);
}

.collapsed .collapse-icon {
    transform: rotate(180deg);
}

/* 展开内容 - 与左侧面板保持一致 */
.controls-content {
    background: var(--bg-primary);
    border-radius: var(--radius-lg);
    margin-top: var(--spacing-md);
    padding: var(--spacing-2xl);
    width: var(--panel-width);
    backdrop-filter: blur(10px);
    border: 1px solid var(--border-primary);
    box-shadow: var(--shadow-lg);
    animation: slideDown var(--transition-base);
    max-height: calc(100vh - 180px);
    overflow-y: auto;
    /* 隐藏滚动条但保持滚动功能 */
    scrollbar-width: none;
    -ms-overflow-style: none;
}

/* 隐藏滚动条但保持滚动功能 */
.controls-content::-webkit-scrollbar {
    display: none;
}

@keyframes slideDown {
    from {
        opacity: 0;
        transform: translateY(-10px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* 内容头部 - 与左侧面板保持一致 */
.content-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-3xl);
    padding-bottom: var(--spacing-xl);
    border-bottom: 1px solid var(--border-primary);
}

.content-header h3 {
    color: var(--text-primary);
    font-size: var(--font-lg);
    font-weight: 500;
    margin: 0;
}

.close-btn {
    background: transparent;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    padding: var(--spacing-xs);
    border-radius: var(--radius-sm);
    transition: background-color var(--transition-base);
}

.close-btn:hover {
    background: var(--bg-tertiary);
}

.panel-content {
    padding: 0;
    height: calc(100% - 60px);
    display: flex;
    flex-direction: column;
}

.function-tabs {
    margin-bottom: var(--spacing-3xl);
    background: var(--bg-tertiary);
    padding: var(--spacing-xl);
    border-radius: var(--radius-lg);
}

.tab-list {
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
    width: 100%;
}

.tab-button {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-md) var(--spacing-xl);
    background: rgba(60, 60, 60, 0.8);
    border: none;
    border-radius: var(--radius-md);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    transition: all 0.2s ease;
    flex: 1;
    justify-content: center;
}

.tab-button:hover {
    background: rgba(70, 70, 70, 0.9);
    transform: translateY(-1px);
}

.tab-button.active {
    background: rgba(80, 150, 255, 0.9);
    box-shadow: 0 4px 12px rgba(80, 150, 255, 0.4);
}

.tab-icon {
    font-size: 14px;
}

.tab-text {
    font-size: 11px;
    color: #ffffff;
}

/* 标签内容区域 */
.tab-content {
    background: rgba(40, 40, 40, 0.8);
    border-radius: 8px;
    padding: var(--spacing-lg);
    height: 100%;
    overflow-y: auto;
}

@keyframes fadeIn {
    from {
        opacity: 0;
        transform: translateY(10px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* 面板区块样式 */
.panel-section {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
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

/* 控制组样式 */
.control-group {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-md);
    padding: var(--spacing-sm) 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.control-group:last-child {
    margin-bottom: 0;
    border-bottom: none;
}

.control-label {
    font-size: 12px;
    color: white;
    min-width: 80px;
    font-weight: 500;
}

.control-inputs {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
}

.slider {
    flex: 1;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    outline: none;
    position: relative;
}

.slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #60A5FA;
    cursor: pointer;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8), 0 2px 8px rgba(0, 0, 0, 0.3);
    border: 2px solid #ffffff;
    position: relative;
    z-index: 10;
}

.slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #60A5FA;
    cursor: pointer;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8), 0 2px 8px rgba(0, 0, 0, 0.3);
    border: 2px solid #ffffff;
    position: relative;
    z-index: 10;
}

.number-input {
    width: 60px;
    padding: 4px 6px;
    background: rgba(45, 55, 72, 0.8);
    color: #e2e8f0;
    border: 1px solid #718096;
    border-radius: 4px;
    font-size: 11px;
    text-align: center;
}

.input-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #94A3B8;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s ease;
}

.input-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    color: #e2e8f0;
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
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.compact-model-item:last-child {
    border-bottom: none;
}

.compact-model-checkbox {
    display: flex;
    align-items: center;
    cursor: pointer;
    flex: 1;
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
    flex: 1;
}

.compact-model-controls {
    display: flex;
    align-items: center;
    gap: 8px;
}

.compact-opacity-control {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
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
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    outline: none;
    transition: all 0.2s ease;
    position: relative;
}

.compact-opacity-slider:hover {
    background: rgba(255, 255, 255, 0.15);
}

.compact-opacity-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #60A5FA;
    cursor: pointer;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8), 0 1px 4px rgba(0, 0, 0, 0.3);
    border: 2px solid #ffffff;
    position: relative;
    z-index: 10;
}

.compact-opacity-slider::-webkit-slider-thumb:hover {
    background: #4F9CFA;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), 0 2px 6px rgba(0, 0, 0, 0.4);
}

.compact-opacity-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #60A5FA;
    cursor: pointer;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8), 0 1px 4px rgba(0, 0, 0, 0.3);
    border: 2px solid #ffffff;
    position: relative;
    z-index: 10;
}

.compact-opacity-value {
    color: #94A3B8;
    font-size: 10px;
    min-width: 24px;
    text-align: center;
}

.compact-action-buttons {
    display: flex;
    gap: 4px;
}

.compact-action-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    color: #94A3B8;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 10px;
    padding: 4px 6px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.compact-action-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    color: #e2e8f0;
}

.compact-action-btn.secondary {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.1);
}

.compact-action-buttons-group {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    justify-content: center;
}

.compact-action-buttons-group .compact-action-btn {
    flex: 1;
    font-size: 11px;
    padding: 6px 8px;
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
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.stat-card-label {
    font-size: 10px;
    color: #94A3B8;
    font-weight: 500;
    text-shadow: 0 0.5px 1px rgba(0, 0, 0, 0.3);
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

/* 矿体信息 */
.orebody-container {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.orebody-card {
    padding: 10px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    border-left: 3px solid #4299e1;
    transition: all 0.3s ease;
}

.orebody-card:hover {
    background: rgba(255, 255, 255, 0.08);
    transform: translateY(-2px);
}

.orebody-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}

.orebody-card-name {
    font-size: 12px;
    font-weight: 600;
    color: #e2e8f0;
}

.orebody-card-grade {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 10px;
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
    padding: 6px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
}

.detail-label {
    font-size: 10px;
    color: #ffffff;
    margin-bottom: 4px;
}

.detail-value {
    font-size: 11px;
    font-weight: 500;
    color: #e2e8f0;
}

/* 测量结果 */
.measurement-results {
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 20px;
    border: 1px solid rgba(100, 116, 139, 0.3);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.result-item {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    padding: 8px 0;
}

.result-item:last-child {
    margin-bottom: 0;
}

.result-icon {
    font-size: 16px;
    color: #60A5FA;
}

.result-text {
    font-size: 13px;
    color: #48BB78;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 测量历史 */
.history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
}

.history-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.history-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    transition: all 0.3s ease;
}

.history-item:hover {
    background: rgba(255, 255, 255, 0.08);
}

.history-info {
    flex: 1;
}

.history-type {
    font-size: 11px;
    color: #94A3B8;
}

.history-value {
    font-size: 12px;
    color: #e2e8f0;
    font-weight: 500;
    margin: 2px 0;
}

.history-time {
    font-size: 10px;
    color: #718096;
}

.delete-btn {
    background: rgba(220, 38, 38, 0.2);
    border: 1px solid rgba(220, 38, 38, 0.3);
}

.delete-btn:hover {
    background: rgba(220, 38, 38, 0.3);
}

/* 操作按钮 */
.action-buttons {
    display: flex;
    gap: 10px;
    margin-top: 20px;
}

.action-btn {
    flex: 1;
    padding: 10px 16px;
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
    color: #94A3B8;
    border: 1px solid rgba(100, 116, 139, 0.3);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.action-btn:hover {
    background: linear-gradient(135deg, rgba(51, 65, 85, 0.9), rgba(71, 85, 105, 0.9));
    color: #E2E8F0;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.action-btn.primary {
    background: linear-gradient(135deg, #ed8936, #dd6b20);
    border-color: #ed8936;
    color: white;
}

.action-btn.secondary {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.1);
}

.action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* 响应式设计 */
@media (max-width: 768px) {
    .control-panel {
        width: calc(100vw - 40px);
        right: 20px;
        left: 20px;
    }

    .panel-collapsed {
        transform: translateX(calc(100% - 40px));
    }

    .stats-container {
        grid-template-columns: 1fr;
    }
}
</style>