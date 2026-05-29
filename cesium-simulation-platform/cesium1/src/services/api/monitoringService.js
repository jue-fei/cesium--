import client, { safeRequest } from './apiClient'

// ---- 降级默认值（来自 monitoringDefaults.js + RealtimeDataEngine.js）----
const FALLBACK_CAMERAS = [
  { preset_id: 'overview', name: '总览镜头', description: '查看采场1、采场2及矿卡整体运行', emoji: '🗺️', destination: { x: 116.391156, y: 39.901164, z: 800 }, heading: 0, pitch: -1.2, roll: 0, sort_order: 1 },
  { preset_id: 'loading', name: '装载区镜头', description: '查看采场1矿卡装载位置', emoji: '⛏️', destination: { x: 116.391178, y: 39.901187, z: 200 }, heading: 0.5, pitch: -0.7, roll: 0, sort_order: 2 },
  { preset_id: 'road', name: '运输线镜头', description: '查看采场1到采场2运输线路', emoji: '🛣️', destination: { x: 116.391116, y: 39.901180, z: 300 }, heading: 0.8, pitch: -0.8, roll: 0, sort_order: 3 },
  { preset_id: 'dump', name: '卸载区镜头', description: '查看采场2矿卡卸载位置', emoji: '📤', destination: { x: 116.391054, y: 39.901173, z: 200 }, heading: -1.2, pitch: -0.7, roll: 0, sort_order: 4 }
]

const FALLBACK_MINERALS = [
  { code: 'CU', name: '铜矿石', density: 2.8, color: '#B87333', grade: '1.2%', value_level: '高', destination: '冶炼厂A区' },
  { code: 'FE', name: '铁矿石', density: 3.5, color: '#8B4513', grade: '45%', value_level: '中', destination: '选矿厂B区' },
  { code: 'AU', name: '金矿石', density: 4.2, color: '#FFD700', grade: '3.5g/t', value_level: '极高', destination: '精炼厂C区' }
]

const FALLBACK_TRANSPORT = [
  { unit_id: 'T01', name: '1号矿卡', driver: '张鹏', phase_offset: 0.0 },
  { unit_id: 'T02', name: '2号矿卡', driver: '刘威', phase_offset: 0.33 },
  { unit_id: 'T03', name: '3号矿卡', driver: '王超', phase_offset: 0.66 }
]

const FALLBACK_PITS = [
  { pit_key: 'pit1', model_id: 'd645920e395fedad7bbbed0eca3fe2e0', name: '采场模型1', cartesian: [-2178472.525158, 4385068.251249, 4073979.895907], lon_lat: { x: 116.391178, y: 39.901187, z: -27.68 }, radius: 1217.7 },
  { pit_key: 'pit2', model_id: 'd67d8ab4f4c10bf22aa353e27879133c', name: '采场模型2', cartesian: [-2178458.198413, 4385055.390495, 4073957.614462], lon_lat: { x: 116.391054, y: 39.901173, z: -23.34 }, radius: 993.82 }
]

const FALLBACK_TRUCKS = [
  { truck_id: 'T001', name: '1号矿卡', driver: '张鹏', driver_info: { age: 35, experience: '8年', license: 'A2' }, vehicle_info: { brand: '徐工XDE240', capacity: 72, maxSpeed: 40 }, mineral_type: { code: 'CU', name: '铜矿石', grade: '1.2%', destination: '冶炼厂A区', color: '#B87333' }, phase: 0.0 },
  { truck_id: 'T002', name: '2号矿卡', driver: '刘威', driver_info: { age: 42, experience: '12年', license: 'A2' }, vehicle_info: { brand: '徐工XDE240', capacity: 72, maxSpeed: 40 }, mineral_type: { code: 'FE', name: '铁矿石', grade: '45%', destination: '选矿厂B区', color: '#8B4513' }, phase: 0.33 },
  { truck_id: 'T003', name: '3号矿卡', driver: '王超', driver_info: { age: 28, experience: '5年', license: 'A2' }, vehicle_info: { brand: '徐工XDE240', capacity: 72, maxSpeed: 40 }, mineral_type: { code: 'AU', name: '金矿石', grade: '3.5g/t', destination: '精炼厂C区', color: '#FFD700' }, phase: 0.66 }
]

export async function fetchCameraPresets() {
  return safeRequest(() => client.get('/monitoring/cameras'), FALLBACK_CAMERAS)
}

export async function fetchMineralTypes() {
  return safeRequest(() => client.get('/monitoring/minerals'), FALLBACK_MINERALS)
}

export async function fetchTransportUnits() {
  return safeRequest(() => client.get('/monitoring/transport-units'), FALLBACK_TRANSPORT)
}

export async function fetchMiningPits() {
  return safeRequest(() => client.get('/monitoring/mining-pits'), FALLBACK_PITS)
}

export async function fetchTruckConfigs() {
  return safeRequest(() => client.get('/monitoring/trucks'), FALLBACK_TRUCKS)
}

export async function fetchFullMonitoringConfig() {
  return safeRequest(
    () => client.get('/monitoring/full-config'),
    { cameras: FALLBACK_CAMERAS, minerals: FALLBACK_MINERALS, transportUnits: FALLBACK_TRANSPORT, miningPits: FALLBACK_PITS, trucks: FALLBACK_TRUCKS }
  )
}
