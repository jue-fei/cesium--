import * as Cesium from 'cesium'

export function createPolygonHandlerController() {
  let polygonHandler = null

  function removePolygonHandler() {
    if (polygonHandler && !polygonHandler.isDestroyed()) {
      polygonHandler.destroy()
    }
    polygonHandler = null
  }

  function setupPolygonHandler({ viewer, manager, onLeftClick, onMouseMove, onRightClick }) {
    removePolygonHandler()
    if (!viewer || !manager) return null

    polygonHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    polygonHandler.setInputAction(movement => {
      manager.handleMouseClick(movement)
      if (typeof onLeftClick === 'function') onLeftClick(manager, movement)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    polygonHandler.setInputAction(movement => {
      manager.handleMouseMove(movement)
      if (typeof onMouseMove === 'function') onMouseMove(manager, movement)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    polygonHandler.setInputAction(() => {
      if (typeof onRightClick === 'function') onRightClick(manager)
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

    return polygonHandler
  }

  return {
    setupPolygonHandler,
    removePolygonHandler
  }
}
