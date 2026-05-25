import * as Cesium from 'cesium'

/**
 * 判断拾取对象是否来自指定的 tileset。
 */
export function isPickedFromTileset(picked, targetTileset) {
  if (!picked || !targetTileset) return false
  if (picked.primitive === targetTileset) return true
  if (picked.tileset === targetTileset) return true
  if (picked.content?.tileset === targetTileset) return true
  if (picked.primitive?.tileset === targetTileset) return true
  if (picked.id?.tileset === targetTileset) return true
  return false
}

/**
 * 从 Cesium 视图的屏幕位置获取世界坐标（若点击在目标 tileset 上）。
 */
export function getPositionFromClick(viewer, screenPosition, targetTileset) {
  try {
    const picked = viewer.scene.pick(screenPosition)
    if (isPickedFromTileset(picked, targetTileset)) {
      const pos = viewer.scene.pickPosition(screenPosition)
      if (pos && Cesium.Cartesian3.distance(pos, Cesium.Cartesian3.ZERO) > 0) return pos
    }
    return null
  } catch (e) {
    return null
  }
}
