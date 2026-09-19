<template>
  <div class="lod-panel">
    <!-- ====== 状态栏 ====== -->
    <div class="status-bar">
      <div class="status-left">
        <div class="status-chip" :class="modelLoaded ? 'active' : 'idle'">
          <span class="status-dot" />{{ modelLoaded ? '已加载' : '等待模型' }}
        </div>
        <div class="status-chip" :class="dirty ? 'warn' : 'idle'">
          <span class="status-dot" />{{ dirty ? '未应用' : '已应用' }}
        </div>
      </div>
      <div class="status-right">
        <span class="metric-pill">{{ detailTierLabel }}</span>
        <span class="metric-pill mono">FPS {{ fps }}</span>
        <span class="metric-pill mono">MEM {{ memoryMb }}MB</span>
        <span class="metric-pill" :class="adaptiveLoadState.level > 0 ? 'warn' : ''">
          {{ adaptiveLoadState.level > 0 ? '降载' : '正常' }}
        </span>
      </div>
    </div>

    <!-- ====== 预设 ====== -->
    <section class="panel-card">
      <div class="card-header">
        <span class="header-icon">🎯</span>
        <span class="header-title">预设方案</span>
        <span class="header-badge">{{ currentPresetLabel }}</span>
      </div>
      <div class="preset-group">
        <button
          v-for="p in presetOptions"
          :key="p.key"
          class="preset-btn"
          :class="{ active: presetKey === p.key }"
          @click="applyPreset(p.key)"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="card-sub">
        请求状态：<span class="accent">{{ requestStageLabel }}</span>
      </div>
    </section>

    <!-- ====== 模型内覆盖 ====== -->
    <section class="panel-card">
      <div class="card-header">
        <span class="header-icon">🎨</span>
        <span class="header-title">可视化覆盖</span>
      </div>
      <div class="viz-mode-group">
        <button
          v-for="opt in visualizationModeOptions"
          :key="opt.key"
          class="viz-mode-btn"
          :class="{ active: currentVisualizationMode === opt.key }"
          @click="setVisualizationMode(opt.key)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="card-sub">
        {{ visualizationModeOptions.find(item => item.key === currentVisualizationMode)?.hint }}
      </div>
      <div class="stage-legend">
        <div
          v-for="stage in stageLegend"
          :key="stage.key"
          class="legend-chip"
          :style="{ '--c': stage.color }"
        >
          <span class="legend-swatch" :style="{ background: stage.color }" />
          <span class="legend-label">{{ stage.label }}</span>
        </div>
      </div>
    </section>

    <!-- ====== 渲染增强 ====== -->
    <section class="panel-card render-enhancement-card">
      <div class="card-header">
        <span class="header-icon">✨</span>
        <span class="header-title">渲染增强</span>
        <span
          class="header-badge"
          :class="renderEnhancementState.config.enabled ? 'active' : 'idle'"
        >
          {{ renderEnhancementState.config.enabled ? '已启用' : '已关闭' }}
        </span>
      </div>
      <div class="card-sub">环境光遮蔽 + 太阳光照 + 阴影，凸显单色模型的几何细节</div>

      <!-- 总开关 -->
      <div class="render-master-toggle">
        <span class="render-master-label">总开关</span>
        <el-switch
          :model-value="renderEnhancementState.config.enabled"
          size="small"
          @update:model-value="v => setRenderEnhancementEnabled(v)"
        />
      </div>

      <!-- 各效果折叠面板 -->
      <el-collapse v-model="renderOpenIds" class="param-collapse">
        <el-collapse-item
          v-for="group in renderEffectGroups"
          :key="group.id"
          :name="group.id"
          class="param-group"
        >
          <template #title>
            <div class="param-group-title">
              <span class="param-group-icon">{{ group.icon }}</span>
              <span class="param-group-name">{{ group.title }}</span>
              <span
                class="effect-state-dot"
                :class="renderEnhancementState.config[group.effectKey]?.enabled ? 'on' : 'off'"
              />
            </div>
          </template>
          <div class="param-fields">
            <!-- 单项开关 -->
            <div class="param-field">
              <div class="field-info">
                <span class="field-label">启用</span>
              </div>
              <div class="field-control">
                <el-switch
                  :model-value="renderEnhancementState.config[group.effectKey]?.enabled"
                  size="small"
                  :disabled="!renderEnhancementState.config.enabled"
                  @update:model-value="v => setRenderEffectEnabled(group.effectKey, v)"
                />
              </div>
            </div>
            <!-- 参数字段 -->
            <div v-for="field in group.fields" :key="field.key" class="param-field">
              <div class="field-info">
                <div class="field-label-row">
                  <span class="field-label">{{ field.label }}</span>
                  <el-tooltip
                    v-if="field.hint"
                    :content="field.hint"
                    placement="top"
                    effect="dark"
                    :show-after="300"
                  >
                    <el-icon class="field-hint-icon"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <span v-if="field.type !== 'checkbox'" class="field-value">
                  {{ formatRenderParam(field, getRenderEffectValue(group.effectKey, field.key)) }}
                </span>
              </div>
              <div class="field-control">
                <el-switch
                  v-if="field.type === 'checkbox'"
                  :model-value="Boolean(getRenderEffectValue(group.effectKey, field.key))"
                  size="small"
                  :disabled="
                    !renderEnhancementState.config.enabled ||
                    !renderEnhancementState.config[group.effectKey]?.enabled
                  "
                  @update:model-value="v => onRenderEffectParamChange(group.effectKey, field, v)"
                />
                <template v-else>
                  <el-slider
                    class="field-slider"
                    :disabled="
                      !renderEnhancementState.config.enabled ||
                      !renderEnhancementState.config[group.effectKey]?.enabled
                    "
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :model-value="Number(getRenderEffectValue(group.effectKey, field.key) || 0)"
                    @update:model-value="v => onRenderEffectParamChange(group.effectKey, field, v)"
                  />
                  <el-input-number
                    class="field-input"
                    :disabled="
                      !renderEnhancementState.config.enabled ||
                      !renderEnhancementState.config[group.effectKey]?.enabled
                    "
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :controls="false"
                    :model-value="Number(getRenderEffectValue(group.effectKey, field.key) || 0)"
                    @update:model-value="v => onRenderEffectParamChange(group.effectKey, field, v)"
                  />
                </template>
              </div>
            </div>
            <div class="render-hint">{{ group.hint }}</div>
          </div>
        </el-collapse-item>
      </el-collapse>

      <div class="action-row">
        <button class="action-btn ghost" @click="resetRenderEnhancement">重置渲染增强</button>
      </div>
    </section>

    <!-- ====== 参数 ====== -->
    <section class="panel-card">
      <div class="card-header">
        <span class="header-icon">⚙️</span>
        <span class="header-title">参数</span>
      </div>
      <el-collapse v-model="openGroupIds" class="param-collapse">
        <el-collapse-item
          v-for="group in groups"
          :key="group.id"
          :name="group.id"
          class="param-group"
        >
          <template #title>
            <div class="param-group-title">
              <span class="param-group-icon">{{ groupIcons[group.id] || '•' }}</span>
              <span class="param-group-name">{{ group.title }}</span>
            </div>
          </template>
          <div class="param-fields">
            <div v-for="field in group.fields" :key="field.key" class="param-field">
              <div class="field-info">
                <div class="field-label-row">
                  <span class="field-label">{{ field.label }}</span>
                  <el-tooltip
                    v-if="field.hint"
                    :content="getFieldHint(field)"
                    placement="top"
                    effect="dark"
                    :show-after="300"
                  >
                    <el-icon class="field-hint-icon"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <span v-if="field.type !== 'checkbox'" class="field-value"
                  >{{ formatField(field)
                  }}<span v-if="field.type === 'bytes_mb'" class="field-unit">MB</span></span
                >
              </div>
              <div class="field-control">
                <el-switch
                  v-if="field.type === 'checkbox'"
                  :model-value="Boolean(local[field.key])"
                  size="small"
                  :disabled="isFieldDisabled(field)"
                  @update:model-value="v => setFieldBoolean(field, v)"
                />
                <template v-else>
                  <el-slider
                    class="field-slider"
                    :disabled="isFieldDisabled(field)"
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :model-value="getFieldNumber(field)"
                    @update:model-value="v => setFieldNumber(field, v)"
                  />
                  <el-input-number
                    class="field-input"
                    :disabled="isFieldDisabled(field)"
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :controls="false"
                    :model-value="getFieldNumber(field)"
                    @update:model-value="v => setFieldNumber(field, v)"
                  />
                </template>
              </div>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </section>

    <!-- ====== 操作 ====== -->
    <section class="panel-card">
      <div class="action-row">
        <button class="action-btn primary" :disabled="!modelLoaded || !dirty" @click="apply">
          应用到场景
        </button>
        <button class="action-btn ghost" :disabled="!dirty" @click="rollback">撤销</button>
        <button class="action-btn ghost" @click="reset">默认</button>
      </div>
    </section>

    <!-- ====== LOD 实时观测 ====== -->
    <section class="panel-card">
      <div class="card-header">
        <span class="header-icon">📊</span>
        <span class="header-title">实时观测</span>
        <span class="header-pulse" :class="{ live: (lodRuntime.pendingRequests || 0) > 0 }" />
      </div>

      <!-- 核心指标：一行四列 -->
      <div class="kpi-row">
        <div class="kpi-card">
          <div class="kpi-label">主导阶段</div>
          <div class="kpi-value" :style="{ color: STAGE_COLORS[dominantStageKey] || '#ccc' }">
            {{ lodRuntime.dominantLodStage }}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">复杂度</div>
          <div class="kpi-value" :class="complexityClass">
            {{ lodComplexityIndex }}<span class="kpi-unit">/100</span>
          </div>
          <div class="kpi-bar">
            <div
              class="kpi-bar-fill"
              :class="complexityClass"
              :style="{ width: lodComplexityIndex + '%' }"
            />
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">三角面</div>
          <div class="kpi-value mono">{{ fmtNum(lodRuntime.trianglesSelected) }}</div>
          <div class="kpi-sub">峰值 {{ Math.round(trianglesTier.ratio * 100) }}%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">可见瓦片</div>
          <div class="kpi-value mono">{{ fmtNum(lodRuntime.selectedTiles) }}</div>
          <div class="kpi-sub">就绪 {{ tilesReadyRatioLabel }}</div>
        </div>
      </div>

      <!-- 阶段分布 + SSE 范围同行 -->
      <div class="obs-row-2">
        <div class="obs-block">
          <div class="section-label">阶段分布</div>
          <div class="stage-bars">
            <div v-for="item in stageDistribution" :key="item.key" class="stage-row">
              <span class="stage-key" :style="{ color: item.color }">{{
                item.key.replace('s', 'S')
              }}</span>
              <div class="stage-track">
                <div
                  class="stage-fill"
                  :style="{ width: Math.max(item.percent, 1.5) + '%', background: item.color }"
                />
              </div>
              <span class="stage-num">{{ item.percent }}%</span>
            </div>
          </div>
        </div>
        <div class="obs-block">
          <div class="section-label">SSE 范围</div>
          <div class="sse-list">
            <div class="sse-row">
              <span class="sse-tag">最小</span
              ><span class="sse-val">{{ screenSpaceErrorRange.min }}</span>
            </div>
            <div class="sse-row">
              <span class="sse-tag">平均</span
              ><span class="sse-val primary">{{ screenSpaceErrorRange.avg }}</span>
            </div>
            <div class="sse-row">
              <span class="sse-tag">最大</span
              ><span class="sse-val">{{ screenSpaceErrorRange.max }}</span>
            </div>
          </div>
          <div class="section-label mt-3">核心指标</div>
          <div class="mini-metrics">
            <div class="mini-item">
              <span class="mini-label">渲染命令</span
              ><span class="mini-val">{{ fmtNum(lodRuntime.commands) }}</span>
            </div>
            <div class="mini-item">
              <span class="mini-label">要素数</span
              ><span class="mini-val">{{ fmtNum(lodRuntime.featuresSelected) }}</span>
            </div>
            <div class="mini-item">
              <span class="mini-label">点数</span
              ><span class="mini-val">{{ fmtNum(lodRuntime.pointsSelected) }}</span>
            </div>
            <div class="mini-item">
              <span class="mini-label">内存</span><span class="mini-val">{{ memoryMb }}MB</span>
            </div>
          </div>
        </div>
      </div>

      <div class="obs-footer">可视化：{{ lodVisualSummary }}</div>
    </section>

    <!-- ====== 几何误差分布 ====== -->
    <section v-if="geometricErrorDistribution.length > 0" class="panel-card">
      <div class="card-header">
        <span class="header-icon">📈</span>
        <span class="header-title">几何误差分布</span>
      </div>
      <div class="histogram">
        <div
          v-for="(bucket, idx) in geometricErrorDistribution"
          :key="idx"
          class="histo-bar-wrap"
          :style="{
            height: maxBucketCount > 0 ? (bucket.count / maxBucketCount) * 100 + '%' : '0%'
          }"
        >
          <el-tooltip
            :content="`${bucket.rangeMin} ~ ${bucket.rangeMax}: ${bucket.count} tiles`"
            placement="top"
            effect="dark"
          >
            <div class="histo-bar" :style="{ '--hue': 210 - idx * 15 }" />
          </el-tooltip>
        </div>
      </div>
      <div class="histo-labels">
        <span>{{ geometricErrorDistribution[0]?.rangeMin || 0 }}</span>
        <span>{{
          geometricErrorDistribution[geometricErrorDistribution.length - 1]?.rangeMax || 0
        }}</span>
      </div>
    </section>

    <!-- ====== 瓦片详情 ====== -->
    <section v-if="tileDetailList.length > 0" class="panel-card">
      <div class="card-header">
        <span class="header-icon">🧩</span>
        <span class="header-title">瓦片详情</span>
        <span class="header-badge outline">{{ tileDetailList.length }}</span>
      </div>
      <div class="tile-list">
        <div v-for="tile in tileDetailList.slice(0, 8)" :key="tile.tileId" class="tile-card">
          <div class="tile-head">
            <span class="tile-dot" :style="{ background: STAGE_COLORS[tile.stageKey] || '#888' }" />
            <span class="tile-stage">{{ tile.stageLabel }}</span>
            <span class="tile-rank">#{{ tile.rank + 1 }}/{{ tile.totalTiles }}</span>
            <span v-if="!tile.contentReady" class="tile-pending">未就绪</span>
          </div>
          <div class="tile-meta">
            <span>误差 {{ tile.geometricError }}</span>
            <span>SSE {{ tile.screenSpaceError }}</span>
            <span>深度 {{ tile.depth }}</span>
            <span>{{ tile.distanceToCamera }}m</span>
            <span>{{ tile.featuresLength }}要素</span>
            <span>{{ tile.contentType }}</span>
          </div>
          <div class="tile-bar">
            <div
              class="tile-bar-fill"
              :style="{
                width: Math.max((tile.combinedScore * 100).toFixed(1), 2) + '%',
                background: STAGE_COLORS[tile.stageKey] || '#888'
              }"
            />
          </div>
        </div>
      </div>
    </section>

    <!-- ====== 运行状态（紧凑） ====== -->
    <section class="panel-card">
      <div class="card-header">
        <span class="header-icon">🖥️</span>
        <span class="header-title">运行状态</span>
      </div>
      <div class="runtime-compact">
        <div class="rt-item">
          <span class="rt-label">请求</span>
          <span class="rt-val">{{ lodRuntime.pendingRequests || 0 }}</span>
          <span
            class="rt-dot"
            :class="
              (lodRuntime.pendingRequests || 0) > 8
                ? 'high'
                : (lodRuntime.pendingRequests || 0) > 3
                  ? 'mid'
                  : 'low'
            "
          />
        </div>
        <div class="rt-item">
          <span class="rt-label">处理</span>
          <span class="rt-val">{{ lodRuntime.tilesProcessing || 0 }}</span>
          <span
            class="rt-dot"
            :class="
              (lodRuntime.tilesProcessing || 0) > 4
                ? 'high'
                : (lodRuntime.tilesProcessing || 0) > 1
                  ? 'mid'
                  : 'low'
            "
          />
        </div>
        <div class="rt-item">
          <span class="rt-label">视角</span>
          <span class="rt-val">{{ requestStageLabel }}</span>
        </div>
        <div class="rt-item">
          <span class="rt-label">降载</span>
          <span class="rt-val" :class="adaptiveLoadState.level > 0 ? 'warn' : ''">{{
            adaptiveStatusLabel
          }}</span>
        </div>
        <div class="rt-item">
          <span class="rt-label">压力</span>
          <span class="rt-val" :class="pressureClass">{{ adaptivePressureLabel }}</span>
        </div>
        <div v-if="adaptiveLoadState.lastReason" class="rt-item">
          <span class="rt-label">最近</span>
          <span class="rt-val small">{{ adaptiveLoadState.lastReason }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { InfoFilled } from '@element-plus/icons-vue'
import { useLodPanelController, STAGE_COLORS } from '../services/panel/useLodPanelController.js'
import { useLodRenderEnhancement } from './useLodRenderEnhancement.js'
import { useLodRuntimeDisplay } from './useLodRuntimeDisplay.js'

defineOptions({ name: 'LOD优化面板' })

const {
  modelLoaded,
  dirty,
  fps,
  memoryMb,
  presetKey,
  presetOptions,
  currentPresetLabel,
  detailTierLabel,
  requestStageLabel,
  adaptiveStatusLabel,
  adaptivePressureLabel,
  tilesReadyRatioLabel,
  lodVisualSummary,
  lodComplexityIndex,
  trianglesTier,
  stageDistribution,
  stageLegend,
  visualizationModeOptions,
  currentVisualizationMode,
  openGroupIds,
  groups,
  local,
  lodRuntime,
  adaptiveLoadState,
  tileDetailList,
  geometricErrorDistribution,
  screenSpaceErrorRange,
  maxBucketCount,
  applyPreset,
  formatField,
  getFieldNumber,
  getFieldHint,
  isFieldDisabled,
  setVisualizationMode,
  setFieldNumber,
  setFieldBoolean,
  apply,
  rollback,
  reset,
  renderEnhancementState,
  setRenderEnhancementEnabled,
  setRenderEffectEnabled,
  setRenderEffectParam,
  resetRenderEnhancement
} = useLodPanelController()

const groupIcons = {
  quality: '📐',
  dynamic: '🌊',
  foveated: '👁️',
  skip: '⏭️',
  culling: '✂️',
  visual: '🔍'
}

const {
  renderOpenIds,
  renderEffectGroups,
  getRenderEffectValue,
  onRenderEffectParamChange,
  formatRenderParam
} = useLodRenderEnhancement({ renderEnhancementState, setRenderEffectParam })

const { dominantStageKey, complexityClass, pressureClass, fmtNum } = useLodRuntimeDisplay({
  lodRuntime,
  lodComplexityIndex,
  adaptivePressureLabel
})
</script>

<style scoped src="./lodPanel.css"></style>
