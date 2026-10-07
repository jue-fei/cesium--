"""拖拽式设备部署与出矿工序顺序（3.2）契约与行为（pytest，从 backend-py 根目录运行）。

覆盖：真源文件读写（缺失=空部署）/ 校验拒绝非法设备·节点·水平·工序 /
空闲设备迁移落位 / 仿真器构建时读取部署 / PUT-GET 路由闭环（含运行中
仿真器即刻生效）/ 快照携带设备 level（前端部署渲染依赖）。
部署目录统一 monkeypatch 到 tmp_path，不污染仓库真实 config。
"""

import json
from pathlib import Path

import pytest

from app.routes.deployment import get_deployment, put_deployment, router
from app.services.scheduling import deployment_store
from app.services.scheduling.deployment_store import (
    apply_deployment,
    load_deployment,
    save_deployment,
    validate_deployment,
)
from app.services.scheduling.scenario_config import load_scenario
from app.services.scheduling.simulator import PROCESS_PRIORITY_BIAS, SchedulingSimulator


@pytest.fixture(autouse=True)
def _tmp_deployments_dir(tmp_path, monkeypatch):
    """部署真源目录重定向到 tmp_path，测试写入不落仓库。"""
    monkeypatch.setattr(deployment_store, "DEPLOYMENTS_DIR", tmp_path)


def _sim():
    return SchedulingSimulator(load_scenario("ashale"))


# ---------- 真源读写 ----------

def test_load_missing_returns_empty():
    dep = load_deployment("no-such-scenario")
    assert dep["deployments"] == {}
    assert dep["processOrder"] == []
    assert dep["rev"] == 0  # 3.2.3 乐观并发版本号缺省 0


def test_save_then_load_roundtrip():
    save_deployment("ashale", {"LHD-01": {"node": "N1", "level": 0}}, ["M1", "M2"])
    dep = load_deployment("ashale")
    assert dep["deployments"] == {"LHD-01": {"node": "N1", "level": 0}}
    assert dep["processOrder"] == ["M1", "M2"]


# ---------- 校验 ----------

def test_validate_rejects_invalid_deployments():
    sim = _sim()
    # 找一个真实"节点不在该水平"的组合（斜坡道贯穿多水平的节点合法，不拿来当反例）
    bad_pair = next(
        (n, lv) for n in sim.tunnel_nodes for lv in range(len(sim.levels_meta))
        if not sim._node_on_level(n, lv)
    )
    errors = validate_deployment(sim, {
        "LHD-99": {"node": "N1", "level": 0},   # 设备不存在
        "LHD-01": {"node": "X9", "level": 0},   # 节点不存在
        "LHD-02": {"node": "N1", "level": 9},   # 水平越界
        "LHD-03": {"node": bad_pair[0], "level": bad_pair[1]},  # 节点不在该水平
    }, ["M1", "M1"])                             # 工序重复
    joined = "；".join(errors)
    assert "LHD-99" in joined and "X9" in joined and "超出场景分层范围" in joined
    assert bad_pair[0] in joined and "重复" in joined


def test_validate_accepts_valid_deployment():
    sim = _sim()
    assert validate_deployment(sim, {"LHD-01": {"node": "N1", "level": 0}}, ["M1", "M2"]) == []


# ---------- 应用与仿真器联动 ----------

def test_apply_deployment_moves_idle_equipment():
    sim = _sim()
    applied, skipped = apply_deployment(sim, {"LHD-01": {"node": "N1", "level": 0}}, only_idle=False)
    assert len(applied) == 1 and not skipped
    eq = next(e for e in sim.equip if e.id == "LHD-01")
    assert eq.node == "N1" and eq.level == 0
    # 落位水平上存在相邻巷道段（设备不悬空）
    assert eq.seg_id in sim.level_seg_sets[0]
    assert eq.state == "idle" and eq.assigned == {}


def test_simulator_init_reads_deployment_file():
    save_deployment("ashale", {"LHD-02": {"node": "M3", "level": 2}}, ["M4", "M1"])
    sim = _sim()
    eq = next(e for e in sim.equip if e.id == "LHD-02")
    assert eq.node == "M3" and eq.level == 2
    assert sim.process_order == ["M4", "M1"]


def test_process_order_bias_constant_is_positive():
    # 出矿工序偏置必须为正（靠前=更优先），量级口径见 simulator.PROCESS_PRIORITY_BIAS 注释
    assert PROCESS_PRIORITY_BIAS > 0


def test_snapshot_exposes_equipment_level():
    snap = _sim().snapshot()
    items = snap["factors"]["equipment"]["items"]
    assert items and all("level" in it for it in items)


# ---------- 路由闭环（运行中仿真器即刻生效）----------

# 3.2.1：写路由新增 client_identity 依赖；直调处理器时须显式传入身份
_IDENTITY = {"clientId": "test-terminal", "operator": "测试"}


def test_put_and_get_route_roundtrip():
    # 换上未 tick 的独立仿真器实例（全部设备空闲），避免共享实例的作业状态影响断言；
    # 结束后恢复原实例，不影响其它用例
    import app.routes.scheduling as scheduling_routes
    prev = scheduling_routes._sims.get("ashale")
    scheduling_routes._sims["ashale"] = _sim()
    try:
        res = put_deployment({
            "scenario": "ashale",
            "deployments": {"LHD-01": {"node": "N2", "level": 0}},
            "processOrder": ["M2", "M1"],
        }, identity=_IDENTITY)
        assert res["code"] == 0
        assert any(a["equipId"] == "LHD-01" and a["node"] == "N2" for a in res["data"]["applied"])
        # 运行中的仿真器即刻生效：设备已迁到新待命点，工序已更新
        sim = scheduling_routes._sims["ashale"]
        eq = next(e for e in sim.equip if e.id == "LHD-01")
        assert eq.node == "N2" and eq.level == 0
        assert sim.process_order == ["M2", "M1"]
        # GET 回读与落盘一致
        got = get_deployment("ashale")
        assert got["code"] == 0
        assert got["data"]["deployments"]["LHD-01"] == {"node": "N2", "level": 0}
        assert got["data"]["processOrder"] == ["M2", "M1"]
    finally:
        if prev is not None:
            scheduling_routes._sims["ashale"] = prev
        else:
            scheduling_routes._sims.pop("ashale", None)
        save_deployment("ashale", {}, [])


def test_put_rejects_invalid_without_side_effects():
    before = load_deployment("ashale")
    res = put_deployment({
        "scenario": "ashale",
        "deployments": {"LHD-01": {"node": "X9", "level": 0}},
    })
    assert res["code"] == 1 and "X9" in res["message"]
    # 校验失败不落盘、不改真源
    assert load_deployment("ashale") == before


# ---------- 契约（shared-consistency-baseline.json#deploymentCmps）----------
# 前端对应用例：cesium1/src/features/realtime-monitoring/services/__tests__/deploymentContract.test.js

BASELINE = json.loads(
    (Path(__file__).resolve().parents[2] / "shared-consistency-baseline.json").read_text(
        encoding="utf-8"
    )
)["deploymentCmps"]


def test_baseline_deployment_cmps_structure():
    assert BASELINE["api"]["get"].startswith("GET /api/deployment")
    assert BASELINE["api"]["put"] == "PUT /api/deployment"
    assert set(BASELINE["payloadKeys"]) == {
        "scenario", "deployments", "processOrder", "baseRev", "force"}
    assert set(BASELINE["deploymentItemKeys"]) == {"node", "level"}
    assert set(BASELINE["responseDataKeys"]) == {
        "deployments", "processOrder", "applied", "skipped", "rev"}


def test_route_table_matches_baseline():
    table = {(m, r.path) for r in router.routes if hasattr(r, "methods") for m in r.methods}
    assert ("GET", "/api/deployment") in table
    assert ("PUT", "/api/deployment") in table


def test_put_consumes_all_payload_keys():
    src = (Path(__file__).resolve().parents[1] / "app" / "routes" / "deployment.py").read_text(
        encoding="utf-8"
    )
    for k in BASELINE["payloadKeys"]:
        assert f'body.get("{k}")' in src, f"路由未消费负载键 {k}"


def test_deployment_item_keys_consumed_in_store():
    src = (Path(__file__).resolve().parents[1] / "app" / "services"
           / "scheduling" / "deployment_store.py").read_text(encoding="utf-8")
    for k in BASELINE["deploymentItemKeys"]:
        assert f'd.get("{k}")' in src, f"部署存储未消费部署项键 {k}"


def test_put_response_data_keys_match_baseline():
    import app.routes.scheduling as scheduling_routes
    prev = scheduling_routes._sims.get("ashale")
    scheduling_routes._sims["ashale"] = _sim()
    try:
        res = put_deployment({
            "scenario": "ashale",
            "deployments": {"LHD-01": {"node": "N1", "level": 0}},
            "processOrder": ["M1", "M2"],
        }, identity=_IDENTITY)
        assert res["code"] == 0
        assert set(res["data"]) == set(BASELINE["responseDataKeys"])
    finally:
        if prev is not None:
            scheduling_routes._sims["ashale"] = prev
        else:
            scheduling_routes._sims.pop("ashale", None)
        save_deployment("ashale", {}, [])


# ---------- 3.2.3 乐观并发（rev / baseRev / force / code=2）----------

def test_put_without_base_rev_still_works():
    """旧客户端/脚本不带 baseRev → 不校验，正常保存并自增 rev。"""
    save_deployment("ashale", {}, [], rev=3)
    res = put_deployment({"scenario": "ashale", "deployments": {}, "processOrder": []},
                         identity=_IDENTITY)
    assert res["code"] == 0
    assert res["data"]["rev"] == 4


def test_put_matching_base_rev_bumps_rev():
    save_deployment("ashale", {}, [], rev=7)
    res = put_deployment({"scenario": "ashale", "deployments": {}, "processOrder": [],
                          "baseRev": 7}, identity=_IDENTITY)
    assert res["code"] == 0
    assert res["data"]["rev"] == 8


def test_put_rejects_stale_base_rev_without_side_effects():
    save_deployment("ashale", {"LHD-01": {"node": "N1", "level": 0}}, ["M1"],
                    rev=5, updated_by="张三@term-000")
    res = put_deployment({
        "scenario": "ashale",
        "deployments": {"LHD-02": {"node": "N2", "level": 0}},
        "baseRev": 4,
    }, identity=_IDENTITY)
    assert res["code"] == 2
    assert res["data"]["currentRev"] == 5
    assert res["data"]["by"] == "张三@term-000"
    assert res["data"]["current"]["deployments"] == {"LHD-01": {"node": "N1", "level": 0}}
    # 未落盘：真源仍是 rev 5 的旧内容
    after = load_deployment("ashale")
    assert after["rev"] == 5
    assert "LHD-02" not in after["deployments"]


def test_put_force_overrides_conflict():
    save_deployment("ashale", {}, [], rev=5)
    res = put_deployment({"scenario": "ashale", "deployments": {}, "processOrder": [],
                          "baseRev": 1, "force": True}, identity=_IDENTITY)
    assert res["code"] == 0
    assert res["data"]["rev"] == 6  # 强制覆盖仍自增（rev 单调）
