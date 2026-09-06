# -*- coding: utf-8 -*-
"""
应力场计算算法严苛验证脚本
==========================
用公开文献数据对平台应力场计算的正确性进行定量检验。

文献依据：
[J1] Castedo, R. et al. (2018). Estimation of JWL parameters of emulsion
     explosives using cylinder tests. Int. J. Rock Mech. Min. Sci.
     -> 乳化炸药 CJ 压力 6.4~7.9 GPa；约束：E0 ≤ 爆热 Q；
        乳化炸药实测爆热 Q = 2235~2537 kJ/kg。
[J2] GB6722-2014《爆破安全规程》附录 A：中硬岩萨道夫斯基 K=150~250, α=1.5~1.8。
[J3] Persson, Holmberg & Lee (1994): PPV 损伤阈值经验表（5/15/30/50 cm/s
     为工程常用简化表）；Persson 同时给出临界 PPV 依赖岩体抗拉强度/波速/模量，
     智利某矿完整岩石初始损伤阈值 ≥100 cm/s（σ_t=9MPa, c_p=5500m/s, E=50GPa）。
[J4] 波阻抗关系 σ=ρ·c·v（平面波，中远场适用）；侧限一维应变 σ_θ=ν/(1-ν)·σ_r。
"""
import os
import sys

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import math
import numpy as np

from app.services.blasting.blast_physics import (
    jwl_pressure, sadosky_vibration, RockMedium,
    stress_field_from_ppv, damage_zone_classify,
    DAMAGE_THRESHOLDS_CMPS, DAMAGE_ZONE_LABELS,
    JWLBlastSource, ElasticWaveFDTD3D, build_ppv_grid,
)

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
# A. JWL 状态方程参数验证（[J1] Castedo 2018 圆柱试验）
# ═══════════════════════════════════════════════════════════════
print("=" * 72)
print("A. JWL 状态方程参数 vs 文献（Castedo 2018 乳化炸药圆柱试验）")
print("=" * 72)
print("  [J1] 文献乳化炸药 JWL 参数范围：")
print("       A=177~435 GPa, B=0.9~4.2 GPa, R1=4.56~5.61, R2=0.51~1.19,")
print("       ω=0.36~0.37, E0=1.93~2.76 GPa；CJ 压力 6.4~7.9 GPa；")
print("       约束：E0 ≤ 爆热 Q（乳化炸药 Q=2235~2537 kJ/kg）。")
print()
print("  平台实现（emulsion）：")
print("       A=373.77 GPa, B=3.747 GPa, R1=4.15, R2=0.9, ω=0.35, E0=3.9 GPa")

# A1: JWL(V=1) 初始压力量级
p1 = jwl_pressure(1.0, "emulsion")
print(f"  JWL(V=1) 初始爆生气压力 = {p1/1e9:.2f} GPa")
check("JWL(V=1) 压力在 CJ 压力量级（文献 6.4~7.9 GPa 附近）",
      4.0 <= p1/1e9 <= 15.0, f"P={p1/1e9:.2f} GPa")

# A2: E0 是否超过爆热上限（[J1] 硬约束：E0 ≤ Q）
for name, e0, rho, q_lit in [
    ("emulsion", 3.9e9, 1100.0, 2.5e6),   # 文献爆热上限 2537 kJ/kg
    ("anfo",     2.484e9, 800.0, 4.0e6),  # ANFO 爆热典型 3.7~4.0 MJ/kg
    ("dynamite", 3.56e9, 1400.0, 5.0e6),  # 胶质炸药爆热典型 4~5 MJ/kg
]:
    e_specific = e0 / rho  # J/kg
    ratio = e_specific / q_lit
    print(f"  {name:9s}: E0/ρ = {e_specific/1e6:6.2f} MJ/kg vs 文献爆热上限 {q_lit/1e6:.1f} MJ/kg"
          f" → 比值 {ratio:.2f}")
    check(f"{name} 比能 E0/ρ ≤ 文献爆热（[J1] 硬约束）",
          e_specific <= q_lit, f"{e_specific/1e6:.2f} MJ/kg > {q_lit/1e6:.1f} MJ/kg")

# A3: 三种炸药 JWL(V=1) 压力对比
print()
for ex in ["emulsion", "anfo", "dynamite"]:
    print(f"  {ex:9s} JWL(V=1) = {jwl_pressure(1.0, ex)/1e9:.2f} GPa")

# ═══════════════════════════════════════════════════════════════
# B. 萨道夫斯基 PPV：K=30（默认可视化）vs K=200（GB6722 中硬岩）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("B. 萨道夫斯基 PPV：默认可视化 K=30 vs 文献标定 K=200")
print("=" * 72)
print("  [J2] GB6722-2014 附录 A：中硬岩 K=150~250, α=1.5~1.8")
Q_b = 100.0
print(f"  Q=100kg，α=1.5：")
for r in [2.0, 5.0, 10.0, 20.0, 30.0]:
    ppv30 = sadosky_vibration(Q_b, r, RockMedium())  # 默认 rock 无 sadosky_k → 回退 K=200?
    rk = RockMedium(); rk.sadosky_k = 30.0; rk.sadosky_alpha = 1.5
    ppv_30 = sadosky_vibration(Q_b, r, rk)
    rk200 = RockMedium(); rk200.sadosky_k = 200.0; rk200.sadosky_alpha = 1.5
    ppv_200 = sadosky_vibration(Q_b, r, rk200)
    print(f"    R={r:4.0f}m: K=30 → {ppv_30*100:6.1f} cm/s | K=200 → {ppv_200*100:6.1f} cm/s"
          f" | 比值 {ppv_200/ppv_30:.1f}x")

# 用 Persson 阈值分区，展示 K 值选择对损伤分区的影响
print()
print("  Persson 损伤分区（[J3] 阈值 5/15/30/50 cm/s）：")
rk = RockMedium(); rk.sadosky_k = 30.0; rk.sadosky_alpha = 1.5
rk200 = RockMedium(); rk200.sadosky_k = 200.0; rk200.sadosky_alpha = 1.5
for r in [2.0, 5.0, 10.0, 20.0, 30.0, 40.0, 60.0]:
    ppv_30 = sadosky_vibration(Q_b, r, rk)
    ppv_200 = sadosky_vibration(Q_b, r, rk200)
    z30 = damage_zone_classify(np.array([ppv_30]))
    z200 = damage_zone_classify(np.array([ppv_200]))
    print(f"    R={r:4.0f}m: K=30→{DAMAGE_ZONE_LABELS[int(z30[0])]:<12s} | "
          f"K=200→{DAMAGE_ZONE_LABELS[int(z200[0])]:<12s}")
check("K=30 在 R=10m 处不应将破碎区误判为弹性区（量级失真检验）",
      False, "见上方分区对比——可视化 K 渗入绝对损伤判定")

# ═══════════════════════════════════════════════════════════════
# C. 应力反演数学验证（σ_rr=ρc_p v, σ_θθ=ν/(1-ν)σ_rr, σ_vm=σ_rr/(1-ν)）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("C. 应力反演公式数值验证（[J4] 平面波波阻抗关系）")
print("=" * 72)
rho, cp, nu = 2650.0, 4500.0, 0.25
v = 0.1  # 10 cm/s PPV
sig = stress_field_from_ppv(np.array([v]), rho, cp, nu)
srr = float(sig['sigma_rr'][0])
sth = float(sig['sigma_theta'][0])
svm = float(sig['sigma_vm'][0])
# 解析值
srr_ref = rho * cp * v
sth_ref = nu / (1 - nu) * srr_ref
svm_ref = srr_ref / (1 - nu)
check("σ_rr = ρ·c_p·v", abs(srr - srr_ref) < 1e-3, f"{srr/1e6:.3f} MPa")
check("σ_θθ = ν/(1-ν)·σ_rr", abs(sth - sth_ref) < 1e-3, f"{sth/1e6:.3f} MPa")
check("σ_vm = σ_rr/(1-ν)", abs(svm - svm_ref) < 1e-3, f"{svm/1e6:.3f} MPa")

# 与 [J3] 智利案例对比：σ_t=9MPa, c_p=5500, E=50GPa 完整岩石初始损伤 PPV≥100cm/s
print()
print("  [J3] 智利某矿完整岩石（σ_t=9MPa, c_p=5500m/s）：初始损伤 PPV ≥ 100 cm/s")
for vv_cmps in [5, 15, 30, 50, 100, 200]:
    vv = vv_cmps * 0.01
    s = stress_field_from_ppv(np.array([vv]), 2650.0, 5500.0, 0.25)
    print(f"    PPV={vv_cmps:3d} cm/s → σ_vm={float(s['sigma_vm'][0])/1e6:6.2f} MPa"
          f" | σ_rr={float(s['sigma_rr'][0])/1e6:6.2f} MPa")

print()
print("  平台固定阈值 5/15/30/50 cm/s 对应 σ_vm（ρ=2650,c_p=4500,ν=0.25）：")
for thr in DAMAGE_THRESHOLDS_CMPS:
    s = stress_field_from_ppv(np.array([thr * 0.01]), 2650.0, 4500.0, 0.25)
    print(f"    PPV={thr:4.0f} cm/s → σ_vm={float(s['sigma_vm'][0])/1e6:5.2f} MPa")
print("  注：中硬岩抗拉强度 σ_t≈6~10 MPa，故平台阈值隐含'σ_vm≥~8MPa 才破碎'")
check("固定 Persson 阈值隐含 σ_vm 上限接近抗拉强度下限（合理但忽略岩石差异）",
      True, "经验表可接受，但应注明是平均岩性的近似")

# ═══════════════════════════════════════════════════════════════
# D. FDTD 爆腔源时间尺度 vs 网格 CFL 步长（数值分辨率检验）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("D. FDTD 数值分辨率：爆腔特征时间 vs CFL 时间步")
print("=" * 72)
for h in [1.5, 0.75, 0.375, 0.15]:
    cp_rock = 4500.0
    dt_cfl = 0.9 * h / (cp_rock * math.sqrt(3.0))
    src = JWLBlastSource(100.0, "emulsion")
    r0 = src.cavity_radius
    tau = r0 / cp_rock
    print(f"  h={h:5.3f}m: R0={r0*1000:.0f}mm, τ=R0/c_p={tau*1e6:6.0f}μs, "
          f"dt_CFL={dt_cfl*1e6:6.0f}μs, τ/dt={tau/dt_cfl:.2f}")
check("爆腔特征时间 τ 应 ≥ 数个 CFL 时间步（否则爆腔压力时程欠解析）",
      tau / dt_cfl >= 2.0, f"τ/dt={tau/dt_cfl:.2f} < 2")

# 爆腔半径 vs 网格间距（空间分辨率）
src2 = JWLBlastSource(100.0, "emulsion")
for h in [1.5, 0.75, 0.375]:
    print(f"  h={h}m: R0/h = {src2.cavity_radius/h:.2f}（需 ≥1 才能解析爆腔）")

# ═══════════════════════════════════════════════════════════════
# E. FDTD 实际运行网格收敛性（生产 h=1.5m vs 加密 h=0.75m）
# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print("E. FDTD 输出网格收敛性快速检查")
print("=" * 72)
print("  （仅小网格快照；完整收敛测试见 test_blast_physics）")
try:
    grid, shape, bmin, bmax = build_ppv_grid(
        tunnel_width=18, tunnel_height=15, extent_forward=25, resolution=3.0)
    eng = ElasticWaveFDTD3D(grid, bmin, bmax, shape,
                            JWLBlastSource(100.0, "emulsion"))
    eng.step(50)
    ppv = eng.get_ppv()
    print(f"  h≈3.0m 网格, 50 步后: max PPV={float(ppv.max()):.4f} m/s, "
          f"mean={float(ppv.mean()):.6f} m/s")
    # 源强度标度因子（经验修正，非物理量纲）
    print(f"  _src_scale = {eng._src_scale:.4f} (含经验 h^0.75 修正，量纲 m^0.75)")
    print(f"  => 注意：引擎 PPV 输出为相对可视化标度，未做物理绝对标定")
    check("FDTD 可运行且输出有界", np.isfinite(ppv).all() and ppv.max() > 0)
except Exception as ex:
    print(f"  [失败] FDTD 运行异常: {ex}")
    check("FDTD 可运行", False, str(ex))

# ═══════════════════════════════════════════════════════════════
print()
print("=" * 72)
print(f"应力场验证汇总: 通过 {PASS} 项 / 失败 {FAIL} 项")
print("=" * 72)
sys.exit(0 if FAIL == 0 else 1)
