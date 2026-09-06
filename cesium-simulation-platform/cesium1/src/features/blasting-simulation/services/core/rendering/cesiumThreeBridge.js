/**
 * Cesium-Three 相机同步桥接器
 *
 * 将 three.js 场景叠加在 Cesium 地球之上，并实时同步相机变换。
 * 使用 ENU（东-北-上）局部坐标系，原点为爆心位置。
 *
 * 工作原理：
 *  1. 以爆心经纬度为原点建立 ENU 局部坐标系（X=东, Y=上, Z=北）
 *  2. 将 three.js 场景原点对齐到该 ENU 原点
 *  3. 每帧从 Cesium 相机提取位置/方向/up 向量，转换到 ENU 空间
 *  4. 同步给 three.js 相机
 *
 * 这样 three.js 渲染的粒子会"贴"在 Cesium 地球上的真实位置。
 */
import * as Cesium from 'cesium'
import * as THREE from 'three'
import { ThreeBlastingRenderer } from './threeBlastingRenderer.js'

export class CesiumThreeBridge {
  constructor(cesiumViewer, container) {
    this.viewer = cesiumViewer
    this.container = container

    // 爆心位置（经纬度）
    this.centerLon = 0
    this.centerLat = 0
    this.centerHeight = 0

    // ENU 原点的固定矩阵（Cesium Transforms）
    this.originMatrix = null
    this.originMatrixInverse = null

    // three.js 渲染器
    this.threeRenderer = new ThreeBlastingRenderer(container)

    // 同步状态
    this._syncBound = this._syncCamera.bind(this)
    this._active = false
    this._lastViewportWidth = 0
    this._lastViewportHeight = 0

    // 预分配 scratch 对象（_syncCamera 每帧调用，避免 new 导致 GC 压力）
    this._scratch = {
      posLocal: new Cesium.Cartesian3(),
      dirLocal: new Cesium.Cartesian3(),
      upLocal: new Cesium.Cartesian3(),
      threePos: new THREE.Vector3(),
      threeDir: new THREE.Vector3(),
      threeUp: new THREE.Vector3(),
      threeRight: new THREE.Vector3(),
      threeUpCorrected: new THREE.Vector3()
    }

    // three.js 容器样式（覆盖在 Cesium 之上，不接收事件）
    this._setupContainerStyle()
  }

  _setupContainerStyle() {
    const el = this.threeRenderer.renderer.domElement
    el.style.position = 'absolute'
    el.style.top = '0'
    el.style.left = '0'
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.pointerEvents = 'auto'
    el.style.zIndex = '100'
  }

  /**
   * 设置爆心位置（经纬度高度）
   * 建立 ENU 局部坐标系
   */
  setCenter(lon, lat, height = 0) {
    this.centerLon = lon
    this.centerLat = lat
    this.centerHeight = height

    // 计算 ENU 原点的变换矩阵（局部→世界）
    this.originMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(lon, lat, height)
    )
    this.originMatrixInverse = Cesium.Matrix4.inverseTransformation(
      this.originMatrix,
      new Cesium.Matrix4()
    )

    // three.js 渲染器原点对齐到 ENU 原点（0,0,0）
    this.threeRenderer.setCenter(0, 0, 0)
  }

  /**
   * 启动爆破效果
   * @param {Object} params - { chargeKg, fragmentCount }
   */
  startBlast(params = {}) {
    if (!this.originMatrix) {
      console.warn('[CesiumThreeBridge] 未设置爆心位置，使用默认 (0,0)')
      this.setCenter(0, 0, 0)
    }
    this.threeRenderer.initBlast(params)
    this._active = true

    // 独立 Three.js 模式：使用 OrbitControls + RAF 渲染循环，
    // 不再注册 Cesium preRender 事件（消除每帧相机同步开销和双重渲染）
    this.threeRenderer.startStandaloneMode()
  }

  /**
   * 停止爆破效果
   */
  stopBlast() {
    this._active = false
    this.threeRenderer.stopStandaloneMode()
    this.threeRenderer.clear()
  }

  /**
   * 每帧同步相机（由 Cesium preRender 事件触发）
   */
  _syncCamera() {
    if (!this._active || !this.originMatrix) return

    try {
      // 调整 three.js 画布大小（完整同步 renderer/camera.aspect/bloomComposer）
      const canvas = this.viewer.canvas
      const width = Math.max(1, canvas.clientWidth || 0)
      const height = Math.max(1, canvas.clientHeight || 0)
      if (width !== this._lastViewportWidth || height !== this._lastViewportHeight) {
        this._lastViewportWidth = width
        this._lastViewportHeight = height
        // 使用 resizeTo 而非 renderer.setSize，确保 camera.aspect 和 bloomComposer 同步更新
        this.threeRenderer.resizeTo(width, height)
      }

      // 获取 Cesium 相机参数
      const cesiumCamera = this.viewer.camera
      const cameraPositionWorld = cesiumCamera.positionWC || cesiumCamera.position
      const cameraDirectionWorld = cesiumCamera.directionWC || cesiumCamera.direction
      const cameraUpWorld = cesiumCamera.upWC || cesiumCamera.up

      // 先将世界坐标转换到 ENU 局部坐标（正交 FOV 反算需要相机到爆心的距离）
      const sc = this._scratch
      const cameraPositionLocal = Cesium.Matrix4.multiplyByPoint(
        this.originMatrixInverse,
        cameraPositionWorld,
        sc.posLocal
      )
      const directionLocal = Cesium.Matrix4.multiplyByPointAsVector(
        this.originMatrixInverse,
        cameraDirectionWorld,
        sc.dirLocal
      )
      const upLocal = Cesium.Matrix4.multiplyByPointAsVector(
        this.originMatrixInverse,
        cameraUpWorld,
        sc.upLocal
      )

      // 计算 Cesium 相机视场角（度）
      const frustum = cesiumCamera.frustum
      let fov
      if (frustum instanceof Cesium.PerspectiveFrustum) {
        fov = Cesium.Math.toDegrees(frustum.fovy)
      } else if (frustum instanceof Cesium.OrthographicFrustum) {
        const orthoHeight = Math.abs(frustum.top - frustum.bottom)
        const camDist = Cesium.Cartesian3.magnitude(cameraPositionLocal)
        fov = Cesium.Math.toDegrees(
          2 * Math.atan(Math.max(1, orthoHeight) / (2 * Math.max(1, camDist)))
        )
      } else {
        fov = 60
      }

      // 转换到 three.js 坐标系（复用 scratch，避免每帧 new）
      // Cesium ENU: X=东, Y=北, Z=上 → three.js: X=东, Y=上, Z=南（-北）
      const threePosition = sc.threePos.set(
        cameraPositionLocal.x,
        cameraPositionLocal.z,
        -cameraPositionLocal.y
      )
      const threeDirection = sc.threeDir
        .set(directionLocal.x, directionLocal.z, -directionLocal.y)
        .normalize()
      const rawThreeUp = sc.threeUp.set(upLocal.x, upLocal.z, -upLocal.y).normalize()
      const threeRight = sc.threeRight.crossVectors(threeDirection, rawThreeUp)
      const threeUp =
        threeRight.lengthSq() > 1e-8
          ? sc.threeUpCorrected.crossVectors(threeRight.normalize(), threeDirection).normalize()
          : rawThreeUp

      // 计算宽高比与裁剪面
      const aspect = width / height
      // Cesium 相机的 near/far 可能为 undefined，使用合理默认值
      const near = cesiumCamera.frustum?.near ?? cesiumCamera.near ?? 0.1
      const far = cesiumCamera.frustum?.far ?? cesiumCamera.far ?? 50000

      // 同步给 three.js 相机
      this.threeRenderer.syncCamera(
        threePosition,
        threeDirection,
        threeUp,
        fov,
        aspect,
        Math.max(0.1, near),
        Math.min(50000, far)
      )

      // 仅渲染场景（粒子模拟由时间轴通过 seekTo 驱动，不再使用真实 deltaTime）
      this.threeRenderer.renderFrame()
    } catch (err) {
      // 修正：原实现单帧异常即永久停用（this._active=false），导致偶发错误后整个爆破效果失效
      // 改为连续错误计数，超过阈值才停用，避免单次异常造成永久失效
      this._syncErrorCount = (this._syncErrorCount || 0) + 1
      if (this._syncErrorCount <= 3) {
        console.error('[CesiumThreeBridge] 同步相机失败:', err)
      }
      if (this._syncErrorCount >= 60) {
        console.error('[CesiumThreeBridge] 连续 60 帧同步失败，停用桥接器')
        this._active = false
      }
    }
  }

  /**
   * 将粒子系统定位到指定模拟时间（由 BlastingManager.setFrame 调用，
   * 实现与时间轴同步）。
   * @param {number} targetTime - 目标模拟时间（秒）
   */
  seekTo(targetTime) {
    this.threeRenderer?.seekTo(targetTime)
  }

  /**
   * 获取 three.js 渲染器实例
   */
  getThreeRenderer() {
    return this.threeRenderer
  }

  /**
   * 销毁桥接器
   */
  dispose() {
    this.stopBlast()
    if (this._removeListener) {
      this._removeListener()
      this._removeListener = null
    }
    this.threeRenderer.dispose()
  }
}
