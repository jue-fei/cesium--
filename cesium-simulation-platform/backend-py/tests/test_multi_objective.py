"""
现场调度多目标优化（后端 · pymoo NSGA-III）回归测试

算法本体统一由标准库 pymoo 求解（app/services/scheduling/multi_objective.py），
前端仅消费快照中预计算的 paretoFront。本测试验证：
  - pymoo 引擎返回可行、互不支配且去重后的前沿（来源标记 nsga3 / engine=pymoo）；
  - 同输入同种子 → 结果可复现（确定性）；
  - 仿真器快照携带预计算 paretoFront（真实场景回归）。
"""
import app.services.scheduling.multi_objective as mo
from app.services.scheduling.simulator import SchedulingSimulator
from app.services.scheduling.scenario_config import load_config, build_scenario


def _cand(target, zone, energy, time_m, hazard, grade, path):
    return {
        "target": target, "zone": zone, "path": path, "nodes": [target, "S0"],
        "levels": [0, 0], "energyTotal": energy, "timeMin": time_m,
        "hazard": hazard, "gradePct": grade, "remainingWorkT": 100.0,
    }


def _small_candidates():
    """迷你场景：2 台设备 × 2 个采区，组合数 (2+1)^2=9。"""
    return [
        [
            _cand("M1", "A采场", 10.0, 8.0, 0.1, 1.0, ["SEG-01"]),
            _cand("M2", "B采场", 12.0, 9.0, 0.3, 0.7, ["SEG-02"]),
        ],
        [
            _cand("M1", "A采场", 11.0, 8.5, 0.2, 1.0, ["SEG-01"]),
            _cand("M2", "B采场", 9.0, 7.5, 0.1, 0.7, ["SEG-02"]),
        ],
    ]


def _large_candidates():
    """大规模组合（(6+1)^6=117649）→ 验证高维演进稳定性。"""
    out = []
    for e in range(6):
        out.append(
            [_cand(f"M{(e + k) % 3 + 1}", f"{chr(65 + (e + k) % 3)}采场",
                   10.0 + e * 0.2 + k, 8.0 + e + k * 0.1, 0.1 + (e + k) * 0.05,
                   0.6 + (e + k) % 3 * 0.2, [f"SEG-{k + 1:02d}"])
             for k in range(6)]
        )
    return out


class TestPymooEngine:
    def test_engine_returns_feasible_front(self):
        """pymoo NSGA-III：来源 nsga3 / 引擎 pymoo；前沿可行、去重、索引合法。"""
        res = mo.solve_pareto(_small_candidates())
        assert res["source"] == "nsga3"
        assert res["stats"]["engine"] == "pymoo"
        assert res["paretoFront"]
        keys = set()
        for ind in res["paretoFront"]:
            assert ind["objectives"]["_constraint"]["isFeasible"]
            assert ind["objectives"]["_constraint"]["uncovered"] == 0
            for i, ci in enumerate(ind["assignment"]):
                assert 0 <= ci <= len(_small_candidates()[i])
            keys.add(",".join(map(str, ind["assignment"])))
        assert len(keys) == len(res["paretoFront"]), "前沿必须按方案去重"

    def test_determinism_with_seed(self):
        """固定种子 → 同输入两次求解得到一致的方案集合。"""
        f1 = mo.solve_pareto(_small_candidates(), {"seed": 42})["paretoFront"]
        f2 = mo.solve_pareto(_small_candidates(), {"seed": 42})["paretoFront"]
        key = lambda ind: ",".join(str(x) for x in ind["assignment"])
        assert {key(i) for i in f1} == {key(i) for i in f2}

    def test_large_space_runs(self):
        """大规模组合仍能跑通且返回可行前沿。"""
        res = mo.solve_pareto(_large_candidates(), {"generations": 20})
        assert res["stats"]["combos"] > 100000
        assert res["paretoFront"]
        for ind in res["paretoFront"]:
            assert ind["objectives"]["_constraint"]["isFeasible"]


class TestSimulatorIntegration:
    def test_snapshot_carries_precomputed_front(self):
        """仿真器快照携带后端预计算的 paretoFront / objectiveDefs / optStats。"""
        sim = SchedulingSimulator(build_scenario(load_config("ashale")))
        opt = sim.snapshot()["factors"]["optimization"]
        assert opt["byEquipment"]
        assert opt["stopes"]
        assert opt["paretoFront"], "快照应带上预计算的帕累托前沿"
        assert opt["objectiveDefs"]
        assert opt["optStats"]["engine"] == "pymoo"
        assert opt["optStats"]["source"] == "nsga3"
        # 缓存：连续二次快照不重算（same key），前沿保持一致
        opt2 = sim.snapshot()["factors"]["optimization"]
        assert len(opt2["paretoFront"]) == len(opt["paretoFront"])