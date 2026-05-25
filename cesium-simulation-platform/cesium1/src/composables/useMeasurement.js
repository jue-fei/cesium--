import { storeToRefs } from 'pinia'
import * as Cesium from 'cesium'
import useViewer from '@/composables/useViewer.js'
import useMessage from '@/composables/useMessage.js'
import { useMeasurementStore } from '../stores/measurementStore.js'

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

function serializeCartesian(point) {
  if (!point) return null
  return { x: point.x, y: point.y, z: point.z }
}

export default function useMeasurement() {
  const store = useMeasurementStore()
  const {
    isMeasuring,
    isAreaMeasuring,
    measurementPoints,
    measurementDistance,
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
      if (isMeasuring.value || isAreaMeasuring.value) {
        const ray = viewer.camera.getPickRay(screenPosition)
        const terrainPos = viewer.scene.globe.pick(ray, viewer.scene)
        if (terrainPos) return terrainPos
        return viewer.scene.camera.pickEllipsoid(screenPosition, viewer.scene.globe.ellipsoid)
      }
      const picked = viewer.scene.pick(screenPosition)
      if (picked && (picked.primitive instanceof Cesium.Cesium3DTileset || picked.id)) {
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
    const temp = viewer.entities.getById('measurement-temp-line')
    if (temp) viewer.entities.remove(temp)

    viewer.entities.add({
      id: 'measurement-temp-line',
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
    const temp = viewer.entities.getById('measurement-temp-line')
    if (temp) viewer.entities.remove(temp)
  }

  /**
   * 添加测量点
   */
  const addMeasurementPoint = position => {
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
      const distance = Cesium.Cartesian3.distance(a, b)
      measurementDistance.value += distance

      const line = viewer.entities.add({
        polyline: { positions: [a, b], width: 2, material: Cesium.Color.CYAN }
      })
      measurementEntities.value.push(line)
    }
  }

  /**
   * Draw area polygon
   */
  const drawAreaPolygon = () => {
    const viewer = getViewer()
    if (measurementPoints.value.length < 3 || !viewer) return

    const pts = [...measurementPoints.value, measurementPoints.value[0]]
    const poly = viewer.entities.add({
      polygon: { hierarchy: pts, material: Cesium.Color.GREEN.withAlpha(0.2) }
    })
    measurementEntities.value.push(poly)

    const area = calculatePolygonArea3D(pts)
    measurementArea.value = area
  }

  /**
   * Save measurement to history
   */
  const saveMeasurementToHistory = type => {
    if (
      (type === 'distance' && measurementDistance.value === 0) ||
      (type === 'area' && measurementArea.value === 0)
    ) {
      return
    }

    const serializablePoints = measurementPoints.value.map(p => serializeCartesian(p))
    const record = {
      id: Date.now(),
      type,
      value: type === 'distance' ? measurementDistance.value : measurementArea.value,
      distance: measurementDistance.value,
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
      area: r.area,
      points: r.points,
      timestamp: r.timestamp
    }))

    localStorage.setItem('measurementHistory', JSON.stringify(toSave))
  }

  /**
   * 停止距离测量
   */
  const stopMeasurement = () => {
    if (measurementHandler) {
      measurementHandler.destroy()
      measurementHandler = null
    }

    const viewer = getViewer()
    if (viewer) {
      viewer.canvas.style.cursor = 'default'
    }

    isMeasuring.value = false
    clearTemporaryLine()
  }

  /**
   * 停止面积测量
   */
  const stopAreaMeasurement = () => {
    if (areaMeasurementHandler) {
      areaMeasurementHandler.destroy()
      areaMeasurementHandler = null
    }

    const viewer = getViewer()
    if (viewer) {
      viewer.canvas.style.cursor = 'default'
    }

    isAreaMeasuring.value = false
    clearTemporaryLine()
    if (measurementPoints.value.length >= 3) {
      drawAreaPolygon()
    }
  }

  /**
   * 清空当前测量
   */
  const clearCurrentMeasurement = () => {
    const viewer = getViewer()

    if (viewer) {
      viewer.canvas.style.cursor = 'default'
    }

    if (viewer) {
      measurementEntities.value.forEach(e => viewer.entities.remove(e))
      measurementEntities.value = []
    }
    clearTemporaryLine()
    measurementPoints.value = []
    measurementDistance.value = 0
    measurementArea.value = 0
    if (isMeasuring.value) stopMeasurement()
    if (isAreaMeasuring.value) stopAreaMeasurement()
  }

  /**
   * 初始化测量
   */
  const initMeasurement = (type, stopFn) => {
    const viewer = getViewer()
    clearCurrentMeasurement()
    if (!viewer) return

    viewer.canvas.style.cursor = 'crosshair'
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    showOperationMessage(type === 'distance' ? '开始距离测量' : '开始面积测量', 'info')

    handler.setInputAction(evt => {
      const pos = getPositionFromClick(evt.position)
      if (!pos) return
      addMeasurementPoint(pos)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    handler.setInputAction(() => {
      const minPoints = type === 'distance' ? 2 : 3
      if (measurementPoints.value.length >= minPoints) {
        saveMeasurementToHistory(type)
      }
      stopFn()
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
    measurementHandler = initMeasurement('distance', stopMeasurement)
  }

  const startAreaMeasurement = () => {
    isAreaMeasuring.value = true
    areaMeasurementHandler = initMeasurement('area', stopAreaMeasurement)
  }

  const toggleMeasurement = () => {
    if (isMeasuring.value) {
      stopMeasurement()
    } else {
      stopAreaMeasurement()
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
    const stored = localStorage.getItem('measurementHistory')
    if (stored) {
      try {
        measurementHistory.value = JSON.parse(stored)
      } catch (e) {
        measurementHistory.value = []
      }
    }
  }

  const clearAllMeasurements = () => {
    clearCurrentMeasurement()
    measurementHistory.value = []
    localStorage.removeItem('measurementHistory')
  }

  const deleteMeasurementRecord = id => {
    measurementHistory.value = measurementHistory.value.filter(r => r.id !== id)
    localStorage.setItem('measurementHistory', JSON.stringify(measurementHistory.value))
  }

  return {
    isMeasuring,
    isAreaMeasuring,
    measurementDistance,
    measurementArea,
    measurementHistory,
    measurementPoints,
    toggleMeasurement,
    toggleAreaMeasurement,
    clearCurrentMeasurement,
    clearAllMeasurements,
    deleteMeasurementRecord,
    loadMeasurementHistory
  }
}
