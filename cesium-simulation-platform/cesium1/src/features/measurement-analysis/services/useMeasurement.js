import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { warn } from '@/utils/errorHandler.js'
import * as Cesium from 'cesium'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'
import { useMeasurementStore } from '../../../stores/measurementStore.js'
import {
  CURSOR,
  MEASUREMENT_HISTORY_STORAGE_KEY,
  MEASUREMENT_MESSAGES,
  MEASUREMENT_MIN_POINTS,
  MEASUREMENT_TYPES,
  TEMP_LINE_ENTITY_ID,
  TEMP_RESULT_LABEL_ENTITY_ID
} from '../types/measurementConstants.js'

let measurementHandler = null
let areaMeasurementHandler = null

// 辅助函数
function calculatePolygonArea3D(points) {
  if (!points || points.length < 3) return 0
  let area = 0
  const n = points.length
  const ref = points[0]
  for (let i = 1; i < n - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    const v1 = Cesium.Cartesian3.subtract(p1, ref, new Cesium.Cartesian3())
    const v2 = Cesium.Cartesian3.subtract(p2, ref, new Cesium.Cartesian3())
    const cross = Cesium.Cartesian3.cross(v1, v2, new Cesium.Cartesian3())
    area += Cesium.Cartesian3.magnitude(cross) / 2
  }
  return Math.abs(area)
}

function calculateTriangleArea(a, b, c) {
  if (!a || !b || !c) return 0
  const ab = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3())
  const ac = Cesium.Cartesian3.subtract(c, a, new Cesium.Cartesian3())
  const cross = Cesium.Cartesian3.cross(ab, ac, new Cesium.Cartesian3())
  return Cesium.Cartesian3.magnitude(cross) * 0.5
}

function getLocalSurfaceFrame(points) {
  const centroid = calculateCentroid(points)
  if (!centroid) return null
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(centroid)
  const inverse = Cesium.Matrix4.inverse(transform, new Cesium.Matrix4())
  const localPoints = points.map(point =>
    Cesium.Matrix4.multiplyByPoint(inverse, point, new Cesium.Cartesian3())
  )
  return { centroid, transform, inverse, localPoints }
}

function getTriangleSubdivisionLevel(a, b, c) {
  const maxEdge = Math.max(
    Cesium.Cartesian2.distance(a, b),
    Cesium.Cartesian2.distance(b, c),
    Cesium.Cartesian2.distance(c, a)
  )
  return Math.max(2, Math.min(32, Math.ceil(maxEdge / 4)))
}

async function sampleCartographicHeights(viewer, cartographics) {
  const clones = cartographics.map(
    item => new Cesium.Cartographic(item.longitude, item.latitude, Number(item.height) || 0)
  )
  if (clones.length < 1) return []
  if (typeof viewer?.scene?.sampleHeightMostDetailed === 'function') {
    try {
      const sampled = await viewer.scene.sampleHeightMostDetailed(clones)
      if (Array.isArray(sampled)) return normalizeCartographicSamples(sampled)
    } catch (e) {
      warn('measurement', 'useMeasurement', e)
    }
  }
  if (viewer?.terrainProvider && typeof Cesium.sampleTerrainMostDetailed === 'function') {
    try {
      const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, clones)
      if (Array.isArray(sampled)) return normalizeCartographicSamples(sampled)
    } catch (e) {
      warn('measurement', 'useMeasurement', e)
    }
  }
  return clones.map(item =>
    createCartographicSample(
      item,
      Number.isFinite(viewer?.scene?.globe?.getHeight?.(item))
        ? viewer.scene.globe.getHeight(item)
        : Number(item.height) || 0
    )
  )
}

async function calculateTerrainAwarePolygonArea(viewer, points) {
  if (!viewer || !Array.isArray(points) || points.length < 3) {
    return { area: 0, sampled: false }
  }
  const frame = getLocalSurfaceFrame(points)
  if (!frame) return { area: 0, sampled: false }
  const positions2D = frame.localPoints.map(point => new Cesium.Cartesian2(point.x, point.y))
  let indices
  try {
    indices = Cesium.PolygonPipeline.triangulate(positions2D, [])
  } catch (e) {
    warn('measurement', 'useMeasurement', e)
    return { area: calculatePolygonArea3D(points), sampled: false }
  }
  if (!Array.isArray(indices) || indices.length < 3) {
    return { area: calculatePolygonArea3D(points), sampled: false }
  }

  const sampleEntries = []
  const sampleIndexByKey = new Map()
  const pendingTriangles = []
  const pushSample = point2D => {
    const key = `${point2D.x.toFixed(3)}:${point2D.y.toFixed(3)}`
    if (sampleIndexByKey.has(key)) return sampleIndexByKey.get(key)
    const worldOnPlane = Cesium.Matrix4.multiplyByPoint(
      frame.transform,
      new Cesium.Cartesian3(point2D.x, point2D.y, 0),
      new Cesium.Cartesian3()
    )
    const cartographic = Cesium.Cartographic.fromCartesian(worldOnPlane)
    if (!cartographic) return -1
    const index = sampleEntries.length
    sampleEntries.push({ point2D, cartographic, world: null })
    sampleIndexByKey.set(key, index)
    return index
  }

  for (let cursor = 0; cursor < indices.length; cursor += 3) {
    const a = positions2D[indices[cursor]]
    const b = positions2D[indices[cursor + 1]]
    const c = positions2D[indices[cursor + 2]]
    const subdivision = getTriangleSubdivisionLevel(a, b, c)
    const triangle = []
    for (let i = 0; i <= subdivision; i++) {
      triangle[i] = []
      for (let j = 0; j <= subdivision - i; j++) {
        const wa = (subdivision - i - j) / subdivision
        const wb = i / subdivision
        const wc = j / subdivision
        const point2D = new Cesium.Cartesian2(
          a.x * wa + b.x * wb + c.x * wc,
          a.y * wa + b.y * wb + c.y * wc
        )
        triangle[i][j] = pushSample(point2D)
      }
    }
    pendingTriangles.push({ subdivision, triangle })
  }

  const batchSize = 200
  for (let offset = 0; offset < sampleEntries.length; offset += batchSize) {
    const batch = sampleEntries.slice(offset, offset + batchSize)
    const sampled = await sampleCartographicHeights(
      viewer,
      batch.map(item => item.cartographic)
    )
    batch.forEach((item, index) => {
      const cartographic = sampled[index] || item.cartographic
      item.world = Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        Number.isFinite(cartographic.height) ? cartographic.height : 0
      )
    })
  }

  let area = 0
  pendingTriangles.forEach(({ subdivision, triangle }) => {
    for (let i = 0; i < subdivision; i++) {
      for (let j = 0; j < subdivision - i; j++) {
        const aIndex = triangle[i][j]
        const bIndex = triangle[i + 1][j]
        const cIndex = triangle[i][j + 1]
        const dIndex = j < subdivision - i - 1 ? triangle[i + 1][j + 1] : -1
        const aw = sampleEntries[aIndex]?.world
        const bw = sampleEntries[bIndex]?.world
        const cw = sampleEntries[cIndex]?.world
        area += calculateTriangleArea(aw, bw, cw)
        if (dIndex >= 0) {
          const dw = sampleEntries[dIndex]?.world
          area += calculateTriangleArea(bw, dw, cw)
        }
      }
    }
  })

  return { area, sampled: area > 0 }
}

function destroyHandler(handler) {
  if (handler) handler.destroy()
  return null
}

function normalizeCartographicSamples(samples) {
  return samples.map(item => createCartographicSample(item, item?.height))
}

function createCartographicSample(item, height) {
  return new Cesium.Cartographic(
    item.longitude,
    item.latitude,
    Number.isFinite(height) ? height : 0
  )
}

async function calculateTerrainPath(viewer, pointA, pointB) {
  const cartA = Cesium.Cartographic.fromCartesian(pointA)
  const cartB = Cesium.Cartographic.fromCartesian(pointB)
  const greatCircleDist = Cesium.Cartesian3.distance(pointA, pointB)
  const numSamples = Math.max(20, Math.min(200, Math.ceil(greatCircleDist / 10)))

  const samples = []
  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples
    const lon = Cesium.Math.lerp(cartA.longitude, cartB.longitude, t)
    const lat = Cesium.Math.lerp(cartA.latitude, cartB.latitude, t)
    samples.push(new Cesium.Cartographic(lon, lat, 0))
  }

  const sampled = await sampleCartographicHeights(viewer, samples)
  const positions = sampled.map(s =>
    Cesium.Cartesian3.fromRadians(s.longitude, s.latitude, s.height)
  )
  let totalDistance = 0
  for (let i = 1; i < positions.length; i++) {
    totalDistance += Cesium.Cartesian3.distance(positions[i - 1], positions[i])
  }
  return { distance: totalDistance, positions }
}

function serializeCartesian(point) {
  if (!point) return null
  return { x: point.x, y: point.y, z: point.z }
}

function calculateCentroid(points) {
  if (!Array.isArray(points) || points.length === 0) return null
  const center = new Cesium.Cartesian3(0, 0, 0)
  points.forEach(point => {
    Cesium.Cartesian3.add(center, point, center)
  })
  return Cesium.Cartesian3.divideByScalar(center, points.length, center)
}

export default function useMeasurement() {
  const store = useMeasurementStore()
  const {
    isMeasuring,
    isAreaMeasuring,
    measurementPoints,
    measurementDistance,
    terrainDistance,
    distanceMode,
    measurementArea,
    measurementEntities,
    measurementHistory
  } = storeToRefs(store)

  const { showOperationMessage } = useMessage()

  const { getViewer } = useViewer()

  /**
   * 从屏幕坐标解析世界坐标
   */
  const getPositionFromClick = screenPosition => {
    const viewer = getViewer()
    if (!viewer) return null

    try {
      const picked = viewer.scene.pick(screenPosition)
      if (
        viewer.scene.pickPositionSupported &&
        picked &&
        (picked.primitive instanceof Cesium.Cesium3DTileset || picked.id || picked.primitive)
      ) {
        const pos = viewer.scene.pickPosition(screenPosition)
        if (pos && Cesium.Cartesian3.distance(pos, Cesium.Cartesian3.ZERO) > 0) return pos
      }
      const ray = viewer.camera.getPickRay(screenPosition)
      const terrainPos = viewer.scene.globe.pick(ray, viewer.scene)
      if (terrainPos) return terrainPos
      return viewer.scene.camera.pickEllipsoid(screenPosition, viewer.scene.globe.ellipsoid)
    } catch (e) {
      return null
    }
  }

  /**
   * 更新临时测量线
   */
  const updateTemporaryLine = screenPosition => {
    const viewer = getViewer()
    const pos = getPositionFromClick(screenPosition)
    if (!pos || measurementPoints.value.length === 0 || !viewer) return

    const last = measurementPoints.value[measurementPoints.value.length - 1]
    const temp = viewer.entities.getById(TEMP_LINE_ENTITY_ID)
    if (temp) viewer.entities.remove(temp)

    viewer.entities.add({
      id: TEMP_LINE_ENTITY_ID,
      polyline: {
        positions: [last, pos],
        width: 1,
        material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE })
      }
    })
  }

  /**
   * 清除临时测量线
   */
  const clearTemporaryLine = () => {
    const viewer = getViewer()
    if (!viewer) return
    const temp = viewer.entities.getById(TEMP_LINE_ENTITY_ID)
    if (temp) viewer.entities.remove(temp)
  }

  const updateMeasurementResultLabel = (position, text) => {
    const viewer = getViewer()
    if (!viewer || !position || !text) return
    const existed = viewer.entities.getById(TEMP_RESULT_LABEL_ENTITY_ID)
    if (existed) {
      existed.position = position
      existed.label.text = text
      return
    }
    const labelEntity = viewer.entities.add({
      id: TEMP_RESULT_LABEL_ENTITY_ID,
      position,
      label: {
        text,
        font: '14px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM
      }
    })
    measurementEntities.value.push(labelEntity)
  }

  let segmentPairs = []

  /**
   * 添加测量点
   */
  const addMeasurementPoint = async position => {
    const viewer = getViewer()
    if (!viewer) return

    measurementPoints.value.push(position)

    const pointEntity = viewer.entities.add({
      position,
      point: { pixelSize: 6, color: Cesium.Color.YELLOW }
    })
    measurementEntities.value.push(pointEntity)

    if (measurementPoints.value.length >= 2) {
      const a = measurementPoints.value[measurementPoints.value.length - 2]
      const b = measurementPoints.value[measurementPoints.value.length - 1]

      const straightDist = Cesium.Cartesian3.distance(a, b)
      measurementDistance.value += straightDist

      const { distance: terrainDist, positions } = await calculateTerrainPath(viewer, a, b)
      terrainDistance.value += terrainDist

      const isTerrain = distanceMode.value === 'terrain'

      const straightLine = viewer.entities.add({
        polyline: { positions: [a, b], width: 2, material: Cesium.Color.CYAN },
        show: !isTerrain
      })
      measurementEntities.value.push(straightLine)

      const terrainLine = viewer.entities.add({
        polyline: { positions, width: 2, material: Cesium.Color.CYAN },
        show: isTerrain
      })
      measurementEntities.value.push(terrainLine)

      segmentPairs.push({ straightLine, terrainLine })

      if (isTerrain) {
        updateMeasurementResultLabel(b, `路途距离 ${terrainDistance.value.toFixed(2)} m`)
      } else {
        updateMeasurementResultLabel(b, `直线距离 ${measurementDistance.value.toFixed(2)} m`)
      }
    }
  }

  /**
   * Draw area polygon
   */
  const drawAreaPolygon = async () => {
    const viewer = getViewer()
    if (measurementPoints.value.length < 3 || !viewer) return

    const pts = [...measurementPoints.value, measurementPoints.value[0]]
    const poly = viewer.entities.add({
      polygon: { hierarchy: pts, material: Cesium.Color.GREEN.withAlpha(0.2) }
    })
    measurementEntities.value.push(poly)

    showOperationMessage('正在计算真实地表面积...', 'info')
    const terrainArea = await calculateTerrainAwarePolygonArea(viewer, measurementPoints.value)
    measurementArea.value = terrainArea.sampled ? terrainArea.area : calculatePolygonArea3D(pts)
    const centroid = calculateCentroid(measurementPoints.value)
    updateMeasurementResultLabel(centroid, `面积 ${measurementArea.value.toFixed(2)} m²`)
    return terrainArea.sampled
  }

  /**
   * Save measurement to history
   */
  const saveMeasurementToHistory = type => {
    if (
      (type === MEASUREMENT_TYPES.DISTANCE &&
        measurementDistance.value === 0 &&
        terrainDistance.value === 0) ||
      (type === MEASUREMENT_TYPES.AREA && measurementArea.value === 0)
    ) {
      return
    }

    const serializablePoints = measurementPoints.value.map(p => serializeCartesian(p))
    const record = {
      id: Date.now(),
      type,
      value:
        type === MEASUREMENT_TYPES.DISTANCE
          ? distanceMode.value === 'terrain'
            ? terrainDistance.value
            : measurementDistance.value
          : measurementArea.value,
      distance: measurementDistance.value,
      terrainDistance: terrainDistance.value,
      distanceMode: distanceMode.value,
      area: measurementArea.value,
      points: serializablePoints,
      timestamp: Date.now()
    }

    measurementHistory.value.unshift(record)
    const toSave = measurementHistory.value.map(r => ({
      id: r.id,
      type: r.type,
      value: r.value,
      distance: r.distance,
      terrainDistance: r.terrainDistance,
      distanceMode: r.distanceMode,
      area: r.area,
      points: r.points,
      timestamp: r.timestamp
    }))

    localStorage.setItem(MEASUREMENT_HISTORY_STORAGE_KEY, JSON.stringify(toSave))
  }

  /**
   * 停止距离测量
   */
  const stopMeasurement = () => {
    measurementHandler = destroyHandler(measurementHandler)
    resetMeasurementCursor()
    isMeasuring.value = false
    clearTemporaryLine()
  }

  const exitMeasurement = () => {
    if (isMeasuring.value && measurementPoints.value.length >= 2) {
      saveMeasurementToHistory(MEASUREMENT_TYPES.DISTANCE)
    }
    if (isAreaMeasuring.value && measurementPoints.value.length >= 3) {
      saveMeasurementToHistory(MEASUREMENT_TYPES.AREA)
    }
    const viewer = getViewer()
    resetMeasurementCursor()
    if (viewer) {
      measurementEntities.value.forEach(e => viewer.entities.remove(e))
      measurementEntities.value = []
    }
    clearTemporaryLine()
    measurementPoints.value = []
    measurementDistance.value = 0
    terrainDistance.value = 0
    measurementArea.value = 0
    segmentPairs = []
    measurementHandler = destroyHandler(measurementHandler)
    areaMeasurementHandler = destroyHandler(areaMeasurementHandler)
    isMeasuring.value = false
    isAreaMeasuring.value = false
  }

  /**
   * 停止面积测量
   */
  const stopAreaMeasurement = async () => {
    areaMeasurementHandler = destroyHandler(areaMeasurementHandler)
    resetMeasurementCursor()
    isAreaMeasuring.value = false
    clearTemporaryLine()
    if (measurementPoints.value.length >= 3) {
      await drawAreaPolygon()
      saveMeasurementToHistory(MEASUREMENT_TYPES.AREA)
    }
  }

  /**
   * 清空当前测量
   */
  const clearCurrentMeasurement = () => {
    const viewer = getViewer()
    resetMeasurementCursor()

    if (viewer) {
      measurementEntities.value.forEach(e => viewer.entities.remove(e))
      measurementEntities.value = []
    }
    clearTemporaryLine()
    measurementPoints.value = []
    measurementDistance.value = 0
    terrainDistance.value = 0
    measurementArea.value = 0
    segmentPairs = []
    if (isMeasuring.value) stopMeasurement()
    if (isAreaMeasuring.value) stopAreaMeasurement()
  }

  const setDistanceMode = mode => {
    if (!['straight', 'terrain'].includes(mode) || distanceMode.value === mode) return
    distanceMode.value = mode

    const isTerrain = mode === 'terrain'
    segmentPairs.forEach(pair => {
      pair.straightLine.show = !isTerrain
      pair.terrainLine.show = isTerrain
    })

    const viewer = getViewer()
    if (measurementPoints.value.length >= 2 && viewer) {
      const lastPoint = measurementPoints.value[measurementPoints.value.length - 1]
      if (isTerrain) {
        updateMeasurementResultLabel(lastPoint, `路途距离 ${terrainDistance.value.toFixed(2)} m`)
      } else {
        updateMeasurementResultLabel(
          lastPoint,
          `直线距离 ${measurementDistance.value.toFixed(2)} m`
        )
      }
    }
  }

  /**
   * 初始化测量
   */
  const initMeasurement = (type, stopFn) => {
    const viewer = getViewer()
    clearCurrentMeasurement()
    if (!viewer) return

    viewer.canvas.style.cursor = CURSOR.MEASURING
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    showOperationMessage(
      type === MEASUREMENT_TYPES.DISTANCE
        ? MEASUREMENT_MESSAGES.START_DISTANCE
        : MEASUREMENT_MESSAGES.START_AREA,
      'info'
    )

    handler.setInputAction(evt => {
      const pos = getPositionFromClick(evt.position)
      if (!pos) return
      addMeasurementPoint(pos)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    handler.setInputAction(async () => {
      const minPoints =
        type === MEASUREMENT_TYPES.DISTANCE
          ? MEASUREMENT_MIN_POINTS.distance
          : MEASUREMENT_MIN_POINTS.area
      if (measurementPoints.value.length >= minPoints) {
        if (type === MEASUREMENT_TYPES.DISTANCE) {
          saveMeasurementToHistory(type)
        }
      }
      await stopFn()
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

    handler.setInputAction(evt => {
      if (measurementPoints.value.length > 0) {
        updateTemporaryLine(evt.endPosition)
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    return handler
  }

  const startDistanceMeasurement = () => {
    isMeasuring.value = true
    measurementHandler = initMeasurement(MEASUREMENT_TYPES.DISTANCE, stopMeasurement)
  }

  const startAreaMeasurement = () => {
    isAreaMeasuring.value = true
    areaMeasurementHandler = initMeasurement(MEASUREMENT_TYPES.AREA, stopAreaMeasurement)
  }

  const toggleMeasurement = () => {
    if (isMeasuring.value) {
      stopMeasurement()
    } else {
      stopAreaMeasurement()
      startDistanceMeasurement()
    }
  }

  const toggleStraightMeasurement = () => {
    if (isMeasuring.value && distanceMode.value === 'straight') {
      stopMeasurement()
    } else if (isMeasuring.value && distanceMode.value === 'terrain') {
      setDistanceMode('straight')
    } else {
      stopAreaMeasurement()
      distanceMode.value = 'straight'
      startDistanceMeasurement()
    }
  }

  const toggleTerrainMeasurement = () => {
    if (isMeasuring.value && distanceMode.value === 'terrain') {
      stopMeasurement()
    } else if (isMeasuring.value && distanceMode.value === 'straight') {
      setDistanceMode('terrain')
    } else {
      stopAreaMeasurement()
      distanceMode.value = 'terrain'
      startDistanceMeasurement()
    }
  }

  const toggleAreaMeasurement = () => {
    if (isAreaMeasuring.value) {
      stopAreaMeasurement()
    } else {
      stopMeasurement()
      startAreaMeasurement()
    }
  }

  const loadMeasurementHistory = () => {
    const stored = localStorage.getItem(MEASUREMENT_HISTORY_STORAGE_KEY)
    if (stored) {
      try {
        measurementHistory.value = JSON.parse(stored).map(r => ({
          ...r,
          terrainDistance: r.terrainDistance ?? 0,
          distanceMode: r.distanceMode ?? 'straight'
        }))
      } catch (e) {
        measurementHistory.value = []
      }
    }
  }

  const clearAllMeasurements = () => {
    clearCurrentMeasurement()
    clearHistoryVisualization()
    measurementHistory.value = []
    localStorage.removeItem(MEASUREMENT_HISTORY_STORAGE_KEY)
  }

  const deleteMeasurementRecord = id => {
    clearHistoryVisualization()
    measurementHistory.value = measurementHistory.value.filter(r => r.id !== id)
    localStorage.setItem(MEASUREMENT_HISTORY_STORAGE_KEY, JSON.stringify(measurementHistory.value))
  }

  let historyVisualizationEntities = []
  const highlightedRecordId = ref(null)

  const showHistoryOnScene = async record => {
    if (highlightedRecordId.value === record.id) {
      clearHistoryVisualization()
      return
    }

    const viewer = getViewer()
    if (!viewer || !record || !record.points) return

    clearHistoryVisualization()

    const positions = record.points.filter(p => p).map(p => new Cesium.Cartesian3(p.x, p.y, p.z))

    if (positions.length === 0) return

    const isTerrain = record.distanceMode === 'terrain'
    const isArea = record.type === 'area'
    const pointColor = isArea
      ? Cesium.Color.fromCssColorString('#ffb74d')
      : isTerrain
        ? Cesium.Color.fromCssColorString('#81c784')
        : Cesium.Color.fromCssColorString('#4fc3f7')
    const lineColor = pointColor

    positions.forEach(pos => {
      const pt = viewer.entities.add({
        _historyVisualization: true,
        position: pos,
        point: {
          pixelSize: 8,
          color: pointColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1
        }
      })
      historyVisualizationEntities.push(pt)
    })

    if (positions.length >= 2) {
      if (isTerrain) {
        for (let i = 0; i < positions.length - 1; i++) {
          try {
            const { positions: terrainPositions } = await calculateTerrainPath(
              viewer,
              positions[i],
              positions[i + 1]
            )
            const line = viewer.entities.add({
              _historyVisualization: true,
              polyline: {
                positions: terrainPositions,
                width: 2,
                material: lineColor
              }
            })
            historyVisualizationEntities.push(line)
          } catch (e) {
            const fallbackLine = viewer.entities.add({
              _historyVisualization: true,
              polyline: {
                positions: [positions[i], positions[i + 1]],
                width: 2,
                material: new Cesium.PolylineDashMaterialProperty({
                  color: lineColor
                })
              }
            })
            historyVisualizationEntities.push(fallbackLine)
          }
        }
      } else {
        const line = viewer.entities.add({
          _historyVisualization: true,
          polyline: {
            positions,
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: lineColor
            })
          }
        })
        historyVisualizationEntities.push(line)
      }
    }

    highlightedRecordId.value = record.id
  }

  const clearHistoryVisualization = () => {
    const viewer = getViewer()
    if (viewer) {
      historyVisualizationEntities.forEach(e => viewer.entities.remove(e))
      // 兜底：遍历所有实体，移除带有历史可视化标记的实体（防止数组引用失效）
      const allEntities = viewer.entities.values || []
      for (let i = allEntities.length - 1; i >= 0; i--) {
        if (allEntities[i]._historyVisualization) {
          viewer.entities.remove(allEntities[i])
        }
      }
    }
    historyVisualizationEntities = []
    highlightedRecordId.value = null
  }

  function resetMeasurementCursor() {
    const viewer = getViewer()
    if (viewer) viewer.canvas.style.cursor = CURSOR.DEFAULT
  }

  return {
    isMeasuring,
    isAreaMeasuring,
    measurementDistance,
    terrainDistance,
    distanceMode,
    measurementArea,
    measurementHistory,
    measurementPoints,
    highlightedRecordId,
    toggleMeasurement,
    toggleStraightMeasurement,
    toggleTerrainMeasurement,
    toggleAreaMeasurement,
    setDistanceMode,
    stopMeasurement,
    exitMeasurement,
    clearCurrentMeasurement,
    clearAllMeasurements,
    deleteMeasurementRecord,
    showHistoryOnScene,
    clearHistoryVisualization,
    loadMeasurementHistory
  }
}
