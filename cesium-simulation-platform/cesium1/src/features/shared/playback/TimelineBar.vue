<template>
  <div class="bg-white/5 rounded-lg border border-white/5 px-3 py-2 flex items-center gap-2">
    <span
      v-if="title"
      class="text-[10px] text-blue-100 font-semibold flex items-center gap-1.5 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm whitespace-nowrap"
      >{{ title }}</span
    >
    <button
      class="w-6 h-6 flex-none rounded-full bg-blue-500/20 border border-blue-400/40 text-blue-200 text-[10px] flex items-center justify-center hover:bg-blue-500/30"
      :title="playing ? '暂停' : '播放（在末端则从头播）'"
      @click="toggle"
    >
      {{ playing ? '❚❚' : '▶' }}
    </button>
    <input
      ref="sliderEl"
      :value="sliderValue"
      type="range"
      min="0"
      max="1000"
      class="flex-1 h-1.5 accent-blue-400 cursor-pointer"
      :aria-label="`${title}进度`"
      @input="onSlide"
    />
    <select
      v-model.number="speed"
      class="text-[10px] bg-white/5 border border-white/10 rounded text-gray-300 py-0.5"
      title="回放倍速"
      @change="timelineBus.setSpeed(speed)"
    >
      <option :value="1">1x</option>
      <option :value="2">2x</option>
      <option :value="4">4x</option>
      <option :value="8">8x</option>
    </select>
    <span class="text-[10px] text-gray-300 font-mono whitespace-nowrap tabular-nums">{{
      timeText
    }}</span>
    <button
      class="text-[10px] text-gray-400 hover:text-blue-200 px-1.5 py-0.5 rounded border border-white/10 whitespace-nowrap"
      title="跳到当前（末端=实时）"
      @click="timelineBus.seek(timelineBus.getState().end)"
    >
      现在
    </button>
  </div>
</template>

<script setup>
/**
 * TimelineBar.vue —— 4D 统一播放控制条（绑定全局时间总线）
 *
 * 所有挂载点（设备层 MonitoringPanel / 品位层 GeologyPanel / …）共享同一
 * timelineBus 单例：任一处拖动/播放，所有图层与控制条同步跳转同一时刻。
 * 设备层回放经 bus 订阅桥接 useMonitoring.handleTimelineTimeChange（已有
 * isHistoricalPlayback 机制，末端自动回 live）；品位层中段推进由
 * gradeLayerService.setTimelineProgress 消费。
 */
defineOptions({ name: 'TimelineBar' })
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { timelineBus } from './timelineController.js'

const props = defineProps({
  title: { type: String, default: '4D 时间轴' },
  /** 首次挂载且总线无窗口时的默认回放窗口（分钟，回看时长） */
  windowMinutes: { type: Number, default: 5 }
})

const sliderEl = ref(null)
const playing = ref(false)
const sliderValue = ref(1000)
const speed = ref(1)
const ts = ref(0)

const timeText = computed(() => {
  if (!Number.isFinite(ts.value) || ts.value <= 0) return '--:--:--'
  const d = new Date(ts.value)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

function onSlide(e) {
  sliderValue.value = Number(e.target.value)
  const { start, end } = timelineBus.getState()
  if (end > start) timelineBus.seek(start + (sliderValue.value / 1000) * (end - start))
}

function toggle() {
  playing.value ? timelineBus.pause() : timelineBus.play()
}

function syncFromBus(state) {
  playing.value = state.playing
  ts.value = state.ts
  // 滑杆正被拖动时不回写（以用户输入为准），松手后恢复总线同步
  if (sliderEl.value !== document.activeElement) {
    sliderValue.value = Math.round(state.progress * 1000)
  }
}

let unsub = null

onMounted(() => {
  const s = timelineBus.getState()
  if (!(s.end > s.start)) {
    const now = Date.now()
    timelineBus.setWindow(now - props.windowMinutes * 60000, now)
  }
  unsub = timelineBus.on(syncFromBus)
  syncFromBus(timelineBus.getState())
})

onBeforeUnmount(() => {
  if (unsub) unsub()
  unsub = null
})
</script>
