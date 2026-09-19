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
  cancelPickSection,
  // 视图派生（controller 提供）
  rotationMap,
  pickHint,
  hintTone
} = useClippingPanelController()
</script>

<style scoped src="./clippingPanel.css"></style>
