<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="blasting-panel">
      <!-- 事件状态横幅 -->
      <div v-if="dataset" class="event-banner">
        <div>
          <div class="event-banner-title">{{ eventName }}</div>
          <div class="event-banner-info">
            <span>{{ dataset.event?.chargeKg || 0 }} kg</span>
            <span class="sep">·</span>
            <span>{{ maxFrame + 1 }} 帧</span>
            <span class="sep">·</span>
            <span>{{ dataset.design?.holes?.length || 0 }} 炮孔</span>
          </div>
        </div>
        <button class="exit-btn" @click="exitBlasting" title="退出爆破板块">退出</button>
      </div>

      <!-- 数据库事件选择 -->
      <div class="panel-section">
        <div class="panel-section-title"> 爆破事件（MySQL 数据库）</div>
        <div class="controls-row">
          <select class="db-event-select" :value="currentEventId || ''" :disabled="dbLoading" @change="onDbEventSelect">
            <option value="">-- 选择事件 --</option>
            <option v-for="ev in dbEvents" :key="ev.eventId" :value="ev.eventId">
              {{ ev.eventId }} - {{ ev.name }} ({{ ev.chargeKg }}kg)
            </option>
          </select>
          <button class="compact-action-btn" :disabled="dbLoading" @click="loadDbEvents">
            刷新
          </button>
        </div>
        <div v-if="dbLoading" class="loading-progress-wrap">
          <el-progress :percentage="loadProgress" :stroke-width="10" :status="loadProgress >= 100 ? 'success' : ''" />
          <div class="hint-text">正在加载数据… {{ loadProgress }}%</div>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="panel-section">
        <div class="tab-bar">
          <button v-for="tab in tabs" :key="tab.key" class="tab-btn" :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key">
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- 回放控制 Tab -->
      <PlaybackControl v-if="activeTab === 'playback'" :dataset="dataset" :is-playing="isPlaying"
        :current-frame="currentFrame" :max-frame="maxFrame" :playback-speed-ms="playbackSpeedMs"
        :playback-rate="playbackRate" :is-looping="isLooping" :ab-loop="abLoop" :three-stats="threeStats"
        @toggle-playback="togglePlayback" @step-frame="stepFrame" @cycle-rate="cyclePlaybackRate"
        @fly-to-center="flyToCenter" @replay-blast="replayBlast" @frame-change="onFrameChange"
        @speed-change="onSpeedChange" @toggle-loop="toggleLoop" @mark-ab-loop="markAbLoopPoint"
        @clear-ab-loop="clearAbLoop" @toggle-ab-loop="toggleAbLoop" @save-result="saveResult" />

      <!-- 视觉选项 Tab -->
      <VisualOptions v-if="activeTab === 'visual'" :layer-defs="LAYER_DEFS" :layer-visibility="layerVisibility"
        @set-layer-visible="setLayerVisible" @sync-visibility="syncLayerVisibility" />

      <!-- 爆破设计 Tab -->
      <BlastDesign v-if="activeTab === 'design'" :dataset="dataset" :blast-design="blastDesign"
        v-model:kco-params="kcoParams" @replay-blast="replayBlast" @reset-kco="resetKcoParams" />

      <!-- 历史对比 Tab -->
      <HistoryCompare v-if="activeTab === 'compare'" :db-events="dbEvents" v-model:compare-event-ids="compareEventIds"
        :comparison-data="comparisonData" :comparison-charts="comparisonCharts" :comparing="comparing"
        @compare="compareEvents" />

      <!-- 爆破效果评价 Tab -->
      <BlastEffect v-if="activeTab === 'effect'" :dataset="dataset" :get-damage-zones="getDamageZones"
        :highlight-damage-zone="highlightDamageZone" :highlight-block-class="highlightBlockClass"
        :get-blast-effect-stats="getBlastEffectStats" :get-ppv-field-stats="getPPVFieldStats"
        :set-safety-standard="setSafetyStandard" :load-ppv-field="loadPPVField"
        :fly-to-farthest-fragment="flyToFarthestFragment" :set-layer-visible="setLayerVisible" />

    </div>
  </div>
</template>

<script setup>
import { useBlastingPanelController } from '../services/panel/useBlastingPanelController.js'
import PlaybackControl from './PlaybackControl.vue'
import VisualOptions from './VisualOptions.vue'
import BlastDesign from './BlastDesign.vue'
import HistoryCompare from './HistoryCompare.vue'
import BlastEffect from './BlastEffect.vue'

defineOptions({ name: '爆破模拟面板' })

const {
  activeTab,
  dataset,
  isPlaying,
  currentFrame,
  maxFrame,
  playbackSpeedMs,
  playbackRate,
  isLooping,
  abLoop,
  cyclePlaybackRate,
  stepFrame,
  toggleLoop,
  markAbLoopPoint,
  clearAbLoop,
  toggleAbLoop,
  loadProgress,
  threeStats,
  replayBlast,
  kcoParams,
  resetKcoParams,
  LAYER_DEFS,
  layerVisibility,
  setLayerVisible,
  syncLayerVisibility,
  blastDesign,
  dbEvents,
  dbLoading,
  currentEventId,
  loadDbEvents,
  loadDbEvent,
  flyToCenter,
  eventName,
  onDbEventChange,
  saveResult,
  togglePlayback,
  clearSimulation,
  exitBlasting,
  onFrameChange,
  onSpeedChange,
  compareEventIds,
  comparisonData,
  comparisonCharts,
  comparing,
  compareEvents,
  // 爆破效果评价：数据获取 + 联动高亮
  getDamageZones,
  highlightDamageZone,
  highlightBlockClass,
  getBlastEffectStats,
  getPPVFieldStats,
  setSafetyStandard,
  loadPPVField,
  flyToFarthestFragment
} = useBlastingPanelController()

function onDbEventSelect(event) {
  const eventId = event?.target?.value
  if (eventId) onDbEventChange(eventId)
}

const tabs = [
  { key: 'playback', label: '回放控制' },
  { key: 'visual', label: '视觉选项' },
  { key: 'design', label: '爆破设计' },
  { key: 'compare', label: '历史对比' },
  { key: 'effect', label: '爆破效果' }
]
</script>

<style scoped>
.blasting-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

/* ─── 事件状态横幅 ─── */
.event-banner {
  padding: 12px 16px;
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.12), rgba(231, 76, 60, 0.08));
  border: 1px solid rgba(64, 158, 255, 0.25);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(8px);
}

.event-banner>div:first-child {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.event-banner-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.3px;
}

.event-banner-info {
  display: flex;
  gap: 8px;
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-family: 'Consolas', 'Monaco', monospace;
  letter-spacing: 0.2px;
}

.event-banner-info .sep {
  opacity: 0.4;
}

.exit-btn {
  padding: 6px 18px;
  font-size: var(--font-xs);
  font-weight: 500;
  color: #fff;
  background: rgba(231, 76, 60, 0.8);
  border: 1px solid rgba(231, 76, 60, 0.9);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.exit-btn:hover {
  background: rgba(192, 57, 43, 0.95);
  border-color: rgba(192, 57, 43, 1);
  box-shadow: 0 2px 8px rgba(231, 76, 60, 0.3);
}

.exit-btn:active {
  transform: scale(0.97);
}

/* ─── 卡片区块（穿透到子组件） ─── */
.blasting-panel :deep(.panel-section) {
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  box-shadow: var(--shadow-sm);
}

.blasting-panel :deep(.panel-section:hover) {
  border-color: rgba(64, 158, 255, 0.3);
  box-shadow: var(--shadow-md);
}

.blasting-panel :deep(.panel-section-title) {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--spacing-md);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.blasting-panel :deep(.panel-section-title)::before {
  content: '';
  display: block;
  width: 3px;
  height: 14px;
  background: var(--primary-color);
  border-radius: 2px;
}

.blasting-panel :deep(.panel-subtitle) {
  font-size: var(--font-sm);
  font-weight: 600;
  margin-bottom: var(--spacing-sm);
  margin-top: var(--spacing-md);
  color: var(--text-primary);
  padding-left: 8px;
  border-left: 3px solid var(--primary-color);
}

/* ─── 按钮（穿透到子组件） ─── */
.blasting-panel :deep(.compact-action-btn) {
  padding: 5px 14px;
  font-size: var(--font-xs);
  font-weight: 500;
  line-height: 1.4;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.blasting-panel :deep(.compact-action-btn:hover:not(:disabled)) {
  background: rgba(64, 158, 255, 0.12);
  border-color: var(--primary-color);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.blasting-panel :deep(.compact-action-btn:active:not(:disabled)) {
  transform: translateY(0);
}

.blasting-panel :deep(.compact-action-btn:disabled) {
  opacity: 0.35;
  cursor: not-allowed;
}

.blasting-panel :deep(.compact-action-btn.primary) {
  background: rgba(64, 158, 255, 0.2);
  border-color: rgba(64, 158, 255, 0.4);
  color: var(--primary-light);
}

.blasting-panel :deep(.compact-action-btn.primary:hover:not(:disabled)) {
  background: rgba(64, 158, 255, 0.35);
  border-color: var(--primary-color);
  color: #fff;
}

.blasting-panel :deep(.compact-action-btn.danger) {
  background: rgba(245, 108, 108, 0.15);
  border-color: rgba(245, 108, 108, 0.35);
  color: var(--secondary-color);
}

.blasting-panel :deep(.compact-action-btn.danger:hover:not(:disabled)) {
  background: rgba(245, 108, 108, 0.3);
  border-color: var(--secondary-color);
  color: #fff;
}

/* ─── 通用布局（穿透） ─── */
.blasting-panel :deep(.controls-row) {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.blasting-panel :deep(.hint-text) {
  margin-top: var(--spacing-sm);
  font-size: var(--font-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.blasting-panel :deep(.text-ok) {
  color: var(--success-color);
}

.blasting-panel :deep(.text-error) {
  color: var(--secondary-color);
}

.blasting-panel :deep(.text-warning) {
  color: var(--warning-color);
}

.blasting-panel :deep(.status-text) {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-family: 'Consolas', 'Monaco', monospace;
}

/* ─── 统计项（穿透） ─── */
.blasting-panel :deep(.stat-item) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-sm);
  padding: 4px 0;
  font-size: var(--font-xs);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.blasting-panel :deep(.stat-item:last-child) {
  border-bottom: none;
}

.blasting-panel :deep(.stat-value) {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  color: var(--primary-light);
}

/* ─── Tab 样式 ─── */
.tab-bar {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border-primary);
  padding-bottom: 0;
  margin-bottom: var(--spacing-xs);
  background: rgba(0, 0, 0, 0.15);
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  padding: 4px 4px 0;
  overflow: hidden;
}

.tab-btn {
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all var(--transition-fast);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  position: relative;
  flex: 1;
  text-align: center;
  letter-spacing: 0.5px;
}

.tab-btn:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
}

.tab-btn.active {
  color: var(--primary-color);
  border-bottom-color: var(--primary-color);
  font-weight: 600;
  background: rgba(64, 158, 255, 0.08);
}

/* ─── 开关与单选（穿透） ─── */
.blasting-panel :deep(.toggle-label),
.blasting-panel :deep(.radio-label) {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-xs);
  cursor: pointer;
  user-select: none;
  color: var(--text-secondary);
  transition: color var(--transition-fast);
}

.blasting-panel :deep(.toggle-label:hover),
.blasting-panel :deep(.radio-label:hover) {
  color: var(--text-primary);
}

.blasting-panel :deep(.toggle-label input),
.blasting-panel :deep(.radio-label input) {
  margin: 0;
  cursor: pointer;
  accent-color: var(--primary-color);
}

/* ─── 视觉选项：图层网格（穿透） ─── */
.blasting-panel :deep(.layer-grid) {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-sm) var(--spacing-md);
  margin-top: var(--spacing-sm);
}

.blasting-panel :deep(.layer-toggle) {
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.blasting-panel :deep(.layer-toggle:hover) {
  border-color: var(--primary-color);
  background: rgba(64, 158, 255, 0.08);
}

/* ─── 爆破设计：炮孔布置图 SVG（穿透） ─── */
.blasting-panel :deep(.hole-layout-wrap) {
  margin-top: var(--spacing-sm);
  padding: 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  display: flex;
  justify-content: center;
}

.blasting-panel :deep(.hole-layout-svg) {
  width: 100%;
  max-width: 260px;
  height: auto;
}

.blasting-panel :deep(.hole-legend text) {
  font-family: 'Consolas', 'Microsoft YaHei', sans-serif;
}

/* ─── 数据库事件选择器 ─── */
.db-event-select {
  flex: 1;
  min-width: 0;
  padding: 6px 12px;
  font-size: var(--font-xs);
  background-color: #1a1d24;
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.db-event-select:hover {
  border-color: var(--primary-color);
  background-color: #1e2530;
}

.db-event-select:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
}

.db-event-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* option 元素需要不透明背景，否则浏览器原生渲染时白字不可见 */
.db-event-select option,
.blasting-panel :deep(.db-event-select option) {
  background-color: #1a1d24;
  color: #e5eaf3;
  padding: 4px 8px;
}

.db-event-select option:checked,
.blasting-panel :deep(.db-event-select option:checked) {
  background-color: var(--primary-color);
  color: #fff;
}

/* ─── KCO 模型参数面板（穿透） ─── */
.blasting-panel :deep(.kco-panel) {
  padding: 12px 14px;
  background: rgba(64, 158, 255, 0.04);
  border: 1px solid rgba(64, 158, 255, 0.15);
  border-radius: var(--radius-md);
}

.blasting-panel :deep(.kco-hint) {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 8px;
}

.blasting-panel :deep(.kco-desc) {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
}

.blasting-panel :deep(.kco-group-title) {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-primary);
  margin-top: var(--spacing-md);
  margin-bottom: var(--spacing-sm);
  padding-left: 8px;
  border-left: 2px solid rgba(64, 158, 255, 0.5);
}

.blasting-panel :deep(.kco-grid) {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--spacing-sm) var(--spacing-md);
}

.blasting-panel :deep(.kco-field) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.blasting-panel :deep(.kco-label) {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
}

.blasting-panel :deep(.kco-field .el-input-number) {
  width: 100%;
}

.blasting-panel :deep(.kco-field .el-input-number .el-input__inner) {
  text-align: left;
  padding-left: 8px;
  padding-right: 8px;
  font-size: var(--font-xs);
  font-family: 'Consolas', 'Monaco', monospace;
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--border-primary);
}

.blasting-panel :deep(.kco-field .el-input-number .el-input__inner:focus) {
  border-color: var(--primary-color);
}

.blasting-panel :deep(.kco-preview) {
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
}

.blasting-panel :deep(.kco-preview .stat-item) {
  margin-bottom: 4px;
}

/* ─── 炮孔点击交互（穿透） ─── */
.blasting-panel :deep(.hole-point) {
  cursor: pointer;
  transition: r 0.12s ease;
}

.blasting-panel :deep(.hole-point:hover) {
  r: 5;
}

.blasting-panel :deep(.hole-detail-pop) {
  font-size: var(--font-xs);
}

.blasting-panel :deep(.hole-detail-title) {
  font-size: var(--font-sm);
  font-weight: 600;
  margin-bottom: var(--spacing-sm);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-primary);
  color: var(--text-primary);
}

/* ─── 方案保存与加载（穿透） ─── */
.blasting-panel :deep(.preset-section) {
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-primary);
}

.blasting-panel :deep(.preset-name-input) {
  flex: 1;
  min-width: 0;
  padding: 5px 12px;
  font-size: var(--font-xs);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-fast);
}

.blasting-panel :deep(.preset-name-input:focus) {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
}

/* ─── 加载进度条 ─── */
.loading-progress-wrap {
  margin-top: var(--spacing-sm);
}

.loading-progress-wrap .hint-text {
  margin-top: 4px;
  text-align: center;
}

/* ─── 历史对比（穿透） ─── */
.blasting-panel :deep(.compare-event-select) {
  flex: 1;
  min-width: 0;
}

.blasting-panel :deep(.compare-chart-block) {
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
}

.blasting-panel :deep(.compare-max-hint) {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 8px;
}

.blasting-panel :deep(.compare-bar-list) {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.blasting-panel :deep(.compare-bar-row) {
  display: grid;
  grid-template-columns: 90px 1fr 70px;
  gap: var(--spacing-sm);
  align-items: center;
  font-size: 11px;
}

.blasting-panel :deep(.compare-bar-name) {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blasting-panel :deep(.compare-bar-track) {
  position: relative;
  height: 16px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.blasting-panel :deep(.compare-bar-fill) {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-color), var(--primary-light));
  border-radius: var(--radius-sm);
  transition: width 0.3s ease;
  box-shadow: 0 0 4px rgba(64, 158, 255, 0.3);
}

.blasting-panel :deep(.compare-bar-value) {
  text-align: right;
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  color: var(--primary-light);
}

/* ─── mt-* 辅助类（穿透） ─── */
.blasting-panel :deep(.mt-2) {
  margin-top: var(--spacing-sm);
}

.blasting-panel :deep(.mt-3) {
  margin-top: var(--spacing-md);
}
</style>
