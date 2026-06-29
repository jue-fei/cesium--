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
    el.style.pointerEvents = 'none'
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

    const stats = this.threeRenderer.getStats()
    console.log('[CesiumThreeBridge] 爆破效果已启动', {
      center: { lon: this.centerLon, lat: this.centerLat, height: this.centerHeight },
      chargeKg: params.chargeKg,
      particleCount: stats?.total
    })

    // 注册到 Cesium 的 preRender 事件，每帧同步
    if (!this._removeListener) {
      this._removeListener = this.viewer.scene.preRender.addEventListener(this._syncBound)
      console.log('[CesiumThreeBridge] preRender 监听已注册')
    }
  }

  /**
   * 停止爆破效果
   */
  stopBlast() {
    this._active = false
    this.threeRenderer.clear()
    if (this._removeListener) {
      this._removeListener()
      this._removeListener = null
    }
  }

  /**
   * 每帧同步相机（由 Cesium preRender 事件触发）
   */
  _syncCamera() {
    if (!this._active || !this.originMatrix) return

    try {
      // 调整 three.js 画布大小
      const canvas = this.viewer.canvas
      const width = Math.max(1, canvas.clientWidth || 0)
      const height = Math.max(1, canvas.clientHeight || 0)
      if (width !== this._lastViewportWidth || height !== this._lastViewportHeight) {
        this._lastViewportWidth = width
        this._lastViewportHeight = height
        this.threeRenderer.renderer.setSize(width, height)
      }

      // 获取 Cesium 相机参数
      const cesiumCamera = this.viewer.camera
      const cameraPositionWorld = cesiumCamera.positionWC || cesiumCamera.position
      const cameraDirectionWorld = cesiumCamera.directionWC || cesiumCamera.direction
      const cameraUpWorld = cesiumCamera.upWC || cesiumCamera.up

      // 计算 Cesium 相机视场角（弧度）
      const frustum = cesiumCamera.frustum
      let fov
      if (frustum instanceof Cesium.PerspectiveFrustum) {
        fov = Cesium.Math.toDegrees(frustum.fovy)
      } else {
        fov = 60 // 默认值
      }

      // 将世界坐标转换到 ENU 局部坐标
      const cameraPositionLocal = Cesium.Matrix4.multiplyByPoint(
        this.originMatrixInverse,
        cameraPositionWorld,
        new Cesium.Cartesian3()
      )
      const directionLocal = Cesium.Matrix4.multiplyByPointAsVector(
        this.originMatrixInverse,
        cameraDirectionWorld,
        new Cesium.Cartesian3()
      )
      const upLocal = Cesium.Matrix4.multiplyByPointAsVector(
        this.originMatrixInverse,
        cameraUpWorld,
        new Cesium.Cartesian3()
      )

      // 转换到 three.js 坐标系
      // Cesium ENU: X=东, Y=北, Z=上（右手）
      // three.js: X=东, Y=上, Z=南（-北，保持右手）
      const threePosition = new THREE.Vector3(
        cameraPositionLocal.x,
        cameraPositionLocal.z,
        -cameraPositionLocal.y
      )
      const threeDirection = new THREE.Vector3(
        directionLocal.x,
        directionLocal.z,
        -directionLocal.y
      ).normalize()
      const rawThreeUp = new THREE.Vector3(upLocal.x, upLocal.z, -upLocal.y).normalize()
      const threeRight = new THREE.Vector3().crossVectors(threeDirection, rawThreeUp)
      const threeUp =
        threeRight.lengthSq() > 1e-8
          ? new THREE.Vector3().crossVectors(threeRight.normalize(), threeDirection).normalize()
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

      // 一次性调试日志（验证同步是否工作）
      if (!this._debugLogged) {
        this._debugLogged = true
        const stats = this.threeRenderer.getStats()
        console.log('[CesiumThreeBridge] 首次相机同步', {
          cameraPos: {
            x: threePosition.x.toFixed(1),
            y: threePosition.y.toFixed(1),
            z: threePosition.z.toFixed(1)
          },
          distance: threePosition.length().toFixed(1),
          fov,
          aspect,
          near,
          far: Math.min(50000, far),
          particles: stats?.total
        })
      }

      // 仅渲染场景（粒子模拟由时间轴通过 seekTo 驱动，不再使用真实 deltaTime）
      this.threeRenderer.renderFrame()
    } catch (err) {
      console.error('[CesiumThreeBridge] 同步相机失败:', err)
      this._active = false
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
