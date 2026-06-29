/**
 * 八叉树空间索引 —— 用于爆破粒子碰撞检测
 *
 * 将 3D 空间递归划分为 8 个子立方体，
 * 支持动态插入与半径查询，避免 O(n²) 暴力遍历。
 */

const MIN_HALF_SIZE = 0.5
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_OBJECTS = 16

/**
 * @typedef {{ x: number, y: number, z: number, radius?: number, data?: any }} OctreePoint
 */

class OctreeNode {
  constructor(centerX, centerY, centerZ, halfSize, depth = 0) {
    this.cx = centerX
    this.cy = centerY
    this.cz = centerZ
    this.halfSize = halfSize
    this.depth = depth
    this.children = null
    /** @type {OctreePoint[]} */
    this.points = []
  }

  contains(point) {
    return (
      point.x >= this.cx - this.halfSize &&
      point.x <= this.cx + this.halfSize &&
      point.y >= this.cy - this.halfSize &&
      point.y <= this.cy + this.halfSize &&
      point.z >= this.cz - this.halfSize &&
      point.z <= this.cz + this.halfSize
    )
  }

  subdivide() {
    if (this.children) return
    const h = this.halfSize / 2
    const d = this.depth + 1
    this.children = [
      new OctreeNode(this.cx - h, this.cy - h, this.cz - h, h, d),
      new OctreeNode(this.cx + h, this.cy - h, this.cz - h, h, d),
      new OctreeNode(this.cx - h, this.cy + h, this.cz - h, h, d),
      new OctreeNode(this.cx + h, this.cy + h, this.cz - h, h, d),
      new OctreeNode(this.cx - h, this.cy - h, this.cz + h, h, d),
      new OctreeNode(this.cx + h, this.cy - h, this.cz + h, h, d),
      new OctreeNode(this.cx - h, this.cy + h, this.cz + h, h, d),
      new OctreeNode(this.cx + h, this.cy + h, this.cz + h, h, d)
    ]
    // 将当前节点上的点重新分配到子节点
    const oldPoints = this.points
    this.points = []
    for (const p of oldPoints) {
      for (const child of this.children) {
        if (child.contains(p)) {
          child.points.push(p)
          break
        }
      }
    }
  }

  insert(point, maxObjects, maxDepth) {
    if (!this.contains(point)) return false

    if (!this.children && (this.points.length < maxObjects || this.depth >= maxDepth)) {
      this.points.push(point)
      return true
    }

    if (!this.children) this.subdivide()

    for (const child of this.children) {
      if (child.insert(point, maxObjects, maxDepth)) return true
    }

    // 边界情况：点在分界面上，直接存当前节点
    this.points.push(point)
    return true
  }

  /**
   * 查询球体内的所有点
   * @param {number} cx - 球心 x
   * @param {number} cy - 球心 y
   * @param {number} cz - 球心 z
   * @param {number} radius - 查询半径
   * @param {OctreePoint[]} results - 结果数组
   */
  queryRadius(cx, cy, cz, radius, results) {
    // 包围盒不相交则剪枝
    const dx = Math.max(0, Math.abs(cx - this.cx) - this.halfSize)
    const dy = Math.max(0, Math.abs(cy - this.cy) - this.halfSize)
    const dz = Math.max(0, Math.abs(cz - this.cz) - this.halfSize)
    const distSq = dx * dx + dy * dy + dz * dz
    if (distSq > radius * radius) return

    const r2 = radius * radius
    for (const p of this.points) {
      const ddx = p.x - cx
      const ddy = p.y - cy
      const ddz = p.z - cz
      if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) {
        results.push(p)
      }
    }

    if (this.children) {
      for (const child of this.children) {
        child.queryRadius(cx, cy, cz, radius, results)
      }
    }
  }

  clear() {
    this.points = []
    if (this.children) {
      for (const child of this.children) child.clear()
      this.children = null
    }
  }

  count() {
    let n = this.points.length
    if (this.children) {
      for (const child of this.children) n += child.count()
    }
    return n
  }
}

export class Octree {
  constructor(centerX, centerY, centerZ, halfSize, options = {}) {
    this.root = new OctreeNode(
      centerX,
      centerY,
      centerZ,
      Math.max(MIN_HALF_SIZE, halfSize),
      0
    )
    this.maxObjects = options.maxObjects || DEFAULT_MAX_OBJECTS
    this.maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH
  }

  insert(point) {
    return this.root.insert(point, this.maxObjects, this.maxDepth)
  }

  insertBatch(points) {
    for (const p of points) this.insert(p)
  }

  queryRadius(cx, cy, cz, radius) {
    const results = []
    this.root.queryRadius(cx, cy, cz, radius, results)
    return results
  }

  clear() {
    this.root.clear()
  }

  get size() {
    return this.root.count()
  }
}

export default Octree
