/**
 * lhdSchedulingUtils.js —— 井下 LHD 现场调度：前端仅存的展示/提交辅助工具
 *
 * 说明：NSGA-III / 精确穷举等多目标优化本体已整体迁移到后端
 * （backend-py/app/services/scheduling/multi_objective.py），并在快照生成阶段
 * 预计算帕累托前沿随 snapshot.factors.optimization 下发；前端不再保留进化算法。
 * 本模块只保留视图展示与派单提交所需的轻量工具：
 *   - LHD_OBJECTIVES / GRADE_FLOOR_PCT：目标定义与品位下限的展示兜底；
 *   - decodeAssignment：把帕累托解（候选索引序列）解码为 apply_assignment 派单列表；
 *   - assignmentZoneStats：按采区汇总方案派车情况（采场卡片/覆盖/品位摘要）。
 */

// 目标定义（与后端 multi_objective.OBJECTIVES 一致；后端下发 objectiveDefs 时以其为准）
const LHD_OBJECTIVES = [
  {
    id: 'energy',
    name: '总能耗',
    dir: 'min',
    unit: 'kWh',
    desc: '全部设备本趟能耗之和',
    why: '出矿能耗是井下运营成本的核心构成：贾纯纯等(2025，《中国矿业》)以最小运输成本为井下无轨运输首要目标，平台对应"运营成本降低10%"工程指标，最小化能耗即节能调度。'
  },
  {
    id: 'time',
    name: '总时间',
    dir: 'min',
    unit: 'min',
    desc: '全部设备本趟用时之和',
    why: '出矿时效决定生产节拍与产能：贾纯纯等(2025，《中国矿业》)将等待时间最小化纳入无轨运输多目标；Hooli 等(2024)实测 LHD 装载40s/卸载15s/调整30s 作为单趟时效校核基准，缩短单趟时间支撑高节拍连续生产。'
  },
  {
    id: 'risk',
    name: '总风险',
    dir: 'min',
    unit: '',
    desc: '岩爆/炮烟危险暴露之和',
    why: '深井高应力采区存在岩爆、炮烟等动态危险：王雷等(2025，《矿产保护与利用》)在井下生产调度中引入安全受限约束，本目标引导路径规避高风险巷道段，对应平台"岩爆危险区识别偏差≤5m"指标。'
  },
  {
    id: 'conflict',
    name: '巷道冲突',
    dir: 'min',
    unit: '',
    desc: '多设备共享同段的冲突惩罚',
    why: '多台铲运机同时占用同一段巷道会引发拥堵与会车风险：Miao & Zhao(2024，Applied Sciences) 对斜坡道拥堵调度的研究表明协调多车通行可提升运输效率10~20%，本目标度量跨采场共享段的相互干扰，促使设备错峰走线、避免巷道死锁。'
  },
  {
    id: 'grade',
    name: '品位回收',
    dir: 'max',
    unit: '%',
    desc: '装载点矿石品位加权',
    why: '优先派往高品位采场可提升入选矿石品位与金属回收价值：贾纯纯等(2025，《中国矿业》)在井下无轨运输调度中引入卸货量/品位容量约束；平台大型矿 A~H 采场品位约 0.4~1.1% Cu，差异即调度空间。'
  },
  {
    id: 'balance',
    name: '出矿均衡',
    dir: 'min',
    unit: '',
    desc: '设备负载与采区服务均衡度（合并原负载均衡/采场均衡/积压清矿）',
    why: '负载均衡(贾纯纯等2025"期望偏差最小化")、采场出矿均衡(王雷等2025多采场多装备调度)与积压清矿(Wang等2020以采场矿石量为输入)同属"调度均衡性"目标且彼此相关，依据目标降维理论(PCA-NSGA-II, Deb & Saxena 2006)合并为单一均衡目标，缓解高维目标困境。'
  }
]

// 品位下限硬约束（%）
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
