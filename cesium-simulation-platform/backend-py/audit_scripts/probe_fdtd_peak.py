# -*- coding: utf-8 -*-
"""
FDTD 模式 PPV 峰值量级探测
==========================
复现生产路径（blasting_ws.py _stream_loop）：use_jwl=True 时
    ppv = fdtd_engine.get_ppv()
    zones = damage_zone_classify(state.peak_ppv)   # 绝对阈值 5/15/30/50 cm/s

检验：FDTD 的 PPV 峰值是否达到 damage_zone_classify 的最低阈值 5 cm/s。
物理参考：100kg 乳化炸药近场 PPV 应为数十~数百 cm/s（GB6722 K=200 时 R=5m 约 179 cm/s）。
"""
import os
import sys

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import numpy as np

from app.services.blasting.blast_physics import (
    build_ppv_grid, JWLBlastSource, ElasticWaveFDTD3D,
    damage_zone_classify, DAMAGE_ZONE_LABELS,
)

for res in [1.5, 0.75]:
    grid, shape, bmin, bmax = build_ppv_grid(
        tunnel_width=18, tunnel_height=15, extent_forward=25, resolution=res)
    src = JWLBlastSource(100.0, "emulsion")
    eng = ElasticWaveFDTD3D(grid, bmin, bmax, shape, src)
    # 推进到波前贯穿网格 + 充分余量（波到 25m 需 25/4500≈5.6ms，推进 30ms）
    n_steps = int(round(0.030 / eng.dt))
    peak = 0.0
    peak_ppv = np.zeros(grid.shape[0], dtype=np.float32)
    for i in range(n_steps):
        eng.step()
        ppv = eng.get_ppv().ravel()  # get_ppv 返回网格形状，展平
        np.maximum(peak_ppv, ppv, out=peak_ppv)
    zones = damage_zone_classify(peak_ppv)
    unique = np.unique(zones)
    frac_elastic = float((zones == 0).mean())
    print(f"h≈{res}m: 网格 {shape}, {n_steps} 步({eng.sim_time*1000:.0f}ms)")
    print(f"  峰值 PPV: max={peak_ppv.max()*100:.2f} cm/s, "
          f"mean={peak_ppv.mean()*100:.4f} cm/s")
    print(f"  damage 分区: {[(DAMAGE_ZONE_LABELS[int(z)], int((zones==z).sum())) for z in unique]}")
    print(f"  elastic(无损伤) 占比 = {frac_elastic*100:.1f}%")
    # 对比：真实中硬岩 K=200 在 R=5m 应为 ~179 cm/s
    print(f"  物理参考: GB6722 K=200, Q=100kg, R=5m → PPV≈179 cm/s（本 FDTD 应为同量级）")
    print()
