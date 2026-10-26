"""FDTD numba 内核 vs 纯 NumPy 回退一致性对照

通过翻转 blast_physics._HAS_NUMBA 在同一进程分别构造同参引擎，
推进相同子步数后比较 PPV / σ_vm / 损伤分区。
数值上允许微小舍入差（float32 累积），用相对差阈值而非逐 bit。

用法：  PYTHONPATH=. .venv/Scripts/python.exe audit_scripts/verify_fdtd_parity.py
"""
import time
import numpy as np

import app.services.blasting.blast_physics as bp
from app.services.blasting.blast_physics import (
    build_ppv_grid, make_fdtd_engine, damage_zone_classify,
)

assert bp._HAS_NUMBA, "本对照需要 numba 可用（numpy 路径作为基准）"


def _run(resolution, sources, n_sub, charge_kg=100.0):
    grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, resolution)
    eng = make_fdtd_engine(grid_xyz, gs, bmin, bmax, charge_kg, 'emulsion',
                           sources=sources)
    t0 = time.perf_counter()
    eng.step(n_sub)
    dt = time.perf_counter() - t0
    return eng, eng.get_ppv().astype(np.float64), eng.get_sigma_vm().astype(np.float64), dt


def _compare(name, resolution, sources, n_sub):
    # numpy 基准
    bp._HAS_NUMBA = False
    eng_np, ppv_np, sm_np, dt_np = _run(resolution, sources, n_sub)
    # numba 内核
    bp._HAS_NUMBA = True
    eng_j, ppv_j, sm_j, dt_j = _run(resolution, sources, n_sub)

    # 归一化到各自全场峰值（避免近零处放大相对差）；另给 p99 逐点相对差
    def scaled_relerr(a, b):
        scale = float(np.abs(b).max())
        if scale <= 1e-12:
            return float(np.abs(a - b).max())
        return float(np.abs(a - b).max() / scale)

    def p99_point_relerr(a, b):
        denom = np.maximum(np.abs(b), 1e-12)
        rel = np.abs(a - b) / denom
        return float(np.percentile(rel, 99))

    r_ppv = scaled_relerr(ppv_j, ppv_np)
    r_sm = scaled_relerr(sm_j, sm_np)
    q_ppv = p99_point_relerr(ppv_j, ppv_np)
    z_j = damage_zone_classify(ppv_j)
    z_n = damage_zone_classify(ppv_np)
    agree = float(np.mean(z_j == z_n))
    print(f"[{name}] grid={eng_np.grid_shape} n_sub={n_sub} "
          f"per_sub numpy={dt_np/n_sub*1e3:.3f}ms numba={dt_j/n_sub*1e3:.3f}ms "
          f"| scaled_max_rel ppv={r_ppv:.2e} sigma_vm={r_sm:.2e} "
          f"p99_point_rel ppv={q_ppv:.2e} zones_agree={agree*100:.2f}%")
    assert r_ppv < 1e-2 and r_sm < 1e-2, f"全场尺度相对差超 1e-2"
    assert agree >= 0.995, f"损伤分区一致率 < 99.5%: {agree*100:.2f}%"
    assert abs(eng_np.sim_time - eng_j.sim_time) < 1e-12
    return r_ppv, r_sm, agree


def main():
    print("=== numba vs numpy FDTD 一致性对照（_HAS_NUMBA 翻转）===")
    # 单源（生产分辨率，短推进；长推进用粗网格）
    _compare("single@0.75", 0.75, None, 150)
    _compare("single@2.5", 2.5, None, 400)
    # 多源延时（2.5m 粗网格，两源一立即一延时）
    multi = [
        {"x": 0.0, "y": 0.0, "z": 2.0, "chargeKg": 50.0, "delayMs": 0.0},
        {"x": 0.0, "y": 0.0, "z": 6.0, "chargeKg": 50.0, "delayMs": 20.0},
    ]
    _compare("multi_delay@2.5", 2.5, multi, 400)
    print("ALL PARITY CHECKS PASSED")


if __name__ == "__main__":
    main()
