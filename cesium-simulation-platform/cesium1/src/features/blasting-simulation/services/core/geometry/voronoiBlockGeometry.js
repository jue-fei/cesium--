/**
 * 节理控制的块体几何生成 — 用三组节理面切出真实块状凸多面体。
 *
 * 算法（无第三方依赖）：
 *  1. 三组节理各取一对平行平面（±spacing/2），两两求交解出 8 个顶点，
 *     得到"平行六面体"——其棱面就是节理面，块体天然带方棱方角；
 *  2. 6 个面心沿法线向外微凸 2%~8%（模拟节理面起伏与次级破裂面），
 *     使凸包从 6 面变为 12~24 个三角面，避免"完美方块"的塑料感；
 *  3. 顶点与面心加 <12% 随机扰动，制造天然棱角；
 *  4. ConvexGeometry 求凸包 → 归一化到最大半径 = 1（与旧变体 maxR 语义一致）。
 *
 * 与旧版（BoxGeometry 压扁 / Dodecahedron 随机缩放）相比，形状由节理间距比
 * 决定：等间距 → 块状，一组密集 → 板状，两组密集 → 柱状，不会出现
 * "所有中块都被压成薄片"的问题。
 */
import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { makeRng } from '../utils/rng.js'
import { deriveShapeStats, classifyZingg } from './jointNetwork.js'

/** 向量叉积 / 点积 */
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  }
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * 解 n1·x=d1, n2·x=d2, n3·x=d3。
 * 行矩阵 A=[n1;n2;n3]，用转置列 b0/b1/b2 构造叉积：x=((b1×b2)·d, (b2×b0)·d, (b0×b1)·d)/det。
 * （直接对行向量取叉积会得到错误的列，前两版实测使解不满足平面方程。）
 * 退化（三法线共面）返回 null。
 */
function solvePlanes(n1, n2, n3, d1, d2, d3) {
  const b0 = { x: n1.x, y: n2.x, z: n3.x }
  const b1 = { x: n1.y, y: n2.y, z: n3.y }
  const b2 = { x: n1.z, y: n2.z, z: n3.z }
  const det = dot(b0, cross(b1, b2))
  if (Math.abs(det) < 1e-6) return null
  const d = { x: d1, y: d2, z: d3 }
  return {
    x: dot(cross(b1, b2), d) / det,
    y: dot(cross(b2, b0), d) / det,
    z: dot(cross(b0, b1), d) / det
  }
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** 退化兜底：带扰动的立方体（保证任何输入都能拿到可用几何体） */
function buildFallbackGeometry(seed) {
  const rng = makeRng(seed)
  const geo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const corner = Math.abs(x) > 0.35 && Math.abs(y) > 0.35 && Math.abs(z) > 0.35
    const f = corner ? 0.82 + rng() * 0.3 : 0.94 + rng() * 0.12
    pos.setXYZ(i, x * f, y * f, z * f)
  }
  geo.computeVertexNormals()
  return geo
}

/**
 * 生成一个节理控制的块体几何。
 * @param {{ network: Object, seed?: number, jitter?: number, faceSpread?: number }} options
 * @returns {{ geometry: THREE.BufferGeometry, vertices: Float32Array, stats: Object }}
 */
export function buildBlockGeometry(options = {}) {
  const network = options.network
  const seed = Number(options.seed) || 1
  const rng = makeRng(seed)
  const jitter = Number.isFinite(Number(options.jitter)) ? Number(options.jitter) : 0.1
  const faceSpread = Number.isFinite(Number(options.faceSpread)) ? Number(options.faceSpread) : 0.05

  const sets = (network?.sets || []).slice(0, 3)
  if (sets.length < 3) return fallbackResult(seed)

  const normals = sets.map(s => normalize(s.normal))
  const spacings = sets.map(s => Math.max(0.05, Number(s.spacing) || 1))
  const sizeScale = (spacings[0] + spacings[1] + spacings[2]) / 3
  // 共面检测：det(A) = b0·(b1×b2)
  const b0 = { x: normals[0].x, y: normals[1].x, z: normals[2].x }
  const b1 = { x: normals[0].y, y: normals[1].y, z: normals[2].y }
  const b2 = { x: normals[0].z, y: normals[1].z, z: normals[2].z }
  if (Math.abs(dot(b0, cross(b1, b2))) < 1e-4) return fallbackResult(seed)

  // ── 1. 8 个顶点（平行六面体）──
  const grid = []
  for (const i1 of [-1, 1]) {
    for (const i2 of [-1, 1]) {
      for (const i3 of [-1, 1]) {
        const v = solvePlanes(
          normals[0],
          normals[1],
          normals[2],
          (i1 * spacings[0]) / 2,
          (i2 * spacings[1]) / 2,
          (i3 * spacings[2]) / 2
        )
        if (!v) return fallbackResult(seed)
        grid.push({ i1, i2, i3, v })
      }
    }
  }

  // ── 2. 顶点扰动（棱角不规则化）──
  const points = grid.map(g => {
    const r = jitter * sizeScale * (0.25 + rng() * 0.75)
    const theta = rng() * Math.PI * 2
    const phi = Math.acos(2 * rng() - 1)
    return new THREE.Vector3(
      g.v.x + r * Math.sin(phi) * Math.cos(theta),
      g.v.y + r * Math.sin(phi) * Math.sin(theta),
      g.v.z + r * Math.cos(phi)
    )
  })

  // ── 3. 面心外凸点（把 6 面切成 12~24 个面，模拟节理面起伏）──
  const faces = []
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const key = ['i1', 'i2', 'i3'][axis]
      const ids = grid.filter(g => g[key] === sign)
      const cx = ids.reduce((s, g) => s + g.v.x, 0) / ids.length
      const cy = ids.reduce((s, g) => s + g.v.y, 0) / ids.length
      const cz = ids.reduce((s, g) => s + g.v.z, 0) / ids.length
      const n = normals[axis]
      const spread = faceSpread * sizeScale * (0.4 + rng() * 1.2) * sign
      faces.push(new THREE.Vector3(cx + n.x * spread, cy + n.y * spread, cz + n.z * spread))
    }
  }

  // ── 4. 凸包 ──
  let geo
  try {
    geo = new ConvexGeometry(points.concat(faces))
  } catch (_) {
    return fallbackResult(seed)
  }
  if (!geo || !geo.attributes.position || geo.attributes.position.count < 12) {
    return fallbackResult(seed)
  }

  // ── 5. 居中 + 归一化到最大半径 1（与旧变体 maxR 语义一致）──
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const cx = (bb.min.x + bb.max.x) / 2
  const cy = (bb.min.y + bb.max.y) / 2
  const cz = (bb.min.z + bb.max.z) / 2
  geo.translate(-cx, -cy, -cz)

  const pos = geo.attributes.position
  let maxR = 0
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))
    if (r > maxR) maxR = r
  }
  if (!(maxR > 1e-6)) return fallbackResult(seed)
  geo.scale(1 / maxR, 1 / maxR, 1 / maxR)
  geo.computeBoundingBox()
  geo.computeVertexNormals()

  const half = geo.boundingBox
  const hx = (half.max.x - half.min.x) / 2
  const hy = (half.max.y - half.min.y) / 2
  const hz = (half.max.z - half.min.z) / 2
  const sorted = [hx, hy, hz].sort((a, b) => b - a)
  // Zingg 分类以**实际几何三轴比**为准（间距比只是名义值，求交+扰动后会偏移），
  // 这样 stats.zingg 与视觉上的块体形状严格一致。
  const geomElongation = sorted[0] > 1e-6 ? sorted[1] / sorted[0] : 1
  const geomFlatness = sorted[1] > 1e-6 ? sorted[2] / sorted[1] : 1
  const jointStats = deriveShapeStats(network)

  return {
    geometry: geo,
    vertices: geo.attributes.position.array.slice(),
    stats: {
      faceTriangles: Math.floor(geo.attributes.position.count / 3),
      halfExtents: [hx, hy, hz],
      elongation: geomElongation,
      flatness: geomFlatness,
      zingg: classifyZingg(geomElongation, geomFlatness),
      zinggFromSpacing: jointStats.zingg,
      jointPreset: network?.presetKey || 'massive'
    }
  }
}

function fallbackResult(seed) {
  const geo = buildFallbackGeometry(seed)
  // 与主路径同口径：居中 + 归一化到最大半径 1
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2)
  const pos = geo.attributes.position
  let maxR = 0
  for (let i = 0; i < pos.count; i++) {
    maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)))
  }
  if (maxR > 1e-6) geo.scale(1 / maxR, 1 / maxR, 1 / maxR)
  geo.computeBoundingBox()
  const half = geo.boundingBox
  const hx = (half.max.x - half.min.x) / 2
  const hy = (half.max.y - half.min.y) / 2
  const hz = (half.max.z - half.min.z) / 2
  return {
    geometry: geo,
    vertices: geo.attributes.position.array.slice(),
    stats: {
      faceTriangles: Math.floor(geo.attributes.position.count / 3),
      halfExtents: [hx, hy, hz],
      elongation: 1,
      flatness: 1,
      zingg: 'blocky',
      jointPreset: 'fallback'
    }
  }
}
