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

const SIMULATOR_RECREATE_DEBOUNCE_MS = 200

export class RealtimeDataEngine {
  constructor() {
    this.trucks = new Map()
    this.listeners = []
    this.mode = 'simulated'
    this.dataSource = 'static_simulated'
    this.simulator = null
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

    if (this.simulator) this.simulator.initializeTruckStates()
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
      console.warn('[RealtimeDataEngine] 路径点不足，无法采样')
      return
    }

    console.log('[RealtimeDataEngine] 开始路径采样，绑定模型局部坐标...')

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

    console.log('[RealtimeDataEngine] 路径采样完成，采样点数:', sampledPath.length)
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
      console.warn('[RealtimeDataEngine] 获取地面高度失败:', error)
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
      console.warn('[RealtimeDataEngine] 异步地形采样失败:', error)
    }

    // 回退到同步方法
    return this.sampleGroundHeight(longitude, latitude)
  }

  init(options = {}) {
    this.initMiningSites()

    this.mode = options.mode || 'simulated'
    this.tileset = options.tileset || null
    this.viewer = options.viewer || null

    if (this.tileset && !this.originalModelMatrix) {
      this.originalModelMatrix = Cesium.Matrix4.clone(this.tileset.modelMatrix)
    }
  }

  async startSimulator() {
    if (this.simulator) this.simulator.stop()
    this.simulator = new TruckDataSimulator(this)
    await this.simulator.loadConfig()
    this.simulator.initializeTruckStates()
    this.simulator.start()
    return this.simulator
  }

  async initWithSimulator(options = {}) {
    this.init(options)
    if (this.mode === 'simulated') {
      await this.startSimulator()
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

      if (this.simulator) {
        this.simulator.stop()
        this.simulator = null
        this.trucks.clear()
        this.startSimulator()
      }

      this._lastTilesetModelMatrix = tileset.modelMatrix
        ? Cesium.Matrix4.clone(tileset.modelMatrix)
        : null
    }, SIMULATOR_RECREATE_DEBOUNCE_MS)
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

  refreshSimulationFrame() {
    if (!this.tileset || !this.simulator) return
    this.initMiningSites()
    this.simulator.initializeTruckStates()
  }

  stopSimulator() {
    this.simulator?.stop()
    this.simulator = null
  }

  validateData(data) {
    return isValidRealtimeTruckData(data)
  }

  processData(data) {
    return normalizeRealtimeTruckData(data)
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
    this.stopSimulator()
    this.trucks.clear()
    this.dataSource = 'external_realtime'
    if (typeof dataHandler === 'function') {
      this.externalDataHandler = dataHandler
    }
    console.log('[RealtimeDataEngine] 已切换到外部实时数据源模式')
  }

  /**
   * 切换回静态模拟数据源模式
   */
  async switchToSimulated() {
    this.stopSimulator()
    this.trucks.clear()
    this.externalDataHandler = null
    this.dataSource = 'static_simulated'
    await this.startSimulator()
    console.log('[RealtimeDataEngine] 已切换回静态模拟数据源模式')
  }

  /**
   * 接收外部数据（实时API推送入口）
   * 无论是模拟器还是外部API，统一通过此方法推送数据
   */
  receiveExternalData(data) {
    if (this.externalDataHandler) {
      data = this.externalDataHandler(data)
    }
    if (!this.validateData(data)) {
      console.warn('[RealtimeDataEngine] 无效数据:', data)
      return
    }
    const processedData = this.processData(data)
    this.trucks.set(data.truckId, processedData)
    this.addToHistory(data.truckId, processedData)
    this.notifyListeners(processedData)
  }

  destroy() {
    this.stopSimulator()
    this.clear()
    this.tileset = null
    this.viewer = null
    this.originalModelMatrix = null
  }
}

export class TruckDataSimulator {
  constructor(engine) {
    this.engine = engine
    this.intervalId = null
    this.truckConfigs = []
    this.truckStates = new Map()
    this.updateInterval = 1000
    this.cycleTime = 360000
    this.speedProfile = {
      loading: { min: 4, max: 6 },
      loadedTransport: { min: 23, max: 30 },
      unloading: { min: 4, max: 6 },
      emptyReturn: { min: 30, max: 38 }
    }
    this.phaseRatio = {
      loading: 0.15,
      loadedTransport: 0.35,
      unloading: 0.15,
      emptyReturn: 0.35
    }
    this.vehicleStatusConfig = {
      engineTemp: { min: 80, max: 100 },
      tirePressure: [8.0, 8.1, 8.2, 8.0],
      fuelLevel: { min: 60, max: 90 }
    }
    this.locationMap = {
      装载中: '采场1装载区',
      重载运输: '采场1→采场2运输线',
      卸载中: '采场2卸载区',
      空载返程: '采场2→采场1返程线'
    }
  }

  async loadConfig() {
    try {
      const [trucksData, simData] = await Promise.all([
        fetch('/trucks-config.json').then(r => (r.ok ? r.json() : null)),
        fetch('/simulation-config.json').then(r => (r.ok ? r.json() : null))
      ])

      if (trucksData?.trucks?.length) {
        this.truckConfigs = trucksData.trucks
        console.log(`[TruckSimulator] 从静态配置加载了 ${this.truckConfigs.length} 辆矿卡`)
      } else {
        this.loadDefaultTruckConfigs()
      }

      if (simData) {
        if (simData.simulation) {
          this.updateInterval = simData.simulation.updateIntervalMs || 1000
          this.cycleTime = simData.simulation.cycleTimeMs || 360000
        }
        if (simData.speedProfile) {
          Object.assign(this.speedProfile, simData.speedProfile)
        }
        if (simData.phaseRatio) {
          Object.assign(this.phaseRatio, simData.phaseRatio)
        }
        if (simData.vehicleStatus) {
          Object.assign(this.vehicleStatusConfig, simData.vehicleStatus)
        }
        if (simData.locationMap) {
          this.locationMap = { ...this.locationMap, ...simData.locationMap }
        }
        console.log(
          `[TruckSimulator] 从静态配置加载模拟参数: 周期=${(this.cycleTime / 60000).toFixed(1)}分钟, 更新间隔=${this.updateInterval}ms`
        )
      }
    } catch (error) {
      console.warn('[TruckSimulator] 加载配置失败，使用默认值:', error.message)
      this.loadDefaultTruckConfigs()
    }
  }

  loadDefaultTruckConfigs() {
    this.truckConfigs = [
      {
        truckId: 'T001',
        name: '1号矿卡',
        driver: '张鹏',
        driverInfo: { age: 35, experience: '8年', license: 'A2' },
        vehicleInfo: { brand: '徐工XDE240', capacity: 72, maxSpeed: 40 },
        mineralType: {
          code: 'CU',
          name: '铜矿石',
          grade: '1.2%',
          destination: '冶炼厂A区',
          color: '#B87333'
        },
        phase: 0.0
      },
      {
        truckId: 'T002',
        name: '2号矿卡',
        driver: '刘威',
        driverInfo: { age: 42, experience: '12年', license: 'A2' },
        vehicleInfo: { brand: '徐工XDE240', capacity: 72, maxSpeed: 40 },
        mineralType: {
          code: 'FE',
          name: '铁矿石',
          grade: '45%',
          destination: '选矿厂B区',
          color: '#8B4513'
        },
        phase: 0.33
      },
      {
        truckId: 'T003',
        name: '3号矿卡',
        driver: '王超',
        driverInfo: { age: 28, experience: '5年', license: 'A2' },
        vehicleInfo: { brand: '徐工XDE240', capacity: 72, maxSpeed: 40 },
        mineralType: {
          code: 'AU',
          name: '金矿石',
          grade: '3.5g/t',
          destination: '精炼厂C区',
          color: '#FFD700'
        },
        phase: 0.66
      }
    ]
    console.log('[TruckSimulator] 使用内置默认矿卡配置')
  }

  initializeTruckStates() {
    if (!MINING_SITE_1 || !MINING_SITE_2 || !this.truckConfigs.length) return
    this.truckStates.clear()
    this.truckConfigs.forEach(config => {
      this.truckStates.set(config.truckId, {
        ...config,
        phase: config.phase || 0,
        status: '装载中',
        payload: 0,
        progress: 0,
        worldPosition: {
          longitude: MINING_SITE_1.longitude,
          latitude: MINING_SITE_1.latitude,
          height: MINING_SITE_1.height
        }
      })
    })
  }

  getConfig() {
    return {
      truckConfigs: this.truckConfigs,
      updateInterval: this.updateInterval,
      cycleTime: this.cycleTime,
      speedProfile: this.speedProfile,
      phaseRatio: this.phaseRatio,
      vehicleStatusConfig: this.vehicleStatusConfig
    }
  }

  updateConfig(newConfig) {
    if (!newConfig) return
    if (newConfig.updateIntervalMs) this.updateInterval = newConfig.updateIntervalMs
    if (newConfig.cycleTimeMs) this.cycleTime = newConfig.cycleTimeMs
    if (newConfig.speedProfile) Object.assign(this.speedProfile, newConfig.speedProfile)
    if (newConfig.phaseRatio) Object.assign(this.phaseRatio, newConfig.phaseRatio)
    if (newConfig.vehicleStatus) Object.assign(this.vehicleStatusConfig, newConfig.vehicleStatus)
    console.log('[TruckSimulator] 运行时配置已更新')
  }

  setTruckConfigs(truckConfigs) {
    if (!Array.isArray(truckConfigs) || !truckConfigs.length) return false
    this.truckConfigs = truckConfigs
    this.initializeTruckStates()
    console.log(`[TruckSimulator] 矿卡配置已更新: ${truckConfigs.length} 辆`)
    return true
  }

  getInitialSurfacePosition(index) {
    const site = MINING_SITE_1
    const r = site.initialPlacementRadius || 6
    const angle =
      ((index % Math.max(this.truckConfigs.length, 1)) / Math.max(this.truckConfigs.length, 1)) *
      Math.PI *
      2
    return this.engine.resolveSiteOffsetWorldPosition(
      site,
      Math.cos(angle) * r,
      Math.sin(angle) * r
    )
  }

  getRoadAngleBetweenSites(site1, site2) {
    const dLon = site2.longitude - site1.longitude
    const dLat = site2.latitude - site1.latitude
    return Math.atan2(dLat, dLon)
  }

  getRoadEdgeCartesian(site, angle, radius) {
    return this.engine.resolveSiteOffsetCartesian(
      site,
      Math.cos(angle) * radius,
      Math.sin(angle) * radius
    )
  }

  start() {
    if (this.intervalId) return
    if (!this.truckConfigs.length) {
      console.warn('[TruckSimulator] 无矿卡配置，无法启动模拟')
      return
    }
    this.intervalId = setInterval(() => {
      this.updateTrucks()
    }, this.updateInterval)
    console.log(
      `[TruckSimulator] 模拟器已启动 (间隔=${this.updateInterval}ms, 周期=${(this.cycleTime / 60000).toFixed(1)}分钟)`
    )
  }

  stop() {
    clearInterval(this.intervalId)
    this.intervalId = null
  }

  restart() {
    this.stop()
    this.start()
  }

  updateTrucks() {
    const now = Date.now()
    this.truckStates.forEach(state => {
      this.updateTruckState(state, now)
      this.engine.receiveExternalData(this.generateDataPacket(state, now))
    })
  }

  updateTruckState(state, now) {
    const cycleTime = this.cycleTime
    const elapsed = (now + state.phase * cycleTime) % cycleTime
    const progress = elapsed / cycleTime
    const hasCustomPath = this.engine.customPathPoints?.length >= 2
    hasCustomPath
      ? this.updateTruckStateOnCustomPath(state, progress)
      : this.updateTruckStateDefault(state, progress)
  }

  updateTruckStateOnCustomPath(state, progress) {
    const { loading, loadedTransport, unloading, emptyReturn } = this.phaseRatio
    const ls = loading,
      le = loading + loadedTransport
    const us = le,
      ue = le + unloading
    const speed = this.speedProfile

    if (progress < ls) {
      state.status = '装载中'
      state.worldPosition = this.getPositionNearStart(progress / ls)
      state.speed = speed.loading.min + Math.random() * (speed.loading.max - speed.loading.min)
      state.payload = (progress / ls) * state.vehicleInfo.capacity
      state.heading = this.getHeadingOnPath(0.01)
    } else if (progress < le) {
      state.status = '重载运输'
      const tp = (progress - ls) / loadedTransport
      state.worldPosition = this.engine.getPositionOnPath(tp)
      state.speed =
        speed.loadedTransport.min +
        Math.random() * (speed.loadedTransport.max - speed.loadedTransport.min)
      state.payload = state.vehicleInfo.capacity
      state.heading = this.getHeadingOnPath(tp)
    } else if (progress < ue) {
      state.status = '卸载中'
      const up = (progress - us) / unloading
      state.worldPosition = this.getPositionNearEnd(up)
      state.speed =
        speed.unloading.min + Math.random() * (speed.unloading.max - speed.unloading.min)
      state.payload = state.vehicleInfo.capacity * (1 - up)
      state.heading = this.getHeadingOnPath(0.99)
    } else {
      state.status = '空载返程'
      const rp = 1 - (progress - ue) / emptyReturn
      state.worldPosition = this.engine.getPositionOnPath(rp)
      state.speed =
        speed.emptyReturn.min + Math.random() * (speed.emptyReturn.max - speed.emptyReturn.min)
      state.payload = 0
      state.heading = (this.getHeadingOnPath(rp) + 180) % 360
    }
  }

  getHeadingOnPath(progress) {
    const delta = 0.01
    const pos1 = this.engine.getPositionOnPath(progress - delta)
    const pos2 = this.engine.getPositionOnPath(progress + delta)
    if (!pos1 || !pos2) return 0
    let angle =
      (Math.atan2(pos2.longitude - pos1.longitude, pos2.latitude - pos1.latitude) * 180) / Math.PI
    if (angle < 0) angle += 360
    return angle
  }

  getPositionNearStart(p) {
    const cp = Math.max(0, Math.min(1, p))
    return this.engine.getPositionOnPath(cp * ENDPOINT_PATH_WINDOW) || MINING_SITE_1
  }

  getPositionNearEnd(p) {
    const cp = Math.max(0, Math.min(1, p))
    return (
      this.engine.getPositionOnPath(1 - ENDPOINT_PATH_WINDOW + cp * ENDPOINT_PATH_WINDOW) ||
      MINING_SITE_2
    )
  }

  updateTruckStateDefault(state, progress) {
    const { loading, loadedTransport, unloading, emptyReturn } = this.phaseRatio
    const ls = loading,
      le = loading + loadedTransport
    const us = le,
      ue = le + unloading
    const speed = this.speedProfile

    if (progress < ls) {
      state.status = '装载中'
      const lp = progress / ls
      const angle = lp * 270 * (Math.PI / 180)
      state.worldPosition = this.getWorldPositionOnSite(MINING_SITE_1, angle)
      state.speed = speed.loading.min + Math.random() * (speed.loading.max - speed.loading.min)
      state.payload = lp * state.vehicleInfo.capacity
      state.heading = (lp * 270 + 90) % 360
    } else if (progress < le) {
      state.status = '重载运输'
      const tp = (progress - ls) / loadedTransport
      state.worldPosition = this.getWorldPositionOnRoad(MINING_SITE_1, MINING_SITE_2, tp)
      state.speed =
        speed.loadedTransport.min +
        Math.random() * (speed.loadedTransport.max - speed.loadedTransport.min)
      state.payload = state.vehicleInfo.capacity
      state.heading = this.calculateWorldHeading(MINING_SITE_1, MINING_SITE_2)
    } else if (progress < ue) {
      state.status = '卸载中'
      const up = (progress - us) / unloading
      const angle = up * 270 * (Math.PI / 180)
      state.worldPosition = this.getWorldPositionOnSite(MINING_SITE_2, angle)
      state.speed =
        speed.unloading.min + Math.random() * (speed.unloading.max - speed.unloading.min)
      state.payload = state.vehicleInfo.capacity * (1 - up)
      state.heading = (up * 270 + 90) % 360
    } else {
      state.status = '空载返程'
      const rp = (progress - ue) / emptyReturn
      state.worldPosition = this.getWorldPositionOnRoad(MINING_SITE_2, MINING_SITE_1, rp)
      state.speed =
        speed.emptyReturn.min + Math.random() * (speed.emptyReturn.max - speed.emptyReturn.min)
      state.payload = 0
      state.heading = this.calculateWorldHeading(MINING_SITE_2, MINING_SITE_1)
    }
  }

  getWorldPositionOnSite(site, angle) {
    const r = site?.radius || SITE_RADIUS
    return this.engine.resolveSiteOffsetWorldPosition(
      site,
      Math.cos(angle) * r,
      Math.sin(angle) * r
    )
  }

  getWorldPositionOnRoad(startSite, endSite, progress) {
    const sr = startSite?.radius || SITE_RADIUS,
      er = endSite?.radius || SITE_RADIUS
    const sra = this.getRoadAngleBetweenSites(startSite, endSite)
    const era = this.getRoadAngleBetweenSites(endSite, startSite)

    if (progress < 0.2) {
      const ap = progress / 0.2
      const angle = sra - Math.PI / 2 + ap * (Math.PI / 2)
      return this.getWorldPositionOnSite(startSite, angle)
    } else if (progress < 0.8) {
      const rp = (progress - 0.2) / 0.6
      const sc = this.getRoadEdgeCartesian(startSite, sra, sr)
      const ec = this.getRoadEdgeCartesian(endSite, era, er)
      const ic = Cesium.Cartesian3.lerp(sc, ec, rp, new Cesium.Cartesian3())
      const wp = this.engine.cartesianToWorldPosition(ic, startSite?.height || 0)
      return { ...wp, height: this.engine.sampleGroundHeight(wp.longitude, wp.latitude, wp.height) }
    }
    const ap = (progress - 0.8) / 0.2
    const angle = era + Math.PI - Math.PI / 2 + ap * (Math.PI / 2)
    return this.getWorldPositionOnSite(endSite, angle)
  }

  calculateWorldHeading(from, to) {
    const dLon = to.longitude - from.longitude,
      dLat = to.latitude - from.latitude
    let angle = Math.atan2(dLat, dLon) * (180 / Math.PI)
    if (angle < 0) angle += 360
    return Math.round(angle)
  }

  generateDataPacket(state, timestamp) {
    const vs = this.vehicleStatusConfig
    const cartesian = Cesium.Cartesian3.fromDegrees(
      state.worldPosition.longitude,
      state.worldPosition.latitude,
      state.worldPosition.height
    )

    return {
      truckId: state.truckId,
      name: state.name,
      truckName: state.name,
      driver: state.driver,
      driverInfo: state.driverInfo,
      vehicleInfo: state.vehicleInfo,
      capacity: state.vehicleInfo.capacity,
      mineralType: state.mineralType,
      position: {
        cartesian: [cartesian.x, cartesian.y, cartesian.z],
        longitude: state.worldPosition.longitude,
        latitude: state.worldPosition.latitude,
        height: state.worldPosition.height
      },
      timestamp,
      speed: Math.round(state.speed * 10) / 10,
      heading: state.heading,
      status: state.status,
      location: this.locationMap[state.status] || '未知位置',
      payload: Math.round(state.payload),
      payloadPercent: Math.round((state.payload / state.vehicleInfo.capacity) * 100),
      engineTemp: Math.round(
        vs.engineTemp.min + Math.random() * (vs.engineTemp.max - vs.engineTemp.min)
      ),
      tirePressure: [...(vs.tirePressure || [8.0, 8.1, 8.2, 8.0])],
      fuelLevel: Math.round(
        vs.fuelLevel.min + Math.random() * (vs.fuelLevel.max - vs.fuelLevel.min)
      ),
      cycleCount: Math.floor(timestamp / this.cycleTime) + 1
    }
  }
}

export default RealtimeDataEngine
