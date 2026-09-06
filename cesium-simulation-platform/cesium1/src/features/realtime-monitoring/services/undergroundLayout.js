/**
 * undergroundLayout.js —— 井下巷道拓扑布局（由场景配置驱动）
 *
 * 巷道网络的 2D 布局坐标 / 三维分层 / 深部分层段不再写死，而是从场景配置
 * （后端 config/scenario_<名>.json，经 /api/scheduling/config 下发）动态构建：
 *
 *   - buildLayout(cfg)：把场景配置解析为前端可视化所需的布局对象
 *       { nodePositions, segmentLinks, deepSegments, viewBox, levels, nodeElevation }
 *   - pathToPoints(path, startNode, layout)：由段 ID 序列还原节点坐标序列
 *
 * 只要在场景 JSON 的 layout.nodes / segments / levelSegs / layout.levels 中增删巷道，
 * 渲染与 NSGA-III 路径绘制即自动适配，无需修改本文件或组件代码。
 */

// 默认 2D 画布范围（与场景配置 layout.viewBox 一致；此处作为兜底）
export const DEFAULT_VIEW_BOX = { x: 0, y: 0, width: 390, height: 300 }

// 顶层默认巷道段（与场景配置 levelSegs["0"] 一致；作为兜底）
export const DEFAULT_SEGMENT_LINKS = [
  ['SEG-01', 'S0', 'N1'],
  ['SEG-02', 'N1', 'N2'],
  ['SEG-03', 'N2', 'N3'],
  ['SEG-04', 'M1', 'N5'],
  ['SEG-05', 'S0', 'N4'],
  ['SEG-06', 'N4', 'N5'],
  ['SEG-07', 'N3', 'M2'],
  ['SEG-08', 'N2', 'M1'],
  ['SEG-09', 'N5', 'M2'],
  ['SEG-10', 'M3', 'N6'],
  ['SEG-11', 'N6', 'M4'],
  ['SEG-12', 'N3', 'N6'],
  ['SEG-13', 'N7', 'M3'],
  ['SEG-14', 'S1', 'N7'],
  ['SEG-15', 'M4', 'S1']
]

// 默认节点 2D 布局（与场景配置 layout.nodes 一致；作为兜底）
export const DEFAULT_NODE_POSITIONS = {
  S0: { x: 50, y: 40, label: 'S0 卸载点', isDump: true },
  N1: { x: 140, y: 40, label: 'N1' },
  N2: { x: 230, y: 40, label: 'N2' },
  N3: { x: 320, y: 40, label: 'N3' },
  M1: { x: 80, y: 110, label: 'M1 A采场', isMuck: true },
  N5: { x: 140, y: 110, label: 'N5' },
  N4: { x: 80, y: 80, label: 'N4' },
  M2: { x: 320, y: 110, label: 'M2 B采场', isMuck: true },
  N6: { x: 320, y: 180, label: 'N6' },
  M3: { x: 170, y: 180, label: 'M3 C采场', isMuck: true },
  N7: { x: 230, y: 180, label: 'N7' },
  M4: { x: 320, y: 250, label: 'M4 D采场', isMuck: true },
  S1: { x: 230, y: 250, label: 'S1 备用卸点', isDump: true }
}

// 默认三维分层（与场景配置 layout.levels 一致；作为兜底）
export const DEFAULT_LEVELS = [
  { y: 36, name: '主运输水平', shift: { x: 0, z: 0 }, activity: 0.5 },
  { y: 14, name: '上部出矿分段', shift: { x: 22, z: -12 }, activity: 0.8 },
  { y: -8, name: '中部联络/通风水平', shift: { x: -16, z: 14 }, activity: 0.4 },
  { y: -30, name: '深部放矿水平', shift: { x: 26, z: -22 }, activity: 0.9 },
  { y: -52, name: '底部转运/运输水平', shift: { x: -12, z: 18 }, activity: 0.7 }
]

/* =========================================================
 * 深部分层巷道段生成（由场景配置 levelSegs 驱动）
 * ---------------------------------------------------------
 * 顶层(level 0)为真实巷道（对接后端实测状态）；深部分层(level 1..4)按场景 levelSegs
 * 为该层列出真实巷道段 id，渲染时生成【专属编号 SEG-{层}-{序}】与按采深推导的
 * 【独立安全配置】(炮烟/拥堵/岩爆/封锁/重载禁行均各不相同)，避免各层巷道信息套用。
 * ========================================================= */

function _hash01(str) {
  let h = 0
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
// 基于段 id 的确定性伪随机 0..1
function _unit01(h, k) {
  const v = Math.sin(h * (k + 1)) * 10000
  return v - Math.floor(v)
}
const _r1 = v => Math.round(v * 10) / 10
const _r3 = v => Math.round(v * 1000) / 1000

function deriveDeepSegments(cfg, nodePositions, levelSegs) {
  const segById = {}
  for (const s of (cfg && Array.isArray(cfg.segments) ? cfg.segments : [])) segById[s.id] = s
  const out = []
  const keys = Object.keys(levelSegs || {})
    .map(Number)
    .sort((a, b) => a - b)
  for (const K of keys) {
    if (K <= 0) continue // 顶层(level 0)走真实段
    const ids = levelSegs[K] || []
    ids.forEach((segId, j) => {
      const base = segById[segId]
      if (!base) return
      const lv = K + 1 // 显示层号 2..5
      const seq = String(j + 1).padStart(2, '0')
      const id = `SEG-${lv}-${seq}` // 专属编号：SEG-{层}-{序}
      const a = nodePositions[base.a]
      const b = nodePositions[base.b]
      if (!a || !b) return
      const h = _hash01(id)
      const depth = K // 采深系数，越深现象越恶劣
      out.push({
        id,
        level: K, // 开采水平索引（顶层为 0）
        aId: base.a,
        bId: base.b,
        name: `路段${lv}-${seq}`,
        lengthM: Math.round(Math.hypot(b.x - a.x, b.y - a.y) * 6),
        clearWidthM: _r1(3.2 + _unit01(h, 5) * 1.3),
        clearHeightM: _r1(3.4 + _unit01(h, 6) * 1.0),
        maxGradePct: _r1(4 + _unit01(h, 7) * 9),
        minTurnRadiusM: _r1(6 + _unit01(h, 8) * 7),
        smoke: _r3(_unit01(h, 2) * 0.7 + (K === 2 ? 0.05 : 0)),
        congestion: _r3(Math.min(0.96, 0.08 + 0.09 * depth + _unit01(h, 1) * 0.5)),
        rockburst: _r3(Math.min(0.98, 0.28 + 0.11 * depth + _unit01(h, 0) * 0.45)),
        blocked: _unit01(h, 3) < 0.04 + 0.05 * depth,
        passableLoaded: !(K >= 3 && _unit01(h, 4) < 0.1 * Math.max(2, depth - 1))
      })
    })
  }
  return out
}

/**
 * 由场景配置构建前端可视化布局对象。
 * @param {object} cfg 后端 /api/scheduling/config 下发的完整场景配置
 * @returns {{ nodePositions, segmentLinks, deepSegments, viewBox, levels, nodeElevation }}
 */
export function buildLayout(cfg) {
  const layout = (cfg && cfg.layout) || {}
  const rawNodes = layout.nodes || {}
  const nodePositions = {}
  for (const [id, n] of Object.entries(rawNodes)) {
    nodePositions[id] = {
      x: n.x,
      y: n.y,
      label: n.label || id,
      isDump: n.type === 'dump',
      isMuck: n.type === 'muck'
    }
  }
  const viewBox = layout.viewBox || DEFAULT_VIEW_BOX
  const levels = (layout.levels || []).map((l, i) => ({
    y: Number(l.y) || 0,
    name: l.name || `开采水平${i + 1}`,
    shift: l.shift || { x: 0, z: 0 },
    activity: l.activity != null ? l.activity : 0.5
  }))
  const levelSegs = (cfg && cfg.levelSegs) || {}
  const topIds = new Set(levelSegs['0'] || [])
  const segmentLinks = (cfg && Array.isArray(cfg.segments) ? cfg.segments : [])
    .filter(s => topIds.has(s.id))
    .map(s => [s.id, s.a, s.b])
  const deepSegments = deriveDeepSegments(cfg, nodePositions, levelSegs)
  return {
    nodePositions,
    segmentLinks,
    deepSegments,
    viewBox,
    levels,
    nodeElevation: layout.nodeElevation || {}
  }
}

/** 无场景配置时的兜底布局（保留旧版视觉，供 pathToPoints 等独立使用）。 */
export const DEFAULT_LAYOUT = buildLayout({
  layout: {
    viewBox: DEFAULT_VIEW_BOX,
    nodes: DEFAULT_NODE_POSITIONS,
    levels: DEFAULT_LEVELS
  },
  segments: DEFAULT_SEGMENT_LINKS.map(([id, a, b]) => ({ id, a, b })),
  levelSegs: {
    0: DEFAULT_SEGMENT_LINKS.map(l => l[0]),
    1: ['SEG-01', 'SEG-02', 'SEG-03', 'SEG-05', 'SEG-06', 'SEG-04', 'SEG-08', 'SEG-09', 'SEG-07'],
    2: ['SEG-01', 'SEG-02', 'SEG-08', 'SEG-04', 'SEG-06', 'SEG-05', 'SEG-12', 'SEG-13', 'SEG-10'],
    3: ['SEG-12', 'SEG-07', 'SEG-09', 'SEG-10', 'SEG-13', 'SEG-11', 'SEG-14', 'SEG-15'],
    4: ['SEG-01', 'SEG-05', 'SEG-14', 'SEG-15', 'SEG-11', 'SEG-10']
  }
})

/**
 * 竖井/斜井（上下层连接段）安全信息推导。
 * 与深部分层段同套路：由段编号确定性推导独立安全配置（尺寸/坡度/转弯/炮烟/拥堵/岩爆/封锁），
 * 越深风险越高，保证每条竖井点击后都能显示完整、稳定的安全信息。
 * @param {string} id 形如 "VERT-N3-2"（VERT-节点-目标层号）
 */
export function deriveRiserMeta(id) {
  const m = String(id || '').match(/^VERT-(\w+)-(\d+)$/)
  if (!m) return null
  const node = m[1]
  const lv = Number(m[2]) // 目标层号（越深风险越高）
  const h = _hash01(id)
  const depth = Math.max(1, lv)
  return {
    id,
    node,
    level: lv,
    name: `竖井/斜井 ${node}`,
    type: '竖井/斜井',
    lengthM: 22, // 层间相对深度(m)
    clearWidthM: _r1(3.6 + _unit01(h, 5) * 1.0),
    clearHeightM: _r1(3.2 + _unit01(h, 6) * 0.8),
    maxGradePct: _r1(6 + _unit01(h, 7) * 8),
    minTurnRadiusM: _r1(20 + _unit01(h, 8) * 15),
    smoke: _r3(_unit01(h, 2) * 0.5 + (lv === 2 ? 0.05 : 0)),
    congestion: _r3(Math.min(0.9, 0.05 + 0.06 * depth + _unit01(h, 1) * 0.4)),
    rockburst: _r3(Math.min(0.95, 0.2 + 0.12 * depth + _unit01(h, 0) * 0.4)),
    blocked: _unit01(h, 3) < 0.03 + 0.03 * depth,
    passableLoaded: true
  }
}

/**
 * 由段 ID 列表还原路径坐标序列（段 ID → 节点 → 2D 坐标）。
 * @param {string[]} path 段 ID 数组（如 ["SEG-01","SEG-08"]）
 * @param {string} startNode 起点节点（设备当前所在节点）
 * @param {object} layout buildLayout 的产物（缺省用 DEFAULT_LAYOUT）
 * @returns {Array<{x,y,node,segId}>}
 */
export function pathToPoints(path = [], startNode = 'S0', layout = DEFAULT_LAYOUT) {
  const pos = layout.nodePositions
  const links = layout.segmentLinks
  const pts = []
  let cur = startNode
  if (pos[cur]) pts.push({ x: pos[cur].x, y: pos[cur].y, node: cur, segId: null })
  for (const segId of path) {
    const link = links.find(([s]) => s === segId)
    if (!link) continue
    const next = link[1] === cur ? link[2] : link[1]
    const p = pos[next]
    if (p) pts.push({ x: p.x, y: p.y, node: next, segId })
    cur = next
  }
  return pts
}
