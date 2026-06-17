import * as Cesium from 'cesium'
import { MINING_PIT_1_POSITION, MINING_PIT_2_POSITION } from '../types/monitoringDefaults.js'
import {
  appendHistoryEntry,
  calculateGreatCircleDistance,
  findNearestHistoryPoint,
  getHistoryTimeRange,
  getTruckStatesAtTime,
  isValidRealtimeTruckData,
  normalizeRealtimeTruckData
} from './realtimeDataCore.js'
import {
  createCustomPathState,
  getCurrentCustomPathPoints,
  getHeightFromPathPoints,
  getPositionOnCustomPath,
  sampleGroundPath
} from './realtimePathHelpers.js'
import {
  buildSurfacePoolCandidates,
  findNearestSurfacePoint,
  isDuplicateSurfacePoint,
  selectResolvedSurfacePool
} from './siteSurfaceCore.js'
import { createSiteSurfaceResolver } from './siteSurfaceResolver.js'
import { resolveGroundHeight } from './groundHeightSampling.js'
import { resolveMiningSites } from './miningSiteInitialization.js'
import { logger } from '@/utils/logger.js'

export let MINING_SITE_1 = null
export let MINING_SITE_2 = null

// 采场半径（道路距离中心的距离，单位：米）
const SITE_RADIUS = 50
const VEHICLE_SURFACE_OFFSET = 0.5
const SITE_RADIUS_RATIO = 0.05
const INITIAL_SITE_RADIUS_RATIO = 0.2
const MIN_SITE_RADIUS = 18
const MAX_SITE_RADIUS = 65
const MIN_INITIAL_RADIUS = 4
const MAX_INITIAL_RADIUS = 12
const FEATURE_SURFACE_SEARCH_STEP = 2
const FEATURE_SURFACE_SEARCH_RINGS = 4
const FEATURE_POOL_MIN_POINTS = 12
const FEATURE_POOL_ANGLE_STEPS = 16
const FEATURE_POOL_TOP_BAND = 6

const TILESET_RECREATE_DEBOUNCE_MS = 200

export class RealtimeDataEngine {
  constructor() {
    this.trucks = new Map()
    this.listeners = []
    this.dataSource = 'external_realtime'
    this.externalDataHandler = null
    this.isPlaying = false
    this.currentTimestamp = Date.now()
    this.playbackSpeed = 1
    this.trajectoryHistory = new Map()
    this.tileset = null
    this.viewer = null
    this.originalModelMatrix = null
    this.customPathPoints = null
    this.customPathTotalLength = 0
    this.sampledGroundPath = null
    this.siteSurfacePointCache = new Map()
    this._tilesetSwitchTimer = null
    this._lastTilesetModelMatrix = null
    this.siteSurfaceResolver = createSiteSurfaceResolver({
      getViewer: () => this.viewer,
      transformOriginalPointToCurrent: cartesian => this.transformOriginalPointToCurrent(cartesian),
      cartesianToWorldPosition: (cartesian, fallbackHeight) =>
        this.cartesianToWorldPosition(cartesian, fallbackHeight),
      getModelScaleFactor: () => this.getModelScaleFactor(),
      buildFeatureSurfacePointPool: site => this.buildFeatureSurfacePointPool(site),
      getNearestSurfacePointFromPool: (site, eastMeters, northMeters) =>
        this.getNearestSurfacePointFromPool(site, eastMeters, northMeters),
      constants: {
        vehicleSurfaceOffset: VEHICLE_SURFACE_OFFSET,
        siteRadius: SITE_RADIUS,
        siteRadiusRatio: SITE_RADIUS_RATIO,
        initialSiteRadiusRatio: INITIAL_SITE_RADIUS_RATIO,
        minSiteRadius: MIN_SITE_RADIUS,
        maxSiteRadius: MAX_SITE_RADIUS,
        minInitialRadius: MIN_INITIAL_RADIUS,
        maxInitialRadius: MAX_INITIAL_RADIUS,
        featureSurfaceSearchStep: FEATURE_SURFACE_SEARCH_STEP,
        featureSurfaceSearchRings: FEATURE_SURFACE_SEARCH_RINGS
      }
    })
  }

  setOriginalModelMatrix(matrix) {
    this.originalModelMatrix = matrix ? Cesium.Matrix4.clone(matrix) : null
  }

  projectSiteToSurface(site) {
    if (!site) return site
    const fallbackHeight = Number(site.height) || 0
    if (!this.viewer) {
      return {
        ...site,
        height: fallbackHeight
      }
    }

    return {
      ...site,
      height: this.sampleGroundHeight(site.longitude, site.latitude, fallbackHeight)
    }
  }

  getModelScaleFactor() {
    if (!this.tileset || !this.originalModelMatrix) return 1

    const currentScale = Cesium.Matrix4.getScale(this.tileset.modelMatrix, new Cesium.Cartesian3())
    const originalScale = Cesium.Matrix4.getScale(this.originalModelMatrix, new Cesium.Cartesian3())
    const currentAverage = (currentScale.x + currentScale.y + currentScale.z) / 3
    const originalAverage = (originalScale.x + originalScale.y + originalScale.z) / 3

    if (
      !Number.isFinite(currentAverage) ||
      !Number.isFinite(originalAverage) ||
      originalAverage === 0
    ) {
      return 1
    }

    return currentAverage / originalAverage
  }

  getDeltaModelMatrix() {
    if (!this.tileset || !this.originalModelMatrix) {
      return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
    }

    const inverseOriginalMatrix = Cesium.Matrix4.inverse(
      this.originalModelMatrix,
      new Cesium.Matrix4()
    )

    return Cesium.Matrix4.multiply(
      this.tileset.modelMatrix,
      inverseOriginalMatrix,
      new Cesium.Matrix4()
    )
  }

  transformOriginalPointToCurrent(cartesian) {
    const basePoint = Array.isArray(cartesian)
      ? Cesium.Cartesian3.fromArray(cartesian)
      : Cesium.Cartesian3.clone(cartesian)

    if (!basePoint) return null
    if (!this.tileset || !this.originalModelMatrix) {
      return basePoint
    }

    return Cesium.Matrix4.multiplyByPoint(
      this.getDeltaModelMatrix(),
      basePoint,
      new Cesium.Cartesian3()
    )
  }

  transformCurrentPointToOriginal(cartesian) {
    const basePoint = Array.isArray(cartesian)
      ? Cesium.Cartesian3.fromArray(cartesian)
      : Cesium.Cartesian3.clone(cartesian)

    if (!basePoint) return null
    if (!this.tileset || !this.originalModelMatrix) {
      return basePoint
    }

    const inverseDeltaMatrix = Cesium.Matrix4.inverse(
      this.getDeltaModelMatrix(),
      new Cesium.Matrix4()
    )
    return Cesium.Matrix4.multiplyByPoint(inverseDeltaMatrix, basePoint, new Cesium.Cartesian3())
  }

  clearSiteSurfacePointCache() {
    this.siteSurfacePointCache.clear()
  }

  getFeatureId(target) {
    return this.siteSurfaceResolver.getFeatureId(target)
  }

  snapCartesianToFeatureSurface(featureId, approximateCartesian) {
    return this.siteSurfaceResolver.snapCartesianToFeatureSurface(featureId, approximateCartesian)
  }

  cartesianToWorldPosition(cartesian, fallbackHeight = 0) {
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian)

    return {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      height: Number.isFinite(cartographic.height) ? cartographic.height : fallbackHeight
    }
  }

  buildFeatureSurfacePointPool(site) {
    if (!site?.featureId || !site?.originalFrameMatrix) {
      return []
    }

    const cacheKey = site.featureId
    const cachedPoints = this.siteSurfacePointCache.get(cacheKey)
    if (cachedPoints?.length) {
      return cachedPoints
    }

    const radiusMeters = Math.max(site.radius || SITE_RADIUS, site.initialPlacementRadius || 0, 8)
    const candidates = buildSurfacePoolCandidates(radiusMeters, FEATURE_POOL_ANGLE_STEPS)
    const uniquePoints = []

    for (const [eastMeters, northMeters] of candidates) {
      const hitCartesian = this.resolveSiteOffsetCartesian(site, eastMeters, northMeters, 0, {
        searchNearestSurface: true,
        useSurfacePool: false
      })

      if (!hitCartesian) continue

      const originalCartesian = this.transformCurrentPointToOriginal(hitCartesian)
      const worldPosition = this.cartesianToWorldPosition(hitCartesian, site.height || 0)
      if (isDuplicateSurfacePoint(uniquePoints, eastMeters, northMeters)) continue

      uniquePoints.push({
        eastMeters,
        northMeters,
        height: worldPosition.height,
        originalCartesian
      })
    }

    const resolvedPoints = selectResolvedSurfacePool(
      uniquePoints,
      FEATURE_POOL_TOP_BAND,
      FEATURE_POOL_MIN_POINTS
    )
    this.siteSurfacePointCache.set(cacheKey, resolvedPoints)
    return resolvedPoints
  }

  getNearestSurfacePointFromPool(site, eastMeters = 0, northMeters = 0) {
    const pool = this.buildFeatureSurfacePointPool(site)
    if (!pool.length) return null

    const nearestPoint = findNearestSurfacePoint(pool, eastMeters, northMeters)
    const currentCartesian = this.transformOriginalPointToCurrent(nearestPoint.originalCartesian)
    return {
      ...nearestPoint,
      currentCartesian
    }
  }

  transformMiningSpecCartesian(cartesian) {
    return this.transformOriginalPointToCurrent(cartesian)
  }

  buildMiningSiteFromSpec(spec, fallbackPosition) {
    return this.siteSurfaceResolver.buildMiningSiteFromSpec(spec, fallbackPosition)
  }

  getSiteSurfaceCartesian(site) {
    return this.siteSurfaceResolver.getSiteSurfaceCartesian(site)
  }

  resolveSiteOffsetCartesian(site, eastMeters = 0, northMeters = 0, upMeters = 0, options = {}) {
    return this.siteSurfaceResolver.resolveSiteOffsetCartesian(
      site,
      eastMeters,
      northMeters,
      upMeters,
      options
    )
  }

  resolveSiteOffsetWorldPosition(
    site,
    eastMeters = 0,
    northMeters = 0,
    upMeters = 0,
    options = {}
  ) {
    return this.siteSurfaceResolver.resolveSiteOffsetWorldPosition(
      site,
      eastMeters,
      northMeters,
      upMeters,
      options
    )
  }

  setCustomPath(pathPoints) {
    if (!pathPoints || pathPoints.length < 2) return false

    const pathState = createCustomPathState(pathPoints, currentCartesian =>
      this.transformCurrentPointToOriginal(currentCartesian)
    )
    this.customPathPoints = pathState.customPathPoints
    this.customPathTotalLength = pathState.customPathTotalLength
    this.samplePathOnGround(20)

    if (MINING_SITE_1 && MINING_SITE_2) {
      const currentPathPoints = this.getCurrentCustomPathPoints()
      const start = currentPathPoints[0],
        end = currentPathPoints[currentPathPoints.length - 1]
      Object.assign(MINING_SITE_1, start)
      Object.assign(MINING_SITE_2, end)
    }

    return true
  }

  calculateDistance(p1, p2) {
    return calculateGreatCircleDistance(p1, p2)
  }

  getPositionOnPath(progress) {
    return getPositionOnCustomPath({
      customPathPoints: this.customPathPoints,
      sampledGroundPath: this.sampledGroundPath,
      customPathTotalLength: this.customPathTotalLength,
      progress,
      transformOriginalPointToCurrent: originalCartesian =>
        this.transformOriginalPointToCurrent(originalCartesian),
      cartesianToWorldPosition: (cartesian, fallbackHeight) =>
        this.cartesianToWorldPosition(cartesian, fallbackHeight)
    })
  }

  samplePathOnGround(samplesPerSegment = 50) {
    if (!this.customPathPoints || this.customPathPoints.length < 2) {
      return
    }

    this.sampledGroundPath = sampleGroundPath(this.customPathPoints, samplesPerSegment)
  }

  getCurrentCustomPathPoints() {
    if (!this.customPathPoints || this.customPathPoints.length === 0) {
      return []
    }

    return getCurrentCustomPathPoints(
      this.customPathPoints,
      originalCartesian => this.transformOriginalPointToCurrent(originalCartesian),
      (cartesian, fallbackHeight) => this.cartesianToWorldPosition(cartesian, fallbackHeight)
    )
  }

  // 使用 Cesium 获取指定经纬度位置的地面高度 -> 针对 3D Tiles 模型优化
  sampleGroundHeight(longitude, latitude, defaultHeight = 0) {
    return resolveGroundHeight({
      viewer: this.viewer,
      hasTileset: !!this.tileset,
      longitude,
      latitude,
      defaultHeight,
      vehicleSurfaceOffset: VEHICLE_SURFACE_OFFSET,
      getHeightFromPathPoints: (targetLongitude, targetLatitude) =>
        this.getHeightFromPathPoints(targetLongitude, targetLatitude)
    })
  }

  getHeightFromPathPoints(longitude, latitude) {
    if (!this.customPathPoints || this.customPathPoints.length === 0) {
      return 0
    }

    return getHeightFromPathPoints(this.getCurrentCustomPathPoints(), longitude, latitude)
  }

  async getGroundHeightAsync(longitude, latitude) {
    const VEHICLE_OFFSET = 0.5

    try {
      if (this.viewer && this.viewer.terrainProvider) {
        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude)
        const positions = [cartographic]

        // 使用 sampleTerrainMostDetailed 获取最详细地形高度
        await Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, positions)

        const height = positions[0].height
        if (height !== undefined && height !== null) {
          return height + VEHICLE_OFFSET
        }
      }
    } catch (error) {
      // Terrain sampling can fail on some providers; fall back to sync sampling.
    }

    // 回退到同步方法
    return this.sampleGroundHeight(longitude, latitude)
  }

  init(options = {}) {
    this.initMiningSites()

    this.tileset = options.tileset || null
    this.viewer = options.viewer || null

    if (this.tileset && !this.originalModelMatrix) {
      this.originalModelMatrix = Cesium.Matrix4.clone(this.tileset.modelMatrix)
    }
  }

  initMiningSites() {
    const nextSites = resolveMiningSites({
      tileset: this.tileset,
      buildMiningSiteFromSpec: (spec, fallbackPosition) =>
        this.buildMiningSiteFromSpec(spec, fallbackPosition),
      defaultSite1Position: MINING_PIT_1_POSITION,
      defaultSite2Position: MINING_PIT_2_POSITION,
      currentSite1: MINING_SITE_1,
      currentSite2: MINING_SITE_2
    })
    MINING_SITE_1 = nextSites.site1
    MINING_SITE_2 = nextSites.site2
  }

  setTileset(tileset) {
    const tilesetChanged = this.tileset !== tileset
    this.tileset = tileset

    if (tileset && !this.originalModelMatrix) {
      this.originalModelMatrix = Cesium.Matrix4.clone(tileset.modelMatrix)
    }

    if (!tileset) return

    if (!tilesetChanged) {
      this.initMiningSites()
      return
    }

    this.clearSiteSurfacePointCache()
    this.initMiningSites()

    if (this._tilesetSwitchTimer) {
      clearTimeout(this._tilesetSwitchTimer)
    }

    this._tilesetSwitchTimer = setTimeout(() => {
      this._tilesetSwitchTimer = null

      if (this.viewer) {
        if (this.customPathPoints && this.customPathPoints.length >= 2) {
          this.samplePathOnGround(20)
        }
      }

      this._lastTilesetModelMatrix = tileset.modelMatrix
        ? Cesium.Matrix4.clone(tileset.modelMatrix)
        : null
    }, TILESET_RECREATE_DEBOUNCE_MS)
  }

  setViewer(viewer) {
    this.viewer = viewer

    if (this.customPathPoints && this.customPathPoints.length >= 2) {
      this.samplePathOnGround(20)
    }
  }

  getModelMatrix() {
    return this.tileset ? this.tileset.modelMatrix : Cesium.Matrix4.IDENTITY
  }

  validateData(data) {
    return isValidRealtimeTruckData(data)
  }

  processData(data) {
    const normalized = {
      ...data,
      truckId: data.truckId || data.truck_id,
      vehicleInfo: data.vehicleInfo || data.vehicle_info,
      mineralType: data.mineralType || data.mineral_type,
      driverInfo: data.driverInfo || data.driver_info
    }
    if (typeof normalized.phase === 'number' && !normalized.position) {
      const pathPosition = this.getPositionOnPath(normalized.phase)
      if (pathPosition) {
        normalized.position = pathPosition
      }
    }
    return normalizeRealtimeTruckData(normalized)
  }

  addToHistory(truckId, data) {
    appendHistoryEntry(this.trajectoryHistory, truckId, data)
  }

  getTruckStateAtTime(timestamp) {
    return getTruckStatesAtTime(this.trajectoryHistory, timestamp)
  }

  findNearestPoint(history, timestamp) {
    return findNearestHistoryPoint(history, timestamp)
  }

  subscribe(callback) {
    this.listeners.push(callback)
    return () => {
      const idx = this.listeners.indexOf(callback)
      if (idx > -1) this.listeners.splice(idx, 1)
    }
  }

  notifyListeners(data) {
    this.listeners.forEach(cb => {
      try {
        cb(data)
      } catch (e) {
        logger.error('realtime-data-engine', '监听器执行失败', null, e)
      }
    })
  }

  getAllTrucks() {
    return Array.from(this.trucks.values())
  }
  getTruck(truckId) {
    return this.trucks.get(truckId)
  }

  getTimeRange() {
    return getHistoryTimeRange(this.trajectoryHistory)
  }

  clear() {
    if (this._tilesetSwitchTimer) {
      clearTimeout(this._tilesetSwitchTimer)
      this._tilesetSwitchTimer = null
    }
    this.trucks.clear()
    this.trajectoryHistory.clear()
    this.siteSurfacePointCache.clear()
    this.listeners = []
    this.customPathPoints = null
    this.customPathTotalLength = 0
    this.sampledGroundPath = null
    this._lastTilesetModelMatrix = null
  }

  /**
   * 切换到外部实时数据源模式
   * 停止内部模拟器，通过 receiveExternalData 接收外部API推送的数据
   * @param {Function} [dataHandler] - 可选的数据预处理函数 (rawData) => processedData
   */
  switchToRealtime(dataHandler) {
    this.trucks.clear()
    this.dataSource = 'external_realtime'
    if (typeof dataHandler === 'function') {
      this.externalDataHandler = dataHandler
    }
  }

  /**
   * 接收外部数据（实时API推送入口）
   */
  receiveExternalData(data) {
    if (this.externalDataHandler) {
      data = this.externalDataHandler(data)
    }
    const valid = this.validateData(data)
    if (!valid) {
      return
    }
    const processedData = this.processData(data)
    this.trucks.set(data.truckId, processedData)
    this.addToHistory(data.truckId, processedData)
    this.notifyListeners(processedData)
  }

  destroy() {
    this.clear()
    this.tileset = null
    this.viewer = null
    this.originalModelMatrix = null
  }
}

export default RealtimeDataEngine
