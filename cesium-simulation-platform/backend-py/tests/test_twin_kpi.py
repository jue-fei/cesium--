"""KPI 字典与时序回归测试（方案 WP5 T5.2 / T5.7，含 R5 接线）

覆盖：
  - 字典 12 项契约（编码/单位/聚合/来源）
  - 快照提取：只取真实字段，活跃设备/存量/品位/封锁段/危险指数
  - 分桶聚合：累计量取差分、瞬时量按 avg
  - 写入-查询-最新值链路（依赖 MySQL）
  - R5 规则已启用并指向 kpi.record_scheduling
"""
import asyncio
import time

import httpx
import pymysql
import pytest

from app.database import DB_CONFIG
from app.services.twin.kpi import _aggregate, extract_from_snapshot
from main import app


def _db_available() -> bool:
    try:
        conn = pymysql.connect(**DB_CONFIG)
        conn.close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="MySQL 不可用，跳过 KPI 时序测试")


def _request(method: str, path: str, **kwargs):
    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_run())


# ─── 契约与纯函数 ─────────────────────────────────────────
def test_kpi_defs_contract():
    defs = _request("GET", "/api/twin/kpi/defs").json()["data"]["defs"]
    assert len(defs) == 12
    codes = {d["code"] for d in defs}
    assert {"equip_utilization", "grade_avg", "blocked_segments", "ppv_max"} <= codes
    # 每项必须有单位、工序、聚合方式与来源，否则驾驶舱无法展示/溯源
    for item in defs:
        assert item["unit"] != ""
        assert item["proc"] in {
            "geology",
            "blasting",
            "haulage",
            "safety",
            "optimization",
            "twin",
        }
        assert item["agg"] in {"avg", "sum", "max"}
        assert item["source"]


def test_extract_from_snapshot_uses_real_fields_only():
    snapshot = {
        "factors": {
            "equipment": {
                "items": [
                    {"state": "hauling"},
                    {"state": "idle"},
                    {"state": "loading"},
                    {"state": "idle"},
                ]
            },
            "muckPile": {
                "points": [
                    {"stock_t": 100, "gradePct": 0.8},
                    {"stock_t": 0, "gradePct": 0.6},
                ]
            },
            "dynamicEnvironment": {
                "segments": [
                    {"blocked": True, "rockburst": 0.3},
                    {"blocked": False, "rockburst": 0.9},
                ]
            },
        }
    }
    values = extract_from_snapshot(snapshot)

    assert values["equip_utilization"] == 50.0
    assert values["equip_busy"] == 2.0
    assert values["stock_total_t"] == 100.0
    assert values["active_muck_points"] == 1.0
    assert values["blocked_segments"] == 1.0
    assert values["hazard_index"] == 90.0
    assert abs(values["grade_avg"] - 0.7) < 1e-6
    # 拿不到的指标不得被编造
    assert "ppv_max" not in values
    assert "powder_factor" not in values


def test_empty_snapshot_returns_only_counters():
    values = extract_from_snapshot({})
    assert values == {
        "equip_busy": 0.0,
        "stock_total_t": 0.0,
        "active_muck_points": 0.0,
        "blocked_segments": 0.0,
    }


def test_aggregate_cumulative_takes_delta():
    points = [(0, 10), (30, 12), (60, 15), (90, 20)]
    avg = _aggregate(points, 60, "avg", False)
    assert len(avg) == 2
    assert avg[0]["value"] == 11.0
    assert avg[1]["value"] == 17.5

    delta = _aggregate(points, 60, "sum", True)
    assert delta[0]["value"] == 2.0
    assert delta[1]["value"] == 5.0


# ─── 写入-查询链路 ────────────────────────────────────────
def test_record_and_query_roundtrip():
    stamp = time.time()
    from app.services.twin.kpi import record

    written = record({"equip_utilization": 42.5}, ts=stamp, tags={"scenario": "test"})
    assert written == 1

    data = _request(
        "GET", "/api/twin/kpi?codes=equip_utilization&minutes=10&step=60"
    ).json()["data"]
    assert data["degraded"] is False
    series = data["series"][0]
    assert series["code"] == "equip_utilization"
    assert any(abs(p["ts"] - int(stamp // 60) * 60) < 1 for p in series["points"])

    latest = _request(
        "GET", "/api/twin/kpi/latest?codes=equip_utilization"
    ).json()["data"]["items"][0]
    assert latest["value"] is not None
    assert latest["name"] == "设备利用率"


def test_record_api_rejects_non_numeric():
    resp = _request(
        "POST", "/api/twin/kpi/record", json={"values": {"equip_utilization": "abc"}}
    ).json()
    assert resp["code"] == 1
    assert "没有可写入" in resp["message"]


# ─── R5 接线 ──────────────────────────────────────────────
def test_r5_rule_enabled_and_points_to_kpi_action():
    rules = {r["id"]: r for r in _request("GET", "/api/twin/rules").json()["data"]["rules"]}
    assert rules["R5"]["enabled"] is True
    assert rules["R5"]["then"]["action"] == "kpi.record_scheduling"


def test_r5_records_kpi_on_scheduling_tick():
    # R5 配置了 5s 节流；其他用例（如 test_twin_fusion 的 tick）可能已占窗口，先清状态
    from app.services.fusion.rules import engine

    engine._last_fired.pop("R5", None)
    resp = _request(
        "POST",
        "/api/twin/events",
        json={"type": "scheduling:tick", "proc": "haulage", "payload": {"scenario": "ashale"}},
    ).json()
    r5 = [m for m in resp["data"]["matches"] if m["ruleId"] == "R5"]
    assert len(r5) == 1
    # 数据库可用时应为 ok；仿真器首次构建较慢但不影响状态
    assert r5[0]["status"] in ("ok", "skipped")
