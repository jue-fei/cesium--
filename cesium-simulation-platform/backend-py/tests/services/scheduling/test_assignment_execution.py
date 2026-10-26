"""
test_assignment_execution.py —— NSGA-III 选解→后端执行闭环验证

当前仿真器实现：NSGA-III 候选是"采矿点→出口(nodeDump)"的重载返程路线，
选解仅在重载返程（target==nodeDump）时被 _consume_pending 消费；空载去程走贪心。
本测试验证：
  - T.1 返程时选解被消费且设备按选解路径执行（path/reason 匹配）
  - T.2 选解路径含封锁段时重验失败 → 选解保留、走贪心兜底、不崩溃
  - T.3 仿真推进后能耗成本累计、OPEX 节省口径有效
  - T.4 接口层：apply_assignment 接受 NSGA-III 派单并返回 applied

说明：直接构造 SchedulingSimulator 而非走 HTTP，聚焦派单执行逻辑；
接口契约（apply_assignment/state/tick）由 cesium1/scripts/verifyNsga3Loop.mjs 端到端覆盖。
"""
from app.services.scheduling.simulator import SchedulingSimulator


def _find(sim, eid):
    for e in sim.equip:
        if e.id == eid:
            return e
    raise AssertionError(f"设备 {eid} 不存在")


def _assign(sim, eid, target, path, nodes=None, levels=None):
    pa = {"target": target, "path": list(path), "source": "nsga3", "_t": sim.t}
    if nodes is not None:
        pa["nodes"] = list(nodes)
    if levels is not None:
        pa["levels"] = list(levels)
    sim.pending_assignments[eid] = pa


def _make_loaded_at_m2(sim):
    """把 LHD-01 模拟为已在 M2 装载完成、待重载返程。"""
    eq = _find(sim, "LHD-01")
    eq.node = "M2"
    eq.level = sim.muck_level.get("M2", 0)
    eq.load_mode = "loaded"
    eq.payload_t = 10.0
    eq.state = "loading"
    return eq


def test_T1_selection_consumed_on_return_haul():
    sim = SchedulingSimulator()
    eq = _make_loaded_at_m2(sim)
    # 解除初始封锁段 SEG-06，使 M2→S0 返程路径可通行
    sim.segs["SEG-06"].blocked = False
    sim.segs["SEG-06"].blockReason = ""

    # NSGA-III 选解：M2→S0 重载返程路线（SEG-09/06/05 均 loaded 可通行）
    _assign(
        sim, "LHD-01", "M2",
        ["SEG-09", "SEG-06", "SEG-05"],
        nodes=["M2", "N5", "N4", "S0"],
        levels=[0, 0, 0, 0],
    )

    ok = sim._begin_haul(eq, sim.node_dump)
    assert ok is True
    assert "LHD-01" not in sim.pending_assignments, "选解应被 _consume_pending 消费"
    assert eq.assigned.get("target") == sim.node_dump
    assert eq.assigned.get("path") == ["SEG-09", "SEG-06", "SEG-05"]
    assert "NSGA-III" in eq.assigned.get("reason", "")


def test_T2_blocked_pending_kept_and_greedy_fallback():
    sim = SchedulingSimulator()
    eq = _make_loaded_at_m2(sim)
    # 显式封锁选解路径中的 SEG-06 → _consume_pending 重验失败
    sim.segs["SEG-06"].blocked = True
    sim.segs["SEG-06"].blockReason = "测试封锁"
    _assign(
        sim, "LHD-01", "M2",
        ["SEG-09", "SEG-06", "SEG-05"],
        nodes=["M2", "N5", "N4", "S0"],
        levels=[0, 0, 0, 0],
    )

    try:
        sim._begin_haul(eq, sim.node_dump)
    except Exception as exc:  # noqa: BLE001
        raise AssertionError(f"封锁兜底不应抛异常: {exc}")

    assert "LHD-01" in sim.pending_assignments, "封锁段未通行时选解应保留"


def test_T3_energy_accrues_and_opex_reported():
    sim = SchedulingSimulator()
    for _ in range(120):  # 600s 仿真，覆盖空载去程装载
        sim.tick()

    total_energy = sum(e.energy_used_kwh for e in sim.equip)
    total_cost = sum(e.energy_mapped_t for e in sim.equip)
    assert total_energy > 0
    assert total_cost > 0

    snap = sim.snapshot()
    opex = snap["factors"]["equipment"]["opexSimulatedSavePct"]
    assert opex is None or opex >= 0, "有基准时 OPEX 节省应非负"


def test_T4_apply_assignment_http_contract():
    """接口层：apply_assignment 接受派单、校验设备存在性。"""
    import asyncio

    import httpx
    from main import app

    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/api/scheduling/apply_assignment",
                json=[
                    {"equipId": "LHD-01", "target": "M2", "path": ["SEG-09", "SEG-06", "SEG-05"]},
                    {"equipId": "LHD-NOPE", "target": "M2", "path": ["SEG-06"]},
                ],
            )

    r = asyncio.run(_run())
    assert r.status_code == 200
    data = r.json()
    assert data["code"] == 0
    assert len(data["data"]["applied"]) == 1
    assert data["data"]["applied"][0]["equipId"] == "LHD-01"
    assert len(data["data"]["rejected"]) == 1
    assert data["data"]["rejected"][0]["reason"] == "设备不存在"
