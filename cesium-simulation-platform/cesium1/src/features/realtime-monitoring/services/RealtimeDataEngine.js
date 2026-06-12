import * as Cesium from 'cesium'
import { MINING_PIT_1_POSITION, MINING_PIT_2_POSITION } from '../types/monitoringDefaults.js'
import {
  appendHistoryEntry,
  calculateGreatCircleDistance,
  findNearestHistoryPoint,
  findPathSegmentByDistance,
  getHistoryTimeRange,
  getTruckStatesAtTime,
  isValidRealtimeTruckData,
  normalizeLoopProgress,
  normalizeRealtimeTruckData,
  resolveSampledPathInterpolation
} from './realtimeDataCore.js'
import {
  buildSurfacePoolCandidates,
  findNearestSurfacePoint,
  isDuplicateSurfacePoint,
  selectResolvedSurfacePool
} from './siteSurfaceCore.js'
import { createSiteSurfaceResolver } from './siteSurfaceResolver.js'

export let MINING_SITE_1 = null
export let MINING_SITE_2 = null

// 采场半径（道路距离中心的距离，单位：米）
const SITE_RADIUS = 50
const VEHICLE_SURFACE_OFFSET = 0.5
const ENDPOINT_PATH_WINDOW = 0.03
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

    this.customPathPoints = pathPoints.map((p, index) => {
      const currentCartesian = Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.height || 0)
      const originalCartesian = this.transformCurrentPointToOriginal(currentCartesian)
      return {
        index,
        longitude: p.longitude,
        latitude: p.latitude,
        height: p.height || 0,
        currentCartesian,
        originalCartesian,
        cumulativeDistance: 0
      }
    })

    let totalDistance = 0
    for (let i = 1; i < this.customPathPoints.length; i++) {
      const prev = this.customPathPoints[i - 1],
        curr = this.customPathPoints[i]
      const segmentDistance = Cesium.Cartesian3.distance(
        prev.originalCartesian,
        curr.originalCartesian
      )
      totalDistance += segmentDistance
      curr.cumulativeDistance = totalDistance
    }
    this.customPathTotalLength = totalDistance

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
    if (!this.customPathPoints || this.customPathPoints.length < 2) {
      return null
    }

    progress = normalizeLoopProgress(progress)

    // 如果有预采样的路径，使用采样点插值
    if (this.sampledGroundPath && this.sampledGroundPath.length >= 2) {
      return this.getPositionFromSampledPath(progress)
    }

    const currentPathPoints = this.getCurrentCustomPathPoints()
    const targetDistance = progress * this.customPathTotalLength
    const segment = findPathSegmentByDistance(currentPathPoints, targetDistance)
    if (!segment) return null

    const interpolatedCartesian = Cesium.Cartesian3.lerp(
      segment.prev.currentCartesian,
      segment.curr.currentCartesian,
      segment.segmentProgress,
      new Cesium.Cartesian3()
    )

    return this.cartesianToWorldPosition(interpolatedCartesian, segment.prev.height || 0)
  }

  getPositionFromSampledPath(progress) {
    const sampledPath = this.sampledGroundPath
    const interpolation = resolveSampledPathInterpolation(progress, sampledPath.length)
    if (!interpolation) return null

    const point1 = sampledPath[interpolation.index1]
    const point2 = sampledPath[interpolation.index2]
    const point1Current = this.transformOriginalPointToCurrent(point1.originalCartesian)
    const point2Current = this.transformOriginalPointToCurrent(point2.originalCartesian)
    const interpolatedCartesian = Cesium.Cartesian3.lerp(
      point1Current,
      point2Current,
      interpolation.localProgress,
      new Cesium.Cartesian3()
    )

    return this.cartesianToWorldPosition(interpolatedCartesian, 0)
  }

  samplePathOnGround(samplesPerSegment = 50) {
    if (!this.customPathPoints || this.customPathPoints.length < 2) {
      return
    }

    const sampledPath = []

    for (let i = 0; i < this.customPathPoints.length - 1; i++) {
      const start = this.customPathPoints[i]
      const end = this.customPathPoints[i + 1]

      for (let j = 0; j < samplesPerSegment; j++) {
        const t = j / samplesPerSegment
        const originalCartesian = Cesium.Cartesian3.lerp(
          start.originalCartesian,
          end.originalCartesian,
          t,
          new Cesium.Cartesian3()
        )

        sampledPath.push({
          originalCartesian,
          segmentIndex: i,
          segmentProgress: t
        })
      }
    }

    const last = this.customPathPoints[this.customPathPoints.length - 1]
    sampledPath.push({
      originalCartesian: Cesium.Cartesian3.clone(last.originalCartesian),
      segmentIndex: this.customPathPoints.length - 1,
      segmentProgress: 1
    })

    // 存储采样路径
    this.sampledGroundPath = sampledPath
  }

  getCurrentCustomPathPoints() {
    if (!this.customPathPoints || this.customPathPoints.length === 0) {
      return []
    }

    return this.customPathPoints.map(point => {
      const currentCartesian = this.transformOriginalPointToCurrent(point.originalCartesian)
      const worldPosition = this.cartesianToWorldPosition(currentCartesian, point.height || 0)

      return {
        ...point,
        ...worldPosition,
        currentCartesian
      }
    })
  }

  // 使用 Cesium 获取指定经纬度位置的地面高度 -> 针对 3D Tiles 模型优化
  sampleGroundHeight(longitude, latitude, defaultHeight = 0) {
    if (!this.viewer) {
      return this.getHeightFromPathPoints(longitude, latitude) + VEHICLE_SURFACE_OFFSET
    }

    try {
      const scene = this.viewer.scene
      let pickedPosition = null

      // 方法1: 优先使用 pickPosition 从屏幕坐标获取 3D Tiles 表面
      // 这需要先将经纬度转换为屏幕坐标
      const cartesian = Cesium.Cartesian3.fromDegrees(longitude, latitude, 100)
      const screenPosition = this.getScreenPositionFromCartesian(scene, cartesian)

      if (screenPosition && scene.pickPositionSupported) {
        // 从屏幕坐标拾取 3D 表面位置
        const pickedCartesian = scene.pickPosition(screenPosition)
        if (pickedCartesian) {
          const cartographic = Cesium.Cartographic.fromCartesian(pickedCartesian)
          // 验证高度是否合理（不是地下或空中）
          if (cartographic.height > -100 && cartographic.height < 10000) {
            pickedPosition = cartographic.height
          }
        }
      }

      // 方法2: 如果 pickPosition 失败，尝试从 tileset 直接获取
      if (pickedPosition === null && this.tileset) {
        // 创建从高处向下的射线
        const cartesianTop = Cesium.Cartesian3.fromDegrees(longitude, latitude, 1000)
        const cartesianBottom = Cesium.Cartesian3.fromDegrees(longitude, latitude, -1000)
        const direction = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(cartesianBottom, cartesianTop, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        )
        const ray = new Cesium.Ray(cartesianTop, direction)

        // 尝试与 tileset 相交
        const features = scene.drillPickFromRay(ray, 10)
        if (features && features.length > 0) {
          // 找到第一个有效的交点
          for (const feature of features) {
            if (feature && feature.position) {
              const cartographic = Cesium.Cartographic.fromCartesian(feature.position)
              if (cartographic.height > -100 && cartographic.height < 10000) {
                pickedPosition = cartographic.height
                break
              }
            }
          }
        }
      }

      // 方法3: 使用 globe.pick 检测地形
      if (pickedPosition === null && scene.globe) {
        const cartesianTop = Cesium.Cartesian3.fromDegrees(longitude, latitude, 1000)
        const direction = new Cesium.Cartesian3(0, 0, -1)
        const ray = new Cesium.Ray(cartesianTop, direction)
        const picked = scene.globe.pick(ray, scene)
        if (picked) {
          const cartographic = Cesium.Cartographic.fromCartesian(picked)
          pickedPosition = cartographic.height
        }
      }

      // 方法4: 如果仍然没有获取到，使用原始路径点插值
      if (pickedPosition === null || pickedPosition === undefined) {
        pickedPosition = this.getHeightFromPathPoints(longitude, latitude)
      }

      // 如果所有方法都失败，使用默认高度
      if (pickedPosition === null || pickedPosition === undefined) {
        pickedPosition = defaultHeight
      }

      return pickedPosition + VEHICLE_SURFACE_OFFSET
    } catch (error) {
      return this.getHeightFromPathPoints(longitude, latitude) + VEHICLE_SURFACE_OFFSET
    }
  }

  getScreenPositionFromCartesian(scene, cartesian) {
    if (!scene || !cartesian) return null

    if (typeof scene.cartesianToCanvasCoordinates === 'function') {
      return scene.cartesianToCanvasCoordinates(cartesian, new Cesium.Cartesian2())
    }

    if (Cesium.SceneTransforms?.worldToWindowCoordinates) {
      return Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        cartesian,
        new Cesium.Cartesian2()
      )
    }

    return null
  }

  getHeightFromPathPoints(longitude, latitude) {
    if (!this.customPathPoints || this.customPathPoints.length === 0) {
      return 0
    }

    const currentPathPoints = this.getCurrentCustomPathPoints()
    if (currentPathPoints.length === 0) {
      return 0
    }

    // 找到最近的两个路径点进行插值
    let nearestIndex = 0
    let minDistance = Infinity

    for (let i = 0; i < currentPathPoints.length; i++) {
      const point = currentPathPoints[i]
      const dLon = point.longitude - longitude
      const dLat = point.latitude - latitude
      const distance = Math.sqrt(dLon * dLon + dLat * dLat)

      if (distance < minDistance) {
        minDistance = distance
        nearestIndex = i
      }
    }

    // 如果找到的是第一个或最后一个点，直接返回
    if (nearestIndex === 0 || nearestIndex === currentPathPoints.length - 1) {
      return currentPathPoints[nearestIndex].height
    }

    // 在两个相邻点之间插值
    const prev = currentPathPoints[nearestIndex - 1]
    const curr = currentPathPoints[nearestIndex]
    const next = currentPathPoints[nearestIndex + 1]

    // 计算到前后点的距离
    const distToPrev = Math.sqrt(
      Math.pow(prev.longitude - longitude, 2) + Math.pow(prev.latitude - latitude, 2)
    )
    const distToNext = Math.sqrt(
      Math.pow(next.longitude - longitude, 2) + Math.pow(next.latitude - latitude, 2)
    )

    // 距离加权插值
    const totalDist = distToPrev + distToNext
    if (totalDist === 0) {
      return curr.height
    }

    const weightPrev = distToNext / totalDist
    const weightNext = distToPrev / totalDist

    return prev.height * weightPrev + next.height * weightNext
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
    const originalSites = this.tileset?.spec?.sites
    const sitesList =
      Array.isArray(originalSites) && originalSites.length >= 2 ? originalSites : null

    if (sitesList && this.tileset) {
      MINING_SITE_1 = this.buildMiningSiteFromSpec(sitesList[0], MINING_PIT_1_POSITION)
      MINING_SITE_2 = this.buildMiningSiteFromSpec(sitesList[1], MINING_PIT_2_POSITION)
      return
    }

    if (this.tileset && this.tileset.boundingSphere) {
      this.initMiningSitesFromModel()
      return
    }

    this.initMiningSitesFromDefaults()
  }

  initMiningSitesFromModel() {
    try {
      const center = this.tileset.boundingSphere.center
      const cartographic = Cesium.Cartographic.fromCartesian(center)

      const modelLongitude = Cesium.Math.toDegrees(cartographic.longitude)
      const modelLatitude = Cesium.Math.toDegrees(cartographic.latitude)
      const modelHeight = cartographic.height

      MINING_SITE_1 = {
        longitude: modelLongitude - 0.0005,
        latitude: modelLatitude,
        height: modelHeight + 5
      }

      MINING_SITE_2 = {
        longitude: modelLongitude + 0.0005,
        latitude: modelLatitude,
        height: modelHeight + 5
      }
    } catch (error) {
      this.initMiningSitesFromDefaults()
    }
  }

  initMiningSitesFromDefaults() {
    if (!MINING_SITE_1) {
      MINING_SITE_1 = {
        longitude: MINING_PIT_1_POSITION.x,
        latitude: MINING_PIT_1_POSITION.y,
        height: MINING_PIT_1_POSITION.z
      }
    }
    if (!MINING_SITE_2) {
      MINING_SITE_2 = {
        longitude: MINING_PIT_2_POSITION.x,
        latitude: MINING_PIT_2_POSITION.y,
        height: MINING_PIT_2_POSITION.z
      }
    }
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
        console.error('[RealtimeDataEngine] 监听器失败:', e)
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