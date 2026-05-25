import useMonitoring from '../useMonitoring.js'
import { computed } from 'vue'

export function useMonitoringPanelController() {
  const m = useMonitoring()

  const selectedTruck = computed(
    () => m.truckStates.value.find(t => t.truckId === m.selectedTruckId.value) || null
  )

  const routeLength = computed(() => {
    const [s1, s2] = [m.miningSite1, m.miningSite2]
    if (!s1 || !s2) return 0
    const dLon = s1.longitude - s2.longitude
    const dLat = s1.latitude - s2.latitude
    return Math.round(Math.sqrt(dLon * dLon + dLat * dLat) * 111 * 10) / 10
  })

  const routeStatus = computed(() => {
    if (m.alertList.value.find(a => a.level === 'high')) return '需干预'
    if (m.alertList.value.length > 0) return '预警中'
    if (!m.isMonitoring.value) return '已暂停'
    return '畅通'
  })

  const metrics = computed(() => ({
    onlineCount: m.statistics.value.activeTrucks || 0,
    warningCount: m.alertList.value.length,
    loadedCount: m.statistics.value.totalPayload || 0,
    averageSpeed: m.statistics.value.avgSpeed || 0,
    throughputTph: Math.round(
      (m.statistics.value.avgSpeed || 0) * Math.max(m.statistics.value.activeTrucks || 1, 1)
    )
  }))

  const transportSummary = computed(() => {
    const t = selectedTruck.value
    return t
      ? `${t.truckName || t.name} 正在${t.status || '待命'}`
      : `${m.statistics.value.activeTrucks || 0} 台设备在线运行`
  })

  const latestMonitoringAt = computed(() =>
    m.currentTimestamp.value ? new Date(m.currentTimestamp.value).toLocaleString('zh-CN') : ''
  )

  const latestScenarioCommand = computed(() => {
    const t = selectedTruck.value
    return t ? `${t.truckName || t.name} -> ${t.location || t.status || '未知位置'}` : '未收到'
  })

  const healthAlerts = computed(() => m.alertList.value)

  const selectedDeviceMetrics = computed(() => {
    const t = selectedTruck.value
    if (!t)
      return {
        truckName: '未选中设备',
        status: '待选择',
        driver: '--',
        location: '--',
        payloadText: '--',
        fuelLevel: '--',
        engineTemp: '--'
      }
    return {
      truckName: t.truckName || t.name,
      status: t.status || '未知',
      driver: t.driver || '--',
      location: t.location || '--',
      payloadText: `${Math.round(t.payload || 0)} / ${Math.round(t.capacity || 0)} 吨`,
      fuelLevel: `${Math.round(t.fuelLevel || 0)}%`,
      engineTemp: `${Math.round(t.engineTemp || 0)}°C`
    }
  })

  const toggleMonitoring = () => (m.isMonitoring.value ? m.stopMonitoring() : m.startMonitoring())

  const switchDataSource = (type, config) => m.switchDataSource(type, config)

  return {
    isMonitoring: m.isMonitoring,
    currentTimestamp: m.currentTimestamp,
    timelineStartTime: m.timelineStartTime,
    timelineEndTime: m.timelineEndTime,
    truckStates: m.truckStates,
    selectedTruckId: m.selectedTruckId,
    selectedCamera: m.selectedCamera,
    connectionType: m.connectionType,
    connectionStatus: m.connectionStatus,
    cameraPresets: m.cameraPresets,
    viewerRef: m.viewerRef,
    metrics,
    transportSummary,
    latestMonitoringAt,
    latestScenarioCommand,
    routeLength,
    routeSegments: 8,
    routeStatus,
    healthAlerts,
    selectedDeviceMetrics,
    showEquipment: computed(() => m.activeLayers.value.equipment ?? true),
    showLabels: computed(() => m.activeLayers.value.labels ?? true),
    showTrajectories: computed(() => m.activeLayers.value.trajectories ?? false),
    toggleMonitoring,
    switchDataSource,
    toggleEquipment: m.toggleEquipment,
    toggleLabels: m.toggleLabels,
    toggleTrajectories: m.toggleTrajectories,
    handleCameraSelect: m.focusCamera,
    handleTimelineTimeChange: m.handleTimelineTimeChange,
    handleTimelinePlayStateChange: m.handleTimelinePlayStateChange,
    selectDevice: m.selectDevice,
    setCustomPath: m.setCustomPath,
    setPlaybackSpeed: m.setPlaybackSpeed
  }
}
