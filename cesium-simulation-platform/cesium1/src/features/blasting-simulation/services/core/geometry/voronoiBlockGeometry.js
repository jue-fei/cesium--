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
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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
 * 生成一个节理控制的块体几何（半空间求交：3 组节理面 + 随机崩落切面）。
 * @param {{ network: Object, seed?: number, jitter?: number, faceSpread?: number, chip?: number }} options
 *   chip: 崩落切面数量系数（0~1，实际切面数 = round(chip×8)）
 * @returns {{ geometry: THREE.BufferGeometry, vertices: Float32Array, stats: Object }}
 */
export function buildBlockGeometry(options = {}) {
  const network = options.network
  const seed = Number(options.seed) || 1
  const rng = makeRng(seed)
  const jitter = Number.isFinite(Number(options.jitter)) ? Number(options.jitter) : 0.1
  const faceSpread = Number.isFinite(Number(options.faceSpread)) ? Number(options.faceSpread) : 0.05
  const chip = Number.isFinite(Number(options.chip)) ? Number(options.chip) : 0.5

  const sets = (network?.sets || []).slice(0, 3)
  if (sets.length < 3) return fallbackResult(seed)

  const normals = sets.map(s => normalize(s.normal))
  const spacings = sets.map(s => Math.max(0.05, Number(s.spacing) || 1))
  const sizeScale = (spacings[0] + spacings[1] + spacings[2]) / 3
  const b0 = { x: normals[0].x, y: normals[1].x, z: normals[2].x }
  const b1 = { x: normals[0].y, y: normals[1].y, z: normals[2].y }
  const b2 = { x: normals[0].z, y: normals[1].z, z: normals[2].z }
  if (Math.abs(dot(b0, cross(b1, b2))) < 1e-4) return fallbackResult(seed)

  // ── 1. 8 个角点（平行六面体）──
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

  // ── 2. 顶点扰动（棱线不规则化）──
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

  // ── 3. 棱角崩落（corner chipping）──
  // 真实爆破碎块表面 = 节理面 + 断裂面，棱角处普遍有崩口/截断，极少出现完整
  // 立方体。按概率把角点替换为沿其三条棱的截断点：凸包在该角处形成一张三角形
  // 崩落面（棱线依旧锐利），轮廓不再读作"方块"。
  // 用"角点→截断点"而非"随机半空间求交"：块体始终包含其余角点，绝不会被
  // 削成刀片/尖刺（后者在薄板/细柱上会直接削穿厚度）。
  const keep = []
  const chipped = []
  for (let ci = 0; ci < grid.length; ci++) {
    const g = grid[ci]
    if (rng() >= chip) {
      keep.push(points[ci])
      continue
    }
    const t = 0.18 + rng() * 0.32
    const p = points[ci]
    for (const [d1, d2, d3] of [
      [-g.i1, g.i2, g.i3],
      [g.i1, -g.i2, g.i3],
      [g.i1, g.i2, -g.i3]
    ]) {
      const ni = grid.findIndex(h => h.i1 === d1 && h.i2 === d2 && h.i3 === d3)
      if (ni < 0) continue
      const q = points[ni]
      chipped.push(
        new THREE.Vector3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t)
      )
    }
  }

  // ── 4. 面心外凸点（把 6 面切成 12~24 个面，模拟节理面起伏）──
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

  // ── 4.5 凸包 ──
  let geo
  try {
    geo = new ConvexGeometry(keep.concat(chipped, faces))
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

/**
 * 方向连贯的径向噪声（确定性）：同一单位方向永远得到同一噪声值。
 * 三层正弦叠加（频率 2 / 4 / 8），低频决定整体"土豆形"鼓包，
 * 高频叠加少量表面起伏；幅度逐层衰减避免出现高频锯齿。
 */
function _radialNoise(x, y, z, s) {
  let v =
    Math.sin(x * 2.1 + s) * Math.sin(y * 1.7 - s * 0.7) * Math.sin(z * 1.9 + s * 0.3) +
    0.5 * Math.sin(x * 4.3 - s) * Math.sin(y * 3.9 + s) * Math.sin(z * 4.1 - s * 0.5) +
    0.25 * Math.sin(x * 8.7 + s * 1.3) * Math.sin(y * 8.1 - s * 0.9) * Math.sin(z * 9.3 + s)
  return v / 1.75 // 归一到约 [-1, 1]
}

/**
 * 生成浑圆（类圆形）块体几何 — 与节理块体互补的形态族。
 *
 * 真实爆破块体中相当一部分是"浑圆状"：节理面密集切割后棱角在抛掷翻滚
 * 过程中被磨圆，细粒径块尤为明显（现场筛分常见次圆/浑圆颗粒）。旧几何池
 * 全部由节理平面求交生成，骨架必为棱角块 → 爆堆里没有一颗圆块。
 *
 * 算法：
 *  1. IcosahedronGeometry(1, 1) 焊接顶点（mergeVertices，保证法线平滑）；
 *  2. 每个顶点沿径向做方向连贯噪声位移（r = 1 + 0.13·noise），
 *     三层正弦叠加 → 浑圆"土豆形" + 轻微表面起伏；
 *  3. 各向异性缩放（sx, sy, sz ∈ [0.82, 1.22]）制造椭球度差异，
 *     使族内既有近球形也有轻微长/扁的圆块；
 *  4. 居中 + 归一化到最大半径 1（与节理块体 maxR 语义一致）。
 *
 * 渲染与物理同源：返回顶点数组同样交给 Rapier convexHull 做凸包碰撞体
 * （近凸形，凸包与真实形状几乎重合，碰撞精度不受影响）。
 *
 * @param {{ seed?: number, detail?: number }} options
 * @returns {{ geometry: THREE.BufferGeometry, vertices: Float32Array, stats: Object }}
 */
export function buildRoundedBlockGeometry(options = {}) {
  const seed = Number(options.seed) || 1
  // detail=0：二十面体 20 面 → 面片大、棱线明显（"棱角状次圆块"）；
  // detail=1（80 面）在 flatShading 下仍读作"球"，故不再作为默认。
  const detail = Number.isFinite(Number(options.detail)) ? Number(options.detail) : 0
  const rng = makeRng(seed)

  // 噪声种子 & 各向异性缩放（族内形状差异来源）
  const ns = rng() * 100
  // 0.20~0.32：足够强的径向起伏，让次圆块也有明显崩口/凸棱，不再是光滑球
  const amp = 0.32 + rng() * 0.18
  const sx = 0.82 + rng() * 0.4
  const sy = 0.82 + rng() * 0.4
  const sz = 0.82 + rng() * 0.4

  let geo
  try {
    geo = new THREE.IcosahedronGeometry(1, detail)
    geo = mergeVertices(geo) // 焊接共享顶点 → 后续位移方向一致、法线平滑
  } catch (_) {
    return fallbackResult(seed)
  }
  if (!geo || !geo.attributes.position || geo.attributes.position.count < 12) {
    return fallbackResult(seed)
  }

  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const len = Math.hypot(x, y, z) || 1
    const n = _radialNoise(x / len, y / len, z / len, ns)
    // 逐顶点随机位移（0.55 权重）压过多面体的"球面感"：12 个顶点各自乱走，
    // 20 个面变成大小不一的不规则三角面 → 棱角状次圆块（旧版纯平滑噪声
    // 只是把球捏成"土豆"，在近景里仍是一颗球）。
    const rnd = rng() * 2 - 1
    const r = 1 + amp * (0.45 * n + 0.55 * rnd)
    pos.setXYZ(i, x * r * sx, y * r * sy, z * r * sz)
  }

  // 居中 + 归一化到最大半径 1
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2)
  const p2 = geo.attributes.position
  let maxR = 0
  for (let i = 0; i < p2.count; i++) {
    const r = Math.hypot(p2.getX(i), p2.getY(i), p2.getZ(i))
    if (r > maxR) maxR = r
  }
  if (!(maxR > 1e-6)) return fallbackResult(seed)
  geo.scale(1 / maxR, 1 / maxR, 1 / maxR)
  geo.computeBoundingBox()
  geo.computeVertexNormals() // 平滑法线 → 渲染呈浑圆面，而非多面体面片

  const half = geo.boundingBox
  const hx = (half.max.x - half.min.x) / 2
  const hy = (half.max.y - half.min.y) / 2
  const hz = (half.max.z - half.min.z) / 2
  const sorted = [hx, hy, hz].sort((a, b) => b - a)
  const geomElongation = sorted[0] > 1e-6 ? sorted[1] / sorted[0] : 1
  const geomFlatness = sorted[1] > 1e-6 ? sorted[2] / sorted[1] : 1

  return {
    geometry: geo,
    vertices: geo.attributes.position.array.slice(),
    stats: {
      faceTriangles: Math.floor(
        geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3
      ),
      halfExtents: [hx, hy, hz],
      elongation: geomElongation,
      flatness: geomFlatness,
      zingg: 'rounded', // 独立形态族：不走节理 Zingg 分类
      jointPreset: 'rounded'
    }
  }
}
