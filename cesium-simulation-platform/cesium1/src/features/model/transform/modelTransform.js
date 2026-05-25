import * as Cesium from 'cesium'

// 默认初始位置和变换
export const DEFAULT_POSITION = {
  longitude: 113.323,
  latitude: 23.106,
  height: -26
}

export const DEFAULT_TRANSFORM = {
  rotationX: 15,
  rotationY: 0,
  rotationZ: 0
}

/**
 * 基于本地ENU坐标系的模型变换工具
 */

/**
 * 旋转模型
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @param {number} rx - X轴旋转角度（度）
 * @param {number} ry - Y轴旋转角度（度）
 * @param {number} rz - Z轴旋转角度（度）
 * @param {Cesium.Cartesian3} [center] - 旋转中心，如果不提供则使用tileset.boundingSphere.center
 */
export function rotate(tileset, rx, ry, rz, center = null) {
  if (rx === 0 && ry === 0 && rz === 0) return

  const origin = center || tileset.boundingSphere.center
  const toWorldMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin)
  const toLocalMatrix = Cesium.Matrix4.inverse(toWorldMatrix, new Cesium.Matrix4())
  const rotateMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)

  if (rx !== 0) {
    const rotateXMatrix = Cesium.Matrix4.fromRotation(
      Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(rx))
    )
    Cesium.Matrix4.multiply(rotateXMatrix, rotateMatrix, rotateMatrix)
  }

  if (ry !== 0) {
    const rotateYMatrix = Cesium.Matrix4.fromRotation(
      Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(ry))
    )
    Cesium.Matrix4.multiply(rotateYMatrix, rotateMatrix, rotateMatrix)
  }

  if (rz !== 0) {
    const rotateZMatrix = Cesium.Matrix4.fromRotation(
      Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(rz))
    )
    Cesium.Matrix4.multiply(rotateZMatrix, rotateMatrix, rotateMatrix)
  }

  const localResultMatrix = Cesium.Matrix4.multiply(
    rotateMatrix,
    toLocalMatrix,
    new Cesium.Matrix4()
  )
  const worldResultMatrix = Cesium.Matrix4.multiply(
    toWorldMatrix,
    localResultMatrix,
    new Cesium.Matrix4()
  )

  tileset.modelMatrix = Cesium.Matrix4.multiply(
    worldResultMatrix,
    tileset.modelMatrix,
    new Cesium.Matrix4()
  )
}

/**
 * 将模型移动到指定经纬高位置
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @param {number} longitude - 经度
 * @param {number} latitude - 纬度
 * @param {number} height - 高度
 * @param {Cesium.Cartesian3} [originalCenter] - 可选：原始包围球中心（世界坐标），如果提供则忽略tileset当前的boundingSphere
 */
export function moveModelToPosition(tileset, longitude, latitude, height, originalCenter = null) {
  if (!tileset) return

  try {
    const targetPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, height)
    const center = originalCenter || tileset.boundingSphere.center
    const offset = Cesium.Cartesian3.subtract(targetPosition, center, new Cesium.Cartesian3())
    const translationMatrix = Cesium.Matrix4.fromTranslation(offset)

    tileset.modelMatrix = Cesium.Matrix4.multiply(
      translationMatrix,
      tileset.modelMatrix,
      new Cesium.Matrix4()
    )
  } catch (error) {
    console.error('移动模型失败:', error)
  }
}

/**
 * 应用完整的模型变换
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @param {Cesium.Matrix4} originalModelMatrix - 原始模型矩阵
 * @param {Object} position - 位置对象
 * @param {Object} transform - 变换对象
 * @param {Cesium.Cartesian3} [originalCenter] - 可选：原始包围球中心
 */
export function applyModelTransform(
  tileset,
  originalModelMatrix,
  position,
  transform,
  originalCenter = null
) {
  if (!tileset || !originalModelMatrix) return

  try {
    // 重置模型矩阵到原始状态
    tileset.modelMatrix = Cesium.Matrix4.clone(originalModelMatrix)

    let currentCenter = originalCenter || tileset.boundingSphere.center

    // 将模型移动到指定位置
    if (
      position &&
      position.longitude !== undefined &&
      position.latitude !== undefined &&
      position.height !== undefined
    ) {
      // 记录移动后的目标中心点，用于后续旋转
      currentCenter = Cesium.Cartesian3.fromDegrees(
        position.longitude,
        position.latitude,
        position.height
      )
      moveModelToPosition(
        tileset,
        position.longitude,
        position.latitude,
        position.height,
        originalCenter
      )
    }

    // 应用旋转
    if (
      transform &&
      transform.rotationX !== undefined &&
      transform.rotationY !== undefined &&
      transform.rotationZ !== undefined
    ) {
      // 使用当前中心点进行旋转，避免因boundingSphere未更新导致的位移
      rotate(tileset, transform.rotationX, transform.rotationY, transform.rotationZ, currentCenter)
    }
  } catch (error) {
    console.error('应用模型变换失败:', error)
  }
}
