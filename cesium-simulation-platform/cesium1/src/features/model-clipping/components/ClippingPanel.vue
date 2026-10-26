<template>
  <div class="clip-panel">
    <!-- ─── 切割控制 ─── -->
    <section class="clip-card">
      <header class="clip-card-head">
        <span class="clip-card-title">切割控制</span>
        <span class="clip-card-badge" :class="{ on: clippingEnabled }">
          {{ clippingEnabled ? '已启用' : '已停用' }}
        </span>
      </header>

      <!-- 切割开关 -->
      <div class="clip-row">
        <span class="clip-label">切割模式</span>
        <button
          class="clip-btn clip-btn-toggle"
          :class="{ on: clippingEnabled }"
          @click="toggleClipping"
        >
          <span class="clip-dot" :class="{ active: clippingEnabled }"></span>
          {{ clippingEnabled ? '停止切割' : '开始切割' }}
        </button>
      </div>

      <!-- ─── 爆破模式：拾取式切割（先拾取切割点 → 再选 X/Y/Z 轴） ─── -->
      <div v-if="blastingSceneActive" class="pick-card">
        <header class="pick-head">
          <span class="pick-title">拾取切割</span>
          <span class="pick-sub">先选切割点，再选方向</span>
        </header>

        <!-- 步骤 ① 拾取切割点 -->
        <div class="pick-step" :class="{ done: sectionPicked }">
          <div class="pick-step-head">
            <span class="pick-step-num" :class="{ active: pickSectionActive, done: sectionPicked }">
              {{ sectionPicked ? '✓' : '1' }}
            </span>
            <span class="pick-step-label">拾取切割点</span>
            <span v-if="sectionPicked" class="pick-step-coord">
              ({{ pickedPoint.x.toFixed(1) }}, {{ pickedPoint.y.toFixed(1) }},
              {{ pickedPoint.z.toFixed(1) }})
            </span>
          </div>
          <button
            class="pick-btn"
            :class="{
              picking: pickSectionActive,
              picked: sectionPicked && !pickSectionActive
            }"
            @click="startPickSection"
          >
            <span v-if="pickSectionActive" class="pick-pulse"></span>
            <el-icon v-else-if="sectionPicked"><RefreshRight /></el-icon>
            <el-icon v-else><Aim /></el-icon>
            <span class="pick-btn-text">
              {{
                pickSectionActive
                  ? '请在岩体表面点击…'
                  : sectionPicked
                    ? '重新拾取切割点'
                    : '拾取切割点'
              }}
            </span>
          </button>
        </div>

        <!-- 步骤连接线 -->
        <div class="pick-connector" :class="{ active: sectionPicked }"></div>

        <!-- 步骤 ② 选择切割轴 -->
        <div class="pick-step" :class="{ active: sectionPicked && !blastEnabled }">
          <div class="pick-step-head">
            <span
              class="pick-step-num"
              :class="{ active: sectionPicked && !blastEnabled, done: blastEnabled }"
            >
              {{ blastEnabled ? '✓' : '2' }}
            </span>
            <span class="pick-step-label">选择切割轴</span>
            <span v-if="blastEnabled" class="pick-step-axis">已沿 {{ pickedAxis }} 轴切割</span>
          </div>
          <div class="pick-axis-row">
            <button
              v-for="axis in axisArr"
              :key="axis"
              class="pick-axis"
              :class="{
                active: pickedAxis === axis && blastEnabled,
                disabled: !sectionPicked
              }"
              :disabled="!sectionPicked"
              @click="changePickAxis(axis)"
            >
              {{ axis }}
            </button>
          </div>
        </div>

        <!-- 状态提示 -->
        <p class="pick-hint" :class="hintTone">
          {{ pickHint }}
        </p>

        <!-- 操作 -->
        <div class="pick-actions">
          <button
            class="clip-btn clip-btn-danger"
            :disabled="!sectionPicked && !blastEnabled && !pickSectionActive"
            @click="cancelPickSection"
          >
            <el-icon><Delete /></el-icon>
            清除切割并还原岩体
          </button>
        </div>
      </div>

      <!-- ─── 多边形切割（非爆破模式） ─── -->
      <div v-if="!blastingSceneActive" class="poly-card">
        <header class="poly-head">
          <span class="poly-title">多边形切割</span>
          <button
            class="clip-btn clip-btn-toggle"
            :class="{ on: polygonClippingEnabled }"
            @click="togglePolygonClipping"
          >
            <span class="clip-dot" :class="{ active: polygonClippingEnabled }"></span>
            {{ polygonClippingEnabled ? '已开启' : '已关闭' }}
          </button>
        </header>

        <template v-if="polygonClippingEnabled">
          <div class="poly-row">
            <button
              class="clip-btn clip-btn-primary"
              :class="{ picking: isDrawingPolygon }"
              @click="toggleDrawingPolygon"
            >
              <span v-if="isDrawingPolygon" class="pick-pulse"></span>
              {{ isDrawingPolygon ? '结束绘制' : '开始绘制' }}
            </button>
            <button class="clip-btn clip-btn-ghost" title="清除" @click="clearAllPolygons">
              <el-icon><Delete /></el-icon>
            </button>
          </div>

          <!-- 参数设置 -->
          <div class="poly-params">
            <div class="poly-param-row">
              <span class="clip-label">模式</span>
              <div class="seg">
                <button
                  v-for="mode in polygonModeOptions"
                  :key="mode.key"
                  class="seg-btn"
                  :class="{ active: polygonDirection === mode.key }"
                  @click="setDirection(mode.key)"
                >
                  {{ mode.label }}
                </button>
              </div>
            </div>

            <div class="poly-slider">
              <div class="poly-slider-head">
                <span class="clip-label">深度</span>
                <span class="poly-value">
                  {{ currentPolygonDepth > 0 ? `${currentPolygonDepth} m` : '穿透模型' }}
                </span>
              </div>
              <div class="poly-slider-body">
                <input
                  :value="currentPolygonDepth"
                  type="range"
                  min="0"
                  max="500"
                  step="1"
                  class="clip-range"
                  @input="e => updateDepth(e.target.value)"
                />
                <input
                  :value="currentPolygonDepth"
                  type="number"
                  min="0"
                  class="clip-num"
                  @input="e => updateDepth(e.target.value)"
                />
              </div>
            </div>

            <div class="poly-slider">
              <div class="poly-slider-head">
                <span class="clip-label">轮廓透明度</span>
                <span class="poly-value">{{ currentPolygonVisualizationOpacity }}%</span>
              </div>
              <div class="poly-slider-body">
                <input
                  :value="currentPolygonVisualizationOpacity"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  class="clip-range"
                  @input="e => updatePolygonOpacity(e.target.value)"
                />
                <input
                  :value="currentPolygonVisualizationOpacity"
                  type="number"
                  min="0"
                  max="100"
                  class="clip-num"
                  @input="e => updatePolygonOpacity(e.target.value)"
                />
              </div>
            </div>
          </div>

          <button class="clip-btn clip-btn-ghost clip-btn-block" @click="resetPolygon">
            重置多边形设置
          </button>
        </template>
      </div>

      <!-- ─── 切割面列表（非爆破模式） ─── -->
      <div v-if="clippingEnabled && !blastingSceneActive" class="plane-list">
        <div class="plane-list-head">
          <span class="clip-label">切割面列表 ({{ clippingPlanes.length }})</span>
          <button class="clip-btn clip-btn-primary clip-btn-sm" @click="addNewPlane">
            <el-icon><Plus /></el-icon>
            添加
          </button>
        </div>
        <div class="plane-list-body">
          <div
            v-for="(plane, index) in clippingPlanes"
            :key="index"
            class="plane-item"
            :class="{ active: activePlaneIndex === index }"
            @click="setActivePlane(index)"
          >
            <span class="plane-item-name">切割面 {{ index + 1 }}</span>
            <button
              v-if="clippingPlanes.length > 1"
              class="plane-item-del"
              title="删除"
              @click.stop="removePlane(index)"
            >
              <el-icon><Delete /></el-icon>
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ─── 激活切割面控制（非爆破模式） ─── -->
    <section
      v-if="clippingEnabled && activePlaneIndex !== null && !blastingSceneActive"
      class="clip-card"
    >
      <header class="clip-card-head">
        <span class="clip-card-title">切割面 {{ activePlaneIndex + 1 }} · 参数控制</span>
      </header>

      <div class="clip-row">
        <span class="clip-label">轴向</span>
        <div class="seg">
          <button
            v-for="axis in axisArr"
            :key="axis"
            class="seg-btn"
            :class="{ active: currentPlaneAxis === axis }"
            @click="changeAxis(axis)"
          >
            {{ axis }}
          </button>
        </div>
      </div>

      <div class="clip-row">
        <span class="clip-label">方向</span>
        <div class="seg">
          <button
            v-for="direction in directionArr"
            :key="direction"
            class="seg-btn"
            :class="{ active: currentPlaneDirection === direction }"
            @click="changeDirection(direction)"
          >
            {{ direction }}
          </button>
        </div>
      </div>

      <div class="poly-slider">
        <div class="poly-slider-head">
          <span class="clip-label">位置偏移</span>
          <span class="poly-value">{{ currentPlaneDistance }} m</span>
        </div>
        <div class="poly-slider-body">
          <input
            v-model.number="currentPlaneDistance"
            type="range"
            :min="positionRange.min"
            :max="positionRange.max"
            :step="positionRange.step"
            class="clip-range"
            @input="updatePlaneDistance"
          />
          <input
            v-model.number="currentPlaneDistance"
            type="number"
            class="clip-num"
            @input="updatePlaneDistance"
          />
        </div>
      </div>

      <div v-for="(rot, axis) in rotationMap" :key="axis" class="poly-slider">
        <div class="poly-slider-head">
          <span class="clip-label">{{ axis }}轴旋转</span>
          <span class="poly-value">{{ rot }}°</span>
        </div>
        <div class="poly-slider-body">
          <input
            :value="rot"
            type="range"
            min="-180"
            max="180"
            step="1"
            class="clip-range"
            @input="e => updateRotation(axis, e.target.value)"
          />
          <input
            :value="rot"
            type="number"
            class="clip-num"
            @input="e => updateRotation(axis, e.target.value)"
          />
        </div>
      </div>

      <div class="poly-slider">
        <div class="poly-slider-head">
          <span class="clip-label">透明度</span>
          <span class="poly-value">{{ currentPlaneOpacity }}%</span>
        </div>
        <div class="poly-slider-body">
          <input
            v-model.number="currentPlaneOpacity"
            type="range"
            min="0"
            max="100"
            class="clip-range"
            @input="updatePlaneOpacity"
          />
          <input
            v-model="currentPlaneColor"
            type="color"
            class="clip-color"
            @change="updatePlaneColor"
          />
        </div>
      </div>

      <button class="clip-btn clip-btn-ghost clip-btn-block" @click="resetCurrentPlane">
        重置当前切割面
      </button>
    </section>

    <!-- ─── 操作按钮（非爆破模式） ─── -->
    <div v-if="clippingEnabled && !blastingSceneActive" class="clip-actions">
      <button class="clip-btn clip-btn-danger" @click="clearAllPlanes">清除所有</button>
      <button class="clip-btn clip-btn-ghost" @click="resetClipping">重置切割</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Aim, RefreshRight, Delete, Plus } from '@element-plus/icons-vue'
import { useClippingPanelController } from '../services/panel/useClippingPanelController.js'

defineOptions({ name: '模型切割面板' })

const {
  clippingEnabled,
  clippingPlanes,
  activePlaneIndex,
  polygonClippingEnabled,
  isDrawingPolygon,
  polygonDirection,
  toggleClipping,
  resetClipping,
  togglePolygonClipping,
  toggleDrawingPolygon,
  clearAllPolygons,
  positionRange,
  axisArr,
  directionArr,
  polygonModeOptions,
  currentPolygonDepth,
  currentPolygonVisualizationOpacity,
  currentPlaneDistance,
  currentPlaneRotationX,
  currentPlaneRotationY,
  currentPlaneRotationZ,
  currentPlaneOpacity,
  currentPlaneColor,
  currentPlaneAxis,
  currentPlaneDirection,
  setDirection,
  updateDepth,
  updatePolygonOpacity,
  resetPolygon,
  addNewPlane,
  removePlane,
  setActivePlane,
  updatePlaneDistance,
  updateRotation,
  updatePlaneOpacity,
  updatePlaneColor,
  changeAxis,
  changeDirection,
  resetCurrentPlane,
  clearAllPlanes,
  pickSectionActive,
  pickedPoint,
  pickedAxis,
  blastEnabled,
  sectionPicked,
  startPickSection,
  changePickAxis,
  cancelPickSection
} = useClippingPanelController()

const rotationMap = computed(() => ({
  X: currentPlaneRotationX.value,
  Y: currentPlaneRotationY.value,
  Z: currentPlaneRotationZ.value
}))

const pickHint = computed(() => {
  if (pickSectionActive.value) return '请在岩体表面点击选取切割点'
  if (sectionPicked.value && !blastEnabled.value) return '已拾取切割点，请选择切割轴方向'
  if (blastEnabled.value) return `已沿 ${pickedAxis.value} 轴切割，可切换轴或重新拾取`
  return '请先在岩体表面拾取切割点'
})

const hintTone = computed(() => {
  if (pickSectionActive.value) return 'warn'
  if (blastEnabled.value) return 'ok'
  if (sectionPicked.value) return 'info'
  return 'muted'
})
</script>

<style scoped>
.clip-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: var(--font-sm);
  color: var(--text-primary);
}

/* ─── 卡片 ─── */
.clip-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.clip-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-primary);
}

.clip-card-title {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.clip-card-title::before {
  content: '';
  width: 3px;
  height: 14px;
  background: linear-gradient(180deg, var(--primary-light), var(--primary-color));
  border-radius: 2px;
  flex-shrink: 0;
}

.clip-card-badge {
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-primary);
  background: rgba(255, 255, 255, 0.03);
}

.clip-card-badge.on {
  color: #67c23a;
  border-color: rgba(103, 194, 58, 0.35);
  background: rgba(103, 194, 58, 0.1);
}

/* ─── 通用行 / 标签 ─── */
.clip-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.clip-label {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 60px;
  flex-shrink: 0;
}

/* ─── 按钮 ─── */
.clip-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.clip-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.09);
  border-color: var(--border-secondary);
  color: var(--text-primary);
}

.clip-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.clip-btn .el-icon {
  width: 14px;
  height: 14px;
}

.clip-btn-sm {
  padding: 3px 10px;
  font-size: 11px;
}

.clip-btn-block {
  width: 100%;
}

.clip-btn-toggle {
  min-width: 96px;
}

.clip-btn-toggle.on {
  color: #67c23a;
  border-color: rgba(103, 194, 58, 0.35);
  background: rgba(103, 194, 58, 0.1);
}

.clip-btn-primary {
  color: var(--primary-light);
  border-color: rgba(64, 158, 255, 0.35);
  background: rgba(64, 158, 255, 0.12);
}

.clip-btn-primary:hover:not(:disabled) {
  background: rgba(64, 158, 255, 0.22);
  border-color: rgba(64, 158, 255, 0.5);
  color: #fff;
}

.clip-btn-primary.picking {
  color: #ffb347;
  border-color: rgba(255, 167, 71, 0.45);
  background: rgba(255, 167, 71, 0.12);
}

.clip-btn-danger {
  color: #f56c6c;
  border-color: rgba(245, 108, 108, 0.3);
  background: rgba(245, 108, 108, 0.08);
}

.clip-btn-danger:hover:not(:disabled) {
  background: rgba(245, 108, 108, 0.18);
  border-color: rgba(245, 108, 108, 0.5);
  color: #fff;
}

.clip-btn-ghost {
  color: var(--text-muted);
  background: transparent;
}

.clip-btn-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.clip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-disabled);
  flex-shrink: 0;
}

.clip-dot.active {
  background: #67c23a;
  box-shadow: 0 0 8px rgba(103, 194, 58, 0.8);
}

/* ─── 分段控件 ─── */
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
  padding: 4px 10px;
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

/* ─── 滑块 / 数值 ─── */
.poly-slider {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.poly-slider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.poly-slider-head .clip-label {
  min-width: 0;
}

.poly-value {
  font-family: 'Consolas', monospace;
  font-size: 12px;
  color: var(--primary-light);
  font-variant-numeric: tabular-nums;
}

.poly-slider-body {
  display: flex;
  align-items: center;
  gap: 10px;
}

.clip-range {
  flex: 1;
  height: 4px;
  appearance: none;
  -webkit-appearance: none;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  outline: none;
  cursor: pointer;
  transition: background 0.15s;
}

.clip-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--primary-color);
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  transition: transform 0.1s;
}

.clip-range::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.clip-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--primary-color);
  border: 2px solid #fff;
  cursor: pointer;
}

.clip-num {
  width: 64px;
  padding: 4px 8px;
  font-size: 12px;
  text-align: center;
  font-family: 'Consolas', monospace;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color 0.15s;
}

.clip-num:focus {
  border-color: var(--primary-color);
}

.clip-color {
  width: 64px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
}

/* ─── 爆破模式：拾取切割工作流 ─── */
.pick-card {
  background: rgba(64, 158, 255, 0.05);
  border: 1px solid rgba(64, 158, 255, 0.22);
  border-radius: var(--radius-lg);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pick-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pick-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-light);
  display: flex;
  align-items: center;
  gap: 6px;
}

.pick-title::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary-color);
  box-shadow: 0 0 8px rgba(64, 158, 255, 0.8);
}

.pick-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.pick-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pick-step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pick-step-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border-primary);
  flex-shrink: 0;
  transition: all 0.2s;
}

.pick-step-num.active {
  color: #ffb347;
  border-color: rgba(255, 167, 71, 0.5);
  background: rgba(255, 167, 71, 0.12);
  box-shadow: 0 0 8px rgba(255, 167, 71, 0.25);
}

.pick-step-num.done {
  color: #67c23a;
  border-color: rgba(103, 194, 58, 0.5);
  background: rgba(103, 194, 58, 0.12);
}

.pick-step-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.pick-step-coord {
  margin-left: auto;
  font-family: 'Consolas', monospace;
  font-size: 11px;
  color: var(--primary-light);
  font-variant-numeric: tabular-nums;
}

.pick-step-axis {
  margin-left: auto;
  font-size: 11px;
  color: #67c23a;
  font-weight: 600;
}

.pick-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-secondary);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.pick-btn .el-icon {
  width: 15px;
  height: 15px;
}

.pick-btn:hover {
  background: rgba(64, 158, 255, 0.1);
  border-color: rgba(64, 158, 255, 0.45);
  color: var(--text-primary);
}

.pick-btn.picking {
  border-style: solid;
  border-color: rgba(255, 167, 71, 0.55);
  background: rgba(255, 167, 71, 0.1);
  color: #ffb347;
}

.pick-btn.picked {
  border-style: solid;
  border-color: rgba(103, 194, 58, 0.45);
  background: rgba(103, 194, 58, 0.08);
  color: #67c23a;
}

.pick-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb347;
  animation: pickPulse 1s ease-in-out infinite;
}

@keyframes pickPulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 167, 71, 0.5);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(255, 167, 71, 0);
  }
}

.pick-connector {
  width: 2px;
  height: 14px;
  margin-left: 9px;
  background: var(--border-primary);
  transition: background 0.3s;
}

.pick-connector.active {
  background: linear-gradient(180deg, rgba(103, 194, 58, 0.6), rgba(64, 158, 255, 0.4));
}

.pick-axis-row {
  display: flex;
  gap: 8px;
}

.pick-axis {
  flex: 1;
  padding: 8px 0;
  font-size: 13px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.pick-axis:hover:not(:disabled) {
  border-color: rgba(64, 158, 255, 0.5);
  background: rgba(64, 158, 255, 0.1);
  color: var(--text-primary);
}

.pick-axis.active {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: #fff;
  box-shadow: 0 2px 10px rgba(64, 158, 255, 0.35);
}

.pick-axis.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.pick-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}

.pick-hint.warn {
  color: #ffb347;
}

.pick-hint.ok {
  color: #67c23a;
}

.pick-hint.info {
  color: var(--primary-light);
}

.pick-hint.muted {
  color: var(--text-muted);
}

.pick-actions {
  display: flex;
  gap: 8px;
}

.pick-actions .clip-btn {
  flex: 1;
}

/* ─── 多边形切割（非爆破） ─── */
.poly-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.poly-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.poly-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.poly-row {
  display: flex;
  gap: 8px;
}

.poly-row .clip-btn {
  flex: 1;
}

.poly-params {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: rgba(0, 0, 0, 0.15);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: 10px;
}

/* ─── 切割面列表（非爆破） ─── */
.plane-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plane-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.plane-list-head .clip-label {
  min-width: 0;
}

.plane-list-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.plane-list-body::-webkit-scrollbar {
  width: 4px;
}

.plane-list-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

.plane-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  transition: all 0.15s;
}

.plane-item:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--border-secondary);
}

.plane-item.active {
  background: rgba(64, 158, 255, 0.1);
  border-color: rgba(64, 158, 255, 0.4);
}

.plane-item-name {
  font-size: 12px;
  color: var(--text-secondary);
}

.plane-item.active .plane-item-name {
  color: var(--primary-light);
}

.plane-item-del {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.plane-item-del:hover {
  background: rgba(245, 108, 108, 0.15);
  color: #f56c6c;
}

.plane-item-del .el-icon {
  width: 13px;
  height: 13px;
}

/* ─── 底部操作（非爆破） ─── */
.clip-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
