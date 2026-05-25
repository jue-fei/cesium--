<template>
  <div
    class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div class="flex items-center justify-between mb-3 pb-2 border-b border-white/10">
      <span
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
      >
        🚛 矿卡实时信息
      </span>
      <div class="flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
        <span class="text-[10px] text-gray-500 font-mono">{{ currentTimeStr }}</span>
      </div>
    </div>

    <div class="flex flex-col gap-2 mb-3 max-h-[400px] overflow-y-auto custom-scrollbar">
      <div
        v-for="truck in truckStates"
        :key="truck.truckId"
        class="rounded p-3 cursor-pointer transition-all border"
        :class="
          selectedTruckId === truck.truckId
            ? 'bg-blue-500/15 border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.1)]'
            : 'bg-black/20 border-transparent hover:bg-white/5 hover:border-white/10'
        "
        @click="selectTruck(truck.truckId)"
      >
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span
              class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
              :class="getTruckIconBg(truck.status)"
            >
              {{ getTruckEmoji(truck.status) }}
            </span>
            <span class="text-xs font-semibold text-gray-100">{{ truck.truckName }}</span>
            <span
              v-if="truck.engineTemp > 95 || truck.fuelLevel < 30"
              class="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse"
              title="需要关注"
            ></span>
          </div>
          <span
            class="px-2 py-0.5 rounded-full text-[10px] font-medium"
            :class="getStatusClass(truck.status)"
          >
            {{ truck.status }}
          </span>
        </div>

        <div class="flex flex-col gap-1.5 mb-2">
          <div class="flex justify-between text-[11px]">
            <span class="text-gray-500">驾驶员</span>
            <span class="text-gray-300">{{ truck.driver }}</span>
          </div>
          <div class="flex justify-between text-[11px]">
            <span class="text-gray-500">矿物类型</span>
            <span :style="{ color: truck.mineralType?.color }">{{
              truck.mineralType?.name || '未知'
            }}</span>
          </div>

          <div class="flex flex-col gap-0.5">
            <div class="flex justify-between text-[11px]">
              <span class="text-gray-500">当前载重</span>
              <span class="text-orange-400">
                {{ Math.round(truck.payload) }}/{{ Math.round(truck.capacity) }} 吨
                <span class="text-gray-500 text-[10px]"
                  >({{ Math.round(truck.payloadPercent) }}%)</span
                >
              </span>
            </div>
            <div class="w-full h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="getPayloadBarClass(truck.payloadPercent)"
                :style="{ width: Math.min(truck.payloadPercent, 100) + '%' }"
              ></div>
            </div>
          </div>

          <div class="flex justify-between text-[11px]">
            <span class="text-gray-500">速度 / 方向</span>
            <span class="text-gray-300">{{ truck.speed }} km/h · {{ truck.heading }}°</span>
          </div>
          <div class="flex justify-between text-[11px]">
            <span class="text-gray-500">当前位置</span>
            <span class="text-gray-300 truncate max-w-[130px] text-right">{{
              truck.location
            }}</span>
          </div>
        </div>

        <div class="flex justify-around pt-2 border-t border-white/10">
          <div class="flex items-center gap-1 text-[11px]">
            <span class="text-xs">🌡️</span>
            <span :class="truck.engineTemp > 95 ? 'text-red-400' : 'text-green-400'">
              {{ Math.round(truck.engineTemp) }}°C
            </span>
          </div>
          <div class="flex items-center gap-1.5 text-[11px]">
            <span class="text-xs">⛽</span>
            <div class="flex items-center gap-1">
              <div class="w-10 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-500"
                  :class="getFuelBarClass(truck.fuelLevel)"
                  :style="{ width: truck.fuelLevel + '%' }"
                ></div>
              </div>
              <span :class="truck.fuelLevel < 30 ? 'text-red-400' : 'text-green-400'">
                {{ Math.round(truck.fuelLevel) }}%
              </span>
            </div>
          </div>
          <div class="flex items-center gap-1 text-[11px]">
            <span class="text-xs">🔄</span>
            <span class="text-gray-300">第{{ truck.cycleCount }}趟</span>
          </div>
        </div>
      </div>

      <div v-if="truckStates.length === 0" class="text-center py-6 text-xs text-gray-500">
        🚫 暂无矿卡数据
      </div>
    </div>

    <div class="pt-3 border-t border-white/10">
      <div class="text-xs font-medium text-blue-100 mb-2">📊 运输统计</div>
      <div class="grid grid-cols-2 gap-2">
        <div class="bg-black/20 rounded p-2.5 text-center border border-white/5">
          <div class="text-sm font-semibold text-green-400">{{ totalTrucks }}</div>
          <div class="text-[10px] text-gray-500">运行矿卡</div>
        </div>
        <div class="bg-black/20 rounded p-2.5 text-center border border-white/5">
          <div class="text-sm font-semibold" :class="efficiencyColor">{{ efficiencyPercent }}%</div>
          <div class="text-[10px] text-gray-500">运载效率</div>
        </div>
        <div class="bg-black/20 rounded p-2.5 text-center border border-white/5">
          <div class="text-sm font-semibold text-blue-400">{{ totalPayload }} 吨</div>
          <div class="text-[10px] text-gray-500">总载重 / {{ totalCapacity }} 吨</div>
        </div>
        <div class="bg-black/20 rounded p-2.5 text-center border border-white/5">
          <div class="text-sm font-semibold text-cyan-400">{{ avgSpeed }} km/h</div>
          <div class="text-[10px] text-gray-500">平均速度</div>
        </div>
      </div>

      <div class="mt-2 bg-black/20 rounded p-2.5 text-center border border-white/5">
        <div class="flex items-center justify-center gap-2">
          <span class="text-xs font-semibold text-purple-400">{{ totalCycles }}</span>
          <span class="text-[10px] text-gray-500">累计完成趟次</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  truckStates: {
    type: Array,
    default: () => []
  },
  selectedTruckId: {
    type: String,
    default: null
  },
  currentTime: {
    type: Number,
    default: Date.now()
  }
})

const emit = defineEmits(['selectTruck'])

const currentTimeStr = computed(() => {
  const date = new Date(props.currentTime)
  return date.toLocaleTimeString('zh-CN')
})

const totalTrucks = computed(() => props.truckStates.length)

const totalPayload = computed(() => {
  return Math.round(props.truckStates.reduce((sum, truck) => sum + (truck.payload || 0), 0))
})

const totalCapacity = computed(() => {
  return Math.round(props.truckStates.reduce((sum, truck) => sum + (truck.capacity || 0), 0))
})

const avgSpeed = computed(() => {
  if (props.truckStates.length === 0) return 0
  const totalSpeed = props.truckStates.reduce((sum, truck) => sum + (truck.speed || 0), 0)
  return Math.round((totalSpeed / props.truckStates.length) * 10) / 10
})

const totalCycles = computed(() => {
  return props.truckStates.reduce((sum, truck) => sum + (truck.cycleCount || 0), 0)
})

const efficiencyPercent = computed(() => {
  if (totalCapacity.value === 0) return 0
  return Math.round((totalPayload.value / totalCapacity.value) * 100)
})

const efficiencyColor = computed(() => {
  const pct = efficiencyPercent.value
  if (pct >= 80) return 'text-red-400'
  if (pct >= 50) return 'text-orange-400'
  if (pct >= 20) return 'text-yellow-400'
  return 'text-green-400'
})

const STATUS_MAP = {
  装载中: {
    cls: 'bg-green-500/20 text-green-400 border border-green-500/30',
    bg: 'bg-green-500/20 text-green-400',
    emoji: '⛏️'
  },
  重载运输: {
    cls: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
    bg: 'bg-orange-500/20 text-orange-400',
    emoji: '🚛'
  },
  卸载中: {
    cls: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    bg: 'bg-blue-500/20 text-blue-400',
    emoji: '📤'
  },
  空载返程: {
    cls: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
    bg: 'bg-gray-500/20 text-gray-400',
    emoji: '↩️'
  }
}
const FALLBACK = STATUS_MAP['空载返程']

const getStatusClass = s => (STATUS_MAP[s] || FALLBACK).cls
const getTruckIconBg = s => (STATUS_MAP[s] || FALLBACK).bg
const getTruckEmoji = s => (STATUS_MAP[s] || FALLBACK).emoji

const getPayloadBarClass = p =>
  p >= 90 ? 'bg-red-500' : p >= 70 ? 'bg-orange-500' : p >= 40 ? 'bg-yellow-500' : 'bg-green-500'
const getFuelBarClass = f => (f < 30 ? 'bg-red-500' : f < 50 ? 'bg-orange-500' : 'bg-green-500')
const selectTruck = truckId => emit('selectTruck', truckId)
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.02);
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.15);
}
</style>
