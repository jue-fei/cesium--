"""孪生融合引擎回归测试（方案 WP2 T2.0–T2.5）

覆盖：
  - 事件 seq 由后端单调分配（前端不可指定）
  - 非法工序 / 超大载荷被拒
  - R4 爆堆注入的成功与失败两条路径
  - R6 方案采纳记录
  - fusion:action 不触发规则递归
  - 规则清单可查询（测评举证用）

说明：与 test_auth_integration.py 保持一致，用 httpx.AsyncClient + ASGITransport
直连 ASGI 应用（starlette.TestClient 在本项目的 httpx 0.28 组合下不可用）。
"""
import asyncio
import os
import time

# 测试不写库：必须在导入 store 之前设置；fixture 再做一次兜底
os.environ["TWIN_EVENT_PERSIST"] = "0"

import httpx
import pytest

from main import app
from app.services.fusion import store


@pytest.fixture(autouse=True)
def _disable_persist(monkeypatch):
    """双重保险：即使其他测试先导入了 store，也强制关闭落库。"""
    monkeypatch.setattr(store, "_ENABLED", False)


def _request(method: str, path: str, **kwargs):
    """直连 ASGI 应用发起请求（AsyncClient + asyncio.run）。"""

    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_run())


def _post(event_type, proc, payload=None, source="test"):
    return _request(
        "POST",
        "/api/twin/events",
        json={"type": event_type, "proc": proc, "payload": payload or {}, "source": source},
    )


def _get(path):
    return _request("GET", path)


def test_seq_assigned_by_backend_and_increasing():
    first = _post("scheduling:tick", "haulage", {"t": 1}).json()
    second = _post("scheduling:tick", "haulage", {"t": 2}).json()
    assert first["code"] == 0 and second["code"] == 0
    seq1 = first["data"]["event"]["seq"]
    seq2 = second["data"]["event"]["seq"]
    assert seq2 == seq1 + 1


def test_invalid_proc_rejected():
    resp = _post("blasting:event:completed", "unknown-proc", {"pileId": "M1"}).json()
    assert resp["code"] == 400
    assert "非法工序" in resp["message"]


def test_oversized_payload_rejected():
    big = {"blob": "x" * (70 * 1024)}
    resp = _post("blasting:event:completed", "blasting", big).json()
    assert resp["code"] == 400
    assert "上限" in resp["message"]


def test_r4_injects_blast_pile():
    """R4：爆堆信息应注入调度仿真器并返回 ok。"""
    resp = _post(
        "blasting:event:completed",
        "blasting",
        {
            "scenario": "ashale",
            "pile": {"pileId": "M1", "gradePct": 0.93, "bigBlockRatio": 0.12, "source": "blasting"},
        },
    ).json()
    assert resp["code"] == 0
    matches = resp["data"]["matches"]
    r4 = [m for m in matches if m["ruleId"] == "R4"]
    assert len(r4) == 1
    assert r4[0]["status"] == "ok"
    assert r4[0]["elapsedMs"] >= 0


def test_r4_unknown_pile_returns_failed():
    resp = _post(
        "blasting:event:completed",
        "blasting",
        {"scenario": "ashale", "pile": {"pileId": "M999"}},
    ).json()
    r4 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R4"]
    assert len(r4) == 1
    assert r4[0]["status"] == "failed"


def test_r4_without_binding_is_skipped():
    """未绑定采场的爆破事件不得默认注入（防假联动）。"""
    resp = _post(
        "blasting:event:completed",
        "blasting",
        {"scenario": "ashale", "eventId": "UNBOUND-9999"},
    ).json()
    r4 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R4"]
    assert len(r4) == 1
    assert r4[0]["status"] == "skipped"
    assert "未绑定" in r4[0]["message"]


def test_bind_blast_then_r4_injects_bound_task():
    """按 blast_event_id 绑定后，仅凭 eventId 就能落到正确采场。"""
    bind = _request(
        "POST",
        "/api/scheduling/bind_blast",
        json={"eventId": "TEST-BIND-1", "taskId": "M3"},
    ).json()
    assert bind["code"] == 0, bind

    try:
        resp = _post(
            "blasting:event:completed",
            "blasting",
            {"scenario": "ashale", "eventId": "TEST-BIND-1", "pile": {"source": "blasting"}},
        ).json()
        r4 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R4"]
        assert len(r4) == 1
        assert r4[0]["status"] == "ok"
        assert r4[0]["message"] == "爆堆 M3 已注入调度"
    finally:
        # 清除绑定，避免污染后续用例
        _request(
            "PUT",
            "/api/scheduling/muck_tasks/M3",
            json={"blast_event_id": ""},
        )


def test_bind_blast_rejects_unknown_task():
    resp = _request(
        "POST",
        "/api/scheduling/bind_blast",
        json={"eventId": "X-1", "taskId": "M999"},
    ).json()
    assert resp["code"] == 1
    assert "不存在" in resp["message"]


def test_r6_records_adoption():
    resp = _post(
        "optimization:adopted",
        "optimization",
        {"runId": "run-test-1", "solutionId": "pf-3", "objectives": {"energy": 10.5}},
    ).json()
    r6 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R6"]
    assert len(r6) == 1 and r6[0]["status"] == "ok"

    adoptions = _get("/api/twin/adoptions").json()["data"]["adoptions"]
    assert any(a["runId"] == "run-test-1" for a in adoptions)


def test_fusion_action_does_not_recurse():
    """动作事件不得再次进入规则求值，否则会无限递归。"""
    resp = _post("fusion:action", "twin", {"action": "haulage:refresh"}).json()
    assert resp["code"] == 0
    assert resp["data"]["matches"] == []


def test_history_incremental():
    last = _get("/api/twin/events").json()["data"]["lastSeq"]
    page = _get(f"/api/twin/events?since_seq={last}").json()["data"]
    assert page["events"] == []
    assert page["lastSeq"] == last


def test_rules_describe_contains_r4_r6():
    data = _get("/api/twin/rules").json()["data"]
    by_id = {r["id"]: r for r in data["rules"]}
    assert by_id["R4"]["enabled"] is True
    assert by_id["R6"]["enabled"] is True
    # 占位规则必须显式关闭，避免"看起来做了"
    assert by_id["R1"]["enabled"] is False
    assert by_id["R3"]["enabled"] is True


def test_health_reports_bus_state():
    data = _get("/api/twin/health").json()["data"]
    assert data["seq"] >= 1
    assert data["capacity"] == 1000


# ─── T2.5b / R3：危险区→巷道封锁 ───────────────────────
def test_r3_blocks_segments_from_zone():
    """R3：危险区多边形应命中巷道段并写入外部封锁台账。"""
    from app.routes.scheduling import get_simulator

    sim = get_simulator("ashale")
    x, _y, z = [float(v) for v in sim.segment_geo["SEG-01"][0]]
    polygon = [[x - 5, z - 5], [x + 5, z - 5], [x + 5, z + 5], [x - 5, z + 5]]

    resp = _post(
        "blasting:zone:changed",
        "blasting",
        {
            "scenario": "ashale",
            "zone": {"polygon": polygon, "reason": "测试危险区", "source": "blasting"},
        },
    ).json()
    r3 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R3"]
    assert len(r3) == 1
    assert r3[0]["status"] == "ok"
    assert "SEG-01" in sim.external_blocks
    assert sim.segs["SEG-01"].blocked is True


def test_manual_block_and_release_api():
    """T2.5b：人工封锁/解除接口。"""
    from app.routes.scheduling import get_simulator

    resp = _request(
        "PUT", "/api/scheduling/segments/SEG-02/block", json={"reason": "人工封锁"}
    ).json()
    assert resp["code"] == 0

    sim = get_simulator("ashale")
    assert sim.segs["SEG-02"].blocked is True
    assert "SEG-02" in [b["segId"] for b in sim.external_block_list()]

    resp2 = _request("DELETE", "/api/scheduling/segments/SEG-02/block").json()
    assert resp2["code"] == 0
    assert "SEG-02" not in [b["segId"] for b in sim.external_block_list()]


def test_external_block_survives_auto_clear():
    """外部封锁不得被"岩爆/炮烟消退即解除"的自动逻辑误清。"""
    from app.services.scheduling.simulator import SchedulingSimulator
    from app.services.scheduling.scenario_config import load_scenario

    sim = SchedulingSimulator(load_scenario("ashale"), seed=1)
    assert sim.set_external_block("SEG-03", source="test", reason="外部封锁") is True
    for _ in range(30):
        sim.tick()
    assert sim.segs["SEG-03"].blocked is True
    assert "SEG-03" in sim.external_blocks


def test_zone_without_intersection_is_skipped():
    """远离巷道的危险区不应误封锁。"""
    # R3 配置了 1s 节流，避免与上一条用例落在同一窗口
    time.sleep(1.05)
    resp = _post(
        "blasting:zone:changed",
        "blasting",
        {
            "scenario": "ashale",
            "zone": {"polygon": [[0, 0], [1, 0], [1, 1], [0, 1]], "reason": "远处危险区"},
        },
    ).json()
    r3 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R3"]
    assert len(r3) == 1
    assert r3[0]["status"] == "skipped"


# ─── T3.4：服务端时钟基准 ───────────────────────────────
def test_clock_endpoint_exposes_epoch_and_seq():
    data = _get("/api/twin/clock").json()["data"]
    assert data["serverTime"] > 0
    assert data["timezone"] == "UTC+8"
    assert data["uptime"] >= 0
    assert data["lastSeq"] >= 0
    assert isinstance(data["iso"], str)
