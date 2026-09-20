"""多目标权重调节契约与单元行为（pytest，从 backend-py 根目录运行）。

锁定 weight_source / multi_objective 权重链路与仓库根 shared-consistency-baseline.json
的 weightTuningCmps 一致；前端对应用例为 cesium1/src/features/realtime-monitoring/
services/__tests__/weightTuningContract.test.js。任一端改动目标 id 清单 / 权重来源
枚举 / API 路径而不同步基线/对端实现，对应测试即失败。

覆盖：
  - 契约：OBJECTIVE_IDS 与 baseline.objectiveIds 一致
  - normalize_weights：归一化 / 等权兜底 / 未知键与非法值容忍 / 非字典拒绝
  - recommend_from_front：空前沿 -1、单点 0、加权推荐取最小标量解
  - solve_pareto(weights=...)：偏好参考方向追加后仍返回可行非支配前沿
  - get_weight_recommendation：未启用外部服务时降级等权（degraded=true）
"""

import json
from pathlib import Path

import pytest

from app.services.scheduling import weight_source
from app.services.scheduling.multi_objective import (
    OBJECTIVES,
    normalize_weights,
    recommend_from_front,
    solve_pareto,
)
from app.services.scheduling.weight_source import OBJECTIVE_IDS, get_weight_recommendation

BASELINE_PATH = Path(__file__).resolve().parents[2] / "shared-consistency-baseline.json"
BASELINE = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


# ---------- 契约 ----------

def test_objective_ids_match_baseline():
    assert OBJECTIVE_IDS == list(BASELINE["weightTuningCmps"]["objectiveIds"])
    assert [o["id"] for o in OBJECTIVES] == OBJECTIVE_IDS


def test_recommend_sources_match_baseline():
    assert list(BASELINE["weightTuningCmps"]["recommendSources"]) == [
        "ml-external", "fallback"
    ]


def test_config_file_matches_baseline_timeout():
    cfg = json.loads(
        (Path(__file__).resolve().parents[1] / "config" / "ml_weight_endpoint.json")
        .read_text(encoding="utf-8"))
    assert int(cfg["timeoutMs"]) == int(BASELINE["weightTuningCmps"]["recommendTimeoutMs"])


# ---------- normalize_weights ----------

def test_normalize_weights_sums_to_one():
    w = normalize_weights({"energy": 2, "time": 1, "risk": 1})
    assert abs(sum(w.values()) - 1.0) < 1e-9
    assert abs(w["energy"] - 0.5) < 1e-9


def test_normalize_weights_nonpositive_total_falls_back_equal():
    w = normalize_weights({"energy": 0, "time": -3})
    assert abs(sum(w.values()) - 1.0) < 1e-9
    assert len(set(w.values())) == 1


def test_normalize_weights_tolerates_unknown_and_invalid():
    w = normalize_weights({"energy": 1, "unknown": 99, "time": "x", "grade": None})
    assert set(w) == {o["id"] for o in OBJECTIVES}
    assert abs(sum(w.values()) - 1.0) < 1e-9
    assert w["energy"] == 1.0


def test_normalize_weights_rejects_non_dict():
    with pytest.raises(ValueError):
        normalize_weights([1, 2, 3])
    with pytest.raises(ValueError):
        normalize_weights(None)


# ---------- recommend_from_front ----------

def _front(*objective_dicts):
    return [{"objectives": d, "assignment": [0], "rank": 0, "crowdingDistance": 0.0}
            for d in objective_dicts]


def test_recommend_empty_and_single():
    assert recommend_from_front([], {"energy": 1}) == -1
    assert recommend_from_front(_front({"energy": 1}), {"energy": 1}) == 0


def test_recommend_prefers_min_energy_when_weighted():
    front = _front(
        {"energy": 10, "time": 1, "risk": 0, "conflict": 0, "grade": 1, "balance": 0},
        {"energy": 1, "time": 10, "risk": 0, "conflict": 0, "grade": 1, "balance": 0},
    )
    assert recommend_from_front(front, {"energy": 1}) == 1
    assert recommend_from_front(front, {"time": 1}) == 0


def test_recommend_grade_is_max_direction():
    front = _front(
        {"energy": 0, "time": 0, "risk": 0, "conflict": 0, "grade": 0.4, "balance": 0},
        {"energy": 0, "time": 0, "risk": 0, "conflict": 0, "grade": 1.1, "balance": 0},
    )
    assert recommend_from_front(front, {"grade": 1}) == 1


# ---------- solve_pareto(weights=...) ----------

def _candidates():
    """2 台设备 × 2 候选（含 zone/grade/能耗/风险等 evaluate_assignment 依赖字段）。"""
    def cand(target, zone, energy, t, hazard, grade):
        return {"target": target, "zone": zone, "path": [target], "energyTotal": energy,
                "timeMin": t, "hazard": hazard, "gradePct": grade, "remainingWorkT": 10}
    return [
        [cand("MP-1", "Z1", 20, 10, 1, 0.8), cand("MP-2", "Z2", 40, 15, 2, 0.9)],
        [cand("MP-2", "Z2", 25, 12, 1, 0.7), cand("MP-1", "Z1", 45, 18, 3, 0.9)],
    ]


def test_solve_pareto_with_weights_returns_valid_front():
    result = solve_pareto(
        _candidates(),
        custom_config={"generations": 5, "restarts": 1, "referenceDivisions": 2},
        weights={"energy": 3, "grade": 1},
    )
    assert result["paretoFront"], "加权求解仍应返回可行非支配前沿"
    assert result["stats"]["preferenceWeights"]["energy"] == 0.75
    rec = recommend_from_front(result["paretoFront"], {"energy": 3, "grade": 1})
    assert 0 <= rec < len(result["paretoFront"])


def test_solve_pareto_without_weights_unchanged_stats():
    result = solve_pareto(
        _candidates(),
        custom_config={"generations": 5, "restarts": 1, "referenceDivisions": 2},
    )
    assert "preferenceWeights" not in result["stats"]


# ---------- get_weight_recommendation 降级路径 ----------

def test_recommend_degrades_to_equal_weights_when_disabled(monkeypatch):
    monkeypatch.setattr(weight_source, "load_weight_config", lambda: {
        "enabled": False, "endpoint": "", "timeoutMs": 2000, "modelVersion": "v0",
    })
    data = get_weight_recommendation("ashale")
    assert data["source"] == "fallback"
    assert data["degraded"] is True
    assert data["modelVersion"] == "v0"
    assert abs(sum(data["weights"].values()) - 1.0) < 1e-9
    assert len(data["weights"]) == len(OBJECTIVES)


def test_recommend_degrades_on_external_failure(monkeypatch):
    monkeypatch.setattr(weight_source, "load_weight_config", lambda: {
        "enabled": True, "endpoint": "http://127.0.0.1:1/weights", "timeoutMs": 50,
        "modelVersion": "",
    })
    data = get_weight_recommendation("ashale")
    assert data["source"] == "fallback"
    assert data["degraded"] is True
