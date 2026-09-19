/**
 * 相机/视角控制器（CameraViewController）
 *
 * 从 ThreeBlastingRenderer（门面）按职责域拆分的组合控制器之一，负责：
 *  - syncCamera：Cesium-Three 桥接器每帧相机同步（方向/上方向直构姿态，
 *    复用 _camScratch 预分配对象避免每帧 new 导致 GC 压力）
 *  - resize/resizeTo/_applySize：renderer/camera.aspect/bloomComposer/
 *    等值线 LineMaterial 分辨率四者同步
 *  - setCameraView/setupCameraView/setCameraViewMode：相机跳转与
 *    'interior'/'exterior' 视角预设
 *  - startStandaloneMode/stopStandaloneMode/startRenderLoop/stopRenderLoop：
 *    独立 Three.js 模式（OrbitControls 鼠标/触摸映射 + RAF 渲染循环）
 *
 * 职责边界：
 *  - 不持有任何状态：camera、_orbitControls、_camScratch、_lastCameraSyncMs、
 *    _standalone、_renderLoopRaf、bloomComposer、container 等仍全部保存在
 *    门面实例上，经 this.r 访问。
 *  - 与其他控制器互不引用；门面保留全部同名公共委托入口（窗口 resize 事件
 *    监听仍在门面构造函数中注册，经门面 resize 委托到本控制器）。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export class CameraViewController {
  /**
   * @param {ThreeBlastingRenderer} renderer - 门面渲染器实例（经 this.r 访问门面状态与公共方法）
   */
  constructor(renderer) {
    this.r = renderer
  }

  resize() {
    const width = this.r.container.clientWidth || window.innerWidth
    const height = this.r.container.clientHeight || window.innerHeight
    this._applySize(width, height)
  }

  /**
   * 显式指定尺寸进行 resize（供 CesiumThreeBridge 用 Cesium canvas 尺寸同步）
   * 同步 renderer / camera.aspect / bloomComposer 三者，避免任一遗漏导致模糊或错位
   * @param {number} width
   * @param {number} height
   */
  resizeTo(width, height) {
    const w = Math.max(1, width || 0)
    const h = Math.max(1, height || 0)
    this._applySize(w, h)
  }

  _applySize(width, height) {
    this.r.renderer.setSize(width, height)
    this.r.camera.aspect = width / height
    this.r.camera.updateProjectionMatrix()
    if (this.r.bloomComposer) {
      this.r.bloomComposer.setSize(width, height)
      // 同步 pixelRatio，防止 EffectComposer 渲染目标分辨率与 renderer 不一致导致模糊
      this.r.bloomComposer.setPixelRatio(this.r.renderer.getPixelRatio())
    }
    // 等值线 LineMaterial 像素线宽依赖视口分辨率，随 resize 同步
    this.r._sceneBuilder?.setContourResolution?.(width, height)
  }

  /**
   * 同步相机参数（由 Cesium-Three 桥接器调用）
   * @param {THREE.Vector3} position - 相机位置
   * @param {THREE.Vector3} direction - 视线方向
   * @param {THREE.Vector3} up - 上方向
   * @param {number} fov - 视场角（度）
   * @param {number} aspect - 宽高比
   * @param {number} near - 近裁剪面
   * @param {number} far - 远裁剪面
   */
  syncCamera(position, direction, up, fov, aspect, near, far) {
    this.r._lastCameraSyncMs = performance.now()
    this.r.camera.fov = fov
    this.r.camera.aspect = aspect
    this.r.camera.near = near
    this.r.camera.far = far
    this.r.camera.position.copy(position)
    this.r.camera.up.copy(up)

    // 使用方向/上方向直接构造相机姿态，避免大坐标下 lookAt 的精度损失。
    // 复用预分配 scratch 对象，避免每帧 new 导致 GC 压力
    const s = this.r._camScratch
    s.forward.copy(direction).normalize()
    s.cameraZ.copy(s.forward).negate()
    s.cameraX.crossVectors(up, s.cameraZ).normalize()
    s.cameraY.crossVectors(s.cameraZ, s.cameraX).normalize()
    s.rotationMatrix.makeBasis(s.cameraX, s.cameraY, s.cameraZ)
    this.r.camera.quaternion.setFromRotationMatrix(s.rotationMatrix)
    this.r.camera.updateMatrixWorld(true)
    this.r.camera.updateProjectionMatrix()
  }

  /**
   * 启动独立 Three.js 模式：不依赖 Cesium，使用 OrbitControls + RAF 渲染循环。
   * 相机由用户通过鼠标直接操控 Three.js 画布，不再每帧同步 Cesium 相机。
   */
  startStandaloneMode() {
    this.r._standalone = true
    // 确保画布尺寸正确（不再由 Cesium preRender 的 _syncCamera 调用 resizeTo）
    this.resize()
    if (!this.r._orbitControls) {
      this.r._orbitControls = new OrbitControls(this.r.camera, this.r.renderer.domElement)
      this.r._orbitControls.enableDamping = true
      this.r._orbitControls.dampingFactor = 0.08
      this.r._orbitControls.maxDistance = 300
      this.r._orbitControls.minDistance = 2
      this.r._orbitControls.target.copy(this.r.center)
      // 鼠标映射与非爆破模式（Cesium 相机）保持一致：
      // 左键 → 平移（拖拽模型前后左右），中键 → 旋转视角，右键/滚轮 → 缩放
      this.r._orbitControls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.DOLLY
      }
      // 触摸手势：单指平移，双指缩放旋转
      this.r._orbitControls.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_ROTATE
      }
      // OrbitControls change 事件 → 更新 _lastCameraSyncMs，
      // 使 renderFrame 中的相机移动检测生效（跳过 bloom）
      this.r._orbitControls.addEventListener('change', () => {
        this.r._lastCameraSyncMs = performance.now()
      })
    }
    this.startRenderLoop()
  }

  stopStandaloneMode() {
    this.r._standalone = false
    this.stopRenderLoop()
  }

  startRenderLoop() {
    if (this.r._renderLoopRaf) return
    const loop = () => {
      this.r._renderLoopRaf = requestAnimationFrame(loop)
      try {
        if (this.r._orbitControls) this.r._orbitControls.update()
        this.r.renderFrame()
      } catch (err) {
        // 任何组件抛异常都不能中断渲染循环，否则画面冻结且日志丢失
        console.error('[ThreeBlastingRenderer] 渲染帧异常已捕获:', err)
      }
    }
    this.r._renderLoopRaf = requestAnimationFrame(loop)
  }

  stopRenderLoop() {
    if (this.r._renderLoopRaf) {
      cancelAnimationFrame(this.r._renderLoopRaf)
      this.r._renderLoopRaf = null
    }
  }

  /**
   * 直接设置相机位置和朝向（跳转，非飞行）
   * @param {THREE.Vector3|number[]} position - 相机位置
   * @param {THREE.Vector3|number[]} target - 观察目标点
   */
  setCameraView(position, target) {
    this.r.camera.position.set(
      position.x ?? position[0],
      position.y ?? position[1],
      position.z ?? position[2]
    )
    const tx = target.x ?? target[0]
    const ty = target.y ?? target[1]
    const tz = target.z ?? target[2]
    this.r.camera.lookAt(tx, ty, tz)
    if (this.r._orbitControls) {
      this.r._orbitControls.target.set(tx, ty, tz)
      this.r._orbitControls.update()
    }
  }

  /**
   * 根据隧道尺寸和面方向计算并设置相机视角（跳转到隧道内部，面朝掌子面）
   * 使用 THREE.Vector3.crossVectors 确保方向正确
   */
  setupCameraView(tunnelLength, wallHeight) {
    const cameraDist = tunnelLength > 0 ? tunnelLength * 0.7 : 55
    const eyeHeight = wallHeight > 0 ? wallHeight : 6

    const dir = this.r.faceDirection.clone().normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    // 相机位置：center - forward * cameraDist + up * eyeHeight（隧道内部，掌子面后方）
    const pos = new THREE.Vector3()
      .copy(this.r.center)
      .addScaledVector(forward, -cameraDist)
      .addScaledVector(up, eyeHeight)
    // 观察目标：掌子面中心 = center + forward * 3
    const target = new THREE.Vector3().copy(this.r.center).addScaledVector(forward, 3)

    this.setCameraView(pos, target)
  }

  /**
   * 切换爆破三维观察视角预设：
   *  - 'interior'：隧道内部视角（掌子面后方，面朝掌子面，默认）
   *  - 'exterior'：外部测区视角（抬高、后移并略带侧偏，框住掌子面与抛掷/爆堆范围）
   * @param {string} mode - 'interior' | 'exterior'
   * @param {Object} [opts] - { tunnelLength, wallHeight }，缺省取隧道当前断面
   */
  setCameraViewMode(mode, opts = {}) {
    const tunnelLength = Number(opts.tunnelLength) > 0 ? Number(opts.tunnelLength) : 0
    const wallHeight =
      Number(opts.wallHeight) > 0 ? Number(opts.wallHeight) : this.r.tunnelWallHeight || 0
    const cameraDist = tunnelLength > 0 ? tunnelLength * 0.7 : 55
    const eyeHeight = wallHeight > 0 ? wallHeight : 6

    const dir = this.r.faceDirection.clone().normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(dir, up).normalize()
    const forward = new THREE.Vector3().crossVectors(up, right).normalize()

    let pos
    let target
    if (mode === 'exterior') {
      // 外部测区视角：后退更远、抬高更高、略带侧偏，能整体看到掌子面、
      // 抛掷方向与爆堆形成区域
      pos = new THREE.Vector3()
        .copy(this.r.center)
        .addScaledVector(forward, -cameraDist * 1.6)
        .addScaledVector(up, eyeHeight * 2.7)
        .addScaledVector(right, -cameraDist * 0.38)
      target = new THREE.Vector3().copy(this.r.center).addScaledVector(forward, 16)
    } else {
      // 隧道内部视角：掌子面后方，面朝掌子面（默认）
      pos = new THREE.Vector3()
        .copy(this.r.center)
        .addScaledVector(forward, -cameraDist)
        .addScaledVector(up, eyeHeight)
      target = new THREE.Vector3().copy(this.r.center).addScaledVector(forward, 3)
    }

    this.setCameraView(pos, target)
  }
}
