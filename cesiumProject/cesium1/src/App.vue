<template>
  <div id="cesiumContainer" ref="cesiumContainer"></div>

  <!-- 顶部标题栏 -->
  <div class="title-bar">
    <div class="title-content">
      <div class="title-icon">⛏️</div>
      <h1>地下金属矿数字孪生可视化平台</h1>
    </div>
    <div class="system-status">
      <div class="status-indicator online"></div>
      <span class="status-text">系统运行中</span>
      <div class="status-divider"></div>
      <span class="status-time">{{ currentTime }}</span>
    </div>
  </div>
  <!-- 左上角模型移动控制面板 -->
  <div class="control-panel left-panel" :class="{ 'panel-collapsed': isMovePanelCollapsed }">
    <div class="panel-handle" @click="toggleMovePanel">
      <div class="panel-icon">↕️</div>
      <span class="panel-text" v-if="!isMovePanelCollapsed">模型移动</span>
    </div>

    <div class="panel-content" v-show="!isMovePanelCollapsed">
      <!-- 位置控制 -->
      <div class="panel-section">
        <h4>位置控制</h4>
        <div class="control-group" v-for="(item, key) in positionControls" :key="key">
          <label class="control-label">
            <span class="label-text">{{ item.label }}</span>
          </label>
          <div class="control-inputs">
            <button class="input-btn" @mousedown="startAdjust(key, -item.step)" @mouseup="stopAdjust">-</button>
            <input type="range" v-model.number="modelPosition[key]" :min="item.min" :max="item.max" :step="item.step"
              @input="updateModelPosition" class="slider">
            <button class="input-btn" @mousedown="startAdjust(key, item.step)" @mouseup="stopAdjust">+</button>
            <input type="number" v-model.number="modelPosition[key]" :min="item.min" :max="item.max"
              :step="key === 'height' ? 1 : 0.0001" @change="updateModelPosition" class="number-input">
          </div>
          <div class="value-display">{{ getFormattedValue(modelPosition[key], key) }}</div>
        </div>
      </div>

      <!-- 旋转控制 -->
      <div class="panel-section">
        <h4>旋转控制</h4>
        <div class="control-group" v-for="(item, key) in rotationControls" :key="key">
          <label class="control-label">
            <span class="label-text">{{ item.label }}</span>
          </label>
          <div class="control-inputs">
            <button class="input-btn" @mousedown="startRotate(key, -item.step)" @mouseup="stopAdjust">-</button>
            <input type="range" v-model.number="modelTransform[key]" :min="item.min" :max="item.max" :step="item.step"
              @input="updateModelTransform" class="slider">
            <button class="input-btn" @mousedown="startRotate(key, item.step)" @mouseup="stopAdjust">+</button>
            <input type="number" v-model.number="modelTransform[key]" :min="item.min" :max="item.max" :step="item.step"
              @change="updateModelTransform" class="number-input">
          </div>
          <div class="value-display">{{ modelTransform[key] }}°</div>
        </div>
      </div>

      <div class="action-buttons">
        <button @click="flyToModel" class="action-btn primary">回到模型</button>
        <button @click="resetModel" class="action-btn secondary">重置位置</button>
      </div>
    </div>
  </div>

  <!-- 右侧专业分析面板 -->
  <div class="control-panel right-panel" :class="{ 'panel-collapsed': isProfessionalPanelCollapsed }">
    <div class="panel-handle" @click="toggleProfessionalPanel">
      <div class="panel-icon">🔍</div>
      <span class="panel-text" v-if="!isProfessionalPanelCollapsed">专业分析</span>
    </div>

    <div class="panel-content" v-show="!isProfessionalPanelCollapsed">
      <!-- 功能标签导航 -->
      <div class="function-tabs">
        <div class="tab-list">
          <button v-for="tab in functionTabs" :key="tab.id" class="tab-button" :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id">
            <span class="tab-icon">{{ tab.icon }}</span>
            <span class="tab-text">{{ tab.name }}</span>
          </button>
        </div>
      </div>

      <!-- 地质分析内容 -->
      <div class="tab-content" v-if="activeTab === 'geology'">
        <!-- 模型管理部分 - 增强版 -->
        <div class="panel-section">
          <h4>模型管理</h4>

          <!-- 配置文件管理 - 默认隐藏，通过设置按钮打开 -->
          <div class="config-control" v-if="isConfigPanelOpen">
            <div class="config-header">
              <span class="control-label">模型配置文件:</span>
              <button @click="toggleConfigPanel" class="compact-action-btn" title="隐藏配置面板">隐藏</button>
            </div>
            <div class="config-inputs">
              <div class="config-file-selector">
                <label>选择配置文件:</label>
                <select v-model="currentConfigFile" @change="loadSelectedConfig" class="config-select">
                  <option value="">请选择配置文件</option>
                  <option v-for="file in modelConfigFiles" :key="file.path" :value="file.path">
                    {{ file.name }}
                  </option>
                </select>
              </div>
              <div class="config-actions">
                <button @click="uploadConfigFile" class="compact-action-btn secondary">上传配置文件</button>
                <button @click="reloadCurrentConfig" class="compact-action-btn secondary">重新加载</button>
              </div>
            </div>
          </div>

          <!-- 配置文件设置按钮 - 当面板关闭时显示 -->
          <div class="config-control" v-if="!isConfigPanelOpen">
            <div class="config-header">
              <span class="control-label">模型配置:</span>
              <button @click="toggleConfigPanel" class="compact-action-btn" title="管理配置文件">设置</button>
            </div>
          </div>

          <!-- 全局控制 -->
          <div class="global-control">
            <span class="control-label">全局透明度:</span>
            <div class="control-inputs">
              <!-- 修改：0为不透明，100为完全透明 -->
              <input type="range" min="0" max="100" step="1" v-model="globalOpacity" @change="updateGlobalOpacity"
                class="slider">
              <span class="value-display">{{ globalOpacity }}%</span>
            </div>
          </div>

          <!-- 模型列表 - 简化为紧凑列表 -->
          <div class="compact-model-list">
            <div v-for="model in modelList" :key="model.id" class="compact-model-item"
              :class="{ 'hover-highlight': hoveredModelId === model.id }" @mouseenter="hoveredModelId = model.id"
              @mouseleave="hoveredModelId = null">
              <label class="compact-model-checkbox">
                <input type="checkbox" v-model="model.visible" @change="toggleModelVisibility(model)">
                <span class="checkmark"></span>
                <span class="compact-model-name">{{ model.name }}</span>
              </label>
              <div class="compact-model-controls">
                <div class="compact-opacity-control">
                  <span class="opacity-label">透明度:</span>
                  <!-- 修改：0为不透明，100为完全透明 -->
                  <input type="range" min="0" max="100" step="1" v-model="model.opacity"
                    @change="updateModelOpacity(model)" class="compact-opacity-slider">
                  <span class="compact-opacity-value">{{ model.opacity }}%</span>
                </div>
                <div class="compact-action-buttons">
                  <button @click="highlightModel(model)" class="compact-action-btn" title="高亮显示">🔆</button>
                  <button @click="showModelProperties(model)" class="compact-action-btn" title="查看属性">📋</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 模型操作按钮 -->
          <div class="compact-action-buttons-group">
            <button @click="showAllModels" class="compact-action-btn secondary">显示全部</button>
            <button @click="hideAllModels" class="compact-action-btn secondary">隐藏全部</button>
            <button @click="resetAllOpacity" class="compact-action-btn secondary">重置透明度</button>
          </div>
        </div>

        <!-- 属性查看器 - 只在选择模型时显示 -->
        <div class="panel-section property-section" v-if="selectedModel">
          <h4>模型属性 - {{ selectedModel.name }}</h4>
          <div class="compact-property-content">
            <div class="compact-property-group">
              <h5>基本信息</h5>
              <div class="compact-property-item">
                <span class="compact-property-label">模型ID:</span>
                <span class="compact-property-value">{{ selectedModel.id }}</span>
              </div>
              <div class="compact-property-item">
                <span class="compact-property-label">模型类型:</span>
                <span class="compact-property-value">{{ selectedModel.type || '未知' }}</span>
              </div>
              <div class="compact-property-item">
                <span class="compact-property-label">显示状态:</span>
                <span class="compact-property-value">{{ selectedModel.visible ? '显示' : '隐藏' }}</span>
              </div>
              <div class="compact-property-item">
                <span class="compact-property-label">透明度:</span>
                <span class="compact-property-value">{{ selectedModel.opacity }}%</span>
              </div>
            </div>

            <!-- 地质属性 -->
            <div class="compact-property-group" v-if="selectedModel.geologyProperties">
              <h5>地质属性</h5>
              <div v-for="(value, key) in selectedModel.geologyProperties" :key="key" class="compact-property-item">
                <span class="compact-property-label">{{ key }}:</span>
                <span class="compact-property-value">{{ value }}</span>
              </div>
            </div>

            <!-- 属性操作按钮 -->
            <div class="compact-property-actions" v-if="selectedModel.geologyProperties">
              <button @click="exportModelProperties(selectedModel)" class="compact-action-btn secondary">导出属性</button>
              <button @click="copyPropertiesToClipboard(selectedModel)"
                class="compact-action-btn secondary">复制属性</button>
            </div>
          </div>
        </div>

        <!-- 统计信息和查询合并显示 -->
        <div class="panel-section combined-section">
          <h4>地质信息</h4>

          <!-- 统计信息 -->
          <div class="stats-container">
            <div class="stat-card" v-for="stat in geologicalStats" :key="stat.id">
              <div class="stat-card-icon">{{ stat.icon }}</div>
              <div class="stat-card-content">
                <div class="stat-card-value">{{ stat.value }}{{ stat.unit }}</div>
                <div class="stat-card-label">{{ stat.label }}</div>
              </div>
            </div>
          </div>

          <!-- 钻孔查询 -->
          <div class="query-container">
            <div class="query-input">
              <label>钻孔编号:</label>
              <select v-model="selectedBorehole" class="query-select">
                <option value="">请选择钻孔</option>
                <option v-for="borehole in boreholes" :key="borehole.id" :value="borehole.id">
                  {{ borehole.name }}
                </option>
              </select>
              <button @click="queryBoreholeInfo" class="compact-action-btn primary" :disabled="!selectedBorehole">
                查询
              </button>
            </div>

            <!-- 钻孔信息 -->
            <div class="borehole-info" v-if="currentBorehole">
              <div class="borehole-details">
                <div class="borehole-detail">
                  <span class="detail-label">孔深:</span>
                  <span class="detail-value">{{ currentBorehole.depth }}米</span>
                </div>
                <div class="borehole-detail">
                  <span class="detail-label">方位角:</span>
                  <span class="detail-value">{{ currentBorehole.azimuth }}°</span>
                </div>
                <div class="borehole-detail">
                  <span class="detail-label">倾角:</span>
                  <span class="detail-value">{{ currentBorehole.dip }}°</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 矿体信息 -->
        <div class="panel-section orebody-section">
          <h4>矿体信息</h4>
          <div class="orebody-container">
            <div class="orebody-card" v-for="orebody in orebodies" :key="orebody.id">
              <div class="orebody-card-header">
                <div class="orebody-card-name">{{ orebody.name }}</div>
                <div class="orebody-card-grade" :class="getGradeClass(orebody.grade)">
                  {{ orebody.grade }}%
                </div>
              </div>
              <div class="orebody-card-details">
                <div class="orebody-card-detail">
                  <span class="detail-label">厚度:</span>
                  <span class="detail-value">{{ orebody.thickness }}米</span>
                </div>
                <div class="orebody-card-detail">
                  <span class="detail-label">储量:</span>
                  <span class="detail-value">{{ orebody.reserves }}万吨</span>
                </div>
                <div class="orebody-card-detail">
                  <span class="detail-label">金属:</span>
                  <span class="detail-value">{{ orebody.metal }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 剖面切割内容 -->
      <div class="tab-content" v-if="activeTab === 'section'">
        <!-- 剖面切割工具 -->
        <div class="panel-section">
          <h4>剖面切割</h4>
          <div class="section-controls">
            <div class="control-group">
              <label class="control-label">
                <span class="label-text">启用切割</span>
              </label>
              <label class="compact-model-checkbox">
                <input type="checkbox" v-model="isSectionEnabled" @change="toggleSection">
                <span class="checkmark"></span>
              </label>
            </div>

            <div class="control-group" v-if="isSectionEnabled">
              <label class="control-label">
                <span class="label-text">切割方向</span>
              </label>
              <select v-model="sectionDirection" @change="updateSectionPlane">
                <option value="x">X轴方向</option>
                <option value="y">Y轴方向</option>
                <option value="z">Z轴方向</option>
              </select>
            </div>

            <div class="control-group" v-if="isSectionEnabled">
              <label class="control-label">
                <span class="label-text">切割位置</span>
              </label>
              <div class="control-inputs">
                <input type="range" v-model.number="sectionPosition" :min="sectionRange.min" :max="sectionRange.max"
                  :step="sectionRange.step" @input="updateSectionPlane" class="slider">
                <input type="number" v-model.number="sectionPosition" :min="sectionRange.min" :max="sectionRange.max"
                  :step="sectionRange.step" @change="updateSectionPlane" class="number-input">
              </div>
            </div>

            <div class="control-group" v-if="isSectionEnabled">
              <label class="control-label">
                <span class="label-text">切割厚度</span>
              </label>
              <div class="control-inputs">
                <input type="range" v-model.number="sectionThickness" :min="0" :max="10" :step="0.1"
                  @input="updateSectionPlane" class="slider">
                <input type="number" v-model.number="sectionThickness" :min="0" :max="10" :step="0.1"
                  @change="updateSectionPlane" class="number-input">
                <span class="unit">米</span>
              </div>
            </div>

            <div class="control-group" v-if="isSectionEnabled">
              <label class="control-label">
                <span class="label-text">显示切割面</span>
              </label>
              <label class="compact-model-checkbox">
                <input type="checkbox" v-model="showSectionPlane" @change="updateSectionPlane">
                <span class="checkmark"></span>
              </label>
            </div>
          </div>
        </div>

        <!-- 切割面样式 -->
        <div class="panel-section" v-if="isSectionEnabled">
          <h4>切割面样式</h4>
          <div class="section-style-controls">
            <div class="control-group">
              <label class="control-label">
                <span class="label-text">颜色</span>
              </label>
              <input type="color" v-model="sectionPlaneColor" @change="updateSectionPlane">
            </div>

            <div class="control-group">
              <label class="control-label">
                <span class="label-text">透明度</span>
              </label>
              <div class="control-inputs">
                <input type="range" v-model.number="sectionPlaneOpacity" :min="0" :max="100" :step="1"
                  @input="updateSectionPlane" class="slider">
                <span class="value">{{ sectionPlaneOpacity }}%</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 快速操作按钮 -->
        <div class="action-buttons">
          <button @click="resetSection" class="action-btn secondary" :disabled="!isSectionEnabled">重置切割</button>
          <button @click="toggleMultipleSections" class="action-btn secondary" :disabled="!isSectionEnabled">
            {{ isMultipleSectionsEnabled ? '关闭多切面' : '启用多切面' }}
          </button>
        </div>
      </div>

      <!-- 测量分析内容 -->
      <div class="tab-content" v-if="activeTab === 'measure'">
        <!-- 测量工具 -->
        <div class="panel-section">
          <h4>测量工具</h4>
          <div class="measurement-controls">
            <div class="measurement-type-selector">
              <button @click="toggleMeasurement" class="measurement-type-btn" :class="{ active: isMeasuring }">
                <span class="measurement-icon">📏</span>
                <span class="measurement-text">距离测量</span>
              </button>
              <button @click="toggleAreaMeasurement" class="measurement-type-btn" :class="{ active: isAreaMeasuring }">
                <span class="measurement-icon">📐</span>
                <span class="measurement-text">面积测量</span>
              </button>
            </div>

            <div class="measurement-actions">
              <button @click="clearAllMeasurements" class="compact-action-btn secondary"
                :disabled="measurementEntities.length === 0 && measurementHistory.length === 0">
                清除测量
              </button>
            </div>
          </div>

          <!-- 测量结果显示 -->
          <div class="measurement-results" v-if="measurementDistance > 0 || measurementArea > 0">
            <div class="result-item" v-if="measurementDistance > 0">
              <span class="result-icon">📏</span>
              <span class="result-text">距离: {{ measurementDistance.toFixed(2) }} 米</span>
            </div>
            <div class="result-item" v-if="measurementArea > 0">
              <span class="result-icon">📐</span>
              <span class="result-text">面积: {{ measurementArea.toFixed(2) }} 平方米</span>
            </div>
          </div>

          <!-- 测量历史 -->
          <div class="panel-section" v-if="measurementHistory.length > 0">
            <div class="history-header">
              <h4>测量历史</h4>
              <button @click="clearMeasurementHistory" class="compact-action-btn secondary">清除历史</button>
            </div>
            <div class="history-list">
              <div class="history-item" v-for="record in measurementHistory.slice(0, 5)" :key="record.id">
                <div class="history-info">
                  <div class="history-type">{{ record.type === 'distance' ? '距离' : '面积' }}</div>
                  <div class="history-value">
                    {{ record.type === 'distance' ? record.distance.toFixed(2) + '米' : record.area.toFixed(2) + '平方米'
                    }}
                  </div>
                  <div class="history-time">{{ formatTime(record.timestamp) }}</div>
                </div>
                <button @click="deleteMeasurementRecord(record.id)" class="compact-action-btn delete-btn"
                  title="删除记录">🗑️</button>
              </div>
            </div>
          </div>

          <!-- 分析工具 -->
          <div class="panel-section">
            <h4>分析工具</h4>
            <div class="analysis-tools">
              <button class="analysis-tool-btn" @click="showVolumeAnalysis">
                <span class="tool-icon">📊</span>
                <span class="tool-text">体积分析</span>
              </button>
              <button class="analysis-tool-btn" @click="showSlopeAnalysis">
                <span class="tool-icon">⛰️</span>
                <span class="tool-text">坡度分析</span>
              </button>
              <button class="analysis-tool-btn" @click="showVisibilityAnalysis">
                <span class="tool-icon">👁️</span>
                <span class="tool-text">可视域分析</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 其他功能内容 -->
      <div class="tab-content" v-if="activeTab === 'other'">
        <!-- 数据导出 -->
        <div class="panel-section">
          <h4>数据导出</h4>
          <div class="export-options">
            <button class="export-option-btn" @click="exportSceneData">
              <span class="export-icon">💾</span>
              <span class="export-text">导出场景数据</span>
            </button>
            <button class="export-option-btn" @click="exportReport">
              <span class="export-icon">📄</span>
              <span class="export-text">生成分析报告</span>
            </button>
            <button class="export-option-btn" @click="exportScreenshot">
              <span class="export-icon">🖼️</span>
              <span class="export-text">截图保存</span>
            </button>
          </div>
        </div>

        <!-- 系统设置 -->
        <div class="panel-section">
          <h4>系统设置</h4>
          <div class="system-settings">
            <div class="setting-item">
              <label class="setting-label">显示质量:</label>
              <select v-model="displayQuality" class="setting-select">
                <option value="low">低质量</option>
                <option value="medium">中等质量</option>
                <option value="high">高质量</option>
              </select>
            </div>
            <div class="setting-item">
              <label class="setting-label">地形精度:</label>
              <select v-model="terrainQuality" class="setting-select">
                <option value="low">低精度</option>
                <option value="medium">中等精度</option>
                <option value="high">高精度</option>
              </select>
            </div>
            <div class="setting-item">
              <label class="setting-label">坐标显示:</label>
              <select v-model="coordinateSystem" class="setting-select">
                <option value="wgs84">WGS84</option>
                <option value="cgcs2000">CGCS2000</option>
                <option value="local">本地坐标系</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 开发中功能 -->
        <div class="panel-section">
          <h4>开发中功能</h4>
          <div class="developing-features">
            <div class="feature-item developing">
              <span class="feature-icon">🚧</span>
              <span class="feature-text">三维剖面分析</span>
            </div>
            <div class="feature-item developing">
              <span class="feature-icon">🚧</span>
              <span class="feature-text">储量动态计算</span>
            </div>
            <div class="feature-item developing">
              <span class="feature-icon">🚧</span>
              <span class="feature-text">开采模拟</span>
            </div>
            <div class="feature-item developing">
              <span class="feature-icon">🚧</span>
              <span class="feature-text">安全监测</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 底部状态栏 -->
  <div class="status-bar">
    <div class="status-item">
      <span class="status-label">坐标:</span>
      <span class="status-value">{{ currentCoordinates.longitude.toFixed(4) }}, {{
        currentCoordinates.latitude.toFixed(4) }}</span>
    </div>
    <div class="status-item">
      <span class="status-label">海拔:</span>
      <span class="status-value">{{ currentCoordinates.height.toFixed(1) }}米</span>
    </div>
    <div class="status-item">
      <span class="status-label">视角:</span>
      <span class="status-value">{{ cameraInfo.heading.toFixed(1) }}°, {{ cameraInfo.pitch.toFixed(1) }}°</span>
    </div>
    <div class="status-item" v-if="isMeasuring">
      <span class="status-label">状态:</span>
      <span class="status-value measuring">距离测量中...</span>
    </div>
    <div class="status-item" v-if="isAreaMeasuring">
      <span class="status-label">状态:</span>
      <span class="status-value measuring">面积测量中...</span>
    </div>
  </div>

  <!-- 操作提示 -->
  <div v-if="operationMessage" class="operation-message" :class="{ error: operationMessageType === 'error' }">
    {{ operationMessage }}
  </div>

  <!-- 加载状态指示器 -->
  <div v-if="loading" class="loading-indicator">
    <div class="spinner"></div>
    <span class="spinner-text">加载中...</span>
  </div>
</template>

<script setup>
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { onMounted, ref, reactive } from 'vue';

// 设置 Cesium 基础 URL
window.CESIUM_BASE_URL = "/"
Cesium.Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIyYjQwMDhkNy04NjljLTRkZGQtYTI4MS0yYTA4ZGQ4NTczYTEiLCJpZCI6MzE2NzQ2LCJpYXQiOjE3NTEyMDQ1MzV9.CZ2M4g2o2JGRE7OFtHVmXuJ_A-XMx59BgOqjqbIz9xQ"

// 面板状态
const isMovePanelCollapsed = ref(false)
const isProfessionalPanelCollapsed = ref(false)
const activeTab = ref('geology') // 默认选中地质分析标签
const hoveredModelId = ref(null) // 鼠标悬停的模型ID
const currentTime = ref('') // 当前时间

// 功能标签
const functionTabs = ref([
  { id: 'geology', name: '地质分析', icon: '🪨' },
  { id: 'measure', name: '测量分析', icon: '📏' },
  { id: 'section', name: '剖面切割', icon: '✂️' },
  { id: 'other', name: '其他功能', icon: '⚙️' }
])

// 模型管理相关数据
const loading = ref(false)
const selectedModel = ref(null)
const modelList = ref([])
const operationMessage = ref("")
const operationMessageType = ref("success")
const globalOpacity = ref(0) // 0%表示完全不透明

// 新增：模型配置文件管理
const modelConfigFiles = ref([])
const currentConfigFile = ref('')
const isConfigPanelOpen = ref(false)
const configFileContent = ref('')

// 新增：剖面切割功能相关数据
const isSectionEnabled = ref(false)
const sectionDirection = ref('x')
const sectionPosition = ref(0)
const sectionThickness = ref(0)
const showSectionPlane = ref(true)
const sectionPlaneColor = ref('#FF0000')
const sectionPlaneOpacity = ref(50)
const isMultipleSectionsEnabled = ref(false)
const sectionRange = ref({
  min: -100,
  max: 100,
  step: 0.1
})

// 用于存储切割平面集合
let clippingPlaneCollection = null
let sectionPlaneEntity = null

// 模型位置和变换数据
const modelPosition = ref({
  longitude: 113.323,
  latitude: 23.106,
  height: 200
})

const modelTransform = ref({
  rotationX: 15,
  rotationY: 0,
  rotationZ: 0
})

// 控制配置
const positionControls = {
  longitude: { label: '经度', min: 113.313, max: 113.333, step: 0.0001 },
  latitude: { label: '纬度', min: 23.096, max: 23.116, step: 0.0001 },
  height: { label: '高度', min: 0, max: 1000, step: 1 }
}

const rotationControls = {
  rotationX: { label: 'X轴旋转', min: -180, max: 180, step: 1 },
  rotationY: { label: 'Y轴旋转', min: -180, max: 180, step: 1 },
  rotationZ: { label: 'Z轴旋转', min: -180, max: 180, step: 1 }
}

// 地质相关数据
const boreholes = ref([
  {
    id: 'ZK001', name: 'ZK001钻孔', depth: 350, azimuth: 45, dip: 75
  },
  {
    id: 'ZK002', name: 'ZK002钻孔', depth: 420, azimuth: 60, dip: 80
  }
])

const geologicalStats = ref([
  { id: 1, icon: '📏', label: '平均厚度', value: 15.2, unit: '米' },
  { id: 2, icon: '📊', label: '矿化强度', value: 68, unit: '%' },
  { id: 3, icon: '⛏️', label: '预测储量', value: 1250, unit: '万吨' },
  { id: 4, icon: '💰', label: '平均品位', value: 2.8, unit: '%' }
])

const orebodies = ref([
  { id: 1, name: '主矿体', grade: 3.2, thickness: 18.5, reserves: 850, metal: '铜' },
  { id: 2, name: '东矿体', grade: 2.5, thickness: 12.3, reserves: 320, metal: '铜' },
  { id: 3, name: '西矿体', grade: 1.8, thickness: 8.7, reserves: 180, metal: '铜' }
])

// 测量相关数据
const isMeasuring = ref(false)
const isAreaMeasuring = ref(false)
const measurementPoints = ref([])
const measurementDistance = ref(0)
const measurementArea = ref(0)
const measurementEntities = ref([])
const measurementHistory = ref([])

// 系统设置
const displayQuality = ref('medium')
const terrainQuality = ref('medium')
const coordinateSystem = ref('wgs84')

// 当前坐标和相机信息
const currentCoordinates = reactive({
  longitude: 113.323,
  latitude: 23.106,
  height: 0
})

const cameraInfo = reactive({
  heading: 0,
  pitch: 0,
  roll: 0
})

// 地质查询相关
const selectedBorehole = ref('')
const currentBorehole = ref(null)

// 长按调整相关
let adjustInterval = null
let currentAdjustField = null
let currentAdjustAmount = 0

let viewer = null
let tileset = null
let originalModelMatrix = null
let measurementHandler = null
let areaMeasurementHandler = null
let modelClickHandler = null
let featureMap = new Map()

// 面板控制
function toggleMovePanel() {
  isMovePanelCollapsed.value = !isMovePanelCollapsed.value
}

function toggleProfessionalPanel() {
  isProfessionalPanelCollapsed.value = !isProfessionalPanelCollapsed.value
}

// 格式化显示值
function getFormattedValue(value, field) {
  if (field === 'longitude' || field === 'latitude') {
    return value.toFixed(6)
  } else {
    return value + '米'
  }
}

let isAdjusting = false
// 开始调整数值（支持长按）
function startAdjust(field, amount) {
  if (isAdjusting) return; // 防止重复触发

  isAdjusting = true;
  currentAdjustField = field;
  currentAdjustAmount = amount;

  // 立即调整一次
  adjustValue(field, amount);

  // 设置长按间隔
  adjustInterval = setInterval(() => {
    adjustValue(field, amount);
  }, 100);

  // 在document上添加mouseup和mouseleave事件，确保鼠标离开按钮也能停止
  document.addEventListener('mouseup', stopAdjustOnDocument);
  document.addEventListener('mouseleave', stopAdjustOnDocument);
}

// 开始旋转调整
function startRotate(field, amount) {
  if (isAdjusting) return; // 防止重复触发

  isAdjusting = true;
  currentAdjustField = field;
  currentAdjustAmount = amount;

  // 立即调整一次
  adjustTransform(field, amount);

  // 设置长按间隔
  adjustInterval = setInterval(() => {
    adjustTransform(field, amount);
  }, 100);

  // 在document上添加mouseup和mouseleave事件
  document.addEventListener('mouseup', stopAdjustOnDocument);
  document.addEventListener('mouseleave', stopAdjustOnDocument);
}

// 停止调整（从按钮事件触发）
function stopAdjust() {
  clearAdjustInterval();
  removeDocumentListeners();
}

// 停止调整（从document事件触发）
function stopAdjustOnDocument() {
  clearAdjustInterval();
  removeDocumentListeners();
}

// 清除调整间隔
function clearAdjustInterval() {
  if (adjustInterval) {
    clearInterval(adjustInterval);
    adjustInterval = null;
  }
  currentAdjustField = null;
  currentAdjustAmount = 0;
  isAdjusting = false;
}

// 移除document上的事件监听器
function removeDocumentListeners() {
  document.removeEventListener('mouseup', stopAdjustOnDocument);
  document.removeEventListener('mouseleave', stopAdjustOnDocument);
}
// 调整位置值
function adjustValue(field, amount) {
  const config = positionControls[field]
  const newValue = modelPosition.value[field] + amount

  // 限制在最小最大值范围内
  if (newValue >= config.min && newValue <= config.max) {
    modelPosition.value[field] = parseFloat(newValue.toFixed(6))
    updateModelPosition()
  }
}

// 调整变换值
function adjustTransform(field, amount) {
  const config = rotationControls[field]
  const newValue = modelTransform.value[field] + amount

  // 限制在最小最大值范围内
  if (newValue >= config.min && newValue <= config.max) {
    modelTransform.value[field] = newValue
    updateModelTransform()
  }
}

// 更新模型位置
function updateModelPosition() {
  applyModelTransform()
}

// 更新模型变换
function updateModelTransform() {
  applyModelTransform()
}

// 重置模型位置和变换
function resetModel() {
  modelPosition.value = {
    longitude: 113.323,
    latitude: 23.106,
    height: 50
  }
  modelTransform.value = {
    rotationX: 15,
    rotationY: 0,
    rotationZ: 0
  }
  applyModelTransform()
}

// 飞行到模型
function flyToModel() {
  if (tileset) {
    viewer.zoomTo(tileset)
  }
}

// 应用模型变换
function applyModelTransform() {
  if (!tileset || !originalModelMatrix) return

  try {
    tileset.modelMatrix = Cesium.Matrix4.clone(originalModelMatrix)

    // 移动到指定位置
    moveModelToPosition(
      modelPosition.value.longitude,
      modelPosition.value.latitude,
      modelPosition.value.height
    )

    // 应用旋转
    rotate(
      tileset,
      modelTransform.value.rotationX,
      modelTransform.value.rotationY,
      modelTransform.value.rotationZ
    )

  } catch (error) {
    console.error("应用模型变换失败:", error)
  }
}

// 模型变换函数
function moveModelToPosition(longitude, latitude, height) {
  if (!tileset) return

  try {
    const targetPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
    const originalCenter = tileset.boundingSphere.center
    const offset = Cesium.Cartesian3.subtract(targetPosition, originalCenter, new Cesium.Cartesian3())
    const translationMatrix = Cesium.Matrix4.fromTranslation(offset)
    tileset.modelMatrix = Cesium.Matrix4.multiply(translationMatrix, tileset.modelMatrix, new Cesium.Matrix4())
  } catch (error) {
    console.error("移动模型失败:", error)
  }
}

function rotate(tileset, rx, ry, rz) {
  if (rx === 0 && ry === 0 && rz === 0) return;

  const origin = tileset.boundingSphere.center;
  const toWorldMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const toLocalMatrix = Cesium.Matrix4.inverse(toWorldMatrix, new Cesium.Matrix4());
  const rotateMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

  if (rx !== 0) {
    const rotateXMatrix = Cesium.Matrix4.fromRotation(
      Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(rx))
    );
    Cesium.Matrix4.multiply(rotateXMatrix, rotateMatrix, rotateMatrix);
  }

  if (ry !== 0) {
    const rotateYMatrix = Cesium.Matrix4.fromRotation(
      Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(ry))
    );
    Cesium.Matrix4.multiply(rotateYMatrix, rotateMatrix, rotateMatrix);
  }

  if (rz !== 0) {
    const rotateZMatrix = Cesium.Matrix4.fromRotation(
      Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(rz))
    );
    Cesium.Matrix4.multiply(rotateZMatrix, rotateMatrix, rotateMatrix);
  }

  const localResultMatrix = Cesium.Matrix4.multiply(rotateMatrix, toLocalMatrix, new Cesium.Matrix4());
  const worldResultMatrix = Cesium.Matrix4.multiply(toWorldMatrix, localResultMatrix, new Cesium.Matrix4());
  tileset.modelMatrix = Cesium.Matrix4.multiply(worldResultMatrix, tileset.modelMatrix, new Cesium.Matrix4());
}

// 操作提示
function showOperationMessage(message, type = 'success') {
  operationMessage.value = message
  operationMessageType.value = type
  setTimeout(() => {
    operationMessage.value = ""
  }, 3000)
}

// 初始化事件处理器
function initModelEventHandler() {
  modelClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  modelClickHandler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// 左键点击选择模型
function onLeftClick(click) {
  if (!tileset) return;

  const pickedFeature = viewer.scene.pick(click.position);

  if (!Cesium.defined(pickedFeature)) {
    return;
  }

  if (pickedFeature.primitive === tileset && pickedFeature instanceof Cesium.Cesium3DTileFeature) {
    handleModelSelection(pickedFeature);
  }
}

// 处理模型选择
function handleModelSelection(feature) {
  const featureId = getFeatureId(feature);

  // 在模型列表中查找对应的模型
  const model = modelList.value.find(m => m.id === featureId);

  if (model) {
    selectedModel.value = model;
    highlightModel(model);
    showOperationMessage(`已选择模型: ${model.name}`, 'success');
  } else {
    // 如果找不到预定义的模型，创建一个临时模型对象
    selectedModel.value = {
      id: featureId,
      name: '未知模型',
      type: '未知类型',
      visible: true,
      opacity: 0,
      properties: getFeatureProperties(feature)
    };
    showOperationMessage(`选择了一个未配置的模型`, 'info');
  }
}

// 获取要素ID
function getFeatureId(feature) {
  try {
    if (typeof feature.getProperty === 'function') {
      // 尝试获取各种可能的ID属性
      const id = feature.getProperty('id') ||
        feature.getProperty('ID') ||
        feature.getProperty('Name') ||
        feature.getProperty('name') ||
        feature.getProperty('GUID') ||
        feature.getProperty('guid');

      if (id) {
        return id;
      }
    }

    // 如果没有找到ID属性，使用feature的内部ID
    if (feature._id) {
      return feature._id;
    }

    // 如果还是没有ID，生成一个基于时间戳和随机数的ID
    return `feature_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  } catch (error) {
    console.warn('获取要素ID失败:', error);
    return `feature_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }
}

// 获取要素属性
function getFeatureProperties(feature) {
  try {
    if (typeof feature.getPropertyNames === 'function' &&
      typeof feature.getProperty === 'function') {
      const propertyNames = feature.getPropertyNames();
      const properties = {};
      propertyNames.forEach(name => {
        properties[name] = feature.getProperty(name);
      });
      return properties;
    }
    return {};
  } catch (error) {
    console.warn('获取要素属性失败:', error);
    return {};
  }
}

// 加载模型属性数据
async function loadModelProperties() {
  try {
    const response = await fetch('./3d/demo4/feature.json');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const propertiesData = await response.json();
    initializeModelList(propertiesData);

    showOperationMessage(`成功加载 ${modelList.value.length} 个模型的属性数据`, 'success');
  } catch (error) {
    console.warn('加载模型属性文件失败:', error);
    // 如果加载失败，使用默认的模型列表
    // 确保先扫描要素
    if (featureMap.size === 0 && tileset) {
      scanAndStoreFeatures();
    }
    // 延迟调用initializeDefaultModelList，确保featureMap有时间填充
    setTimeout(() => {
      initializeDefaultModelList();
      showOperationMessage('使用默认模型配置', 'info');
    }, 500);
  }
}

// 初始化模型列表函数已在后面重新定义，此处删除重复定义

// 初始化默认模型列表（自动从要素中获取ID）
function initializeDefaultModelList() {
  // 清空现有模型列表
  modelList.value = [];

  // 根据featureMap中的要素创建模型列表
  featureMap.forEach((feature, featureId) => {
    // 尝试获取要素名称
    let featureName = '未知模型';
    try {
      if (typeof feature.getProperty === 'function') {
        featureName = feature.getProperty('name') ||
          feature.getProperty('Name') ||
          feature.getProperty('description') ||
          feature.getProperty('Description') ||
          featureName;
      }
    } catch (error) {
      console.warn('获取要素名称失败:', error);
    }

    // 创建模型对象
    const model = {
      id: featureId,
      name: featureName,
      type: 'unknown',
      category: '未知',
      visible: true,
      opacity: 0, // 0%表示完全不透明
      geologyProperties: {
        '地质类型': '未知',
        'ID': featureId
      }
    };

    // 根据ID或名称尝试分类模型
    const idLower = featureId.toLowerCase();
    const nameLower = featureName.toLowerCase();

    if (idLower.includes('surface') || nameLower.includes('surface') || nameLower.includes('地表')) {
      model.type = 'surface';
      model.category = '地形地貌';
      model.geologyProperties['地质类型'] = '地表层';
    } else if (idLower.includes('terrain') || nameLower.includes('terrain') || nameLower.includes('地形')) {
      model.type = 'terrain';
      model.category = '地形地貌';
      model.geologyProperties['地质类型'] = '地形模型';
    } else if (idLower.includes('pit') || nameLower.includes('pit') || nameLower.includes('采场') || nameLower.includes('pit')) {
      model.type = 'mining_pit';
      model.category = '采矿工程';
      model.geologyProperties['地质类型'] = '露天采场';
    } else if (idLower.includes('ore') || nameLower.includes('ore') || nameLower.includes('矿体')) {
      model.type = 'ore_body';
      model.category = '矿产资源';
      model.geologyProperties['地质类型'] = '矿体';
    } else if (idLower.includes('waste') || nameLower.includes('waste') || nameLower.includes('夹石')) {
      model.type = 'waste_body';
      model.category = '矿产资源';
      model.geologyProperties['地质类型'] = '夹石';
    }

    // 添加到模型列表
    modelList.value.push(model);
  });

  // 如果没有从要素中获取到任何模型，使用默认模型列表
  if (modelList.value.length === 0) {
    console.log('未从要素中获取到任何模型，使用默认模型列表');
    modelList.value = [
      {
        id: 'a5771bce93e200c36f7cd9dfd0e5deaa',
        name: '地表模型',
        type: 'surface',
        category: '地形地貌',
        visible: true,
        opacity: 0, // 0%表示完全不透明
        geologyProperties: {
          '地质类型': '地表层',
          '地貌特征': '矿山地表',
          '土地利用': '采矿作业区'
        }
      },
      {
        id: '3416a75f4cea9109507cacd8e2f2aefc',
        name: '地形模型',
        type: 'terrain',
        category: '地形地貌',
        visible: true,
        opacity: 0, // 0%表示完全不透明
        geologyProperties: {
          '地质类型': '地形模型',
          '地形特征': '数字高程',
          '用途': '地形分析基础'
        }
      },
      {
        id: 'd645920e395fedad7bbbed0eca3fe2e0',
        name: '采场模型1',
        type: 'mining_pit',
        category: '采矿工程',
        visible: true,
        opacity: 0, // 0%表示完全不透明
        geologyProperties: {
          '地质类型': '露天采场',
          '开采方式': '露天开采',
          '采场阶段': '一期'
        }
      },
      {
        id: 'd67d8ab4f4c10bf22aa353e27879133c',
        name: '采场模型2',
        type: 'mining_pit',
        category: '采矿工程',
        visible: true,
        opacity: 0, // 0%表示完全不透明
        geologyProperties: {
          '地质类型': '露天采场',
          '开采方式': '露天开采',
          '采场阶段': '二期'
        }
      },
      {
        id: '17e62166fc8586dfa4d1bc0e1742c08b',
        name: '矿体模型',
        type: 'ore_body',
        category: '矿产资源',
        visible: true,
        opacity: 0, // 0%表示完全不透明
        geologyProperties: {
          '地质类型': '矿体',
          '矿石类型': '待鉴定',
          '赋存状态': '层状/脉状'
        }
      },

      {
        id: 'a1d0c6e83f027327d8461063f4ac58a6',
        name: '夹石模型',
        type: 'ore_body',
        category: '矿产资源',
        visible: true,
        opacity: 0, // 0%表示完全不透明
        geologyProperties: {
          '地质类型': '矿体',
          '矿石类型': '待鉴定',
          '赋存状态': '层状/脉状'
        }
      }
    ];
  }
}

// 扫描并存储所有要素
function scanAndStoreFeatures() {
  if (!tileset) return;

  featureMap.clear();

  // 递归处理tile及其所有子tile
  function processTile(tile) {
    if (tile.content && tile.content.featuresLength > 0) {
      for (let i = 0; i < tile.content.featuresLength; ++i) {
        const feature = tile.content.getFeature(i);
        const featureId = getFeatureId(feature);

        if (!featureMap.has(featureId)) {
          featureMap.set(featureId, feature);
        }
      }
    }

    if (tile.children) {
      for (let j = 0; j < tile.children.length; ++j) {
        processTile(tile.children[j]);
      }
    }
  }

  // 处理所有已加载的tile
  if (tileset.root) {
    processTile(tileset.root);
  }

  // 继续监听新加载的tile
  tileset.tileLoad.addEventListener(function (tile) {
    processTile(tile);
  });

}

// 切换模型可见性
function toggleModelVisibility(model) {
  if (!tileset) return;

  try {
    // 直接操作要素的show属性
    const feature = featureMap.get(model.id);
    if (feature && feature.show !== undefined) {
      feature.show = model.visible;
      showOperationMessage(`${model.visible ? '显示' : '隐藏'}了模型: ${model.name}`, 'success');
    } else {
      // 如果找不到对应的要素，提供有用的错误信息
      console.warn(`无法找到模型要素，ID: ${model.id}, 名称: ${model.name}`);
      showOperationMessage(`无法操作模型: ${model.name} (ID不匹配)`, 'warning');
    }
  } catch (error) {
    console.error('切换模型可见性失败:', error);
    showOperationMessage('切换显示状态失败', 'error');
  }
}

// 更新全局透明度
function updateGlobalOpacity() {
  if (!tileset) return;

  try {
    let successCount = 0;
    let failCount = 0;

    // 应用全局透明度到所有模型
    modelList.value.forEach(model => {
      if (model.visible) {
        if (updateModelOpacityDirectly(model)) {
          successCount++;
        } else {
          failCount++;
        }
      }
    });

    if (failCount === 0) {
      showOperationMessage(`全局透明度已调整为 ${globalOpacity.value}% (成功更新 ${successCount} 个模型)`, 'success');
    } else {
      showOperationMessage(`全局透明度已调整为 ${globalOpacity.value}% (成功更新 ${successCount} 个模型，${failCount} 个模型ID不匹配)`, 'warning');
    }
  } catch (error) {
    console.error('更新全局透明度失败:', error);
    showOperationMessage('更新透明度失败', 'error');
  }
}

// 更新单个模型透明度
function updateModelOpacity(model) {
  if (!tileset) return;

  try {
    if (updateModelOpacityDirectly(model)) {
      showOperationMessage(`模型 ${model.name} 透明度已调整为 ${model.opacity}%`, 'success');
    } else {
      console.warn(`无法找到模型要素进行透明度调整，ID: ${model.id}, 名称: ${model.name}`);
      showOperationMessage(`无法调整模型透明度: ${model.name} (ID不匹配)`, 'warning');
    }
  } catch (error) {
    console.error('更新模型透明度失败:', error);
    showOperationMessage('更新透明度失败', 'error');
  }
}

// 直接更新模型透明度
function updateModelOpacityDirectly(model) {
  const feature = featureMap.get(model.id);
  if (feature && feature.color !== undefined) {
    // 将0-100的透明度转换为0-1，并反转（0%表示不透明，100%表示完全透明）
    const opacityValue = 1 - (model.opacity / 100);
    const globalOpacityValue = 1 - (globalOpacity.value / 100);

    // 计算最终透明度（模型透明度 × 全局透明度）
    const finalOpacity = opacityValue * globalOpacityValue;

    // 获取当前颜色并设置新的透明度
    const currentColor = feature.color || Cesium.Color.WHITE;
    feature.color = new Cesium.Color(
      currentColor.red,
      currentColor.green,
      currentColor.blue,
      finalOpacity
    );
    return true; // 操作成功
  }
  return false; // 操作失败
}

// 重置所有模型透明度
function resetAllOpacity() {
  modelList.value.forEach(model => {
    model.opacity = 0; // 重置为0（完全不透明）
  });
  globalOpacity.value = 0; // 重置为0（完全不透明）

  // 重置所有要素的透明度
  featureMap.forEach((feature, featureId) => {
    if (feature.color !== undefined) {
      // 重置为完全不透明
      feature.color = new Cesium.Color(
        feature.color.red,
        feature.color.green,
        feature.color.blue,
        1.0 // 完全不透明
      );
    }
  });

  showOperationMessage('已重置所有模型透明度', 'success');
}

// 高亮显示模型
function highlightModel(model) {
  if (!tileset) return;

  try {
    const feature = featureMap.get(model.id);
    if (feature && feature.color !== undefined) {
      // 保存原始颜色
      const originalColor = feature.color.clone();

      // 将0-100的透明度转换为0-1，并反转
      const opacityValue = 1 - (model.opacity / 100);
      const globalOpacityValue = 1 - (globalOpacity.value / 100);
      const finalOpacity = opacityValue * globalOpacityValue;

      // 设置高亮颜色（黄色）
      feature.color = Cesium.Color.YELLOW.withAlpha(finalOpacity);

      showOperationMessage(`高亮显示模型: ${model.name}`, 'success');

      // 3秒后恢复原始颜色
      setTimeout(() => {
        if (feature && feature.color !== undefined) {
          feature.color = originalColor;
        }
      }, 3000);
    } else {
      console.warn(`无法找到模型要素进行高亮显示，ID: ${model.id}, 名称: ${model.name}`);
      showOperationMessage(`无法高亮显示模型: ${model.name} (ID不匹配)`, 'warning');
    }
  } catch (error) {
    console.error('高亮模型失败:', error);
    showOperationMessage('高亮模型失败', 'error');
  }
}

// 显示模型属性
function showModelProperties(model) {
  selectedModel.value = model;
  showOperationMessage(`显示模型属性: ${model.name}`, 'success');
}

// 显示所有模型
function showAllModels() {
  let successCount = 0;
  let failCount = 0;

  modelList.value.forEach(model => {
    model.visible = true;
    const feature = featureMap.get(model.id);
    if (feature && feature.show !== undefined) {
      feature.show = true;
      successCount++;
    } else {
      failCount++;
    }
  });

  if (failCount === 0) {
    showOperationMessage(`已显示所有模型 (${successCount} 个模型)`, 'success');
  } else {
    showOperationMessage(`已显示所有模型 (${successCount} 个模型成功，${failCount} 个模型ID不匹配)`, 'warning');
  }
}

// 隐藏所有模型
function hideAllModels() {
  let successCount = 0;
  let failCount = 0;

  modelList.value.forEach(model => {
    model.visible = false;
    const feature = featureMap.get(model.id);
    if (feature && feature.show !== undefined) {
      feature.show = false;
      successCount++;
    } else {
      failCount++;
    }
  });

  if (failCount === 0) {
    showOperationMessage(`已隐藏所有模型 (${successCount} 个模型)`, 'success');
  } else {
    showOperationMessage(`已隐藏所有模型 (${successCount} 个模型成功，${failCount} 个模型ID不匹配)`, 'warning');
  }
}

// 导出模型属性
function exportModelProperties(model) {
  const exportData = {
    timestamp: new Date().toISOString(),
    model: {
      id: model.id,
      name: model.name,
      type: model.type,
      category: model.category,
      geologyProperties: model.geologyProperties
    }
  };

  const dataStr = JSON.stringify(exportData, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });

  const link = document.createElement('a');
  link.href = URL.createObjectURL(dataBlob);
  link.download = `model_${model.id}_properties.json`;
  link.click();

  showOperationMessage(`已导出模型 ${model.name} 的属性`, 'success');
}

// 复制属性到剪贴板
function copyPropertiesToClipboard(model) {
  const propertiesText = JSON.stringify({
    name: model.name,
    type: model.type,
    ...model.geologyProperties
  }, null, 2);

  navigator.clipboard.writeText(propertiesText).then(() => {
    showOperationMessage('属性已复制到剪贴板', 'success');
  });
}

// 新增：配置文件管理功能

// 切换配置文件面板
function toggleConfigPanel() {
  isConfigPanelOpen.value = !isConfigPanelOpen.value;
  if (isConfigPanelOpen.value) {
    scanAvailableConfigFiles();
  }
}

// 扫描可用的配置文件
function scanAvailableConfigFiles() {
  modelConfigFiles.value = [
    { name: 'demo2模型配置', path: './3d/demo2/features.json' },
    { name: 'demo3模型配置', path: './3d/demo3/feature.json' },
    { name: 'demo4模型配置', path: './3d/demo4/feature.json' }
  ];
}

// 加载选定的配置文件
async function loadSelectedConfig() {
  if (!currentConfigFile.value) return;

  try {
    loading.value = true;

    // 根据配置文件路径确定对应的3D模型路径
    let modelPath = './3d/demo4/tileset.json'; // 默认路径

    if (currentConfigFile.value.includes('demo2')) {
      modelPath = './3d/demo2/tileset.json';
    } else if (currentConfigFile.value.includes('demo3')) {
      modelPath = './3d/demo3/tileset.json';
    } else if (currentConfigFile.value.includes('demo4')) {
      modelPath = './3d/demo4/tileset.json';
    }

    // 先加载配置文件
    const response = await fetch(currentConfigFile.value);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const configData = await response.json();

    // 加载对应的3D模型
    await load3DModelWithPath(modelPath);

    // 初始化模型列表
    initializeModelList(configData);

    showOperationMessage(`成功加载配置文件: ${getFileName(currentConfigFile.value)}`, 'success');
  } catch (error) {
    console.error('加载配置文件失败:', error);
    showOperationMessage(`加载配置文件失败: ${error.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

// 使用指定路径加载3D模型
async function load3DModelWithPath(modelPath) {
  try {
    // 移除现有的模型
    if (tileset) {
      viewer.scene.primitives.remove(tileset);
      tileset = null;
    }

    // 加载新的模型
    tileset = await Cesium.Cesium3DTileset.fromUrl(modelPath);
    viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;

    originalModelMatrix = Cesium.Matrix4.clone(tileset.modelMatrix);
    applyModelTransform();
    await viewer.zoomTo(tileset);

    // 根据模型的实际大小动态调整切割平面的范围
    if (tileset && tileset.boundingSphere) {
      const modelBounds = tileset.boundingSphere;
      const modelRadius = modelBounds.radius;

      // 设置切割平面的范围为模型半径的1.5倍，确保可以覆盖整个模型
      sectionRange.value.min = -modelRadius * 1.5;
      sectionRange.value.max = modelRadius * 1.5;

      // 将初始切割位置重置到模型中心
      sectionPosition.value = 0;

      console.log('动态调整切割平面范围:');
      console.log('模型半径:', modelRadius);
      console.log('新的切割范围:', sectionRange.value);
    }

    // 扫描并存储所有要素
    scanAndStoreFeatures();

    // 初始化模型点击事件处理器
    initModelEventHandler();

    console.log(`矿山3D模型加载成功: ${modelPath}`);
  } catch (error) {
    console.error('模型加载失败:', error);
    throw new Error(`加载3D模型失败: ${error.message}`);
  }
}

// 启用/禁用剖面切割
function toggleSection() {
  if (!tileset) {
    showOperationMessage('请先加载模型', 'warning');
    isSectionEnabled.value = false;
    return;
  }

  if (isSectionEnabled.value) {
    // 启用切割
    if (!clippingPlaneCollection) {
      createClippingPlanes();
    }
    if (showSectionPlane.value) {
      displaySectionPlane();
    }
  } else {
    // 禁用切割
    removeClippingPlanes();
    hideSectionPlane();
  }
}

// 更新切割平面
function updateSectionPlane() {
  if (!clippingPlaneCollection || !tileset || !clippingPlaneCollection.planes) return;

  // 移除旧的切割平面
  clippingPlaneCollection.planes.length = 0;

  // 根据方向和位置创建切割平面
  let plane1, plane2;
  const position = sectionPosition.value;

  // 简单直接的方式：移除modelMatrix设置
  // 对于3DTileset，切割平面应该在世界坐标系中定义
  // 或者使用默认的变换
  clippingPlaneCollection.modelMatrix = undefined;

  // 根据选择的方向创建切割平面
  // 使用最基本的平面定义方式
  if (sectionDirection.value === 'x') {
    // 创建一个垂直于X轴的切割平面
    plane1 = new Cesium.ClippingPlane(new Cesium.Cartesian3(1.0, 0.0, 0.0), -position);
    clippingPlaneCollection.planes.push(plane1);

    // 如果有厚度，添加第二个平面
    if (sectionThickness.value > 0) {
      plane2 = new Cesium.ClippingPlane(new Cesium.Cartesian3(-1.0, 0.0, 0.0), position + sectionThickness.value);
      clippingPlaneCollection.planes.push(plane2);
    }
  } else if (sectionDirection.value === 'y') {
    // 创建一个垂直于Y轴的切割平面
    plane1 = new Cesium.ClippingPlane(new Cesium.Cartesian3(0.0, 1.0, 0.0), -position);
    clippingPlaneCollection.planes.push(plane1);

    if (sectionThickness.value > 0) {
      plane2 = new Cesium.ClippingPlane(new Cesium.Cartesian3(0.0, -1.0, 0.0), position + sectionThickness.value);
      clippingPlaneCollection.planes.push(plane2);
    }
  } else if (sectionDirection.value === 'z') {
    // 创建一个垂直于Z轴的切割平面
    plane1 = new Cesium.ClippingPlane(new Cesium.Cartesian3(0.0, 0.0, 1.0), -position);
    clippingPlaneCollection.planes.push(plane1);

    if (sectionThickness.value > 0) {
      plane2 = new Cesium.ClippingPlane(new Cesium.Cartesian3(0.0, 0.0, -1.0), position + sectionThickness.value);
      clippingPlaneCollection.planes.push(plane2);
    }
  }

  // 确保clippingPlaneCollection启用
  clippingPlaneCollection.enabled = true;

  // 移除origin设置，使用默认的原点
  clippingPlaneCollection.origin = undefined;

  // 确保切割平面的边缘可见
  clippingPlaneCollection.edgeWidth = 1.0;
  clippingPlaneCollection.edgeColor = Cesium.Color.WHITE;

  // 重新设置切割平面，确保更新
  tileset.clippingPlanes = clippingPlaneCollection;

  // 调试：输出切割平面信息
  console.log('切割平面信息：');
  console.log('方向:', sectionDirection.value);
  console.log('位置:', sectionPosition.value);
  console.log('厚度:', sectionThickness.value);
  console.log('模型变换矩阵:', tileset.modelMatrix);
  console.log('切割平面modelMatrix:', clippingPlaneCollection.modelMatrix);
  console.log('切割平面数量:', clippingPlaneCollection.planes.length);
  if (clippingPlaneCollection.planes.length > 0) {
    console.log('平面1参数:', clippingPlaneCollection.planes[0]);
  }

  // 更新切割面的显示
  if (showSectionPlane.value) {
    updateSectionPlaneDisplay();
  }
}

// 创建切割平面集合
function createClippingPlanes() {
  if (!tileset) return;

  // 如果已经存在clippingPlaneCollection，先销毁
  if (clippingPlaneCollection) {
    if (clippingPlaneCollection.isDestroyed && typeof clippingPlaneCollection.isDestroyed === 'function') {
      if (!clippingPlaneCollection.isDestroyed()) {
        clippingPlaneCollection.destroy();
      }
    }
    clippingPlaneCollection = null;
  }

  // 创建切割平面集合
  // 确保所有属性都正确设置
  clippingPlaneCollection = new Cesium.ClippingPlaneCollection({
    planes: [],
    enabled: true,
    unionClippingRegions: false,
    // 确保切割平面的边缘可见
    edgeWidth: 1.0,
    edgeColor: Cesium.Color.WHITE
  });

  // 确保3DTileset支持切割平面
  tileset.enableClippingPlanes = true;

  // 将切割平面集合应用到模型
  tileset.clippingPlanes = clippingPlaneCollection;

  // 初始化切割平面
  updateSectionPlane();
}

// 移除切割平面集合
function removeClippingPlanes() {
  if (clippingPlaneCollection && tileset) {
    tileset.clippingPlanes = undefined;
    // 检查对象是否已被销毁，避免重复调用destroy()
    if (clippingPlaneCollection.isDestroyed && typeof clippingPlaneCollection.isDestroyed === 'function') {
      if (!clippingPlaneCollection.isDestroyed()) {
        clippingPlaneCollection.destroy();
      }
    }
    clippingPlaneCollection = null;
  }
}

// 显示切割面
function displaySectionPlane() {
  if (!tileset || sectionPlaneEntity) return;

  updateSectionPlaneDisplay();
}

// 更新切割面显示
function updateSectionPlaneDisplay() {
  if (!viewer) return;

  // 移除旧的切割面实体
  if (sectionPlaneEntity) {
    viewer.entities.remove(sectionPlaneEntity);
    sectionPlaneEntity = null;
  }

  // 创建新的切割面实体
  const position = sectionPosition.value;
  const opacity = sectionPlaneOpacity.value / 100;

  // 获取颜色的RGB值
  const color = Cesium.Color.fromCssColorString(sectionPlaneColor.value).withAlpha(opacity);

  // 计算切割面的尺寸（假设模型在100x100x100的范围内）
  const size = 1000;

  // 直接创建平面实体，不使用PlaneGeometry
  // 根据方向和位置创建平面实体
  const entityPosition = Cesium.Cartesian3.fromDegrees(
    modelPosition.value.longitude,
    modelPosition.value.latitude,
    modelPosition.value.height
  );

  let planeOrientation;
  let planeDimensions;

  if (sectionDirection.value === 'x') {
    planeOrientation = new Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Y, Math.PI / 2);
    planeDimensions = new Cesium.Cartesian2(size, size);
  } else if (sectionDirection.value === 'y') {
    planeOrientation = new Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Math.PI / 2);
    planeDimensions = new Cesium.Cartesian2(size, size);
  } else {
    planeOrientation = Cesium.Quaternion.IDENTITY;
    planeDimensions = new Cesium.Cartesian2(size, size);
  }

  // 根据方向调整平面位置
  const offset = new Cesium.Cartesian3();
  if (sectionDirection.value === 'x') {
    offset.x = position;
  } else if (sectionDirection.value === 'y') {
    offset.y = position;
  } else {
    offset.z = position;
  }

  const planePosition = Cesium.Cartesian3.add(entityPosition, offset, new Cesium.Cartesian3());

  // 创建平面实体
  sectionPlaneEntity = viewer.entities.add({
    name: 'Section Plane',
    position: planePosition,
    orientation: planeOrientation,
    plane: {
      dimensions: planeDimensions,
      material: color,
      outline: true,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2
    }
  });
}

// 隐藏切割面
function hideSectionPlane() {
  if (sectionPlaneEntity && viewer) {
    viewer.entities.remove(sectionPlaneEntity);
    sectionPlaneEntity = null;
  }
}

// 重置切割设置
function resetSection() {
  sectionDirection.value = 'x';
  sectionPosition.value = 0;
  sectionThickness.value = 0;
  showSectionPlane.value = true;
  sectionPlaneColor.value = '#FF0000';
  sectionPlaneOpacity.value = 50;

  if (isSectionEnabled.value) {
    updateSectionPlane();
  }
}

// 启用/禁用多切面切割
function toggleMultipleSections() {
  isMultipleSectionsEnabled.value = !isMultipleSectionsEnabled.value;
  // 多切面功能可以在后续扩展
  showOperationMessage(isMultipleSectionsEnabled.value ? '多切面切割已启用' : '多切面切割已禁用', 'success');
}

// 重新加载当前配置文件
function reloadCurrentConfig() {
  if (currentConfigFile.value) {
    loadSelectedConfig();
  } else {
    showOperationMessage('请先选择一个配置文件', 'warning');
  }
}

// 上传配置文件
function uploadConfigFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (event) => {
    const file = event.target.files[0];
    if (file) {
      try {
        const content = await readFileAsText(file);
        const configData = JSON.parse(content);

        // 添加到配置文件列表
        modelConfigFiles.value.push({
          name: file.name,
          path: `uploaded_${Date.now()}_${file.name}`,
          content: configData
        });

        // 使用上传的配置
        currentConfigFile.value = `uploaded_${Date.now()}_${file.name}`;
        initializeModelList(configData);

        showOperationMessage(`成功上传并应用配置文件: ${file.name}`, 'success');
      } catch (error) {
        console.error('上传配置文件失败:', error);
        showOperationMessage('上传配置文件失败: 文件格式错误', 'error');
      }
    }
  };
  input.click();
}

// 读取文件为文本
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = (error) => reject(error);
    reader.readAsText(file);
  });
}

// 获取文件名
function getFileName(path) {
  return path.split('/').pop() || path;
}

// 增强的模型列表初始化函数
function initializeModelList(propertiesData) {
  if (propertiesData.modelMappings && Array.isArray(propertiesData.modelMappings)) {
    modelList.value = propertiesData.modelMappings.map(model => ({
      ...model,
      visible: true,
      opacity: 0,  // 0%表示完全不透明
      // 确保所有必要的属性都存在
      geologyProperties: model.geologyProperties || {},
      miningProperties: model.miningProperties || {},
      safetyProperties: model.safetyProperties || {}
    }));

    // 扫描并存储要素
    scanAndStoreFeatures();

    showOperationMessage(`成功加载 ${modelList.value.length} 个模型的配置信息`, 'success');
  } else {
    // 确保先扫描要素
    if (featureMap.size === 0 && tileset) {
      scanAndStoreFeatures();
    }
    // 延迟调用initializeDefaultModelList，确保featureMap有时间填充
    setTimeout(() => {
      initializeDefaultModelList();
      showOperationMessage('配置文件格式不正确，使用默认配置', 'warning');
    }, 500);
  }
}

// 地质分析相关函数
function queryBoreholeInfo() {
  currentBorehole.value = boreholes.value.find(b => b.id === selectedBorehole.value)
  if (currentBorehole.value) {
    showOperationMessage(`已查询钻孔 ${currentBorehole.value.name} 的信息`, 'success')
  }
}

function getGradeClass(grade) {
  if (grade >= 3) return 'high-grade'
  if (grade >= 2) return 'medium-grade'
  return 'low-grade'
}

// 测量相关函数
function toggleMeasurement() {
  if (isMeasuring.value) {
    stopMeasurement()
  } else {
    if (isAreaMeasuring.value) {
      stopAreaMeasurement()
    }
    startDistanceMeasurement()
  }
}

function toggleAreaMeasurement() {
  if (isAreaMeasuring.value) {
    stopAreaMeasurement()
  } else {
    if (isMeasuring.value) {
      stopMeasurement()
    }
    startAreaMeasurement()
  }
}

function startDistanceMeasurement() {
  clearCurrentMeasurement()
  isMeasuring.value = true
  viewer.canvas.style.cursor = 'crosshair'

  measurementHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

  measurementHandler.setInputAction((event) => {
    const position = getPositionFromClick(event.position)
    if (!position) return
    addMeasurementPoint(position)
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 右键退出测量，无论是否有测量点
  measurementHandler.setInputAction((event) => {
    if (measurementPoints.value.length >= 2) {
      saveMeasurementToHistory('distance')
    }
    stopMeasurement()
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

  measurementHandler.setInputAction((event) => {
    if (measurementPoints.value.length > 0) {
      updateTemporaryLine(event.endPosition)
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
}

function stopMeasurement() {
  if (measurementHandler) {
    measurementHandler.destroy()
    measurementHandler = null
  }
  resetCursor()
  isMeasuring.value = false
  const tempLine = viewer.entities.getById('measurement-temp-line')
  if (tempLine) {
    viewer.entities.remove(tempLine)
  }
}

function startAreaMeasurement() {
  clearCurrentMeasurement()
  isAreaMeasuring.value = true
  viewer.canvas.style.cursor = 'crosshair'

  areaMeasurementHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

  areaMeasurementHandler.setInputAction((event) => {
    const position = getPositionFromClick(event.position)
    if (!position) return
    addMeasurementPoint(position)
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 右键退出测量，无论是否有测量点
  areaMeasurementHandler.setInputAction((event) => {
    if (measurementPoints.value.length >= 3) {
      saveMeasurementToHistory('area')
    }
    stopAreaMeasurement()
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

  areaMeasurementHandler.setInputAction((event) => {
    if (measurementPoints.value.length > 0) {
      updateTemporaryLine(event.endPosition)
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
}

function stopAreaMeasurement() {
  if (areaMeasurementHandler) {
    areaMeasurementHandler.destroy()
    areaMeasurementHandler = null
  }
  resetCursor()
  isAreaMeasuring.value = false
  const tempLine = viewer.entities.getById('measurement-temp-line')
  if (tempLine) {
    viewer.entities.remove(tempLine)
  }
  if (measurementPoints.value.length >= 3) {
    drawAreaPolygon()
  }
}

// 清除当前测量（不清除历史）
function clearCurrentMeasurement() {
  resetCursor()
  measurementEntities.value.forEach(entity => {
    viewer.entities.remove(entity)
  })
  measurementEntities.value = []

  const tempLine = viewer.entities.getById('measurement-temp-line')
  if (tempLine) {
    viewer.entities.remove(tempLine)
  }

  measurementPoints.value = []
  measurementDistance.value = 0
  measurementArea.value = 0

  if (isMeasuring.value) {
    stopMeasurement()
  }
  if (isAreaMeasuring.value) {
    stopAreaMeasurement()
  }
}

// 清除所有测量（包括历史）
function clearAllMeasurements() {
  clearCurrentMeasurement()
  clearMeasurementHistory()
}

// 清除测量历史
function clearMeasurementHistory() {
  measurementHistory.value = []
  localStorage.removeItem('measurementHistory')
  showOperationMessage('已清除所有测量历史', 'success')
}

// 删除单个测量记录
function deleteMeasurementRecord(recordId) {
  measurementHistory.value = measurementHistory.value.filter(record => record.id !== recordId)
  const saveData = measurementHistory.value.map(record => ({
    ...record,
    points: record.points.map(p => ({ x: p.x, y: p.y, z: p.z }))
  }))
  localStorage.setItem('measurementHistory', JSON.stringify(saveData))
  showOperationMessage('已删除测量记录', 'success')
}

function saveMeasurementToHistory(type) {
  if ((type === 'distance' && measurementDistance.value === 0) ||
    (type === 'area' && measurementArea.value === 0)) {
    return
  }

  const record = {
    id: Date.now(),
    type: type,
    distance: type === 'distance' ? measurementDistance.value : 0,
    area: type === 'area' ? measurementArea.value : 0,
    points: measurementPoints.value.map(point => ({
      x: point.x,
      y: point.y,
      z: point.z
    })),
    timestamp: new Date().getTime()
  }

  measurementHistory.value.unshift(record)
  const saveData = measurementHistory.value.map(record => ({
    ...record,
    points: record.points.map(p => ({ x: p.x, y: p.y, z: p.z }))
  }))
  localStorage.setItem('measurementHistory', JSON.stringify(saveData))
}

function resetCursor() {
  if (viewer && viewer.canvas) {
    viewer.canvas.style.cursor = 'default'
  }
}

function getPositionFromClick(screenPosition) {
  if (!viewer) return null

  try {
    const pickedObject = viewer.scene.pick(screenPosition)

    if (pickedObject && (pickedObject.primitive instanceof Cesium.Cesium3DTileset || pickedObject.id)) {
      const position = viewer.scene.pickPosition(screenPosition)
      if (position && Cesium.Cartesian3.distance(position, Cesium.Cartesian3.ZERO) > 0) {
        return position
      }
    }

    const ray = viewer.camera.getPickRay(screenPosition)
    const terrainPosition = viewer.scene.globe.pick(ray, viewer.scene)
    if (terrainPosition) {
      return terrainPosition
    }

    const ellipsoidPosition = viewer.scene.camera.pickEllipsoid(screenPosition, viewer.scene.globe.ellipsoid)
    return ellipsoidPosition

  } catch (error) {
    console.error('获取点击位置失败:', error)
    return null
  }
}

function addMeasurementPoint(position) {
  measurementPoints.value.push(position)

  const pointEntity = viewer.entities.add({
    position: position,
    point: {
      pixelSize: 6,
      color: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      heightReference: Cesium.HeightReference.NONE
    },
    label: {
      text: `${measurementPoints.value.length}`,
      font: '12px sans-serif',
      pixelOffset: new Cesium.Cartesian2(0, -15),
      fillColor: Cesium.Color.WHITE,
      backgroundColor: Cesium.Color.BLACK,
      backgroundPadding: new Cesium.Cartesian2(3, 3),
      showBackground: true,
      heightReference: Cesium.HeightReference.NONE
    }
  })

  measurementEntities.value.push(pointEntity)

  if (measurementPoints.value.length >= 2) {
    const startPoint = measurementPoints.value[measurementPoints.value.length - 2]
    const endPoint = measurementPoints.value[measurementPoints.value.length - 1]
    const distance = Cesium.Cartesian3.distance(startPoint, endPoint)
    measurementDistance.value += distance

    const lineEntity = viewer.entities.add({
      polyline: {
        positions: [startPoint, endPoint],
        width: 2,
        material: Cesium.Color.CYAN,
        clampToGround: false
      }
    })

    measurementEntities.value.push(lineEntity)
  }
}

function updateTemporaryLine(screenPosition) {
  const position = getPositionFromClick(screenPosition)
  if (!position || measurementPoints.value.length === 0) return

  const lastPoint = measurementPoints.value[measurementPoints.value.length - 1]
  const tempLine = viewer.entities.getById('measurement-temp-line')
  if (tempLine) {
    viewer.entities.remove(tempLine)
  }

  viewer.entities.add({
    id: 'measurement-temp-line',
    polyline: {
      positions: [lastPoint, position],
      width: 1,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.WHITE,
        dashLength: 8
      }),
      clampToGround: false
    }
  })
}

function drawAreaPolygon() {
  if (measurementPoints.value.length < 3) return

  const polygonPoints = [...measurementPoints.value, measurementPoints.value[0]]
  const polygonEntity = viewer.entities.add({
    polygon: {
      hierarchy: polygonPoints,
      material: Cesium.Color.GREEN.withAlpha(0.2),
      outline: true,
      outlineColor: Cesium.Color.GREEN,
      outlineWidth: 1,
      heightReference: Cesium.HeightReference.NONE
    }
  })

  measurementEntities.value.push(polygonEntity)
  const area = calculatePolygonArea3D(polygonPoints)
  measurementArea.value = area
}

function calculatePolygonArea3D(points) {
  if (points.length < 3) return 0
  let area = 0
  const n = points.length
  const referencePoint = points[0]

  for (let i = 1; i < n - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    const v1 = Cesium.Cartesian3.subtract(p1, referencePoint, new Cesium.Cartesian3())
    const v2 = Cesium.Cartesian3.subtract(p2, referencePoint, new Cesium.Cartesian3())
    const crossProduct = Cesium.Cartesian3.cross(v1, v2, new Cesium.Cartesian3())
    const triangleArea = Cesium.Cartesian3.magnitude(crossProduct) / 2
    area += triangleArea
  }
  return Math.abs(area)
}

function loadMeasurementHistory() {
  const savedHistory = localStorage.getItem('measurementHistory')
  if (savedHistory) {
    try {
      const history = JSON.parse(savedHistory)
      measurementHistory.value = history
    } catch (e) {
      console.error('加载测量历史记录失败:', e)
    }
  }
}

// 其他功能函数
function showVolumeAnalysis() {
  showOperationMessage('体积分析功能开发中', 'info')
}

function showSlopeAnalysis() {
  showOperationMessage('坡度分析功能开发中', 'info')
}

function showVisibilityAnalysis() {
  showOperationMessage('可视域分析功能开发中', 'info')
}

function exportSceneData() {
  showOperationMessage('场景数据导出功能开发中', 'info')
}

function exportReport() {
  showOperationMessage('分析报告生成功能开发中', 'info')
}

function exportScreenshot() {
  showOperationMessage('截图保存功能开发中', 'info')
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

// 更新时间
function updateTime() {
  const now = new Date()
  currentTime.value = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
}

// Cesium初始化
onMounted(async () => {
  try {
    // 启动时间更新
    updateTime()
    setInterval(updateTime, 1000)

    loading.value = true
    viewer = new Cesium.Viewer("cesiumContainer", {
      animation: false,
      timeline: false,
      homeButton: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      selectionIndicator: false,
      infoBox: false,
      terrainProvider: await Cesium.createWorldTerrainAsync()
    });

    // 设置矿山主题背景色
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#1a2434');

    // 隐藏版权信息和其他控件
    try {
      if (viewer.cesiumWidget.creditContainer) {
        viewer.cesiumWidget.creditContainer.style.display = 'none'
      }
    } catch (e) {
      console.log('隐藏版权信息失败:', e)
    }

    // 使用CSS选择器隐藏其他控件
    setTimeout(() => {
      try {
        const toolbar = document.querySelector('.cesium-viewer-toolbar')
        if (toolbar) toolbar.style.display = 'none'
        const bottomContainer = document.querySelector('.cesium-viewer-bottom')
        if (bottomContainer) bottomContainer.style.display = 'none'
      } catch (e) {
        console.log('隐藏控件失败:', e)
      }
    }, 100)

    // 设置更专业的初始视角
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(113.323, 23.106, 800),
      orientation: {
        heading: 0.0,
        pitch: -0.7,
        roll: 0.0
      }
    });

    // 加载3D模型
    await load3DModel()
    viewer.scene.postRender.addEventListener(updatePositionInfo)
    viewer.scene.postRender.addEventListener(updateCameraInfo)

    // 加载测量历史记录
    loadMeasurementHistory()

    // 加载模型属性数据
    await loadModelProperties()

    showOperationMessage('矿山模型管理系统初始化完成', 'success')
  } catch (error) {
    console.error('Cesium初始化失败:', error)
    showOperationMessage('系统初始化失败，请检查控制台错误信息', 'error')
  } finally {
    loading.value = false
  }
})

// 加载3D模型
async function load3DModel() {
  try {
    // 使用默认的demo4模型路径
    const modelPath = './3d/demo4/tileset.json'
    await load3DModelWithPath(modelPath)

    // 加载对应的配置文件
    await loadModelProperties()

    console.log('矿山3D模型加载成功')
  } catch (error) {
    console.error('模型加载失败:', error)
    showOperationMessage('模型加载失败，请检查控制台错误信息', 'error')
  }
}

// 更新坐标信息 - 使用节流优化性能
let updatePositionTimer = null
function updatePositionInfo() {
  if (!viewer) return
  if (updatePositionTimer) return

  updatePositionTimer = setTimeout(() => {
    const camera = viewer.camera
    const position = camera.position
    const cartographic = Cesium.Cartographic.fromCartesian(position)

    currentCoordinates.longitude = Cesium.Math.toDegrees(cartographic.longitude)
    currentCoordinates.latitude = Cesium.Math.toDegrees(cartographic.latitude)
    currentCoordinates.height = cartographic.height

    updatePositionTimer = null
  }, 100)
}

// 更新相机信息 - 使用节流优化性能
let updateCameraTimer = null
function updateCameraInfo() {
  if (!viewer) return
  if (updateCameraTimer) return

  updateCameraTimer = setTimeout(() => {
    const camera = viewer.camera
    cameraInfo.heading = Cesium.Math.toDegrees(camera.heading)
    cameraInfo.pitch = Cesium.Math.toDegrees(camera.pitch)
    cameraInfo.roll = Cesium.Math.toDegrees(camera.roll)

    updateCameraTimer = null
  }, 100)
}

</script>

<style scoped>
/* 统一的面板样式 - 专业简洁设计 */
.control-panel {
  position: fixed;
  background: rgba(15, 23, 42, 0.96);
  color: white;
  z-index: 1000;
  max-height: 80vh;
  overflow-y: auto;
  border: 1px solid rgba(100, 116, 139, 0.2);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  transition: all 0.3s ease;
  backdrop-filter: blur(8px);
}

/* 左侧面板 - 专业简洁设计 */
.left-panel {
  top: 80px;
  left: 0;
  width: 300px;
  border-radius: 0 4px 4px 0;
  border-left: none;
  overflow-x: hidden;
}

.panel-collapsed {
  transform: translateX(calc(-100% + 50px));
}

/* 右侧面板 - 专业简洁设计 */
.right-panel {
  top: 80px;
  right: 0;
  width: 320px;
  border-radius: 4px 0 0 4px;
}

.right-panel.panel-collapsed {
  transform: translateX(calc(100% - 50px));
}

/* 面板把手 - 专业简洁设计 */
.panel-handle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(30, 41, 59, 0.95);
  border-bottom: 1px solid rgba(100, 116, 139, 0.2);
  cursor: pointer;
  transition: all 0.2s ease;
}

.left-panel .panel-handle {
  border-radius: 0 4px 0 0;
}

.right-panel .panel-handle {
  border-radius: 4px 0 0 0;
}

.panel-handle:hover {
  background: rgba(51, 65, 85, 0.95);
}

.panel-icon {
  font-size: 16px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}

.panel-text {
  font-size: 13px;
  font-weight: 600;
  color: #94A3B8;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 面板内容区域 - 紧凑布局 */
.left-panel .panel-content {
  padding: 14px;
  max-height: 70vh;
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  width: 100%;
}

/* 右侧面板内容区域 */
.right-panel .panel-content {
  padding: 14px;
  max-height: 70vh;
  overflow-y: auto;
}

/* 面板区域 - 紧凑布局 */
.panel-section {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(100, 116, 139, 0.15);
}

.panel-section:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.panel-section h4 {
  margin-bottom: 12px;
  color: #94A3B8;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-left: 2px solid #64748B;
  padding-left: 8px;
}

/* 左侧面板控制组 - 紧凑布局 */
.left-panel .control-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
  width: 100%;
  box-sizing: border-box;
}

.left-panel .control-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 500;
  font-size: 12px;
  color: #94A3B8;
  width: 100%;
}

.left-panel .control-inputs {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  flex-wrap: wrap;
}

.input-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(71, 85, 105, 0.9);
  color: white;
  border: none;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: bold;
  font-size: 13px;
  flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.input-btn:hover {
  background: rgba(100, 116, 139, 0.9);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.slider {
  flex: 1;
  min-width: 120px;
  max-width: 180px;
  height: 6px;
  border-radius: 3px;
  background: #334155;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  background: #64748B;
  cursor: pointer;
  border: 2px solid #FFFFFF;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  transition: all 0.2s ease;
}

.slider::-webkit-slider-thumb:hover {
  transform: scale(1.05);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}

.number-input {
  width: 70px;
  padding: 4px 6px;
  background: rgba(30, 41, 59, 0.8);
  color: white;
  border: 1px solid rgba(100, 116, 139, 0.4);
  border-radius: 2px;
  font-size: 11px;
  text-align: center;
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.number-input:focus {
  outline: none;
  border-color: #64748B;
  box-shadow: 0 0 0 2px rgba(100, 116, 139, 0.2);
  background: rgba(30, 41, 59, 0.95);
}

.value-display {
  text-align: right;
  font-size: 11px;
  color: #94A3B8;
  font-weight: 600;
  width: 100%;
  margin-top: 4px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 按钮样式 - 专业简洁设计 */
.action-buttons {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  width: 100%;
  box-sizing: border-box;
}

.action-btn {
  padding: 8px 12px;
  color: white;
  border: none;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
  font-weight: 500;
  flex: 1;
  box-sizing: border-box;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  position: relative;
  overflow: hidden;
}

.action-btn::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  transform: translate(-50%, -50%);
  transition: width 0.4s, height 0.4s;
}

.action-btn:hover::before {
  width: 300px;
  height: 300px;
}

.action-btn.primary {
  background: rgba(59, 130, 246, 0.9);
  border: 1px solid rgba(59, 130, 246, 0.5);
}

.action-btn.primary:hover {
  background: rgba(37, 99, 235, 0.95);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(59, 130, 246, 0.3);
}

.action-btn.secondary {
  background: rgba(71, 85, 105, 0.9);
  border: 1px solid rgba(71, 85, 105, 0.5);
}

.action-btn.secondary:hover {
  background: rgba(51, 65, 85, 0.95);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(100, 116, 139, 0.3);
}

.action-btn.small {
  padding: 5px 8px;
  font-size: 11px;
  flex: none;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.action-btn:disabled:hover {
  transform: none;
}

.action-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
}

/* 按钮组 */
.action-buttons-group {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
  width: 100%;
  box-sizing: border-box;
}

.action-buttons-small {
  display: flex;
  gap: 4px;
}

/* 功能标签导航 - 简洁设计 */
.function-tabs {
  margin-bottom: 14px;
  width: 100%;
}

.tab-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  background: rgba(30, 41, 59, 0.6);
  border-radius: 4px;
  padding: 4px;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(100, 116, 139, 0.2);
}

.tab-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 6px;
  background: transparent;
  color: #64748B;
  border: none;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}

.tab-button:hover {
  background: rgba(71, 85, 105, 0.5);
  color: #94A3B8;
}

.tab-button.active {
  background: rgba(71, 85, 105, 0.8);
  color: #E2E8F0;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.tab-icon {
  font-size: 14px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}

.tab-text {
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 标签内容 - 现代化设计 */
.tab-content {
  max-height: 65vh;
  overflow-y: auto;
  width: 100%;
  box-sizing: border-box;
}

/* 右侧面板新样式 - 现代化设计 */
/* 全局控制 */
.global-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  padding: 16px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
  border-radius: 10px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.global-control .control-label {
  font-size: 13px;
  font-weight: 600;
  color: #E2E8F0;
}

.global-control .control-inputs {
  flex: 1;
  max-width: 220px;
  gap: 12px;
}

/* 紧凑模型列表 - 专业简洁设计 */
.compact-model-list {
  margin-bottom: 14px;
  max-height: 200px;
  overflow-y: auto;
}

.compact-model-item {
  padding: 10px;
  margin-bottom: 8px;
  background: rgba(30, 41, 59, 0.7);
  border-radius: 2px;
  border-left: 2px solid #64748B;
  transition: all 0.2s ease;
  cursor: pointer;
  position: relative;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.compact-model-item:hover,
.compact-model-item.hover-highlight {
  background: rgba(51, 65, 85, 0.8);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  border-left: 2px solid #94A3B8;
}

.compact-model-checkbox {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
}

.compact-model-name {
  flex: 1;
  color: #F1F5F9;
  transition: color 0.3s ease;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.compact-model-item:hover .compact-model-name,
.compact-model-item.hover-highlight .compact-model-name {
  color: #FBBF24;
}

.compact-model-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.compact-opacity-control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
}

.opacity-label {
  font-size: 12px;
  color: #94A3B8;
  font-weight: 500;
}

.compact-opacity-slider {
  width: 100px;
  height: 6px;
  background: #334155;
  border-radius: 3px;
  -webkit-appearance: none;
  appearance: none;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
}

.compact-opacity-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: linear-gradient(135deg, #FBBF24, #D97706);
  cursor: pointer;
  border: 3px solid #FFFFFF;
  box-shadow: 0 2px 8px rgba(251, 191, 36, 0.4);
}

.compact-opacity-value {
  font-size: 12px;
  color: #FBBF24;
  font-weight: 600;
  min-width: 30px;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.compact-action-buttons {
  display: flex;
  gap: 6px;
}

.compact-action-btn {
  padding: 8px 12px;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s ease;
  font-size: 12px;
  background: linear-gradient(135deg, #475569, #64748B);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.compact-action-btn.primary {
  background: linear-gradient(135deg, #3B82F6, #2563EB);
}

.compact-action-btn.secondary {
  background: linear-gradient(135deg, #64748B, #475569);
}

.compact-action-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.compact-action-buttons-group {
  display: flex;
  gap: 10px;
  margin-top: 15px;
}

.compact-action-buttons-group .compact-action-btn {
  flex: 1;
}

/* 属性查看器 - 现代化设计 */
.property-section {
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(51, 65, 85, 0.9));
  border-radius: 10px;
  padding: 16px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.compact-property-content {
  margin-top: 12px;
}

.compact-property-group {
  margin-bottom: 16px;
}

.compact-property-group h5 {
  font-size: 13px;
  color: #FBBF24;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(100, 116, 139, 0.3);
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.compact-property-item {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 6px 0;
  font-size: 12px;
  transition: all 0.3s ease;
}

.compact-property-item:hover {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 6px 8px;
}

.compact-property-label {
  color: #94A3B8;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.compact-property-value {
  color: #F1F5F9;
  text-align: right;
  max-width: 60%;
  word-break: break-word;
  font-weight: 500;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.compact-property-actions {
  display: flex;
  gap: 10px;
  margin-top: 15px;
  justify-content: center;
}

/* 统计信息和查询合并部分 - 现代化设计 */
.combined-section {
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(51, 65, 85, 0.9));
  border-radius: 10px;
  padding: 16px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.stats-container {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: linear-gradient(135deg, rgba(51, 65, 85, 0.8), rgba(71, 85, 105, 0.8));
  border-radius: 8px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.stat-card-icon {
  font-size: 18px;
  background: linear-gradient(135deg, #60A5FA, #3B82F6);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: white;
  box-shadow: 0 2px 8px rgba(96, 165, 250, 0.4);
}

.stat-card-content {
  flex: 1;
}

.stat-card-value {
  font-size: 16px;
  font-weight: 700;
  color: #60A5FA;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.stat-card-label {
  font-size: 11px;
  color: #94A3B8;
  font-weight: 500;
  text-shadow: 0 0.5px 1px rgba(0, 0, 0, 0.3);
}

.query-container {
  margin-top: 15px;
}

.query-input {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.query-input label {
  font-size: 12px;
  color: #aaa;
  min-width: 70px;
}

.query-select {
  flex: 1;
  padding: 6px 8px;
  background: rgba(45, 55, 72, 0.8);
  color: #e2e8f0;
  border: 1px solid #718096;
  border-radius: 4px;
  font-size: 12px;
}

.borehole-info {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 10px;
  margin-top: 10px;
}

.borehole-details {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.borehole-detail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}

.detail-label {
  font-size: 10px;
  color: #a0aec0;
  margin-bottom: 4px;
}

.detail-value {
  font-size: 12px;
  font-weight: 500;
  color: #e2e8f0;
}

/* 矿体信息 */
.orebody-section {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 12px;
}

.orebody-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.orebody-card {
  padding: 10px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  border-left: 3px solid #4299e1;
  transition: all 0.3s ease;
}

.orebody-card:hover {
  background: rgba(255, 255, 255, 0.12);
  transform: translateY(-2px);
}

.orebody-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.orebody-card-name {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}

.orebody-card-grade {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.orebody-card-grade.high-grade {
  background: rgba(72, 187, 120, 0.2);
  color: #48bb78;
}

.orebody-card-grade.medium-grade {
  background: rgba(246, 173, 85, 0.2);
  color: #f6ad55;
}

.orebody-card-grade.low-grade {
  background: rgba(160, 174, 192, 0.2);
  color: #a0aec0;
}

.orebody-card-details {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.orebody-card-detail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}

/* 测量分析样式 - 现代化设计 */
.measurement-controls {
  margin-bottom: 20px;
}

.measurement-type-selector {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 15px;
}

.measurement-type-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 12px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
  color: #94A3B8;
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.measurement-type-btn:hover {
  background: linear-gradient(135deg, rgba(51, 65, 85, 0.9), rgba(71, 85, 105, 0.9));
  color: #E2E8F0;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.measurement-type-btn.active {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(37, 99, 235, 0.3));
  border-color: #60A5FA;
  color: #60A5FA;
  box-shadow: 0 4px 12px rgba(96, 165, 250, 0.3);
}

.measurement-icon {
  font-size: 20px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.measurement-text {
  font-size: 13px;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.measurement-actions {
  display: flex;
  justify-content: center;
}

.measurement-results {
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(51, 65, 85, 0.9));
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 20px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.result-item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  padding: 8px 0;
}

.result-item:last-child {
  margin-bottom: 0;
}

.result-icon {
  font-size: 16px;
  color: #60A5FA;
}

.result-text {
  font-size: 13px;
  color: #48BB78;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 测量历史样式 */
.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  transition: all 0.3s ease;
}

.history-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.history-info {
  flex: 1;
}

.history-type {
  font-size: 11px;
  color: #a0aec0;
}

.history-value {
  font-size: 12px;
  color: #e2e8f0;
  font-weight: 500;
  margin: 2px 0;
}

.history-time {
  font-size: 10px;
  color: #718096;
}

.delete-btn {
  background: rgba(220, 38, 38, 0.2);
  border: 1px solid rgba(220, 38, 38, 0.3);
}

.delete-btn:hover {
  background: rgba(220, 38, 38, 0.3);
}

/* 分析工具样式 - 现代化设计 */
.analysis-tools {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.analysis-tool-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 12px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
  color: #94A3B8;
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.analysis-tool-btn:hover {
  background: linear-gradient(135deg, rgba(51, 65, 85, 0.9), rgba(71, 85, 105, 0.9));
  color: #E2E8F0;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.tool-icon {
  font-size: 18px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.tool-text {
  font-size: 12px;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 其他功能样式 - 现代化设计 */
.export-options {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.export-option-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
  color: #94A3B8;
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  text-align: left;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.export-option-btn:hover {
  background: linear-gradient(135deg, rgba(51, 65, 85, 0.9), rgba(71, 85, 105, 0.9));
  color: #E2E8F0;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.export-icon {
  font-size: 18px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.export-text {
  font-size: 13px;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.system-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  transition: all 0.3s ease;
}

.setting-item:hover {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 10px 8px;
}

.setting-label {
  font-size: 13px;
  color: #F1F5F9;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.setting-select {
  padding: 6px 10px;
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(51, 65, 85, 0.8));
  color: #F1F5F9;
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 6px;
  font-size: 12px;
  width: 140px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  transition: all 0.3s ease;
}

.setting-select:focus {
  outline: none;
  border-color: #60A5FA;
  box-shadow: 0 4px 12px rgba(96, 165, 250, 0.3);
}

.developing-features {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  font-size: 11px;
  transition: all 0.3s ease;
}

.feature-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.feature-item.developing {
  opacity: 0.6;
}

.feature-icon {
  font-size: 12px;
}

.feature-text {
  color: #e2e8f0;
}

/* 通用复选框样式 */
.checkmark {
  position: relative;
  width: 16px;
  height: 16px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  margin-right: 8px;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

input[type="checkbox"] {
  display: none;
}

input[type="checkbox"]:checked+.checkmark {
  background: #ed8936;
  border-color: #ed8936;
}

input[type="checkbox"]:checked+.checkmark:after {
  content: '✓';
  position: absolute;
  color: white;
  font-size: 10px;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* 滚动条样式 - 隐藏滚动条但保持滚动功能 */
.control-panel::-webkit-scrollbar,
.compact-model-list::-webkit-scrollbar,
.tab-content::-webkit-scrollbar,
.compact-property-content::-webkit-scrollbar {
  display: none;
}

/* 为Firefox隐藏滚动条 */
.control-panel,
.compact-model-list,
.tab-content,
.compact-property-content {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

/* 响应式设计 */
@media (max-width: 768px) {

  .left-panel,
  .right-panel {
    width: calc(100vw - 30px);
  }

  .panel-collapsed {
    transform: translateX(calc(-100% + 40px));
  }

  .right-panel.panel-collapsed {
    transform: translateX(calc(100% - 40px));
  }

  /* 移动端进一步优化左侧面板 */
  .left-panel .control-inputs {
    flex-direction: column;
    align-items: stretch;
  }

  .left-panel .slider {
    max-width: 100%;
  }
}

/* 底部状态栏 - 现代化设计 */
.status-bar {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 24px;
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(30, 41, 59, 0.98));
  color: white;
  padding: 12px 28px;
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(15px);
  border: 1px solid rgba(100, 116, 139, 0.3);
  z-index: 999;
  max-width: 90vw;
  overflow: hidden;
  transition: all 0.3s ease;
}

.status-bar:hover {
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.99), rgba(30, 41, 59, 0.99));
}

.status-item {
  display: flex;
  gap: 6px;
  font-size: 12px;
  align-items: center;
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  transition: all 0.3s ease;
}

.status-item:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateY(-2px);
}

.status-label {
  color: #94A3B8;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.status-value {
  color: #F1F5F9;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.status-value.measuring {
  color: #10B981;
  animation: blink 1.5s ease-in-out infinite;
}

@keyframes blink {

  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.6;
  }
}

/* 操作提示样式 - 现代化设计 */
.operation-message {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: linear-gradient(135deg, #10B981, #059669);
  color: white;
  padding: 14px 28px;
  border-radius: 10px;
  z-index: 3000;
  font-weight: 600;
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4);
  animation: slideDown 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  max-width: 80vw;
  text-align: center;
  border: 1px solid rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  gap: 10px;
}

.operation-message::before {
  content: '✔';
  font-size: 16px;
  background: rgba(255, 255, 255, 0.2);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.operation-message.error {
  background: linear-gradient(135deg, #DC2626, #B91C1C);
  box-shadow: 0 4px 16px rgba(220, 38, 38, 0.4);
}

.operation-message.error::before {
  content: '✖';
}

@keyframes slideDown {
  from {
    transform: translateX(-50%) translateY(-30px);
    opacity: 0;
  }

  to {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }
}

/* 加载指示器样式 - 现代化设计 */
.loading-indicator {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(30, 41, 59, 0.98));
  color: white;
  padding: 30px 40px;
  border-radius: 16px;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(15px);
  border: 1px solid rgba(100, 116, 139, 0.3);
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.9);
  }

  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

/* 新增：配置文件管理样式 */
.config-control {
  margin-bottom: 15px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.config-inputs {
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.config-file-selector {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.config-file-selector label {
  font-size: 11px;
  color: #aaa;
  font-weight: 500;
}

.config-select {
  padding: 6px 8px;
  background: rgba(45, 55, 72, 0.8);
  color: #e2e8f0;
  border: 1px solid #718096;
  border-radius: 4px;
  font-size: 11px;
  width: 100%;
}

.config-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-start;
}

.config-actions .compact-action-btn {
  flex: 1;
  font-size: 10px;
  padding: 6px 8px;
}

/* 模型属性查看器增强样式 */
.compact-property-content {
  max-height: 300px;
  overflow-y: auto;
}

.compact-property-group {
  margin-bottom: 15px;
}

.compact-property-group h5 {
  margin: 0 0 8px 0;
  font-size: 12px;
  color: #ed8936;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 4px;
}

.compact-property-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.compact-property-item:last-child {
  border-bottom: none;
}

.compact-property-label {
  font-size: 11px;
  color: #aaa;
  font-weight: 500;
  flex-shrink: 0;
}

.compact-property-value {
  font-size: 11px;
  color: #e2e8f0;
  text-align: right;
  word-break: break-word;
  margin-left: 8px;
}

.compact-property-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  justify-content: center;
}

/* 模型列表增强样式 */
.compact-model-item {
  transition: all 0.3s ease;
}

.compact-model-item.hover-highlight {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}

.compact-model-checkbox {
  display: flex;
  align-items: center;
  cursor: pointer;
  flex: 1;
}

.compact-model-name {
  font-size: 11px;
  font-weight: 500;
  color: #e2e8f0;
}

.compact-model-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.compact-opacity-control {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}

.opacity-label {
  color: #aaa;
  white-space: nowrap;
}

.compact-opacity-slider {
  width: 60px;
  height: 4px;
}

.compact-opacity-value {
  color: #aaa;
  font-size: 9px;
  min-width: 20px;
  text-align: center;
}

.compact-action-buttons {
  display: flex;
  gap: 4px;
}

.compact-action-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  color: #aaa;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 10px;
  padding: 4px 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.compact-action-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #e2e8f0;
}

.compact-action-btn.secondary {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
}

.compact-action-btn.primary {
  background: #ed8936;
  border-color: #ed8936;
  color: white;
}

.compact-action-btn.delete-btn {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.3);
  color: #fca5a5;
}

.compact-action-btn.delete-btn:hover {
  background: rgba(239, 68, 68, 0.3);
  color: #fecaca;
}

.compact-action-buttons-group {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  justify-content: center;
}

.compact-action-buttons-group .compact-action-btn {
  flex: 1;
  font-size: 10px;
  padding: 6px 8px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid rgba(96, 165, 250, 0.2);
  border-radius: 50%;
  border-top-color: #60A5FA;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.spinner-text {
  font-size: 15px;
  color: #F1F5F9;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

/* 顶部标题栏 - 专业简洁设计 */
.title-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: rgba(15, 23, 42, 0.98);
  color: white;
  padding: 14px 28px;
  z-index: 1001;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(100, 116, 139, 0.15);
  transition: all 0.2s ease;
}

.title-bar:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}

.title-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-icon {
  font-size: 24px;
  color: #64748B;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
  transition: all 0.2s ease;
}

.title-content:hover .title-icon {
  transform: scale(1.05);
  color: #94A3B8;
}

.title-content h1 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  color: #E2E8F0;
  letter-spacing: 0.5px;
}

.system-status {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(30, 41, 59, 0.7);
  padding: 6px 12px;
  border-radius: 2px;
  border: 1px solid rgba(100, 116, 139, 0.2);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  transition: all 0.2s ease;
}

.system-status:hover {
  background: rgba(51, 65, 85, 0.8);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10B981;
  animation: pulse 2s infinite;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}

.status-indicator.online {
  background: #10B981;
}

.status-text {
  font-size: 12px;
  color: #94A3B8;
  font-weight: 500;
}

.status-divider {
  width: 1px;
  height: 16px;
  background: rgba(100, 116, 139, 0.2);
}

.status-time {
  font-size: 12px;
  color: #94A3B8;
  font-weight: 500;
  font-family: 'Courier New', monospace;
  letter-spacing: 0.5px;
}

@keyframes pulse {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5);
  }

  70% {
    transform: scale(1.05);
    box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
  }

  100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
  }
}

#cesiumContainer {
  width: 100vw;
  height: 100vh;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1;
}

/* 防止水平滚动条 */
body,
html {
  overflow-x: hidden;
}

/* 确保所有元素不会导致水平溢出 */
* {
  max-width: 100%;
}

/* 保持左右面板内部的滚动功能但隐藏滚动条 */
.panel-content {
  overflow-y: auto;
  overflow-x: hidden;
}

/* 隐藏左右面板内部的滚动条 */
.panel-content::-webkit-scrollbar {
  display: none;
}
</style>