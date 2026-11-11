/**
 * 岩石几何体工厂 — 节理控制的块状碎石几何池
 *
 * 用节理网络 + 凸多面体生成块体（见 geometry/jointNetwork.js、
 * geometry/voronoiBlockGeometry.js），按形状族组织变体池：
 *
 *   块状 blocky    7 个变体（massive 节理，等轴棱角块 + 崩角）
 *   次圆 rounded   2 个（低面数多面体 + 强径向噪声，棱角状次圆块）
 *   柱状 columnar  3 个（两组密集竖向节理）
 *   不规则 irregular 6 个（多组节理 + 强扰动 + 强崩角）
 *   板状 platy     2 个（bedded 层理，仅层理发育时按权重出现）
 *   长条 elongated 2 个（columnar 强扰动）
 *   合计 22 个变体
 *
 * 旧版把 x50~x80 的中块**全部**硬映射为扁平板状（flatten 0.12~0.25），
 * 导致爆堆里大半碎块是薄片；现由节理间距比决定形状（Zingg 分类），
 * 默认板状占比 < 8%。
 *
 * 渲染与物理同源：本模块的顶点数组同时用于 InstancedMesh 与 Rapier 凸包。
 */
import * as THREE from 'three'
import { makeRng as _makeRngShared } from '../utils/rng.js'
import { createJointNetwork, ZINGG_LABELS } from '../geometry/jointNetwork.js'
import {
  buildBlockGeometry,
  buildRoundedBlockGeometry
} from '../geometry/voronoiBlockGeometry.js'

// ─── 确定性伪随机数生成器（LCG）：转发至 utils/rng.js ──
export const makeRng = _makeRngShared

// ─── 形状族定义 ────────────────────────────────────────
// count = 该族变体数；preset = 节理预设；jitter/faceSpread = 棱面不规则度。
// rounded（浑圆/类圆形）不走节理求交，由 buildRoundedBlockGeometry 生成
// （Icosahedron + 径向噪声 → 土豆形圆块），对应抛掷翻滚磨圆的现场块体。
const SHAPE_FAMILIES = [
  // chip = 崩角概率（把立方体角点换成截断面，避免"方方正正"的观感）
  { key: 'blocky', label: '块状', count: 7, preset: 'massive', jitter: 0.11, faceSpread: 0.06, chip: 0.5 },
  { key: 'rounded', label: '次圆', count: 2, preset: null, jitter: 0, faceSpread: 0 },
  {
    key: 'columnar',
    label: '柱状',
    count: 3,
    preset: 'columnar',
    jitter: 0.09,
    faceSpread: 0.05,
    chip: 0.4
  },
  {
    key: 'irregular',
    label: '不规则',
    count: 6,
    preset: 'sheared',
    jitter: 0.16,
    faceSpread: 0.08,
    chip: 0.7
  },
  {
    key: 'platy',
    label: '板状',
    count: 2,
    preset: 'bedded',
    jitter: 0.07,
    faceSpread: 0.04,
    chip: 0.35
  },
  {
    key: 'elongated',
    label: '长条',
    count: 2,
    preset: 'columnar',
    jitter: 0.13,
    faceSpread: 0.07,
    chip: 0.55
  }
]

/** 形状族数量（语义：族数，不再是旧版的"形态类型数×子变体"） */
export const ROCK_VARIANT_COUNT = SHAPE_FAMILIES.length

/** 变体总数（几何池长度） */
export const ROCK_VARIANT_TOTAL = SHAPE_FAMILIES.reduce((s, f) => s + f.count, 0)

let _familyRanges = null

/** 形状族（按实际 Zingg 分类排序）：块状 → 浑圆 → 不规则 → 柱状 → 板状 */
const ZINGG_ORDER = ['blocky', 'rounded', 'irregular', 'columnar', 'platy']

/** 形状族 → 变体索引区间 [lo, hi]（闭区间，按实际 Zingg 分类分组） */
function getFamilyRanges() {
  if (_familyRanges) return _familyRanges
  // 首次使用前先建模板池（建池时会按实际 Zingg 重排并写好 ranges）
  getTemplatePool()
  return _familyRanges
}

/** 给几何体补充全 1.0 白色 color 属性（InstancedMesh instanceColor 生效所需） */
function addWhiteColorAttribute(geo) {
  if (geo.attributes.color) return
  const count = geo.attributes.position.count
  const colors = new Float32Array(count * 3).fill(1)
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
}

/** 计算三角网格实心体积（自原点四面体分解，逐三角形取 abs） */
function polyhedronVolume(geo) {
  const positions = geo.attributes.position
  const index = geo.index ? geo.index.array : null
  const triCount = index ? index.length / 3 : positions.count / 3
  let vol = 0
  for (let t = 0; t < triCount; t++) {
    const i = index ? index[t * 3] : t * 3
    const j = index ? index[t * 3 + 1] : t * 3 + 1
    const k = index ? index[t * 3 + 2] : t * 3 + 2
    const ax = positions.getX(i)
    const ay = positions.getY(i)
    const az = positions.getZ(i)
    const bx = positions.getX(j)
    const by = positions.getY(j)
    const bz = positions.getZ(j)
    const cx = positions.getX(k)
    const cy = positions.getY(k)
    const cz = positions.getZ(k)
    vol += Math.abs(ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx))
  }
  return vol / 6
}

// ─── 几何池构建 ────────────────────────────────────────
let _shapeStats = null

/** 真正构建池（每次调用都新建几何对象，供渲染器持有并 dispose） */
function _buildPool() {
  const built = []
  let seedBase = 1000
  for (const fam of SHAPE_FAMILIES) {
    for (let sub = 0; sub < fam.count; sub++) {
      const seed = seedBase + sub * 337
      let result
      if (fam.key === 'rounded') {
        // 浑圆族：Icosahedron + 径向噪声（不走节理网络求交）
        result = buildRoundedBlockGeometry({ seed })
      } else {
        const network = createJointNetwork({ preset: fam.preset, seed })
        result = buildBlockGeometry({
          network,
          seed,
          jitter: fam.jitter,
          faceSpread: fam.faceSpread,
          chip: fam.chip
        })
      }
      addWhiteColorAttribute(result.geometry)
      built.push({
        geometry: result.geometry,
        baseFamily: fam.key,
        baseLabel: fam.label,
        jointPreset: fam.key === 'rounded' ? 'rounded' : fam.preset,
        ...result.stats
      })
    }
    seedBase += 10000
  }

  // 按**实际几何 Zingg 分类**重排：族名必须与形状统计一致。
  // 否则会出现"族名为柱状、几何判定却不规则"的情况，使形状占比统计与
  // selectVariantBySize 的权重表错位（旧版实测块状占比 43% 而权重预期 55%）。
  built.sort((a, b) => ZINGG_ORDER.indexOf(a.zingg) - ZINGG_ORDER.indexOf(b.zingg))

  const pool = []
  const stats = []
  for (const item of built) {
    pool.push(item.geometry)
    stats.push({
      variantIndex: pool.length - 1,
      family: item.zingg,
      familyLabel: ZINGG_LABELS[item.zingg] || '',
      baseFamily: item.baseFamily,
      baseLabel: item.baseLabel,
      jointPreset: item.jointPreset,
      zingg: item.zingg,
      zinggLabel: ZINGG_LABELS[item.zingg] || '',
      elongation: item.elongation,
      flatness: item.flatness,
      faceTriangles: item.faceTriangles,
      halfExtents: item.halfExtents
    })
  }

  // 重建族区间（按重排后的顺序）
  _familyRanges = new Map()
  for (let i = 0; i < stats.length; i++) {
    const key = stats[i].family
    if (!_familyRanges.has(key)) _familyRanges.set(key, [i, i])
    else _familyRanges.get(key)[1] = i
  }
  _shapeStats = stats
  return pool
}

// 模板池：供各类统计 getter 复用，常驻不释放（渲染器用 createRockGeometryPool 另建）
let _templatePool = null

function getTemplatePool() {
  if (!_templatePool) _templatePool = _buildPool()
  return _templatePool
}

/**
 * 创建完整的岩石几何体池（渲染器/物理引擎使用；调用方负责 dispose）。
 * @returns {THREE.BufferGeometry[]} 长度 = ROCK_VARIANT_TOTAL（22：含 2 个次圆变体）
 */
export function createRockGeometryPool() {
  return _buildPool()
}

/**
 * 各变体的形状统计（族、Zingg 分类、三轴比、面数），供 UI 与验收脚本读取。
 * @returns {Array<Object>}
 */
export function getRockVariantShapeStats() {
  getTemplatePool()
  return _shapeStats
}

// ─── 派生统计（均按模板池计算，不重复构建）─────────────
let _variantMaxRadius = null

/** 每个变体的最大顶点球半径（索引同池） */
export function getRockVariantMaxRadius() {
  if (_variantMaxRadius) return _variantMaxRadius
  const pool = getTemplatePool()
  _variantMaxRadius = pool.map(geo => {
    const p = geo.attributes.position
    let m = 0
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i))
      if (r > m) m = r
    }
    return m
  })
  return _variantMaxRadius
}

let _variantHalfExtents = null

/** 每个变体的 AABB 半轴 [hx,hy,hz]（索引同池） */
export function getRockVariantHalfExtents() {
  if (_variantHalfExtents) return _variantHalfExtents
  const pool = getTemplatePool()
  _variantHalfExtents = pool.map(geo => {
    geo.computeBoundingBox()
    const bb = geo.boundingBox
    return [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2]
  })
  return _variantHalfExtents
}

let _variantUnitVolumes = null

/** 每个变体的单位体积（scale=1），用于渲染体积归一化 */
export function getRockVariantUnitVolumes() {
  if (_variantUnitVolumes) return _variantUnitVolumes
  const pool = getTemplatePool()
  _variantUnitVolumes = pool.map(polyhedronVolume)
  return _variantUnitVolumes
}

let _variantVertices = null

/** 每个变体的基础顶点数组（scale=1），供包裹壳做真实投影轮廓 */
export function getRockVariantVertices() {
  if (_variantVertices) return _variantVertices
  const pool = getTemplatePool()
  _variantVertices = pool.map(geo => geo.attributes.position.array.slice())
  return _variantVertices
}

// ─── 按块度 + 岩体形状混合抽取变体 ─────────────────────
// 块度档位 → 形状族权重（族与几何池的 Zingg/形态分类严格一致）。
// 默认对应"节理中等发育的硬岩"：等轴块状为主体（总占比 ≥ 40%，满足验收
// 要求），不规则块次之（含强崩角，是"破碎感"的主要来源），次圆块仅 8%~12%
// （旧版 20%~28% 的浑圆族在近景下读作"光滑球"，与爆破碎石不符），
// 板状/长条只占零头（层理发育时由 shapeMix 提高）。
const SIZE_WEIGHTS = {
  large: { blocky: 0.62, rounded: 0.08, irregular: 0.2, columnar: 0.07, platy: 0.03 },
  medium: { blocky: 0.56, rounded: 0.1, irregular: 0.24, columnar: 0.07, platy: 0.03 },
  small: { blocky: 0.52, rounded: 0.11, irregular: 0.27, columnar: 0.07, platy: 0.03 },
  fine: { blocky: 0.48, rounded: 0.12, irregular: 0.3, columnar: 0.07, platy: 0.03 }
}

/**
 * 按块度档位 + 岩体形状混合抽取变体索引。
 *
 * 与旧版的关键差异：**不再把 x50~x80 的中块硬映射为板状**。板状属于
 * "层理发育岩体"的特征，只能通过 shapeMix 提高权重（如 { platy: 3 }）。
 *
 * @param {number} physSize - 碎块物理尺寸(m)
 * @param {number} x50 - KCO 中位块度(m)
 * @param {number} x80 - 80% 通过块度(m)
 * @param {number} xmax - 最大块度(m)
 * @param {Function} rng - 随机数发生器
 * @param {Object|null} shapeMix - 形状族权重倍率，如 { platy: 3, blocky: 0.8 }
 * @returns {number} variantIndex（0 ~ ROCK_VARIANT_TOTAL-1）
 */
export function selectVariantBySize(physSize, x50, x80, xmax, rng = Math.random, shapeMix = null) {
  const safeX80 = x80 > 0 ? x80 : x50 * 1.6
  let weights
  if (physSize > safeX80) weights = SIZE_WEIGHTS.large
  else if (physSize > x50) weights = SIZE_WEIGHTS.medium
  else if (physSize > x50 * 0.5) weights = SIZE_WEIGHTS.small
  else weights = SIZE_WEIGHTS.fine

  const mix = shapeMix && typeof shapeMix === 'object' ? shapeMix : null
  // 可用族以几何池实际存在的 Zingg 分类为准（可能缺某类，如无板状变体）
  const ranges = getFamilyRanges()
  const keys = ZINGG_ORDER.filter(k => ranges.has(k))
  const w = keys.map(k => {
    const base = Math.max(0, Number(weights[k]) || 0)
    const mult = mix && mix[k] != null ? Math.max(0, Number(mix[k]) || 0) : 1
    return base * mult
  })
  const total = w.reduce((s, x) => s + x, 0)

  let key = keys[0] || 'blocky'
  if (total > 0) {
    let r = rng() * total
    for (let i = 0; i < keys.length; i++) {
      r -= w[i]
      if (r <= 0) {
        key = keys[i]
        break
      }
    }
  }
  const [lo, hi] = getFamilyRanges().get(key)
  return lo + Math.floor(rng() * (hi - lo + 1))
}

export default {
  createRockGeometryPool,
  selectVariantBySize,
  getRockVariantMaxRadius,
  getRockVariantHalfExtents,
  getRockVariantUnitVolumes,
  getRockVariantVertices,
  getRockVariantShapeStats,
  ROCK_VARIANT_COUNT,
  ROCK_VARIANT_TOTAL
}
