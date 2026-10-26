"""
multi_objective.py —— 井下 LHD 多设备联合调度的多目标优化（后端 · pymoo 引擎）

本模块是前端 nsga3Lhd.js 时代算法的后端承接者：多目标优化**整体迁移到后端**，
统一使用标准库 **pymoo 的 NSGA-III**（Deb & Jain 2014，参考点非支配排序）求解，
不再保留任何自研进化/穷举实现，前端只消费随快照下发的结果：

    snapshot.factors.optimization.paretoFront   ← 预计算结果
    snapshot.factors.optimization.objectiveDefs ← 目标定义（6 目标）
    snapshot.factors.optimization.optStats      ← 统计（engine/source/latency…）

决策变量 / 目标 / 约束口径（与前端及派单接口严格一致）：
  - assignment[i] ∈ [0, len(candidates[i])]，末位"等待"伪候选（索引 = 候选数）；
  - 6 目标：总能耗 / 总时间 / 总风险 / 巷道冲突 / 品位回收(max→取负) / 出矿均衡；
  - 3 条不等式约束（g ≤ 0，违规数为正）：
      C1 有矿须运（全部设备等待 → 违规 1）
      C2 采区全覆盖（未覆盖的有矿采区数）
      C3 加权品位下限（派车设备加权平均品位 < 0.6% → 违规 1）
  - 前端 UI 展示仅保留可行（满足全部约束）的非支配方案。

pymoo 依赖见 requirements.txt（numpy/scipy/pymoo）。
"""
import math
import time

import numpy as np
from pymoo.algorithms.moo.nsga3 import NSGA3
from pymoo.core.problem import ElementwiseProblem
from pymoo.optimize import minimize
from pymoo.util.ref_dirs import get_reference_directions

# =====================================================================
# 一、目标定义（与前端 LHD_OBJECTIVES 完全一致）
# =====================================================================

OBJECTIVES = [
    {
        "id": "energy",
        "name": "总能耗",
        "dir": "min",
        "unit": "kWh",
        "desc": "全部设备本趟能耗之和",
        "why": "出矿能耗是井下运营成本的核心构成：贾纯纯等(2025，《中国矿业》)以最小运输成本为井下无轨运输首要目标，平台对应\"运营成本降低10%\"工程指标，最小化能耗即节能调度。",
    },
    {
        "id": "time",
        "name": "总时间",
        "dir": "min",
        "unit": "min",
        "desc": "全部设备本趟用时之和",
        "why": "出矿时效决定生产节拍与产能：贾纯纯等(2025，《中国矿业》)将等待时间最小化纳入无轨运输多目标；Hooli 等(2024)实测 LHD 装载40s/卸载15s/调整30s 作为单趟时效校核基准，缩短单趟时间支撑高节拍连续生产。",
    },
    {
        "id": "risk",
        "name": "总风险",
        "dir": "min",
        "unit": "",
        "desc": "岩爆/炮烟危险暴露之和",
        "why": "深井高应力采区存在岩爆、炮烟等动态危险：王雷等(2025，《矿产保护与利用》)在井下生产调度中引入安全受限约束，本目标引导路径规避高风险巷道段，对应平台\"岩爆危险区识别偏差≤5m\"指标。",
    },
    {
        "id": "conflict",
        "name": "巷道冲突",
        "dir": "min",
        "unit": "",
        "desc": "多设备共享同段的冲突惩罚",
        "why": "多台铲运机同时占用同一段巷道会引发拥堵与会车风险：Miao & Zhao(2024，Applied Sciences) 对斜坡道拥堵调度的研究表明协调多车通行可提升运输效率10~20%，本目标度量跨采场共享段的相互干扰，促使设备错峰走线、避免巷道死锁。",
    },
    {
        "id": "grade",
        "name": "品位回收",
        "dir": "max",
        "unit": "%",
        "desc": "装载点矿石品位加权",
        "why": "优先派往高品位采场可提升入选矿石品位与金属回收价值：贾纯纯等(2025，《中国矿业》)在井下无轨运输调度中引入卸货量/品位容量约束；平台大型矿 A~H 采场品位约 0.4~1.1% Cu，差异即调度空间。",
    },
    {
        "id": "balance",
        "name": "出矿均衡",
        "dir": "min",
        "unit": "",
        "desc": "设备负载与采区服务均衡度（合并原负载均衡/采场均衡/积压清矿）",
        "why": "负载均衡(贾纯纯等2025\"期望偏差最小化\")、采场出矿均衡(王雷等2025多采场多装备调度)与积压清矿(Wang等2020以采场矿石量为输入)同属\"调度均衡性\"目标且彼此相关，依据目标降维理论(PCA-NSGA-II, Deb & Saxena 2006)合并为单一均衡目标，缓解高维目标困境。",
    },
]

# 品位下限硬约束（%）
GRADE_FLOOR_PCT = 0.6

# pymoo NSGA-III 求解参数
DEFAULT_PYMOO_CONFIG = {
    "generations": 60,          # 终止代数（与前端此前的 60 代口径一致）
    "referenceDivisions": 3,    # Das-Dennis 细分：6 目标下 C(6+3-1,3)=56 参考方向
    "seed": 1024,               # 随机种子：同输入可复现
    "gradeFloorPct": GRADE_FLOOR_PCT,
    "restarts": 3,              # 多种子重启次数：各自独立跑 NSGA-III 后合并取非支配并集，
                                # 缓解进化算法在离散决策空间上的前沿稀疏问题（仍纯 pymoo 引擎）
}

# 热路径本地元组（避免每轮 dict 查找）
_OBJ_META = [(o["id"], o["dir"]) for o in OBJECTIVES]


def round2(v, digits=2):
    k = 10 ** digits
    return round(v * k) / k


# =====================================================================
# 二、方案评估（目标 / 约束，与派单接口同源）
# =====================================================================

def precompute_conflict_matrix(candidates):
    """冲突矩阵：M[i][j][ci][cj] = 设备 i 候选 ci 与设备 j 候选 cj 的共享段数。
    每设备末位保留"等待"伪候选（索引 = 候选数），其冲突恒为 0。"""
    n = len(candidates)
    matrix = [[None] * n for _ in range(n)]
    for i in range(n):
        len_i = len(candidates[i]) + 1
        for j in range(n):
            len_j = len(candidates[j]) + 1
            m = [[0] * len_j for _ in range(len_i)]
            if i != j:
                for ci in range(len(candidates[i])):
                    seg_set_i = set(candidates[i][ci].get("path") or [])
                    for cj in range(len(candidates[j])):
                        m[ci][cj] = sum(
                            1 for s in (candidates[j][cj].get("path") or []) if s in seg_set_i)
            matrix[i][j] = m
    return matrix


def derive_zone_context(candidates):
    """从候选空间推导"有矿待出采区"集合与各采区剩余工作量。"""
    active_zones = []
    zone_seen = set()
    zone_stock = {}
    for cands in candidates:
        for c in cands or []:
            zone = c.get("zone", "") if c else ""
            if not zone:
                continue
            if zone not in zone_seen:
                zone_seen.add(zone)
                active_zones.append(zone)
            if zone not in zone_stock:
                zone_stock[zone] = c.get("remainingWorkT") or 0
    return active_zones, zone_stock


def assignment_zone_stats(assignment, candidates):
    """解析一个方案：每台设备的装载点采区归属。返回 (served: {zone:count}, assigned: [(i,c)])。"""
    served = {}
    assigned = []
    for i, ci in enumerate(assignment):
        cands = candidates[i] or []
        if ci >= len(cands) or not cands[ci]:
            continue
        c = cands[ci]
        zone = c.get("zone") or ""
        assigned.append((i, c))
        if zone:
            served[zone] = served.get(zone, 0) + 1
    return served, assigned


def evaluate_assignment(assignment, candidates, conflict_matrix, zone_ctx=None, grade_floor=None):
    """评估一个多设备联合方案（每台设备一条候选路径 + 等待档）。

    目标 6 个（energy/time/risk/conflict/grade/balance），_constraint 携带硬约束详情：
      - c1Violation：有矿须运（存在可出车任务时"全部设备等待" → 1，否则 0）
      - uncovered：C2 采区全覆盖未覆盖的有矿采区数
      - gradeViolation：C3 加权品位下限（派车设备加权平均品位 < gradeFloor → 1）
    """
    if grade_floor is None:
        grade_floor = GRADE_FLOOR_PCT
    if zone_ctx is None:
        active_zones, zone_stock = derive_zone_context(candidates)
        zone_ctx = (active_zones, zone_stock)
    active_zones, zone_stock = zone_ctx
    n = len(assignment)

    energy = 0.0
    total_time = 0.0
    risk = 0.0
    grade = 0.0
    energies = []
    served, assigned = assignment_zone_stats(assignment, candidates)

    for i, ci in enumerate(assignment):
        cands = candidates[i] or []
        if ci < len(cands):
            c = cands[ci]
            energy += c.get("energyTotal") or 0
            total_time += c.get("timeMin") or 0
            risk += c.get("hazard") or 0
            grade += c.get("gradePct") or 0
            energies.append(c.get("energyTotal") or 0)
        else:
            energies.append(0.0)  # 等待：本趟不出车

    # 巷道冲突：预计算矩阵查表
    conflict = 0
    for i in range(n):
        ci = assignment[i]
        if ci >= len(candidates[i]):
            continue
        for j in range(i + 1, n):
            cj = assignment[j]
            if cj >= len(candidates[j]):
                continue
            conflict += (conflict_matrix[i][j][ci][cj] or 0)

    # 负载均衡：设备间能耗标准差
    mean = energy / n
    var_sum = sum((e - mean) ** 2 for e in energies)
    load_balance = math.sqrt(var_sum / n)

    # 采场出矿均衡：各采区被服务车次标准差
    counts = [served.get(z, 0) for z in active_zones]
    if counts:
        c_mean = sum(counts) / len(counts)
        var_sum = sum((cN - c_mean) ** 2 for cN in counts)
    stope_balance = math.sqrt(var_sum / len(counts)) if counts else 0.0

    # 积压清矿：被服务采区剩余工作量加权
    backlog = sum((zone_stock.get(z) or 0) for z in served if served.get(z, 0) > 0)
    max_stock = max(list(zone_stock.values()) + [1])
    balance = load_balance + stope_balance + 0.1 * (backlog / max_stock)

    # ---- 硬约束 ----
    has_work = any(cands for cands in candidates)
    has_assigned = len(assigned) > 0
    c1_violation = 1 if (has_work and not has_assigned) else 0
    uncovered = sum(1 for z in active_zones if z not in served)
    grade_violation = 0
    if has_assigned:
        avg = grade / len(assigned)
        if avg < grade_floor - 1e-9:
            grade_violation = 1
    total_violation = c1_violation + uncovered + grade_violation

    return {
        "energy": round2(energy, 2),
        "time": round2(total_time, 2),
        "risk": round2(risk, 3),
        "conflict": conflict,
        "grade": round2(grade, 3),
        "balance": round2(balance, 3),
        "_constraint": {
            "isFeasible": total_violation == 0,
            "totalViolation": total_violation,
            "uncovered": uncovered,
            "c1Violation": c1_violation,
            "gradeViolation": grade_violation,
            "avgGradePct": round2(grade / len(assigned), 3) if has_assigned else None,
        },
    }


# =====================================================================
# 三、pymoo 引擎
# =====================================================================

class LhdAssignmentProblem(ElementwiseProblem):
    """pymoo 问题封装：n_var=设备数（每维=候选索引[0, lenₑ]，含等待档），
    n_obj=6（品位回收取负转最小化），n_ieq_constr=3（违规数 ≤ 0）。"""

    def __init__(self, candidates, grade_floor=GRADE_FLOOR_PCT):
        self.candidates = candidates
        self.grade_floor = grade_floor
        self.zone_ctx = derive_zone_context(candidates)
        self.conflict_matrix = precompute_conflict_matrix(candidates)
        n = len(candidates)
        super().__init__(
            n_var=n,
            n_obj=len(OBJECTIVES),
            n_ieq_constr=3,
            xl=np.zeros(n),
            xu=np.array([len(c) for c in candidates], dtype=float),
        )

    def _evaluate(self, X, out, *args, **kwargs):
        # 连续基因 → 最近的合法候选索引（含"等待"档 = 候选数）
        assignment = [
            min(len(self.candidates[i]), max(0, int(round(float(X[i])))))
            for i in range(self.n_var)
        ]
        objs = evaluate_assignment(assignment, self.candidates, self.conflict_matrix,
                                   self.zone_ctx, self.grade_floor)
        c = objs["_constraint"]
        out["F"] = np.array([
            objs["energy"], objs["time"], objs["risk"], objs["conflict"],
            -objs["grade"],       # max 目标取负 → 统一最小化
            objs["balance"],
        ], dtype=float)
        # 不等式约束 g ≤ 0：违规数即为正值
        out["G"] = np.array([c["c1Violation"], c["uncovered"], c["gradeViolation"]],
                            dtype=float)


def _decode_X(X, candidates):
    """pymoo 连续解 → 各设备候选索引（含等待档），并 clamp 到 [0, lenₑ]。"""
    n = len(candidates)
    return [min(len(candidates[i]), max(0, int(round(float(X[i]))))) for i in range(n)]


def _prune_nondominated(pool):
    """对可行方案池求非支配集（统一最小化口径，品位取负）。池已保证可行。"""
    if len(pool) <= 1:
        return pool
    vec = np.array([[
        ind["objectives"][oid] if odir == "min" else -ind["objectives"][oid]
        for oid, odir in _OBJ_META
    ] for ind in pool], dtype=float)
    m = vec.shape[0]
    dominated = np.zeros(m, dtype=bool)
    chunk = 1500
    for s in range(0, m, chunk):
        block = vec[s:s + chunk]
        leq = np.all(vec[:, None, :] <= block[None, :, :], axis=2)
        lt = np.any(vec[:, None, :] < block[None, :, :], axis=2)
        dominated[s:s + chunk] = np.any(leq & lt, axis=0)
    return [ind for i, ind in enumerate(pool) if not dominated[i]]


def solve_pareto(candidates, custom_config=None):
    """运行 pymoo NSGA-III 求解帕累托前沿（后端统一引擎，无自研算法）。

    离散决策空间（每台设备索引 + 等待档）上单次进化易得稀疏前沿，故按
    restarts 次多种子重启，把各自非支配可行解求并集后再做约束感知非支配剪枝
    —— 仍是纯 pymoo 引擎，只是多次运行合并。

    @param candidates: 按设备分组的候选路径（snapshot.factors.optimization.byEquipment 顺序）
    @param custom_config: {generations?, referenceDivisions?, seed?, gradeFloorPct?, restarts?}
    @returns {paretoFront, objectives, stats, source}
        paretoFront: 仅保留可行非支配方案 [{assignment, objectives, rank, crowdingDistance}]
    """
    cfg = dict(DEFAULT_PYMOO_CONFIG)
    if custom_config:
        cfg.update(custom_config)

    # 无设备/无候选 → 空前沿（模拟器侧标记 source='error' 或前端按无候选处理）
    if not candidates or all(len(c) == 0 for c in candidates):
        stats = {
            "algorithm": "NSGA-III (pymoo)", "engine": "pymoo", "source": "nsga3",
            "paretoSize": 0, "combos": 1 if candidates else 0,
            "equipmentCount": len(candidates), "stopeCount": 0,
            "gradeFloorPct": cfg["gradeFloorPct"], "latencyMs": 0.0,
            "restarts": cfg["restarts"],
        }
        return {"paretoFront": [], "objectives": OBJECTIVES, "stats": stats, "source": "nsga3"}

    t0 = time.perf_counter()
    problem = LhdAssignmentProblem(candidates, cfg["gradeFloorPct"])
    ref_dirs = get_reference_directions(
        "das-dennis", len(OBJECTIVES), n_partitions=cfg["referenceDivisions"])

    # 多种子重启：各自独立运行 NSGA-III，收集全部可行非支配解
    seen = {}
    restarts = max(1, int(cfg["restarts"]))
    for k in range(restarts):
        algorithm = NSGA3(
            pop_size=len(ref_dirs),
            ref_dirs=ref_dirs,
            eliminate_duplicates=True,   # 离散空间重复解清洗
        )
        res = minimize(
            problem,
            algorithm,
            ("n_gen", cfg["generations"]),
            seed=int(cfg["seed"]) + k,
            verbose=False,
            save_history=False,
        )
        for X in np.asarray(res.opt.get("X"), dtype=float):
            assignment = _decode_X(X, candidates)
            key = ",".join(str(x) for x in assignment)
            if key in seen:
                continue
            objs = evaluate_assignment(assignment, candidates, problem.conflict_matrix,
                                       problem.zone_ctx, cfg["gradeFloorPct"])
            if not objs["_constraint"]["isFeasible"]:
                continue
            seen[key] = {
                "assignment": assignment,
                "objectives": objs,
                "rank": 0,
                "crowdingDistance": 0.0,
            }

    # 多种子并集 → 非支配剪枝
    pareto_front = _prune_nondominated(list(seen.values()))

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    active_zones, _ = problem.zone_ctx
    combos = 1
    for c in candidates:
        combos *= (len(c) + 1)
    stats = {
        "algorithm": "NSGA-III (pymoo)",
        "engine": "pymoo",
        "paretoSize": len(pareto_front),
        "populationSize": len(ref_dirs),
        "restarts": restarts,
        "objectiveCount": len(OBJECTIVES),
        "equipmentCount": len(candidates),
        "stopeCount": len(active_zones),
        "gradeFloorPct": cfg["gradeFloorPct"],
        "combos": combos,
        "latencyMs": round2(elapsed_ms, 1),
        "feasibleRatio": round2(
            len(pareto_front) / max(1, len(seen)), 3),
    }
    return {
        "paretoFront": pareto_front,
        "objectives": OBJECTIVES,
        "stats": stats,
        "source": "nsga3",
    }