<template>
  <div
    class="bg-white/5 rounded-lg p-4 mb-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      地质统计
    </div>
    <div class="grid grid-cols-2 gap-2">
      <div
        v-for="stat in stats"
        :key="stat.id"
        class="bg-white/5 border border-white/10 rounded-md p-2.5 flex items-center gap-2 hover:bg-white/10 transition-colors"
      >
        <div class="text-lg opacity-80">{{ stat.icon }}</div>
        <div class="flex flex-col">
          <div class="text-sm font-semibold text-gray-100 leading-none mb-0.5">
            {{ stat.value
            }}<span class="text-[10px] text-gray-400 ml-0.5 font-normal">{{ stat.unit }}</span>
          </div>
          <div class="text-[10px] text-gray-400">{{ stat.label }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  stats: {
    type: Array,
    default: () => []
  }
})
</script>
