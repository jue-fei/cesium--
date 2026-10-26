import * as Cesium from 'cesium'

/**
 * 基于本地ENU坐标系的模型变换工具
 */

/**
 * 判断 tileset 是否自带地理定位（root.transform 平移为 ECEF 地心距量级）。
 * 自带定位的模型位置/姿态已内嵌于数据，面板变换应按"相对锚点偏移"语义处理。
 * @param {Cesium.Cesium3DTileset} tileset
 * @returns {boolean}
 */
export function isGeoreferencedTileset(tileset) {
  try {
    const t = tileset.root && tileset.root.transform
    if (!t) return false
    const mag = Math.hypot(t[12], t[13], t[14])
    return mag > 6.0e6
  } catch (error) {
    return false
  }
}

/**
 * 读取自带地理定位模型的锚点经纬高（root.transform 平移向量 = 模型本地原点的 ECEF）。
 * @param {Cesium.Cesium3DTileset} tileset
 * @returns {{longitude:number, latitude:number, height:number}|null}
 */
export function georeferencedAnchor(tileset) {
  try {
    const t = tileset.root && tileset.root.transform
    if (!t) return null
    const carto = Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(t[12], t[13], t[14])
    )
    if (!carto) return null
    return {
      longitude: Cesium.Math.toDegrees(carto.longitude),
      latitude: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height
    }
  } catch (error) {
    return null
  }
}

/**
 * 读取聚合 tileset 内嵌的"地表锚点"本地坐标（asset.extras.surfaceAnchorLocal）。
 * 该点是模型地表参考点（海拔基准），terrain 贴合校正与面板锚定都以它为准。
 * @param {Cesium.Cesium3DTileset} tileset
 * @returns {number[]|null} [x, y, z] mine 本地坐标
 */
export function surfaceAnchorLocal(tileset) {
  try {
    const ex = tileset.asset && tileset.asset.extras
    const a = ex && ex.surfaceAnchorLocal
    return Array.isArray(a) && a.length === 3 ? a : null
  } catch (error) {
    return null
  }
}

/**
 * 计算地表锚点的世界坐标（modelMatrix × root.transform × local）。
 * @param {Cesium.Cesium3DTileset} tileset
 * @returns {Cesium.Cartesian3|null}
 */
export function surfaceAnchorWorld(tileset) {
  try {
    const local = surfaceAnchorLocal(tileset)
    if (!local) return null
    const root = tileset.root && tileset.root.transform
    if (!root) return null
    const M = Cesium.Matrix4.multiply(
      tileset.modelMatrix,
      Cesium.Matrix4.fromArray(root),
      new Cesium.Matrix4()
    )
    return Cesium.Matrix4.multiplyByPoint(
      M,
      new Cesium.Cartesian3(local[0], local[1], local[2]),
      new Cesium.Cartesian3()
    )
  } catch (error) {
    return null
  }
}

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

    // ===== 自带地表锚点的模型（聚合 tileset）：面板值 = 相对地表锚点的偏移 =====
    // 模型位置已内嵌于 root.transform，此处只做相对地表锚点的平移/旋转；
    // 面板初始值由加载器设为地表锚点经纬高，用户微调 height 即"贴地升降"。
    if (isGeoreferencedTileset(tileset) && surfaceAnchorLocal(tileset)) {
      const world = surfaceAnchorWorld(tileset)
      const carto = world && Cesium.Cartographic.fromCartesian(world)
      if (carto) {
        const anchor = {
          longitude: Cesium.Math.toDegrees(carto.longitude),
          latitude: Cesium.Math.toDegrees(carto.latitude),
          height: carto.height
        }
        let dLon = ((position && position.longitude) ?? anchor.longitude) - anchor.longitude
        let dLat = ((position && position.latitude) ?? anchor.latitude) - anchor.latitude
        const dH = ((position && position.height) ?? anchor.height) - anchor.height
        // 防御：跨配置残留的默认经纬度（如 demo 的广州坐标）不适用，归零避免"模型飞走"
        if (Math.abs(dLon) > 0.5 || Math.abs(dLat) > 0.5) {
          dLon = 0
          dLat = 0
        }
        const mPerDegLat = 111320
        const mPerDegLon = 111320 * Math.cos(carto.latitude)
        const eastM = dLon * mPerDegLon
        const northM = dLat * mPerDegLat

        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(world)
        const c0 = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4())
        const c1 = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4())
        const c2 = Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian4())
        const offset = new Cesium.Cartesian3(
          c0.x * eastM + c1.x * northM + c2.x * dH,
          c0.y * eastM + c1.y * northM + c2.y * dH,
          c0.z * eastM + c1.z * northM + c2.z * dH
        )
        tileset.modelMatrix = Cesium.Matrix4.multiply(
          Cesium.Matrix4.fromTranslation(offset),
          tileset.modelMatrix,
          new Cesium.Matrix4()
        )
        if (
          transform &&
          ((transform.rotationX || 0) !== 0 ||
            (transform.rotationY || 0) !== 0 ||
            (transform.rotationZ || 0) !== 0)
        ) {
          rotate(
            tileset,
            transform.rotationX || 0,
            transform.rotationY || 0,
            transform.rotationZ || 0,
            world
          )
        }
        return
      }
    }

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
