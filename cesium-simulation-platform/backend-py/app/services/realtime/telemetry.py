"""
telemetry.py —— 全域实时推送的数据源适配器

平台当前没有真实遥测数据源：SimTelemetryAdapter 从调度仿真器（进程级共享，
与 /ws/scheduling、HTTP /api/scheduling 同一实例）读取设备状态，并叠加固定
seed 的传感器模拟曲线（油温/油量/速度利用率），供预警推导与将来的设备健康
面板消费。帧中 source='simulated'，前端界面据此显示"模拟数据源"状态灯。

将来接入真实遥测：实现 TelemetryAdapter 协议的 MqttTelemetryAdapter
（MQTT 订阅 → 适配为同结构帧），在 config/realtime_telemetry.json 把
adapter 切为 'mqtt' 即可，/ws/realtime 帧协议与前端零改动。

契约：shared-consistency-baseline.json#realtimeWsCmps。
"""
import hashlib
import json
import logging
import math
import random
import time

from app.services.scheduling.simulator import SchedulingSimulator
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO

logger = logging.getLogger(__name__)

# 适配器选择配置（真源：config/realtime_telemetry.json；模块级常量便于测试注入）
CONFIG_PATH = None  # 惰性解析（见 _config_path()），测试可 monkeypatch


def _config_path():
    global CONFIG_PATH
    if CONFIG_PATH is None:
        from pathlib import Path

        CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "realtime_telemetry.json"
    return CONFIG_PATH

# 模拟传感器曲线参数（固定 seed，可复现；量级对标 monitoringAlerts 阈值：
# 油温告警 95℃ / 油量告警 30% / 速度告警 95% 上限）
SENSOR_SEED = 20260920
ENGINE_TEMP_BASE = 82.0    # ℃
ENGINE_TEMP_AMP = 9.0
FUEL_BASE = 68.0           # %
FUEL_DRAIN_RATE = 0.9      # %/min（仿真推进下缓慢下降）
SPEED_PCT_BASE = 45.0      # %（相对额定速度利用率）
SPEED_PCT_AMP = 30.0


class SimTelemetryAdapter:
    """模拟遥测源：调度仿真器状态 + 固定 seed 传感器曲线。"""

    source = "simulated"

    def __init__(self):
        self._rng = None
        self._frame_idx = 0
        self._last_ts = 0.0

    def _advance_rng(self):
        # 每帧推进一次共享伪随机流：固定 seed + 帧序号 → 同帧可复现
        self._rng = random.Random(SENSOR_SEED + self._frame_idx)

    def _sensor_curve(self, equip_id, state, dt_min):
        """单设备传感器读数（正弦趋势 + 扰动；停机设备回落基线）。"""
        # 设备异质性：以 equip_id 哈希作相位偏移
        digest = hashlib.md5(equip_id.encode("utf-8")).hexdigest()
        phase = int(digest[:8], 16) / 0xFFFFFFFF * 2 * math.pi
        moving = state in ("hauling", "loading", "dumping")
        r = self._rng
        engine_temp = (
            ENGINE_TEMP_BASE
            + (ENGINE_TEMP_AMP if moving else 0.0) * (1.0 + 0.3 * math.sin(self._frame_idx * 0.35 + phase))
            + r.uniform(-1.5, 1.5)
        )
        fuel = max(
            5.0,
            FUEL_BASE - self._frame_idx * FUEL_DRAIN_RATE * dt_min * (0.6 + 0.4 * (digest[8] > "7"))
            + r.uniform(-0.8, 0.8),
        )
        speed_pct = (
            (SPEED_PCT_BASE + SPEED_PCT_AMP * abs(math.sin(self._frame_idx * 0.2 + phase)) if moving else 0.0)
            + r.uniform(-2.0, 2.0)
        )
        return {
            "engineTempC": round(max(25.0, engine_temp), 1),
            "fuelLevelPct": round(min(100.0, fuel), 1),
            "speedPct": round(max(0.0, speed_pct), 1),
        }

    def get_frame(self, scope, sim: SchedulingSimulator):
        """构建一帧遥测。scope 固定 'equipment'（当前唯一 scope）。"""
        if scope != "equipment":
            raise ValueError(f"未知 scope: {scope}")
        now = time.time()
        dt_min = max(0.0, (now - self._last_ts) / 60.0) if self._last_ts else 0.0
        self._last_ts = now
        self._advance_rng()

        equipment = []
        for eq in sim.equip:
            rec = {
                "equipId": eq.id,
                "state": eq.state,
                "loadMode": eq.load_mode,
            }
            rec.update(self._sensor_curve(eq.id, eq.state, dt_min))
            equipment.append(rec)

        fleet = {
            "loadedCount": sum(1 for eq in sim.equip if eq.load_mode == "loaded"),
            "emptyCount": sum(1 for eq in sim.equip if eq.load_mode == "empty"),
            "muckStockT": round(sum(mp.stock_t for mp in sim.muck.values()), 1),
        }
        self._frame_idx += 1
        return {"source": self.source, "scope": scope, "equipment": equipment, "fleet": fleet}


class MqttTelemetryAdapter:
    """真实遥测接入点（预留 stub）。

    实现契约（将来填写）：
      - 构造时订阅 MQTT 主题（边缘网关 → 井下设备上报）；
      - get_frame(scope) 返回与 SimTelemetryAdapter 完全同构的帧 dict
        （equipment: [{equipId, state, loadMode, engineTempC, fuelLevelPct, speedPct}],
        fleet: {loadedCount, emptyCount, muckStockT}），source 标真实来源；
      - 数据缺失时返回最近缓存帧并置 stale=true。
    """

    source = "mqtt"

    def __init__(self, **_kwargs):
        raise NotImplementedError(
            "MQTT 遥测适配器未实现：真实数据源接入时按类注释契约补全"
        )

    def get_frame(self, scope):
        raise NotImplementedError


_ADAPTERS = {"sim": SimTelemetryAdapter, "mqtt": MqttTelemetryAdapter}


def get_telemetry_adapter():
    """按配置取适配器（config/realtime_telemetry.json，缺省 sim）。

    配置为 'mqtt' 但未实现时降级 sim 并告警——推送链路不允许因数据源
    配置错误而 500/断链。
    """
    adapter_name = "sim"
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            adapter_name = json.load(f).get("adapter", "sim")
    except OSError:
        pass
    cls = _ADAPTERS.get(adapter_name, SimTelemetryAdapter)
    try:
        return cls()
    except NotImplementedError:
        logger.warning("[Realtime] adapter=%s 未实现，降级 sim 模拟源", adapter_name)
        return SimTelemetryAdapter()
