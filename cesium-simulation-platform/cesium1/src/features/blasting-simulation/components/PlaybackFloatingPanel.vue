<template>
  <!-- Teleport 到 body：脱离 el-card 的 overflow-hidden/backdrop-filter 祖先，
       否则 position:fixed 会被其约束并被裁剪，导致拖出面板时消失 -->
  <teleport to="body">
    <!-- 收起态：紧凑胶囊条 -->
    <div
      v-if="collapsed"
      class="pf-pill"
      :style="{ top: pos.y + 'px', left: pos.x + 'px' }"
      @mousedown="onDragStart"
    >
      <!-- 迷你进度环（兼播放/暂停） -->
      <button
        class="pf-pill-play"
        :disabled="!dataset"
        :title="isPlaying ? '暂停' : '播放'"
        @mousedown.stop
        @click.stop="$emit('toggle-playback')"
      >
        <svg class="pf-ring-svg" viewBox="0 0 36 36">
          <circle class="pf-ring-track" cx="18" cy="18" r="15" />
          <circle
            class="pf-ring-prog"
            cx="18"
            cy="18"
            r="15"
            :class="{ running: isPlaying }"
            :style="{ strokeDashoffset: ringOffset }"
          />
        </svg>
        <span class="pf-ring-icon">
          <el-icon><VideoPlay v-if="!isPlaying" /><VideoPause v-else /></el-icon>
        </span>
      </button>

      <div class="pf-pill-actions">
        <button
          class="pf-pill-btn"
          :disabled="!dataset"
          title="后退一帧"
          @mousedown.stop
          @click.stop="$emit('step-frame', -1)"
        >
          <el-icon><DArrowLeft /></el-icon>
        </button>
        <button
          class="pf-pill-btn"
          :disabled="!dataset"
          title="前进一帧"
          @mousedown.stop
          @click.stop="$emit('step-frame', 1)"
        >
          <el-icon><DArrowRight /></el-icon>
        </button>
        <button
          class="pf-pill-btn expand"
          title="展开"
          @mousedown.stop
          @click.stop="collapsed = false"
        >
          <el-icon><ArrowUp /></el-icon>
        </button>
      </div>
    </div>

    <!-- 展开态：完整面板 -->
    <div v-else class="playback-float" :style="{ top: pos.y + 'px', left: pos.x + 'px' }">
      <!-- 标题栏（拖拽手柄） -->
      <div class="pf-header" @mousedown="onDragStart">
        <el-icon class="pf-grip"><Rank /></el-icon>
        <span class="pf-title">爆破播放</span>
        <span class="pf-spacer"></span>
        <button class="pf-btn" title="收起" @mousedown.stop @click="collapsed = true">
          <el-icon><ArrowDown /></el-icon>
        </button>
      </div>

      <!-- 控制区 -->
      <div class="pf-body">
        <!-- 爆破物理预计算进度：预计算关键帧期间显示（完成后播放/倍速/循环/拖拽即时响应） -->
        <div v-if="!replayReady && replayPrecompute.active" class="pf-precompute">
          <div
            class="pf-precompute-fill"
            :style="{ width: (replayPrecompute.pct || 0) + '%' }"
          ></div>
          <span class="pf-precompute-text">
            爆破物理预计算中 {{ replayPrecompute.pct || 0 }}%…
          </span>
        </div>

        <!-- 进度条与帧号 -->
        <div class="pf-progress">
          <el-slider
            :disabled="!dataset || (!replayReady && replayPrecompute.active)"
            :min="0"
            :max="maxFrame"
            :step="1"
            :model-value="currentFrame"
            size="small"
            @update:model-value="val => $emit('frame-change', val)"
          />
          <span class="pf-frame">{{ currentFrame + 1 }}/{{ maxFrame + 1 }}</span>
        </div>

        <!-- 主控区 -->
        <div class="pf-main">
          <button
            class="pf-play"
            :disabled="!dataset"
            :title="isPlaying ? '暂停' : '播放'"
            @click="$emit('toggle-playback')"
          >
            <el-icon><VideoPlay v-if="!isPlaying" /><VideoPause v-else /></el-icon>
          </button>
          <div class="pf-actions">
            <button
              class="pf-btn"
              :disabled="!dataset || (!replayReady && replayPrecompute.active)"
              title="后退一帧"
              @click="$emit('step-frame', -1)"
            >
              <el-icon><DArrowLeft /></el-icon>
            </button>
            <button
              class="pf-btn"
              :disabled="!dataset || (!replayReady && replayPrecompute.active)"
              title="前进一帧"
              @click="$emit('step-frame', 1)"
            >
              <el-icon><DArrowRight /></el-icon>
            </button>
            <button class="pf-btn" :disabled="!dataset" title="重播" @click="$emit('replay-blast')">
              <el-icon><Refresh /></el-icon>
            </button>
            <!-- 倍速：下拉选择全部倍数 -->
            <el-select
              class="pf-rate-select"
              popper-class="pf-rate-popper"
              :model-value="playbackRate"
              :disabled="!dataset"
              size="small"
              title="选择播放倍速"
              @update:model-value="val => $emit('rate-change', val)"
            >
              <el-option v-for="r in playbackRates" :key="r" :label="r + 'x'" :value="r" />
            </el-select>
          </div>
        </div>

        <!-- 辅助控制区 -->
        <div class="pf-sub">
          <button
            class="pf-btn"
            :class="{ on: isLooping }"
            title="循环播放"
            @click="$emit('toggle-loop')"
          >
            <el-icon><RefreshRight /></el-icon>
          </button>
          <button
            class="pf-btn"
            :class="{ on: abLoop.enabled }"
            :title="'标记 A/B（当前帧 ' + (currentFrame + 1) + '）'"
            @click="onMarkAb"
          >
            <span class="pf-text">{{ abBtnLabel }}</span>
          </button>
          <button
            v-if="abLoop.a != null || abLoop.b != null"
            class="pf-btn"
            title="清除 AB 标记"
            @click="$emit('clear-ab-loop')"
          >
            <el-icon><Close /></el-icon>
          </button>
          <span v-if="abLoop.a != null || abLoop.b != null" class="pf-ab">
            A{{ abLoop.a != null ? abLoop.a + 1 : '-' }} B{{
              abLoop.b != null ? abLoop.b + 1 : '-'
            }}
          </span>
          <span class="pf-spacer"></span>
          <div class="pf-speed">
            <span class="pf-lbl">间隔</span>
            <el-input-number
              :disabled="!dataset"
              :min="16"
              :max="2000"
              :step="10"
              :controls="false"
              :model-value="playbackSpeedMs"
              size="small"
              @update:model-value="val => $emit('speed-change', val)"
            />
            <span class="pf-lbl">ms</span>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  VideoPlay,
  VideoPause,
  DArrowLeft,
  DArrowRight,
  Refresh,
  RefreshRight,
  Close,
  Rank,
  ArrowUp,
  ArrowDown
} from '@element-plus/icons-vue'

defineOptions({ name: 'PlaybackFloatingPanel' })

const props = defineProps({
  dataset: Object,
  isPlaying: Boolean,
  currentFrame: Number,
  maxFrame: Number,
  playbackSpeedMs: Number,
  playbackRate: Number,
  // 全部可选倍速（1x/2x/4x/8x），供下拉选择
  playbackRates: { type: Array, default: () => [1, 2, 4, 8] },
  isLooping: Boolean,
  abLoop: { type: Object, default: () => ({ a: null, b: null, enabled: false }) },
  // 关键帧回放（全速预计算）就绪标志与进度
  replayReady: Boolean,
  replayPrecompute: { type: Object, default: () => ({ active: false, pct: 0 }) }
})

const emit = defineEmits([
  'toggle-playback',
  'step-frame',
  'rate-change',
  'replay-blast',
  'frame-change',
  'speed-change',
  'toggle-loop',
  'mark-ab-loop',
  'clear-ab-loop',
  'save-result'
])

const collapsed = ref(false)
// 初始位置：屏幕左上角
const pos = ref({ x: 16, y: 16 })

const abBtnLabel = computed(() => {
  const ab = props.abLoop
  if (ab.a == null) return '标记 A'
  if (ab.b == null) return '标记 B'
  return '重标'
})

// 迷你进度环：0..1 进度，与帧号联动
const RING_CURCUM = 2 * Math.PI * 15 // r=15 → 周长
const ringProgress = computed(() => {
  const total = (props.maxFrame ?? 0) + 1
  if (!total || total <= 0) return 0
  return Math.min(1, Math.max(0, (props.currentFrame + 1) / total))
})
const ringOffset = computed(() => RING_CURCUM * (1 - ringProgress.value))

function onMarkAb() {
  emit('mark-ab-loop')
}

// ─── 拖拽 ───
let drag = null
function onDragStart(e) {
  if (e.button !== 0 && e.type !== 'mousedown') return
  drag = { startX: e.clientX, startY: e.clientY, originX: pos.value.x, originY: pos.value.y }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  e.preventDefault()
}
function onDragMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.startX
  const dy = e.clientY - drag.startY
  pos.value = { x: drag.originX + dx, y: drag.originY + dy }
}
function onDragEnd() {
  drag = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}
</script>

<style scoped>
/* ─── 物理预计算进度条 ─── */
.pf-precompute {
  position: relative;
  height: 20px;
  line-height: 20px;
  margin-bottom: 8px;
  padding: 0 8px;
  border-radius: var(--radius-md);
  background: rgba(64, 158, 255, 0.14);
  border: 1px solid rgba(64, 158, 255, 0.25);
  overflow: hidden;
  font-size: 12px;
}
.pf-precompute-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, rgba(64, 158, 255, 0.55), rgba(64, 158, 255, 0.9));
  transition: width 0.35s ease;
}
.pf-precompute-text {
  position: relative;
  z-index: 1;
  color: var(--primary-light);
}

/* ─── 收起态：紧凑胶囊条 ─── */
.pf-pill {
  position: fixed;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border-radius: 999px;
  background: var(--bg-primary);
  backdrop-filter: blur(10px);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-lg);
  cursor: grab;
  user-select: none;
}
.pf-pill:active {
  cursor: grabbing;
}

.pf-pill-play {
  position: relative;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.pf-pill-play:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.pf-ring-svg {
  position: absolute;
  inset: 0;
  width: 38px;
  height: 38px;
  transform: rotate(-90deg);
}
.pf-ring-track {
  fill: none;
  stroke: var(--border-primary);
  stroke-width: 3;
}
.pf-ring-prog {
  fill: none;
  stroke: var(--primary-color);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 94.24;
  transition:
    stroke-dashoffset 0.15s linear,
    stroke 0.2s;
}
.pf-ring-prog.running {
  stroke: #67c23a;
}

.pf-ring-icon {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
}
.pf-ring-icon .el-icon {
  width: 16px;
  height: 16px;
}

.pf-pill-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.pf-pill-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.pf-pill-btn:hover:not(:disabled) {
  background: rgba(64, 158, 255, 0.16);
  color: var(--text-primary);
}
.pf-pill-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pf-pill-btn .el-icon {
  width: 15px;
  height: 15px;
}
.pf-pill-btn.expand {
  background: rgba(64, 158, 255, 0.14);
  color: var(--primary-light);
}

/* ─── 展开态：完整面板 ─── */
.playback-float {
  position: fixed;
  z-index: 2000;
  width: 360px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-primary);
  backdrop-filter: blur(10px);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-lg);
  user-select: none;
}

.pf-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  cursor: grab;
  border-bottom: 1px solid var(--border-primary);
  background: var(--bg-secondary);
}
.pf-header:active {
  cursor: grabbing;
}
.pf-grip {
  color: var(--text-muted);
  font-size: 14px;
  transform: rotate(90deg);
}
.pf-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
}
.pf-spacer {
  flex: 1;
}

.pf-body {
  padding: 8px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pf-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pf-progress .el-slider {
  flex: 1;
}
.pf-frame {
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'Consolas', monospace;
  white-space: nowrap;
}

.pf-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pf-play {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--primary-color);
  color: #fff;
  cursor: pointer;
  transition: all 0.15s;
}
.pf-play:hover:not(:disabled) {
  background: var(--primary-dark);
}
.pf-play:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pf-play .el-icon {
  width: 18px;
  height: 18px;
}
.pf-actions {
  display: flex;
  gap: 4px;
}

.pf-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}
.pf-btn:hover:not(:disabled) {
  background: rgba(64, 158, 255, 0.12);
  color: var(--text-primary);
  border-color: rgba(64, 158, 255, 0.35);
}
.pf-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pf-btn.on {
  color: var(--primary-light);
  background: rgba(64, 158, 255, 0.18);
  border-color: rgba(64, 158, 255, 0.4);
}
.pf-btn .el-icon {
  width: 15px;
  height: 15px;
}

/* ─── 倍速下拉选择 ─── */
.pf-rate-select {
  width: 64px;
}
.pf-rate-select :deep(.el-select__wrapper) {
  background: rgba(255, 255, 255, 0.05);
  box-shadow: 0 0 0 1px var(--border-primary) inset;
  padding: 1px 8px;
  min-height: 28px;
}
.pf-rate-select :deep(.el-select__wrapper.is-disabled) {
  opacity: 0.35;
  cursor: not-allowed;
}
.pf-rate-select :deep(.el-select__selected-item) {
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
  font-family: 'Consolas', monospace;
}
.pf-rate-select :deep(.el-select__caret) {
  color: var(--text-muted);
}

/* 下拉选项浮层（teleport 到 body，需全局选择器） */
:global(.pf-rate-popper) {
  z-index: 2100 !important;
}
:global(.pf-rate-popper .el-select-dropdown__item) {
  color: var(--text-primary);
  font-size: 12px;
  font-family: 'Consolas', monospace;
}
:global(.pf-rate-popper .el-select-dropdown__item.is-selected) {
  color: var(--primary-color);
  font-weight: 600;
}
:global(.pf-rate-popper .el-popper__arrow) {
  display: none;
}
.pf-text {
  font-size: 11px;
  font-weight: 600;
  font-family: 'Consolas', monospace;
}

.pf-sub {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pf-ab {
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'Consolas', monospace;
  white-space: nowrap;
}
.pf-speed {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.pf-speed .el-input-number {
  width: 72px;
}
.pf-lbl {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
