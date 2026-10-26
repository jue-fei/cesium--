# -*- coding: utf-8 -*-
"""昆阳磷矿二矿巷道爆破振动 —— 平台 vs 文献现场实测 · 逐点比对实验

文献：王万禄等《昆阳磷矿二矿巷道围岩爆破振动监测与分析》采矿技术 2025, 25(2):78-88
  - 萨道夫斯基回归：V = K·(Q^(1/3)/R)^α，K=90.63, α=1.58（据 M1~M3 三方向合成速度拟合）
  - 现场实测（表2，总装药 Q=84kg）：
      测点  爆距R/m   比例距离   合成速度v/(cm/s)
      M1    33.70    7.69       3.18
      M2    43.70    9.98       3.11
      M3    54.70    12.50      1.45
      M4    65.85    15.04      1.79   （文献判定异常，未参与 K/α 拟合）
  - 验证口径：
      * M1~M3：K/α 由它们回归而来，"平台回代"属实现一致性（同源自证，作拟合诊断）
      * M4    ：独立验证（不参与标定），据式显检验平台模型外推精度
  - 平台：后端离线引擎 sadosky_vibration(Q,R,RockMedium(K=90.63, α=1.58))，
    与前端实时渲染共用同一解析式。
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from app.services.blasting.blast_physics import RockMedium, sadosky_vibration  # noqa: E402

K = 90.63
ALPHA = 1.58
Q = 84.0  # 总装药量 kg
# 表2 现场实测：(测点, 爆距R, 实测合成速度 cm/s, 是否参与标定)
MEAS = [
    ("M1", 33.70, 3.18, True),
    ("M2", 43.70, 3.11, True),
    ("M3", 54.70, 1.45, True),
    ("M4", 65.85, 1.79, False),
]


def _platform(q, r):
    rock = RockMedium()
    rock.sadosky_k = K
    rock.sadosky_alpha = ALPHA
    return float(sadosky_vibration(q, r, rock)) * 100.0


def main():
    q13 = Q ** (1 / 3)
    rows, preds, meas = [], [], []
    for name, r, v, fitted in MEAS:
        p = _platform(Q, r)
        rows.append({
            "station": name, "R_m": r, "scaled_distance_rho": round(r / q13, 2),
            "v_measured_cm_s": v, "v_platform_cm_s": round(p, 3),
            "relative_error_pct": round((p - v) / v * 100, 2),
            "in_calibration_set": fitted,
        })
        preds.append(p); meas.append(v)

    n = len(preds)
    mae = sum(abs(p - v) for p, v in zip(preds, meas)) / n
    rmse = math.sqrt(sum((p - v) ** 2 for p, v in zip(preds, meas)) / n)
    mape = sum(abs(p - v) / v for p, v in zip(preds, meas)) / n * 100
    me = sum(p - v for p, v in zip(preds, meas)) / n

    out = {
        "event": "BLAST-2026-006",
        "name": "昆阳磷矿二矿1890m中段胶带巷道钻爆（光面爆破）",
        "literature": "王万禄等, 采矿技术 2025, 25(2): 78-88",
        "model": {"K": K, "alpha": ALPHA, "formula": "V=K·(Q^(1/3)/R)^α",
                  "fit_basis": "M1~M3 三方向合成速度最小二乘（M4 异常剔除）"},
        "units": {"ppv": "cm/s", "distance": "m", "charge": "kg"},
        "total_charge_kg": Q,
        "points": rows,
        "metrics_all_4": {
            "ME_cm_s": round(me, 3), "MAE_cm_s": round(mae, 3),
            "RMSE_cm_s": round(rmse, 3), "MAPE_pct": round(mape, 2),
        },
        "independent_validation_M4": {
            "v_measured": 1.79, "v_platform": rows[3]["v_platform_cm_s"],
            "relative_error_pct": rows[3]["relative_error_pct"],
        },
        "caveat": "M1~M3 为 K/α 拟合点，平台回代误差系拟合残差（自证、作诊断）；"
                  "M4 未参与标定，其误差为真正的独立外推验证。"
                  "文献对 M1~M3 用合成速度回归，单方向(径向/切向/垂向)不同。",
    }
    dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "nanshan_validation_output", "kunyang_field_comparison.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print("=== 昆阳磷矿 · 平台 vs 现场逐点比对 (K=90.63, α=1.58, Q=84kg) ===")
    for r in rows:
        tag = "拟合点" if r["in_calibration_set"] else "独立验证"
        print(f"  {r['station']}: R={r['R_m']} ρ={r['scaled_distance_rho']:>5} "
              f"实测{r['v_measured_cm_s']} vs 平台{r['v_platform_cm_s']} "
              f"-> {r['relative_error_pct']:+.2f}%  [{tag}]")
    print(f"  4点总体: ME={me:+.3f} MAE={mae:.3f} RMSE={rmse:.3f} MAPE={mape:.2f}%")
    m4 = rows[3]
    print(f"  独立验证 M4: 实测{m4['v_measured_cm_s']} vs 平台{m4['v_platform_cm_s']} "
          f"-> {m4['relative_error_pct']:+.2f}%")
    print(f"[OK] 写入 {dest}")


if __name__ == "__main__":
    main()