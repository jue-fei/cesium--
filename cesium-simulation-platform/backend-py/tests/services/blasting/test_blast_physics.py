"""blast_physics.py 单元测试（pytest 风格）

覆盖：
- sadosky_vibration 萨道夫斯基峰值振动速度
- jwl_pressure JWL 状态方程爆生气压力
- ppv_field_3d 3D 球面波 PPV 振动场（因果性 / 衰减 / 单位换算）
- stress_field_from_ppv 弹性球面波应力反演
- damage_zone_classify Persson 损伤分区
- wave_field_1d 一维波动场（因果性 / 时间衰减）
- pack_ppv/stress/damage_binary 二进制帧打包结构
"""
import os
import sys
import struct

# 确保可从 backend-py 根目录导入 app 包（兼容 pytest / python -m pytest 调用）
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import numpy as np
import pytest

from app.services.blasting.blast_physics import (
    BlastSource,
    RockMedium,
    sadosky_vibration,
    jwl_pressure,
    wave_field_1d,
    ppv_field_3d,
    build_ppv_grid,
    pack_ppv_binary,
    pack_stress_binary,
    pack_damage_binary,
    stress_field_from_ppv,
    damage_zone_classify,
    DAMAGE_THRESHOLDS_CMPS,
    DAMAGE_ZONE_LABELS,
    JWLBlastSource,
    ElasticWaveFDTD3D,
    make_fdtd_engine,
)


# ============================================================
# sadosky_vibration 萨道夫斯基峰值振动速度
# ============================================================

class TestSadoskyVibration:
    """v = K · (Q^{1/3} / R)^{α}，K=200, α=1.5"""

    def test_basic_formula(self):
        """Q=1000kg, R=100m → v = 200 × (10/100)^1.5 = 200 × 0.03162 = 6.324"""
        v = sadosky_vibration(1000, 100)
        expected = 200 * (1000 ** (1/3) / 100) ** 1.5
        assert v == pytest.approx(expected, rel=1e-10)
        assert v == pytest.approx(6.3246, rel=1e-3)

    def test_near_zero_distance_returns_K(self):
        """距离 < 0.1m 时返回场地常数 K=200（避免奇点）"""
        assert sadosky_vibration(100, 0.05) == 200
        assert sadosky_vibration(100, 0.0) == 200

    def test_monotonic_decrease_with_distance(self):
        """同一药量下，PPV 随距离单调递减"""
        v1 = sadosky_vibration(200, 10)
        v2 = sadosky_vibration(200, 50)
        v3 = sadosky_vibration(200, 200)
        assert v1 > v2 > v3 > 0

    def test_scales_with_charge_cuberoot(self):
        """PPV ∝ Q^{α/3} = Q^{0.5}（α=1.5）：药量翻 4 倍 → PPV 翻 2 倍"""
        v1 = sadosky_vibration(100, 50)
        v2 = sadosky_vibration(400, 50)
        assert v2 / v1 == pytest.approx(2.0, rel=1e-10)

    def test_returns_positive(self):
        assert sadosky_vibration(1, 1) > 0


# ============================================================
# jwl_pressure JWL 状态方程
# ============================================================

class TestJwlPressure:

    def test_positive_pressure_at_v1(self):
        """V=1（初始爆生气状态）各炸药压力均为正"""
        for exp in ("emulsion", "anfo", "dynamite"):
            p = jwl_pressure(1.0, exp)
            assert p > 0, f"{exp} pressure should be positive, got {p}"

    def test_unknown_explosive_falls_back_to_emulsion(self):
        """未知炸药类型回退到 emulsion 参数"""
        p_known = jwl_pressure(1.0, "emulsion")
        p_unknown = jwl_pressure(1.0, "nonexistent")
        assert p_unknown == pytest.approx(p_known, rel=1e-10)

    def test_charge_kg_increases_pressure(self):
        """装药量缩放：E0 ∝ v_charge = kg/rho；需 kg > rho（>1m³装药）时 E0 项才放大

        emulsion 密度 1100 kg/m³，取 charge_kg=2200 → v_charge=2.0 → E0 翻倍
        仅 E0 项放大，前两项不变，故总压应高于基准
        """
        p_base = jwl_pressure(1.0, "emulsion")
        p_scaled = jwl_pressure(1.0, "emulsion", charge_kg=2200)
        assert p_scaled > p_base

    def test_charge_kg_linear_scaling(self):
        """E0 项线性于 v_charge：P(kg=2x) - P(kg=0) ≈ 2 × (P(kg=x) - P(kg=0))

        P = P_static + w·E0·v_charge/V，v_charge = kg/rho
        取 kg=2200（v_charge=2）和 kg=4400（v_charge=4），delta 应 2 倍
        """
        p0 = jwl_pressure(1.0, "emulsion", charge_kg=1e-6)  # 近似无缩放
        p2 = jwl_pressure(1.0, "emulsion", charge_kg=2200)  # v_charge=2
        p4 = jwl_pressure(1.0, "emulsion", charge_kg=4400)  # v_charge=4
        delta2 = p2 - p0
        delta4 = p4 - p0
        assert delta4 == pytest.approx(2 * delta2, rel=1e-6)

    def test_volume_clamping_no_nan(self):
        """极小相对体积不产生 NaN/Inf（V 被 clamp 到 0.01）

        JWL 在小 V（高压膨胀后期）可返回负值（拉应力相），仅验证有限性
        """
        p = jwl_pressure(0.001, "emulsion")
        assert np.isfinite(p)

    def test_pressure_decreases_with_volume(self):
        """JWL 等熵膨胀：压力随相对体积增大而单调下降"""
        p1 = jwl_pressure(1.0, "emulsion")
        p5 = jwl_pressure(5.0, "emulsion")
        p20 = jwl_pressure(20.0, "emulsion")
        assert p1 > p5 > p20 > 0


# ============================================================
# ppv_field_3d 3D 球面波 PPV 振动场
# ============================================================

class TestPpvField3d:

    def test_causality_zero_before_arrival(self):
        """t=0 时波前未到达任何采样点（r≥0.5m），PPV 全 0"""
        grid = np.array([[5, 0, 0], [10, 0, 0], [0, 5, 0]], dtype=np.float32)
        center = np.array([0, 0, 0], dtype=np.float32)
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=0.0)
        assert ppv.shape == (3,)
        assert np.all(ppv == 0)

    def test_nonzero_after_arrival(self):
        """t 足够大时波前已到达，PPV > 0"""
        grid = np.array([[5, 0, 0]], dtype=np.float32)
        center = np.array([0, 0, 0], dtype=np.float32)
        # r=5m, c_p=4500 → arrival≈1.1ms；t=0.1s 远超到达时间
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=0.1)
        assert ppv[0] > 0

    def test_unit_conversion_mps(self):
        """输出单位为 m/s（cm/s × 0.01）

        sadosky 返回 cm/s 级（K=200 量级），ppv_field_3d 末尾 ×0.01 → m/s
        """
        grid = np.array([[10, 0, 0]], dtype=np.float32)
        center = np.zeros(3, dtype=np.float32)
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=1.0)
        # 萨道夫斯基 cm/s: 200 × (100^{1/3}/10)^1.5 ≈ 200 × 4.642^1.5 ≈ 2000
        # 转换后 m/s ≈ 20
        assert ppv[0] < 100  # m/s 量级，远小于 cm/s
        # 验证与 sadosky 一致（含时间衰减）
        from app.services.blasting.blast_physics import sadosky_vibration
        sado = sadosky_vibration(100, 10)  # cm/s
        expected_mps = sado * 0.01 * np.exp(-0.02 * (1.0 - 10/4500))
        assert ppv[0] == pytest.approx(expected_mps, rel=1e-5)

    def test_geometric_attenuation(self):
        """同爆心同时间，远点 PPV < 近点 PPV"""
        grid = np.array([[5, 0, 0], [20, 0, 0]], dtype=np.float32)
        center = np.zeros(3, dtype=np.float32)
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=0.1)
        assert ppv[0] > ppv[1] > 0

    def test_blast_center_clamping(self):
        """爆心处采样点 r 被 clamp 到 0.5m，不产生 NaN"""
        grid = np.array([[0, 0, 0]], dtype=np.float32)
        center = np.zeros(3, dtype=np.float32)
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=0.01)
        assert np.all(np.isfinite(ppv))


# ============================================================
# stress_field_from_ppv 弹性球面波应力反演
# ============================================================

class TestStressFieldFromPpv:

    def test_sigma_rr_formula(self):
        """σ_rr = ρ · c_p · v_r"""
        ppv = np.array([0.01, 0.05, 0.1], dtype=np.float32)  # m/s
        rho, c_p, nu = 2650, 4500, 0.25
        result = stress_field_from_ppv(ppv, rho=rho, c_p=c_p, nu=nu)
        expected_rr = rho * c_p * ppv
        np.testing.assert_allclose(result['sigma_rr'], expected_rr, rtol=1e-5)

    def test_sigma_theta_formula(self):
        """σ_θθ = (ν/(1−ν)) · σ_rr；ν=0.25 → 系数 1/3"""
        ppv = np.array([0.1], dtype=np.float32)
        result = stress_field_from_ppv(ppv, nu=0.25)
        expected_theta = result['sigma_rr'] * (0.25 / 0.75)
        np.testing.assert_allclose(result['sigma_theta'], expected_theta, rtol=1e-5)

    def test_sigma_vm_formula(self):
        """σ_vm = |σ_rr − σ_θθ| = σ_rr · (1−2ν)/(1−ν)；ν=0.25 → 系数 2/3"""
        ppv = np.array([0.1], dtype=np.float32)
        result = stress_field_from_ppv(ppv, nu=0.25)
        expected_vm = result['sigma_rr'] * (1 - 2*0.25) / (1 - 0.25)
        np.testing.assert_allclose(result['sigma_vm'], expected_vm, rtol=1e-5)

    def test_principal_stress_assignment(self):
        """σ_1 = σ_rr（最大主应力），σ_3 = σ_θθ（最小主应力）"""
        ppv = np.array([0.1], dtype=np.float32)
        result = stress_field_from_ppv(ppv, nu=0.25)
        np.testing.assert_array_equal(result['sigma_1'], result['sigma_rr'])
        np.testing.assert_array_equal(result['sigma_3'], result['sigma_theta'])

    def test_zero_ppv_zero_stress(self):
        """PPV=0 → 所有应力分量为 0"""
        ppv = np.zeros(5, dtype=np.float32)
        result = stress_field_from_ppv(ppv)
        for key in ('sigma_rr', 'sigma_theta', 'sigma_vm', 'sigma_1', 'sigma_3'):
            assert np.all(result[key] == 0)

    def test_output_dtype_float32(self):
        ppv = np.array([0.1], dtype=np.float32)
        result = stress_field_from_ppv(ppv)
        for key in ('sigma_rr', 'sigma_theta', 'sigma_vm'):
            assert result[key].dtype == np.float32

    def test_stress_scales_with_ppv(self):
        """应力与 PPV 线性正比"""
        ppv1 = np.array([0.05], dtype=np.float32)
        ppv2 = np.array([0.10], dtype=np.float32)
        r1 = stress_field_from_ppv(ppv1)
        r2 = stress_field_from_ppv(ppv2)
        assert r2['sigma_rr'][0] / r1['sigma_rr'][0] == pytest.approx(2.0, rel=1e-5)
        assert r2['sigma_vm'][0] / r1['sigma_vm'][0] == pytest.approx(2.0, rel=1e-5)


# ============================================================
# damage_zone_classify Persson 损伤分区
# ============================================================

class TestDamageZoneClassify:

    def test_five_zones_represented(self):
        """构造覆盖 5 个分区的 PPV 值，验证输出 0~4"""
        # m/s 单位；阈值 5/15/30/50 cm/s → 0.05/0.15/0.30/0.50 m/s
        ppv = np.array([0.01, 0.08, 0.20, 0.40, 0.60], dtype=np.float32)
        zones = damage_zone_classify(ppv)
        assert zones.tolist() == [0, 1, 2, 3, 4]

    def test_boundary_at_threshold(self):
        """恰好等于阈值时归入上一级分区（np.digitize 左闭右开语义）"""
        # PPV=5cm/s=0.05m/s → zone 1 (≥5)
        # PPV=15cm/s=0.15m/s → zone 2
        # PPV=30cm/s=0.30m/s → zone 3
        # PPV=50cm/s=0.50m/s → zone 4
        ppv = np.array([0.05, 0.15, 0.30, 0.50], dtype=np.float32)
        zones = damage_zone_classify(ppv)
        assert zones.tolist() == [1, 2, 3, 4]

    def test_just_below_threshold(self):
        """阈值以下归入下一级"""
        ppv = np.array([0.049, 0.149, 0.299, 0.499], dtype=np.float32)
        zones = damage_zone_classify(ppv)
        assert zones.tolist() == [0, 1, 2, 3]

    def test_zero_ppv_is_elastic(self):
        ppv = np.zeros(3, dtype=np.float32)
        zones = damage_zone_classify(ppv)
        assert np.all(zones == 0)

    def test_very_high_ppv_is_throw(self):
        ppv = np.array([10.0], dtype=np.float32)  # 1000 cm/s
        zones = damage_zone_classify(ppv)
        assert zones[0] == 4

    def test_output_dtype_int8(self):
        ppv = np.array([0.1], dtype=np.float32)
        zones = damage_zone_classify(ppv)
        assert zones.dtype == np.int8

    def test_default_thresholds_match_persson(self):
        """默认阈值应为 Persson (5, 15, 30, 50) cm/s"""
        assert DAMAGE_THRESHOLDS_CMPS == (5.0, 15.0, 30.0, 50.0)

    def test_zone_labels_count(self):
        assert len(DAMAGE_ZONE_LABELS) == 5


# ============================================================
# wave_field_1d 一维波动场
# ============================================================

class TestWaveField1d:

    def test_causality_before_arrival(self):
        """t < r/c_p 时场值为 0（波前未到达）"""
        distances = np.array([10, 50, 100])
        # c_p=4500 → 100m 到达需 0.022s；t=0.001s 全未到达
        times = np.array([0.001])
        field = wave_field_1d(100, distances, times)
        assert field.shape == (1, 3)
        assert np.all(field == 0)

    def test_nonzero_after_arrival(self):
        """t > r/c_p 时场值 > 0"""
        distances = np.array([10])
        times = np.array([0.1])  # 10m 到达 0.0022s，0.1s 已到达
        field = wave_field_1d(100, distances, times)
        assert field[0, 0] > 0

    def test_peak_matches_sadosky_at_arrival(self):
        """t=arrival 时场值 ≈ sadosky 峰值（envelope≈1）"""
        r = 10.0
        c_p = 4500
        arrival = r / c_p
        distances = np.array([r])
        times = np.array([arrival])
        field = wave_field_1d(100, distances, times)
        expected = sadosky_vibration(100, r)
        assert field[0, 0] == pytest.approx(expected, rel=1e-5)

    def test_time_decay(self):
        """固定距离，场值随时间指数衰减"""
        distances = np.array([10])
        times = np.array([0.01, 0.05, 0.10])
        field = wave_field_1d(100, distances, times)
        assert field[0, 0] > field[1, 0] > field[2, 0] > 0


# ============================================================
# 二进制帧打包结构（帧格式正确性；前后端对称性见 P3-2）
# ============================================================

class TestBinaryPacking:
    """验证 pack_ppv/stress/damage_binary 帧头结构与载荷大小"""

    # 公共测试参数
    FRAME = 42
    T = 1.5
    GRID_SHAPE = (4, 5, 6)  # nx=4, ny=5, nz=6
    BOUNDS_MIN = np.array([-10, -5, 0], dtype=np.float32)
    BOUNDS_MAX = np.array([10, 15, 25], dtype=np.float32)
    N = 4 * 5 * 6  # 120 体素
    HEADER_SIZE = 45  # 1 + 4 + 4 + 12 + 24 = 45

    def _parse_header(self, data: bytes, expected_type_id: int):
        """解析 45 字节帧头，返回 (frame, t, nx, ny, nz, bounds_min, bounds_max)"""
        assert len(data) >= self.HEADER_SIZE
        type_id = struct.unpack('>B', data[0:1])[0]
        assert type_id == expected_type_id
        frame, t, nx, ny, nz = struct.unpack('>I f I I I', data[1:21])
        bmin = struct.unpack('>3f', data[21:33])
        bmax = struct.unpack('>3f', data[33:45])
        return frame, t, nx, ny, nz, bmin, bmax

    def test_pack_ppv_structure(self):
        ppv = np.random.rand(self.N).astype(np.float32)
        data = pack_ppv_binary(self.FRAME, self.T, self.GRID_SHAPE,
                               self.BOUNDS_MIN, self.BOUNDS_MAX, ppv)
        frame, t, nx, ny, nz, bmin, bmax = self._parse_header(data, 0x02)
        assert frame == self.FRAME
        assert t == pytest.approx(self.T, rel=1e-5)
        assert (nx, ny, nz) == self.GRID_SHAPE
        assert bmin == tuple(self.BOUNDS_MIN)
        assert bmax == tuple(self.BOUNDS_MAX)
        # 载荷：N × 4 字节（>f4 大端）
        body = data[self.HEADER_SIZE:]
        assert len(body) == self.N * 4

    def test_pack_stress_structure(self):
        sigma = np.random.rand(self.N).astype(np.float32)
        data = pack_stress_binary(self.FRAME, self.T, self.GRID_SHAPE,
                                  self.BOUNDS_MIN, self.BOUNDS_MAX, sigma)
        frame, t, nx, ny, nz, bmin, bmax = self._parse_header(data, 0x03)
        assert frame == self.FRAME
        assert (nx, ny, nz) == self.GRID_SHAPE
        body = data[self.HEADER_SIZE:]
        assert len(body) == self.N * 4  # float32

    def test_pack_damage_structure(self):
        zones = np.random.randint(0, 5, self.N).astype(np.int8)
        data = pack_damage_binary(self.FRAME, self.T, self.GRID_SHAPE,
                                  self.BOUNDS_MIN, self.BOUNDS_MAX, zones)
        frame, t, nx, ny, nz, bmin, bmax = self._parse_header(data, 0x04)
        assert frame == self.FRAME
        assert (nx, ny, nz) == self.GRID_SHAPE
        body = data[self.HEADER_SIZE:]
        assert len(body) == self.N * 1  # int8 = 1 字节

    def test_ppv_axis_transpose_webgl(self):
        """验证 PPV 帧载荷轴序为 WebGL x-最快（transpose 2,1,0）

        构造已知体素值，解包后验证 data[z*nx*ny + y*nx + x] == 原始值
        """
        nx, ny, nz = self.GRID_SHAPE
        # 构造 (nx, ny, nz) 体素，值 = x*100 + y*10 + z 便于定位
        ppv_3d = np.zeros((nx, ny, nz), dtype=np.float32)
        for ix in range(nx):
            for iy in range(ny):
                for iz in range(nz):
                    ppv_3d[ix, iy, iz] = ix * 100 + iy * 10 + iz
        ppv_flat = ppv_3d.ravel()  # x-最慢、z-最快（meshgrid ij 默认）

        data = pack_ppv_binary(self.FRAME, self.T, self.GRID_SHAPE,
                               self.BOUNDS_MIN, self.BOUNDS_MAX, ppv_flat)
        body = data[self.HEADER_SIZE:]
        # 解包大端 float32 数组
        decoded = np.frombuffer(body, dtype='>f4').astype(np.float32)
        # WebGL 轴序：data[z*nx*ny + y*nx + x]
        for iz in range(nz):
            for iy in range(ny):
                for ix in range(nx):
                    idx_webgl = iz * nx * ny + iy * nx + ix
                    assert decoded[idx_webgl] == pytest.approx(
                        ppv_3d[ix, iy, iz], abs=1e-3
                    ), f"mismatch at (x={ix},y={iy},z={iz})"


# ============================================================
# build_ppv_grid 网格构建
# ============================================================

class TestBuildPpvGrid:

    def test_grid_shape_and_bounds(self):
        grid_xyz, shape, bmin, bmax = build_ppv_grid(
            tunnel_width=18, tunnel_height=15, extent_forward=25, resolution=1.5
        )
        assert len(shape) == 3
        assert grid_xyz.shape == (shape[0] * shape[1] * shape[2], 3)
        # bounds 与参数一致
        assert bmin[0] == pytest.approx(-18 * 0.75)
        assert bmax[0] == pytest.approx(18 * 0.75)
        assert bmin[2] == 0
        assert bmax[2] == pytest.approx(25)

    def test_resolution_affects_shape(self):
        _, (nx1, ny1, nz1), _, _ = build_ppv_grid(resolution=2.0)
        _, (nx2, ny2, nz2), _, _ = build_ppv_grid(resolution=1.0)
        assert nx2 >= nx1 and ny2 >= ny1 and nz2 >= nz1


# ============================================================
# JWLBlastSource JWL 爆腔源（问题 8）
# ============================================================

class TestJWLBlastSource:
    """JWL 爆腔源：P0 = jwl_pressure(V=1)，R0 = (3V/4π)^(1/3)"""

    def test_cavity_radius_scales_with_charge_cuberoot(self):
        """R0 ∝ (kg/ρ)^(1/3)：8 倍药量 → 2 倍半径"""
        s1 = JWLBlastSource(100.0, 'emulsion')
        s2 = JWLBlastSource(800.0, 'emulsion')
        assert s2.cavity_radius / s1.cavity_radius == pytest.approx(2.0, rel=1e-6)

    def test_cavity_radius_positive(self):
        s = JWLBlastSource(50.0, 'anfo')
        assert s.cavity_radius > 0

    def test_peak_pressure_positive_all_explosives(self):
        for exp in ('emulsion', 'anfo', 'dynamite'):
            s = JWLBlastSource(100.0, exp)
            assert s.peak_pressure > 0, f"{exp} peak pressure should be positive"

    def test_peak_pressure_independent_of_charge(self):
        """P0 = jwl_pressure(V=1, kg=None) 仅依赖炸药类型，与装药量无关"""
        s1 = JWLBlastSource(50.0, 'emulsion')
        s2 = JWLBlastSource(500.0, 'emulsion')
        assert s1.peak_pressure == pytest.approx(s2.peak_pressure, rel=1e-10)

    def test_pressure_decay_exponential(self):
        """P(t) = P0·exp(-t/τ)；t=τ 时 P = P0/e"""
        s = JWLBlastSource(100.0, 'emulsion')
        p0 = s.pressure_at(0.0)
        tau = s.characteristic_time()
        p_tau = s.pressure_at(tau)
        assert p_tau / p0 == pytest.approx(np.exp(-1.0), rel=1e-5)

    def test_pressure_monotonic_decrease(self):
        s = JWLBlastSource(100.0, 'emulsion')
        p0 = s.pressure_at(0.0)
        p1 = s.pressure_at(1e-4)
        p2 = s.pressure_at(1e-3)
        assert p0 > p1 > p2 > 0

    def test_pressure_zero_before_detonation(self):
        s = JWLBlastSource(100.0, 'emulsion')
        assert s.pressure_at(-1.0) == 0.0

    def test_invalid_charge_raises(self):
        with pytest.raises(ValueError):
            JWLBlastSource(0.0, 'emulsion')
        with pytest.raises(ValueError):
            JWLBlastSource(-10.0, 'emulsion')

    def test_explosive_density_affects_cavity(self):
        """同药量下，密度小的炸药（ANFO 800）爆腔更大"""
        s_emul = JWLBlastSource(100.0, 'emulsion')   # ρ=1100
        s_anfo = JWLBlastSource(100.0, 'anfo')        # ρ=800
        assert s_anfo.cavity_radius > s_emul.cavity_radius


# ============================================================
# ElasticWaveFDTD3D 3D 弹性波 FDTD（问题 8）
# ============================================================

class TestElasticWaveFDTD3D:
    """3D 速度-应力 FDTD：JWL 爆腔源 + 弹性波传播"""

    @staticmethod
    def _make_engine(charge_kg=100.0, explosive='emulsion', resolution=2.5):
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, resolution)
        return make_fdtd_engine(grid_xyz, gs, bmin, bmax, charge_kg, explosive)

    def test_cfl_stability_condition(self):
        """dt < h / (c_p · √3)，且取 0.9 安全系数"""
        eng = self._make_engine()
        cfl_max = eng.h / (eng.cp * np.sqrt(3.0))
        assert eng.dt < cfl_max
        assert eng.dt == pytest.approx(0.9 * cfl_max, rel=1e-6)

    def test_initial_ppv_zero(self):
        """爆前（未 step）PPV 全 0"""
        eng = self._make_engine()
        ppv = eng.get_ppv()
        assert np.all(ppv == 0)

    def test_step_produces_nonzero_wave(self):
        """step 后波场非零"""
        eng = self._make_engine()
        eng.step(50)
        ppv = eng.get_ppv()
        assert np.any(ppv > 0)
        assert np.all(np.isfinite(ppv))

    def test_no_nan_after_long_simulation(self):
        """较长模拟不产生 NaN（数值稳定性）"""
        eng = self._make_engine()
        eng.step(200)
        ppv = eng.get_ppv()
        assert np.all(np.isfinite(ppv))

    def test_ppv_decreases_with_distance(self):
        """几何衰减：近场峰值 PPV > 远场峰值 PPV（球面波能量扩散）

        逐帧记录各点峰值 PPV，避免瞬时快照因波前已过近场而误判
        （波传播是时变的，单时刻比较无物理意义）。
        """
        eng = self._make_engine()
        grid_xyz, gs, _, _ = build_ppv_grid(18, 15, 25, 2.5)
        r = np.linalg.norm(grid_xyz, axis=1)  # 爆心在原点
        peak_ppv = np.zeros(r.shape, dtype=np.float32)
        for _ in range(250):
            eng.step(1)
            ppv = eng.get_ppv().ravel()
            np.maximum(peak_ppv, ppv, out=peak_ppv)
        # 分近场（r<5m）和远场（r>15m），比较峰值 PPV 的均值
        near_mask = (r < 5.0) & (peak_ppv > 1e-9)
        far_mask = (r > 15.0) & (peak_ppv > 1e-9)
        if near_mask.any() and far_mask.any():
            assert peak_ppv[near_mask].mean() > peak_ppv[far_mask].mean()

    def test_sim_time_advances(self):
        """step 后 sim_time 按 n_substeps·dt 推进"""
        eng = self._make_engine()
        assert eng.sim_time == 0.0
        eng.step(100)
        assert eng.sim_time == pytest.approx(100 * eng.dt, rel=1e-6)

    def test_different_explosives_different_wave(self):
        """不同炸药类型（P0 不同）产出不同波场"""
        eng_emul = self._make_engine(100.0, 'emulsion')
        eng_anfo = self._make_engine(100.0, 'anfo')
        eng_emul.step(50)
        eng_anfo.step(50)
        # emulsion 的 P0（7.7GPa）高于 anfo，波场应有差异
        ppv_emul = eng_emul.get_ppv()
        ppv_anfo = eng_anfo.get_ppv()
        assert not np.allclose(ppv_emul, ppv_anfo, atol=1e-9)

    def test_velocity_fields_shape(self):
        """三向速度场形状与网格一致"""
        eng = self._make_engine()
        vx, vy, vz = eng.get_velocity()
        assert vx.shape == eng.grid_shape
        assert vy.shape == eng.grid_shape
        assert vz.shape == eng.grid_shape

    def test_cavity_mask_nonempty(self):
        """爆腔掩膜至少覆盖一个网格点"""
        eng = self._make_engine()
        assert eng.cavity_mask.sum() >= 1

    def test_pml_damping_at_boundary(self):
        """PML 阻尼层在边界处 < 1，内部 = 1"""
        eng = self._make_engine()
        damp = eng.damp
        # 内部点（远离边界）应为 1.0
        nx, ny, nz = eng.grid_shape
        interior = damp[nx // 2, ny // 2, nz // 2]
        assert interior == 1.0
        # 边界角点应 < 1.0
        assert damp[0, 0, 0] < 1.0


# ============================================================
# make_fdtd_engine 工厂函数（问题 8）
# ============================================================

class TestMakeFdtdEngine:

    def test_returns_fdtd_instance(self):
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 2.5)
        eng = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 100.0, 'emulsion')
        assert isinstance(eng, ElasticWaveFDTD3D)
        assert eng.grid_shape == gs

    def test_custom_rock_params(self):
        """自定义岩体参数影响波速与 dt"""
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 2.5)
        rock_hard = RockMedium(density=3000, p_wave_speed=5500, s_wave_speed=3200)
        eng = ElasticWaveFDTD3D(grid_xyz, bmin, bmax, gs,
                                JWLBlastSource(100.0, 'emulsion'), rock_hard)
        # 更高波速 → 更小 dt（CFL）
        eng_soft = self._default_engine()
        assert eng.dt < eng_soft.dt

    @staticmethod
    def _default_engine():
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 2.5)
        return make_fdtd_engine(grid_xyz, gs, bmin, bmax, 100.0, 'emulsion')
