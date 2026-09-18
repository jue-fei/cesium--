"""blast_physics 多源叠加口径回归（pytest，从 backend-py 根目录运行）。

锁定两个口径：
1. 时域错峰峰值（peak_ppv_envelope_multi, peak_method="history"）必须等于
   "逐点到达序"精确解 —— 与逐时刻暴力采样包络矢量和的最大值一致（<1%）。
   旧"延时序"增量累加在 visual_c_p≈35 m/s 模式下（路径时差压倒延期差）
   会把未到达源以 e^(+D·Δarr)>1 的权重提前计入 → 系统性偏高，本测试可判别
   （场景中到达序与延时序完全颠倒，旧实现偏差 >20%）。
2. 镜象反射条目（_expand_sources_with_reflections）：幅值 × amp_scale、
   接收侧 gate_z_min 门控（空腔一侧与无反射严格相等）。
"""

import numpy as np

from app.services.blasting.blast_physics import (
    _expand_sources_with_reflections,
    peak_ppv_envelope_multi,
    ppv_field_3d_multi,
)

K = 90.0
ALPHA = 1.58
VISUAL_CP = 35.0
BETA = 0.02
VISUAL_BETA = 0.8
MIN_STANDOFF = 0.5

# 与前端 staggeredPeakExact.test.js 同一场景：探针 [0,0,20] 处
# 延时序 A(0) < C(100ms) < B(250ms)；到达序 B(0.32s) < C(0.45s) < A(0.58s)
SOURCES = [
    {"pos": [3.0, 0.0, 0.0], "charge_kg": 100.0, "delay_s": 0.0},
    {"pos": [-2.0, 1.0, 8.0], "charge_kg": 60.0, "delay_s": 0.1},
    {"pos": [0.5, 0.2, 17.6], "charge_kg": 40.0, "delay_s": 0.25},
]


def _brute_peak(grid_xyz, sources, t_max=2.0, dt=0.001):
    """包络模型逐时刻暴力采样取最大（与 ppv_field_3d_multi/峰值场同一模型）。"""
    grid = np.asarray(grid_xyz, dtype=np.float64)
    best = np.zeros(grid.shape[0], dtype=np.float64)
    for t in np.arange(0.0, t_max, dt):
        v = np.zeros((grid.shape[0], 3), dtype=np.float64)
        for s in sources:
            gate = s.get("gate_z_min")
            act = np.ones(grid.shape[0], dtype=bool) if gate is None else grid[:, 2] >= gate
            pos = np.asarray(s["pos"], dtype=np.float64)
            q = float(s["charge_kg"])
            delay = float(s["delay_s"])
            scale = float(s.get("amp_scale", 1.0))
            d = grid - pos
            r = np.maximum(np.linalg.norm(d, axis=1), MIN_STANDOFF)
            gap = t - (delay + r / VISUAL_CP)
            m = (gap > 0) & act
            if not m.any():
                continue
            a = (
                K * q ** (ALPHA / 3.0) * r ** (-ALPHA)
                * np.exp(-(BETA + VISUAL_BETA) * np.maximum(gap, 0.0))
                * scale
                * 0.01
            )
            a = np.where(m, a, 0.0)
            v += a[:, None] * (d / r[:, None])
        best = np.maximum(best, np.linalg.norm(v, axis=1))
    return best


def test_peak_history_equals_brute_time_domain_max():
    grid = np.array([[0.0, 0.0, 20.0], [5.0, 5.0, 5.0]])
    peak, arrival = peak_ppv_envelope_multi(
        grid, SOURCES, K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA, min_standoff=MIN_STANDOFF,
    )
    brute = _brute_peak(grid, SOURCES)
    assert peak[0] > 0
    assert abs(peak[0] - brute[0]) / brute[0] < 0.01
    assert abs(peak[1] - brute[1]) / brute[1] < 0.01
    # arrival = 最早到达（B 源最近）；核心场 float32 化（29 万点×91 源性能）后
    # arrival 精度 ~1e-8s，对波前门控/动画完全无感，取 1e-6 容差
    r_b = np.linalg.norm(np.array([0.0, 0.0, 20.0]) - np.array(SOURCES[2]["pos"]))
    assert abs(arrival[0] - (SOURCES[2]["delay_s"] + r_b / VISUAL_CP)) < 1e-6


def test_peak_history_exact_with_mirror_reflections():
    expanded = _expand_sources_with_reflections(SOURCES, face_z=10.0, coeff=0.85)
    assert len(expanded) == len(SOURCES) + 1  # 仅 B 源在岩体侧（z=17.6 > 10）
    img = expanded[-1]
    assert img["gate_z_min"] == 10.0
    assert abs(img["pos"][2] - (2 * 10.0 - 17.6)) < 1e-9
    # 负号镜像（自由面/压力释放边界）：幅值为负、|amp_scale| = coeff
    assert abs(img["amp_scale"] + 0.85) < 1e-9
    grid = np.array([[0.0, 0.0, 20.0]])
    peak, _ = peak_ppv_envelope_multi(
        grid, expanded, K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA, min_standoff=MIN_STANDOFF,
    )
    brute = _brute_peak(grid, expanded)
    assert abs(peak[0] - brute[0]) / brute[0] < 0.01


def test_mirror_gate_zero_contribution_outside_rock_side():
    """接收点在自由面空腔一侧（z < gate）时，反射条目贡献严格为零。"""
    grid = np.array([[0.0, 0.0, 5.0]])  # z=5 < face_z=10
    direct_only, _ = peak_ppv_envelope_multi(
        grid, SOURCES, K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA,
    )
    with_refl, _ = peak_ppv_envelope_multi(
        grid, _expand_sources_with_reflections(SOURCES, 10.0, 0.85),
        K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA,
    )
    assert np.allclose(direct_only, with_refl, atol=1e-12)
    # dmin 只统计直达源 → 影响包络口径一致（无 influence_radius 时两者本就同值）
    field_direct = ppv_field_3d_multi(grid, SOURCES, t=2.0, K=K, alpha=ALPHA,
                                      visual_c_p=VISUAL_CP, beta=BETA, visual_beta=VISUAL_BETA)
    field_refl = ppv_field_3d_multi(grid, _expand_sources_with_reflections(SOURCES, 10.0, 0.85),
                                    t=2.0, K=K, alpha=ALPHA,
                                    visual_c_p=VISUAL_CP, beta=BETA, visual_beta=VISUAL_BETA)
    assert np.allclose(field_direct, field_refl, atol=1e-12)


def test_mirror_reflection_amplifies_rock_side_receivers():
    """岩体侧近自由面接收点：反射使峰值场增大（镜像距接收点更近时显著放大）。

    单源 [0,0,12]（q=50kg）、face_z=10 → 镜象 [0,0,8]；接收点 [0,0,11]：
    直达 1m、镜像 3m，反射贡献 ≈ 0.85·3^1.58 ≈ 4.9 倍直达幅值 → 峰值必增大。
    """
    src = [{"pos": [0.0, 0.0, 12.0], "charge_kg": 50.0, "delay_s": 0.0}]
    grid = np.array([[0.0, 0.0, 11.0]])
    direct, _ = peak_ppv_envelope_multi(
        grid, src, K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA,
    )
    with_refl, _ = peak_ppv_envelope_multi(
        grid, _expand_sources_with_reflections(src, 10.0, 0.85),
        K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA,
    )
    assert direct[0] > 0
    # 负号镜像：反射与直达同向叠加（源-面-接收点几何下约 +10%）
    assert with_refl[0] > 1.05 * direct[0]


def test_peak_bound_is_simultaneous_upper_bound():
    grid = np.array([[0.0, 0.0, 20.0]])
    peak_bound, _ = peak_ppv_envelope_multi(
        grid, SOURCES, K=K, alpha=ALPHA, visual_c_p=VISUAL_CP,
        beta=BETA, visual_beta=VISUAL_BETA, peak_method="bound",
    )
    v = np.zeros(3)
    for s in SOURCES:
        d = grid[0] - np.asarray(s["pos"])
        r = max(np.linalg.norm(d), MIN_STANDOFF)
        v += K * s["charge_kg"] ** (ALPHA / 3.0) * r ** (-ALPHA) * 0.01 * (d / r)
    assert abs(peak_bound[0] - np.linalg.norm(v)) < 1e-6


def test_expand_reflections_noop_without_face_or_rock_side_sources():
    assert _expand_sources_with_reflections(SOURCES, None, 0.85) == SOURCES
    assert _expand_sources_with_reflections(SOURCES, 10.0, 0.0) == SOURCES
    deep = [{"pos": [0.0, 0.0, 5.0], "charge_kg": 10.0, "delay_s": 0.0}]  # 全在面内侧
    assert _expand_sources_with_reflections(deep, 10.0, 0.85) == deep


def test_expand_reflections_caps_source_count():
    many = [
        {"pos": [float(i), 0.0, 12.0], "charge_kg": 1.0 + i, "delay_s": 0.0}
        for i in range(30)
    ]
    out = _expand_sources_with_reflections(many, 10.0, 0.85)
    assert len(out) == 30 + 16  # 反射条目按药量取前 16
    assert sum(1 for s in out if s.get("gate_z_min") is not None) == 16
