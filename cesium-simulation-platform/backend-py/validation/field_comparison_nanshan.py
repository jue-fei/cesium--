# -*- coding: utf-8 -*-
"""南山隧道萨道夫斯基振速模型 —— 平台计算 vs 文献现场数据 · 现场比对实验（严谨版）

设计原则：不做"平台公式 vs 文献回归线"的同源自证（那恒为 0%，无信息量）；
也不把目视数字化散点当作精确现场值（实测数字化 R²≈0.93，远高于文献 R²=0.61，
会把模型误差严重低估）。本版本以三类证据给出可证伪、可复算的比对：

  A) 独立锚点验证 —— 使用论文表3-2 明确标注"掏槽孔段药量 28.8kg + 埋深 26.349m
     → 实测最大振速 6.056 cm/s"的真实现场点，用平台离线引擎复算并比对。
  B) 现场散点统计拟合质量 —— 以文献权威统计 R²=0.6125（图5-1/5-2 最小二乘）
     反演模型对真实现场数据的预测散布（对数残差标准差 σ_ln、期望相对误差带），
     不虚构逐点坐标，给出模型对现场的真实预测精度。
  C) 实现一致性核验 —— 平台引擎与文献回归曲线逐点一致（属实现正确性回读）。
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app.services.blasting.blast_physics import RockMedium, sadosky_vibration  # noqa: E402

K = 113.64
ALPHA = 1.341
R2 = 0.6125
LNK = math.log(K)  # 回归在 lnV=lnK-α·lnρ 空间的截距


def build_rock():
    rock = RockMedium()
    rock.sadosky_k = K
    rock.sadosky_alpha = ALPHA
    return rock


def platform_ppv_cm_s(q_kg, dist_m):
    return float(sadosky_vibration(q_kg, dist_m, build_rock())) * 100.0


def model_logv(rho):
    return LNK - ALPHA * math.log(rho)


def main():
    out = {
        "event": "BLAST-2026-002",
        "title": "南山隧道萨道夫斯基振速模型 · 平台 vs 文献现场数据 现场比对实验（严谨版）",
        "model": {"K": K, "alpha": ALPHA, "literature_R2": R2},
        "units": {"ppv": "cm/s", "scaled_distance_rho": "m/kg^(1/3)", "charge": "kg", "distance": "m"},
    }

    # ── A. 独立锚点验证（真实现场点）─────────────────────────────
    # 论文表3-2/正文：全断面爆破，掏槽孔段药量 28.8kg，测点埋深(爆心距) 26.349m，
    # 实测最大地表振速 6.056 cm/s。
    anchors = []
    for name, q, r, v_meas in [("全断面·掏槽段（表3-2）", 28.8, 26.349, 6.056)]:
        v = platform_ppv_cm_s(q, r)
        anchors.append({
            "name": name, "Q_seg_kg": q, "R_m": r,
            "v_measured_cm_s": v_meas, "v_platform_cm_s": round(v, 3),
            "relative_error_pct": round((v - v_meas) / v_meas * 100, 2),
        })
    out["A_anchor_validation"] = anchors

    # ── B. 现场散点统计拟合质量（以文献 R² 反演模型真实预测精度）──
    # 文献图5-2 比例距离窗口 ρ∈[19,31]，lnρ 极差≈0.49，近似均匀分布。
    # Var(lnρ)≈(Δlnρ)²/12；Var_fit=α²·Var(lnρ)；Var_ε=(1-R²)/R²·Var_fit
    # 对数残差标准差 σ_ln=√Var_ε → 期望相对误差与±1σ 相对误差带（含 0.68 覆盖率）。
    rho_lo, rho_hi = 19.0, 31.0
    d_lnrho = math.log(rho_hi) - math.log(rho_lo)
    var_lnrho = (d_lnrho ** 2) / 12.0
    var_fit = ALPHA ** 2 * var_lnrho
    var_eps = (1 - R2) / R2 * var_fit
    sigma_ln = math.sqrt(var_eps)
    # 期望 |相对误差| = E|e^ε-1| ≈ E|ε|（小偏差近似），期望相对误差带 = e^(±σ_ln)-1
    expected_abs_relerr = sigma_ln * math.sqrt(2.0 / math.pi)
    band_low = math.exp(-sigma_ln) - 1.0
    band_high = math.exp(sigma_ln) - 1.0
    scatter = {
        "rho_window": [rho_lo, rho_hi],
        "literature_R2": R2,
        "sigma_ln": round(sigma_ln, 4),
        "expected_abs_relative_error_pct": round(expected_abs_relerr * 100, 1),
        "one_sigma_relative_error_band_pct": [
            round(band_low * 100, 1), round(band_high * 100, 1),
        ],
        "interpretation": ("平台采用文献标定 K/α，对真实现场数据的预测散布由文献 R²=0.6125 决定："
                           "模型可解释约 61% 的现场数据方差，约 39% 为未解释的场地/测量散布；"
                           "单点相对误差大致落在 -{low}% ~ +{hi}% 的 ±1σ 带宽内。"
                           .format(low=round(abs(band_low) * 100, 1), hi=round(band_high * 100, 1))),
    }
    out["B_field_scatter_statistics"] = scatter

    # ── C. 实现一致性核验（平台引擎 == 文献回归曲线）─────────────
    grid = [5, 8, 10, 14.18, 20, 26.349, 30, 40]
    consistency = [
        {"distance_m": d, "platform_ppv_cm_s": round(platform_ppv_cm_s(28.8, d), 4)}
        for d in grid
    ]
    # 用比例距离直接回读回归线：平台 v=K·ρ^-α
    rho_grid = [8.6, 15, 20, 25, 30]
    regression_readback = [
        {"rho": r, "regression_curve_cm_s": round(math.exp(model_logv(r)), 4),
         "platform_cm_s": round(platform_ppv_cm_s(1.0, r), 4)}
        for r in rho_grid
    ]
    out["C_consistency_check"] = {
        "note": "平台引擎与文献回归曲线同源（同 K/α），回读差异用于校验实现，不等于现场验证。",
        "anchor_curve_Q28_8": consistency,
        "regression_readback": regression_readback,
    }

    # ── 说明：效果类指标为文献沿用（非平台独立计算）──────────────
    out["adopted_effect_params_note"] = (
        "峰值应力 48MPa、单循环进尺 2.55m、块度 x50/x80/xmax=0.22/0.33/1.2m、"
        "平均/最大抛掷 9/14m、半孔率 0.75、峰值振速 4.8cm/s 等为文献实测/设计值，"
        "平台沿用于渲染（seed_nanshan_event 固化），不在本比对中作独立验证，故不标相对误差。")

    meta = {
        "generated_by": "field_comparison_nanshan.py + backend sadosky_vibration",
        "data_provenance": "锚点自《复杂环境下隧道钻爆施工降振试验研究及控制》(汪亚飞)表3-2；"
                           "R²=0.6125 自图5-1/5-2",
        "limitation": "扫描件表格数值仅可读关键锚点；逐点散度以文献 R² 为准，不作目视数字化。",
    }
    out["meta"] = meta

    dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "nanshan_validation_output", "nanshan_field_comparison.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print("=== 现场比对实验（严谨版）===")
    for a in anchors:
        print(f"[A] 锚点 {a['name']}: 实测 {a['v_measured_cm_s']} vs 平台 {a['v_platform_cm_s']}"
              f" -> 相对误差 {a['relative_error_pct']}%")
    s = scatter
    print(f"[B] 据文献 R²={R2}: σ_ln={s['sigma_ln']}, "
          f"期望|相对误差|≈{s['expected_abs_relative_error_pct']}%, "
          f"±1σ 相对误差带 {s['one_sigma_relative_error_band_pct']}")
    print("[C] 一致性核验完成（平台==回归曲线，0% 属回读核验）")
    print(f"[OK] 写入 {dest}")


if __name__ == "__main__":
    main()