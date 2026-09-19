/**
 * 地下视角控制域（UndergroundViewController）
 *
 * 从 BlastingManager 拆出的"相机/视角"职责：
 *  - 地下事件（centerHeight<0）的地表/地下相机模式切换：关闭地形碰撞检测与
 *    地形深度测试、地球半透明，使地下视角移动控制与露天爆破一致（并在切回
 *    地表事件时恢复原状）；
 *  - three.js 相机视角预设/跳转（隧道内部视角直面掌子面、内部/外部预设切换）。
 * 经门面实例（this.m）访问共享状态（viewer、dataset、_threeRenderer），自身持有
 * 地下模式状态 _undergroundSavedState / _undergroundActive。
 */
export class UndergroundViewController {
  /** @param {import('../blastingManager.js').BlastingManager} manager 门面实例 */
  constructor(manager) {
    this.m = manager
    // 地下视角状态：地下事件（centerHeight<0）需禁用地形碰撞检测，否则相机被推回地表
    this._undergroundSavedState = null
    this._undergroundActive = false
  }

  /**
   * 切换爆破三维观察视角预设（内部/外部）
   * @param {'interior'|'exterior'} mode - 视角模式
   */
  setCameraViewMode(mode) {
    const renderer = this.m._threeRenderer
    if (!renderer?.setCameraViewMode) return
    const design = this.m.dataset?.design || {}
    renderer.setCameraViewMode(mode, {
      tunnelLength: Number(design.tunnelLength) || 0,
      wallHeight: Number(design.tunnelWallHeight) || 0
    })
  }

  /**
   * 根据爆心高度切换地表/地下相机模式。
   * 露天爆破（centerHeight>=0）相机位于地表上方，使用 Cesium 默认碰撞检测，
   * 视角移动控制平滑自然；地下爆破（centerHeight<0）相机位于地形之下，默认碰撞
   * 检测会把相机顶回地表，导致拖拽/缩放/倾斜时被"卡住"。此处对地下事件关闭碰撞
   * 检测与地形深度测试，并将地球设为半透明（参照 undergroundView.js 模式），
   * 使地下视角移动控制与露天爆破一致。
   */
  applyUndergroundViewIfNeeded() {
    if (!this.m.viewer?.scene) return
    const centerHeight = Number(this.m.dataset?.event?.centerHeight || 0)
    const isUnderground = centerHeight < 0
    const globe = this.m.viewer.scene.globe
    const controller = this.m.viewer.scene.screenSpaceCameraController
    if (!globe || !controller) return

    if (isUnderground && !this._undergroundActive) {
      // 保存原始状态（仅首次进入地下模式时保存，避免覆盖默认值）
      this._undergroundSavedState = {
        collisionDetection: controller.enableCollisionDetection,
        depthTestAgainstTerrain: globe.depthTestAgainstTerrain,
        translucencyEnabled: globe.translucency.enabled,
        frontFaceAlpha: globe.translucency.frontFaceAlpha,
        backFaceAlpha: globe.translucency.backFaceAlpha
      }
      // 关闭地形碰撞检测：相机可在地下自由移动，不再被推回地表
      controller.enableCollisionDetection = false
      // 关闭地形深度测试：地下实体（爆心标记等）不被地形遮挡
      globe.depthTestAgainstTerrain = false
      // 地球半透明：可透过地表看到地下隧道与爆破效果
      globe.translucency.enabled = true
      globe.translucency.frontFaceAlpha = 0.2
      globe.translucency.backFaceAlpha = 0.2
      this._undergroundActive = true
    } else if (!isUnderground && this._undergroundActive) {
      // 切换回地表事件：恢复默认相机控制
      this.m._restoreSurfaceView()
    }
  }

  /** 恢复地表视角的默认相机控制（关闭地下模式） */
  restoreSurfaceView() {
    if (!this._undergroundActive || !this.m.viewer?.scene) return
    const globe = this.m.viewer.scene.globe
    const controller = this.m.viewer.scene.screenSpaceCameraController
    const s = this._undergroundSavedState
    if (s) {
      controller.enableCollisionDetection = s.collisionDetection
      globe.depthTestAgainstTerrain = s.depthTestAgainstTerrain
      globe.translucency.enabled = s.translucencyEnabled
      globe.translucency.frontFaceAlpha = s.frontFaceAlpha
      globe.translucency.backFaceAlpha = s.backFaceAlpha
    }
    this._undergroundActive = false
  }

  /**
   * 直接设置 Three.js 相机到隧道内部视角（跳转，非飞行）
   * 相机位于隧道内部（掌子面后方），朝向掌子面观察
   */
  jumpToCameraView() {
    const renderer = this.m._threeRenderer
    if (!renderer?.setupCameraView) return
    const design = this.m.dataset?.design || {}
    const tunnelLen = Number(design.tunnelLength) || 0
    const wallH = Number(design.tunnelWallHeight) || 0
    renderer.setupCameraView(tunnelLen, wallH)
  }
}
