import * as Cesium from 'cesium'

export const DEFAULT_ACTIVE_LAYERS = {
  equipment: true,
  risk: true
}

export const DEFAULT_MONITORING_TICK_MS = 1000
export const DEFAULT_MAX_TRAJECTORY_POINTS = 240
export const DEFAULT_CAMERA_PRESET_ID = 'overview'

// 采场位置（由模型 scenetree.json 坐标转换而来，运行时计算）
function cartesianToLonLat(cartesian) {
  const cartesian3 = new Cesium.Cartesian3(cartesian[0], cartesian[1], cartesian[2])
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian3)
  return {
    x: Cesium.Math.toDegrees(cartographic.longitude),
    y: Cesium.Math.toDegrees(cartographic.latitude),
    z: cartographic.height
  }
}

const MINING_PIT_1_CARTESIAN = [-2178472.525158136, 4385068.25124887, 4073979.8959065275]
const MINING_PIT_1_LONLAT = cartesianToLonLat(MINING_PIT_1_CARTESIAN)
const MINING_PIT_1_RADIUS = 1217.6985574230237

const MINING_PIT_2_CARTESIAN = [-2178458.1984128794, 4385055.3904954335, 4073957.6144616078]
const MINING_PIT_2_LONLAT = cartesianToLonLat(MINING_PIT_2_CARTESIAN)
const MINING_PIT_2_RADIUS = 993.8219488941803

export const MINING_PIT_MODEL_SPECS = {
  pit1: {
    id: 'd645920e395fedad7bbbed0eca3fe2e0',
    name: '采场模型1',
    cartesian: MINING_PIT_1_CARTESIAN,
    lonLat: MINING_PIT_1_LONLAT,
    radius: MINING_PIT_1_RADIUS
  },
  pit2: {
    id: 'd67d8ab4f4c10bf22aa353e27879133c',
    name: '采场模型2',
    cartesian: MINING_PIT_2_CARTESIAN,
    lonLat: MINING_PIT_2_LONLAT,
    radius: MINING_PIT_2_RADIUS
  }
}

// 相机预设位 - 基于采场位置计算
export const CAMERA_PRESETS = [
  {
    id: 'overview',
    name: '总览镜头',
    description: '查看采场1、采场2及矿卡整体运行',
    emoji: '🗺️',
    destination: {
      x: (MINING_PIT_1_LONLAT.x + MINING_PIT_2_LONLAT.x) / 2,
      y: (MINING_PIT_1_LONLAT.y + MINING_PIT_2_LONLAT.y) / 2,
      z: 800
    },
    heading: 0,
    pitch: -1.2,
    roll: 0
  },
  {
    id: 'loading',
    name: '装载区镜头',
    description: '查看采场1矿卡装载位置',
    emoji: '⛏️',
    destination: { x: MINING_PIT_1_LONLAT.x, y: MINING_PIT_1_LONLAT.y, z: 200 },
    heading: 0.5,
    pitch: -0.7,
    roll: 0
  },
  {
    id: 'road',
    name: '运输线镜头',
    description: '查看采场1到采场2运输线路',
    emoji: '🛣️',
    destination: {
      x: (MINING_PIT_1_LONLAT.x + MINING_PIT_2_LONLAT.x) / 2,
      y: (MINING_PIT_1_LONLAT.y + MINING_PIT_2_LONLAT.y) / 2,
      z: 300
    },
    heading: 0.8,
    pitch: -0.8,
    roll: 0
  },
  {
    id: 'dump',
    name: '卸载区镜头',
    description: '查看采场2矿卡卸载位置',
    emoji: '📤',
    destination: { x: MINING_PIT_2_LONLAT.x, y: MINING_PIT_2_LONLAT.y, z: 200 },
    heading: -1.2,
    pitch: -0.7,
    roll: 0
  }
]

export const MINING_PIT_1_POSITION = MINING_PIT_1_LONLAT
export const MINING_PIT_2_POSITION = MINING_PIT_2_LONLAT
