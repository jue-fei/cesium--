import * as Cesium from 'cesium'

/**
 * Scenario Manager - 虚拟场景仿真管理类
 * 负责设备部署、工序调整、拖拽交互
 */
export class ScenarioManager {
  constructor(viewer) {
    if (!viewer) throw new Error('Viewer is required for ScenarioManager')
    this.viewer = viewer
    this.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.deployedEntities = []
    this.isEditing = false
    this.selectedEntity = null
    this.dragActive = false
  }

  /**
   * 开启编辑模式
   */
  enableEditing() {
    this.isEditing = true
    this.setupInputHandler()
  }

  /**
   * 关闭编辑模式
   */
  disableEditing() {
    this.isEditing = false
    this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOWN)
    this.handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_UP)
  }

  setupInputHandler() {
    // 鼠标按下：选择实体
    this.handler.setInputAction(click => {
      if (!this.isEditing) return

      const pickedObject = this.viewer.scene.pick(click.position)
      if (
        Cesium.defined(pickedObject) &&
        pickedObject.id &&
        this.deployedEntities.includes(pickedObject.id)
      ) {
        this.selectedEntity = pickedObject.id
        this.dragActive = true
        this.viewer.scene.screenSpaceCameraController.enableRotate = false // 禁用相机旋转
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    // 鼠标移动：拖拽实体
    this.handler.setInputAction(movement => {
      if (this.isEditing && this.dragActive && this.selectedEntity) {
        const cartesian = this.viewer.camera.pickEllipsoid(
          movement.endPosition,
          this.viewer.scene.globe.ellipsoid
        )
        if (cartesian) {
          this.selectedEntity.position = cartesian
        }
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // 鼠标抬起：结束拖拽
    this.handler.setInputAction(() => {
      if (this.dragActive) {
        this.dragActive = false
        this.selectedEntity = null
        this.viewer.scene.screenSpaceCameraController.enableRotate = true // 恢复相机旋转
      }
    }, Cesium.ScreenSpaceEventType.LEFT_UP)
  }

  /**
   * 部署新设备
   * @param {String} type 设备类型
   */
  deployEquipment(type) {
    // 获取当前相机中心位置
    const center = this.viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(this.viewer.canvas.width / 2, this.viewer.canvas.height / 2)
    )

    if (!center) return

    const entity = this.viewer.entities.add({
      position: center,
      model: {
        uri: '/dist/3d/demo1/NoLod_0.glb', // 临时使用现有模型，实际应根据type加载不同模型
        minimumPixelSize: 64,
        maximumScale: 20000,
        color: Cesium.Color.WHITE // 混合颜色以区分类型
      },
      label: {
        text: `${type} (可拖拽)`,
        font: '14px sans-serif',
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -50)
      }
    })

    // 根据类型设置颜色模拟不同设备
    if (type === 'Excavator') entity.model.color = Cesium.Color.YELLOW
    if (type === 'Truck') entity.model.color = Cesium.Color.BLUE
    if (type === 'Drill') entity.model.color = Cesium.Color.RED

    this.deployedEntities.push(entity)
    return entity
  }

  clearScene() {
    this.deployedEntities.forEach(e => this.viewer.entities.remove(e))
    this.deployedEntities = []
  }
}
