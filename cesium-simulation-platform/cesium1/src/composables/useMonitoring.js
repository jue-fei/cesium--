import { ref } from 'vue'
import { EquipmentManager } from '../features/monitoring/equipmentManager.js'
import { RiskManager } from '../features/monitoring/riskManager.js'

let equipmentManager = null
let riskManager = null
let monitoringInterval = null

export default function useMonitoring() {
  const isMonitoring = ref(false)
  const activeLayers = ref({
    equipment: true,
    risk: true
  })

  const initMonitoringManager = viewer => {
    if (!equipmentManager && viewer) {
      equipmentManager = new EquipmentManager(viewer)
    }
    if (!riskManager && viewer) {
      riskManager = new RiskManager(viewer)
    }
  }

  // 模拟实时数据流
  const startRealtimeMonitoring = () => {
    if (isMonitoring.value) return
    isMonitoring.value = true

    // 模拟初始风险区
    if (activeLayers.value.risk && riskManager) {
      riskManager.clearAll()
      riskManager.addRiskZone({
        id: 'zone1',
        positions: [
          { x: 116.392, y: 39.902 },
          { x: 116.393, y: 39.902 },
          { x: 116.393, y: 39.903 },
          { x: 116.392, y: 39.903 }
        ],
        level: 'high'
      })
    }

    // 模拟设备移动
    monitoringInterval = setInterval(() => {
      if (!equipmentManager || !activeLayers.value.equipment) return

      // 模拟两台卡车
      const time = Date.now() / 1000
      const offset1 = Math.sin(time) * 0.001
      const offset2 = Math.cos(time) * 0.001

      equipmentManager.updateEquipment({
        id: 'T01',
        type: 'Truck',
        position: { x: 116.39 + offset1, y: 39.9 + offset2, z: 0 },
        health: 'normal'
      })

      equipmentManager.updateEquipment({
        id: 'E01',
        type: 'Excavator',
        position: { x: 116.391 + offset2, y: 39.901 + offset1, z: 0 },
        health: 'warning'
      })
    }, 1000)
  }

  const stopMonitoring = () => {
    if (monitoringInterval) {
      clearInterval(monitoringInterval)
      monitoringInterval = null
    }
    isMonitoring.value = false
  }

  const toggleLayer = layerName => {
    activeLayers.value[layerName] = !activeLayers.value[layerName]

    if (layerName === 'equipment' && equipmentManager) {
      if (!activeLayers.value.equipment) equipmentManager.clearAll()
    }
    if (layerName === 'risk' && riskManager) {
      if (!activeLayers.value.risk) riskManager.clearAll()
      else {
        // 重新添加风险区 (简化逻辑)
        startRealtimeMonitoring()
      }
    }
  }

  return {
    isMonitoring,
    activeLayers,
    initMonitoringManager,
    startRealtimeMonitoring,
    stopMonitoring,
    toggleLayer
  }
}
