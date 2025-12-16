<template>
    <div class="model-controls-container" :class="{ collapsed: isCollapsed }">
        <!-- 收起时的状态 -->
        <div class="collapsed-header" @click="toggleCollapse">
            <div class="logo">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" />
                </svg>
                <span>模型控制</span>
            </div>
            <div class="collapse-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z" />
                </svg>
            </div>
        </div>

        <!-- 展开时的内容 -->
        <div v-if="!isCollapsed" class="controls-content">
            <div class="content-header">
                <h3>矿山模型控制</h3>
                <button class="close-btn" @click="toggleCollapse">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path
                            d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" />
                    </svg>
                </button>
            </div>

            <!-- 位置控制 -->
            <div class="control-section">
                <h4>位置控制</h4>

                <!-- 经度控制 -->
                <div class="control-item">
                    <div class="control-label">
                        <span class="label-text">经度:</span>
                        <span class="label-value">{{ modelPosition.longitude.toFixed(4) }}</span>
                    </div>
                    <div class="control-inputs">
                        <button class="step-btn" @mousedown.prevent="startAdjust('longitude', -0.0001)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">-</button>
                        <input type="range" min="113.313" max="113.333" step="0.0001"
                            v-model.number="modelPosition.longitude" @input="onPositionChange">
                        <button class="step-btn" @mousedown.prevent="startAdjust('longitude', 0.0001)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">+</button>
                        <input type="number" v-model.number="modelPosition.longitude" step="0.01"
                            @change="onPositionChange" class="number-input">
                    </div>
                </div>

                <!-- 纬度控制 -->
                <div class="control-item">
                    <div class="control-label">
                        <span class="label-text">纬度:</span>
                        <span class="label-value">{{ modelPosition.latitude.toFixed(4) }}</span>
                    </div>
                    <div class="control-inputs">
                        <button class="step-btn" @mousedown.prevent="startAdjust('latitude', -0.0001)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">-</button>
                        <input type="range" min="23.096" max="23.116" step="0.0001"
                            v-model.number="modelPosition.latitude" @input="onPositionChange">
                        <button class="step-btn" @mousedown.prevent="startAdjust('latitude', 0.0001)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">+</button>
                        <input type="number" v-model.number="modelPosition.latitude" step="0.0001"
                            @change="onPositionChange" class="number-input">
                    </div>
                </div>

                <!-- 高度控制 -->
                <div class="control-item">
                    <div class="control-label">
                        <span class="label-text">高度:</span>
                        <span class="label-value">{{ modelPosition.height }}米</span>
                    </div>
                    <div class="control-inputs">
                        <button class="step-btn" @mousedown.prevent="startAdjust('height', -1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">-</button>
                        <input type="range" min="0" max="5000" step="1" v-model.number="modelPosition.height"
                            @input="onPositionChange">
                        <button class="step-btn" @mousedown.prevent="startAdjust('height', 1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">+</button>
                        <input type="number" v-model.number="modelPosition.height" step="1" @change="onPositionChange"
                            class="number-input">
                    </div>
                </div>
            </div>

            <!-- 旋转控制 -->
            <div class="control-section">
                <h4>旋转控制</h4>

                <!-- X轴旋转 -->
                <div class="control-item">
                    <div class="control-label">
                        <span class="label-text">X轴:</span>
                        <span class="label-value">{{ modelTransform.rotationX }}°</span>
                    </div>
                    <div class="control-inputs">
                        <button class="step-btn" @mousedown.prevent="startAdjust('rotationX', -1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">-</button>
                        <input type="range" min="-180" max="180" step="1" v-model.number="modelTransform.rotationX"
                            @input="onTransformChange">
                        <button class="step-btn" @mousedown.prevent="startAdjust('rotationX', 1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">+</button>
                        <input type="number" v-model.number="modelTransform.rotationX" step="1"
                            @change="onTransformChange" class="number-input">
                    </div>
                </div>

                <!-- Y轴旋转 -->
                <div class="control-item">
                    <div class="control-label">
                        <span class="label-text">Y轴:</span>
                        <span class="label-value">{{ modelTransform.rotationY }}°</span>
                    </div>
                    <div class="control-inputs">
                        <button class="step-btn" @mousedown.prevent="startAdjust('rotationY', -1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">-</button>
                        <input type="range" min="-180" max="180" step="1" v-model.number="modelTransform.rotationY"
                            @input="onTransformChange">
                        <button class="step-btn" @mousedown.prevent="startAdjust('rotationY', 1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">+</button>
                        <input type="number" v-model.number="modelTransform.rotationY" step="1"
                            @change="onTransformChange" class="number-input">
                    </div>
                </div>

                <!-- Z轴旋转 -->
                <div class="control-item">
                    <div class="control-label">
                        <span class="label-text">Z轴:</span>
                        <span class="label-value">{{ modelTransform.rotationZ }}°</span>
                    </div>
                    <div class="control-inputs">
                        <button class="step-btn" @mousedown.prevent="startAdjust('rotationZ', -1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">-</button>
                        <input type="range" min="-180" max="180" step="1" v-model.number="modelTransform.rotationZ"
                            @input="onTransformChange">
                        <button class="step-btn" @mousedown.prevent="startAdjust('rotationZ', 1)"
                            @mouseup.prevent="stopAdjust" @mouseleave="handleMouseLeave">+</button>
                        <input type="number" v-model.number="modelTransform.rotationZ" step="1"
                            @change="onTransformChange" class="number-input">
                    </div>
                </div>
            </div>

            <!-- 操作按钮 -->
            <div class="action-buttons">
                <button class="action-btn reset-view" @click="$emit('resetView')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 6px;">
                        <path
                            d="M12,5.5A3.5,3.5 0 0,1 15.5,9C15.5,9.97 15.07,10.84 14.39,11.43L12,13.5L9.61,11.43C8.93,10.84 8.5,9.97 8.5,9A3.5,3.5 0 0,1 12,5.5M12,2A7,7 0 0,0 5,9C5,14.25 12,22 12,22C12,22 19,14.25 19,9A7,7 0 0,0 12,2M12,4A5,5 0 0,1 17,9C17,10 16.69,10.9 16.18,11.65L12,15.5L7.82,11.65C7.31,10.9 7,10 7,9A5,5 0 0,1 12,4Z" />
                    </svg>
                    重置视角
                </button>
                <button class="action-btn reset-model" @click="$emit('resetModel')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 6px;">
                        <path
                            d="M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2C6.48,2 2,6.48 2,12C2,17.52 6.48,22 12,22C17.52,22 22,17.52 22,12C22,6.48 17.52,2 12,2M12,7.5C9.52,7.5 7.5,9.52 7.5,12C7.5,14.48 9.52,16.5 12,16.5C14.48,16.5 16.5,14.48 16.5,12C16.5,9.52 14.48,7.5 12,7.5Z" />
                    </svg>
                    重置模型
                </button>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, reactive, watch, defineEmits, defineProps, onMounted, onUnmounted } from 'vue'

const emit = defineEmits(['positionChange', 'transformChange', 'resetView', 'resetModel'])
const props = defineProps({
    initialPosition: Object,
    initialTransform: Object
})

// 控制面板状态
const isCollapsed = ref(true)

// 模型位置数据
const modelPosition = reactive({
    longitude: props.initialPosition?.longitude || 113.323,
    latitude: props.initialPosition?.latitude || 23.106,
    height: props.initialPosition?.height || 50
})

// 模型变换数据
const modelTransform = reactive({
    rotationX: props.initialTransform?.rotationX || 15,
    rotationY: props.initialTransform?.rotationY || 0,
    rotationZ: props.initialTransform?.rotationZ || 0
})

// 长按增减控制
let adjustInterval = null
let isAdjusting = false
let currentAdjustType = null

// 开始调整数值
const startAdjust = (property, delta) => {
    if (isAdjusting) return

    isAdjusting = true
    currentAdjustType = property

    // 首次调整
    adjustValue(property, delta)

    // 设置延迟后开始连续调整
    setTimeout(() => {
        if (isAdjusting && currentAdjustType === property) {
            adjustInterval = setInterval(() => {
                if (isAdjusting && currentAdjustType === property) {
                    adjustValue(property, delta)
                }
            }, 50)
        }
    }, 300)
}

// 调整数值
const adjustValue = (property, delta) => {
    let targetObj = null
    let value = 0

    if (property in modelPosition) {
        targetObj = modelPosition
        value = modelPosition[property] + delta

        // 限制范围
        if (property === 'longitude') {
            value = Math.max(113.313, Math.min(113.333, value))
        } else if (property === 'latitude') {
            value = Math.max(23.096, Math.min(23.116, value))
        } else if (property === 'height') {
            value = Math.max(0, Math.min(5000, value))
        }
    } else if (property in modelTransform) {
        targetObj = modelTransform
        value = modelTransform[property] + delta

        // 限制角度范围在 -180 到 180 之间
        value = ((value + 180) % 360 + 360) % 360 - 180
    }

    if (targetObj) {
        targetObj[property] = value

        // 触发相应的事件
        if (targetObj === modelPosition) {
            onPositionChange()
        } else {
            onTransformChange()
        }
    }
}

// 停止调整
const stopAdjust = () => {
    isAdjusting = false
    currentAdjustType = null

    if (adjustInterval) {
        clearInterval(adjustInterval)
        adjustInterval = null
    }
}

// 处理鼠标离开按钮
const handleMouseLeave = (event) => {
    // 只有在鼠标按下状态离开按钮时才停止调整
    if (event.buttons === 1) {
        stopAdjust()
    }
}

// 切换展开/收起状态
const toggleCollapse = () => {
    isCollapsed.value = !isCollapsed.value
}

// 位置变化处理
const onPositionChange = () => {
    emit('positionChange', { ...modelPosition })
}

// 变换变化处理
const onTransformChange = () => {
    emit('transformChange', { ...modelTransform })
}

// 监听外部传入的初始值变化
watch(() => props.initialPosition, (newVal) => {
    if (newVal) {
        Object.assign(modelPosition, newVal)
    }
}, { deep: true })

watch(() => props.initialTransform, (newVal) => {
    if (newVal) {
        Object.assign(modelTransform, newVal)
    }
}, { deep: true })

// 组件卸载时清理定时器
onUnmounted(() => {
    stopAdjust()
})

// 添加全局鼠标抬起事件监听和触摸事件支持
onMounted(() => {
    // 使用 passive 事件监听器
    const options = { passive: true }
    document.addEventListener('mouseup', stopAdjust, options)
    document.addEventListener('touchend', stopAdjust, options)

    // 为所有增减按钮添加触摸事件支持
    const stepButtons = document.querySelectorAll('.step-btn')
    stepButtons.forEach(button => {
        // 使用 passive 事件监听器
        button.addEventListener('touchstart', (e) => {
            e.preventDefault()
            const isMinus = button.textContent === '-'
            const property = button.closest('.control-item').querySelector('.label-text').textContent

            let adjProperty = ''
            if (property.includes('经度')) adjProperty = 'longitude'
            else if (property.includes('纬度')) adjProperty = 'latitude'
            else if (property.includes('高度')) adjProperty = 'height'
            else if (property.includes('X轴')) adjProperty = 'rotationX'
            else if (property.includes('Y轴')) adjProperty = 'rotationY'
            else if (property.includes('Z轴')) adjProperty = 'rotationZ'

            if (adjProperty) {
                const delta = isMinus ? -getStepSize(adjProperty) : getStepSize(adjProperty)
                startAdjust(adjProperty, delta)
            }
        }, { passive: false })

        button.addEventListener('touchend', stopAdjust, { passive: true })
        button.addEventListener('touchcancel', stopAdjust, { passive: true })
    })
})

onUnmounted(() => {
    const options = { passive: true }
    document.removeEventListener('mouseup', stopAdjust, options)
    document.removeEventListener('touchend', stopAdjust, options)
})

// 获取步长大小
const getStepSize = (property) => {
    switch (property) {
        case 'longitude':
        case 'latitude':
            return 0.0001
        case 'height':
            return 1
        case 'rotationX':
        case 'rotationY':
        case 'rotationZ':
            return 1
        default:
            return 0.0001
    }
}
</script>

<style scoped>
.model-controls-container {
    position: absolute;
    top: var(--spacing-3xl);
    left: var(--spacing-3xl);
    z-index: 9;
    transition: all var(--transition-base);
}

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

.content-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-3xl);
    padding-bottom: var(--spacing-xl);
    border-bottom: 1px solid var(--border-primary);
}

.content-header h3 {
    margin: 0;
    font-size: var(--font-lg);
    color: var(--text-primary);
    font-weight: 500;
}

.close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: var(--spacing-xs);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
}

.close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-tertiary);
}

.control-section {
    margin-bottom: var(--spacing-3xl);
}

.control-section h4 {
    margin: 0 0 var(--spacing-xl) 0;
    font-size: var(--font-base);
    color: var(--text-secondary);
    font-weight: 500;
}

.control-item {
    margin-bottom: var(--spacing-2xl);
}

.control-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-sm);
}

.label-text {
    font-size: var(--font-xs);
    color: var(--text-muted);
}

.label-value {
    font-size: var(--font-xs);
    color: var(--text-secondary);
    font-weight: 500;
    background: var(--bg-tertiary);
    padding: var(--spacing-xs) var(--spacing-md);
    border-radius: var(--radius-sm);
}

.control-inputs {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
}

.step-btn {
    width: 32px;
    height: 32px;
    background: rgba(78, 125, 219, 0.3);
    color: var(--text-primary);
    border: 1px solid rgba(78, 125, 219, 0.5);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 16px;
    font-weight: bold;
    transition: all var(--transition-fast);
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    position: relative;
    touch-action: manipulation;
}

.step-btn:hover {
    background: rgba(78, 125, 219, 0.5);
}

.step-btn:active {
    background: rgba(78, 125, 219, 0.7);
    transform: scale(0.95);
}

input[type="range"] {
    flex: 1;
    height: 8px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
    touch-action: none;
    position: relative;
    overflow: visible;
}

input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    background: linear-gradient(135deg, var(--primary-color), #6a9aff);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
    position: relative;
    z-index: 100;
    transition: all var(--transition-fast);
    margin-top: -6px;
    /* 使滑块垂直居中（考虑到轨道高度8px） */
}

input[type="range"]::-webkit-slider-thumb:hover {
    transform: scale(1.15);
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.95), 0 4px 15px rgba(0, 0, 0, 0.5);
    background: linear-gradient(135deg, #6a9aff, var(--primary-color));
}

input[type="range"]::-webkit-slider-thumb:active {
    transform: scale(1.1);
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.9), 0 2px 8px rgba(0, 0, 0, 0.4);
}

input[type="range"]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    background: linear-gradient(135deg, var(--primary-color), #6a9aff);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
    transition: all var(--transition-fast);
    position: relative;
    z-index: 100;
}

input[type="range"]::-moz-range-track {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    border: none;
}

input[type="range"]::-ms-thumb {
    width: 24px;
    height: 24px;
    background: linear-gradient(135deg, var(--primary-color), #6a9aff);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.9), 0 3px 10px rgba(0, 0, 0, 0.4);
    border: 3px solid #ffffff;
}

input[type="range"]::-ms-track {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    border: none;
    color: transparent;
}

.number-input {
    width: 80px;
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-secondary);
    border-radius: var(--radius-sm);
    font-size: var(--font-xs);
    transition: all var(--transition-fast);
    touch-action: manipulation;
}

.number-input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 2px rgba(78, 125, 219, 0.2);
}

.action-buttons {
    display: flex;
    gap: var(--spacing-lg);
    margin-top: var(--spacing-3xl);
}

.action-btn {
    flex: 1;
    padding: var(--spacing-xl);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--font-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-base);
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
}

.reset-view {
    background: linear-gradient(135deg, var(--primary-light), var(--primary-dark));
    color: var(--text-primary);
}

.reset-view:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(57, 83, 215, 0.3);
}

.reset-model {
    background: rgba(255, 107, 107, 0.2);
    color: var(--secondary-color);
    border: 1px solid rgba(255, 107, 107, 0.3);
}

.reset-model:hover {
    background: rgba(255, 107, 107, 0.3);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(255, 107, 107, 0.2);
}

/* 响应式设计 */
@media (max-width: 768px) {
    .controls-content {
        width: calc(100vw - 40px);
        max-width: var(--panel-width);
    }

    .collapsed-header {
        min-width: 140px;
    }

    .number-input {
        width: 70px;
    }
}
</style>