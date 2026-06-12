<template>
  <div class="h-full min-h-0 p-4 text-text-primary text-base overflow-x-hidden overflow-y-auto">
    <div class="flex flex-col gap-4">
      <!-- 多目标优化视图 -->
      <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
        <div
          class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">
          🎯 多目标调度优化实验
        </div>
        <MultiObjectiveView />
      </div>

      <!-- 实时运营指标 -->
      <DashboardStats :metrics="metrics" />

      <!-- 矿卡时间轴回放 -->
      <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
        <div
          class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">
          🚛 矿卡位置回放
        </div>
        <TimelinePlayer :start-time="timelineStartTime" :end-time="timelineEndTime" :initial-time="currentTimestamp"
          data-source-mode="external" @time-change="handleTimelineTimeChange"
          @play-state-change="handleTimelinePlayStateChange" @speed-change="setPlaybackSpeed" />
      </div>

      <!-- 道路绘制工具 -->
      <RoadDrawingTool :viewer="viewerRef" @path-applied="handlePathApplied"
        @default-route-set="handleDefaultRouteSet" />

      <!-- 矿卡实时信息 -->
      <TruckInfoPanel :truck-states="truckStates" :selected-truck-id="selectedTruckId" :current-time="currentTimestamp"
        @select-truck="selectDevice" />

      <!-- 📋 调度摘要 -->
      <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <div
              class="text-sm font-semibold text-blue-100 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">
              📋 调度摘要
            </div>
            <div class="text-xs text-gray-400 mt-1">{{ transportSummary }}</div>
          </div>
          <span class="text-[10px] text-gray-500">{{ latestMonitoringAt }}</span>
        </div>

        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-black/20 rounded p-2.5 border border-white/5">
            <div class="text-[10px] text-gray-500 mb-1">选中设备</div>
            <div class="text-xs text-gray-200 font-medium">
              {{ selectedDeviceMetrics.truckName }}
            </div>
            <div class="text-[10px] text-gray-400 mt-1">{{ selectedDeviceMetrics.status }}</div>
          </div>
          <div class="bg-black/20 rounded p-2.5 border border-white/5">
            <div class="text-[10px] text-gray-500 mb-1">当前线路</div>
            <div class="text-xs text-gray-200 font-medium">
              {{ routeLength }} km / {{ routeSegments }} 段
            </div>
            <div class="text-[10px] text-gray-400 mt-1">{{ routeStatus }}</div>
          </div>
          <div class="bg-black/20 rounded p-2.5 border border-white/5">
            <div class="text-[10px] text-gray-500 mb-1">司机 / 位置</div>
            <div class="text-xs text-gray-200 font-medium truncate">
              {{ selectedDeviceMetrics.driver }}
            </div>
            <div class="text-[10px] text-gray-400 mt-1 truncate">
              {{ selectedDeviceMetrics.location }}
            </div>
          </div>
          <div class="bg-black/20 rounded p-2.5 border border-white/5">
            <div class="text-[10px] text-gray-500 mb-1">载重 / 油温</div>
            <div class="text-xs text-gray-200 font-medium">
              {{ selectedDeviceMetrics.payloadText }}
            </div>
            <div class="text-[10px] text-gray-400 mt-1">
              {{ selectedDeviceMetrics.fuelLevel }} / {{ selectedDeviceMetrics.engineTemp }}
            </div>
          </div>
        </div>

        <div class="px-3 py-2.5 rounded bg-blue-500/10 border border-blue-500/20 text-xs text-gray-300 mb-3">
          最近调度指令：<span class="text-blue-300">{{ latestScenarioCommand }}</span>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <div class="text-xs font-medium text-blue-100">异常告警</div>
            <div class="text-[10px] text-gray-500">{{ healthAlerts.length }} 条</div>
          </div>
          <div v-if="healthAlerts.length > 0" class="space-y-2">
            <div v-for="alert in healthAlerts.slice(0, 3)" :key="alert.key || `${alert.truckId}-${alert.type}`"
              class="rounded-md border px-3 py-2 text-xs" :class="alert.level === 'high'
                ? 'bg-red-500/10 border-red-500/30 text-red-200'
                : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-100'
                ">
              <div class="font-medium">{{ alert.truckName }}</div>
              <div class="text-[11px] opacity-90 mt-1">{{ alert.message }}</div>
            </div>
          </div>
          <div v-else
            class="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            当前无异常告警，调度运行平稳。
          </div>
        </div>
      </div>

      <!-- 场景视角 -->
      <CameraPresets :camera-presets="cameraPresets" :selected-camera="selectedCamera" @select="handleCameraSelect" />

      <!-- 🎛️ 设备控制 -->
      <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
        <div
          class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">
          🎛️ 设备控制
        </div>
        <div class="grid grid-cols-3 gap-2">
          <button
            class="px-3 py-2 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white hover:border-white/20 transition-all flex items-center justify-center gap-1"
            @click="toggleEquipment">
            <span>{{ showEquipment ? '👁️' : '🚫' }}</span>
            {{ showEquipment ? '隐藏矿卡' : '显示矿卡' }}
          </button>
          <button
            class="px-3 py-2 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white hover:border-white/20 transition-all flex items-center justify-center gap-1"
            @click="toggleLabels">
            <span>{{ showLabels ? '🏷️' : '🚫' }}</span>
            {{ showLabels ? '隐藏标签' : '显示标签' }}
          </button>
          <button
            class="px-3 py-2 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white hover:border-white/20 transition-all flex items-center justify-center gap-1"
            @click="toggleTrajectories">
            <span>{{ showTrajectories ? '🛤️' : '🚫' }}</span>
            {{ showTrajectories ? '隐藏轨迹' : '显示轨迹' }}
          </button>
        </div>
      </div>

      <!-- 监控状态 -->
      <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
        <div
          class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">
          📡 监控状态
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5" :class="isMonitoring
            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
            : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
            ">
            <span class="w-2 h-2 rounded-full"
              :class="isMonitoring ? 'bg-green-400 animate-pulse' : 'bg-gray-400'"></span>
            {{ isMonitoring ? '监控中' : '已停止' }}
          </span>
          <button
            class="px-4 py-1.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-500/30 hover:text-blue-200 transition-all"
            @click="toggleMonitoring">
            {{ isMonitoring ? '⏹ 停止' : '▶ 启动' }}
          </button>
        </div>
      </div>

      <!-- 数据源管理 -->
      <div class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300">
        <div
          class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm">
          🔌 数据源管理
        </div>
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" :class="getStatusColor(connectionStatus)"></span>
            <span class="text-xs text-gray-300">{{ getStatusLabel(connectionStatus) }}</span>
            <span class="text-[10px] text-gray-500">
              -
              {{
                connectionType === 'websocket'
                  ? 'WebSocket'
                  : 'HTTP轮询'
              }}
            </span>
          </div>
          <button
            class="px-3 py-1.5 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all"
            @click="showDataSourceConfig = !showDataSourceConfig">
            {{ showDataSourceConfig ? '收起' : '切换数据源' }}
          </button>
        </div>

        <div v-if="showDataSourceConfig" class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <button class="px-3 py-2 rounded text-xs font-medium transition-all border" :class="connectionType === 'websocket'
              ? 'bg-green-500/20 text-green-400 border-green-500/30'
              : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
              " @click="handleSwitchDataSource('websocket')">
              📡 WebSocket
            </button>
            <button class="px-3 py-2 rounded text-xs font-medium transition-all border" :class="connectionType === 'http_poll'
              ? 'bg-green-500/20 text-green-400 border-green-500/30'
              : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'
              " @click="handleSwitchDataSource('http_poll')">
              🔄 HTTP轮询
            </button>
          </div>

          <div v-if="connectionType === 'websocket'" class="space-y-2">
            <label class="text-[10px] text-gray-500">WebSocket 地质</label>
            <input v-model="wsUrl"
              class="w-full px-3 py-2 rounded bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-blue-500/50 transition-all"
              placeholder="ws://host:port/path" />
            <button
              class="w-full px-3 py-1.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-500/30 transition-all"
              @click="handleSwitchDataSource('websocket')">
              重新连接
            </button>
          </div>

          <div v-if="connectionType === 'http_poll'" class="space-y-2">
            <label class="text-[10px] text-gray-500">HTTP 接口地质</label>
            <input v-model="httpUrl"
              class="w-full px-3 py-2 rounded bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-blue-500/50 transition-all"
              placeholder="http://host:port/api/path" />
            <button
              class="w-full px-3 py-1.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-500/30 transition-all"
              @click="handleSwitchDataSource('http_poll')">
              重新连接
            </button>
          </div>

          <div class="px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded text-[10px] text-gray-400">
            💡 实时数据接口需返回如下格式：
            <code class="text-blue-300 block mt-1 text-[10px] break-all">
              { truckId, position:{longitude,latitude,height}, speed, heading, status, payload,
              driver, timestamp }
            </code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineOptions({ name: '现场调度中心面板' })
import { ref } from 'vue'
import { useMonitoringPanelController } from '../services/panel/useMonitoringPanelController.js'
import DashboardStats from './DashboardStats.vue'
import CameraPresets from './CameraPresets.vue'
import TimelinePlayer from './TimelinePlayer.vue'
import TruckInfoPanel from './TruckInfoPanel.vue'
import RoadDrawingTool from './RoadDrawingTool.vue'
import MultiObjectiveView from './MultiObjectiveView.vue'

const {
  // 状态
  isMonitoring,
  currentTimestamp,
  timelineStartTime,
  timelineEndTime,
  truckStates,
  selectedTruckId,
  selectedCamera,
  metrics,
  cameraPresets,
  transportSummary,
  latestMonitoringAt,
  latestScenarioCommand,
  routeLength,
  routeSegments,
  routeStatus,
  healthAlerts,
  selectedDeviceMetrics,
  showEquipment,
  showLabels,
  showTrajectories,
  connectionType,
  connectionStatus,
  viewerRef,
  // 方法
  toggleMonitoring,
  switchDataSource,
  toggleEquipment,
  toggleLabels,
  toggleTrajectories,
  handleCameraSelect,
  handleTimelineTimeChange,
  handleTimelinePlayStateChange,
  selectDevice,
  setCustomPath,
  setPlaybackSpeed
} = useMonitoringPanelController()

const wsUrl = ref('ws://localhost:8080/trucks/realtime')
const httpUrl = ref('/api/trucks')
const showDataSourceConfig = ref(false)

function handleSwitchDataSource(type) {
  if (type === connectionType.value) {
    showDataSourceConfig.value = false
    return
  }

  if (type === 'websocket') {
    switchDataSource('websocket', { url: wsUrl.value })
  } else if (type === 'http_poll') {
    switchDataSource('http_poll', { url: httpUrl.value, pollInterval: 2000 })
  }
  showDataSourceConfig.value = false
}

function getStatusColor(status) {
  const map = {
    connected: 'bg-green-400',
    connecting: 'bg-yellow-400 animate-pulse',
    reconnecting: 'bg-orange-400 animate-pulse',
    disconnected: 'bg-red-400',
    error: 'bg-red-400',
    idle: 'bg-gray-400'
  }
  return map[status] || 'bg-gray-400'
}

function getStatusLabel(status) {
  const map = {
    connected: '已连接',
    connecting: '连接中',
    reconnecting: '重连中',
    disconnected: '已断开',
    error: '异常',
    idle: '未连接'
  }
  return map[status] || status
}

// 处理道路绘制完成
function handlePathApplied(pathData) {
  // 设置自定义路径，矿卡将沿此路径移动
  setCustomPath(pathData.points)
}

function handleDefaultRouteSet(routeData) {
  if (routeData.points && routeData.points.length >= 2) {
    setCustomPath(routeData.points)
  }
}
</script>
