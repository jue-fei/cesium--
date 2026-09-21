"""
equipment/health.py —— 设备健康模型（后端单源）

健康分 = 加权(油温分/油量分/速度分) ∈ [0,100]，分级：正常(≥80)/关注(≥60)/告警(<60)。
告警阈值与前端 monitoringAlerts.js 严格同源（油温 95℃ / 油量 30% / 速度 95%），
数值锁定在 shared-consistency-baseline.json#equipmentHealthCmps，两端契约测试守护。

数据源：TelemetryAdapter（2.2 全域实时推送，Sim 模拟源）；健康分随计算写入
时序层（2.1，metric=equipment.health，tags={equipId}）供趋势查询。
"""
import time

from app.services.realtime.telemetry import get_telemetry_adapter
from app.services.timeseries.ts_store import record_metric

# ---- 阈值常量（单源：本模块 + baseline#equipmentHealthCmps 两端测试锁定）----
# 告警阈值（与前端 monitoringAlerts 一致）
TEMP_ALARM_C = 95.0     # 油温告警
FUEL_ALARM_PCT = 30.0   # 油量告警
SPEED_ALARM_PCT = 95.0  # 速度利用率告警

# 子项评分锚点
TEMP_NORMAL_C = 80.0    # 油温满分锚点（≤80 满分）
FUEL_FULL_PCT = 60.0    # 油量满分锚点
FUEL_LOW_PCT = 15.0     # 油量零分锚点
SPEED_SOFT_PCT = 85.0   # 速度满分锚点（过载惩罚起点）
SPEED_HARD_PCT = 110.0  # 速度零分锚点

# 子项权重
WEIGHTS = {"temp": 0.45, "fuel": 0.35, "speed": 0.20}

# 健康分级阈值（score ∈ [0,100]）
LEVEL_NORMAL_MIN = 80.0
LEVEL_WATCH_MIN = 60.0

LEVELS = ("normal", "watch", "alarm")
LEVEL_LABELS = {"normal": "正常", "watch": "关注", "alarm": "告警"}


def _clamp01(v):
    return max(0.0, min(1.0, v))


def temp_score(engine_temp_c):
    """油温分：≤TEMP_NORMAL_C 满分，线性降至 TEMP_ALARM_C 零分，超温为 0。"""
    if engine_temp_c <= TEMP_NORMAL_C:
        return 100.0
    if engine_temp_c >= TEMP_ALARM_C:
        return 0.0
    return round(_clamp01((TEMP_ALARM_C - engine_temp_c) / (TEMP_ALARM_C - TEMP_NORMAL_C)) * 100.0, 1)


def fuel_score(fuel_pct):
    """油量分：≥FUEL_FULL_PCT 满分，线性降至 FUEL_LOW_PCT 零分。"""
    if fuel_pct >= FUEL_FULL_PCT:
        return 100.0
    if fuel_pct <= FUEL_LOW_PCT:
        return 0.0
    return round(_clamp01((fuel_pct - FUEL_LOW_PCT) / (FUEL_FULL_PCT - FUEL_LOW_PCT)) * 100.0, 1)


def speed_score(speed_pct):
    """速度分：≤SPEED_SOFT_PCT 满分，过载线性降至 SPEED_HARD_PCT 零分。"""
    if speed_pct <= SPEED_SOFT_PCT:
        return 100.0
    if speed_pct >= SPEED_HARD_PCT:
        return 0.0
    return round(_clamp01((SPEED_HARD_PCT - speed_pct) / (SPEED_HARD_PCT - SPEED_SOFT_PCT)) * 100.0, 1)


def health_level(score):
    if score >= LEVEL_NORMAL_MIN:
        return "normal"
    if score >= LEVEL_WATCH_MIN:
        return "watch"
    return "alarm"


def derive_alerts(rec):
    """告警明细（语义与前端 monitoringAlerts 一致，阈值同源 baseline）。"""
    alerts = []
    if rec.get("engineTempC", 0) >= TEMP_ALARM_C:
        alerts.append({"code": "engine_temp_high", "message": f"油温过高（{rec['engineTempC']}℃ ≥ {TEMP_ALARM_C}℃）"})
    if rec.get("fuelLevelPct", 100) <= FUEL_ALARM_PCT:
        alerts.append({"code": "fuel_low", "message": f"油量偏低（{rec['fuelLevelPct']}% ≤ {FUEL_ALARM_PCT}%）"})
    if rec.get("speedPct", 0) >= SPEED_ALARM_PCT:
        alerts.append({"code": "speed_overload", "message": f"速度利用率过高（{rec['speedPct']}% ≥ {SPEED_ALARM_PCT}%）"})
    return alerts


def compute_health(rec):
    """单设备健康分（遥测记录 → {score, level, subScores, alerts}）。"""
    subs = {
        "temp": temp_score(rec.get("engineTempC", TEMP_NORMAL_C)),
        "fuel": fuel_score(rec.get("fuelLevelPct", FUEL_FULL_PCT)),
        "speed": speed_score(rec.get("speedPct", 0.0)),
    }
    score = round(sum(subs[k] * WEIGHTS[k] for k in WEIGHTS), 1)
    return {
        "score": score,
        "level": health_level(score),
        "subScores": subs,
        "alerts": derive_alerts(rec),
    }


def build_health_frame(sim):
    """构建全 fleet 健康帧：遥测帧 → 健康分，并写入时序层（趋势数据源）。"""
    frame = get_telemetry_adapter().get_frame("equipment", sim)
    equipment = []
    scores = []
    for rec in frame["equipment"]:
        h = compute_health(rec)
        scores.append(h["score"])
        record_metric("equipment.health", h["score"], tags={"equipId": rec["equipId"]})
        if h["level"] == "alarm":
            record_metric("equipment.health_alarm", 1.0, tags={"equipId": rec["equipId"]})
        equipment.append({**rec, **h})

    alarm_n = sum(1 for e in equipment if e["level"] == "alarm")
    watch_n = sum(1 for e in equipment if e["level"] == "watch")
    return {
        "source": frame["source"],
        "ts": time.time(),
        "equipment": equipment,
        "fleet": {
            **frame["fleet"],
            "avgScore": round(sum(scores) / len(scores), 1) if scores else None,
            "alarmCount": alarm_n,
            "watchCount": watch_n,
        },
    }
