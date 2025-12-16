import * as Cesium from 'cesium'

/**
 * 基于本地ENU坐标系的模型变换工具
 */

/**
 * 旋转模型
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @param {number} rx - X轴旋转角度（度）
 * @param {number} ry - Y轴旋转角度（度）
 * @param {number} rz - Z轴旋转角度（度）
 */
export function rotate(tileset, rx, ry, rz) {
    if (rx === 0 && ry === 0 && rz === 0) return;

    const origin = tileset.boundingSphere.center;
    const toWorldMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const toLocalMatrix = Cesium.Matrix4.inverse(toWorldMatrix, new Cesium.Matrix4());

    const rotateMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

    if (rx !== 0) {
        const rotateXMatrix = Cesium.Matrix4.fromRotation(
            Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(rx))
        );
        Cesium.Matrix4.multiply(rotateXMatrix, rotateMatrix, rotateMatrix);
    }

    if (ry !== 0) {
        const rotateYMatrix = Cesium.Matrix4.fromRotation(
            Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(ry))
        );
        Cesium.Matrix4.multiply(rotateYMatrix, rotateMatrix, rotateMatrix);
    }

    if (rz !== 0) {
        const rotateZMatrix = Cesium.Matrix4.fromRotation(
            Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(rz))
        );
        Cesium.Matrix4.multiply(rotateZMatrix, rotateMatrix, rotateMatrix);
    }

    const localResultMatrix = Cesium.Matrix4.multiply(rotateMatrix, toLocalMatrix, new Cesium.Matrix4());
    const worldResultMatrix = Cesium.Matrix4.multiply(toWorldMatrix, localResultMatrix, new Cesium.Matrix4());

    tileset.modelMatrix = Cesium.Matrix4.multiply(worldResultMatrix, tileset.modelMatrix, new Cesium.Matrix4());
}

/**
 * 将模型移动到指定经纬高位置
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @param {number} longitude - 经度
 * @param {number} latitude - 纬度
 * @param {number} height - 高度
 */
export function moveModelToPosition(tileset, longitude, latitude, height) {
    if (!tileset) return;

    try {
        const targetPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, height);
        const originalCenter = tileset.boundingSphere.center;
        const offset = Cesium.Cartesian3.subtract(targetPosition, originalCenter, new Cesium.Cartesian3());
        const translationMatrix = Cesium.Matrix4.fromTranslation(offset);

        tileset.modelMatrix = Cesium.Matrix4.multiply(translationMatrix, tileset.modelMatrix, new Cesium.Matrix4());
    } catch (error) {
        console.error("移动模型失败:", error);
    }
}

/**
 * 应用完整的模型变换
 * @param {Cesium.Cesium3DTileset} tileset - 3D瓦片集
 * @param {Cesium.Matrix4} originalModelMatrix - 原始模型矩阵
 * @param {Object} position - 位置对象
 * @param {Object} transform - 变换对象
 */
export function applyModelTransform(tileset, originalModelMatrix, position, transform) {
    if (!tileset || !originalModelMatrix) return;

    try {
        // 重置模型矩阵到原始状态
        tileset.modelMatrix = Cesium.Matrix4.clone(originalModelMatrix);

        // 将模型移动到指定位置
        moveModelToPosition(tileset, position.longitude, position.latitude, position.height);

        // 应用旋转
        rotate(tileset, transform.rotationX, transform.rotationY, transform.rotationZ);

        console.log('模型变换已应用');
    } catch (error) {
        console.error("应用模型变换失败:", error);
    }
}