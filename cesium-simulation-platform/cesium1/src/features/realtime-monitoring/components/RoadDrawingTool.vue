<template>
  <div
    class="bg-white/5 rounded-lg p-4 border border-white/5 hover:border-blue-500/30 transition-all duration-300"
  >
    <div
      class="text-sm font-semibold text-blue-100 mb-3 flex items-center gap-2 before:content-[''] before:w-1 before:h-3 before:bg-blue-500 before:rounded-sm"
    >
      🖊️ 道路绘制工具
    </div>

    <!-- 状态显示 -->
    <div class="flex items-center gap-3 mb-3 px-3 py-2 bg-black/20 rounded-md">
      <span
        class="px-2.5 py-1 rounded text-xs font-medium"
        :class="
          drawingState === 'drawing'
            ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
            : 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
        "
      >
        {{ statusText }}
      </span>
      <span v-if="pathPoints.length > 0" class="text-xs text-gray-500">
        {{ pathPoints.length }} 个点
      </span>
    </div>

    <!-- 控制按钮 -->
    <div class="grid grid-cols-3 gap-2 mb-3">
      <button
        class="px-3 py-2 rounded text-xs font-medium transition-all flex items-center justify-center gap-1"
        :class="
          isDrawing
            ? 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30'
            : editingPathIndex >= 0
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30'
              : 'bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30'
        "
        :disabled="!viewer"
        @click="toggleDrawing"
      >
        {{
          isDrawing
            ? editingPathIndex >= 0
              ? '✓ 更新'
              : '✓ 完成'
            : editingPathIndex >= 0
              ? '✎ 编辑'
              : '✎ 绘制'
        }}
      </button>

      <button
        class="px-3 py-2 rounded bg-white/5 border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="pathPoints.length === 0"
        @click="clearPath"
      >
        🗑 清除
      </button>

      <button
        class="px-3 py-2 rounded bg-blue-500/20 border border-blue-500/30 text-xs text-blue-300 hover:bg-blue-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="pathPoints.length < 2"
        @click="applyToTrucks"
      >
        🚛 应用
      </button>
    </div>

    <div class="mb-3">
      <button
        class="w-full px-3 py-2 rounded text-xs font-medium transition-all flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
        :class="
          hasDefaultRoute
            ? 'bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30'
            : 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30'
        "
        :disabled="pathPoints.length < 2 && !hasDefaultRoute"
        @click="setCurrentAsDefault"
      >
        {{ hasDefaultRoute ? '🔄 更新默认路线' : '⭐ 设为默认路线' }}
      </button>
    </div>

    <!-- 路径列表 -->
    <div v-if="savedPaths.length > 0" class="mb-3">
      <div class="text-xs text-gray-500 mb-2">已保存的路径</div>
      <div class="max-h-[120px] overflow-y-auto space-y-1">
        <div
          v-for="(path, index) in savedPaths"
          :key="index"
          class="flex items-center gap-2 px-3 py-2 rounded bg-black/20 cursor-pointer transition-all hover:bg-black/30"
          :class="
            selectedPathIndex === index
              ? 'bg-blue-500/20 border border-blue-500/30'
              : 'border border-transparent'
          "
          @click="selectPath(index)"
        >
          <span class="flex-1 text-xs text-gray-200 truncate">
            {{ path.name }}
            <span v-if="path.isDefault" class="ml-1 text-[10px] text-amber-400">⭐默认</span>
          </span>
          <span class="text-[10px] text-gray-500">{{ path.points.length }} 点</span>
          <button
            v-if="!path.isDefault"
            class="w-5 h-5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 flex items-center justify-center text-[10px] transition-colors"
            title="设为默认"
            @click.stop="setSavedPathAsDefault(index)"
          >
            ⭐
          </button>
          <button
            class="w-5 h-5 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 flex items-center justify-center text-xs transition-colors"
            @click.stop="deletePath(index)"
          >
            ×
          </button>
        </div>
      </div>
    </div>

    <!-- 提示信息 -->
    <div class="px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-md">
      <p class="text-xs text-gray-400 leading-relaxed">
        <span class="text-blue-400">💡</span>
        {{
          isDrawing
            ? editingPathIndex >= 0
              ? '编辑模式：添加/修改路径点，双击完成更新'
              : '点击模型表面添加路径点，双击完成绘制'
            : pathPoints.length === 0
              ? '点击"绘制"创建新道路，或从下方列表选择已有路径进行编辑'
              : editingPathIndex >= 0
                ? '点击"编辑"修改路径点，或点击"应用"同步到矿卡'
                : '路径已创建，可以应用到矿卡或继续编辑'
        }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import * as Cesium from 'cesium'
import {
  saveDefaultRoute,
  saveAllPaths,
  loadAllPaths,
  loadAllRoutesFromDb,
  saveDefaultRouteToDb,
  saveRouteToDb,
  setRouteAsDefaultInDb,
  deleteRouteFromDb,
  updateRouteInDb
} from '../services/routeStorage.js'

const props = defineProps({ viewer: { type: Object, required: true } })
const emit = defineEmits(['path-updated', 'path-applied', 'default-route-set'])

const isDrawing = ref(false)
const pathPoints = ref([])
const savedPaths = ref([])
const selectedPathIndex = ref(-1)
const editingPathIndex = ref(-1)
const drawingState = computed(() => (isDrawing.value ? 'drawing' : 'idle'))
const hasDefaultRoute = computed(() => savedPaths.value.some(p => p.isDefault))

let pointEntities = [],
  lineEntity = null,
  previewLineEntity = null,
  handler = null
let cursorIndicatorEntity = null
let pathLineBuildVersion = 0
let cachedSurfacePathPoints = [],
  cachedPathSignature = '',
  cachedSourcePathPoints = []
let cachedSurfaceSegments = new Map()
let previewFrameRequestId = null,
  pendingPreviewScreenPosition = null

const FINAL_PATH_SAMPLES_PER_SEGMENT = 24
const PREVIEW_PATH_SAMPLES_PER_SEGMENT = 10
const ROUTE_DISPLAY_LIFT_METERS = 0.03

const statusText = computed(() =>
  isDrawing.value
    ? editingPathIndex.value >= 0
      ? '编辑中...'
      : '绘制中...'
    : pathPoints.value.length === 0
      ? '就绪'
      : editingPathIndex.value >= 0
        ? '已加载'
        : '已完成'
)

const cartesianToPoint = cartesian => {
  const c = Cesium.Cartographic.fromCartesian(cartesian)
  return {
    longitude: Cesium.Math.toDegrees(c.longitude),
    latitude: Cesium.Math.toDegrees(c.latitude),
    height: c.height,
    cartesian
  }
}

const pointToStr = p =>
  [
    Number(p.longitude).toFixed(8),
    Number(p.latitude).toFixed(8),
    Number(p.height || 0).toFixed(3)
  ].join(',')

function createPathSignature(points, samples = FINAL_PATH_SAMPLES_PER_SEGMENT) {
  return [samples, ...points.map(pointToStr)].join('|')
}

function createSegmentSignature(start, end) {
  return [pointToStr(start), '->', pointToStr(end)].join('|')
}

onMounted(async () => {
  // 优先从数据库加载路线列表
  const dbRoutes = await loadAllRoutesFromDb().catch(() => [])
  if (dbRoutes.length > 0) {
    savedPaths.value = dbRoutes.map(r => ({
      _dbId: r.id,
      name: r.name,
      points: r.points,
      createdAt: r.createdAt || new Date().toLocaleString(),
      isDefault: r.isDefault
    }))
  } else {
    // 降级到 localStorage
    const stored = loadAllPaths()
    if (stored.length > 0) savedPaths.value = stored
  }
  if (props.viewer) initHandler()
})
onUnmounted(() => cleanup())
watch(
  () => props.viewer,
  v => {
    if (v) initHandler()
  }
)

function initHandler() {
  if (!props.viewer || handler) return
  handler = new Cesium.ScreenSpaceEventHandler(props.viewer.canvas)
  handler.setInputAction(m => {
    if (isDrawing.value && pathPoints.value.length > 0) schedulePreviewLineUpdate(m.endPosition)
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
  handler.setInputAction(click => {
    if (isDrawing.value) addPoint(click.position)
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
  handler.setInputAction(() => {
    if (isDrawing.value && pathPoints.value.length >= 2) finishDrawing()
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
}

function cleanup() {
  handler?.destroy()
  handler = null
  clearVisualization()
}

function clearVisualization() {
  ;[...pointEntities, lineEntity, previewLineEntity, cursorIndicatorEntity].forEach(e => {
    if (e) props.viewer.entities.remove(e)
  })
  pointEntities = []
  lineEntity = null
  previewLineEntity = null
  cursorIndicatorEntity = null
  cachedSurfacePathPoints = []
  cachedPathSignature = ''
  cachedSourcePathPoints = []
  cachedSurfaceSegments = new Map()
  pathLineBuildVersion++
  if (previewFrameRequestId !== null) {
    cancelAnimationFrame(previewFrameRequestId)
    previewFrameRequestId = null
  }
  pendingPreviewScreenPosition = null
}

function toggleDrawing() {
  isDrawing.value ? finishDrawing() : startDrawing()
}
function startDrawing() {
  isDrawing.value = true
  // 编辑模式保留已有路径点，新建模式清空
  if (editingPathIndex.value < 0) {
    pathPoints.value = []
  }
  clearVisualization()
}

function finishDrawing() {
  isDrawing.value = false
  if (previewLineEntity) {
    props.viewer.entities.remove(previewLineEntity)
    previewLineEntity = null
  }
  if (cursorIndicatorEntity) {
    props.viewer.entities.remove(cursorIndicatorEntity)
    cursorIndicatorEntity = null
  }
  pointEntities.forEach(e => props.viewer.entities.remove(e))
  pointEntities = []
  if (pathPoints.value.length >= 2) {
    // 编辑已有路线
    if (editingPathIndex.value >= 0) {
      const existing = savedPaths.value[editingPathIndex.value]
      if (existing) {
        existing.points = [...pathPoints.value]
        existing.createdAt = new Date().toLocaleString()
        // 更新数据库
        if (existing._dbId) {
          updateRouteInDb(existing._dbId, existing.name, existing.points, existing.isDefault).catch(
            () => {}
          )
        } else {
          saveRouteToDb(existing.name, existing.points, existing.isDefault)
            .then(res => {
              if (res?.id) existing._dbId = res.id
            })
            .catch(() => {})
        }
        saveAllPaths(savedPaths.value)
        emit('path-updated', { name: existing.name, points: pathPoints.value })
      }
      editingPathIndex.value = -1
      return
    }

    // 新建路线
    const name = `路径 ${savedPaths.value.length + 1}`
    const newPath = {
      name,
      points: [...pathPoints.value],
      createdAt: new Date().toLocaleString(),
      isDefault: false
    }
    saveRouteToDb(name, newPath.points, false)
      .then(res => {
        if (res?.id) newPath._dbId = res.id
      })
      .catch(() => {})
    savedPaths.value.push(newPath)
    selectedPathIndex.value = savedPaths.value.length - 1
    saveAllPaths(savedPaths.value)
    emit('path-updated', { name, points: pathPoints.value })
  }
}

function pickPosition(screenPosition) {
  const scene = props.viewer.scene
  let pos = scene.pickPositionSupported ? scene.pickPosition(screenPosition) : null
  if (pos) {
    const c = Cesium.Cartographic.fromCartesian(pos)
    if (!isValidPosition(c)) pos = null
  }
  if (!pos) {
    const ray = props.viewer.camera.getPickRay(screenPosition)
    pos = scene.globe.pick(ray, scene)
  }
  if (!pos) pos = scene.camera.pickEllipsoid(screenPosition, scene.globe.ellipsoid)
  return pos
}

function isValidPosition(c) {
  const h = c.height
  return (
    Cesium.Math.toDegrees(c.latitude) !== 0 &&
    Cesium.Math.toDegrees(c.longitude) !== 0 &&
    !isNaN(h) &&
    h > -10000 &&
    h < 10000
  )
}

function sampleSurfaceHeight(lon, lat, fallback = 0) {
  const scene = props.viewer?.scene
  if (!scene) return fallback
  const cg = Cesium.Cartographic.fromDegrees(lon, lat, fallback)
  try {
    const h = scene.sampleHeight?.(cg)
    if (Number.isFinite(h)) return h
  } catch (e) {
    /* noop */
  }
  try {
    const cp = scene.clampToHeight?.(Cesium.Cartesian3.fromDegrees(lon, lat, fallback))
    if (cp) {
      const cc = Cesium.Cartographic.fromCartesian(cp)
      if (Number.isFinite(cc?.height)) return cc.height
    }
  } catch (e) {
    /* noop */
  }
  const gh = scene.globe?.getHeight?.(cg)
  return Number.isFinite(gh) ? gh : fallback
}

function getAdaptiveSampleCount(start, end, fallback = FINAL_PATH_SAMPLES_PER_SEGMENT) {
  if (!start || !end) return fallback
  try {
    const d = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(start.longitude, start.latitude, start.height || 0),
      Cesium.Cartesian3.fromDegrees(end.longitude, end.latitude, end.height || 0)
    )
    return Math.max(12, Math.min(64, Math.ceil(d / 2) || fallback))
  } catch (e) {
    return fallback
  }
}

function addPoint(screenPosition) {
  const pos = pickPosition(screenPosition)
  if (!pos) return
  const point = { ...cartesianToPoint(pos), id: Date.now() }
  pathPoints.value.push(point)
  cachedPathSignature = ''
  const entity = props.viewer.entities.add({
    position: pos,
    point: {
      pixelSize: 14,
      color: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.RED,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: `${pathPoints.value.length}`,
      font: 'bold 14px sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -15),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  })
  pointEntities.push(entity)
  void updatePathLine()
}

function liftCartesianAboveSurface(cartesian, liftMeters = ROUTE_DISPLAY_LIFT_METERS) {
  if (!cartesian) return cartesian
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cartesian, new Cesium.Cartesian3())
  const offset = Cesium.Cartesian3.multiplyByScalar(normal, liftMeters, new Cesium.Cartesian3())
  return Cesium.Cartesian3.add(cartesian, offset, new Cesium.Cartesian3())
}

function isSamePathPoint(a, b) {
  if (!a || !b) return false
  return (
    Math.abs(Number(a.longitude) - Number(b.longitude)) < 1e-8 &&
    Math.abs(Number(a.latitude) - Number(b.latitude)) < 1e-8 &&
    Math.abs(Number(a.height || 0) - Number(b.height || 0)) < 1e-3
  )
}

function canAppendLatestSegment(points) {
  if (!Array.isArray(points) || !Array.isArray(cachedSourcePathPoints)) return false
  if (cachedSourcePathPoints.length < 1 || points.length !== cachedSourcePathPoints.length + 1) {
    return false
  }

  for (let i = 0; i < cachedSourcePathPoints.length; i++) {
    if (!isSamePathPoint(points[i], cachedSourcePathPoints[i])) {
      return false
    }
  }

  return true
}

async function sampleSurfaceHeights(points) {
  const scene = props.viewer?.scene
  if (!scene || !Array.isArray(points) || points.length === 0) return points.map(p => ({ ...p }))

  const cartesians = points.map(p =>
    Cesium.Cartesian3.fromDegrees(Number(p.longitude), Number(p.latitude), Number(p.height) || 0)
  )
  try {
    const clamped = await scene.clampToHeightMostDetailed?.(cartesians)
    if (Array.isArray(clamped))
      return points.map((p, i) => {
        const cc = Cesium.Cartographic.fromCartesian(clamped[i])
        return {
          ...p,
          height:
            cc && Number.isFinite(cc.height)
              ? cc.height
              : sampleSurfaceHeight(p.longitude, p.latitude, p.height || 0)
        }
      })
  } catch (e) {
    /* noop */
  }

  const cartographics = points.map(
    p =>
      new Cesium.Cartographic(
        Cesium.Math.toRadians(p.longitude),
        Cesium.Math.toRadians(p.latitude),
        Number(p.height) || 0
      )
  )
  try {
    const sampled = await scene.sampleHeightMostDetailed?.(cartographics)
    if (Array.isArray(sampled))
      return points.map((p, i) => ({
        ...p,
        height: Number.isFinite(sampled[i]?.height)
          ? sampled[i].height
          : sampleSurfaceHeight(p.longitude, p.latitude, p.height || 0)
      }))
  } catch (e) {
    /* noop */
  }

  return points.map(p => ({
    ...p,
    height: sampleSurfaceHeight(p.longitude, p.latitude, p.height || 0)
  }))
}

function buildInterpolatedPathPoints(points, samplesPerSegment = FINAL_PATH_SAMPLES_PER_SEGMENT) {
  if (!Array.isArray(points) || points.length === 0) return []

  if (points.length === 1) {
    const point = points[0]
    return [
      {
        longitude: point.longitude,
        latitude: point.latitude,
        height: point.height || 0
      }
    ]
  }

  const sampledPoints = []

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    const segmentSamples = getAdaptiveSampleCount(start, end, samplesPerSegment)

    for (let j = 0; j < segmentSamples; j++) {
      const t = j / segmentSamples
      const longitude = start.longitude + (end.longitude - start.longitude) * t
      const latitude = start.latitude + (end.latitude - start.latitude) * t
      const height = start.height + (end.height - start.height) * t

      sampledPoints.push({
        longitude,
        latitude,
        height
      })
    }
  }

  const last = points[points.length - 1]
  sampledPoints.push({
    longitude: last.longitude,
    latitude: last.latitude,
    height: last.height || 0
  })

  return sampledPoints
}

async function buildSurfacePathPoints(points, samplesPerSegment = FINAL_PATH_SAMPLES_PER_SEGMENT) {
  if (!Array.isArray(points) || points.length === 0) return []
  if (points.length === 1) {
    const sampledPoints = await sampleSurfaceHeights(points)
    return sampledPoints.map(point => ({
      ...point,
      cartesian: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, point.height)
    }))
  }

  const surfacePathPoints = []

  for (let i = 0; i < points.length - 1; i++) {
    const segmentPoints = await buildSurfaceSegmentPoints(
      points[i],
      points[i + 1],
      samplesPerSegment
    )

    if (i === 0) {
      surfacePathPoints.push(...segmentPoints)
    } else {
      surfacePathPoints.push(...segmentPoints.slice(1))
    }
  }

  return surfacePathPoints
}

async function buildSurfaceSegmentPoints(startPoint, endPoint, samplesPerSegment) {
  const segmentSignature = `${createSegmentSignature(startPoint, endPoint)}|${samplesPerSegment}`
  const cachedSegment = cachedSurfaceSegments.get(segmentSignature)
  if (cachedSegment?.length) {
    return cachedSegment
  }

  const segmentSamples = getAdaptiveSampleCount(startPoint, endPoint, samplesPerSegment)
  const interpolatedPoints = buildInterpolatedPathPoints([startPoint, endPoint], segmentSamples)
  const sampledPoints = await sampleSurfaceHeights(interpolatedPoints)
  const surfaceSegmentPoints = sampledPoints.map(point => ({
    ...point,
    cartesian: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, point.height)
  }))

  cachedSurfaceSegments.set(segmentSignature, surfaceSegmentPoints)
  return surfaceSegmentPoints
}

async function ensureSurfacePathPoints(points, samplesPerSegment = FINAL_PATH_SAMPLES_PER_SEGMENT) {
  const signature = createPathSignature(points, samplesPerSegment)
  if (cachedPathSignature === signature && cachedSurfacePathPoints.length > 0) {
    return cachedSurfacePathPoints
  }

  if (canAppendLatestSegment(points) && cachedSurfacePathPoints.length > 0) {
    const latestSegmentPoints = await buildSurfaceSegmentPoints(
      points[points.length - 2],
      points[points.length - 1],
      samplesPerSegment
    )
    cachedSurfacePathPoints = cachedSurfacePathPoints.concat(latestSegmentPoints.slice(1))
    cachedSourcePathPoints = points.map(point => ({ ...point }))
    cachedPathSignature = signature
    return cachedSurfacePathPoints
  }

  const surfacePoints = await buildSurfacePathPoints(points, samplesPerSegment)
  cachedSurfacePathPoints = surfacePoints
  cachedSourcePathPoints = points.map(point => ({ ...point }))
  cachedPathSignature = signature
  return surfacePoints
}

async function updatePathLine() {
  if (pathPoints.value.length < 2) return

  const buildVersion = ++pathLineBuildVersion
  const positions = (
    await ensureSurfacePathPoints(pathPoints.value, FINAL_PATH_SAMPLES_PER_SEGMENT)
  ).map(p => liftCartesianAboveSurface(p.cartesian))

  if (buildVersion !== pathLineBuildVersion) return

  if (!lineEntity) {
    lineEntity = props.viewer.entities.add({
      polyline: {
        positions: positions,
        width: 4,
        material: Cesium.Color.CYAN,
        clampToGround: false,
        arcType: Cesium.ArcType.NONE
      }
    })
    return
  }

  lineEntity.polyline.positions = positions
}

function schedulePreviewLineUpdate(screenPosition) {
  pendingPreviewScreenPosition = screenPosition
  if (previewFrameRequestId !== null) return

  previewFrameRequestId = requestAnimationFrame(() => {
    previewFrameRequestId = null
    if (pendingPreviewScreenPosition) {
      updatePreviewLine(pendingPreviewScreenPosition)
      pendingPreviewScreenPosition = null
    }
  })
}

function updatePreviewLine(screenPosition) {
  if (pathPoints.value.length === 0) return

  // 使用相同的拾取逻辑
  const position = pickPosition(screenPosition)

  if (position) {
    const cartographic = Cesium.Cartographic.fromCartesian(position)
    const previewPoint = {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
      cartesian: position
    }
    const previewPositions = buildInterpolatedPathPoints(
      [pathPoints.value[pathPoints.value.length - 1], previewPoint],
      PREVIEW_PATH_SAMPLES_PER_SEGMENT
    ).map(p =>
      liftCartesianAboveSurface(
        Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.height),
        0.2
      )
    )

    if (!previewLineEntity) {
      previewLineEntity = props.viewer.entities.add({
        polyline: {
          positions: previewPositions,
          width: 3,
          material: Cesium.Color.YELLOW.withAlpha(0.7),
          clampToGround: false,
          arcType: Cesium.ArcType.NONE
        }
      })
    } else {
      previewLineEntity.polyline.positions = previewPositions
    }

    showCursorIndicator(position)
  } else {
    hideCursorIndicator()
  }
}

function showCursorIndicator(position) {
  if (cursorIndicatorEntity) {
    cursorIndicatorEntity.position = position
    cursorIndicatorEntity.show = true
  } else {
    cursorIndicatorEntity = props.viewer.entities.add({
      position,
      point: {
        pixelSize: 10,
        color: Cesium.Color.GREEN.withAlpha(0.8),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      show: true
    })
  }
}

function hideCursorIndicator() {
  if (cursorIndicatorEntity) cursorIndicatorEntity.show = false
}

function clearPath() {
  pathPoints.value = []
  clearVisualization()
  selectedPathIndex.value = -1
  editingPathIndex.value = -1
}

function selectPath(index) {
  selectedPathIndex.value = index
  editingPathIndex.value = index
  const path = savedPaths.value[index]
  if (path) {
    pathPoints.value = [...path.points]
    isDrawing.value = false
    visualizePath()
    emit('path-updated', path)
  }
}

function deletePath(index) {
  const path = savedPaths.value[index]
  if (path?._dbId) {
    deleteRouteFromDb(path._dbId).catch(() => {})
  }
  savedPaths.value.splice(index, 1)
  if (selectedPathIndex.value === index) {
    selectedPathIndex.value = -1
    editingPathIndex.value = -1
    clearPath()
  } else if (selectedPathIndex.value > index) {
    selectedPathIndex.value--
    if (editingPathIndex.value > index) editingPathIndex.value--
  }
  saveAllPaths(savedPaths.value)
}

function setCurrentAsDefault() {
  if (pathPoints.value.length < 2 && !hasDefaultRoute.value) return

  savedPaths.value.forEach(p => {
    p.isDefault = false
  })

  const defaultPoints = pathPoints.value.length >= 2 ? [...pathPoints.value] : []

  if (pathPoints.value.length >= 2) {
    const existingIndex = savedPaths.value.findIndex(p => p.name === '默认矿卡路线')
    if (existingIndex >= 0) {
      savedPaths.value[existingIndex].points = defaultPoints
      savedPaths.value[existingIndex].createdAt = new Date().toLocaleString()
      savedPaths.value[existingIndex].isDefault = true
    } else {
      savedPaths.value.unshift({
        name: '默认矿卡路线',
        points: defaultPoints,
        createdAt: new Date().toLocaleString(),
        isDefault: true
      })
    }
  }

  // 保存到数据库
  saveDefaultRouteToDb(
    '默认矿卡路线',
    defaultPoints.length >= 2
      ? defaultPoints
      : savedPaths.value.find(p => p.isDefault)?.points || []
  ).catch(() => {})
  saveDefaultRoute({
    name: '默认矿卡路线',
    points:
      defaultPoints.length >= 2
        ? defaultPoints
        : savedPaths.value.find(p => p.isDefault)?.points || []
  })
  saveAllPaths(savedPaths.value)
  emit('default-route-set', {
    name: '默认矿卡路线',
    points: defaultPoints
  })
}

function setSavedPathAsDefault(index) {
  const path = savedPaths.value[index]
  if (!path || path.points.length < 2) return

  savedPaths.value.forEach(p => {
    p.isDefault = false
  })
  path.isDefault = true

  pathPoints.value = [...path.points]
  selectedPathIndex.value = index
  editingPathIndex.value = index

  // 保存到数据库
  if (path._dbId) {
    setRouteAsDefaultInDb(path._dbId).catch(() => {})
  }
  saveDefaultRouteToDb(path.name, path.points).catch(() => {})
  saveDefaultRoute({ name: path.name, points: path.points })
  saveAllPaths(savedPaths.value)
  visualizePath()
  emit('default-route-set', { name: path.name, points: [...path.points] })
}

function visualizePath() {
  clearVisualization()
  void updatePathLine()
}

async function applyToTrucks() {
  if (pathPoints.value.length < 2) return
  const appliedPoints = await ensureSurfacePathPoints(
    pathPoints.value,
    FINAL_PATH_SAMPLES_PER_SEGMENT
  )
  pathPoints.value = appliedPoints
  cachedSurfacePathPoints = appliedPoints
  cachedSourcePathPoints = appliedPoints.map(p => ({ ...p }))
  cachedPathSignature = createPathSignature(appliedPoints, FINAL_PATH_SAMPLES_PER_SEGMENT)
  if (lineEntity)
    lineEntity.polyline.positions = appliedPoints.map(p => liftCartesianAboveSurface(p.cartesian))
  pointEntities.forEach(e => props.viewer.entities.remove(e))
  pointEntities = []
  emit('path-applied', {
    name:
      selectedPathIndex.value >= 0 ? savedPaths.value[selectedPathIndex.value].name : '自定义路径',
    points: appliedPoints.map(p => ({
      longitude: p.longitude,
      latitude: p.latitude,
      height: p.height,
      cartesian: [p.cartesian.x, p.cartesian.y, p.cartesian.z]
    }))
  })
}
</script>
