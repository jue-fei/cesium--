# -*- coding: utf-8 -*-
"""平台 vs 文献现场实验比对 —— 双事件版

002 南山隧道：文献给出萨道夫斯基回归 V=113.64·ρ^-1.341，R²=0.6125（图5-1/5-2）。
  比对A=独立锚点(表3-2 掏槽段Q=28.8kg,R=26.349m→实测6.056)；B=由R²反演现场散布；
  C=平台引擎实现回读(自证、标注非验证)。

006 Da Balai 隧道：文献(eng-07-00161-v2)为模型试验+现场应用研究，**未给出萨道夫斯基 K/α**，
  现场实测仅报告不同工况下的 PPV(表12)、拉裂效率(表10)、大块率(表11)；模型试验 PPV(表9)。
  比对A=平台006配置峰值振速 vs 文献现场/模型试验 PPV 分布；B=旁证指标(拉裂效率/半孔率)。
  并标记：006 当前振速模型未用文献标定(平台回退默认 K)，配置值 2.8 cm/s 与现场不符。
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from app.services.blasting.blast_physics import RockMedium, sadosky_vibration  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "nanshan_validation_output")
os.makedirs(OUT_DIR, exist_ok=True)


def _mean(xs): return sum(xs) / len(xs)
def _sd(xs):
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def _platform_ppv(q, r, k=None, a=None):
    rock = RockMedium()
    rock.sadosky_k = k if k is not None else 113.64
    rock.sadosky_alpha = a if a is not None else 1.341
    return float(sadosky_vibration(q, r, rock)) * 100.0


# ══════════════ 002 南山 ══════════════
K, ALPHA, R2 = 113.64, 1.341, 0.6125
LNK = math.log(K)
nan = {
    "event": "BLAST-2026-002", "name": "南山隧道上台阶楔形掏槽微差爆破",
    "model": {"K": K, "alpha": ALPHA, "literature_R2": R2},
    "units": {"ppv": "cm/s", "scaled_distance": "m/kg^(1/3)"},
}
nan["A_anchor"] = [{
    "name": "全断面·掏槽段（表3-2）", "Q_seg_kg": 28.8, "R_m": 26.349,
    "v_measured_cm_s": 6.056, "v_platform_cm_s": round(_platform_ppv(28.8, 26.349), 3),
    "relative_error_pct": round((_platform_ppv(28.8, 26.349) - 6.056) / 6.056 * 100, 2),
}]
# B：现场散布（由 R² 反演，ρ∈[19,31]）
dln = math.log(31) - math.log(19)
var_eps = (1 - R2) / R2 * (ALPHA ** 2 * dln ** 2 / 12)
sigma = math.sqrt(var_eps)
expected_abs = sigma * math.sqrt(2 / math.pi)
nan["B_scatter"] = {
    "rho_window": [19, 31], "literature_R2": R2, "sigma_ln": round(sigma, 4),
    "expected_abs_relative_error_pct": round(expected_abs * 100, 1),
    "one_sigma_band_pct": [round((math.exp(-sigma) - 1) * 100, 1), round((math.exp(sigma) - 1) * 100, 1)],
}
# C：实现回读
nan["C_consistency"] = {
    "note": "平台引擎 vs 文献回归线同源回读，仅校验实现，非现场验证。",
    "regression_readback": [
        {"rho": rho, "regression_cm_s": round(math.exp(LNK - ALPHA * math.log(rho)), 4),
         "platform_cm_s": round(_platform_ppv(1.0, rho), 4)}
        for rho in [8.6, 15, 20, 25, 30]
    ],
}

# ══════════════ 006 昆阳磷矿 ══════════════
# 006 现已完全改为昆阳磷矿模型（44→43孔楔形掏槽光面爆破，Q=84kg，K=90.63/α=1.58）。
# 文献给出萨道夫斯基回归（据 M1~M3 三方向合成速度拟合），故 006 与 002 采用同一严谨口径：
#   M1~M3 = K/α 拟合点（平台回代=拟合残差，作诊断）；M4 = 独立验证（未参与标定）。
KY_K, KY_A, KY_Q = 90.63, 1.58, 84.0
_KY_MEAS = [
    ("M1", 33.70, 3.18, True),
    ("M2", 43.70, 3.11, True),
    ("M3", 54.70, 1.45, True),
    ("M4", 65.85, 1.79, False),
]
def _ky_platform(r):
    rock = RockMedium()
    rock.sadosky_k = KY_K
    rock.sadosky_alpha = KY_A
    return float(sadosky_vibration(KY_Q, r, rock)) * 100.0

ky = {
    "event": "BLAST-2026-006", "name": "昆阳磷矿二矿巷道楔形掏槽光面爆破",
    "units": {"ppv": "cm/s", "distance": "m", "charge": "kg"},
    "literature": "王万禄等《昆阳磷矿二矿巷道围岩爆破振动监测与分析》采矿技术 2025,25(2):78-88",
    "model": {"K": KY_K, "alpha": KY_A, "Q_seg_kg": KY_Q,
              "fit_basis": "M1~M3 三方向合成速度最小二乘（M4 异常剔除）"},
}
ky_q13 = KY_Q ** (1 / 3)
ky["A_points"] = [
    {"station": n, "R_m": r, "scaled_distance_rho": round(r / ky_q13, 2),
     "v_measured_cm_s": v, "v_platform_cm_s": round(_ky_platform(r), 3),
     "relative_error_pct": round((_ky_platform(r) - v) / v * 100, 2),
     "in_calibration_set": fitted}
    for n, r, v, fitted in _KY_MEAS
]
_ky_pred = [p["v_platform_cm_s"] for p in ky["A_points"]]
_ky_meas = [p["v_measured_cm_s"] for p in ky["A_points"]]
ky["metrics_all_4"] = {
    "ME_cm_s": round(sum(a - b for a, b in zip(_ky_pred, _ky_meas)) / 4, 3),
    "MAE_cm_s": round(sum(abs(a - b) for a, b in zip(_ky_pred, _ky_meas)) / 4, 3),
    "RMSE_cm_s": round(math.sqrt(sum((a - b) ** 2 for a, b in zip(_ky_pred, _ky_meas)) / 4), 3),
    "MAPE_pct": round(sum(abs(a - b) / b for a, b in zip(_ky_pred, _ky_meas)) / 4 * 100, 2),
}
ky["independent_validation_M4"] = {
    "v_measured_cm_s": _KY_MEAS[3][2],
    "v_platform_cm_s": _ky_pred[3],
    "relative_error_pct": ky["A_points"][3]["relative_error_pct"],
    "note": "M4 未参与 K/α 标定，其误差为真正的独立外推验证。",
}

both = {
    "title": "平台 vs 文献现场实验比对（双事件：南山002 · 昆阳磷矿006）",
    "generated_by": "field_comparison_both.py + backend sadosky_vibration",
    "cases": [nan, ky],
    "caveat_002": "002 平台采用文献标定 K/α，比对验证其为『标定模型复现现场散布』，属拟合质量评估。",
    "caveat_006": "006 平台采用昆阳文献标定 K/α（K=90.63/α=1.58），口径同 002；M1~M3 为拟合残差，"
                  "M4 为独立外推验证点。",
}
dest = os.path.join(OUT_DIR, "both_field_comparison.json")
with open(dest, "w", encoding="utf-8") as f:
    json.dump(both, f, ensure_ascii=False, indent=2)

print("=== 双事件现场比对 ===")
a = nan["A_anchor"][0]
print(f"[002 南山] 锚点: 实测{a['v_measured_cm_s']} vs 平台{a['v_platform_cm_s']} "
      f"-> {a['relative_error_pct']}% ; R²现场散布期望|误差|≈{nan['B_scatter']['expected_abs_relative_error_pct']}%")
print(f"[006 昆阳] 文献标定 K={KY_K} α={KY_A} Q={KY_Q}kg，逐点回代 4 个现场测点:")
for p in ky["A_points"]:
    tag = "拟合点" if p["in_calibration_set"] else "独立验证"
    print(f"   {p['station']}: R={p['R_m']} ρ={p['scaled_distance_rho']:>5} "
          f"实测{p['v_measured_cm_s']} vs 平台{p['v_platform_cm_s']} "
          f"-> {p['relative_error_pct']:+.2f}% [{tag}]")
m = ky["metrics_all_4"]
print(f"   4点: ME={m['ME_cm_s']:+.3f} MAE={m['MAE_cm_s']:.3f} RMSE={m['RMSE_cm_s']:.3f} MAPE={m['MAPE_pct']:.2f}%")
print(f"   独立验证 M4 -> {ky['independent_validation_M4']['relative_error_pct']:+.2f}%")
print(f"[OK] 写入 {dest}")