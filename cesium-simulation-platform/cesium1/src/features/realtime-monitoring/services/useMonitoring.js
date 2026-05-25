import * as Cesium from 'cesium'
import { ref, watch } from 'vue'
import { EquipmentManager } from './equipmentManager.js'
import { RealtimeDataEngine, MINING_SITE_1, MINING_SITE_2 } from './RealtimeDataEngine.js'
import {
  CAMERA_PRESETS,
  DEFAULT_ACTIVE_LAYERS,
  DEFAULT_CAMERA_PRESET_ID,
  DEFAULT_MAX_TRAJECTORY_POINTS
} from '../types/monitoringDefaults.js'
import { initializeDefaultRoute } from './routeStorage.js'
import { ConnectionManager } from './ConnectionManager.js'
import useModel from '../../model-control/services/useModel.js'

const HISTORY_LIVE_THRESHOLD_MS = 1500
const ALERT_HISTORY_LIMIT = 50
const ACTIVE_ALERT_LIMIT = 6
const RENDER_THROTTLE_MS = 50
const INTERPOLATION_DURATION = 200

const isMonitoring = ref(false)
const activeLayers = ref({
  equipment: DEFAULT_ACTIVE_LAYERS.equipment,
  risk: DEFAULT_ACTIVE_LAYERS.risk,
  labels: true,
  trajectories: false
})
const currentTimestamp = ref(Date.now())
const timelineStartTime = ref(Date.now())
const timelineEndTime = ref(Date.now())
const isTimelinePlaying = ref(true)
const playbackSpeed = ref(1)
const truckStates = ref([])
const liveTruckStates = ref([])
const selectedTruckId = ref(null)
const isHistoricalPlayback = ref(false)
const alertList = ref([])
const alertHistory = ref([])
const selectedCamera = ref(DEFAULT_CAMERA_PRESET_ID)
const statistics = ref({
  totalTrucks: 0,
  activeTrucks: 0,
  totalPayload: 0,
  avgSpeed: 0,
  completedCycles: 0
})
const connectionType = ref('simulated')
const connectionStatus = ref('connected')

let dataEngine = null,
  equipmentManager = null,
  connectionManager = null,
  viewerRef = null,
  isInitialized = false
let unsubscribeDataEngine = null,
  stopTilesetWatch = null,
  stopTransformWatch = null
let modelTransformThrottleTimer = null,
  miningSiteDebugTimer = null
let activeAlertKeys = new Set()
let renderThrottleTimer = null,
  pendingRender = false
let previousPositions = new Map()
let tilesetSwitchCooldown = false
const MODEL_TRANSFORM_THROTTLE_MS = 150

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasValidCartesianArray(position) {
  return (
    Array.isArray(position?.cartesian) &&
    position.cartesian.length === 3 &&
    position.cartesian.every(component => isFiniteNumber(component))
  )
}

function hasValidGeographicPosition(position) {
  return isFiniteNumber(position?.longitude) && isFiniteNumber(position?.latitude)
}

function hasRenderableTruckPosition(position) {
  return hasValidCartesianArray(position) || hasValidGeographicPosition(position)
}

function cloneTruckState(truck) {
  if (!truck) return truck
  return {
    ...truck,
    mineralType: truck.mineralType ? { ...truck.mineralType } : truck.mineralType,
    vehicleInfo: truck.vehicleInfo ? { ...truck.vehicleInfo } : truck.vehicleInfo,
    driverInfo: truck.driverInfo ? { ...truck.driverInfo } : truck.driverInfo,
    tirePressure: Array.isArray(truck.tirePressure) ? [...truck.tirePressure] : truck.tirePressure,
    position: truck.position
      ? {
          ...truck.position,
          cartesian: Array.isArray(truck.position.cartesian)
            ? [...truck.position.cartesian]
            : undefined
        }
      : truck.position
  }
}

function upsertTruckState(collection, data) {
  const idx = collection.value.findIndex(t => t.truckId === data.truckId)
  if (idx >= 0) {
    Object.assign(collection.value[idx], cloneTruckState(data))
    collection.value = [...collection.value]
  } else {
    collection.value = [...collection.value, cloneTruckState(data)]
  }
}

function syncTimelineRange() {
  if (!dataEngine) return
  const { startTime, endTime } = dataEngine.getTimeRange()
  timelineStartTime.value = Math.min(startTime, endTime)
  timelineEndTime.value = Math.max(startTime, endTime, currentTimestamp.value)
}

function buildAlertCandidates(trucks) {
  return trucks
    .flatMap(t => {
      const alerts = []
      if ((t.engineTemp || 0) >= 95)
        alerts.push({
          key: `${t.truckId}:engineTemp`,
          truckId: t.truckId,
          truckName: t.truckName || t.name || t.truckId,
          level: 'high',
          type: 'engineTemp',
          message: `发动机温度 ${Math.round(t.engineTemp)}°C，建议立即检查冷却系统`,
          timestamp: t.timestamp || currentTimestamp.value
        })
      if ((t.fuelLevel || 0) <= 30)
        alerts.push({
          key: `${t.truckId}:fuelLevel`,
          truckId: t.truckId,
          truckName: t.truckName || t.name || t.truckId,
          level: 'medium',
          type: 'fuelLevel',
          message: `燃油仅剩 ${Math.round(t.fuelLevel)}%，建议尽快补能`,
          timestamp: t.timestamp || currentTimestamp.value
        })
      if ((t.speed || 0) >= (t.vehicleInfo?.maxSpeed || 40) * 0.95)
        alerts.push({
          key: `${t.truckId}:speed`,
          truckId: t.truckId,
          truckName: t.truckName || t.name || t.truckId,
          level: 'medium',
          type: 'speed',
          message: `当前速度 ${Math.round(t.speed)} km/h，接近车辆上限`,
          timestamp: t.timestamp || currentTimestamp.value
        })
      return alerts
    })
    .sort(
      (a, b) => ({ high: 3, medium: 2, low: 1 })[b.level] - { high: 3, medium: 2, low: 1 }[a.level]
    )
}

function updateAlerts(trucks) {
  const nextAlerts = buildAlertCandidates(trucks)
  const nextKeys = new Set(nextAlerts.map(a => a.key))
  nextAlerts.forEach(a => {
    if (!activeAlertKeys.has(a.key))
      alertHistory.value = [{ ...a }, ...alertHistory.value].slice(0, ALERT_HISTORY_LIMIT)
  })
  activeAlertKeys = nextKeys
  alertList.value = nextAlerts.slice(0, ACTIVE_ALERT_LIMIT)
}

function setDisplayedTruckStates(states, { immediateRender = false } = {}) {
  truckStates.value = states.map(cloneTruckState)
  updateStatistics(truckStates.value)
  if (!activeLayers.value.equipment) return
  immediateRender ? renderTrucks() : throttleRenderTrucks()
}

function resumeLiveMode({ immediateRender = true } = {}) {
  isHistoricalPlayback.value = false
  if (liveTruckStates.value.length === 0) {
    updateStatistics([])
    equipmentManager?.clearAll()
    return
  }
  currentTimestamp.value = timelineEndTime.value
  setDisplayedTruckStates(liveTruckStates.value, { immediateRender })
}

async function initMonitoringManager(viewer) {
  if (!viewer || isInitialized) return
  viewerRef = viewer
  isInitialized = true

  equipmentManager = new EquipmentManager(viewer, {
    maxTrajectoryPoints: DEFAULT_MAX_TRAJECTORY_POINTS,
    pointSize: 8,
    showLabels: activeLayers.value.labels,
    showTrajectories: activeLayers.value.trajectories
  })

  const { tileset, modelPosition, modelTransform, getOriginalModelMatrix } = useModel()
  dataEngine = new RealtimeDataEngine()
  dataEngine.setOriginalModelMatrix(getOriginalModelMatrix())

  if (tileset.value) {
    dataEngine.tileset = tileset.value
  }

  await dataEngine.initWithSimulator({
    mode: 'simulated',
    viewer,
    tileset: tileset.value || null,
    originalModelMatrix: getOriginalModelMatrix()
  })

  if (tileset.value) {
    dataEngine.setTileset(tileset.value)
  }

  stopTilesetWatch = watch(tileset, newT => {
    if (!newT || !dataEngine) return
    if (tilesetSwitchCooldown) return
    tilesetSwitchCooldown = true
    setTimeout(() => {
      tilesetSwitchCooldown = false
    }, 300)

    dataEngine.setOriginalModelMatrix(getOriginalModelMatrix())
    dataEngine.setTileset(newT)
  })
  stopTransformWatch = watch(
    [modelPosition, modelTransform],
    () => {
      if (!tileset.value || !dataEngine) return
      if (tilesetSwitchCooldown) return
      dataEngine.refreshSimulationFrame()
      if (activeLayers.value.equipment && isMonitoring.value) {
        clearTimeout(modelTransformThrottleTimer)
        modelTransformThrottleTimer = setTimeout(() => {
          dataEngine.setTileset(tileset.value)
          renderTrucks()
        }, MODEL_TRANSFORM_THROTTLE_MS)
      }
    },
    { deep: true }
  )

  unsubscribeDataEngine = dataEngine.subscribe(data => updateTruckFromRealtime(data))

  connectionManager = new ConnectionManager({
    dataHandler: data => {
      const processed = Array.isArray(data)
        ? data.map(d => dataEngine.processData(d))
        : [dataEngine.processData(data)]
      processed.forEach(d => dataEngine.receiveExternalData(d))
    },
    statusHandler: status => {
      connectionStatus.value = status
    }
  })

  startMonitoring()
  syncTimelineRange()

  try {
    const defaultRoute = await initializeDefaultRoute({ useStaticAsFallback: true })
    if (defaultRoute && defaultRoute.points.length >= 2) {
      console.log('[useMonitoring] 检测到默认路线，正在应用...')
      if (dataEngine && dataEngine.simulator) {
        dataEngine.setCustomPath(defaultRoute.points)
        dataEngine.simulator.initializeTruckStates()
      }
    }
  } catch (error) {
    console.warn('[useMonitoring] 加载默认路线失败:', error)
  }

  miningSiteDebugTimer = setTimeout(() => {
    console.log('[useMonitoring] 采场位置:', MINING_SITE_1, MINING_SITE_2)
  }, 2000)
}

function updateTruckFromRealtime(data) {
  const prev = liveTruckStates.value.find(t => t.truckId === data.truckId)
  if (
    !isHistoricalPlayback.value &&
    hasValidCartesianArray(prev?.position) &&
    hasValidCartesianArray(data?.position)
  ) {
    previousPositions.set(data.truckId, {
      position: cloneTruckState(prev).position,
      timestamp: performance.now()
    })
  } else {
    previousPositions.delete(data.truckId)
  }
  upsertTruckState(liveTruckStates, data)
  currentTimestamp.value = data.timestamp || Date.now()
  syncTimelineRange()
  updateAlerts(liveTruckStates.value)
  if (!selectedTruckId.value && liveTruckStates.value.length > 0)
    selectedTruckId.value = liveTruckStates.value[0].truckId
  if (!isHistoricalPlayback.value) setDisplayedTruckStates(liveTruckStates.value)
}

function throttleRenderTrucks() {
  if (renderThrottleTimer) {
    pendingRender = true
    return
  }
  renderTrucks()
  pendingRender = false
  renderThrottleTimer = setTimeout(() => {
    renderThrottleTimer = null
    if (pendingRender) {
      renderTrucks()
      pendingRender = false
    }
  }, RENDER_THROTTLE_MS)
}

function startMonitoring() {
  if (isMonitoring.value) return
  isMonitoring.value = true
  isTimelinePlaying.value = true
  if (dataEngine?.mode === 'simulated' && !dataEngine.simulator) dataEngine.startSimulator()
  resumeLiveMode()
}

function stopMonitoring() {
  if (!isMonitoring.value) return
  isMonitoring.value = false
  if (dataEngine?.mode === 'simulated') dataEngine.stopSimulator()
}

function lerp(start, end, t) {
  return start + (end - start) * t
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3)
}

function interpolatePosition(truckId, target) {
  const prev = previousPositions.get(truckId)
  if (!prev) return target
  if (!hasValidCartesianArray(prev.position) || !hasValidCartesianArray(target)) {
    previousPositions.delete(truckId)
    return target
  }
  const elapsed = performance.now() - prev.timestamp
  if (elapsed >= INTERPOLATION_DURATION) {
    previousPositions.delete(truckId)
    return target
  }
  const t = easeOutCubic(elapsed / INTERPOLATION_DURATION)
  return {
    cartesian: prev.position.cartesian.map((v, i) => lerp(v, target.cartesian[i], t)),
    longitude: lerp(prev.position.longitude, target.longitude, t),
    latitude: lerp(prev.position.latitude, target.latitude, t),
    height: lerp(prev.position.height || 0, target.height || 0, t)
  }
}

function renderTrucks() {
  if (
    !equipmentManager?.updateTrucks ||
    !activeLayers.value.equipment ||
    truckStates.value.length === 0
  ) {
    equipmentManager?.clearAll()
    return
  }
  const trucks = truckStates.value
    .filter(s => hasRenderableTruckPosition(s?.position))
    .map(s => ({
      id: s.truckId,
      position: interpolatePosition(s.truckId, s.position),
      status: s.status,
      heading: s.heading,
      name: s.name,
      driver: s.driver,
      payload: s.payload,
      speed: s.speed,
      mineralType: s.mineralType
    }))
  if (trucks.length > 0) equipmentManager.updateTrucks(trucks)
  else equipmentManager.clearAll()
}

function updateStatistics(sourceTrucks = truckStates.value) {
  const trucks = sourceTrucks || []
  statistics.value = {
    totalTrucks: trucks.length,
    activeTrucks: trucks.filter(t => t.speed > 0).length,
    totalPayload: Math.round(trucks.reduce((s, t) => s + (t.payload || 0), 0)),
    avgSpeed:
      trucks.length > 0
        ? Math.round((trucks.reduce((s, t) => s + (t.speed || 0), 0) / trucks.length) * 10) / 10
        : 0,
    completedCycles: Math.max(...trucks.map(t => t.cycleCount || 0), 0)
  }
}

function destroyMonitoringManager() {
  stopMonitoring()
  connectionManager?.destroy()
  connectionManager = null
  unsubscribeDataEngine?.()
  unsubscribeDataEngine = null
  stopTilesetWatch?.()
  stopTilesetWatch = null
  stopTransformWatch?.()
  stopTransformWatch = null
  clearTimeout(modelTransformThrottleTimer)
  modelTransformThrottleTimer = null
  clearTimeout(renderThrottleTimer)
  renderThrottleTimer = null
  clearTimeout(miningSiteDebugTimer)
  miningSiteDebugTimer = null
  dataEngine?.destroy()
  dataEngine = null
  equipmentManager?.destroy()
  equipmentManager = null
  activeAlertKeys = new Set()
  previousPositions = new Map()
  pendingRender = false
  tilesetSwitchCooldown = false
  truckStates.value = []
  liveTruckStates.value = []
  alertList.value = []
  alertHistory.value = []
  selectedTruckId.value = null
  currentTimestamp.value = timelineStartTime.value = timelineEndTime.value = Date.now()
  updateStatistics([])
  viewerRef = null
  isInitialized = false
}

function handleTimelineTimeChange(timestamp) {
  currentTimestamp.value = timestamp
  if (!dataEngine) return
  syncTimelineRange()
  if (timelineEndTime.value - timestamp <= HISTORY_LIVE_THRESHOLD_MS) {
    resumeLiveMode()
    return
  }
  const states = dataEngine.getTruckStateAtTime(timestamp)
  if (states?.length) {
    isHistoricalPlayback.value = true
    setDisplayedTruckStates(states, { immediateRender: true })
  }
}

function handleTimelinePlayStateChange(isPlaying) {
  isTimelinePlaying.value = isPlaying
  if (!isPlaying && timelineEndTime.value - currentTimestamp.value <= HISTORY_LIVE_THRESHOLD_MS)
    resumeLiveMode()
}

function setPlaybackSpeed(speed) {
  playbackSpeed.value = Number(speed) || 1
}

function focusCamera(cameraId) {
  const preset = CAMERA_PRESETS.find(p => p.id === cameraId)
  if (!preset || !viewerRef) return
  selectedCamera.value = cameraId
  viewerRef.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      preset.destination.x,
      preset.destination.y,
      preset.destination.z
    ),
    orientation: { heading: preset.heading, pitch: preset.pitch, roll: preset.roll },
    duration: 1.4
  })
}

function focusTruck(truckId) {
  selectedTruckId.value = truckId
  const truck = truckStates.value.find(t => t.truckId === truckId)
  if (!truck || !viewerRef || !equipmentManager) return
  const entity = viewerRef.entities.getById(`truck_${truckId}`)
  if (entity) {
    viewerRef.flyTo(entity, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, -0.6, 150) })
    return
  }
  const dest =
    truck.position.cartesian?.length === 3
      ? new Cesium.Cartesian3(
          truck.position.cartesian[0],
          truck.position.cartesian[1],
          truck.position.cartesian[2] + 150
        )
      : Cesium.Cartesian3.fromDegrees(truck.position.longitude, truck.position.latitude, 150)
  viewerRef.camera.flyTo({
    destination: dest,
    orientation: { heading: 0, pitch: -0.6, roll: 0 },
    duration: 1.2
  })
}

function toggleEquipment() {
  activeLayers.value.equipment = !activeLayers.value.equipment
  activeLayers.value.equipment ? renderTrucks() : equipmentManager?.clearAll()
}

function toggleLabels() {
  activeLayers.value.labels = equipmentManager
    ? equipmentManager.toggleLabels()
    : !activeLayers.value.labels
  if (activeLayers.value.labels && activeLayers.value.equipment) renderTrucks()
}

function toggleTrajectories() {
  activeLayers.value.trajectories = equipmentManager
    ? equipmentManager.toggleTrajectories()
    : !activeLayers.value.trajectories
  if (activeLayers.value.trajectories && activeLayers.value.equipment) renderTrucks()
}

function selectDevice(truckId) {
  selectedTruckId.value = truckId
  focusTruck(truckId)
}

function setCustomPath(pathPoints) {
  if (!dataEngine || !pathPoints || pathPoints.length < 2) return false
  if (!dataEngine.setCustomPath(pathPoints)) return false
  dataEngine.simulator?.initializeTruckStates()
  resumeLiveMode()
  return true
}

function switchDataSource(type, config = {}) {
  if (type === connectionType.value) return

  if (type === 'simulated') {
    connectionManager?.disconnect()
    connectionType.value = 'simulated'
    connectionStatus.value = 'connected'
    dataEngine.switchToSimulated()
    resumeLiveMode()
  } else {
    connectionType.value = type
    dataEngine.switchToRealtime(rawData => rawData)
    connectionManager.switchTo(type, config)
  }
}

export default function useMonitoring() {
  return {
    isMonitoring,
    activeLayers,
    currentTimestamp,
    timelineStartTime,
    timelineEndTime,
    isTimelinePlaying,
    playbackSpeed,
    truckStates,
    selectedTruckId,
    selectedCamera,
    statistics,
    alertList,
    alertHistory,
    connectionType,
    connectionStatus,
    cameraPresets: CAMERA_PRESETS,
    get miningSite1() {
      return MINING_SITE_1
    },
    get miningSite2() {
      return MINING_SITE_2
    },
    viewerRef,
    initMonitoringManager,
    startMonitoring,
    stopMonitoring,
    destroyMonitoringManager,
    handleTimelineTimeChange,
    handleTimelinePlayStateChange,
    setPlaybackSpeed,
    focusCamera,
    focusTruck,
    toggleEquipment,
    toggleLabels,
    toggleTrajectories,
    selectDevice,
    setCustomPath,
    switchDataSource
  }
}
