<template>
  <div class="panel-section">
    <div class="panel-section-title">回放控制</div>
    <div class="controls-row">
      <button class="compact-action-btn primary" :disabled="!dataset" @click="$emit('toggle-playback')">
        {{ isPlaying ? '暂停' : '播放' }}
      </button>
      <button v-if="dataset" class="compact-action-btn" title="后退 1 帧" @click="$emit('step-frame', -1)">
        « 上一帧
      </button>
      <button v-if="dataset" class="compact-action-btn" title="前进 1 帧" @click="$emit('step-frame', 1)">
        下一帧 »
      </button>
      <button v-if="dataset" class="compact-action-btn" :class="{ primary: playbackRate > 1 }"
        title="点击切换 1x/2x/4x/8x" @click="$emit('cycle-rate')">
        {{ playbackRate }}x
      </button>
      <button v-if="dataset" class="compact-action-btn" title="飞行至爆心" @click="$emit('fly-to-center')">
        定位爆心
      </button>
      <button v-if="dataset" class="compact-action-btn" title="重新触发 three.js 爆破粒子效果" @click="$emit('replay-blast')">
        重播爆破
      </button>
      <span class="status-text">帧 {{ currentFrame + 1 }} / {{ maxFrame + 1 }}</span>
    </div>
    <el-slider class="mt-2" :disabled="!dataset" :min="0" :max="maxFrame" :step="1" :model-value="currentFrame"
      @update:model-value="val => $emit('frame-change', val)" />
    <div class="controls-row mt-2">
      <span class="status-text">播放间隔(ms)</span>
      <el-input-number :disabled="!dataset" :min="16" :max="2000" :step="10" :controls="false"
        :model-value="playbackSpeedMs" @update:model-value="val => $emit('speed-change', val)" />
    </div>

    <!-- 循环控制 -->
    <div v-if="dataset" class="controls-row mt-3">
      <label class="toggle-label" :title="isLooping ? '整体循环播放中' : '播放到末尾停止'">
        <input type="checkbox" :checked="isLooping" @change="$emit('toggle-loop')" />
        整体循环
      </label>
      <span class="status-text">·</span>
      <button class="compact-action-btn" :class="{ primary: abLoop.enabled }" :disabled="!dataset"
        @click="$emit('mark-ab-loop')" :title="'在当前帧标记 A/B 点（当前帧 ' + (currentFrame + 1) + '）'">
        {{ abLoop.a == null ? '标记 A 点' : abLoop.b == null ? '标记 B 点' : '重新标记' }}
      </button>
      <button v-if="abLoop.a != null || abLoop.b != null" class="compact-action-btn" @click="$emit('clear-ab-loop')">
        清除 AB
      </button>
      <button v-if="abLoop.a != null && abLoop.b != null" class="compact-action-btn"
        :class="{ primary: abLoop.enabled }" @click="$emit('toggle-ab-loop')">
        AB 循环：{{ abLoop.enabled ? '开' : '关' }}
      </button>
    </div>
    <div v-if="abLoop.a != null || abLoop.b != null" class="hint-text">
      A 点：{{ abLoop.a != null ? '帧 ' + (abLoop.a + 1) : '未设置' }} |
      B 点：{{ abLoop.b != null ? '帧 ' + (abLoop.b + 1) : '未设置' }}
    </div>

    <!-- Three.js 渲染统计 -->
    <div v-if="threeStats" class="mt-3">
      <div class="panel-subtitle">Three.js 渲染统计</div>
      <div class="stat-item">
        <span>碎片总数</span><span class="stat-value">{{ threeStats.total }}</span>
      </div>
      <div class="stat-item">
        <span>活跃碎片</span><span class="stat-value">{{ threeStats.alive }}</span>
      </div>
      <div class="stat-item">
        <span>已落地</span><span class="stat-value">{{ threeStats.landed }}</span>
      </div>
    </div>

    <!-- 保存结果 -->
    <div v-if="dataset" class="controls-row mt-3">
      <button class="compact-action-btn primary" @click="$emit('save-result')">保存结果</button>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: 'PlaybackControl' })

defineProps({
  dataset: { type: Object, default: null },
  isPlaying: { type: Boolean, default: false },
  currentFrame: { type: Number, default: 0 },
  maxFrame: { type: Number, default: 0 },
  playbackSpeedMs: { type: Number, default: 50 },
  playbackRate: { type: Number, default: 1 },
  isLooping: { type: Boolean, default: false },
  abLoop: { type: Object, default: () => ({ a: null, b: null, enabled: false }) },
  threeStats: { type: Object, default: null }
})

defineEmits([
  'toggle-playback', 'step-frame', 'cycle-rate', 'fly-to-center',
  'replay-blast', 'frame-change', 'speed-change', 'toggle-loop',
  'mark-ab-loop', 'clear-ab-loop', 'toggle-ab-loop', 'save-result'
])
</script>