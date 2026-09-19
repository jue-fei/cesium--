/**
 * lhdSchedulingUtils.js —— 井下 LHD 现场调度：前端仅存的展示/提交辅助工具
 *
 * 说明：NSGA-III / 精确穷举等多目标优化本体已整体迁移到后端
 * （backend-py/app/services/scheduling/multi_objective.py），并在快照生成阶段
 * 预计算帕累托前沿随 snapshot.factors.optimization 下发；前端不再保留进化算法。
 * 本模块只保留视图展示与派单提交所需的轻量工具：
 *   - LHD_OBJECTIVES / GRADE_FLOOR_PCT：目标定义与品位下限的**最小展示兜底**
 *     （仅在后端未下发时启用；真源在后端 multi_objective.py 的 OBJECTIVES /
 *     GRADE_FLOOR_PCT，随 snapshot.factors.optimization.objectiveDefs 与
 *     optStats.gradeFloorPct 下发，消费端优先取下发值）；
 *   - decodeAssignment：把帕累托解（候选索引序列）解码为 apply_assignment 派单列表；
 *   - assignmentZoneStats：按采区汇总方案派车情况（采场卡片/覆盖/品位摘要）。
 */

// 目标定义最小兜底（仅作后端未下发 objectiveDefs 时的兜底，真源在后端
// multi_objective.py OBJECTIVES——含文献 why 字段，随快照 objectiveDefs 下发；
// 模板以 obj.why || obj.desc 展示，故兜底省略 why 仅保留必需展示字段）。
const LHD_OBJECTIVES = [
  { id: 'energy', name: '总能耗', dir: 'min', unit: 'kWh', desc: '全部设备本趟能耗之和' },
  { id: 'time', name: '总时间', dir: 'min', unit: 'min', desc: '全部设备本趟用时之和' },
  { id: 'risk', name: '总风险', dir: 'min', unit: '', desc: '岩爆/炮烟危险暴露之和' },
  { id: 'conflict', name: '巷道冲突', dir: 'min', unit: '', desc: '多设备共享同段的冲突惩罚' },
  { id: 'grade', name: '品位回收', dir: 'max', unit: '%', desc: '装载点矿石品位加权' },
  {
    id: 'balance',
    name: '出矿均衡',
    dir: 'min',
    unit: '',
    desc: '设备负载与采区服务均衡度（合并原负载均衡/采场均衡/积压清矿）'
  }
]

// 品位下限硬约束（%）——仅作后端未下发时的兜底，真源在后端 multi_objective.py
// 的 GRADE_FLOOR_PCT（随快照 factors.optimization.optStats.gradeFloorPct 下发）
const GRADE_FLOOR_PCT = 0.6

/**
 * 把 NSGA-III 选解解码为 apply_assignment 接口可提交的派单列表。
 * 索引 == 候选数 → "等待"设备（本趟不出车，不提交）。
 * @param {number[]} assignment 每台设备的候选索引
 * @param {Array<Array<object>>} candidates
 * @param {string[]} equipmentIds 与 candidates 同序的设备 id
 * @returns {Array<{equipId, target, path}>}
 */
function decodeAssignment(assignment, candidates, equipmentIds = []) {
  const out = []
  for (let i = 0; i < assignment.length; i++) {
    const candIdx = assignment[i]
    const cands = candidates[i] || []
    if (candIdx >= cands.length) continue
    const c = cands[candIdx]
    const item = {
      equipId: equipmentIds[i],
      target: c.target,
      path: c.path
    }
    // 候选携带"采矿点→出口"完整节点/水平序列时一并下发（后端返程执行用，代价由后端重算）
    for (const k of ['nodes', 'levels']) {
      if (c[k] != null) item[k] = c[k]
    }
    out.push(item)
  }
  return out
}

/**
 * 解析一个方案：每台设备的装载点采区归属（供采场卡片/覆盖/品位摘要展示）。
 * @returns {{ served: Map<string,number>, assigned: Array<{i, c}> }}
 */
function assignmentZoneStats(assignment, candidates) {
  const served = new Map()
  const assigned = []
  for (let i = 0; i < assignment.length; i++) {
    const cands = candidates[i] || []
    const ci = assignment[i]
    if (ci >= cands.length || !cands[ci]) continue
    const c = cands[ci]
    const zone = c.zone || ''
    assigned.push({ i, c })
    if (zone) served.set(zone, (served.get(zone) || 0) + 1)
  }
  return { served, assigned }
}

export { LHD_OBJECTIVES, GRADE_FLOOR_PCT, decodeAssignment, assignmentZoneStats }
