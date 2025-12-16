<template>
    <div class="panel-section">
        <h4>数据导出</h4>
        <div class="export-options">
            <button class="export-option-btn" @click="$emit('export-scene-data')">
                <span class="export-icon">💾</span>
                <span class="export-text">导出场景数据</span>
            </button>
            <button class="export-option-btn" @click="$emit('export-report')">
                <span class="export-icon">📄</span>
                <span class="export-text">生成分析报告</span>
            </button>
            <button class="export-option-btn" @click="$emit('export-screenshot')">
                <span class="export-icon">🖼️</span>
                <span class="export-text">截图保存</span>
            </button>
        </div>
    </div>

    <div class="panel-section">
        <h4>系统设置</h4>
        <div class="system-settings">
            <div class="setting-item">
                <label class="setting-label">显示质量:</label>
                <select v-model="localDisplayQuality" @change="updateSetting" class="setting-select">
                    <option value="low">低质量</option>
                    <option value="medium">中等质量</option>
                    <option value="high">高质量</option>
                </select>
            </div>
            <div class="setting-item">
                <label class="setting-label">地形精度:</label>
                <select v-model="localTerrainQuality" @change="updateSetting" class="setting-select">
                    <option value="low">低精度</option>
                    <option value="medium">中等精度</option>
                    <option value="high">高精度</option>
                </select>
            </div>
            <div class="setting-item">
                <label class="setting-label">坐标显示:</label>
                <select v-model="localCoordinateSystem" @change="updateSetting" class="setting-select">
                    <option value="wgs84">WGS84</option>
                    <option value="cgcs2000">CGCS2000</option>
                    <option value="local">本地坐标系</option>
                </select>
            </div>
        </div>
    </div>

    <div class="panel-section">
        <h4>系统工具</h4>
        <div class="system-tools">
            <button class="system-tool-btn" @click="$emit('reset-view')">
                <span class="tool-icon">🔄</span>
                <span class="tool-text">重置视角</span>
            </button>
            <button class="system-tool-btn" @click="$emit('fit-to-models')">
                <span class="tool-icon">🔍</span>
                <span class="tool-text">适配模型</span>
            </button>
            <button class="system-tool-btn" @click="$emit('toggle-fullscreen')">
                <span class="tool-icon">⛶</span>
                <span class="tool-text">全屏显示</span>
            </button>
        </div>
    </div>

    <div class="panel-section">
        <h4>开发中功能</h4>
        <div class="developing-features">
            <div class="feature-item developing">
                <span class="feature-icon">🚧</span>
                <span class="feature-text">储量动态计算</span>
            </div>
            <div class="feature-item developing">
                <span class="feature-icon">🚧</span>
                <span class="feature-text">开采模拟</span>
            </div>
            <div class="feature-item developing">
                <span class="feature-icon">🚧</span>
                <span class="feature-text">安全监测</span>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, computed } from 'vue'

// 定义组件属性
const props = defineProps({
    coordinateSystem: { type: String, default: 'wgs84' }
})

// 定义事件发射器
const emit = defineEmits([
    'export-scene-data', 'export-report', 'export-screenshot',
    'reset-view', 'fit-to-models', 'toggle-fullscreen'
])

// 本地状态
const localDisplayQuality = ref('medium')
const localTerrainQuality = ref('medium')
const localCoordinateSystem = ref(props.coordinateSystem)

// 计算属性
const settings = computed(() => ({
    displayQuality: localDisplayQuality.value,
    terrainQuality: localTerrainQuality.value,
    coordinateSystem: localCoordinateSystem.value
}))

// 更新设置
const updateSetting = () => {
    // 这里可以添加设置更新的逻辑
    console.log('Settings updated:', settings.value)
}
</script>

<style scoped>
/* 数据导出样式 */
.export-options {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--spacing-md);
}

.export-option-btn {
    display: flex;
    align-items: center;
    gap: var(--spacing-xl);
    padding: var(--spacing-xl) var(--spacing-2xl);
    background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
    color: var(--text-muted);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: left;
    box-shadow: var(--shadow-md);
}

.export-option-btn:hover {
    background: linear-gradient(135deg, var(--bg-secondary), var(--bg-primary));
    color: var(--text-primary);
    transform: translateY(-2px);
    box-shadow: var(--shadow-lg);
}

.export-icon {
    font-size: var(--font-lg);
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.export-text {
    font-size: var(--font-sm);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 系统设置样式 */
.system-settings {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xl);
}

.setting-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-md) 0;
    transition: all var(--transition-fast);
}

.setting-item:hover {
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
    padding: var(--spacing-md) var(--spacing-sm);
}

.setting-label {
    font-size: var(--font-sm);
    color: var(--text-primary);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.setting-select {
    padding: var(--spacing-xs) var(--spacing-md);
    background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    width: 140px;
    box-shadow: var(--shadow-md);
    transition: all var(--transition-fast);
}

.setting-select:focus {
    outline: none;
    border-color: var(--primary-color);
    box-shadow: 0 4px 12px rgba(78, 125, 219, 0.3);
}

/* 系统工具样式 */
.system-tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-md);
}

.system-tool-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-2xl) var(--spacing-xl);
    background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    box-shadow: var(--shadow-md);
}

.system-tool-btn:hover {
    background: linear-gradient(135deg, var(--bg-secondary), var(--bg-primary));
    color: var(--text-primary);
    transform: translateY(-2px);
    box-shadow: var(--shadow-lg);
}

.tool-icon {
    font-size: var(--font-lg);
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.tool-text {
    font-size: var(--font-xs);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    color: var(--text-primary);
}

/* 开发中功能样式 */
.developing-features {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}

.feature-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    font-size: 11px;
    transition: all 0.3s ease;
}

.feature-item:hover {
    background: rgba(255, 255, 255, 0.08);
}

.feature-item.developing {
    opacity: 0.6;
}

.feature-icon {
    font-size: 12px;
}

.feature-text {
    color: #e2e8f0;
}

h4 {
    color: white;
}
</style>