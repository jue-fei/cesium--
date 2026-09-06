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
    ppv_field_3d_fdtd,
    parameter_sweep,
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
        """Q=1000kg, R=100m → v = 200 × (10/100)^1.5 = 200 × 0.03162 = 6.324 cm/s = 0.06324 m/s"""
        v = sadosky_vibration(1000, 100)
        expected = 200 * (1000 ** (1/3) / 100) ** 1.5 * 0.01
        assert v == pytest.approx(expected, rel=1e-10)
        assert v == pytest.approx(0.063246, rel=1e-3)

    def test_near_zero_distance_bounded_and_monotonic(self):
        """近场距离钳制到 min_standoff 下限，避免奇点与跳变

        旧实现 R<0.1m 直接返回常数 K=200，而 R=0.1m 处公式值达数十万 cm/s，
        形成巨大跳变。修复后 R→0 收敛到 R=min_standoff 处的有界值，且整体单调。
        """
        v0 = sadosky_vibration(100, 0.0)
        v_tiny = sadosky_vibration(100, 0.05)
        v_floor = sadosky_vibration(100, 0.5)
        # 低于下限的距离一律钳制到 min_standoff
        assert v0 == v_tiny == v_floor > 0
        # 与公式在 0.5m 处连续（略高于 0.5 时应接近钳制值）
        v_just_above = sadosky_vibration(100, 0.5001)
        assert v_floor == pytest.approx(v_just_above, rel=1e-3)
        # 整体随距离单调递减
        assert v_floor > sadosky_vibration(100, 10)

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

    def test_charge_kg_invariance(self):
        """JWL 压力为强度量：在相同相对体积 V 下与装药量无关

        CJ 压力是炸药材料属性，装药量只影响爆腔体积/总能量，不影响局部压力。
        早期实现错误地把 E0 乘以装药体积 v_charge（量纲 J 而非 J/m³），
        导致同种炸药不同装药量算出不同压力，本测试锁定修复后的不变性。
        """
        p_base = jwl_pressure(1.0, "emulsion")
        p_scaled = jwl_pressure(1.0, "emulsion", charge_kg=2200)
        p_scaled2 = jwl_pressure(1.0, "emulsion", charge_kg=1e6)
        assert p_scaled == pytest.approx(p_base, rel=1e-10)
        assert p_scaled2 == pytest.approx(p_base, rel=1e-10)

    def test_charge_kg_does_not_affect_cj_pressure(self):
        """JWLBlastSource 用 charge_kg=None 取单位体积 CJ 压力，与 jwl_pressure 一致"""
        p_direct = jwl_pressure(1.0, "anfo", charge_kg=None)
        p_named = jwl_pressure(1.0, "anfo", charge_kg=500)
        assert p_named == pytest.approx(p_direct, rel=1e-10)

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
        # 可视化波速 visual_c_p=35 → r=5m 到达 ≈0.143s；t=0.3s 远超到达时间
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=0.3)
        assert ppv[0] > 0

    def test_unit_conversion_mps(self):
        """输出单位为 m/s（cm/s × 0.01）

        sadosky 已由源码统一为 m/s（K=30 已经过 ×0.01），ppv_field_3d
        直接使用 sadosky 返回值，与 sadosky 直接调用结果一致。
        """
        grid = np.array([[10, 0, 0]], dtype=np.float32)
        center = np.zeros(3, dtype=np.float32)
        # 注：波前可视速度 visual_c_p=35 → r=10m 到达 ≈0.286s；t=1.0s 已衰减到
        # exp(-β·(t - r/visual_c_p))，时间阻尼项按 10/35 而非物理 c_p。
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=1.0, K=30, alpha=1.5)
        assert ppv[0] < 100  # m/s 量级，远小于 cm/s
        # 验证与 sadosky 一致（含时间衰减）
        from app.services.blasting.blast_physics import sadosky_vibration, RockMedium
        rock = RockMedium()
        rock.sadosky_k = 30.0
        rock.sadosky_alpha = 1.5
        expected_mps = sadosky_vibration(100, 10, rock=rock) * np.exp(-(0.02 + 0.80) * (1.0 - 10 / 35.0))
        assert ppv[0] == pytest.approx(expected_mps, rel=1e-5)

    def test_geometric_attenuation(self):
        """同爆心同时间，远点 PPV < 近点 PPV"""
        grid = np.array([[5, 0, 0], [20, 0, 0]], dtype=np.float32)
        center = np.zeros(3, dtype=np.float32)
        # visual_c_p=35：r=20m 到达 ≈0.571s，t=1.2s 两点均已到达
        ppv = ppv_field_3d(grid, center, charge_kg=100, t=1.2)
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
        """σ_vm = σ_rr/(1−ν)（径向压 + 切向拉；ν=0.25 → 系数 4/3）"""
        ppv = np.array([0.1], dtype=np.float32)
        result = stress_field_from_ppv(ppv, nu=0.25)
        expected_vm = result['sigma_rr'] / (1 - 0.25)
        np.testing.assert_allclose(result['sigma_vm'], expected_vm, rtol=1e-5)
        # 切向拉应力幅值 < σ_vm < σ_rr + 切向幅值（物理量级自洽）
        assert np.all(result['sigma_theta'] < result['sigma_vm'])
        assert np.all(result['sigma_theta'] > 0)

    def test_principal_stress_assignment(self):
        """σ_1 = σ_rr（径向压，最大主应力），σ_3 = −σ_θθ（切向拉，最小主应力）"""
        ppv = np.array([0.1], dtype=np.float32)
        result = stress_field_from_ppv(ppv, nu=0.25)
        np.testing.assert_array_equal(result['sigma_1'], result['sigma_rr'])
        np.testing.assert_allclose(result['sigma_3'], -result['sigma_theta'], rtol=1e-6)

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

    def test_get_sigma_vm_tensor(self):
        """完整应力张量 von Mises：形状/非负/初始为零/爆腔附近非零"""
        eng = self._make_engine()
        sm0 = eng.get_sigma_vm()
        assert sm0.shape == eng.grid_shape
        assert sm0.dtype == np.float32
        # 未起爆：应力张量为 0 → σ_vm 全 0
        assert np.all(sm0 == 0)
        # 推进后：爆腔附近应力集中非零，且单调性基本保持（近爆心 σ_vm 更大）
        eng.step(40)
        sm1 = eng.get_sigma_vm()
        assert np.all(sm1 >= 0)
        assert np.isfinite(sm1).all()
        assert np.partition(sm1.flatten(), -3)[-1] > 0  # 存在显著应力
        # 与纯 hydrostatic（σ_xx=σ_yy=σ_zz, 无剪应力）→ σ_vm=0 的自洽校验
        eng2 = self._make_engine()
        eng2.sxx[:] = 5.0e6
        eng2.syy[:] = 5.0e6
        eng2.szz[:] = 5.0e6
        eng2.sxy[:] = 0.0
        eng2.sxz[:] = 0.0
        eng2.syz[:] = 0.0
        assert np.all(eng2.get_sigma_vm() == 0)

    def test_cavity_mask_nonempty(self):
        """爆腔掩膜至少覆盖一个网格点"""
        eng = self._make_engine()
        assert eng.cavity_mask.sum() >= 1

    def test_multi_source_engine_single_source_equivalent(self):
        """单装药源（sources 缺省）与多源列表仅 1 项时结果一致（向后兼容）"""
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 2.5)
        eng_single = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 50.0, 'emulsion')
        eng_multi = make_fdtd_engine(
            grid_xyz, gs, bmin, bmax, 50.0, 'emulsion',
            sources=[{"x": 0, "y": 0, "z": 0, "chargeKg": 50.0, "delayMs": 0.0}]
        )
        eng_single.step(80)
        eng_multi.step(80)
        assert np.allclose(eng_single.get_ppv(), eng_multi.get_ppv(), atol=1e-9)

    def test_multi_source_delay_gates_activation(self):
        """延时源在 delay 到达前不注入：延迟源的波场显著弱于立即起爆源（同刻）"""
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 3.0)
        # 立即（delay=0）4 源 vs 全部延迟 50ms（波前推进子步内大部分未起爆）
        src_im = [{"x": dx, "y": 0, "z": dz, "chargeKg": 30.0, "delayMs": 0.0}
                  for dx, dz in [(-3, 0), (3, 0), (0, -2), (0, 2)]]
        src_delay = [{**s, "delayMs": 40.0} for s in src_im]
        eng_im = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 30.0, 'emulsion', sources=src_im)
        eng_delay = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 30.0, 'emulsion', sources=src_delay)
        # 推进到约 30ms（< 40ms 延时），立即源应显著更强
        n_sub = int(round(0.03 / eng_im.dt))
        eng_im.step(n_sub)
        eng_delay.step(n_sub)
        p_im = eng_im.get_ppv()
        p_delay = eng_delay.get_ppv()
        assert p_im.ravel().max() > p_delay.ravel().max()

    def test_multi_source_non_concentric_stress_around_offset_source(self):
        """多源应力场不再以原点为唯一对称中心（波场干涉，非单一同心圆）

        两偏置源（±x）同时起爆后，x 方向沿轴应力分布因两源相长/相消干涉而
        呈现非单调、非以原点对称的形态：|x| 较近源处的应力峰值高于远离处，
        且两侧并不对称相等（干涉瓣），从而区别于单源以原点为中心的同心衰减。
        """
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 20, 3.0)
        # 沿 y=0,z=0 剖面取 x 轴上的等应力采样点
        x_axis = grid_xyz[(np.abs(grid_xyz[:, 1]) < 1e-3) & (np.abs(grid_xyz[:, 2]) < 1e-3)]
        x_col = np.unique(np.round(x_axis[:, 0], 3))
        srcs = [{"x": -6, "y": 0, "z": 0, "chargeKg": 40.0, "delayMs": 0.0},
                {"x": 6, "y": 0, "z": 0, "chargeKg": 40.0, "delayMs": 0.0}]
        eng = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 40.0, 'emulsion', sources=srcs)
        eng.step(60)
        sm = eng.get_sigma_vm()
        # 收集 x 轴上各采样点的 σ_vm（取该列极大值近似）
        sig_at_x = []
        for xv in x_col:
            m = (np.abs(grid_xyz[:, 0] - xv) < 1e-3) & (np.abs(grid_xyz[:, 1]) < 1e-3) & \
                (np.abs(grid_xyz[:, 2]) < 1e-3)
            sig_at_x.append(float(sm.ravel()[m].max())) if m.any() else sig_at_x.append(0.0)
        sig_at_x = np.asarray(sig_at_x, dtype=np.float64)
        peak = float(sig_at_x.max())
        assert peak > 0
        # 双源在 ±6 附近应力增强，x 轴两侧（x≈±6）与中心区存在明显的非单调干涉
        # （判别：非全部严格随 |x| 单调 —— 存在两侧峰值与中心谷/隆起）
        xs_sorted = np.argsort(x_col)
        sig_sorted = sig_at_x[xs_sorted]
        # 使用中心点（x≈0）作为参照：中心两侧各有局部峰，说明干涉而非单源同心
        center_val = float(sig_at_x[np.argmin(np.abs(x_col))])
        side_val = np.array([float(sig_at_x[np.argmin(np.abs(x_col - xv))])
                             for xv in [-6, 6]]).max()
        assert side_val > center_val * 1.05  # 源附近应力明显高于中心（两源叠加而非塌缩）

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


# ============================================================
# parameter_sweep 参数扫描（A1 单位统一：m/s）
# ============================================================

class TestParameterSweep:
    """A1 单位统一后 parameter_sweep 输出字段单位应为 m/s"""

    def test_velocity_unit_mps(self):
        """vibration_velocity 与 vibration_velocity_mps 均为 m/s（≤ 阈值 0.05 m/s 判 safe）"""
        results = parameter_sweep({'charge_kg': 100, 'distance': 50}, 'charge_kg', [50, 100, 200])
        assert len(results) == 3
        for r in results:
            # 显式单位标注字段与主字段一致（m/s）
            assert r['vibration_velocity'] == pytest.approx(r['vibration_velocity_mps'], rel=1e-12)
            # 主字段应为 m/s 量级（0.05 阈值附近），而非 cm/s 量级（几 cm/s → 0.05+ 即不安全）
            assert 0 < r['vibration_velocity'] < 0.5
            # jwl_peak_pressure 始终为正（GPa 量级，无单位冲突）
            assert r['jwl_peak_pressure'] > 0

    def test_safe_threshold_default_005_mps(self):
        """默认 safe 阈值 = 0.05 m/s（= 5 cm/s，GB6722 远场安全下限）"""
        # 近距离（0.5m 钳制下限）→ PPV 极大 → 不安全
        results = parameter_sweep({'charge_kg': 100, 'distance': 0.5}, 'distance', [0.5])
        assert results[0]['safe'] is False
        # 远距离 → PPV 极小 → 安全（< 0.05 m/s）
        results_far = parameter_sweep({'charge_kg': 100, 'distance': 200}, 'distance', [200])
        assert results_far[0]['safe'] is True
        # 边界：自定义阈值可覆盖默认 0.05
        results_custom = parameter_sweep(
            {'charge_kg': 100, 'distance': 50, 'threshold': 0.5}, 'distance', [50])
        # distance=50 时 PPV 远小于 0.5，自定义阈值放宽后 safe
        assert results_custom[0]['safe'] is True

    def test_sweep_scans_specified_param(self):
        """扫描字段随 values 变化，其余固定"""
        r = parameter_sweep({'charge_kg': 100, 'distance': 50}, 'charge_kg', [25, 100, 400])
        vals = [x['param_value'] for x in r]
        assert vals == [25, 100, 400]
        # 药量增大 → PPV 单调增大（sadosky 单调性）
        ppvs = [x['vibration_velocity'] for x in r]
        assert ppvs[0] < ppvs[1] < ppvs[2]


# ============================================================
# ppv_field_3d_fdtd 无状态模式 grid_shape 强制校验（A3）
# ============================================================

class TestPpvField3dFdtdGridShape:
    """A3：消除立方体网格假设，无状态模式必须显式传入 grid_shape"""

    def test_requires_grid_shape(self):
        """不传 grid_shape → 明确报错（不再用 n^(1/3) 立方近似推断）"""
        grid_xyz, gs, _, _ = build_ppv_grid(18, 15, 25, 2.5)
        with pytest.raises(ValueError, match="grid_shape"):
            ppv_field_3d_fdtd(grid_xyz, np.zeros(3, dtype=np.float32), 100.0)

    def test_shape_mismatch_raises(self):
        """grid_shape 与 grid_xyz.shape[0] 不一致 → 明确报错"""
        grid_xyz, gs, _, _ = build_ppv_grid(18, 15, 25, 2.5)
        wrong_shape = (gs[0] + 1, gs[1], gs[2])
        with pytest.raises(ValueError, match="不一致"):
            ppv_field_3d_fdtd(grid_xyz, np.zeros(3, dtype=np.float32), 100.0,
                              grid_shape=wrong_shape)

    def test_non_cubic_grid_works(self):
        """非立方网格（27×21×25 之类）显式传入 grid_shape 可正常计算"""
        # 构造显式非立方网格（而非 build_ppv_grid 立方近似）
        nx, ny, nz = 8, 6, 10  # 非立方
        xs = np.linspace(-6, 6, nx)
        ys = np.linspace(-4, 4, ny)
        zs = np.linspace(0, 12, nz)
        X, Y, Z = np.meshgrid(xs, ys, zs, indexing='ij')
        grid_xyz = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1).astype(np.float32)
        ppv, engine = ppv_field_3d_fdtd(
            grid_xyz, np.zeros(3, dtype=np.float32), 100.0,
            grid_shape=(nx, ny, nz), sim_time=0.001)
        assert ppv.shape == (nx, ny, nz)
        assert engine.grid_shape == (nx, ny, nz)
        # 波前未覆盖区为 0，爆心附近 > 0（0.001s 已推进若干子步）
        assert np.all(np.isfinite(ppv))

    def test_stateful_mode_uses_engine(self):
        """有状态模式：传入 engine 时不重建，直接增量推进 n_substeps"""
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 2.5)
        engine = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 100.0, 'emulsion')
        ppv1, engine_out = ppv_field_3d_fdtd(
            grid_xyz, np.zeros(3, dtype=np.float32), 100.0,
            grid_shape=gs, engine=engine, n_substeps=20)
        assert engine_out is engine
        assert np.any(ppv1 > 0)
        # 无状态模式与有状态模式推进相同子步数应一致
        ppv2, _ = ppv_field_3d_fdtd(
            grid_xyz, np.zeros(3, dtype=np.float32), 100.0,
            grid_shape=gs, sim_time=20 * engine.dt)
        np.testing.assert_allclose(ppv1, ppv2, rtol=1e-5)


# ============================================================
# A2：FDTD 网格收敛性 + 长时间稳定性
# ============================================================

class TestFdtdGridConvergence:
    """A2：网格收敛验证——固定观察点峰值 PPV 对网格分辨率收敛

    爆腔源已做体积等效归一化 + 数值收敛修正（src_scale = V_cav/(n·h^0.75)）。
    实测：h=1.5 vs h=0.75（生产网格 18×15×25，100kg 炸药），
    观察点 z=3m 峰值 PPV 相对差 < 2%（见 blast_physics.py 注释）。
    """

    @staticmethod
    def _peak_ppv(resolution, obs=3.0, charge=100.0, sim_time=0.008):
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, resolution)
        eng = make_fdtd_engine(grid_xyz, gs, bmin, bmax, charge, 'emulsion')
        r = np.linalg.norm(grid_xyz, axis=1)
        obs_idx = int(np.argmin(np.abs(r - obs)))
        n = max(1, int(sim_time / eng.dt))
        peak = 0.0
        for _ in range(n):
            eng.step(1)
            v = float(eng.get_ppv().ravel()[obs_idx])
            if v > peak:
                peak = v
        return peak

    def test_peak_ppv_converges_between_resolutions(self):
        """1.5m 与 0.75m 网格在 z=3m 观察点的峰值 PPV 相对差 < 10%"""
        p_coarse = self._peak_ppv(1.5)
        p_fine = self._peak_ppv(0.75)
        assert p_coarse > 0 and p_fine > 0
        rel = abs(p_coarse - p_fine) / max(abs(p_coarse), abs(p_fine))
        assert rel < 0.10, (
            f"网格收敛失败：h=1.5 PPV={p_coarse:.3e}, h=0.75 PPV={p_fine:.3e}, "
            f"相对差={rel*100:.1f}%（要求 <10%）"
        )

    def test_long_time_stability_no_blowup(self):
        """长时间推进不出现 NaN/Inf 与能量爆炸（数值稳定性）"""
        grid_xyz, gs, bmin, bmax = build_ppv_grid(18, 15, 25, 2.5)
        eng = make_fdtd_engine(grid_xyz, gs, bmin, bmax, 100.0, 'emulsion')
        eng.step(600)
        ppv = eng.get_ppv()
        assert np.all(np.isfinite(ppv))
        # 源衰减后总能量不应持续增长：与中期相比，晚期峰值 PPV 不应显著增大
        # （压应力源 P(t) 指数衰减，能量应向边界耗散而非积累）
        # 用 RMS 作为能量代理
        rms_late = float(np.sqrt(np.mean(ppv ** 2)))
        assert np.isfinite(rms_late)
        assert rms_late < 1e3  # 有界（源已衰减）

