/**
 * 岩石几何体工厂
 *
 * 生成 5 种形态的实体碎石 3D 网格，用于 InstancedMesh 实例化渲染。
 * 每种形态预生成多个子变体（不同 seed），总计约 15 个几何体。
 *
 * 变体分类：
 *   0 - 块状岩块（大块碎石）：BoxGeometry + 顶点大幅随机偏移，棱角分明
 *   1 - 扁平板状岩片（中块碎石）：极度扁平 BoxGeometry，模拟层理断裂
 *   2 - 楔形碎块（中小碎石）：ConvexGeometry 凸包，前薄后厚
 *   3 - 不规则多面体（小块碎石）：DodecahedronGeometry + 大范围顶点扰动
 *   4 - 长条状碎块（特殊形态）：CylinderGeometry + 非均匀缩放
 *
 * variantIndex 与碎块尺寸的关联由 fragmentSpecGenerator.js 中的
 * _selectVariantBySize() 函数实现。
 */

import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'

// ─── 确定性伪随机数生成器（LCG） ────────────────────────
function makeRng(seed) {
  let s = (seed + 1) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ─── 变体 0：块状岩块 ──────────────────────────────────
// 真实感最强：8 个角顶点大幅偏移产生不规则块状外观
function createBlockyRockGeometry(seed) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)
  const positions = geo.attributes.position
  const rng = makeRng(seed)

  // 识别角顶点：BoxGeometry(2,2,2) 中坐标绝对值接近 0.5 的为角
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i)
    const y = positions.getY(i)
    const z = positions.getZ(i)
    const isCorner = Math.abs(x) > 0.35 && Math.abs(y) > 0.35 && Math.abs(z) > 0.35
    // 角顶点大幅偏移(0.4~1.4)，面内顶点小幅偏移(0.8~1.1)
    const factor = isCorner
      ? (0.4 + rng() * 1.0)
      : (0.8 + rng() * 0.3)
    positions.setXYZ(i, x * factor, y * factor, z * factor)
  }
  geo.computeVertexNormals()
  return geo
}

// ─── 变体 1：扁平板状岩片 ──────────────────────────────
// Y 轴极度压缩(0.12~0.25)，模拟层理断裂产生的板状碎块
function createPlatyRockGeometry(seed) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 3, 1, 3)
  const positions = geo.attributes.position
  const rng = makeRng(seed)

  const flatten = 0.12 + rng() * 0.13 // Y 压缩到 0.12~0.25
  const stretchX = 1.0 + rng() * 0.6
  const stretchZ = 1.0 + rng() * 0.6

  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i)
    const y = positions.getY(i)
    const z = positions.getZ(i)
    // 面内顶点扰动
    const jitter = 0.85 + rng() * 0.3
    // 断裂纹：沿对角线方向微凹
    const crackBias = Math.abs(x + z) < 0.15 ? 0.85 : 1.0
    positions.setXYZ(
      i,
      x * stretchX * jitter * crackBias,
      y * flatten * (0.9 + rng() * 0.2),
      z * stretchZ * jitter * crackBias
    )
  }
  geo.computeVertexNormals()
  return geo
}

// ─── 变体 2：楔形碎块 ──────────────────────────────────
// 使用 ConvexGeometry 从 6-8 个随机 3D 点生成凸包，前薄后厚
function createWedgeRockGeometry(seed) {
  const rng = makeRng(seed)
  const points = []
  // 后端（厚端）：4 点，Z 正方向
  points.push(new THREE.Vector3(-0.6 - rng() * 0.3, 0.4 + rng() * 0.2, 0.4 + rng() * 0.2))
  points.push(new THREE.Vector3(0.6 + rng() * 0.3, 0.4 + rng() * 0.2, 0.3 + rng() * 0.2))
  points.push(new THREE.Vector3(-0.5 - rng() * 0.2, -0.4 - rng() * 0.2, 0.3 + rng() * 0.2))
  points.push(new THREE.Vector3(0.5 + rng() * 0.2, -0.4 - rng() * 0.2, 0.4 + rng() * 0.2))
  // 前端（薄端）：2-3 点，Z 负方向，Y 幅度小
  points.push(new THREE.Vector3(-0.2 - rng() * 0.15, 0.15 + rng() * 0.1, -0.5 - rng() * 0.2))
  points.push(new THREE.Vector3(0.2 + rng() * 0.15, 0.15 + rng() * 0.1, -0.5 - rng() * 0.2))
  points.push(new THREE.Vector3(rng() * 0.1 - 0.05, -0.1 - rng() * 0.1, -0.4 - rng() * 0.2))

  const geo = new ConvexGeometry(points)
  geo.computeVertexNormals()
  return geo
}

// ─── 变体 3：不规则多面体 ──────────────────────────────
// 基于 DodecahedronGeometry(1,0)，12 面体逐顶点大范围随机扰动
function createIrregularRockGeometry(seed) {
  const geo = new THREE.DodecahedronGeometry(1, 0)
  const positions = geo.attributes.position
  const rng = makeRng(seed)

  // 非均匀轴缩放
  const scaleX = 0.7 + rng() * 0.8
  const scaleY = 0.5 + rng() * 0.8
  const scaleZ = 0.7 + rng() * 0.8

  for (let i = 0; i < positions.count; i++) {
    // 大范围逐顶点随机(0.3~1.7)，产生尖锐棱角
    const factor = 0.3 + rng() * 1.4
    positions.setXYZ(
      i,
      positions.getX(i) * factor * scaleX,
      positions.getY(i) * factor * scaleY,
      positions.getZ(i) * factor * scaleZ
    )
  }
  geo.computeVertexNormals()
  return geo
}

// ─── 变体 4：长条状碎块 ────────────────────────────────
// CylinderGeometry + 非均匀缩放，模拟层理/节理断裂的长条碎石
function createElongatedRockGeometry(seed) {
  // 6 段圆柱，端面 6 边形
  const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 3)
  const positions = geo.attributes.position
  const rng = makeRng(seed)

  // Y 方向拉伸(1.5~2.5)，XZ 方向压缩(0.3~0.5)
  const stretchY = 1.5 + rng() * 1.0
  const compressXZ = 0.3 + rng() * 0.2

  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i)
    const y = positions.getY(i)
    const z = positions.getZ(i)
    const jitter = 0.7 + rng() * 0.6
    // 端面微凹/凸
    const endFactor = Math.abs(y) > 0.4 ? (0.6 + rng() * 0.8) : 1.0
    positions.setXYZ(
      i,
      x * compressXZ * jitter * endFactor,
      y * stretchY,
      z * compressXZ * jitter * endFactor
    )
  }
  geo.computeVertexNormals()
  return geo
}

// ─── 几何体变体总数 ─────────────────────────────────────
export const ROCK_VARIANT_COUNT = 5 // 0:块状 1:板状 2:楔形 3:不规则 4:长条

// 每种形态的子变体数（不同 seed 产生的同类形状）
const SUB_VARIANTS_PER_TYPE = 3

/**
 * 创建完整的岩石几何体池
 * 总计 ROCK_VARIANT_COUNT × SUB_VARIANTS_PER_TYPE = 15 个几何体
 * @returns {THREE.BufferGeometry[]} 几何体数组，索引 = type * SUB_VARIANTS_PER_TYPE + sub
 */
export function createRockGeometryPool() {
  const pool = []
  const creators = [
    createBlockyRockGeometry,
    createPlatyRockGeometry,
    createWedgeRockGeometry,
    createIrregularRockGeometry,
    createElongatedRockGeometry
  ]

  for (let type = 0; type < creators.length; type++) {
    for (let sub = 0; sub < SUB_VARIANTS_PER_TYPE; sub++) {
      const seed = type * 1000 + sub * 337
      pool.push(creators[type](seed))
    }
  }
  return pool
}

/**
 * 根据碎块尺寸选择几何体变体索引
 * 大块→块状，中块→板状，中小→楔形，小块→不规则，偶尔长条
 *
 * @param {number} physSize - 碎块物理尺寸(m)
 * @param {number} x50 - KCO 中位块度(m)
 * @param {number} x80 - 80%通过块度(m)，若未提供则估算为 x50*1.6
 * @param {number} xmax - 最大块度(m)
 * @returns {number} variantIndex（0~14），对应 pool 中的几何体
 */
export function selectVariantBySize(physSize, x50, x80, xmax, rng = Math.random) {
  const safeX80 = x80 > 0 ? x80 : x50 * 1.6
  const safeXmax = xmax > 0 ? xmax : x50 * 3

  let type
  if (physSize > safeX80) {
    type = 0 // 块状岩块（大块）
  } else if (physSize > x50) {
    type = 1 // 扁平板状（中块）
  } else if (physSize > x50 * 0.5) {
    type = rng() > 0.7 ? 4 : 2 // 中小：楔形为主，偶尔长条
  } else {
    type = rng() > 0.85 ? 4 : 3 // 小块：不规则为主，偶尔长条
  }

  // 在该 type 内随机选子变体
  const sub = Math.floor(rng() * SUB_VARIANTS_PER_TYPE)
  return type * SUB_VARIANTS_PER_TYPE + sub
}

/**
 * 形态感知碰撞半径系数
 * 根据几何体变体索引返回等效碰撞半径相对于外接球半径的缩放系数。
 * 不同形态的碎片在碰撞时应有不同的等效半径：
 *   - 块状(0)：接近球形，scale = 1.0
 *   - 板状(1)：扁平，等效半径小，scale = 0.82
 *   - 楔形(2)：前薄后厚，平均略小，scale = 0.90
 *   - 不规则(3)：多面体，接近球形但凹凸不平，scale = 0.95
 *   - 长条(4)：长轴远大于短轴，碰撞半径取长轴方向，scale = 1.18
 *
 * @param {number} variantIndex - 几何体变体索引(0~14)
 * @returns {number} 碰撞半径缩放系数(0.5~1.3)
 */
export function getCollisionRadiusScale(variantIndex) {
  // variantIndex = type * 3 + sub，取 type
  const type = Math.floor(variantIndex / SUB_VARIANTS_PER_TYPE)
  switch (type) {
    case 0: return 1.00  // 块状
    case 1: return 0.82  // 板状
    case 2: return 0.90  // 楔形
    case 3: return 0.95  // 不规则
    case 4: return 1.18  // 长条
    default: return 1.00
  }
}

export default { createRockGeometryPool, selectVariantBySize, getCollisionRadiusScale, ROCK_VARIANT_COUNT }
