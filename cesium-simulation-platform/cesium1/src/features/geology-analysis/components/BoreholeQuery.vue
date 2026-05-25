<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      钻孔查询
    </div>
    <div class="mb-2">
      <div class="flex items-center gap-2">
        <select
          v-model="selectedBoreholeId"
          class="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
        >
          <option value="">选择钻孔编号</option>
          <option v-for="borehole in boreholes" :key="borehole.id" :value="borehole.id">
            {{ borehole.name }}
          </option>
        </select>
        <button
          class="px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
          :disabled="!selectedBoreholeId"
          @click="queryBoreholeInfo"
        >
          查询
        </button>
      </div>
    </div>

    <div
      v-if="currentBorehole"
      class="mt-3 bg-black/20 p-3 rounded-md border-l-[3px] border-blue-500 shadow-inner"
    >
      <div class="flex justify-between items-center mb-1 text-xs">
        <span class="text-gray-400">孔深:</span>
        <span class="text-gray-200 font-mono">{{ currentBorehole.depth }}m</span>
      </div>
      <div class="flex justify-between items-center mb-1 text-xs">
        <span class="text-gray-400">方位:</span>
        <span class="text-gray-200 font-mono">{{ currentBorehole.azimuth }}°</span>
      </div>
      <div class="flex justify-between items-center text-xs">
        <span class="text-gray-400">倾角:</span>
        <span class="text-gray-200 font-mono">{{ currentBorehole.dip }}°</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import useGeologyAnalysis from '../services/useGeologyAnalysis.js'

const { boreholes, showBoreholeDetails } = useGeologyAnalysis()

const selectedBoreholeId = ref('')
const currentBorehole = ref(null)

const queryBoreholeInfo = () => {
  if (!selectedBoreholeId.value) {
    currentBorehole.value = null
    return
  }

  const found = boreholes.value.find(b => b.id === selectedBoreholeId.value)
  currentBorehole.value = found || null

  if (found) {
    showBoreholeDetails(found.id)
  }
}
</script>
