"""3.1 多目标调度求解后端可配置——契约（shared-consistency-baseline.json#solverCmps）与行为测试。

契约双端锁定：本文件与前端 cesium1/src/features/realtime-monitoring/services/__tests__/
solverContract.test.js 共用 solverCmps 段，任一端后端枚举/默认后端/配置路径/统一输出键/
optStats 键/展示标签不同步即失败。

覆盖：
  - 契约：BACKENDS / 默认后端 / 配置路径 / 输出键 / optStats 键 / 展示标签 与 baseline 一致
  - Nsga3Solver：薄包装 solve_pareto，registry 输出前沿与直调逐点一致（默认路径行为不变）
  - MlSolver：只取候选索引 → 后端 evaluate_assignment() 重算目标值（不采信外部自报）
  - 索引校验：长度不符/越界/非整数 → 丢弃
  - fallback 链：外部 ML 失败/全非法 → 降级 NSGA-III，optStats 如实标注 degraded
"""

import json
from pathlib import Path

import pytest

from app.services.scheduling import solver_registry
from app.services.scheduling.multi_objective import (
    evaluate_assignment,
    precompute_conflict_matrix,
    solve_pareto,
)
from app.services.scheduling.solver_registry import (
    BACKENDS,
    DEFAULT_CONFIG,
    SOLVER_LABELS,
    Nsga3Solver,
    MlSolver,
    _validate_assignment,
    load_solver_config,
    reset_solver_config_cache,
    solve_multi_objective,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE = json.loads(
    (REPO_ROOT / "shared-consistency-baseline.json").read_text(encoding="utf-8")
)["solverCmps"]

# 求解加速配置（寄存器行为测试用，不改变契约）
SMALL_CFG = {"generations": 4, "restarts": 1, "referenceDivisions": 2}


def _candidates():
    """2 台设备 × 2 候选（含 zone/grade/能耗/风险等 evaluate_assignment 依赖字段）。

    索引 2 = 末位"等待"伪候选。可行解须覆盖 Z1/Z2 且加权品位 ≥ 0.6%。
    """
    def cand(target, zone, energy, t, hazard, grade):
        return {"target": target, "zone": zone, "path": [target], "energyTotal": energy,
                "timeMin": t, "hazard": hazard, "gradePct": grade, "remainingWorkT": 10}
    return [
        [cand("MP-1", "Z1", 20, 10, 1, 0.8), cand("MP-2", "Z2", 40, 15, 2, 0.9)],
        [cand("MP-2", "Z2", 25, 12, 1, 0.7), cand("MP-1", "Z1", 45, 18, 3, 0.9)],
    ]


def _ml_config(backend="ml", endpoint="http://127.0.0.1:9/solve"):
    return {
        "backend": backend,
        "fallback": ["nsga3"],
        "ml": {"endpoint": endpoint, "timeoutMs": 50, "retries": 0, "modelVersion": "v0"},
    }


# ---------- 契约（solverCmps）----------

def test_backends_and_default_match_baseline():
    assert list(BACKENDS) == list(BASELINE["backends"])
    assert DEFAULT_CONFIG["backend"] == BASELINE["defaultBackend"]


def test_solver_labels_match_baseline():
    for bid, label in BASELINE["labels"].items():
        assert SOLVER_LABELS[bid] == label


def test_config_file_backend_within_baseline():
    assert BASELINE["configPath"] == "backend-py/config/scheduling_solver.json"
    cfg = json.loads(
        (Path(__file__).resolve().parents[1] / "config" / "scheduling_solver.json")
        .read_text(encoding="utf-8"))
    assert cfg["backend"] in BASELINE["backends"]
    # 出厂默认必须是内置 NSGA-III（保证默认路径行为不变）
    assert cfg["backend"] == BASELINE["defaultBackend"]


def test_output_keys_match_baseline():
    reset_solver_config_cache()
    result = solve_multi_objective(_candidates(), custom_config=SMALL_CFG)
    for k in BASELINE["outputKeys"]:
        assert k in result
    for k in BASELINE["optStatsKeys"]:
        assert k in result["optStats"]


# ---------- Nsga3Solver：薄包装零行为变化 ----------

def test_nsga3_solver_default_path_identical_to_solve_pareto():
    """默认 registry 路径的前沿须与直调 solve_pareto 逐点一致（迁移零行为变化）。"""
    cands = _candidates()
    direct = solve_pareto(cands, custom_config=SMALL_CFG)
    via_registry = Nsga3Solver().solve(cands, custom_config=SMALL_CFG)
    assert via_registry["source"] == "nsga3"
    assert via_registry["paretoFront"] == direct["paretoFront"]
    assert via_registry["objectiveDefs"] == direct["objectives"]
    assert via_registry["optStats"]["label"] == SOLVER_LABELS["nsga3"]


def test_default_config_uses_nsga3():
    reset_solver_config_cache()
    cfg = load_solver_config()
    assert cfg["backend"] == "nsga3"
    assert cfg["fallback"] == []  # 出厂 fallback 与首选同源被过滤，order 恒为 ["nsga3"]


# ---------- MlSolver：只取候选索引，后端重算目标值 ----------

def test_ml_solver_recomputes_objectives(monkeypatch):
    monkeypatch.setattr(
        MlSolver, "_request",
        lambda self, cands, w: {"assignments": [[0, 0]], "modelVersion": "v9"})
    cands = _candidates()
    result = MlSolver(_ml_config()["ml"]).solve(cands)

    assert result["source"] == "ml"
    assert result["optStats"]["label"] == SOLVER_LABELS["ml"]
    assert result["optStats"]["modelVersion"] == "v9"
    assert len(result["paretoFront"]) == 1

    # 目标值真源在后端：须与 evaluate_assignment([0,0]) 逐字段一致
    expected = evaluate_assignment([0, 0], cands, precompute_conflict_matrix(cands))
    got = result["paretoFront"][0]["objectives"]
    for k in ("energy", "time", "risk", "conflict", "grade", "balance"):
        assert got[k] == expected[k]
    assert result["paretoFront"][0]["assignment"] == [0, 0]


def test_ml_solver_rejects_all_out_of_range(monkeypatch):
    monkeypatch.setattr(
        MlSolver, "_request",
        lambda self, cands, w: {"assignments": [[9, 0]]})  # 9 越界
    with pytest.raises(ValueError):
        MlSolver(_ml_config()["ml"]).solve(_candidates())


@pytest.mark.parametrize("bad", [
    [1],                 # 长度不符
    [1, 2, 3],           # 长度不符
    [3, 0],              # 越界（上限 = lenₑ = 2）
    [-1, 0],             # 负索引
    [1.5, 0],            # 非整数
    [True, 0],           # bool 拒绝
    "10",                # 非列表
])
def test_validate_assignment_rejects_bad(bad):
    assert _validate_assignment(bad, _candidates()) is None


def test_validate_assignment_accepts_wait_slot():
    # 索引 == 候选数 = 等待档，合法
    assert _validate_assignment([2, 1], _candidates()) == [2, 1]


# ---------- fallback 链与降级标注 ----------

def test_ml_failure_falls_back_to_nsga3_degraded(monkeypatch):
    monkeypatch.setattr(solver_registry, "load_solver_config", lambda: _ml_config())
    # 外部服务不可达（endpoint 指向不可用端口，retries=0）
    result = solve_multi_objective(_candidates(), custom_config=SMALL_CFG)

    assert result["source"] == "nsga3"
    assert result["optStats"]["degraded"] is True
    assert result["optStats"]["requestedBackend"] == "ml"
    assert "降级" in result["optStats"]["label"]


def test_ml_all_invalid_falls_back_degraded(monkeypatch):
    monkeypatch.setattr(solver_registry, "load_solver_config", lambda: _ml_config())
    monkeypatch.setattr(
        MlSolver, "_request",
        lambda self, cands, w: {"assignments": [[9, 9]]})  # 全越界 → ML 判失败
    result = solve_multi_objective(_candidates(), custom_config=SMALL_CFG)
    assert result["source"] == "nsga3"
    assert result["optStats"]["degraded"] is True


def test_ml_success_used_when_configured(monkeypatch):
    monkeypatch.setattr(solver_registry, "load_solver_config", lambda: _ml_config())
    monkeypatch.setattr(
        MlSolver, "_request",
        lambda self, cands, w: {"assignments": [[0, 0]], "modelVersion": "vX"})
    result = solve_multi_objective(_candidates(), custom_config=SMALL_CFG)
    assert result["source"] == "ml"
    assert "degraded" not in result["optStats"]
