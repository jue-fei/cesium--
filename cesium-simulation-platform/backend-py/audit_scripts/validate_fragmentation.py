# -*- coding: utf-8 -*-
"""
块度计算（KCO / Kuz-Ram）算法严苛验证脚本
=========================================
用公开文献数据对平台块度计算的正确性进行定量检验。

文献依据：
[L1] Cunningham, C. (1983). The Kuz-Ram model for prediction of fragmentation
     from blasting. Proc. 1st Int. Symp. Rock Frag. by Blasting, Lulea.
[L2] Cunningham, C. (1987). Fragmentation estimations and the Kuz-Ram model.
     Proc. 2nd Int. Symp. Rock Frag. by Blasting, Keystone.
[L3] Ouchterlony, F. (2005). The Swebrec function: linking fragmentation by
     blasting and crushing. Min. Technol. 114(1):29-44.
[L4] Ouchterlony, Sanchidrián & Moser (2017). Percentile Fragment Size
     Predictions for Blasted Rock and the Fragmentation-Energy Fan. Rock
     Mech. Rock Eng. (b 与 n 的关联式 b = 2·ln2·ln(x_max/x_50)·n).
[L5] Bedri et al. (2024). Djebel Bouzegza C01 石灰石采石场: Kuz-Ram 预测
     X50=680mm vs Split-Desktop 实测 P50=645mm（B×S=4.5×4.5m, q=0.20 kg/m³）.
[L6] Marques (Tese IST). FRAGTrack 13 次露天爆破: Kuz-Ram MAPE 28.6-42.1%,
     KCO MAPE 16.3-18.5%；Kuz-Ram 在 0-35cm 细粒段系统性低估通过率.
"""
import os
import sys

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import math
import numpy as np

from app.services.blasting.kco_formulas import (
    swebrec_cdf, swebrec_inverse, solve_x80, cunningham_n,
)
from app.services.blasting.kco_validator import KCOInput, calculate_kco

LN2 = math.log(2.0)
PASS, FAIL = 0, 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [通过] {name}")
    else:
        FAIL += 1
        print(f"  [失败] {name}  {detail}")

# ═══════════════════════════════════════════════════════════════
# A. Cunningham n 公式复现（[L1][L2] 1987 单种炸药简化式）
#    n = (2.2 - 14·B/D_mm) · (1-W/B) · sqrt((1+S/B)/2) · (L/H)
# ═══════════════════════════════════════════════════════════════
print("=" * 72)
print("A. Cunningham 均匀性指数 n 公式复现与文献范围对比")
print("=" * 72)
# 经典露天中硬岩：B=3.5m, d=200mm(0.2m), W=0.2, S=4.5, L=H=10
n_lit = (2.2 - 14 * 3.5 / 200) * (1 - 0.2 / 3.5) * math.sqrt((1 + 4.5 / 3.5) / 2) * (10 / 10)
n_impl = cunningham_n(3.5, 0.2, 0.2, 4.5, 10, 10)
check("露天大孔径 n 公式复现", abs(n_lit - n_impl) < 1e-9, f"文献={n_lit:.4f} 实现={n_impl:.4f}")
# Cunningham(1983) 正常范围 0.8~2.2；[L1] 报告露天典型值可达 ~1.97。
# 注：Cunningham(1987) 报告合理地层典型 0.75~1.5——公式对露天参数常给出 >1.5，
# 属 Kuz-Ram n 已知的"预测偏高"缺陷（fragmentation-energy fan 亦质疑 n 纯几何依赖）。
check("n 落在 Cunningham(1983) 正常范围 [0.8,2.2]",
      0.8 <= n_impl <= 2.2, f"n={n_impl:.3f}")

# 平台默认参数（隧道中硬岩 B=1.5,d=90mm）→ 检查 n 是否在文献范围
n_default = cunningham_n(1.5, 0.09, 0.2, 2.0, 4.5, 4.5)
print(f"  -- 平台默认隧道参数 n={n_default:.3f} (Cunningham 1987 合理地层典型 0.75~1.5, 平均≈1.0)")
check("默认参数 n 未严重超文献范围", n_default <= 2.2, f"n={n_default:.3f}")

# 孔径单位敏感性：14·B/D 要求 D 以 mm 计；若误用 m 则主导项被高估 1000 倍
n_wrong_unit = (2.2 - 14 * 3.5 / 0.2) * (1 - 0.2 / 3.5) * math.sqrt((1 + 4.5 / 3.5) / 2)
print(f"  -- 单位误用示例（D 以 m 计）→ n={n_wrong_unit:.3f}（负值，证明实现单位正确）")

# ═══════════════════════════════════════════════════════════════
# B. Kuznetsov x50 方程 + 岩石因子 A 标定
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("B. Kuznetsov x50 方程与岩石因子 A 标定")
print("=" * 72)
print("  文献 A 值 [Cunningham 1983/1987]: 中硬岩≈7, 硬岩高节理≈10, 非常硬≈13;")
print("  Cunningham 本人给出范围 8~12（下限 8 即使是软岩）.")

# 平台默认：A = 0.06*(RMD+RDI+HF) = 0.06*60 = 3.6（Lilly blastability index 式）
A_platform_default = 0.06 * (20 + 15 + 25)
print(f"  平台默认 A = 0.06×(RMD+RDI+HF) = 0.06×60 = {A_platform_default:.2f}")

# 用典型中硬岩孔网参数计算 x50，对比 A=3.6 vs 7/10/13
B, S, H, d, W = 1.5, 2.0, 4.5, 0.09, 0.2
Q = 10.8  # = q·B·S·H, q=0.8
v0 = B * S * H
x50_by_A = {}
for A in [3.6, 7.0, 10.0, 13.0]:
    out = calculate_kco(KCOInput(Q=Q, A=A, RWS=100, B=B, S=S, d=d, H=H, W_abs=W, xmax=2.0, b=2.0))
    x50_by_A[A] = out.x50
    print(f"  A={A:5.2f} → x50={out.x50*1000:7.1f} mm   (n={out.n:.3f})")

x50_default = x50_by_A[3.6]
x50_lit = x50_by_A[7.0]
print(f"\n  A=3.6 vs A=7（中硬岩文献值）: x50 相差 {x50_lit/x50_default:.2f} 倍")
check("默认 A 不应导致 x50 系统性低估 >1.8 倍",
      x50_lit / x50_default < 1.8, f"比值={x50_lit/x50_default:.2f} (>1.8 说明默认 A 偏小)")
check("A=7 中硬岩 x50 落在工程合理区间 [50, 500]mm",
      50 <= x50_lit * 1000 <= 500, f"x50={x50_lit*1000:.1f}mm")

# ═══════════════════════════════════════════════════════════════
# C. Kuz-Ram exp 形式 Swebrec 分布数学性质
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("C. Swebrec（Kuz-Ram exp 形式）分布数学性质")
print("=" * 72)
x50, xmax, n, b = 0.25, 2.0, 1.2, 2.0
xs = np.linspace(1e-6, xmax - 1e-6, 2000)
cdfs = np.array([swebrec_cdf(x, x50, xmax, n, b) for x in xs])
# C1 单调性
check("CDF 单调递增", np.all(np.diff(cdfs) >= 0))
# C2 边界
check("P(0)=0", swebrec_cdf(0, x50, xmax, n, b) == 0)
check("P(xmax)=1", swebrec_cdf(xmax, x50, xmax, n, b) == 1)
# C3 中位：P(x50) 应=0.5（这是 x50 作为中位数的定义）
p_at_x50 = swebrec_cdf(x50, x50, xmax, n, b)
check("P(x50)≈0.5（x50 必须是中位数）", abs(p_at_x50 - 0.5) < 1e-3, f"P(x50)={p_at_x50:.5f}")

# C4 反解一致性
for u in [0.1, 0.3, 0.5, 0.8, 0.9]:
    xr = swebrec_inverse(u, x50, xmax, n, b)
    back = swebrec_cdf(xr, x50, xmax, n, b)
    check(f"反解一致性 u={u}", abs(back - u) < 1e-4, f"x={xr:.5f} P={back:.5f}")

# C5 x80 与 x50 比值（[L1] 良好爆破 x80/x50≈1.5~2.0）
x80 = solve_x80(x50, xmax, n, b)
ratio = x80 / x50
check("良好爆破 x80/x50 在 [1.3, 2.5]", 1.3 <= ratio <= 2.5, f"比值={ratio:.3f}")

# ═══════════════════════════════════════════════════════════════
# D. b 参数与 n 的一致性（[L4] KCO 关联式 b = 2·ln2·ln(xmax/x50)·n）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("D. Swebrec 弯曲参数 b 与均匀性 n 的一致性（Ouchterlony KCO）")
print("=" * 72)
# 平台把 b 当独立参数默认=2.0；[L4] KCO 模型要求 b 由 n 推导
b_kco = 2 * LN2 * math.log(xmax / x50) * n
print(f"  参数 x50={x50}, xmax={xmax}, n={n}")
print(f"  平台默认 b = 2.0")
print(f"  [L4] KCO 关联 b = 2·ln2·ln(xmax/x50)·n = {b_kco:.3f}")
print(f"  比值 b_kco/b_platform = {b_kco/2.0:.2f}")
# 用平台默认参数算一次实际 b 关联
inp = KCOInput(Q=Q, A=3.6, RWS=100, B=B, S=S, d=d, H=H, W_abs=W, xmax=2.0, b=2.0)
out_d = calculate_kco(inp)
b_kco_real = 2 * LN2 * math.log(inp.xmax / out_d.x50) * out_d.n
print(f"  平台默认场景：x50={out_d.x50*1000:.1f}mm, n={out_d.n:.3f}, "
      f"KCO 关联 b={b_kco_real:.2f} vs 实现 b=2.0")
check("b 作为自由参数与 n 的 KCO 关联差异应 < 50%（提示模型不自洽则失败）",
      abs(b_kco_real - 2.0) / 2.0 < 0.5, f"偏差={(abs(b_kco_real-2.0)/2.0*100):.0f}%")

# ═══════════════════════════════════════════════════════════════
# E. 与实测数据对比（[L5] Bedri 2024 石灰石采石场）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("E. 与文献实测数据对比")
print("=" * 72)
# [L5] Bedri 2024: 石灰石采石场 B×S=4.5×4.5m, q=0.20 kg/m³,
#      Kuz-Ram 预测 X50=680mm, Split-Desktop 实测 P50=645mm
print("  [L5] Djebel Bouzegza 石灰石采石场（Bedri 2024）:")
print("       B×S=4.5×4.5m, 单耗 q=0.20 kg/m³, H 未知(假设 10m)")
print("       文献: Kuz-Ram 预测 X50=680mm, 实测 P50=645mm（偏差 +5.4%）")
H_bedri = 10.0
Q_bedri = 0.20 * (4.5 * 4.5 * H_bedri)
out_bedri = calculate_kco(KCOInput(Q=Q_bedri, A=7.0, RWS=100, B=4.5, S=4.5, d=0.2, H=H_bedri,
                                    W_abs=0.2, xmax=1.5, b=2.0))
err_bedri = abs(out_bedri.x50 - 0.680) / 0.680
print(f"       本平台(A=7,d=200mm) x50={out_bedri.x50*1000:.0f}mm vs 文献预测 680mm → 偏差 {err_bedri*100:.0f}%")
print(f"       本平台(A=7,d=89mm)   x50={calculate_kco(KCOInput(Q=Q_bedri, A=7.0, RWS=100, B=4.5, S=4.5, d=0.089, H=H_bedri, W_abs=0.2, xmax=1.5, b=2.0)).x50*1000:.0f}mm")
check("Bedri 案例在工程精度内（<50%，Kuz-Ram 典型 MAPE 15-40%）",
      err_bedri < 0.50, f"偏差={err_bedri*100:.0f}%")

# [L6] Marques IST: Kuz-Ram 对露天爆破整体 MAPE 28.6-42.1%（系统性高估块度）
print()
print("  [L6] Marques 硕士论文（FRAGTrack 13 次爆破）:")
print("       Kuz-Ram 整体 MAPE = 28.6~42.1%（系统性高估块度）")
print("       KCO 模型 MAPE = 16.3~18.5%（更优）")
print("  => 结论：Kuz-Ram/KCO 本质是±20~40%的经验预测工具，")

# ═══════════════════════════════════════════════════════════════
# F. 大块率默认行为（x_allow 缺省 → 恒为 0）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("F. 大块率默认行为")
print("=" * 72)
out_none = calculate_kco(KCOInput(Q=Q, A=7.0, RWS=100, B=B, S=S, d=d, H=H, W_abs=W, xmax=2.0, b=2.0))
out_allow = calculate_kco(KCOInput(Q=Q, A=7.0, RWS=100, B=B, S=S, d=d, H=H, W_abs=W, xmax=2.0, b=2.0, x_allow=0.3))
print(f"  x_allow 缺省 → oversize_ratio = {out_none.oversize_ratio:.3f}")
print(f"  x_allow=0.3m → oversize_ratio = {out_allow.oversize_ratio:.3f}")
check("缺省时大块率应为真实尾部概率（>0），而非恒 0", out_none.oversize_ratio > 0)

# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print(f"块度验证汇总: 通过 {PASS} 项 / 失败 {FAIL} 项")
print("=" * 72)
sys.exit(0 if FAIL == 0 else 1)
