"""全域实时推送遥测适配器（pytest，从 backend-py 根目录运行）。

锁定 SimTelemetryAdapter 帧结构与确定性（固定 seed + 帧序号 → 同帧可复现）、
未知 scope 拒绝、MQTT stub 降级路径。帧协议契约见
shared-consistency-baseline.json#realtimeWsCmps，前端 RealtimeWsConnector
与 DataSourceBadge 消费同一帧结构。
"""

import json

import pytest

from app.routes.realtime_ws import _clamp_interval
from app.services.realtime import telemetry as telemetry_mod
from app.services.realtime.telemetry import (
    MqttTelemetryAdapter,
    SimTelemetryAdapter,
    get_telemetry_adapter,
)

REQUIRED_EQUIP_FIELDS = {"equipId", "state", "loadMode", "engineTempC", "fuelLevelPct", "speedPct"}


@pytest.fixture()
def sim():
    from app.routes.scheduling import get_simulator

    return get_simulator()


def test_frame_structure(sim):
    adapter = SimTelemetryAdapter()
    frame = adapter.get_frame("equipment", sim)
    assert frame["source"] == "simulated"
    assert frame["scope"] == "equipment"
    assert frame["equipment"], "遥测帧必须包含设备记录"
    for rec in frame["equipment"]:
        assert REQUIRED_EQUIP_FIELDS <= set(rec)
        assert 25.0 <= rec["engineTempC"] <= 120.0
        assert 0.0 <= rec["fuelLevelPct"] <= 100.0
        assert 0.0 <= rec["speedPct"] <= 110.0
    assert frame["fleet"]["loadedCount"] + frame["fleet"]["emptyCount"] == len(frame["equipment"])


def test_frame_deterministic_per_frame_index(sim):
    """同帧序号 → 传感器值完全一致（固定 seed 可复现，测试/回放友好）。"""
    a, b = SimTelemetryAdapter(), SimTelemetryAdapter()
    fa = a.get_frame("equipment", sim)
    fb = b.get_frame("equipment", sim)
    assert json.dumps(fa["equipment"], sort_keys=True) == json.dumps(fb["equipment"], sort_keys=True)


def test_frame_seq_advances(sim):
    adapter = SimTelemetryAdapter()
    e1 = adapter.get_frame("equipment", sim)["equipment"]
    e2 = adapter.get_frame("equipment", sim)["equipment"]
    # 帧序推进 → 随机流推进（两帧不可能完全相同，除非单设备退化）
    assert json.dumps(e1, sort_keys=True) != json.dumps(e2, sort_keys=True)


def test_unknown_scope_rejected(sim):
    adapter = SimTelemetryAdapter()
    with pytest.raises(ValueError):
        adapter.get_frame("bogus", sim)


def test_mqtt_stub_raises():
    with pytest.raises(NotImplementedError):
        MqttTelemetryAdapter()


def test_adapter_fallback_when_mqtt_unconfigured(monkeypatch):
    """配置指向未实现的 mqtt → 降级 SimTelemetryAdapter（推送链路不允许断）。"""
    cfg = {"adapter": "mqtt"}

    class FakePath(str):
        pass

    monkeypatch.setattr(telemetry_mod, "_config_path", lambda: FakePath("fake.json"))
    orig_open = open

    def fake_open(path, *a, **k):
        if str(path) == "fake.json":
            import io

            return io.StringIO(json.dumps(cfg))
        return orig_open(path, *a, **k)

    monkeypatch.setattr("builtins.open", fake_open)
    adapter = get_telemetry_adapter()
    assert isinstance(adapter, SimTelemetryAdapter)


def test_clamp_interval():
    assert _clamp_interval(0.1) == 0.5
    assert _clamp_interval(999) == 30.0
    assert _clamp_interval("3") == 3.0
    assert _clamp_interval(None) == 2.0
    assert _clamp_interval("bogus") == 2.0
