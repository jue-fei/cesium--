<template>
    <div class="panel-section">
        <h4>测量工具</h4>
        <div class="measurement-controls">
            <div class="measurement-type-selector">
                <button @click="$emit('toggle-measurement')" class="measurement-type-btn"
                    :class="{ active: isMeasuring }">
                    <span class="measurement-icon">📏</span>
                    <span class="measurement-text">距离测量</span>
                </button>
                <button @click="$emit('toggle-area-measurement')" class="measurement-type-btn"
                    :class="{ active: isAreaMeasuring }">
                    <span class="measurement-icon">📐</span>
                    <span class="measurement-text">面积测量</span>
                </button>
            </div>

            <div class="measurement-actions">
                <button @click="$emit('clear-all-measurements')" class="compact-action-btn secondary"
                    :disabled="!hasMeasurements">
                    清除测量
                </button>
            </div>
        </div>

        <!-- 测量结果显示 -->
        <div class="measurement-results" v-if="hasCurrentMeasurements">
            <div class="result-item" v-if="measurementDistance > 0">
                <span class="result-icon">📏</span>
                <span class="result-text">距离: {{ formattedDistance }} 米</span>
            </div>
            <div class="result-item" v-if="measurementArea > 0">
                <span class="result-icon">📐</span>
                <span class="result-text">面积: {{ formattedArea }} 平方米</span>
            </div>
        </div>

        <!-- 测量历史 -->
        <div class="panel-section" v-if="hasMeasurementHistory">
            <div class="history-header">
                <h4>测量历史</h4>
                <button @click="clearMeasurementHistory" class="compact-action-btn secondary">清除历史</button>
            </div>
            <div class="history-list">
                <div class="history-item" v-for="record in measurementHistory.slice(0, 5)" :key="record.id">
                    <div class="history-info">
                        <div class="history-type">{{ record.type === 'distance' ? '距离' : '面积' }}</div>
                        <div class="history-value">
                            {{ record.type === 'distance' ? formatNumber(record.distance) + '米' :
                                formatNumber(record.area) + '平方米' }}
                        </div>
                        <div class="history-time">{{ formatTime(record.timestamp) }}</div>
                    </div>
                    <button @click="$emit('delete-measurement-record', record.id)" class="compact-action-btn delete-btn"
                        title="删除记录">🗑️</button>
                </div>
            </div>
        </div>

        <!-- 分析工具 -->
        <div class="panel-section">
            <h4>分析工具</h4>
            <div class="analysis-tools">
                <button class="analysis-tool-btn" @click="showVolumeAnalysis">
                    <span class="tool-icon">📊</span>
                    <span class="tool-text">体积分析</span>
                </button>
                <button class="analysis-tool-btn" @click="showSlopeAnalysis">
                    <span class="tool-icon">⛰️</span>
                    <span class="tool-text">坡度分析</span>
                </button>
                <button class="analysis-tool-btn" @click="showVisibilityAnalysis">
                    <span class="tool-icon">👁️</span>
                    <span class="tool-text">可视域分析</span>
                </button>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed } from 'vue'

// 定义组件属性
const props = defineProps({
    isMeasuring: Boolean,
    isAreaMeasuring: Boolean,
    measurementDistance: Number,
    measurementArea: Number,
    measurementHistory: Array
})

// 定义事件发射器
const emit = defineEmits([
    'toggle-measurement', 'toggle-area-measurement',
    'clear-all-measurements', 'delete-measurement-record'
])

// 计算属性
const hasCurrentMeasurements = computed(() =>
    props.measurementDistance > 0 || props.measurementArea > 0
)

const hasMeasurements = computed(() =>
    props.measurementDistance > 0 || props.measurementArea > 0 || props.measurementHistory.length > 0
)

const hasMeasurementHistory = computed(() => props.measurementHistory.length > 0)

const formattedDistance = computed(() => formatNumber(props.measurementDistance))
const formattedArea = computed(() => formatNumber(props.measurementArea))

// 格式化数字显示
const formatNumber = (value) => {
    if (value === undefined || value === null) return '0'
    if (value === 0) return '0'
    if (value < 0.001) return value.toExponential(2)
    if (value < 1) return value.toFixed(3)
    if (value < 1000) return value.toFixed(2)
    return value.toFixed(0)
}

// 格式化时间显示
const formatTime = (timestamp) => {
    const date = new Date(timestamp)
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

// 清除测量历史
const clearMeasurementHistory = () => emit('clear-all-measurements')

// 分析工具函数
const showVolumeAnalysis = () =>
    alert('体积分析：请在场景中选择多个点，系统将自动计算围合体积。')

const showSlopeAnalysis = () =>
    alert('坡度分析：已激活。请在地形上点击查看斜坡坡度信息。')

const showVisibilityAnalysis = () =>
    alert('可视域分析：从当前视点计算可见范围。')
</script>

<style scoped>
/* 测量控制样式 */
.measurement-controls {
    margin-bottom: var(--spacing-3xl);
}

.measurement-type-selector {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-2xl);
}

.measurement-type-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-2xl) var(--spacing-xl);
    background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
    color: var(--text-muted);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    box-shadow: var(--shadow-md);
}

.measurement-type-btn:hover {
    background: linear-gradient(135deg, var(--bg-secondary), var(--bg-primary));
    color: var(--text-primary);
    transform: translateY(-2px);
    box-shadow: var(--shadow-lg);
}

.measurement-type-btn.active {
    background: linear-gradient(135deg, rgba(78, 125, 219, 0.2), rgba(52, 101, 204, 0.3));
    border-color: var(--primary-color);
    color: var(--primary-color);
    box-shadow: 0 4px 12px rgba(78, 125, 219, 0.3);
}

.measurement-icon {
    font-size: var(--font-xl);
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.measurement-text {
    font-size: var(--font-sm);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.measurement-actions {
    display: flex;
    justify-content: center;
}

/* 测量结果显示 */
.measurement-results {
    background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
    border-radius: var(--radius-md);
    padding: var(--spacing-2xl);
    margin-bottom: var(--spacing-3xl);
    border: 1px solid var(--border-primary);
    box-shadow: var(--shadow-md);
}

.result-item {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-md);
    padding: var(--spacing-sm) 0;
}

.result-item:last-child {
    margin-bottom: 0;
}

.result-icon {
    font-size: var(--font-lg);
    color: var(--primary-color);
}

.result-text {
    font-size: var(--font-sm);
    color: var(--success-color);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 测量历史样式 */
.history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-md);
}

.history-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
}

.history-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-sm);
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
}

.history-item:hover {
    background: var(--bg-primary);
}

.history-info {
    flex: 1;
}

.history-type {
    font-size: var(--font-xs);
    color: var(--text-muted);
}

.history-value {
    font-size: var(--font-sm);
    color: var(--text-primary);
    font-weight: 500;
    margin: var(--spacing-xs) 0;
}

.history-time {
    font-size: var(--font-xs);
    color: var(--text-muted);
}

/* 分析工具样式 */
.analysis-tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-md);
}

.analysis-tool-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-2xl) var(--spacing-xl);
    background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
    color: var(--text-muted);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.analysis-tool-btn:hover {
    background: linear-gradient(135deg, rgba(51, 65, 85, 0.9), rgba(71, 85, 105, 0.9));
    color: #E2E8F0;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.tool-icon {
    font-size: 18px;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.tool-text {
    font-size: 12px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    color: #ffffff;
}

/* 紧凑操作按钮 */
.compact-action-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #ffffff;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 11px;
    padding: 6px 10px;
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

.compact-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.delete-btn {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(239, 68, 68, 0.3);
    color: #fca5a5;
}

.delete-btn:hover {
    background: rgba(239, 68, 68, 0.3);
    color: #fecaca;
}

h4 {
    color: white;
}
</style>