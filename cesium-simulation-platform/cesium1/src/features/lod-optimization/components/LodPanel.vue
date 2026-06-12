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
        >{{ p.label }}</button>
      </div>
      <div class="card-sub">请求状态：<span class="accent">{{ requestStageLabel }}</span></div>
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
        >{{ opt.label }}</button>
      </div>
      <div class="card-sub">{{ visualizationModeOptions.find(item => item.key === currentVisualizationMode)?.hint }}</div>
      <div class="stage-legend">
        <div v-for="stage in stageLegend" :key="stage.key" class="legend-chip" :style="{ '--c': stage.color }">
          <span class="legend-swatch" :style="{ background: stage.color }" />
          <span class="legend-label">{{ stage.label }}</span>
        </div>
      </div>
    </section>

    <!-- ====== 参数 ====== -->
    <section class="panel-card">
      <div class="card-header">
        <span class="header-icon">⚙️</span>
        <span class="header-title">参数</span>
      </div>
      <el-collapse v-model="openGroupIds" class="param-collapse">
        <el-collapse-item v-for="group in groups" :key="group.id" :name="group.id" class="param-group">
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
                  <el-tooltip v-if="field.hint" :content="getFieldHint(field)" placement="top" effect="dark" :show-after="300">
                    <el-icon class="field-hint-icon"><InfoFilled /></el-icon>
                  </el-tooltip>
                </div>
                <span v-if="field.type !== 'checkbox'" class="field-value">{{ formatField(field) }}<span v-if="field.type === 'bytes_mb'" class="field-unit">MB</span></span>
              </div>
              <div class="field-control">
                <el-switch v-if="field.type === 'checkbox'" :model-value="Boolean(local[field.key])" size="small" :disabled="isFieldDisabled(field)" @update:model-value="v => setFieldBoolean(field, v)" />
                <template v-else>
                  <el-slider class="field-slider" :disabled="isFieldDisabled(field)" :min="field.min" :max="field.max" :step="field.step" :model-value="getFieldNumber(field)" @update:model-value="v => setFieldNumber(field, v)" />
                  <el-input-number class="field-input" :disabled="isFieldDisabled(field)" :min="field.min" :max="field.max" :step="field.step" :controls="false" :model-value="getFieldNumber(field)" @update:model-value="v => setFieldNumber(field, v)" />
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
        <button class="action-btn primary" :disabled="!modelLoaded || !dirty" @click="apply">应用到场景</button>
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
          <div class="kpi-value" :style="{ color: STAGE_COLORS[dominantStageKey] || '#ccc' }">{{ lodRuntime.dominantLodStage }}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">复杂度</div>
          <div class="kpi-value" :class="complexityClass">{{ lodComplexityIndex }}<span class="kpi-unit">/100</span></div>
          <div class="kpi-bar"><div class="kpi-bar-fill" :class="complexityClass" :style="{ width: lodComplexityIndex + '%' }" /></div>
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
              <span class="stage-key" :style="{ color: item.color }">{{ item.key.replace('s', 'S') }}</span>
              <div class="stage-track"><div class="stage-fill" :style="{ width: Math.max(item.percent, 1.5) + '%', background: item.color }" /></div>
              <span class="stage-num">{{ item.percent }}%</span>
            </div>
          </div>
        </div>
        <div class="obs-block">
          <div class="section-label">SSE 范围</div>
          <div class="sse-list">
            <div class="sse-row"><span class="sse-tag">最小</span><span class="sse-val">{{ screenSpaceErrorRange.min }}</span></div>
            <div class="sse-row"><span class="sse-tag">平均</span><span class="sse-val primary">{{ screenSpaceErrorRange.avg }}</span></div>
            <div class="sse-row"><span class="sse-tag">最大</span><span class="sse-val">{{ screenSpaceErrorRange.max }}</span></div>
          </div>
          <div class="section-label mt-3">核心指标</div>
          <div class="mini-metrics">
            <div class="mini-item"><span class="mini-label">渲染命令</span><span class="mini-val">{{ fmtNum(lodRuntime.commands) }}</span></div>
            <div class="mini-item"><span class="mini-label">要素数</span><span class="mini-val">{{ fmtNum(lodRuntime.featuresSelected) }}</span></div>
            <div class="mini-item"><span class="mini-label">点数</span><span class="mini-val">{{ fmtNum(lodRuntime.pointsSelected) }}</span></div>
            <div class="mini-item"><span class="mini-label">内存</span><span class="mini-val">{{ memoryMb }}MB</span></div>
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
        <div v-for="(bucket, idx) in geometricErrorDistribution" :key="idx" class="histo-bar-wrap" :style="{ height: maxBucketCount > 0 ? (bucket.count / maxBucketCount * 100) + '%' : '0%' }">
          <el-tooltip :content="`${bucket.rangeMin} ~ ${bucket.rangeMax}: ${bucket.count} tiles`" placement="top" effect="dark">
            <div class="histo-bar" :style="{ '--hue': 210 - idx * 15 }" />
          </el-tooltip>
        </div>
      </div>
      <div class="histo-labels">
        <span>{{ geometricErrorDistribution[0]?.rangeMin || 0 }}</span>
        <span>{{ geometricErrorDistribution[geometricErrorDistribution.length - 1]?.rangeMax || 0 }}</span>
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
          <div class="tile-bar"><div class="tile-bar-fill" :style="{ width: Math.max((tile.combinedScore * 100).toFixed(1), 2) + '%', background: STAGE_COLORS[tile.stageKey] || '#888' }" /></div>
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
          <span class="rt-dot" :class="(lodRuntime.pendingRequests || 0) > 8 ? 'high' : (lodRuntime.pendingRequests || 0) > 3 ? 'mid' : 'low'" />
        </div>
        <div class="rt-item">
          <span class="rt-label">处理</span>
          <span class="rt-val">{{ lodRuntime.tilesProcessing || 0 }}</span>
          <span class="rt-dot" :class="(lodRuntime.tilesProcessing || 0) > 4 ? 'high' : (lodRuntime.tilesProcessing || 0) > 1 ? 'mid' : 'low'" />
        </div>
        <div class="rt-item">
          <span class="rt-label">视角</span>
          <span class="rt-val">{{ requestStageLabel }}</span>
        </div>
        <div class="rt-item">
          <span class="rt-label">降载</span>
          <span class="rt-val" :class="adaptiveLoadState.level > 0 ? 'warn' : ''">{{ adaptiveStatusLabel }}</span>
        </div>
        <div class="rt-item">
          <span class="rt-label">压力</span>
          <span class="rt-val" :class="pressureClass">{{ adaptivePressureLabel }}</span>
        </div>
        <div class="rt-item" v-if="adaptiveLoadState.lastReason">
          <span class="rt-label">最近</span>
          <span class="rt-val small">{{ adaptiveLoadState.lastReason }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import { useLodPanelController, STAGE_COLORS } from '../services/panel/useLodPanelController.js'

defineOptions({ name: 'LOD优化面板' })

const {
  modelLoaded, dirty, fps, memoryMb,
  presetKey, presetOptions, currentPresetLabel, detailTierLabel, requestStageLabel,
  adaptiveStatusLabel, adaptivePressureLabel, tilesReadyRatioLabel, lodVisualSummary,
  lodComplexityIndex, lodComplexityLabel,
  trianglesTier, visibleTilesTier, commandsTier,
  stageDistribution, stageLegend,
  visualizationModeOptions, currentVisualizationMode,
  lodMetricCards,
  openGroupIds, groups, local, lodRuntime, adaptiveLoadState,
  tileDetailList, geometricErrorDistribution, screenSpaceErrorRange,
  maxBucketCount,
  applyPreset, formatField, getFieldNumber, getFieldHint, isFieldDisabled,
  setVisualizationMode, setFieldNumber, setFieldBoolean,
  apply, rollback, reset
} = useLodPanelController()

const groupIcons = { quality: '📐', dynamic: '🌊', foveated: '👁️', skip: '⏭️', culling: '✂️', visual: '🔍' }

const dominantStageKey = computed(() => {
  const m = (lodRuntime.value?.dominantLodStage || 'S0').match(/S(\d)/i)
  return m ? `s${m[1]}` : 's0'
})

const complexityClass = computed(() => {
  const v = lodComplexityIndex.value
  return v >= 80 ? 'high' : v >= 50 ? 'mid' : 'low'
})

const pressureClass = computed(() => {
  if (adaptivePressureLabel.value === '高') return 'high'
  if (adaptivePressureLabel.value === '中') return 'mid'
  return 'low'
})

function fmtNum(v) {
  const n = Number(v) || 0
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(Math.round(n))
}
</script>

<style scoped>
.lod-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: #ddd;
  font-size: 12.5px;
  overflow-x: hidden;
  background: linear-gradient(180deg, rgba(15,18,25,0.3) 0%, rgba(12,15,20,0.5) 100%);
  min-height: 100%;
}

/* ---- 卡片 ---- */
.panel-card {
  background: rgba(255,255,255,0.022);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 9px;
  padding: 12px;
  transition: border-color 0.25s;
}
.panel-card:hover { border-color: rgba(255,255,255,0.1); }

.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.header-icon { font-size: 14px; line-height: 1; }
.header-title { font-size: 12.5px; font-weight: 600; color: #e6e6e6; letter-spacing: 0.02em; }
.header-badge {
  margin-left: auto;
  font-size: 9.5px;
  padding: 1.5px 7px;
  border-radius: 8px;
  background: rgba(64,158,255,0.12);
  color: #80b8ff;
  font-weight: 500;
}
.header-badge.outline { background: transparent; border: 1px solid rgba(255,255,255,0.12); color: #999; }
.header-pulse {
  margin-left: auto;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: rgba(255,255,255,0.15);
  transition: all 0.3s;
}
.header-pulse.live { background: #4caf50; box-shadow: 0 0 6px #4caf50; animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

.card-sub { font-size: 10.5px; color: #777; margin-top: 7px; }
.accent { color: #80b8ff; }

/* ---- 状态栏 ---- */
.status-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
}
.status-left, .status-right { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.status-chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 9px; border-radius: 12px;
  font-size: 10.5px; font-weight: 500;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(255,255,255,0.02);
  color: #999;
}
.status-chip.active { border-color: rgba(76,175,80,0.3); background: rgba(76,175,80,0.06); color: #81c784; }
.status-chip.warn { border-color: rgba(255,167,38,0.3); background: rgba(255,167,38,0.06); color: #ffb74d; }
.status-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.6; }
.status-chip.active .status-dot { box-shadow: 0 0 4px currentColor; }

.metric-pill {
  display: inline-flex; align-items: center; gap: 2px;
  height: 24px; padding: 0 8px; border-radius: 12px;
  font-size: 10px; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.05); color: #aaa; white-space: nowrap;
}
.metric-pill.mono { font-family: 'JetBrains Mono','Consolas',monospace; }
.metric-pill.warn { border-color: rgba(255,167,38,0.25); color: #ffb74d; }

/* ---- 预设 ---- */
.preset-group { display: flex; gap: 5px; flex-wrap: wrap; }
.preset-btn {
  flex: 1; min-width: 55px; height: 30px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.02);
  color: #aaa; font-size: 11.5px; cursor: pointer; transition: all 0.2s; font-weight: 500;
}
.preset-btn:hover { border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.05); color: #ddd; }
.preset-btn.active {
  background: rgba(64,158,255,0.12); border-color: rgba(64,158,255,0.35); color: #80b8ff;
  box-shadow: 0 0 8px rgba(64,158,255,0.08);
}

/* ---- 可视化模式 ---- */
.viz-mode-group { display: flex; gap: 4px; flex-wrap: wrap; }
.viz-mode-btn {
  flex: 1; min-width: 50px; height: 28px; border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02);
  color: #999; font-size: 10.5px; cursor: pointer; transition: all 0.2s; padding: 0 4px;
}
.viz-mode-btn:hover { border-color: rgba(255,255,255,0.14); color: #ccc; }
.viz-mode-btn.active {
  background: rgba(139,92,246,0.12); border-color: rgba(139,92,246,0.35); color: #a78bfa;
}

/* ---- 阶段图例 ---- */
.stage-legend {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin-top: 10px;
}
.legend-chip {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 6px 2px; border-radius: 6px;
  background: rgba(255,255,255,0.01); border: 1px solid rgba(255,255,255,0.04);
  transition: all 0.2s; position: relative; overflow: hidden;
}
.legend-chip::before { content:''; position:absolute; inset:0; background:var(--c); opacity:.03; transition:opacity .2s; }
.legend-chip:hover { border-color: rgba(255,255,255,0.14); transform: translateY(-1px); }
.legend-chip:hover::before { opacity:.08; }
.legend-swatch { width:100%; height:3px; border-radius:2px; }
.legend-label { font-size:10px; font-weight:600; font-family:'JetBrains Mono','Consolas',monospace; color:#ddd; }

/* ---- 参数 ---- */
.param-collapse { border: none !important; }
:deep(.param-collapse .el-collapse-item__header) { background:transparent!important; border:none!important; padding:0!important; height:auto!important; }
:deep(.param-collapse .el-collapse-item__wrap) { background:transparent!important; border:none!important; }
:deep(.param-collapse .el-collapse-item__content) { padding:0!important; padding-top:6px!important; }
.param-group { border:1px solid rgba(255,255,255,0.05)!important; border-radius:7px!important; margin-bottom:6px!important; overflow:hidden; background:rgba(255,255,255,0.01); transition:border-color .2s; }
.param-group:hover { border-color:rgba(255,255,255,0.12)!important; }
.param-group-title { display:flex; align-items:center; gap:8px; padding:8px 10px; width:100%; }
.param-group-icon { font-size:13px; line-height:1; }
.param-group-name { font-size:12px; font-weight:600; color:#e0e0e0; }
.param-fields { display:flex; flex-direction:column; gap:2px; padding:4px 10px 10px; background:rgba(0,0,0,0.12); border-radius:5px; margin:0 4px 6px; }
.param-field { padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.02); }
.param-field:last-child { border-bottom:none; }
.field-info { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
.field-label-row { display:flex; align-items:center; gap:4px; }
.field-label { font-size:11.5px; color:#ccc; }
.field-hint-icon { color:#666; font-size:13px; cursor:help; }
.field-value { font-size:10.5px; color:#80b8ff; font-family:'JetBrains Mono','Consolas',monospace; font-weight:500; }
.field-unit { color:#666; font-size:9px; }
.field-control { display:flex; align-items:center; gap:7px; }
.field-slider { flex:1; }
.field-input { width:66px!important; flex-shrink:0; }
:deep(.field-slider .el-slider__runway) { margin:4px 0!important; height:3px!important; }
:deep(.field-slider .el-slider__bar) { background:#409eff!important; height:3px!important; }
:deep(.field-slider .el-slider__button) { width:12px!important; height:12px!important; border-color:#409eff!important; background:#1a1a2e!important; }
:deep(.field-input .el-input__wrapper) { padding:0 5px!important; background:rgba(255,255,255,0.03)!important; box-shadow:none!important; border:1px solid rgba(255,255,255,0.09)!important; border-radius:4px!important; }
:deep(.field-input .el-input__inner) { height:26px!important; line-height:26px!important; font-size:10.5px!important; color:#ccc!important; text-align:center!important; }

/* ---- 操作 ---- */
.action-row { display:flex; gap:6px; }
.action-btn {
  height:32px; border-radius:6px; border:1px solid transparent;
  font-size:11.5px; font-weight:500; cursor:pointer; transition:all .2s; padding:0 14px;
}
.action-btn:disabled { opacity:.35; cursor:not-allowed; }
.action-btn.primary { flex:1; background:linear-gradient(135deg,#409eff,#3370c4); border-color:#409eff; color:#fff; }
.action-btn.primary:hover:not(:disabled) { background:linear-gradient(135deg,#5aafff,#4080d4); box-shadow:0 2px 10px rgba(64,158,255,0.25); }
.action-btn.ghost { background:transparent; border-color:rgba(255,255,255,0.08); color:#999; }
.action-btn.ghost:hover:not(:disabled) { background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.15); color:#ccc; }

/* ---- KPI 行 ---- */
.kpi-row { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-bottom:10px; }
.kpi-card {
  background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05);
  border-radius:7px; padding:10px; transition:border-color .2s;
}
.kpi-card:hover { border-color:rgba(255,255,255,0.12); }
.kpi-label { font-size:9.5px; color:#888; text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px; }
.kpi-value { font-size:16px; font-weight:700; font-family:'JetBrains Mono','Consolas',monospace; color:#e8e8e8; }
.kpi-value.mono { font-size:14px; }
.kpi-unit { font-size:10px; color:#777; font-weight:400; }
.kpi-sub { font-size:9px; color:#666; margin-top:2px; }
.kpi-bar { margin-top:5px; height:2.5px; border-radius:2px; background:rgba(255,255,255,0.05); overflow:hidden; }
.kpi-bar-fill { height:100%; border-radius:2px; transition:width .5s ease; }
.kpi-bar-fill.high { background:linear-gradient(90deg,#ff9800,#ef5350); }
.kpi-bar-fill.mid { background:linear-gradient(90deg,#ffc107,#ff9800); }
.kpi-bar-fill.low { background:linear-gradient(90deg,#4caf50,#8bc34a); }
.kpi-value.high { color:#ef5350; }
.kpi-value.mid { color:#ffa726; }
.kpi-value.low { color:#66bb6a; }

/* ---- 观测双列 ---- */
.obs-row-2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
.obs-block {
  background:rgba(255,255,255,0.015); border:1px solid rgba(255,255,255,0.04);
  border-radius:7px; padding:10px;
}
.section-label { font-size:10.5px; color:#999; margin-bottom:6px; letter-spacing:.03em; }

/* ---- 阶段分布 ---- */
.stage-bars { display:flex; flex-direction:column; gap:2.5px; }
.stage-row { display:grid; grid-template-columns:22px 1fr 30px; gap:6px; align-items:center; }
.stage-key { font-size:10px; font-weight:600; font-family:'JetBrains Mono','Consolas',monospace; text-align:right; }
.stage-track { height:4px; border-radius:2px; background:rgba(255,255,255,0.04); overflow:hidden; }
.stage-fill { height:100%; border-radius:2px; transition:width .6s cubic-bezier(.25,.8,.25,1.2); min-width:0; }
.stage-num { font-size:9px; color:#888; font-family:'JetBrains Mono','Consolas',monospace; text-align:right; }

/* ---- SSE ---- */
.sse-list { display:flex; flex-direction:column; gap:4px; }
.sse-row { display:flex; justify-content:space-between; align-items:center; padding:5px 8px; border-radius:5px; background:rgba(255,255,255,0.015); }
.sse-tag { font-size:10px; color:#888; text-transform:uppercase; letter-spacing:.04em; }
.sse-val { font-size:13px; font-weight:600; font-family:'JetBrains Mono','Consolas',monospace; color:#ddd; }
.sse-val.primary { color:#80b8ff; }

/* ---- 迷你指标 ---- */
.mt-3 { margin-top:8px; }
.mini-metrics { display:grid; grid-template-columns:1fr 1fr; gap:3px; }
.mini-item { display:flex; justify-content:space-between; align-items:center; padding:4px 6px; border-radius:4px; background:rgba(255,255,255,0.012); }
.mini-label { font-size:10px; color:#888; }
.mini-val { font-size:10.5px; font-weight:600; font-family:'JetBrains Mono','Consolas',monospace; color:#ddd; }

.obs-footer { margin-top:8px; font-size:10px; color:#777; }

/* ---- 直方图 ---- */
.histogram { display:flex; align-items:flex-end; gap:2px; height:50px; padding:0 1px; }
.histo-bar-wrap { flex:1; min-height:2px; transition:height .5s ease; }
.histo-bar { height:100%; border-radius:3px 3px 0 0; background:hsl(var(--hue),55%,46%); border:1px solid rgba(255,255,255,0.06); cursor:pointer; transition:background .2s; }
.histo-bar:hover { background:hsl(var(--hue),68%,56%); }
.histo-labels { display:flex; justify-content:space-between; font-size:9px; color:#777; margin-top:4px; }

/* ---- 瓦片详情 ---- */
.tile-list { max-height:240px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; }
.tile-list::-webkit-scrollbar { width:3px; }
.tile-list::-webkit-scrollbar-track { background:transparent; }
.tile-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:2px; }
.tile-card {
  background:rgba(255,255,255,0.015); border:1px solid rgba(255,255,255,0.04);
  border-radius:6px; padding:8px 10px; transition:border-color .2s;
}
.tile-card:hover { border-color:rgba(255,255,255,0.13); }
.tile-head { display:flex; align-items:center; gap:6px; margin-bottom:5px; }
.tile-dot { width:7px; height:7px; border-radius:50%; box-shadow:0 0 5px currentColor; flex-shrink:0; }
.tile-stage { font-size:11px; font-weight:600; font-family:'JetBrains Mono','Consolas',monospace; color:#e0e0e0; }
.tile-rank { margin-left:auto; font-size:9.5px; color:#666; }
.tile-pending { font-size:9px; color:#ff9800; margin-left:4px; }
.tile-meta { display:grid; grid-template-columns:repeat(3,1fr); gap:2px 8px; font-size:10px; color:#999; }
.tile-bar { margin-top:5px; height:2.5px; border-radius:2px; background:rgba(255,255,255,0.04); overflow:hidden; }
.tile-bar-fill { height:100%; border-radius:2px; transition:width .5s ease; }

/* ---- 运行状态（紧凑） ---- */
.runtime-compact { display:flex; flex-wrap:wrap; gap:4px; }
.rt-item {
  display:inline-flex; align-items:center; gap:4px;
  padding:4px 9px; border-radius:5px;
  background:rgba(255,255,255,0.018); border:1px solid rgba(255,255,255,0.04);
  font-size:10.5px;
}
.rt-label { color:#888; font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; }
.rt-val { color:#ddd; font-weight:600; font-family:'JetBrains Mono','Consolas',monospace; font-size:10.5px; }
.rt-val.warn { color:#ffb74d; }
.rt-val.small { font-size:9.5px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rt-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; }
.rt-dot.low { background:#66bb6a; box-shadow:0 0 3px #66bb6a; }
.rt-dot.mid { background:#ffa726; box-shadow:0 0 3px #ffa726; }
.rt-dot.high { background:#ef5350; box-shadow:0 0 4px #ef5350; animation:pulse 1s ease-in-out infinite; }
.rt-val.high { color:#ef5350; }
.rt-val.mid { color:#ffa726; }
.rt-val.low { color:#66bb6a; }
</style>
