/**
 * useMultiObjectiveLhdTunnel.js —— 巷道网络数据加工（MultiObjectiveLhdView 专用 composable）
 *
 * 职责：
 *   - 由场景配置构建的 layout 派生 3D 渲染数据：巷道段/节点坐标/分层/节点高程
 *   - 合并后端硬约束 + 动态环境，推导各段安全元数据（segMeta，含竖井/深部分层兜底）
 *   - 把选中方案的多水平路由投影为 3D 路线点（routePoints）
 *   - 路段详情条展示辅助：状态判定/综合评级/尺寸格式化/指标条配色/编号中文化
 */
import { computed } from 'vue'
import { pathToPoints, deriveRiserMeta } from '../services/undergroundLayout.js'
import { riskScore, riskLevel, baseRiskScore } from '../services/riskUtils.js'

// 路段状态阈值：岩爆高发 / 拥堵缓行（与 3D 渲染、综合评级共享同一口径；
// 模块级导出单源，scheduling/FactorDynamic.vue 的"岩爆高发"角标亦消费此常量）
export const ROCKBURST_ALERT_THRESHOLD = 0.7
export const CONGESTION_ALERT_THRESHOLD = 0.6
// 路段详情条指标条配色阈值：>HOT 预警色、>MID 关注色、其余正常色
const METRIC_BAR_HOT_THRESHOLD = 0.6
const METRIC_BAR_MID_THRESHOLD = 0.3

export function useMultiObjectiveLhdTunnel({
  layout,
  snapshot,
  activeSegId,
  selected,
  candidates,
  equipIds,
  equipmentItems
}) {
  const nodePositions = computed(() => layout.value?.nodePositions || {})

  // 全巷道段定义：顶层真实段(level 0，对接后端实时状态) + 深部分层专属巷道段
  // (level 1..4，每条拥有独立编号 SEG-{层}-{序} 与独立安全配置，见 undergroundLayout)。
  const segmentLines = computed(() => {
    const L = layout.value
    if (!L) return []
    const pos = L.nodePositions
    const defs = [
      ...L.segmentLinks.map(([id, aId, bId]) => ({ id, level: 0, aId, bId })),
      ...L.deepSegments
    ]
    return defs
      .map(s => {
        const a = pos[s.aId]
        const b = pos[s.bId]
        if (!a || !b) return null
        const label = segLabel(s.id)
        return { ...s, a, b, label, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, label } }
      })
      .filter(Boolean)
  })

  // 深部分层段的独立元数据（含安全配置），供点击后展示该段独有信息
  const deepMetaById = computed(() => {
    const m = {}
    for (const s of layout.value?.deepSegments || []) m[s.id] = s
    return m
  })

  // 段 ID → {aId, bId, level}，用于数据缺失时按同一份 baseRiskScore 兜底评分
  const segCoordById = computed(() => {
    const m = {}
    for (const s of segmentLines.value) m[s.id] = { aId: s.aId, bId: s.bId, level: s.level ?? 0 }
    return m
  })

  // 三维分层（y 深度 / 平面错位 / 活动度）与节点高程，均由场景配置 layout.* 驱动，
  // TunnelMap3D 据此在 X/Y/Z 三个方向铺满真实道路，无需修改组件代码。
  const levels = computed(() => layout.value?.levels || [])
  const nodeHeights = computed(() => layout.value?.nodeElevation || {})

  // 巷道段约束数据：硬约束（物理通过性）+ 动态（炮烟/拥堵/岩爆/封锁）按段 ID 合并
  const hardBySeg = computed(() => {
    const map = {}
    for (const s of snapshot.value?.factors?.hardConstraints?.segments || []) map[s.id] = s
    return map
  })
  const dynBySeg = computed(() => {
    const map = {}
    for (const s of snapshot.value?.factors?.dynamicEnvironment?.segments || []) map[s.id] = s
    return map
  })
  function segMeta(id) {
    // 竖井/斜井（上下层连接段，VERT-节点-层）：确定性推导完整安全信息，与普通巷道段一致
    const vert = String(id || '').match(/^VERT-(\w+)-(\d+)$/)
    if (vert) return deriveRiserMeta(id) || { id, name: `竖井/斜井 ${vert[1]}`, type: '竖井/斜井' }
    // 深部分层段：直接返回该段专属的独立安全配置（编号/尺寸/炮烟/拥堵/岩爆/封锁等）
    const deep = deepMetaById.value[id]
    if (deep) return { ...deep }
    // 顶层真实段：合并后端硬约束 + 动态环境的实时状态
    const merged = {
      id,
      ...(hardBySeg.value[id] || {}),
      ...(dynBySeg.value[id] || {}),
      name: hardBySeg.value[id]?.name || dynBySeg.value[id]?.name || cnId(id)
    }
    // 数据缺失（无任何安全参数）时注入与 3D 渲染同一份 baseRiskScore 兜底分，
    // 保证详情评分与巷道颜色严格同源
    const hasParams =
      merged.passableLoaded === false ||
      merged.rockburst != null ||
      merged.congestion != null ||
      merged.smoke != null ||
      merged.maxGradePct != null ||
      merged.clearWidthM != null
    if (!hasParams) {
      const sc = segCoordById.value[id]
      if (sc) {
        merged._baseScore = baseRiskScore(sc.aId, sc.bId, sc.level, {
          nLevels: levels.value.length
        })
      }
    }
    return merged
  }

  // 当前点击路段的元数据（computed 化：模板单次渲染内复用，避免重复推导 10+ 次）
  const activeSegMeta = computed(() => (activeSegId.value ? segMeta(activeSegId.value) : null))

  // 综合约束状态：封锁 > 硬禁行 > 岩爆高发 > 拥堵 > 正常
  const STATE_NORMAL = { stroke: '#64748b', label: '通畅' }
  const STATE_CONGEST = { stroke: '#F59E0B', label: '拥堵缓行' }
  const STATE_RBURST = { stroke: '#E6A23C', label: '岩爆高发' }
  const STATE_BAN = { stroke: '#FB923C', label: '重载禁行' }
  const STATE_BLOCK = { stroke: '#F56C6C', label: '封锁' }
  function segState(m) {
    if (m.blocked) return { ...STATE_BLOCK, clazz: 'st-blocked' }
    if (m.passableLoaded === false) return { ...STATE_BAN, clazz: 'st-ban' }
    if ((m.rockburst || 0) > ROCKBURST_ALERT_THRESHOLD)
      return { ...STATE_RBURST, clazz: 'st-rburst' }
    if ((m.congestion || 0) > CONGESTION_ALERT_THRESHOLD)
      return { ...STATE_CONGEST, clazz: 'st-congest' }
    return { ...STATE_NORMAL, clazz: 'st-ok' }
  }
  function fmtM(v) {
    return v == null ? '-' : `${Number(v).toFixed(1)}m`
  }
  function fmtV(v) {
    return v == null ? '-' : Number(v).toFixed(1)
  }
  function pct(v) {
    return v == null ? '-' : Math.round(v * 100) + '%'
  }
  function barColor(v) {
    const x = v || 0
    return x > METRIC_BAR_HOT_THRESHOLD ? 'c-hot' : x > METRIC_BAR_MID_THRESHOLD ? 'c-mid' : 'c-low'
  }

  // 选中方案的各设备路径（段→节点→坐标数组），供三维地图绘制路线。
  // 后端候选已带多水平路由(nodes + levels，含主井/斜井竖向穿梭)，这里逐点带上
  // level，供 3D 图按真实开采水平落位、并绘制竖井升降段——让多目标算法走的新巷道真实可见。
  const routePoints = computed(() => {
    if (!selected.value) return []
    const assignment = selected.value.assignment
    return candidates.value.map((cands, i) => {
      const idx = assignment[i]
      if (idx >= cands.length) return []
      const cand = cands[idx]
      // 优先用后端给出的多水平路由（节点序列与水平一一对应）
      if (
        Array.isArray(cand.nodes) &&
        Array.isArray(cand.levels) &&
        cand.nodes.length === cand.levels.length
      ) {
        const pts = []
        for (let k = 0; k < cand.nodes.length; k++) {
          const p = layout.value?.nodePositions[cand.nodes[k]]
          if (!p) continue
          pts.push({ node: cand.nodes[k], level: cand.levels[k] ?? 0, x: p.x, y: p.y })
        }
        return pts
      }
      // 兜底：纯平面候选（老数据）
      const startNode = equipmentItems.value[i]?.node || 'S0'
      return pathToPoints(cand.path, startNode, layout.value).map(p => ({
        node: p.node,
        level: 0,
        x: p.x,
        y: p.y
      }))
    })
  })

  // 设备显示名（三维设备 tooltip / 图例）
  const equipNames = computed(() => equipIds.value.map((id, i) => cnId(id) || `设备${i + 1}`))
  // 各巷道段约束元数据（三维地图按段状态着色）
  const metaById = computed(() => {
    const out = {}
    for (const seg of segmentLines.value) out[seg.id] = segMeta(seg.id)
    return out
  })

  // 英文缩写 → 中文显示：LHD-* → 铲运机*；SEG-01 → 路段01；SEG-2-01 → 路段2-01；VERT-节点-层 → 竖井·节点
  function cnId(id) {
    const s = String(id || '')
    if (/^LHD-?/i.test(s)) return s.replace(/^LHD-?/i, '铲运机')
    const vert = s.match(/^VERT-(\w+)-(\d+)$/)
    if (vert) return `竖井·${vert[1]}`
    const m = s.match(/^SEG-(\d{1,2})-(\d{2})$/i)
    if (m) return `路段${m[1]}-${m[2]}`
    return s.replace(/^SEG-?/i, '路段')
  }
  // 巷道段唯一编号显示：顶层=路段01…，深部分层=路段{层}-{序}
  function segLabel(id) {
    const m = String(id || '').match(/^SEG-(\d{1,2})-(\d{2})$/i)
    if (m) return `路段${m[1]}-${m[2]}`
    return cnId(id)
  }
  // 路径文本中文化：SEG-xx → 路段xx
  function cnPath(txt) {
    return String(txt || '').replace(/SEG-?/gi, '路段')
  }

  // 综合安全评级（统一口径见 services/riskUtils.js）：
  // 评分/颜色/标签共享同一阈值（封锁>禁行>岩爆>拥堵>炮烟 + 物理约束），与巷道渲染颜色严格对应
  function riskOf(m) {
    const score = riskScore(m)
    const lv = riskLevel(score)
    return { score, label: lv.label, clazz: lv.clazz }
  }

  return {
    nodePositions,
    segmentLines,
    levels,
    nodeHeights,
    metaById,
    routePoints,
    equipNames,
    activeSegMeta,
    segState,
    riskOf,
    fmtM,
    fmtV,
    pct,
    barColor,
    cnId,
    cnPath
  }
}
