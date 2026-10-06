"""
solver_registry.py —— 多目标调度求解后端注册与路由（后端 · 求解器可配置）

平台把"用哪个求解后端"外置为配置（config/scheduling_solver.json），各求解器经
统一 Protocol 注册，切换求解后端**零前端发布**：

    backend:  "nsga3" | "ml"     —— 首选求解后端
    fallback: ["nsga3", ...]     —— 首选失败时按序降级的候选后端

统一输出契约（前端 lhdSchedulingUtils / MultiObjectiveLhdView 消费口径，双端契约见
shared-consistency-baseline.json#solverCmps）：

    {paretoFront, objectiveDefs, optStats:{source, label, ...}, source}

    - source：实际生效的求解后端 id（降级后写实际使用的后端，而非请求的后端）；
    - optStats.label：展示标签真源（前端 optSourceLabel 直接消费，新增后端零前端发布）；
    - 降级时另记 optStats.degraded=true 与 requestedBackend（如实标注降级）。

安全铁律：**任何求解器都只允许返回"每台设备的候选索引"**（含末位"等待"伪候选，
索引 = 候选数）。目标值一律由后端 evaluate_assignment() 重算，**绝不采信外部自报的
objectives**；候选索引越界 / 长度不符的方案直接判非法丢弃。如此，外部 ML 服务即便
返回伪造目标值也无法污染帕累托前沿。

内置 NSGA-III（Nsga3Solver）只是对 multi_objective.solve_pareto 的薄包装——默认配置
（backend=nsga3）下输出与迁移前逐字节一致。
"""
import json
import logging
import urllib.request
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

from app.services.scheduling.multi_objective import (
    OBJECTIVES,
    derive_zone_context,
    evaluate_assignment,
    precompute_conflict_matrix,
    solve_pareto,
    _prune_nondominated,
)

logger = logging.getLogger(__name__)

# 配置真源（后端持有，前端零发布）
CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "scheduling_solver.json"

# 求解后端枚举（真源，随 solverCmps.backends 契约锁定）
BACKENDS = ("nsga3", "ml")

# 各求解后端展示标签（前端 optSourceLabel 直接消费；新增/切换后端零前端发布）
SOLVER_LABELS = {
    "nsga3": "后端 NSGA-III · pymoo",
    "ml": "外部 ML 求解（后端校验）",
    "error": "求解异常",
}

# 默认配置：纯内置 NSGA-III，fallback 空 → 与迁移前行为一致
DEFAULT_CONFIG = {
    "backend": "nsga3",
    "fallback": [],
    "ml": {"endpoint": "", "timeoutMs": 3000, "retries": 1, "modelVersion": ""},
}

_config_cache = None


def load_solver_config():
    """读取求解后端配置（模块级缓存；文件缺失/非法 → 默认纯 NSGA-III，行为与原版一致）。"""
    global _config_cache
    if _config_cache is None:
        raw = {}
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = {}
        backend = str(raw.get("backend") or DEFAULT_CONFIG["backend"])
        if backend not in BACKENDS:
            logger.warning("[Solver] 配置的 backend=%r 非法，回退 nsga3", backend)
            backend = DEFAULT_CONFIG["backend"]
        fallback = [b for b in (raw.get("fallback") or [])
                    if b in BACKENDS and b != backend]
        ml = dict(DEFAULT_CONFIG["ml"])
        ml.update(raw.get("ml") or {})
        _config_cache = {
            "backend": backend,
            "fallback": fallback,
            "ml": {
                "endpoint": str(ml.get("endpoint") or ""),
                "timeoutMs": int(ml.get("timeoutMs") or 3000),
                "retries": max(0, int(ml.get("retries") or 0)),
                "modelVersion": str(ml.get("modelVersion") or ""),
            },
        }
    return _config_cache


def reset_solver_config_cache():
    """测试钩子：清空配置缓存。"""
    global _config_cache
    _config_cache = None


@runtime_checkable
class SchedulerSolver(Protocol):
    """求解器协议：输入候选空间，输出统一契约 dict（见模块 docstring）。"""

    id: str

    def solve(self, candidates, weights=None, custom_config=None) -> dict:
        ...


def _validate_assignment(assignment, candidates):
    """校验外部求解器返回的候选索引：长度一致 + 每维 ∈ [0, lenₑ]（末位=等待档）。

    非法返回 None（调用方丢弃该方案），绝不因外部非法输入抛异常中断整条链。
    返回值为正规化的 int 列表（拒绝 bool / 非整数 float / 越界）。
    """
    if not isinstance(assignment, (list, tuple)) or len(assignment) != len(candidates):
        return None
    out = []
    for i, v in enumerate(assignment):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        if isinstance(v, float) and not v.is_integer():
            return None
        iv = int(v)
        if iv < 0 or iv > len(candidates[i]):
            return None
        out.append(iv)
    return out


class Nsga3Solver:
    """内置 NSGA-III 求解器：对 multi_objective.solve_pareto 的**薄包装**，零行为变化。"""

    id = "nsga3"

    def solve(self, candidates, weights=None, custom_config=None):
        r = solve_pareto(candidates, custom_config=custom_config, weights=weights)
        stats = dict(r["stats"])
        stats["source"] = "nsga3"
        stats["label"] = SOLVER_LABELS["nsga3"]
        return {
            "paretoFront": r["paretoFront"],
            "objectiveDefs": r["objectives"],
            "optStats": stats,
            "source": "nsga3",
        }


class MlSolver:
    """外部 ML 求解器：HTTP 外呼只取候选索引，目标值一律后端 evaluate_assignment() 重算。"""

    id = "ml"

    def __init__(self, ml_cfg, scenario=""):
        self.cfg = ml_cfg
        self.scenario = scenario

    def _request(self, candidates, weights):
        """POST {scenario, objectiveIds, weights, candidates} → {assignments, modelVersion?}。

        带 retries 次重试（网络/超时/格式异常均重试）；重试耗尽抛 RuntimeError 交由
        上层 fallback 链降级。
        """
        endpoint = self.cfg.get("endpoint") or ""
        if not endpoint:
            raise RuntimeError("未配置外部 ML 求解服务 endpoint")
        payload = json.dumps({
            "scenario": self.scenario,
            "objectiveIds": [o["id"] for o in OBJECTIVES],
            "weights": weights,
            "candidates": candidates,
        }).encode("utf-8")
        attempts = max(0, int(self.cfg.get("retries", 0))) + 1
        last_err = None
        for _ in range(attempts):
            try:
                req = urllib.request.Request(
                    endpoint, data=payload, method="POST",
                    headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(
                        req, timeout=self.cfg["timeoutMs"] / 1000.0) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                if not isinstance(body, dict):
                    raise ValueError("外部 ML 响应非 JSON 对象")
                return body
            except Exception as e:  # noqa: BLE001 —— 外部源异常必须可重试/降级
                last_err = e
        raise RuntimeError(f"外部 ML 求解服务调用失败：{last_err}")

    def solve(self, candidates, weights=None, custom_config=None):
        body = self._request(candidates, weights)
        assignments = body.get("assignments")
        if not isinstance(assignments, list) or not assignments:
            raise ValueError("外部 ML 响应缺少 assignments 列表")

        # 目标值真源在后端：候选索引 → evaluate_assignment 重算，不采信外部 objectives
        conflict_matrix = precompute_conflict_matrix(candidates)
        zone_ctx = derive_zone_context(candidates)
        pool, rejected = [], 0
        for a in assignments:
            idx = _validate_assignment(a, candidates)
            if idx is None:
                rejected += 1
                continue
            objs = evaluate_assignment(idx, candidates, conflict_matrix, zone_ctx)
            if not objs["_constraint"]["isFeasible"]:
                rejected += 1
                continue
            pool.append({"assignment": idx, "objectives": objs,
                         "rank": 0, "crowdingDistance": 0.0})
        if not pool:
            raise ValueError("外部 ML 返回的候选索引全部非法或不可行")

        front = _prune_nondominated(pool)
        stats = {
            "algorithm": "ML (external)",
            "engine": "ml",
            "source": "ml",
            "label": SOLVER_LABELS["ml"],
            "paretoSize": len(front),
            "equipmentCount": len(candidates),
            "objectiveCount": len(OBJECTIVES),
            "rejected": rejected,
            "modelVersion": str(body.get("modelVersion")
                                 or self.cfg.get("modelVersion") or ""),
        }
        return {
            "paretoFront": front,
            "objectiveDefs": OBJECTIVES,
            "optStats": stats,
            "source": "ml",
        }


def _build_solver(name, cfg, scenario=""):
    """按后端名构建求解器实例；未知后端返回 None。"""
    if name == "nsga3":
        return Nsga3Solver()
    if name == "ml":
        return MlSolver(cfg["ml"], scenario=scenario)
    return None


def solve_multi_objective(candidates, weights=None, custom_config=None, scenario=""):
    """按配置路由求解后端：首选 → 失败依次 fallback；实际后端如实写回 optStats。

    内置 NSGA-III 恒作为最终兜底（保证面板始终有前沿），故任何外部后端失败都会
    降级到 NSGA-III 并在 optStats 标注 degraded/requestedBackend。

    默认配置（backend=nsga3）下 order=["nsga3"]，输出与迁移前逐字节一致。

    @returns {paretoFront, objectiveDefs, optStats, source}
    """
    cfg = load_solver_config()
    order = [cfg["backend"]] + [b for b in cfg["fallback"] if b != cfg["backend"]]
    if "nsga3" not in order:
        order.append("nsga3")  # 内置引擎兜底：外部后端失败时保证仍有前沿

    last_err = None
    for i, name in enumerate(order):
        solver = _build_solver(name, cfg, scenario=scenario)
        if solver is None:
            continue
        try:
            result = solver.solve(candidates, weights=weights, custom_config=custom_config)
        except Exception as e:  # noqa: BLE001 —— 首选失败必须可降级，见 docstring
            last_err = e
            logger.warning("[Solver] 后端 %s 求解失败，尝试降级：%s", name, e)
            continue
        if i > 0:
            stats = dict(result.get("optStats") or {})
            stats["degraded"] = True
            stats["requestedBackend"] = cfg["backend"]
            base = stats.get("label") or SOLVER_LABELS.get(name, name)
            stats["label"] = f"{base}（{cfg['backend']} 降级）"
            result = {**result, "optStats": stats}
        return result

    raise RuntimeError(f"全部求解后端失败：{last_err}")
