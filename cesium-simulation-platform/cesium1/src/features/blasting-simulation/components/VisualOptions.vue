<template>
  <div class="panel-section">
    <div class="panel-section-title">图层可见性</div>
    <div class="hint-text">单独控制 3D 场景中各爆破元素的显示/隐藏，便于聚焦观察特定效果。</div>
    <div class="layer-grid">
      <label v-for="layer in layerDefs" :key="layer.key" class="toggle-label layer-toggle">
        <input
          type="checkbox"
          :checked="layerVisibility[layer.key]"
          @change="onToggle(layer.key, $event)"
        />
        {{ layer.label }}
      </label>
    </div>
    <div class="controls-row mt-3">
      <button class="compact-action-btn" @click="setAll(true)">全部显示</button>
      <button class="compact-action-btn" @click="setAll(false)">仅场景</button>
      <button class="compact-action-btn" @click="$emit('sync-visibility')">同步状态</button>
    </div>

    <!-- 振动场分析（PPV 振动 / σ_vm 应力 / 损伤分区 三模式） -->
    <div class="panel-section-title vibration-section-title">振动场分析</div>
    <div class="hint-text">
      实时振动场体积渲染，切换 PPV 振动速度 / σ_vm 等效应力 / 损伤分区。 数据由后端 WebSocket
      同帧推送（萨道夫斯基正演 + 弹性球面波应力反演 + Persson 损伤分区）。
    </div>

    <!-- 三模式切换按钮 -->
    <div class="vibration-mode-bar">
      <button
        v-for="m in vibrationModes"
        :key="m.key"
        class="vibration-mode-btn"
        :class="{ active: vibrationMode === m.key, pending: !isModeReady(m.key) }"
        :disabled="!isModeReady(m.key)"
        :title="isModeReady(m.key) ? m.label : `${m.label}（等待数据）`"
        @click="$emit('set-vibration-mode', m.key)"
      >
        {{ m.label }}
      </button>
    </div>

    <!-- 色阶图例（根据当前模式） -->
    <div v-if="vibrationFieldInfo" class="vibration-legend">
      <!-- PPV 色阶（GB6722-2014） -->
      <template v-if="vibrationMode === 'ppv'">
        <div class="legend-title">PPV 峰值速度 (cm/s) · GB6722-2014</div>
        <div
          class="legend-bar"
          :style="{ background: `linear-gradient(to right, ${ppvGradient})` }"
        ></div>
        <div class="legend-ticks">
          <span v-for="t in ppvTicks" :key="t">{{ t }}</span>
        </div>
        <div class="legend-thresholds">
          <span>1 住宅安全</span><span>2 民用</span><span>4 商业</span><span>7 软岩巷道</span
          ><span>10 硬岩</span>
        </div>
      </template>
      <!-- σ_vm 应力色阶（弹性球面波反演） -->
      <template v-else-if="vibrationMode === 'stress'">
        <div class="legend-title">σ_vm 等效应力 (MPa) · 弹性球面波反演</div>
        <div
          class="legend-bar"
          :style="{ background: `linear-gradient(to right, ${stressGradient})` }"
        ></div>
        <div class="legend-ticks">
          <span v-for="t in stressTicks" :key="t">{{ t }}</span>
        </div>
        <div class="legend-thresholds">
          <span>3 近起裂</span><span class="hl">6 抗拉下限</span><span>10 抗拉上限</span
          ><span>20 严重</span><span>30 破碎</span>
        </div>
      </template>
      <!-- 损伤分区（Persson 模型） -->
      <template v-else>
        <div class="legend-title">Persson 损伤分区</div>
        <div class="damage-legend-grid">
          <div v-for="d in damageLegend" :key="d.zone" class="damage-legend-item">
            <span
              class="damage-swatch"
              :style="{ background: d.c, opacity: d.zone === 0 ? 0.35 : 1 }"
            ></span>
            <span class="damage-zone">{{ d.zone }}</span>
            <span class="damage-label">{{ d.label }}</span>
          </div>
        </div>
        <div class="legend-thresholds">
          <span>阈值 5/15/30/50 cm/s</span><span>Persson 1997</span><span>胡英国 2015</span>
        </div>
      </template>

      <!-- 当前场元信息 -->
      <div class="legend-info">
        <span>t = {{ formatT(vibrationFieldInfo.lastT) }} s</span>
        <span>·</span>
        <span>frame {{ vibrationFieldInfo.lastFrame ?? 0 }}</span>
        <span>·</span>
        <span>{{ (vibrationFieldInfo.gridShape || []).join('×') }} 体素</span>
      </div>
    </div>
    <div v-else class="hint-text vibration-empty">
      振动场尚未加载（选择事件并启动实时推送后显示）
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: 'VisualOptions' })

// 色阶图例数据统一从 vibrationColorScales.js 单源 import（消除与 blastVibrationFieldRenderer.js 的双份维护）
import {
  PPV_LEGEND_STOPS,
  PPV_LEGEND_MAX,
  PPV_TICKS,
  STRESS_LEGEND_STOPS,
  STRESS_LEGEND_MAX,
  STRESS_TICKS,
  DAMAGE_LEGEND,
  gradientCss
} from '../services/core/rendering/vibrationColorScales.js'

const props = defineProps({
  layerDefs: { type: Array, default: () => [] },
  layerVisibility: { type: Object, default: () => ({}) },
  // 振动场三模式（来自 useBlasting.VIBRATION_MODES）
  vibrationModes: { type: Array, default: () => [] },
  // 当前显示模式 'ppv'|'stress'|'damage'
  vibrationMode: { type: String, default: 'ppv' },
  // 振动场元信息（含 gridShape/lastT/lastFrame/hasPpv/hasStress/hasDamage）
  vibrationFieldInfo: { type: Object, default: null }
})

const emit = defineEmits(['set-layer-visible', 'sync-visibility', 'set-vibration-mode'])

function onToggle(layer, event) {
  const checked = event?.target?.checked
  emit('set-layer-visible', layer, checked)
}

function setAll(visible) {
  for (const def of props.layerDefs) {
    emit('set-layer-visible', def.key, visible)
  }
}

// 当前模式是否已有数据（用于按钮禁用态）
function isModeReady(key) {
  const info = props.vibrationFieldInfo
  if (!info) return false
  if (key === 'ppv') return !!info.hasPpv
  if (key === 'stress') return !!info.hasStress
  if (key === 'damage') return !!info.hasDamage
  return false
}

function formatT(t) {
  const v = Number(t)
  return Number.isFinite(v) ? v.toFixed(3) : '0.000'
}

// ─── 色阶图例数据已从 vibrationColorScales.js import（单源真相）───
// PPV_LEGEND_STOPS/PPV_LEGEND_MAX/STRESS_LEGEND_STOPS/STRESS_LEGEND_MAX/DAMAGE_LEGEND/gradientCss
// 均为 import 绑定，此处仅保留 UI 派生计算（gradientCss 调用）
const ppvTicks = PPV_TICKS
const stressTicks = STRESS_TICKS
const damageLegend = DAMAGE_LEGEND

const ppvGradient = gradientCss(PPV_LEGEND_STOPS, PPV_LEGEND_MAX)
const stressGradient = gradientCss(STRESS_LEGEND_STOPS, STRESS_LEGEND_MAX)
</script>

<style scoped>
.vibration-section-title {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.vibration-mode-bar {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.vibration-mode-btn {
  flex: 1;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--el-text-color-regular, #d0d0d0);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.vibration-mode-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.25);
}

.vibration-mode-btn.active {
  color: #fff;
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.35), rgba(64, 158, 255, 0.15));
  border-color: rgba(64, 158, 255, 0.7);
  box-shadow: 0 0 8px rgba(64, 158, 255, 0.3);
}

.vibration-mode-btn.pending {
  opacity: 0.45;
}

.vibration-mode-btn:disabled {
  cursor: not-allowed;
}

.vibration-legend {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}

.legend-title {
  font-size: 12px;
  color: var(--el-text-color-secondary, #9a9a9a);
  margin-bottom: 6px;
  letter-spacing: 0.3px;
}

.legend-bar {
  width: 100%;
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.legend-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 11px;
  color: var(--el-text-color-secondary, #888);
  font-variant-numeric: tabular-nums;
}

.legend-thresholds {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--el-text-color-secondary, #777);
}

.legend-thresholds .hl {
  color: #f0c040;
  font-weight: 600;
}

.legend-info {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary, #888);
  font-variant-numeric: tabular-nums;
}

.damage-legend-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  margin-bottom: 4px;
}

.damage-legend-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 11px;
}

.damage-swatch {
  width: 100%;
  height: 12px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.damage-zone {
  font-weight: 600;
  color: var(--el-text-color-primary, #d0d0d0);
}

.damage-label {
  font-size: 10px;
  color: var(--el-text-color-secondary, #888);
  text-align: center;
  line-height: 1.2;
}

.vibration-empty {
  margin-top: 8px;
  opacity: 0.6;
  font-style: italic;
}
</style>
