/**
 * 体网格生成（自 localVibrationSimulator.js 拆分，纯搬运）
 *
 * buildPpvGrid：覆盖隧道断面范围沿轴向扩展的 3D 网格坐标，
 * 输出按 WebGL Data3DTexture 轴序（x-最快，z-最慢）排列，
 * 支持显式边界与后端 WS 网格对齐。
 */

/**
 * 生成 3D 网格坐标（X, Y, Z），覆盖隧道断面范围沿轴向扩展
 * @param {number} tunnelWidth - 隧道宽度(m)，横向(X)范围 [-w/2, w/2]
 * @param {number} tunnelHeight - 隧道总高度(m)，竖向(Y)范围 [-h/2, h/2]
 * @param {number} lengthZ - 沿隧道轴向(Z)长度(m)，范围 [0, lengthZ]
 * @param {number} nx - X 方向网格数
 * @param {number} ny - Y 方向网格数
 * @param {number} nz - Z 方向网格数
 * @param {Object} [explicitBounds] - 显式边界覆盖 { boundsMin: [x,y,z], boundsMax: [x,y,z] }，
 *                用于与后端 WS 网格完全对齐（后端 y 边界非对称：[-0.2h, 1.2h]）
 * @returns {Object} { gridXyz: Float32Array(n*3), gridShape: [nx,ny,nz], boundsMin: [xmin,ymin,zmin], boundsMax: [xmax,ymax,zmax] }
 */
export function buildPpvGrid(
  tunnelWidth,
  tunnelHeight,
  lengthZ = 40,
  nx = 32,
  ny = 32,
  nz = 64,
  explicitBounds = null
) {
  let xMin = -tunnelWidth / 2
  let xMax = tunnelWidth / 2
  let yMin = -tunnelHeight / 2
  let yMax = tunnelHeight / 2
  let zMin = 0
  let zMax = lengthZ
  if (explicitBounds?.boundsMin && explicitBounds?.boundsMax) {
    xMin = explicitBounds.boundsMin[0]
    yMin = explicitBounds.boundsMin[1]
    zMin = explicitBounds.boundsMin[2]
    xMax = explicitBounds.boundsMax[0]
    yMax = explicitBounds.boundsMax[1]
    zMax = explicitBounds.boundsMax[2]
  }

  const gridShape = [nx, ny, nz]
  const nTotal = nx * ny * nz
  const gridXyz = new Float32Array(nTotal * 3)

  let idx = 0
  for (let zi = 0; zi < nz; zi++) {
    const z = zMin + ((zMax - zMin) * (zi + 0.5)) / nz
    for (let yi = 0; yi < ny; yi++) {
      const y = yMin + ((yMax - yMin) * (yi + 0.5)) / ny
      for (let xi = 0; xi < nx; xi++) {
        const x = xMin + ((xMax - xMin) * (xi + 0.5)) / nx
        gridXyz[idx * 3 + 0] = x
        gridXyz[idx * 3 + 1] = y
        gridXyz[idx * 3 + 2] = z
        idx++
      }
    }
  }

  return {
    gridXyz,
    gridShape,
    boundsMin: [xMin, yMin, zMin],
    boundsMax: [xMax, yMax, zMax]
  }
}
