"""设备健康模型契约与单元行为（pytest，从 backend-py 根目录运行）。

锁定 equipment/health.py 健康分模型与仓库根 shared-consistency-baseline.json
的 equipmentHealthCmps 一致；告警阈值与前端 monitoringAlerts.js 同源。
前端对应用例为 cesium1/src/features/realtime-monitoring/services/__tests__/
equipmentHealthContract.test.js。覆盖：子项评分边界/加权与分级/告警明细/
路由直调（含时序层写入联动）/契约一致性。
"""

import json
import time
from pathlib import Path

import pytest

from app.routes.equipment import equipment_health
from app.services.equipment.health import (
    FUEL_ALARM_PCT,
    LEVELS,
    SPEED_ALARM_PCT,
    TEMP_ALARM_C,
    WEIGHTS,
    build_health_frame,
    compute_health,
    fuel_score,
    health_level,
    speed_score,
    temp_score,
)
from app.services.timeseries.ts_store import MemoryTsStore, reset_ts_store

BASELINE_PATH = Path(__file__).resolve().parents[2] / "shared-consistency-baseline.json"
BASELINE = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
CMP = BASELINE["equipmentHealthCmps"]


# ---------- 契约 ----------

def test_alarm_thresholds_match_baseline():
    assert TEMP_ALARM_C == CMP["alarms"]["tempAlarmC"]
    assert FUEL_ALARM_PCT == CMP["alarms"]["fuelAlarmPct"]
    assert SPEED_ALARM_PCT == CMP["alarms"]["speedAlarmPct"]


def test_weights_and_levels_match_baseline():
    assert WEIGHTS == CMP["weights"]
    assert (80.0, 60.0) == (CMP["levels"]["normalMin"], CMP["levels"]["watchMin"])
    assert LEVELS == ("normal", "watch", "alarm")


# ---------- 子项评分 ----------

def test_temp_score_boundaries():
    assert temp_score(70) == 100.0
    assert temp_score(TEMP_ALARM_C) == 0.0
    assert temp_score(120) == 0.0
    mid = temp_score(87.5)  # 80~95 中点
    assert mid == pytest.approx(50.0)


def test_fuel_score_boundaries():
    assert fuel_score(60) == 100.0
    assert fuel_score(15) == 0.0
    assert fuel_score(37.5) == pytest.approx(50.0)


def test_speed_score_boundaries():
    assert speed_score(80) == 100.0
    assert speed_score(110) == 0.0
    assert speed_score(95) == pytest.approx(60.0)  # (110-95)/(110-85)=0.6


def test_health_level_and_score():
    assert health_level(100) == "normal"
    assert health_level(80) == "normal"
    assert health_level(79.9) == "watch"
    assert health_level(60) == "watch"
    assert health_level(59.9) == "alarm"

    ideal = compute_health({"engineTempC": 70, "fuelLevelPct": 80, "speedPct": 40})
    assert ideal["score"] == 100.0
    assert ideal["level"] == "normal"
    assert ideal["alerts"] == []


def test_derive_alerts_semantics():
    rec = {"engineTempC": 96, "fuelLevelPct": 25, "speedPct": 97}
    alerts = compute_health(rec)["alerts"]
    codes = [a["code"] for a in alerts]
    assert codes == CMP["alertCodes"]


# ---------- 路由直调（含时序写入联动） ----------

@pytest.fixture()
def isolated_store(monkeypatch):
    reset_ts_store()
    store = MemoryTsStore()
    monkeypatch.setattr("app.services.timeseries.ts_store._store", store)
    monkeypatch.setattr("app.services.timeseries.ts_store._store_tried", True)
    yield store
    reset_ts_store()


def test_health_route_and_timeseries_link(isolated_store):
    res = equipment_health(scenario=None)
    assert res["code"] == 0
    data = res["data"]
    assert data["source"] == "simulated"
    assert data["equipment"]
    for e in data["equipment"]:
        assert {"score", "level", "subScores", "alerts"} <= set(e)
        assert 0 <= e["score"] <= 100
        # 健康分已入时序层（2.1 联动：趋势查询数据源）
        pts = isolated_store.query("equipment.health", tags={"equipId": e["equipId"]})
        assert len(pts) == 1
        assert pts[0][1] == pytest.approx(e["score"])
    assert data["fleet"]["alarmCount"] + data["fleet"]["watchCount"] <= len(data["equipment"])
    assert data["fleet"]["avgScore"] is not None


def test_health_frame_uses_shared_adapter(sim=None):
    """共享适配器单例：WS 推送与健康端点共用同一帧流。"""
    from app.services.realtime.telemetry import (
        get_shared_sim_adapter,
        get_telemetry_adapter,
        reset_shared_sim_adapter,
    )

    reset_shared_sim_adapter()
    assert get_telemetry_adapter() is get_shared_sim_adapter()
    reset_shared_sim_adapter()
