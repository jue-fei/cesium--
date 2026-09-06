<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="blasting-panel">
      <!-- 顶部事件选择卡片 -->
      <div class="event-card" :class="{ active: !!currentEventId }">
        <div class="event-card-header">
          <div class="event-card-title">
            <span class="event-card-icon"
              ><el-icon><Collection /></el-icon
            ></span>
            <span>爆破事件</span>
          </div>
          <button class="btn-icon exit" title="退出爆破模拟" @click="exitBlasting">
            <el-icon><Close /></el-icon>
          </button>
        </div>
        <div class="event-card-body">
          <div class="event-select-wrap">
            <el-icon class="event-select-icon"><Aim /></el-icon>
            <select
              class="event-select"
              :value="currentEventId || ''"
              :disabled="dbLoading"
              @change="e => onDbEventChange(e.target.value)"
            >
              <option value="">
                {{ dbEvents.length ? '点击选择爆破事件' : '暂无事件，点击刷新' }}
              </option>
              <option v-for="ev in dbEvents" :key="ev.eventId" :value="ev.eventId">
                {{ ev.eventId }} · {{ ev.name }} · {{ ev.chargeKg }}kg
              </option>
            </select>
          </div>
          <button class="btn-icon" :disabled="dbLoading" title="刷新事件列表" @click="loadDbEvents">
            <el-icon><Refresh /></el-icon>
          </button>
        </div>
      </div>

      <!-- 当前事件摘要（已加载数据时显示） -->
      <div v-if="dataset" class="event-summary">
        <span class="event-name">{{ eventName }}</span>
        <span class="event-divider">·</span>
        <span class="event-meta">{{ dataset.event?.chargeKg || 0 }} kg</span>
        <span class="event-divider">·</span>
        <span class="event-meta">{{ maxFrame + 1 }} 帧</span>
        <span class="event-divider">·</span>
        <span class="event-meta">{{ dataset.design?.holes?.length || 0 }} 孔</span>
        <span class="mode-tag">{{ previewMode }}</span>
      </div>

      <!-- 加载进度 -->
      <div v-if="dbLoading" class="loading-bar">
        <div class="loading-fill" :style="{ width: loadProgress + '%' }"></div>
        <span class="loading-text">加载中 {{ loadProgress }}%</span>
      </div>

      <!-- 爆破物理预计算进度：首播前全速预计算关键帧，完成后播放/倍速/循环即时响应 -->
      <div v-if="dataset && !replayReady && replayPrecompute.active" class="precompute-bar">
        <div class="precompute-fill" :style="{ width: (replayPrecompute.pct || 0) + '%' }"></div>
        <span class="precompute-text">爆破物理预计算中 {{ replayPrecompute.pct || 0 }}%…</span>
      </div>

      <!-- Tab 切换：始终显示 -->
      <div class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 空状态占位 -->
      <div v-if="!dataset && !dbLoading" class="empty-state">
        <div class="empty-icon">🧨</div>
        <div class="empty-title">暂未选择爆破事件</div>
        <div class="empty-desc">从上方下拉框选择事件后，可查看效果预览与参数。</div>
      </div>

      <!-- 效果预览 Tab -->
      <div v-else-if="activeTab === 'preview'" class="tab-content">
        <!-- 三维观察视角切换（内部 / 外部） -->
        <div class="view-toggle">
          <span class="view-toggle-label">视角</span>
          <div class="seg">
            <button
              class="seg-btn"
              :class="{ active: cameraViewMode === 'interior' }"
              @click="setCameraViewMode('interior')"
            >
              隧道内部
            </button>
            <button
              class="seg-btn"
              :class="{ active: cameraViewMode === 'exterior' }"
              @click="setCameraViewMode('exterior')"
            >
              外部测区
            </button>
          </div>
        </div>
        <!-- 爆堆轮廓（三维包络 + 安息角标注） -->
        <div class="muck-row">
          <button
            class="view-btn muck-btn"
            :class="{ active: muckPileOutlineEnabled }"
            @click="toggleMuckPileOutline"
          >
            <span class="muck-dot" :class="{ active: muckPileOutlineEnabled }"></span>
            爆堆轮廓
          </button>
        </div>
        <!-- 爆堆测量信息（按钮下方独立卡片，信息全面；测量不再绘制进 3D 模型） -->
        <div v-if="muckPileOutlineEnabled" class="muck-info">
          <template v-if="muckPileMeasure && muckPileMeasure.height != null">
            <div class="muck-info-head">
              <span class="muck-info-dot"></span>
              <span class="muck-info-title">爆堆测量</span>
              <span class="muck-info-angle">
                <span class="muck-info-angle-label">安息角</span>
                <span class="muck-info-angle-value">
                  {{
                    muckPileMeasure.angle != null ? `φ≈${muckPileMeasure.angle.toFixed(1)}°` : '—'
                  }}
                </span>
              </span>
            </div>
            <div class="muck-info-grid">
              <div class="muck-cell">
                <span class="muck-cell-label">堆高</span>
                <span class="muck-cell-value">{{ muckPileMeasure.height?.toFixed(1) }}m</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">平均堆高</span>
                <span class="muck-cell-value">{{ muckPileMeasure.meanHeight?.toFixed(1) }}m</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">堆宽</span>
                <span class="muck-cell-value">{{ muckPileMeasure.width?.toFixed(1) }}m</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">堆长</span>
                <span class="muck-cell-value">{{ muckPileMeasure.length?.toFixed(1) }}m</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">足迹面积</span>
                <span class="muck-cell-value">{{ muckPileMeasure.area?.toFixed(1) }}m²</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">爆堆体积</span>
                <span class="muck-cell-value">{{ muckPileMeasure.volume?.toFixed(1) }}m³</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">抛距</span>
                <span class="muck-cell-value">≤{{ muckPileMeasure.mainLength?.toFixed(1) }}m</span>
              </div>
              <div class="muck-cell">
                <span class="muck-cell-label">堆体碎块</span>
                <span class="muck-cell-value"
                  >{{ muckPileMeasure.keptCount }}/{{ muckPileMeasure.totalCount }}块</span
                >
              </div>
            </div>
            <div v-if="muckPileMeasure.excludedCount" class="muck-info-foot">
              剔除过远离群 {{ muckPileMeasure.excludedCount }} 块
            </div>
          </template>
          <template v-else>
            <div class="muck-wait">等待碎片落地堆积…</div>
          </template>
        </div>
        <PlaybackControl
          :three-stats="threeStats"
          :kco-params="kcoParams"
          :layer-defs="LAYER_DEFS"
          :layer-visibility="layerVisibility"
          @set-layer-visible="setLayerVisible"
          @sync-visibility="syncLayerVisibility"
        />
      </div>

      <!-- 参数设计 Tab -->
      <div v-else-if="activeTab === 'design'" class="tab-content">
        <BlastDesign
          :dataset="dataset"
          :blast-design="blastDesign"
          :kco-model="kcoParams"
          :distribution="fragmentDistribution"
          :three-stats="threeStats"
          @replay-blast="replayBlast"
          @reset-kco="resetKcoParams"
          @update-section="updateSection"
          @update-kco="onKcoParamsChange"
          @highlight-size="highlightFragmentsBySize"
          @clear-highlight="clearFragmentHighlight"
        />
      </div>

      <!-- 振动场 Tab -->
      <div v-else-if="activeTab === 'field'" class="tab-content">
        <VibrationFieldPanel
          :vibration-modes="VIBRATION_MODES"
          :vibration-mode="vibrationDisplayMode"
          :vibration-field-info="vibrationFieldInfo"
          :sadosky-params="sadoskyParams"
          :ppv-pick-enabled="ppvPickEnabled"
          :picked-ppv="pickedPpv"
          :white-model-enabled="whiteModelEnabled"
          @set-vibration-mode="setVibrationDisplayMode"
          @update-sadosky-params="setSadoskyParams"
          @toggle-ppv-pick="togglePpvPick"
          @toggle-white-model="setWhiteModelEnabled"
        />
        <!-- 视觉图层开关（含烟雾/粉尘等特效），方便在振动场视图下隐藏特效以查看岩体轮廓 -->
        <PlaybackControl
          :three-stats="threeStats"
          :kco-params="kcoParams"
          :layer-defs="LAYER_DEFS"
          :layer-visibility="layerVisibility"
          @set-layer-visible="setLayerVisible"
          @sync-visibility="syncLayerVisibility"
        />
      </div>

      <!-- 方案对比 Tab -->
      <HistoryCompare
        v-else-if="activeTab === 'compare'"
        v-model:compare-event-ids="compareEventIds"
        :db-events="dbEvents"
        :comparison-data="comparisonData"
        :comparison-charts="comparisonCharts"
        :comparing="comparing"
        :current-event-id="currentEventId"
        :current-event-name="eventName"
        @compare="compareEvents"
      />
    </div>
  </div>
</template>

<script setup>
import { Refresh, Close, Collection, Aim } from '@element-plus/icons-vue'
import { useBlastingPanelController } from '../services/panel/useBlastingPanelController.js'
import PlaybackControl from './PlaybackControl.vue'
import BlastDesign from './BlastDesign.vue'
import HistoryCompare from './HistoryCompare.vue'
import VibrationFieldPanel from './VibrationFieldPanel.vue'

defineOptions({ name: '爆破模拟面板' })

const {
  activeTab,
  dataset,
  maxFrame,
  loadProgress,
  previewMode,
  threeStats,
  replayBlast,
  kcoParams,
  resetKcoParams,
  LAYER_DEFS,
  layerVisibility,
  setLayerVisible,
  updateSection,
  syncLayerVisibility,
  VIBRATION_MODES,
  vibrationDisplayMode,
  vibrationFieldInfo,
  setVibrationDisplayMode,
  sadoskyParams,
  setSadoskyParams,
  whiteModelEnabled,
  setWhiteModelEnabled,
  ppvPickEnabled,
  pickedPpv,
  togglePpvPick,
  blastDesign,
  dbEvents,
  dbLoading,
  currentEventId,
  loadDbEvents,
  eventName,
  onDbEventChange,
  onKcoParamsChange,
  exitBlasting,
  compareEventIds,
  comparisonData,
  comparisonCharts,
  comparing,
  compareEvents,
  fragmentDistribution,
  highlightFragmentsBySize,
  clearFragmentHighlight,
  cameraViewMode,
  setCameraViewMode,
  muckPileOutlineEnabled,
  muckPileMeasure,
  toggleMuckPileOutline,
  replayReady,
  replayPrecompute
} = useBlastingPanelController()

const tabs = [
  { key: 'preview', label: '效果预览' },
  { key: 'design', label: '参数设计' },
  { key: 'field', label: '振动场' },
  { key: 'compare', label: '方案对比' }
]
</script>

<style scoped src="./BlastingPanel.css"></style>

<style scoped>
.blasting-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ─── 顶部事件选择卡片 ─── */
.event-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition:
    border-color 0.2s,
    background 0.2s;
}
.event-card.active {
  border-color: rgba(64, 158, 255, 0.4);
  background: linear-gradient(180deg, rgba(64, 158, 255, 0.08), var(--bg-secondary));
}
.event-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-primary);
}
.event-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.event-card-icon {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(64, 158, 255, 0.14);
  color: var(--primary-color);
}
.event-card-icon .el-icon {
  width: 14px;
  height: 14px;
}
.event-card-body {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
}

.event-select-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.event-select-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--text-muted);
  pointer-events: none;
}
.event-select {
  width: 100%;
  padding: 8px 12px 8px 32px;
  font-size: 13px;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.2);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  transition: border-color 0.15s;
}
.event-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.event-select:focus {
  outline: none;
  border-color: var(--primary-color);
}
.event-select option {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

/* ─── 空状态占位 ─── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 20px;
  text-align: center;
  border: 1px dashed var(--border-primary);
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.02);
}
.empty-icon {
  font-size: 36px;
}
.empty-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}
.empty-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  max-width: 260px;
}

/* ─── 当前事件摘要 ─── */
.event-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  flex-wrap: wrap;
  padding: 0 2px;
}

.event-name {
  font-weight: 600;
  color: var(--text-primary);
}

.event-meta {
  color: var(--text-muted);
  font-family: 'Consolas', monospace;
  font-size: 11px;
}

.event-divider {
  color: var(--border-primary);
}

.mode-tag {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(64, 158, 255, 0.15);
  color: var(--primary-light);
}

/* ─── 通用图标按钮（供子组件使用） ─── */
.btn-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.btn-icon:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}
.btn-icon.on {
  background: rgba(64, 158, 255, 0.18);
  color: var(--primary-color);
  border-color: rgba(64, 158, 255, 0.35);
}
.btn-icon:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.btn-icon.exit:hover {
  background: rgba(245, 108, 108, 0.15);
  color: #f56c6c;
  border-color: rgba(245, 108, 108, 0.3);
}
.btn-icon .el-icon {
  width: 18px;
  height: 18px;
}

/* ─── 加载进度 ─── */
.loading-bar {
  position: relative;
  height: 4px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  overflow: visible;
}
.loading-fill {
  height: 100%;
  background: var(--primary-color);
  border-radius: 2px;
  transition: width 0.3s;
}
.loading-text {
  position: absolute;
  right: 0;
  top: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

/* ─── Tab ─── */
.tabs {
  display: flex;
  gap: 2px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: 3px;
}

.tab {
  flex: 1;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}

.tab:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.04);
}
.tab.active {
  color: #fff;
  background: var(--primary-color);
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.3);
}

/* ─── Tab 内容区 ─── */
.tab-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ─── 三维观察视角切换 ─── */
.view-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}
.view-toggle-label {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.seg {
  display: flex;
  gap: 2px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: 2px;
  flex: 1;
}
.seg-btn {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}
.seg-btn:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
}
.seg-btn.active {
  color: #fff;
  background: var(--primary-color);
  font-weight: 600;
}

/* ─── 爆堆轮廓控制 ─── */
.muck-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.view-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.view-btn:hover {
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-primary);
}
.view-btn.active {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: #fff;
}
.muck-btn {
  border-color: rgba(255, 167, 71, 0.45);
  color: #ffb347;
}
.muck-btn:hover {
  border-color: rgba(255, 167, 71, 0.7);
  background: rgba(255, 167, 71, 0.08);
}
.muck-btn.active {
  background: rgba(255, 167, 71, 0.85);
  border-color: #ffb347;
  color: #17191f;
}
.muck-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 167, 71, 0.4);
  transition: all 0.15s;
}
.muck-dot.active {
  background: #17191f;
  box-shadow: 0 0 6px rgba(255, 167, 71, 0.6);
}
/* 爆堆测量信息卡：按钮下方独立卡片，与暗色面板统一，琥珀强调 */
.muck-info {
  margin-top: 8px;
  background: rgba(255, 167, 71, 0.06);
  border: 1px solid rgba(255, 167, 71, 0.2);
  border-radius: var(--radius-lg);
  padding: 8px 10px 9px;
}
.muck-info-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  margin-bottom: 7px;
  border-bottom: 1px solid rgba(255, 167, 71, 0.14);
}
.muck-info-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ffb347;
  box-shadow: 0 0 6px rgba(255, 167, 71, 0.8);
  flex: none;
}
.muck-info-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text-primary);
}
.muck-info-angle {
  margin-left: auto;
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.muck-info-angle-label {
  font-size: 10px;
  color: var(--text-muted);
}
.muck-info-angle-value {
  font-family: 'Consolas', monospace;
  font-size: 15px;
  font-weight: 600;
  color: #ffb347;
  font-variant-numeric: tabular-nums;
}
.muck-info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 16px;
}
.muck-cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.muck-cell-label {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
.muck-cell-value {
  font-family: 'Consolas', monospace;
  font-size: 11px;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.muck-info-foot {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 167, 71, 0.12);
  font-size: 10px;
  color: var(--text-muted);
}
.muck-wait {
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 0;
}
</style>
