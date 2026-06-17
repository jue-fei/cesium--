<template>
  <div
    class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300 select-none"
    tabindex="0"
    @keydown="handleKeydown"
  >
    <div class="flex items-center justify-between mb-2">
      <span
        class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
      >
        🎞️ 时间轴回放
      </span>
      <div class="flex items-center gap-2">
        <button
          v-if="isOffLive && hasValidRange"
          class="px-2 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 text-[10px] hover:bg-blue-500/30 transition-all flex items-center gap-1"
          title="返回实时"
          @click="goLive"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          返回实时
        </button>
        <span v-if="isLoading" class="text-xs text-gray-500 animate-pulse">加载中…</span>
        <span v-else-if="!hasValidRange" class="text-xs text-gray-500">无数据</span>
        <span v-else class="text-base font-semibold text-green-400 font-mono">{{
          currentTimeStr
        }}</span>
      </div>
    </div>

    <!-- 无数据提示 -->
    <div v-if="!hasValidRange" class="py-6 flex flex-col items-center justify-center text-gray-500">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        class="mb-2 opacity-50"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span class="text-xs">暂无历史回放数据</span>
      <span class="text-[10px] text-gray-600 mt-1">开始监控后将自动记录时间轴</span>
    </div>

    <template v-else>
      <!-- 进度条 + 时间刻度 -->
      <div class="mb-1">
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-gray-500 min-w-[60px] text-center">{{ startTimeStr }}</span>
          <div class="flex-1 relative">
            <input
              type="range"
              class="w-full h-2 bg-black/30 rounded-lg outline-none cursor-pointer accent-blue-500 relative z-10"
              :min="startTime"
              :max="endTime"
              :value="currentTime"
              @input="handleSliderInput"
              @change="handleSliderChange"
            />
            <!-- 刻度标记 -->
            <div class="relative h-3 mt-0.5">
              <div
                v-for="(tick, i) in timeTicks"
                :key="i"
                class="absolute top-0 flex flex-col items-center"
                :style="{ left: tick.position + '%' }"
              >
                <div class="w-px h-1 bg-white/10"></div>
                <span
                  class="text-[9px] text-gray-600 mt-0.5 whitespace-nowrap transform -translate-x-1/2"
                >
                  {{ tick.label }}
                </span>
              </div>
            </div>
          </div>
          <span class="text-[10px] text-gray-500 min-w-[60px] text-center">{{ endTimeStr }}</span>
        </div>
      </div>

      <!-- 控制按钮 -->
      <div class="flex items-center gap-2 flex-wrap mb-3 mt-4">
        <button
          class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
          title="跳到开始 (Home)"
          :disabled="!hasValidRange"
          @click="skipToStart"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="1 4 1 20" />
            <polygon points="7 12 23 4 23 20 7 12" />
          </svg>
        </button>
        <button
          class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
          title="后退10秒 (←)"
          :disabled="!hasValidRange"
          @click="stepBackward"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="19 20 9 12 19 4 19 20" />
            <line x1="5" y1="19" x2="5" y2="5" />
          </svg>
        </button>
        <button
          class="w-12 h-11 rounded transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
          :class="
            isPlaying
              ? 'bg-orange-500/20 border border-orange-500/30 text-white hover:bg-orange-500/30'
              : 'bg-green-500/20 border border-green-500/30 text-white hover:bg-green-500/30'
          "
          :title="isPlaying ? '暂停 (空格)' : '播放 (空格)'"
          :disabled="!hasValidRange"
          @click="togglePlay"
        >
          <svg
            v-if="!isPlaying"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <svg
            v-else
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
          >
            <rect x="4" y="4" width="6" height="16" rx="1" />
            <rect x="14" y="4" width="6" height="16" rx="1" />
          </svg>
        </button>
        <button
          class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
          title="前进10秒 (→)"
          :disabled="!hasValidRange"
          @click="stepForward"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="5 4 15 12 5 20 5 4" />
            <line x1="19" y1="5" x2="19" y2="19" />
          </svg>
        </button>
        <button
          class="w-9 h-9 bg-white/5 border-white/10 text-white text-sm hover:bg-white/10 rounded border transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
          title="跳到结束 (End)"
          :disabled="!hasValidRange"
          @click="skipToEnd"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="17 12 1 4 1 20 17 12" />
            <polyline points="23 4 23 20" />
          </svg>
        </button>

        <div class="flex items-center gap-1.5 ml-auto">
          <label class="text-[10px] text-gray-500">速度:</label>
          <select
            v-model="playSpeed"
            class="px-2 py-1 rounded bg-white/5 border border-white/10 text-white text-[11px] cursor-pointer disabled:opacity-30"
            :disabled="!hasValidRange"
            @change="handleSpeedChange"
          >
            <option v-for="s in [0.5, 1, 2, 5, 10]" :key="s" :value="s">{{ s }}x</option>
          </select>
        </div>
        <label class="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
          <input
            v-model="loop"
            type="checkbox"
            class="w-3.5 h-3.5 accent-blue-500"
            :disabled="!hasValidRange"
          />
          循环
        </label>
      </div>

      <!-- 统计信息 -->
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
        <div class="flex flex-col items-center gap-0.5">
          <span class="text-[10px] text-gray-500">总时长</span>
          <span class="text-xs font-semibold text-gray-300">{{ totalDurationStr }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'

const props = defineProps({
  startTime: { type: Number, required: true },
  endTime: { type: Number, required: true },
  initialTime: { type: Number, default: null },
  dataSourceMode: { type: String, default: 'external' },
  isLoading: { type: Boolean, default: false }
})

const emit = defineEmits(['timeChange', 'playStateChange', 'speedChange'])

const currentTime = ref(props.initialTime || props.startTime)
const isPlaying = ref(false)
const playSpeed = ref(1)
const loop = ref(false)

let animationFrameId = null
let lastFrameTime = null

const MIN_VALID_RANGE_MS = 1000

const hasValidRange = computed(() => props.endTime - props.startTime >= MIN_VALID_RANGE_MS)

const fmtPad = (n, len = 2) => String(n).padStart(len, '0')

const needsDate = computed(() => {
  const s = new Date(props.startTime)
  const e = new Date(props.endTime)
  return (
    s.getFullYear() !== e.getFullYear() ||
    s.getMonth() !== e.getMonth() ||
    s.getDate() !== e.getDate()
  )
})

const fmtTime = ts => {
  const d = new Date(ts)
  const hms = `${fmtPad(d.getHours())}:${fmtPad(d.getMinutes())}:${fmtPad(d.getSeconds())}`
  if (needsDate.value) {
    return `${fmtPad(d.getMonth() + 1)}-${fmtPad(d.getDate())} ${hms}`
  }
  return hms
}

const fmtDur = ms => {
  const abs = Math.max(0, Math.abs(ms))
  const s = Math.floor(abs / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${fmtPad(m)}:${fmtPad(sec)}`
  return `${m}:${fmtPad(sec)}`
}

const currentTimeStr = computed(() => fmtTime(currentTime.value))
const startTimeStr = computed(() => fmtTime(props.startTime))
const endTimeStr = computed(() => fmtTime(props.endTime))

const totalRange = computed(() => Math.max(props.endTime - props.startTime, 1))

const progressPercent = computed(() => {
  if (!hasValidRange.value) return 0
  return Math.round(((currentTime.value - props.startTime) / totalRange.value) * 100)
})

const elapsedStr = computed(() => fmtDur(currentTime.value - props.startTime))
const remainingStr = computed(() => fmtDur(props.endTime - currentTime.value))
const totalDurationStr = computed(() => fmtDur(totalRange.value))

// 时间刻度
const timeTicks = computed(() => {
  if (!hasValidRange.value) return []
  const count = 4
  const ticks = []
  for (let i = 1; i < count; i++) {
    const ratio = i / count
    const ts = props.startTime + totalRange.value * ratio
    ticks.push({
      position: ratio * 100,
      label: fmtTime(ts)
    })
  }
  return ticks
})

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
  if (!hasValidRange.value) return
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

function handleSliderInput(e) {
  if (!hasValidRange.value) return
  emitTime(parseInt(e.target.value))
}

function handleSliderChange() {
  // 拖拽结束，确保状态同步
  if (isPlaying.value) {
    lastFrameTime = null
  }
}

function handleSpeedChange() {
  playSpeed.value = Number(playSpeed.value) || 1
  emit('speedChange', playSpeed.value)
}

function skipToStart() {
  if (!hasValidRange.value) return
  pauseIfPlaying()
  emitTime(props.startTime)
}

function skipToEnd() {
  if (!hasValidRange.value) return
  pauseIfPlaying()
  emitTime(props.endTime)
}

function stepBackward() {
  if (!hasValidRange.value) return
  emitTime(Math.max(props.startTime, currentTime.value - 10000))
}

function stepForward() {
  if (!hasValidRange.value) return
  emitTime(Math.min(props.endTime, currentTime.value + 10000))
}

function pauseIfPlaying() {
  if (isPlaying.value) {
    isPlaying.value = false
    emit('playStateChange', false)
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }
}

// 键盘快捷键
function handleKeydown(e) {
  if (!hasValidRange.value) return
  switch (e.key) {
    case ' ':
    case 'k':
      e.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      e.preventDefault()
      stepBackward()
      break
    case 'ArrowRight':
      e.preventDefault()
      stepForward()
      break
    case 'Home':
      e.preventDefault()
      skipToStart()
      break
    case 'End':
      e.preventDefault()
      skipToEnd()
      break
    case 'j':
      e.preventDefault()
      emitTime(Math.max(props.startTime, currentTime.value - 5000))
      break
    case 'l':
      e.preventDefault()
      emitTime(Math.min(props.endTime, currentTime.value + 5000))
      break
  }
}

const isOffLive = computed(() => {
  if (!hasValidRange.value) return false
  return Math.abs(currentTime.value - props.endTime) > 1500
})

function goLive() {
  if (!hasValidRange.value) return
  pauseIfPlaying()
  emitTime(props.endTime)
}

defineExpose({
  setTime: t => emitTime(clamp(t)),
  play: () => {
    if (!isPlaying.value && hasValidRange.value) togglePlay()
  },
  pause: () => {
    if (isPlaying.value) togglePlay()
  }
})

watch(
  () => props.initialTime,
  t => {
    if (t == null) return
    currentTime.value = clamp(t)
  }
)

watch(
  () => [props.startTime, props.endTime],
  ([, newEnd]) => {
    currentTime.value = clamp(currentTime.value)
    // 如果当前在播放且范围变化导致越界，暂停
    if (isPlaying.value && currentTime.value >= newEnd) {
      pauseIfPlaying()
    }
  }
)

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
})
</script>
