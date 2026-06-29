<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="blasting-panel">
      <!-- 事件状态横幅 -->
      <div v-if="dataset" class="event-banner">
        <div class="event-banner-title">{{ eventName }}</div>
        <div class="event-banner-info">
          <span>{{ summary.chargeKg || dataset.event?.chargeKg || 0 }} kg</span>
          <span>·</span>
          <span>{{ summary.frameCount }} 帧</span>
          <span>·</span>
          <span>{{ summary.fragmentCount }} 碎片</span>
        </div>
      </div>

      <!-- 数据库事件选择 -->
      <div class="panel-section">
        <div class="panel-section-title">爆破事件（MySQL 数据库）</div>
        <div class="controls-row">
          <select
            class="db-event-select"
            :value="currentEventId || ''"
            :disabled="dbLoading"
            @change="onDbEventSelect"
          >
            <option value="">-- 选择事件 --</option>
            <option v-for="ev in dbEvents" :key="ev.event_id" :value="ev.event_id">
              {{ ev.event_id }} - {{ ev.name }} ({{ ev.charge_kg }}kg)
            </option>
          </select>
          <button class="compact-action-btn" :disabled="dbLoading" @click="loadDbEvents">
            刷新
          </button>
        </div>
        <div v-if="dbLoading" class="hint-text">加载中...</div>
      </div>

      <!-- 渲染配置 -->
      <div class="panel-section">
        <div class="panel-section-title">渲染配置</div>
        <div class="controls-row">
          <select
            class="db-event-select"
            :value="selectedRenderConfig"
            @change="onRenderConfigSelect"
          >
            <option value="realistic">真实模式</option>
            <option value="high_performance">高性能模式</option>
            <option value="ultra_realistic">超真实模式</option>
          </select>
        </div>
        <div v-if="currentRenderConfig" class="hint-text">
          {{ currentRenderConfig.description || '已应用渲染配置' }}
        </div>
      </div>

      <!-- 数据导入 -->
      <div class="panel-section">
        <div class="panel-section-title">爆破数据导入</div>
        <div class="controls-row">
          <input
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="onFileChange"
          />
          <button class="compact-action-btn primary" @click="fileInput?.click()">选择文件</button>
          <button class="compact-action-btn" @click="loadExample">加载示例</button>
          <button class="compact-action-btn danger" :disabled="!dataset" @click="clearSimulation">
            清空
          </button>
        </div>
        <div class="hint-text">
          支持格式：event.center、design.holes、frames。无 frames 时自动启动粒子模拟。
        </div>
        <div
          class="hint-text"
          :class="{ 'text-ok': importStatus?.ok, 'text-error': importStatus && !importStatus.ok }"
        >
          {{ importStatus?.message || '等待导入数据' }}
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="panel-section">
        <div class="tab-bar">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="tab-btn"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- 回放控制 Tab -->
      <div v-if="activeTab === 'playback'" class="panel-section">
        <div class="panel-section-title">回放控制</div>
        <div class="controls-row">
          <button class="compact-action-btn primary" :disabled="!dataset" @click="togglePlayback">
            {{ isPlaying ? '暂停' : '播放' }}
          </button>
          <button v-if="dataset" class="compact-action-btn" title="飞行至爆心" @click="flyToCenter">
            定位爆心
          </button>
          <button
            v-if="dataset"
            class="compact-action-btn"
            title="重新触发 three.js 爆破粒子效果"
            @click="replayBlast"
          >
            重播爆破
          </button>
          <span class="status-text">帧 {{ currentFrame + 1 }} / {{ maxFrame + 1 }}</span>
        </div>
        <el-slider
          class="mt-2"
          :disabled="!dataset"
          :min="0"
          :max="maxFrame"
          :step="1"
          :model-value="currentFrame"
          @update:model-value="onFrameChange"
        />
        <div class="controls-row mt-2">
          <span class="status-text">播放间隔(ms)</span>
          <el-input-number
            :disabled="!dataset"
            :min="16"
            :max="2000"
            :step="10"
            :controls="false"
            :model-value="playbackSpeedMs"
            @update:model-value="onSpeedChange"
          />
        </div>

        <!-- 显示开关 -->
        <div class="controls-row mt-3">
          <label class="toggle-label">
            <input type="checkbox" :checked="showHeatmap" @change="toggleHeatmap" />
            振动热力图
          </label>
          <label class="toggle-label">
            <input type="checkbox" :checked="showMonitorPoints" @change="toggleMonitorPoints" />
            应力监测点
          </label>
        </div>
      </div>

      <!-- 视觉选项 Tab -->
      <div v-if="activeTab === 'visual'" class="panel-section">
        <div class="panel-section-title">图层可见性</div>
        <div class="hint-text">
          单独控制 3D 场景中各爆破元素的显示/隐藏，便于聚焦观察特定效果。
        </div>
        <div class="layer-grid">
          <label
            v-for="layer in LAYER_DEFS"
            :key="layer.key"
            class="toggle-label layer-toggle"
          >
            <input
              type="checkbox"
              :checked="layerVisibility[layer.key]"
              @change="onLayerToggle(layer.key, $event)"
            />
            {{ layer.label }}
          </label>
        </div>
        <div class="controls-row mt-3">
          <button class="compact-action-btn" @click="setAllLayers(true)">全部显示</button>
          <button class="compact-action-btn" @click="setAllLayers(false)">仅场景</button>
          <button class="compact-action-btn" @click="syncLayerVisibility">同步状态</button>
        </div>
      </div>

      <!-- 爆破设计 Tab -->
      <div v-if="activeTab === 'design'" class="panel-section">
        <div class="panel-section-title">炮孔布置图（掌子面正视图）</div>
        <div v-if="!blastDesign" class="hint-text">
          请先加载爆破数据以生成炮孔布置图。
        </div>
        <div v-else class="hole-layout-wrap">
          <svg
            :viewBox="`0 0 ${holeLayoutSize} ${holeLayoutSize}`"
            class="hole-layout-svg"
          >
            <!-- 马蹄形断面轮廓 -->
            <path :d="tunnelOutlinePath" fill="#1a1a1a" stroke="#888" stroke-width="1.5" />
            <!-- 炮孔点 -->
            <circle
              v-for="(h, i) in blastDesign.holes"
              :key="i"
              :cx="holeToSvgX(h.x)"
              :cy="holeToSvgY(h.y)"
              :r="h.isEmpty ? 4 : 2.5"
              :fill="holeColor(h)"
              :stroke="h.isEmpty ? '#fff' : 'none'"
              :stroke-width="h.isEmpty ? 0.8 : 0"
            />
            <!-- 图例 -->
            <g class="hole-legend">
              <circle :cx="holeLayoutSize - 90" :cy="14" r="2.5" fill="#ff6b6b" />
              <text :x="holeLayoutSize - 82" :y="17" fill="#ccc" font-size="9">掏槽孔</text>
              <circle :cx="holeLayoutSize - 90" :cy="28" r="2.5" fill="#feca57" />
              <text :x="holeLayoutSize - 82" :y="31" fill="#ccc" font-size="9">辅助孔</text>
              <circle :cx="holeLayoutSize - 50" :cy="14" r="2.5" fill="#1dd1a1" />
              <text :x="holeLayoutSize - 42" :y="17" fill="#ccc" font-size="9">周边孔</text>
              <circle :cx="holeLayoutSize - 50" :cy="28" r="4" fill="#fff" stroke="#888" stroke-width="0.8" />
              <text :x="holeLayoutSize - 42" :y="31" fill="#ccc" font-size="9">空孔</text>
            </g>
          </svg>
        </div>

        <div v-if="blastDesign" class="mt-3">
          <div class="panel-subtitle">钻孔统计</div>
          <div class="stat-item">
            <span>总孔数</span><span class="stat-value">{{ blastDesign.counts.total }}</span>
          </div>
          <div class="stat-item">
            <span>掏槽孔（含空孔）</span
            ><span class="stat-value"
              >{{ blastDesign.counts.cut }} (空孔 {{ blastDesign.counts.empty }})</span
            >
          </div>
          <div class="stat-item">
            <span>辅助孔</span><span class="stat-value">{{ blastDesign.counts.auxiliary }}</span>
          </div>
          <div class="stat-item">
            <span>周边孔</span><span class="stat-value">{{ blastDesign.counts.perimeter }}</span>
          </div>
          <div class="stat-item">
            <span>钻孔深度</span><span class="stat-value">{{ blastDesign.holeDepth }} m</span>
          </div>
        </div>

        <div v-if="blastDesign" class="mt-3">
          <div class="panel-subtitle">掘进与爆破参数</div>
          <div class="stat-item">
            <span>断面尺寸</span
            ><span class="stat-value"
              >{{ blastDesign.section.W }}m × {{ blastDesign.section.totalH.toFixed(1) }}m</span
            >
          </div>
          <div class="stat-item">
            <span>断面面积</span
            ><span class="stat-value">{{ blastDesign.section.area.toFixed(2) }} m²</span>
          </div>
          <div class="stat-item">
            <span>单循环进尺</span
            ><span class="stat-value">{{ blastDesign.advanceDepth.toFixed(2) }} m</span>
          </div>
          <div class="stat-item">
            <span>单循环爆破方量</span
            ><span class="stat-value">{{ blastDesign.volumePerRound.toFixed(2) }} m³</span>
          </div>
        </div>

        <div v-if="blastDesign" class="mt-3">
          <div class="panel-subtitle">装药参数</div>
          <div class="stat-item">
            <span>掏槽孔药量</span
            ><span class="stat-value">{{ blastDesign.charge.cut.toFixed(1) }} kg</span>
          </div>
          <div class="stat-item">
            <span>辅助孔药量</span
            ><span class="stat-value">{{ blastDesign.charge.auxiliary.toFixed(1) }} kg</span>
          </div>
          <div class="stat-item">
            <span>周边孔药量</span
            ><span class="stat-value">{{ blastDesign.charge.perimeter.toFixed(1) }} kg</span>
          </div>
          <div class="stat-item">
            <span>总装药量</span
            ><span class="stat-value">{{ blastDesign.charge.total.toFixed(1) }} kg</span>
          </div>
          <div class="stat-item">
            <span>炸药单耗</span
            ><span class="stat-value"
              >{{ blastDesign.charge.specific.toFixed(3) }} kg/m³</span
            >
          </div>
        </div>
      </div>

      <!-- 实时推送 Tab -->
      <div v-if="activeTab === 'stream'" class="panel-section">
        <div class="panel-section-title">实时数据推送</div>
        <div class="controls-row">
          <label class="radio-label">
            <input
              type="radio"
              value="local"
              :checked="streamMode === 'local'"
              @change="onStreamModeChange('local')"
            />
            本地模拟推送
          </label>
          <label class="radio-label">
            <input
              type="radio"
              value="websocket"
              :checked="streamMode === 'websocket'"
              @change="onStreamModeChange('websocket')"
            />
            WebSocket 实时推送
          </label>
        </div>
        <div v-if="streamMode === 'websocket'" class="controls-row mt-2">
          <el-input
            placeholder="ws://localhost:8080/blasting"
            :model-value="wsUrl"
            size="small"
            @update:model-value="onWsUrlChange"
          />
        </div>
        <div class="controls-row mt-2">
          <button class="compact-action-btn primary" :disabled="!dataset" @click="toggleStream">
            {{ streamStatus === 'streaming' ? '停止推送' : '启动推送' }}
          </button>
          <span class="status-text" :class="streamStatusClass">
            {{ streamStatusLabel }}
          </span>
        </div>
        <div class="hint-text mt-2">
          本地模式使用内置数值模拟引擎按帧推送；WebSocket 模式连接外部传感器/计算节点。
        </div>
      </div>

      <!-- 粒子统计 Tab -->
      <div v-if="activeTab === 'particles'" class="panel-section">
        <div class="panel-section-title">粒子系统统计</div>
        <div class="stat-item">
          <span>事件名称</span><span class="stat-value">{{ eventName }}</span>
        </div>
        <div class="stat-item">
          <span>粒子总数</span><span class="stat-value">{{ summary.particleCount }}</span>
        </div>
        <div class="stat-item">
          <span>碎片数量</span><span class="stat-value">{{ summary.fragmentCount }}</span>
        </div>
        <div class="stat-item">
          <span>总帧数</span><span class="stat-value">{{ summary.frameCount }}</span>
        </div>
        <div class="stat-item">
          <span>持续时间</span><span class="stat-value">{{ summary.durationSec }} s</span>
        </div>
        <div class="stat-item">
          <span>最大冲击半径</span><span class="stat-value">{{ summary.maxWaveRadius }} m</span>
        </div>
        <div class="stat-item">
          <span>峰值振动速度</span><span class="stat-value">{{ summary.peakVibration }} m/s</span>
        </div>
        <div class="stat-item">
          <span>炮孔数量</span><span class="stat-value">{{ summary.holeCount || 0 }}</span>
        </div>
        <div class="stat-item">
          <span>落石设计数量</span><span class="stat-value">{{ summary.rockBlockCount || 0 }}</span>
        </div>

        <!-- 当前帧实时统计 -->
        <div v-if="currentStats" class="mt-3">
          <div class="panel-subtitle">当前帧实时数据</div>
          <div class="stat-item">
            <span>活跃粒子</span><span class="stat-value">{{ currentStats.aliveCount }}</span>
          </div>
          <div class="stat-item">
            <span>已落地</span><span class="stat-value">{{ currentStats.landedCount }}</span>
          </div>
          <div class="stat-item">
            <span>最大飞溅距离</span
            ><span class="stat-value">{{ currentStats.maxDistance }} m</span>
          </div>
          <div class="stat-item">
            <span>最大速度</span><span class="stat-value">{{ currentStats.maxSpeed }} m/s</span>
          </div>
          <div class="stat-item">
            <span>系统总能量</span><span class="stat-value">{{ currentStats.totalEnergy }} J</span>
          </div>
        </div>
      </div>

      <!-- 应力演化 Tab -->
      <div v-if="activeTab === 'stress'" class="panel-section">
        <div class="panel-section-title">应力演化分析</div>

        <!-- 汇总统计 -->
        <div class="stat-item">
          <span>峰值应力 (Mises)</span>
          <span class="stat-value">{{ summary.peakStress }} MPa</span>
        </div>
        <div class="stat-item">
          <span>最小安全系数</span>
          <span class="stat-value" :class="safetyClass(summary.minSafetyFactor)">
            {{ summary.minSafetyFactor }}
          </span>
        </div>

        <!-- 当前帧应力列表 -->
        <div class="mt-3">
          <div class="panel-subtitle">当前帧监测点应力</div>
          <div v-if="currentStressList.length === 0" class="hint-text">暂无应力数据</div>
          <div v-else class="stress-table">
            <div class="stress-row stress-header">
              <span>监测点</span>
              <span>Mises</span>
              <span>安全系数</span>
              <span>等级</span>
            </div>
            <div
              v-for="s in currentStressList"
              :key="s.pointId"
              class="stress-row"
              :class="`safety-${s.safetyLevel}`"
              @click="selectMonitorPoint(s.pointId)"
            >
              <span>{{ s.pointLabel }}</span>
              <span class="stat-value">{{ s.mises }}</span>
              <span class="stat-value">{{ s.safetyFactor }}</span>
              <span class="safety-badge" :class="`badge-${s.safetyLevel}`">{{
                s.safetyLabel
              }}</span>
            </div>
          </div>
        </div>

        <!-- 监测点应力汇总 -->
        <div class="mt-3">
          <div class="panel-subtitle">监测点峰值汇总</div>
          <div v-if="stressSummaryList.length === 0" class="hint-text">暂无汇总数据</div>
          <div v-else class="stress-table">
            <div class="stress-row stress-header">
              <span>监测点</span>
              <span>峰值Mises</span>
              <span>最小FS</span>
              <span>等级</span>
            </div>
            <div
              v-for="s in stressSummaryList"
              :key="s.id"
              class="stress-row"
              :class="`safety-${s.safetyLevel}`"
              @click="selectMonitorPoint(s.id)"
            >
              <span>{{ s.label }}</span>
              <span class="stat-value">{{ s.peakMises }}</span>
              <span class="stat-value">{{ s.minSafety }}</span>
              <span class="safety-badge" :class="`badge-${s.safetyLevel}`">{{
                s.safetyLabel
              }}</span>
            </div>
          </div>
        </div>

        <!-- 选中点的应力时程图 -->
        <div v-if="showStressChart && selectedPointHistory.length > 0" class="mt-3">
          <div class="panel-subtitle">应力时程：{{ selectedPointHistory[0]?.pointLabel }}</div>
          <div class="stress-chart">
            <svg :viewBox="`0 0 ${chartWidth} ${chartHeight}`" class="stress-chart-svg">
              <!-- 网格线 -->
              <line
                v-for="i in 5"
                :key="'grid-' + i"
                :x1="chartPadding"
                :x2="chartWidth - chartPadding"
                :y1="chartPadding + ((i - 1) * (chartHeight - 2 * chartPadding)) / 4"
                :y2="chartPadding + ((i - 1) * (chartHeight - 2 * chartPadding)) / 4"
                stroke="#333"
                stroke-width="0.5"
                stroke-dasharray="2,2"
              />
              <!-- Mises 应力曲线 -->
              <polyline
                :points="misesChartPoints"
                fill="none"
                stroke="#e74c3c"
                stroke-width="1.5"
              />
              <!-- 安全系数曲线 -->
              <polyline
                :points="safetyChartPoints"
                fill="none"
                stroke="#3498db"
                stroke-width="1.5"
              />
              <!-- 坐标轴 -->
              <line
                :x1="chartPadding"
                :y1="chartHeight - chartPadding"
                :x2="chartWidth - chartPadding"
                :y2="chartHeight - chartPadding"
                stroke="#666"
                stroke-width="1"
              />
              <line
                :x1="chartPadding"
                :y1="chartPadding"
                :x2="chartPadding"
                :y2="chartHeight - chartPadding"
                stroke="#666"
                stroke-width="1"
              />
            </svg>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot red"></span>Mises (MPa)</span>
              <span class="legend-item"><span class="legend-dot blue"></span>安全系数</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '爆破模拟面板' })
import { computed } from 'vue'
import { useBlastingPanelController } from '../services/panel/useBlastingPanelController.js'

const {
  fileInput,
  activeTab,
  dataset,
  importStatus,
  isPlaying,
  currentFrame,
  maxFrame,
  playbackSpeedMs,
  summary,
  stressSummaryList,
  currentStats,
  currentStressList,
  streamStatus,
  streamStatusLabel,
  streamMode,
  wsUrl,
  showHeatmap,
  showMonitorPoints,
  showStressChart,
  selectedMonitorPoint,
  selectedPointHistory,
  eventName,
  // three.js 渲染
  threeStats,
  replayBlast,
  // 图层可见性与爆破设计
  LAYER_DEFS,
  layerVisibility,
  setLayerVisible,
  syncLayerVisibility,
  blastDesign,
  // MySQL 数据库事件
  dbEvents,
  dbLoading,
  currentEventId,
  renderConfigs,
  currentRenderConfig,
  selectedRenderConfig,
  loadDbEvents,
  loadDbEvent,
  applyRenderConfig,
  flyToCenter,
  onDbEventChange,
  onRenderConfigChange,
  loadExample,
  togglePlayback,
  clearSimulation,
  onFileChange,
  onFrameChange,
  onSpeedChange,
  onStreamModeChange,
  onWsUrlChange,
  toggleStream,
  toggleHeatmap,
  toggleMonitorPoints,
  selectMonitorPoint
} = useBlastingPanelController()

// 数据库事件选择处理
function onDbEventSelect(event) {
  const eventId = event?.target?.value
  if (eventId) onDbEventChange(eventId)
}

// 渲染配置选择处理
function onRenderConfigSelect(event) {
  const configName = event?.target?.value
  if (configName) onRenderConfigChange(configName)
}

const tabs = [
  { key: 'playback', label: '回放控制' },
  { key: 'visual', label: '视觉选项' },
  { key: 'design', label: '爆破设计' },
  { key: 'stream', label: '实时推送' },
  { key: 'particles', label: '粒子统计' },
  { key: 'stress', label: '应力演化' }
]

const streamStatusClass = computed(() => {
  const s = streamStatus.value
  if (s === 'streaming') return 'text-ok'
  if (s === 'error') return 'text-error'
  if (s === 'complete') return 'text-ok'
  return ''
})

function safetyClass(fs) {
  if (fs < 1) return 'text-error'
  if (fs < 1.5) return 'text-warning'
  return 'text-ok'
}

// 应力时程图参数
const chartWidth = 280
const chartHeight = 140
const chartPadding = 30

const misesChartPoints = computed(() => {
  if (selectedPointHistory.value.length === 0) return ''
  const data = selectedPointHistory.value
  const maxMises = Math.max(...data.map(d => d.mises), 1)
  const n = data.length
  return data
    .map((d, i) => {
      const x = chartPadding + (i / Math.max(1, n - 1)) * (chartWidth - 2 * chartPadding)
      const y = chartHeight - chartPadding - (d.mises / maxMises) * (chartHeight - 2 * chartPadding)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

const safetyChartPoints = computed(() => {
  if (selectedPointHistory.value.length === 0) return ''
  const data = selectedPointHistory.value
  const maxFs = Math.max(...data.map(d => d.safetyFactor), 10)
  const n = data.length
  return data
    .map((d, i) => {
      const x = chartPadding + (i / Math.max(1, n - 1)) * (chartWidth - 2 * chartPadding)
      const y =
        chartHeight - chartPadding - (d.safetyFactor / maxFs) * (chartHeight - 2 * chartPadding)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

// ─── 图层可见性控制 ────────────────────────────────
function onLayerToggle(layer, event) {
  const checked = event?.target?.checked
  setLayerVisible(layer, checked)
}

function setAllLayers(visible) {
  for (const def of LAYER_DEFS) {
    setLayerVisible(def.key, visible)
  }
}

// ─── 炮孔布置图（SVG）─────────────────────────────
// SVG 画布尺寸与坐标映射：将马蹄形断面（宽 W、高 totalH，单位 m）映射到 SVG 像素
const holeLayoutSize = 220
// SVG 留白边距，确保炮孔不贴边
const holeLayoutPadding = 16

// 计算断面在 SVG 中的实际绘制尺寸（按 W:totalH 比例缩放至画布内）
const holeLayoutScale = computed(() => {
  if (!blastDesign.value) return 1
  const W = blastDesign.value.section.W
  const H = blastDesign.value.section.totalH
  const usable = holeLayoutSize - holeLayoutPadding * 2
  return Math.min(usable / W, usable / H)
})

// 断面在 SVG 中的左上角偏移（居中）
const holeLayoutOffset = computed(() => {
  if (!blastDesign.value) return { x: 0, y: 0 }
  const W = blastDesign.value.section.W
  const H = blastDesign.value.section.totalH
  const s = holeLayoutScale.value
  return {
    x: (holeLayoutSize - W * s) / 2,
    y: (holeLayoutSize - H * s) / 2
  }
})

// 掌子面局部坐标 (x: 横向 m, y: 高度 m, 自底板起算) → SVG 坐标
function holeToSvgX(x) {
  const W = blastDesign.value?.section.W || 1
  const s = holeLayoutScale.value
  const off = holeLayoutOffset.value
  // x ∈ [-W/2, W/2] → [off.x, off.x + W*s]
  return off.x + (x + W / 2) * s
}
function holeToSvgY(y) {
  const s = holeLayoutScale.value
  const off = holeLayoutOffset.value
  // y 从底板起算，SVG y 轴向下 → 翻转
  const H = blastDesign.value?.section.totalH || 1
  return off.y + (H - y) * s
}

// 马蹄形断面轮廓 SVG path（直墙矩形 + 顶部半圆拱）
const tunnelOutlinePath = computed(() => {
  if (!blastDesign.value) return ''
  const { W, Hw, R, totalH } = blastDesign.value.section
  const xL = holeToSvgX(-W / 2)
  const xR = holeToSvgX(W / 2)
  const yBottom = holeToSvgY(0)
  const yWallTop = holeToSvgY(Hw)
  // 半圆拱：从左墙顶 → 右墙顶，半圆向上凸
  // SVG arc: A rx ry x-axis-rotation large-arc-flag sweep-flag x y
  const rx = (xR - xL) / 2
  return `M ${xL} ${yBottom} L ${xL} ${yWallTop} A ${rx} ${rx} 0 0 1 ${xR} ${yWallTop} L ${xR} ${yBottom} Z`
})

// 炮孔颜色（按类型）
function holeColor(h) {
  if (h.isEmpty) return '#ffffff'
  switch (h.type) {
    case 'cut':
      return '#ff6b6b'
    case 'auxiliary':
      return '#feca57'
    case 'perimeter':
      return '#1dd1a1'
    default:
      return '#888'
  }
}
</script>

<style scoped>
.blasting-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* ─── 事件状态横幅 ─── */
.event-banner {
  padding: 10px 14px;
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.15), rgba(231, 76, 60, 0.1));
  border: 1px solid rgba(64, 158, 255, 0.3);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.event-banner-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e5e7eb);
}

.event-banner-info {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
  font-family: 'Consolas', 'Monaco', monospace;
}

/* ─── 按钮样式 ─── */
.compact-action-btn {
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--text-primary, #e5e7eb);
  background: var(--bg-secondary, #374151);
  border: 1px solid var(--border-color, #4b5563);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.compact-action-btn:hover:not(:disabled) {
  background: var(--bg-tertiary, #4b5563);
  border-color: var(--primary-color, #409eff);
  transform: translateY(-1px);
}

.compact-action-btn:active:not(:disabled) {
  transform: translateY(0);
}

.compact-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.compact-action-btn.primary {
  background: var(--primary-color, #409eff);
  border-color: var(--primary-color, #409eff);
  color: #fff;
}

.compact-action-btn.primary:hover:not(:disabled) {
  background: #5b8def;
  border-color: #5b8def;
}

.compact-action-btn.danger {
  background: var(--danger-color, #e74c3c);
  border-color: var(--danger-color, #e74c3c);
  color: #fff;
}

.compact-action-btn.danger:hover:not(:disabled) {
  background: #ef5f50;
  border-color: #ef5f50;
}

/* ─── 通用布局 ─── */
.controls-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.hint-text {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary, #9ca3af);
  line-height: 1.5;
}

.text-ok {
  color: var(--success-color, #2ecc71);
}
.text-error {
  color: var(--danger-color, #e74c3c);
}
.text-warning {
  color: #f39c12;
}

.status-text {
  font-size: 12px;
  color: var(--text-secondary, #9ca3af);
  font-family: monospace;
}

/* ─── 统计项 ─── */
.stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.stat-item:last-child {
  border-bottom: none;
}

.stat-value {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  color: var(--text-primary, #e5e7eb);
}

.panel-subtitle {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  margin-top: 4px;
  color: var(--text-primary, #e5e7eb);
  padding-left: 8px;
  border-left: 3px solid var(--primary-color, #409eff);
}

/* ─── Tab 样式 ─── */
.tab-bar {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border-color, #333);
  padding-bottom: 0;
}

.tab-btn {
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--text-secondary, #9ca3af);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  border-radius: 4px 4px 0 0;
}

.tab-btn:hover {
  color: var(--text-primary, #e5e7eb);
  background: rgba(255, 255, 255, 0.03);
}

.tab-btn.active {
  color: var(--primary-color, #409eff);
  border-bottom-color: var(--primary-color, #409eff);
  font-weight: 600;
}

/* ─── 开关与单选 ─── */
.toggle-label,
.radio-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}

.toggle-label input,
.radio-label input {
  margin: 0;
  cursor: pointer;
}

/* ─── 视觉选项：图层网格 ─── */
.layer-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 10px;
  margin-top: 8px;
}

.layer-toggle {
  padding: 4px 6px;
  background: var(--bg-secondary, #1f2937);
  border: 1px solid var(--border-color, #374151);
  border-radius: 4px;
  transition: border-color 0.15s, background 0.15s;
}

.layer-toggle:hover {
  border-color: var(--primary-color, #409eff);
}

/* ─── 爆破设计：炮孔布置图 SVG ─── */
.hole-layout-wrap {
  margin-top: 8px;
  padding: 8px;
  background: var(--bg-secondary, #1f2937);
  border: 1px solid var(--border-color, #374151);
  border-radius: 6px;
  display: flex;
  justify-content: center;
}

.hole-layout-svg {
  width: 100%;
  max-width: 260px;
  height: auto;
}

.hole-legend text {
  font-family: 'Consolas', 'Microsoft YaHei', sans-serif;
}

/* ─── 数据库事件选择器 ─── */
.db-event-select {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  font-size: 12px;
  background: var(--bg-secondary, #1f2937);
  color: var(--text-primary, #e5e7eb);
  border: 1px solid var(--border-color, #374151);
  border-radius: 5px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.db-event-select:hover {
  border-color: var(--primary-color, #409eff);
}

.db-event-select:focus {
  outline: none;
  border-color: var(--primary-color, #409eff);
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
}

.db-event-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ─── 应力表格 ─── */
.stress-table {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
}

.stress-row {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr 0.8fr 0.6fr;
  gap: 4px;
  padding: 5px 6px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
  align-items: center;
}

.stress-row:hover {
  background: rgba(64, 158, 255, 0.08);
}

.stress-header {
  font-weight: 600;
  color: var(--text-secondary, #9ca3af);
  cursor: default;
  border-bottom: 1px solid var(--border-color, #333);
  margin-bottom: 2px;
}

.stress-header:hover {
  background: transparent;
}

.safety-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}

.badge-safe {
  background: #2ecc71;
  color: #fff;
}
.badge-watch {
  background: #f1c40f;
  color: #333;
}
.badge-warning {
  background: #e67e22;
  color: #fff;
}
.badge-danger {
  background: #e74c3c;
  color: #fff;
}
.badge-critical {
  background: #c0392b;
  color: #fff;
}

/* ─── 应力图表 ─── */
.stress-chart {
  margin-top: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  padding: 6px;
}

.stress-chart-svg {
  width: 100%;
  height: auto;
}

.chart-legend {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: 11px;
  justify-content: center;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.legend-dot.red {
  background: #e74c3c;
}
.legend-dot.blue {
  background: #3498db;
}
</style>
