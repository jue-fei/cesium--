<template>
  <div
    class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      实时运营指标
    </div>
    <div class="grid grid-cols-2 gap-2">
      <div
        class="bg-white/5 border border-white/10 rounded-md p-2.5 flex items-center gap-2 hover:bg-white/10 transition-colors"
      >
        <div class="text-lg opacity-80">🚛</div>
        <div class="flex flex-col">
          <div class="text-sm font-semibold text-gray-100 leading-none mb-0.5">
            {{ metrics.onlineCount }}
          </div>
          <div class="text-[10px] text-gray-400">在线设备</div>
        </div>
      </div>
      <div
        class="border rounded-md p-2.5 flex items-center gap-2 transition-colors"
        :class="
          metrics.warningCount > 0
            ? 'bg-yellow-500/10 border-yellow-500/30 hover:bg-yellow-500/20'
            : 'bg-white/5 border-white/10 hover:bg-white/10'
        "
      >
        <div class="text-lg opacity-80">⚠️</div>
        <div class="flex flex-col">
          <div
            class="text-sm font-semibold leading-none mb-0.5"
            :class="metrics.warningCount > 0 ? 'text-yellow-400' : 'text-gray-100'"
          >
            {{ metrics.warningCount }}
          </div>
          <div class="text-[10px] text-gray-400">预警设备</div>
        </div>
      </div>
      <div
        class="bg-white/5 border border-white/10 rounded-md p-2.5 flex items-center gap-2 hover:bg-white/10 transition-colors"
      >
        <div class="text-lg opacity-80">⚡</div>
        <div class="flex flex-col">
          <div class="text-sm font-semibold text-gray-100 leading-none mb-0.5">
            {{ metrics.averageSpeed
            }}<span class="text-[10px] text-gray-400 ml-0.5 font-normal">km/h</span>
          </div>
          <div class="text-[10px] text-gray-400">平均速度</div>
        </div>
      </div>
      <div
        class="bg-blue-500/10 border border-blue-500/30 rounded-md p-2.5 flex items-center gap-2 hover:bg-blue-500/20 transition-colors"
      >
        <div class="text-lg opacity-80">📊</div>
        <div class="flex flex-col">
          <div class="text-sm font-semibold text-blue-300 leading-none mb-0.5">
            {{ metrics.throughputTph
            }}<span class="text-[10px] text-blue-400/70 ml-0.5 font-normal">t/h</span>
          </div>
          <div class="text-[10px] text-gray-400">吞吐量</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '实时运营指标' })

defineProps({
  metrics: {
    type: Object,
    default: () => ({
      onlineCount: 0,
      warningCount: 0,
      loadedCount: 0,
      averageSpeed: 0,
      throughputTph: 0
    })
  }
})
</script>
