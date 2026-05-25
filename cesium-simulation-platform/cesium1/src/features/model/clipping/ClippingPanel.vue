<template>
  <div
    class="flex flex-col gap-5 p-6 text-sm leading-relaxed text-gray-100 bg-gray-900/90 backdrop-blur-md rounded-xl border border-white/10 font-sans shadow-2xl"
  >
    <!-- 切割控制面板 -->
    <div
      class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300 shadow-lg"
    >
      <h4
        class="flex items-center gap-2 m-0 mb-3 text-sm font-semibold text-blue-100 before:content-[''] before:w-1 before:h-4 before:bg-gradient-to-b before:from-blue-400 before:to-blue-600 before:rounded-sm before:shadow-[0_0_8px_rgba(59,130,246,0.5)]"
      >
        切割控制
      </h4>

      <!-- 切割开关 -->
      <div
        class="flex items-center gap-4 py-2 border-b border-white/5 last:border-0 hover:bg-white/5 rounded px-2 transition-colors"
      >
        <span class="text-xs font-medium text-gray-300 min-w-[80px]">切割模式:</span>
        <div class="flex items-center gap-2 flex-1">
          <button
            :class="[
              'px-4 py-1.5 rounded-md font-medium text-xs transition-all duration-200 flex items-center gap-2',
              clippingEnabled
                ? 'bg-gradient-to-r from-green-500/20 to-green-600/20 text-green-400 border border-green-500/30 shadow-[0_0_12px_rgba(34,197,94,0.2)] hover:shadow-[0_0_16px_rgba(34,197,94,0.4)]'
                : 'bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 hover:text-white'
            ]"
            @click="toggleClipping"
          >
            <span
              class="w-1.5 h-1.5 rounded-full"
              :class="
                clippingEnabled
                  ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]'
                  : 'bg-gray-500'
              "
            ></span>
            {{ clippingEnabled ? '停止切割' : '开始切割' }}
          </button>
        </div>
      </div>

      <!-- 多边形切割控制 -->
      <div class="mt-4 bg-black/20 rounded-lg p-3 border border-white/5">
        <h4 class="text-xs font-medium text-gray-400 mb-3 uppercase tracking-wider">多边形切割</h4>

        <div class="flex items-center gap-4 mb-3">
          <span class="text-xs font-medium text-gray-300 min-w-[80px]">状态:</span>
          <div class="flex items-center gap-2 flex-1">
            <button
              :class="[
                'px-4 py-1.5 rounded-md font-medium text-xs transition-all duration-200 flex items-center gap-2',
                polygonClippingEnabled
                  ? 'bg-gradient-to-r from-blue-500/20 to-blue-600/20 text-blue-400 border border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.2)]'
                  : 'bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10'
              ]"
              @click="togglePolygonClipping"
            >
              <span
                class="w-1.5 h-1.5 rounded-full"
                :class="
                  polygonClippingEnabled
                    ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]'
                    : 'bg-gray-500'
                "
              ></span>
              {{ polygonClippingEnabled ? '已开启' : '已关闭' }}
            </button>
          </div>
        </div>

        <template v-if="polygonClippingEnabled">
          <div class="flex gap-2 mb-3">
            <button
              :class="[
                'flex-1 px-4 py-2 rounded-md font-medium text-xs transition-all duration-200 flex justify-center items-center gap-2',
                isDrawingPolygon
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 shadow-[0_0_12px_rgba(245,158,11,0.2)] hover:bg-amber-500/30'
                  : 'bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30 hover:shadow-[0_0_12px_rgba(37,99,235,0.3)]'
              ]"
              @click="toggleDrawingPolygon"
            >
              <span v-if="isDrawingPolygon" class="animate-pulse">●</span>
              {{ isDrawingPolygon ? '结束绘制' : '开始绘制' }}
            </button>
            <button
              class="px-3 py-2 rounded-md bg-white/5 text-gray-400 border border-white/10 hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30 transition-all duration-200"
              title="清除"
              @click="clearAllPolygons"
            >
              🗑️
            </button>
          </div>

          <!-- 参数设置 -->
          <div class="bg-black/20 rounded p-3 border border-white/5 mb-3">
            <!-- 模式控制 -->
            <div class="flex items-center gap-3">
              <span class="text-xs text-gray-400 min-w-[40px]">模式:</span>
              <div class="flex bg-black/40 p-1 rounded-md border border-white/5">
                <button
                  v-for="mode in [
                    { key: 'excavate', label: '挖掘' },
                    { key: 'isolate', label: '保留' }
                  ]"
                  :key="mode.key"
                  :class="[
                    'px-3 py-1 rounded text-xs transition-all duration-200',
                    polygonDirection === mode.key
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                  ]"
                  @click="setDirection(mode.key)"
                >
                  {{ mode.label }}
                </button>
              </div>
            </div>
          </div>

          <button
            class="w-full py-2 rounded-md bg-white/5 text-gray-400 border border-white/10 text-xs hover:bg-white/10 hover:text-white transition-all duration-200"
            @click="resetPolygon"
          >
            重置多边形设置
          </button>
        </template>
      </div>

      <!-- 切割面列表 -->
      <div v-if="clippingEnabled" class="mt-4">
        <div
          class="flex justify-between items-center mb-2 px-3 py-2 bg-gradient-to-br from-blue-500/10 to-blue-600/5 rounded border border-blue-500/20 backdrop-blur-sm"
        >
          <span class="text-xs font-semibold text-blue-400 shadow-blue-500/50 drop-shadow-sm"
            >切割面列表 ({{ clippingPlanes.length }})</span
          >
          <button
            class="px-2 py-1 bg-blue-600/20 text-blue-400 text-xs rounded border border-blue-500/30 hover:bg-blue-600/40 transition-colors"
            @click="addNewPlane"
          >
            + 添加
          </button>
        </div>

        <div
          class="flex flex-col gap-2 max-h-[200px] overflow-y-auto p-2 bg-black/20 rounded border border-white/5 custom-scrollbar"
        >
          <div
            v-for="(plane, index) in clippingPlanes"
            :key="index"
            :class="[
              'group relative overflow-hidden rounded border transition-all duration-200 cursor-pointer',
              activePlaneIndex === index
                ? 'bg-blue-900/20 border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.15)] translate-x-0'
                : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/20 hover:translate-x-1'
            ]"
          >
            <div
              v-if="activePlaneIndex === index"
              class="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-400 to-blue-600 rounded-l-sm"
            ></div>

            <div class="flex justify-between items-center p-3 pl-4" @click="setActivePlane(index)">
              <span class="text-xs font-medium text-gray-200 flex items-center gap-2">
                <span class="text-base opacity-70">✂️</span> 切割面 {{ index + 1 }}
              </span>
              <div
                class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              >
                <button
                  v-if="clippingPlanes.length > 1"
                  class="p-1.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:text-red-300 transition-colors"
                  title="删除"
                  @click.stop="removePlane(index)"
                >
                  🗑️
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 激活切割面控制 -->
    <div
      v-if="clippingEnabled && activePlaneIndex !== null"
      class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300 shadow-lg"
    >
      <h4
        class="flex items-center gap-2 m-0 mb-4 text-sm font-semibold text-blue-100 before:content-[''] before:w-1 before:h-4 before:bg-gradient-to-b before:from-blue-400 before:to-blue-600 before:rounded-sm"
      >
        切割面 {{ activePlaneIndex + 1 }} - 参数控制
      </h4>

      <!-- 轴选择控制 -->
      <div class="flex items-center gap-4 mb-3 py-2 border-b border-white/5">
        <span class="text-xs font-medium text-gray-300 min-w-[60px]">轴向:</span>
        <div class="flex items-center gap-2">
          <button
            v-for="axis in axisArr"
            :key="axis"
            :class="[
              'px-3 py-1 rounded text-xs font-medium transition-all duration-200 border',
              currentPlaneAxis === axis
                ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                : 'bg-white/5 text-gray-400 border-white/10 hover:bg-white/10 hover:text-white'
            ]"
            @click="changeAxis(axis)"
          >
            {{ axis }}
          </button>
        </div>
      </div>

      <!-- 方向控制 -->
      <div class="flex items-center gap-4 mb-3 py-2 border-b border-white/5">
        <span class="text-xs font-medium text-gray-300 min-w-[60px]">方向:</span>
        <div class="flex items-center gap-2">
          <button
            v-for="direction in directionArr"
            :key="direction"
            :class="[
              'px-3 py-1 rounded text-xs font-medium transition-all duration-200 border',
              currentPlaneDirection === direction
                ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                : 'bg-white/5 text-gray-400 border-white/10 hover:bg-white/10 hover:text-white'
            ]"
            @click="changeDirection(direction)"
          >
            {{ direction }}
          </button>
        </div>
      </div>

      <!-- 位置控制 -->
      <div class="mb-3">
        <div class="flex justify-between items-center mb-2">
          <span class="text-xs font-medium text-gray-300">位置偏移</span>
          <span class="text-xs text-blue-400 font-mono">{{ currentPlaneDistance }} m</span>
        </div>
        <div class="flex items-center gap-3">
          <input
            v-model.number="currentPlaneDistance"
            type="range"
            :min="positionRange.min"
            :max="positionRange.max"
            :step="positionRange.step"
            class="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-blue-500/50 accent-blue-500 transition-colors"
            @input="updatePlaneDistance"
          />
          <input
            v-model.number="currentPlaneDistance"
            type="number"
            class="w-16 bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-center text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
            @input="updatePlaneDistance"
          />
        </div>
      </div>

      <!-- 旋转控制组 -->
      <div class="space-y-3 mb-3 border-t border-white/5 pt-3">
        <div
          v-for="(rot, axis) in {
            X: currentPlaneRotationX,
            Y: currentPlaneRotationY,
            Z: currentPlaneRotationZ
          }"
          :key="axis"
        >
          <div class="flex justify-between items-center mb-1">
            <span class="text-xs font-medium text-gray-300">{{ axis }}轴旋转</span>
            <span class="text-xs text-blue-400 font-mono">{{ rot }}°</span>
          </div>
          <div class="flex items-center gap-3">
            <input
              :value="rot"
              type="range"
              min="-180"
              max="180"
              step="1"
              class="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer hover:bg-blue-500/50 accent-blue-500 transition-colors"
              @input="e => updateRotation(axis, e.target.value)"
            />
            <input
              :value="rot"
              type="number"
              class="w-16 bg-black/20 border border-white/10 rounded px-2 py-1 text-xs text-center text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
              @input="e => updateRotation(axis, e.target.value)"
            />
          </div>
        </div>
      </div>

      <!-- 透明度与颜色 -->
      <div class="grid grid-cols-2 gap-4 pt-2 border-t border-white/5">
        <div>
          <span class="block text-xs font-medium text-gray-300 mb-2">透明度</span>
          <div class="flex items-center gap-2">
            <input
              v-model.number="currentPlaneOpacity"
              type="range"
              min="0"
              max="100"
              class="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-500"
              @input="updatePlaneOpacity"
            />
            <span class="text-xs text-gray-400 w-8 text-right">{{ currentPlaneOpacity }}%</span>
          </div>
        </div>
        <div>
          <span class="block text-xs font-medium text-gray-300 mb-2">颜色</span>
          <div class="flex items-center gap-2">
            <input
              v-model="currentPlaneColor"
              type="color"
              class="w-full h-6 rounded cursor-pointer bg-transparent border border-white/20"
              @change="updatePlaneColor"
            />
          </div>
        </div>
      </div>

      <!-- 重置按钮 -->
      <div class="mt-4 pt-3 border-t border-white/5">
        <button
          class="w-full py-2 rounded-md bg-white/5 text-gray-400 border border-white/10 text-xs hover:bg-white/10 hover:text-white transition-all duration-200"
          @click="resetCurrentPlane"
        >
          重置当前切割面
        </button>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div v-if="clippingEnabled" class="flex gap-3 justify-end pt-2">
      <button
        class="px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 text-xs hover:bg-red-500/20 hover:text-red-300 transition-all duration-200"
        @click="clearAllPlanes"
      >
        清除所有
      </button>
      <button
        class="px-3 py-2 rounded-md bg-white/10 text-gray-200 border border-white/20 text-xs hover:bg-white/20 hover:text-white transition-all duration-200"
        @click="resetClipping"
      >
        重置切割
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import useClipping from '../../../composables/useClipping.js'

// 使用共享组合式函数
const {
  clippingEnabled,
  clippingPlanes,
  activePlaneIndex,
  activePlaneConfig,
  polygonClippingEnabled,
  isDrawingPolygon,
  polygonDirection,
  toggleClipping,
  addClippingPlane,
  removeClippingPlane,
  setActiveClippingPlane,
  updateClippingPlaneDistance,
  updateClippingPlaneRotation,
  updateClippingPlaneOpacity,
  updateClippingPlaneColor,
  updateClippingPlaneAxis,
  updateClippingPlaneDirection,
  resetClippingPlane,
  clearAllClippingPlanes,
  resetClipping,
  togglePolygonClipping,
  toggleDrawingPolygon,
  clearAllPolygons,
  updatePolygonDirection,
  resetPolygonSettings
} = useClipping()

const setDirection = direction => {
  updatePolygonDirection(direction)
}

const resetPolygon = () => {
  resetPolygonSettings()
}

// 位置范围（根据模型大小动态调整）
const positionRange = ref({
  min: -2000,
  max: 2000,
  step: 0.5
})

// 轴和方向选项
const axisArr = ref(['X', 'Y', 'Z'])
const directionArr = ref(['正向', '反向'])

// 当前切割面参数
const currentPlaneDistance = ref(0)
const currentPlaneRotationX = ref(0)
const currentPlaneRotationY = ref(0)
const currentPlaneRotationZ = ref(0)
const currentPlaneOpacity = ref(30)
const currentPlaneColor = ref('#ffffff')
const currentPlaneAxis = ref('X')
const currentPlaneDirection = ref('正向')

// 监听激活切割面变化，更新控制参数
watch(
  activePlaneConfig,
  config => {
    if (config) {
      currentPlaneDistance.value = config.distance || 0
      currentPlaneRotationX.value = config.rotation?.x || 0
      currentPlaneRotationY.value = config.rotation?.y || 0
      currentPlaneRotationZ.value = config.rotation?.z || 0
      currentPlaneOpacity.value = (config.opacity || 0.3) * 100
      currentPlaneColor.value = config.color || '#ffffff'
      currentPlaneAxis.value = config.axis || 'X'
      currentPlaneDirection.value = config.direction || '正向'
    }
  },
  { immediate: true, deep: true }
)

// 添加新切割面
const addNewPlane = () => {
  addClippingPlane()
}

// 移除切割面
const removePlane = index => {
  removeClippingPlane(index)
}

// 设置激活切割面
const setActivePlane = index => {
  setActiveClippingPlane(index)
}

// 更新切割面距离
const updatePlaneDistance = () => {
  updateClippingPlaneDistance({
    index: activePlaneIndex.value,
    distance: Number(currentPlaneDistance.value)
  })
}

// 更新旋转参数并同步到切割面
const updateRotation = (axis, value) => {
  const val = Number(value)
  if (axis === 'X') currentPlaneRotationX.value = val
  if (axis === 'Y') currentPlaneRotationY.value = val
  if (axis === 'Z') currentPlaneRotationZ.value = val
  updatePlaneRotation()
}

// 更新切割面旋转
const updatePlaneRotation = () => {
  updateClippingPlaneRotation({
    index: activePlaneIndex.value,
    rotationX: Number(currentPlaneRotationX.value),
    rotationY: Number(currentPlaneRotationY.value),
    rotationZ: Number(currentPlaneRotationZ.value)
  })
}

// 更新切割面透明度
const updatePlaneOpacity = () => {
  updateClippingPlaneOpacity({
    index: activePlaneIndex.value,
    opacity: currentPlaneOpacity.value / 100
  })
}

// 更新切割面颜色
const updatePlaneColor = () => {
  updateClippingPlaneColor({
    index: activePlaneIndex.value,
    color: currentPlaneColor.value
  })
}

// 改变轴
const changeAxis = axis => {
  currentPlaneAxis.value = axis
  updateClippingPlaneAxis({
    index: activePlaneIndex.value,
    axis
  })
}

// 改变方向
const changeDirection = direction => {
  currentPlaneDirection.value = direction
  updateClippingPlaneDirection({
    index: activePlaneIndex.value,
    direction
  })
}

// 重置当前切割面
const resetCurrentPlane = () => {
  currentPlaneDistance.value = 0
  currentPlaneRotationX.value = 0
  currentPlaneRotationY.value = 0
  currentPlaneRotationZ.value = 0
  currentPlaneOpacity.value = 0
  currentPlaneColor.value = '#ffffff'

  resetClippingPlane(activePlaneIndex.value)
}

// 清除所有切割面
const clearAllPlanes = () => {
  clearAllClippingPlanes()
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
