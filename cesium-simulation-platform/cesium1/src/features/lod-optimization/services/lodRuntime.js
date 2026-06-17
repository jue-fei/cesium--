import * as Cesium from 'cesium'
import { warn } from '@/utils/errorHandler.js'

// ---- 导出：十级 LOD 阶段定义（单一数据源） ----
export const LOD_STAGE_DEFINITIONS = [
  { key: 's0', label: 'S0 极粗', color: new Cesium.Color(0.88, 0.12, 0.1, 0.7), score: 0 },
  { key: 's1', label: 'S1 超粗', color: new Cesium.Color(0.91, 0.3, 0.14, 0.67), score: 1 },
  { key: 's2', label: 'S2 粗略', color: new Cesium.Color(0.94, 0.48, 0.17, 0.64), score: 2 },
  { key: 's3', label: 'S3 较粗', color: new Cesium.Color(0.97, 0.64, 0.19, 0.61), score: 3 },
  { key: 's4', label: 'S4 过渡', color: new Cesium.Color(0.96, 0.76, 0.22, 0.58), score: 4 },
  { key: 's5', label: 'S5 中等', color: new Cesium.Color(0.62, 0.84, 0.28, 0.55), score: 5 },
  { key: 's6', label: 'S6 较细', color: new Cesium.Color(0.3, 0.8, 0.36, 0.52), score: 6 },
  { key: 's7', label: 'S7 精细', color: new Cesium.Color(0.18, 0.71, 0.9, 0.49), score: 7 },
  { key: 's8', label: 'S8 高精', color: new Cesium.Color(0.28, 0.48, 0.95, 0.46), score: 8 },
  { key: 's9', label: 'S9 超精', color: new Cesium.Color(0.5, 0.3, 0.95, 0.43), score: 9 }
]

export function cesiumColorToHex(color) {
  const r = Math.round(color.red * 255)
    .toString(16)
    .padStart(2, '0')
  const g = Math.round(color.green * 255)
    .toString(16)
    .padStart(2, '0')
  const b = Math.round(color.blue * 255)
    .toString(16)
    .padStart(2, '0')
  return `#${r}${g}${b}`
}

// ---- 内部常量 ----
const EMPTY_STAGE_COUNTS = Object.freeze(
  LOD_STAGE_DEFINITIONS.reduce((acc, stage) => {
    acc[stage.key] = 0
    return acc
  }, {})
)

function createEmptyStageCounts() {
  return { ...EMPTY_STAGE_COUNTS }
}

function cloneColor(color) {
  return new Cesium.Color(color.red, color.green, color.blue, color.alpha)
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function getTileScreenSpaceError(tile) {
  const tileSse = Number(tile?._screenSpaceError) || 0
  if (tileSse > 0) return tileSse
  const parentSse = Number(tile?.parent?._screenSpaceError) || 0
  return parentSse > 0 ? parentSse * 0.5 : 0
}

function detectTileContentType(tile) {
  const content = tile?.content
  if (!content) return 'empty'
  const name = content.constructor?.name || ''
  if (name.includes('Batched3DModel')) return 'b3dm'
  if (name.includes('Instanced3DModel')) return 'i3dm'
  if (name.includes('PointCloud')) return 'pnts'
  if (name.includes('Composite')) return 'cmpt'
  const url = String(content._url || content.url || '')
  if (url.endsWith('.b3dm')) return 'b3dm'
  if (url.endsWith('.i3dm')) return 'i3dm'
  if (url.endsWith('.pnts')) return 'pnts'
  if (url.endsWith('.cmpt')) return 'cmpt'
  return 'tile'
}

function buildVisibleTileMetric(tile, tileset) {
  const rootGeometricError = Math.max(1, Number(tileset?.root?.geometricError) || 1)
  const geometricError = Math.max(0, Number(tile?.geometricError) || 0)
  return {
    tile,
    geometricError,
    geometricRatio: geometricError / rootGeometricError,
    screenSpaceError: getTileScreenSpaceError(tile),
    depth: Math.max(0, Number(tile?._depth) || 0),
    distanceToCamera: Math.max(0, Number(tile?._distanceToCamera) || 0),
    contentReady: Boolean(tile?.contentReady),
    featuresLength: Number(tile?.content?.featuresLength) || 0,
    contentType: detectTileContentType(tile)
  }
}

// ---- 阶段分配 ----
function getStageByIndex(index) {
  return LOD_STAGE_DEFINITIONS[Math.max(0, Math.min(LOD_STAGE_DEFINITIONS.length - 1, index))]
}

function assignStagesForVisibleTiles(metrics, tileset) {
  const stageCounts = createEmptyStageCounts()
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return { stageCounts, assignments: [] }
  }

  const maxDepth = metrics.reduce((max, item) => Math.max(max, item.depth), 0)
  const maxDistance = metrics.reduce((max, item) => Math.max(max, item.distanceToCamera), 0)
  const sseReference = Math.max(
    1,
    Number(tileset?.memoryAdjustedScreenSpaceError) || 0,
    Number(tileset?.maximumScreenSpaceError) || 0
  )
  const sseUpperBound = Math.max(sseReference * 4, 4)
  const sseDenominator = Math.log2(sseUpperBound + 1)

  const scored = metrics.map(metric => {
    const depthNorm = maxDepth > 0 ? metric.depth / maxDepth : 1
    const distanceNorm = maxDistance > 0 ? 1 - metric.distanceToCamera / maxDistance : 1
    const geometryNorm = 1 - clamp01(metric.geometricRatio)
    const sseNorm =
      sseDenominator > 0 ? 1 - clamp01(Math.log2(metric.screenSpaceError + 1) / sseDenominator) : 1
    const score = clamp01(
      depthNorm * 0.38 + sseNorm * 0.34 + geometryNorm * 0.18 + distanceNorm * 0.1
    )
    return {
      ...metric,
      depthNorm,
      distanceNorm,
      geometryNorm,
      sseNorm,
      score
    }
  })

  const ordered = [...scored].sort((a, b) => a.score - b.score)
  const maxRank = Math.max(1, ordered.length - 1)
  const stageCount = LOD_STAGE_DEFINITIONS.length
  const assignments = ordered.map((item, index) => {
    const rankPercentile = ordered.length === 1 ? 1 : index / maxRank
    const combinedScore = clamp01(item.score * 0.65 + rankPercentile * 0.35)
    const stageIndex = Math.min(stageCount - 1, Math.floor(combinedScore * stageCount))
    const stage = getStageByIndex(stageIndex)
    stageCounts[stage.key] = (stageCounts[stage.key] || 0) + 1
    return {
      ...item,
      stage,
      combinedScore
    }
  })

  return { stageCounts, assignments }
}

// ---- 调试颜色 ----
function applyTileDebugColor(tile, color) {
  if (!tile?.content) return
  if (typeof tile.content.applyDebugSettings === 'function') {
    tile.content.applyDebugSettings(true, cloneColor(color))
    tile.__debugColorCleared = false
    return
  }
  const featuresLength = Number(tile.content.featuresLength) || 0
  for (let i = 0; i < featuresLength; i++) {
    const feature = tile.content.getFeature(i)
    if (feature?.color) {
      feature.color = cloneColor(color)
    }
  }
}

function clearTileDebugColor(tile) {
  if (!tile?.content) return
  if (typeof tile.content.applyDebugSettings === 'function') {
    // 避免每帧重复调用，仅在需要时清除
    if (!tile.__debugColorCleared) {
      tile.content.applyDebugSettings(false, Cesium.Color.WHITE)
      tile.__debugColorCleared = true
    }
    return
  }
  // 非 b3dm 情况下，不直接重置所有 feature.color，以免覆盖用户自定义样式（透明度/显隐）
}

function normalizeVisualizationMode(mode) {
  return ['off', 'stage_color', 'stage_wireframe', 'random_tiles', 'random_wireframe'].includes(
    mode
  )
    ? mode
    : 'off'
}

function applyVisualizationModeToTile(tile, tileset, mode) {
  if (!tile?.content) return
  if (mode === 'off') {
    clearTileDebugColor(tile)
    return
  }
  if (mode === 'random_tiles' || mode === 'random_wireframe') {
    clearTileDebugColor(tile)
    return
  }
  const stage = tile.__lodAssignedStage || getStageByIndex(0)
  applyTileDebugColor(tile, stage.color)
}

// ---- 阶段汇总 ----
function buildStageSummary(stageCounts) {
  let dominantKey = 's0'
  let dominantCount = -1
  let weightedScore = 0
  let total = 0
  for (const stage of LOD_STAGE_DEFINITIONS) {
    const count = Number(stageCounts?.[stage.key]) || 0
    total += count
    weightedScore += count * stage.score
    if (count > dominantCount) {
      dominantCount = count
      dominantKey = stage.key
    }
  }
  const dominantStage =
    LOD_STAGE_DEFINITIONS.find(stage => stage.key === dominantKey) || LOD_STAGE_DEFINITIONS[0]
  const avgStageScore = total > 0 ? weightedScore / total : 0
  const maxScore = LOD_STAGE_DEFINITIONS.length - 1
  return {
    dominantLodStage: dominantStage.label,
    lodStageScore: maxScore > 0 ? Math.round((avgStageScore / maxScore) * 100) : 0,
    stageCounts: { ...stageCounts }
  }
}

// ---- 瓦片详情序列化 ----
function serializeTileDetail(item, rank, total) {
  const tile = item.tile
  return {
    tileId: tile?._debugId ? `tile_${tile._debugId}` : `tile_${rank}`,
    rank,
    totalTiles: total,
    geometricError: Math.round(item.geometricError * 100) / 100,
    screenSpaceError: Math.round(item.screenSpaceError * 10000) / 10000,
    depth: item.depth,
    distanceToCamera: Math.round(item.distanceToCamera * 10) / 10,
    geometricRatio: Math.round(item.geometricRatio * 10000) / 10000,
    contentReady: item.contentReady || false,
    featuresLength: item.featuresLength || 0,
    contentType: item.contentType || 'unknown',
    score: Math.round(item.score * 1000) / 1000,
    combinedScore: Math.round(item.combinedScore * 1000) / 1000,
    stageLabel: item.stage?.label || 'S0',
    stageKey: item.stage?.key || 's0'
  }
}

function buildTileDetailList(assignments, limit = 20) {
  if (!Array.isArray(assignments) || assignments.length === 0) return []
  const sorted = [...assignments].sort((a, b) => a.score - b.score)
  const total = sorted.length
  if (total <= limit * 2) {
    return sorted.map((item, idx) => serializeTileDetail(item, idx, total))
  }
  const halfLimit = Math.min(limit, Math.floor(total / 2))
  const coarse = sorted.slice(0, halfLimit)
  const fine = sorted.slice(-halfLimit)
  const seen = new Set()
  const result = []
  for (let i = 0; i < Math.max(coarse.length, fine.length); i++) {
    if (i < coarse.length && !seen.has(coarse[i].tile?._debugId)) {
      seen.add(coarse[i].tile?._debugId)
      result.push(serializeTileDetail(coarse[i], i, total))
    }
    if (i < fine.length && !seen.has(fine[i].tile?._debugId)) {
      seen.add(fine[i].tile?._debugId)
      result.push(serializeTileDetail(fine[i], total - halfLimit + i, total))
    }
  }
  return result
}

// ---- 分析数据构建 ----
function buildGeometricErrorDistribution(metrics, bucketCount = 10) {
  if (!Array.isArray(metrics) || metrics.length === 0) return []
  const errors = metrics.map(m => m.geometricError).filter(e => e > 0)
  if (errors.length === 0) return []
  const min = Math.min(...errors)
  const max = Math.max(...errors)
  if (max <= min) {
    return [
      {
        rangeMin: Math.round(min * 100) / 100,
        rangeMax: Math.round(max * 100) / 100,
        count: errors.length
      }
    ]
  }
  const bucketWidth = (max - min) / bucketCount
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    rangeMin: Math.round((min + i * bucketWidth) * 100) / 100,
    rangeMax: Math.round((min + (i + 1) * bucketWidth) * 100) / 100,
    count: 0
  }))
  for (const e of errors) {
    const idx = Math.min(bucketCount - 1, Math.floor((e - min) / bucketWidth))
    buckets[idx].count++
  }
  return buckets
}

function buildSseRangeSummary(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return { min: 0, max: 0, avg: 0 }
  }
  const values = metrics.map(m => m.screenSpaceError)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  return {
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    avg: Math.round(avg * 100) / 100
  }
}

function buildPerStageStats(assignments) {
  const stats = {}
  for (const def of LOD_STAGE_DEFINITIONS) {
    stats[def.key] = { count: 0, totalGeometricError: 0, avgGeometricError: 0 }
  }
  for (const item of assignments) {
    const key = item.stage?.key || 's0'
    if (stats[key]) {
      stats[key].count++
      stats[key].totalGeometricError += item.geometricError
    }
  }
  for (const def of LOD_STAGE_DEFINITIONS) {
    const s = stats[def.key]
    s.avgGeometricError = s.count > 0 ? Math.round(s.totalGeometricError / s.count) : 0
  }
  return stats
}

function buildStageTransitionInfo(assignments) {
  const threshold = 0.08
  const stageCount = LOD_STAGE_DEFINITIONS.length
  const nearBoundaries = []
  for (const item of assignments) {
    const fracInStage = (item.combinedScore * stageCount) % 1
    if (fracInStage < threshold || fracInStage > 1 - threshold) {
      nearBoundaries.push({
        tileId: item.tile?._debugId
          ? `tile_${item.tile._debugId}`
          : `tile_${nearBoundaries.length}`,
        stageKey: item.stage?.key,
        combinedScore: Math.round(item.combinedScore * 1000) / 1000,
        nearNextStage: fracInStage > 1 - threshold
      })
    }
  }
  return nearBoundaries.slice(0, 10)
}

// ---- 运行时状态工厂 ----
export function createLodRuntimeState() {
  return {
    pendingRequests: 0,
    tilesProcessing: 0,
    initialTilesLoaded: false,
    allTilesLoaded: false,
    selectedTiles: 0,
    visitedTiles: 0,
    commands: 0,
    contentReadyTiles: 0,
    totalTiles: 0,
    featuresSelected: 0,
    pointsSelected: 0,
    trianglesSelected: 0,
    stageCounts: createEmptyStageCounts(),
    dominantLodStage: 'S0 极粗',
    lodStageScore: 0,
    debugColorizeTiles: false,
    debugShowGeometricError: false,
    debugShowRenderingStatistics: false,
    debugShowMemoryUsage: false,
    visualizationMode: 'off',
    lastUpdatedMs: 0,
    // 新增：瓦片级详细信息
    tileDetailList: [],
    geometricErrorDistribution: [],
    screenSpaceErrorRange: { min: 0, max: 0, avg: 0 },
    perStageStats: {},
    stageTransitionInfo: []
  }
}

function readTilesetStatisticsSnapshot(tileset) {
  const stats = tileset?.statistics || {}
  return {
    selectedTiles: Number(stats.selected) || 0,
    visitedTiles: Number(stats.visited) || 0,
    commands: Number(stats.numberOfCommands) || 0,
    contentReadyTiles: Number(stats.numberOfTilesWithContentReady) || 0,
    totalTiles: Number(stats.numberOfTilesTotal) || 0,
    featuresSelected: Number(stats.numberOfFeaturesSelected) || 0,
    pointsSelected: Number(stats.numberOfPointsSelected) || 0,
    trianglesSelected: Number(stats.numberOfTrianglesSelected) || 0,
    debugColorizeTiles: Boolean(tileset?.debugColorizeTiles),
    debugShowGeometricError: Boolean(tileset?.debugShowGeometricError),
    debugShowRenderingStatistics: Boolean(tileset?.debugShowRenderingStatistics),
    debugShowMemoryUsage: Boolean(tileset?.debugShowMemoryUsage)
  }
}

// ---- 事件绑定 ----
export function bindTilesetLodRuntimeEvents(viewer, tileset, onPatch) {
  if (!tileset) return () => null

  const emit = patch => {
    if (typeof onPatch === 'function') onPatch(patch)
  }

  let frameStageCounts = createEmptyStageCounts()
  let visibleTileMetrics = []
  let stageResult = { stageCounts: createEmptyStageCounts(), assignments: [] }
  let lastSnapshotMs = 0
  const SNAPSHOT_INTERVAL_MS = 120

  const buildFullFrameSnapshot = () => ({
    ...readTilesetStatisticsSnapshot(tileset),
    ...buildStageSummary(frameStageCounts),
    tileDetailList: buildTileDetailList(stageResult.assignments),
    geometricErrorDistribution: buildGeometricErrorDistribution(visibleTileMetrics),
    screenSpaceErrorRange: buildSseRangeSummary(visibleTileMetrics),
    perStageStats: buildPerStageStats(stageResult.assignments),
    stageTransitionInfo: buildStageTransitionInfo(stageResult.assignments)
  })

  const emitSnapshot = force => {
    const now = Date.now()
    if (!force && now - lastSnapshotMs < SNAPSHOT_INTERVAL_MS) return
    lastSnapshotMs = now
    emit(buildFullFrameSnapshot())
  }

  const onLoadProgress = (pendingRequests, tilesProcessing) => {
    emit({
      pendingRequests: Number(pendingRequests) || 0,
      tilesProcessing: Number(tilesProcessing) || 0,
      ...buildFullFrameSnapshot()
    })
  }

  const onInitialTilesLoaded = () => {
    emit({
      initialTilesLoaded: true,
      ...buildFullFrameSnapshot()
    })
  }

  const onAllTilesLoaded = () => {
    emit({
      allTilesLoaded: true,
      ...buildFullFrameSnapshot()
    })
  }

  const onPreRender = () => {
    frameStageCounts = createEmptyStageCounts()
    visibleTileMetrics = []
  }

  const onTileVisible = tile => {
    visibleTileMetrics.push(buildVisibleTileMetric(tile, tileset))
  }

  const onPostRender = () => {
    const mode = normalizeVisualizationMode(tileset.__lodVisualizationMode)
    stageResult = assignStagesForVisibleTiles(visibleTileMetrics, tileset)
    frameStageCounts = stageResult.stageCounts
    for (const item of stageResult.assignments) {
      item.tile.__lodAssignedStage = item.stage
      applyVisualizationModeToTile(item.tile, tileset, mode)
    }
    tileset.debugColorizeTiles = mode === 'random_tiles' || mode === 'random_wireframe'
    tileset.debugWireframe = mode === 'stage_wireframe' || mode === 'random_wireframe'
    emitSnapshot(false)
  }

  tileset.loadProgress.addEventListener(onLoadProgress)
  tileset.initialTilesLoaded.addEventListener(onInitialTilesLoaded)
  tileset.allTilesLoaded.addEventListener(onAllTilesLoaded)
  tileset.tileVisible.addEventListener(onTileVisible)
  const removePreRenderListener = viewer?.scene?.preRender?.addEventListener(onPreRender)
  const removePostRenderListener = viewer?.scene?.postRender?.addEventListener(onPostRender)
  emitSnapshot(true)

  return () => {
    try {
      tileset.loadProgress.removeEventListener(onLoadProgress)
      tileset.initialTilesLoaded.removeEventListener(onInitialTilesLoaded)
      tileset.allTilesLoaded.removeEventListener(onAllTilesLoaded)
      tileset.tileVisible.removeEventListener(onTileVisible)
      tileset.debugColorizeTiles = false
      tileset.debugWireframe = false
      if (typeof removePreRenderListener === 'function') removePreRenderListener()
      if (typeof removePostRenderListener === 'function') removePostRenderListener()
    } catch (e) {
      warn('lod', 'lodRuntime', e)
    }
  }
}

// ---- 配置应用 ----
const RUNTIME_UNSAFE_PROPS = ['cacheBytes', 'maximumCacheOverflowBytes']

export function applyLodConfigToTileset(tileset, config, requestRender) {
  if (!tileset || !config) return false
  let changed = false
  Object.keys(config).forEach(prop => {
    if (RUNTIME_UNSAFE_PROPS.includes(prop)) return
    if (prop in tileset && typeof tileset[prop] !== 'function') {
      try {
        if (tileset[prop] === config[prop]) return
        tileset[prop] = config[prop]
        changed = true
      } catch (e) {
        // Ignore runtime-incompatible property assignments on older Cesium builds.
      }
    }
  })
  if (changed && typeof requestRender === 'function') requestRender()
  return changed
}

export function getTilesetMemoryUsageBytes(tileset) {
  return tileset ? Number(tileset.totalMemoryUsageInBytes) || 0 : 0
}
