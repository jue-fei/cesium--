"""FDTD step 耗时基准

优化前基线（纯 NumPy，2026-09）：per_substep≈1.29ms，per_frame(577)≈716ms，
完整 10s 播放(100 个 bin 帧)计算 ≈74s。
优化后（numba 内联内核）读取本脚本输出对比。
"""
import time
import numpy as np
from app.services.blasting.blast_physics import build_ppv_grid, make_fdtd_engine

g, shp, lo, hi = build_ppv_grid(tunnel_width=18.0, tunnel_height=15.0)
engine = make_fdtd_engine(g, shp, lo, hi, charge_kg=100.0, explosive_type="emulsion")
dt = engine.dt
timestep = 0.05
n_sub = max(1, int(round(timestep / dt)))
print(f"grid={shp} n={g.shape[0]} h={engine.h:.4f} dt={dt:.3e} n_substeps_per_frame={n_sub}")

# 预热（含编译/缓存加载），再取稳态：单次大推进比 step(小步数) 更贴近流式节拍
engine.step(n_sub)

def time_frame(reps=5):
    t0 = time.perf_counter()
    for _ in range(reps):
        engine.step(n_sub)
    t1 = time.perf_counter()
    return (t1 - t0) / reps

per_frame = time_frame()
per_sub = per_frame / n_sub
print(f"per_substep={per_sub*1e6:.1f} us ({per_sub*1e3:.3f} ms)")
print(f"per_frame({n_sub} sub)={per_frame*1e3:.1f} ms")

# 外推完整 10s 播放：200 帧，仅偶数帧做 PPV 全推进（100 个 bin 帧）
duration, timestep_ = 10.0, 0.05
total_frames = int(round(duration / timestep_))
bin_frames = total_frames // 2
print(f"extrapolate: {duration}s 播放需 {bin_frames} 次 bin 推进 "
      f"(每次 {n_sub} 子步) => FDTD 计算总量 ~{bin_frames*per_frame:.1f}s")
