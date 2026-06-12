<template>
  <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
    <div class="flex items-center justify-between mb-2">
      <span
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">🎞️
        时间轴回放</span>
      <div class="flex items-center gap-2">
        <button v-if="isOffLive"
          class="px-2 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 text-[10px] hover:bg-blue-500/30 transition-all flex items-center gap-1"
          title="返回实时" @click="goLive">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          返回实时
        </button>
        <span class="text-base font-semibold text-green-400 font-mono">{{ currentTimeStr }}</span>
      </div>
    </div>

    <div class="flex items-center gap-2 mb-3">
      <span class="text-[10px] text-gray-500 min-w-[50px] text-center">{{ startTimeStr }}</span>
      <input type="range" class="flex-1 h-2 bg-black/30 rounded-lg outline-none cursor-pointer accent-blue-500"
        :min="startTime" :max="endTime" :value="currentTime" @input="handleSliderChange" />
      <span class="text-[10px] text-gray-500 min-w-[50px] text-center">{{ endTimeStr }}</span>
    </div>

    <div class="flex items-center gap-2 flex-wrap mb-3">
      <button
        class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center"
        title="跳到开始" @click="skipToStart">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 20" />
          <polygon points="7 12 23 4 23 20 7 12" />
        </svg>
      </button>
      <button
        class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center"
        title="后退10秒" @click="stepBackward">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="19 20 9 12 19 4 19 20" />
          <line x1="5" y1="19" x2="5" y2="5" />
        </svg>
      </button>
      <button class="w-12 h-11 rounded transition-all flex items-center justify-center" :class="isPlaying
        ? 'bg-orange-500/20 border border-orange-500/30 text-white hover:bg-orange-500/30'
        : 'bg-green-500/20 border border-green-500/30 text-white hover:bg-green-500/30'
        " :title="isPlaying ? '暂停' : '播放'" @click="togglePlay">
        <svg v-if="!isPlaying" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
          fill="currentColor" stroke="none">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
          stroke="none">
          <rect x="4" y="4" width="6" height="16" rx="1" />
          <rect x="14" y="4" width="6" height="16" rx="1" />
        </svg>
      </button>
      <button
        class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center"
        title="前进10秒" @click="stepForward">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 4 15 12 5 20 5 4" />
          <line x1="19" y1="5" x2="19" y2="19" />
        </svg>
      </button>
      <button
        class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center"
        title="跳到结束" @click="skipToEnd">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="17 12 1 4 1 20 17 12" />
          <polyline points="23 4 23 20" />
        </svg>
      </button>

      <div class="flex items-center gap-1.5 ml-auto">
        <label class="text-[10px] text-gray-500">速度:</label>
        <select v-model="playSpeed"
          class="px-2 py-1 rounded bg-white/5 border border-white/10 text-white text-[11px] cursor-pointer"
          @change="handleSpeedChange">
          <option v-for="s in [0.5, 1, 2, 5, 10]" :key="s" :value="s">{{ s }}x</option>
        </select>
      </div>
      <label class="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
        <input v-model="loop" type="checkbox" class="w-3.5 h-3.5 accent-blue-500" />
        循环
      </label>
    </div>

    <div class="flex justify-around pt-2 border-t border-white/10">
      <div class="flex flex-col items-center gap-0.5">
        <span class="text-[10px] text-gray-500">进度</span>
        <span class="text-xs font-semibold text-gray-300">{{ progressPercent }}%</span>
      </div>
      <div class="flex flex-col items-center gap-0.5">
        <span class="text-[10px] text-gray-500">已播放</span>
        <span class="text-xs font-semibold text-gray-300">{{ elapsedStr }}</span>
      </div>
      <div class="flex flex-col items-center gap-0.5">
        <span class="text-[10px] text-gray-500">剩余</span>
        <span class="text-xs font-semibold text-gray-300">{{ remainingStr }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'

const props = defineProps({
  startTime: { type: Number, required: true },
  endTime: { type: Number, required: true },
  initialTime: { type: Number, default: null },
  dataSourceMode: { type: String, default: 'external' }
})

const emit = defineEmits(['timeChange', 'playStateChange', 'speedChange'])

const currentTime = ref(props.initialTime || props.startTime)
const isPlaying = ref(false)
const playSpeed = ref(1)
const loop = ref(false)

let animationFrameId = null
let lastFrameTime = null

const fmtPad = (n, len = 2) => String(n).padStart(len, '0')
const fmtTime = ts => {
  const d = new Date(ts)
  return `${fmtPad(d.getHours())}:${fmtPad(d.getMinutes())}:${fmtPad(d.getSeconds())}`
}
const fmtDur = ms => {
  const abs = Math.abs(ms)
  const s = Math.floor(abs / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${fmtPad(m)}:${fmtPad(s % 60)}` : `${m}:${fmtPad(s % 60)}`
}

const currentTimeStr = computed(() => fmtTime(currentTime.value))
const startTimeStr = computed(() => fmtTime(props.startTime))
const endTimeStr = computed(() => fmtTime(props.endTime))

const totalRange = computed(() => Math.max(props.endTime - props.startTime, 1))

const progressPercent = computed(() => {
  return Math.round(((currentTime.value - props.startTime) / totalRange.value) * 100)
})

const elapsedStr = computed(() => fmtDur(currentTime.value - props.startTime))
const remainingStr = computed(() => fmtDur(props.endTime - currentTime.value))

const clamp = t => Math.max(props.startTime, Math.min(props.endTime, t ?? props.startTime))

function emitTime(t) {
  currentTime.value = t
  emit('timeChange', t)
}

function playAnimation(ts) {
  if (!isPlaying.value) return
  if (lastFrameTime === null) lastFrameTime = ts
  const dt = ts - lastFrameTime
  lastFrameTime = ts

  let nt = currentTime.value + dt * playSpeed.value
  if (nt >= props.endTime) {
    if (loop.value) {
      nt = props.startTime + ((nt - props.endTime) % totalRange.value)
    } else {
      nt = props.endTime
      isPlaying.value = false
      emit('playStateChange', false)
    }
  }
  emitTime(nt)
  if (isPlaying.value) {
    animationFrameId = requestAnimationFrame(playAnimation)
  }
}

function togglePlay() {
  if (!isPlaying.value && currentTime.value >= props.endTime && !loop.value) {
    emitTime(props.startTime)
  }
  isPlaying.value = !isPlaying.value
  emit('playStateChange', isPlaying.value)
  if (isPlaying.value) {
    lastFrameTime = null
    animationFrameId = requestAnimationFrame(playAnimation)
  } else if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
}

function handleSliderChange(e) {
  emitTime(parseInt(e.target.value))
}
function handleSpeedChange() {
  playSpeed.value = Number(playSpeed.value) || 1
  emit('speedChange', playSpeed.value)
}
function skipToStart() {
  if (isPlaying.value) {
    isPlaying.value = false
    emit('playStateChange', false)
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }
  emitTime(props.startTime)
}
function skipToEnd() {
  if (isPlaying.value && !loop.value) {
    isPlaying.value = false
    emit('playStateChange', false)
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }
  emitTime(props.endTime)
}
function stepBackward() {
  emitTime(Math.max(props.startTime, currentTime.value - 10000))
}
function stepForward() {
  emitTime(Math.min(props.endTime, currentTime.value + 10000))
}

defineExpose({
  setTime: t => emitTime(clamp(t)),
  play: () => {
    if (!isPlaying.value) togglePlay()
  },
  pause: () => {
    if (isPlaying.value) togglePlay()
  }
})

const isOffLive = computed(() => {
  return Math.abs(currentTime.value - props.endTime) > 1500
})

function goLive() {
  emitTime(props.endTime)
}

watch(
  () => props.initialTime,
  t => {
    if (t == null) return
    currentTime.value = clamp(t)
  }
)

watch(
  () => [props.startTime, props.endTime],
  () => {
    currentTime.value = clamp(currentTime.value)
  }
)

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
})
</script>
