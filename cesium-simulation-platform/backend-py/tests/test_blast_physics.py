"""爆破物理引擎单元测试

覆盖函数：
- jwl_pressure: JWL 状态方程
- sadosky_vibration: 萨道夫斯基振动公式
- damage_zone_radii: 损伤区半径计算
- wave_field_2d: 二维 PPV 波场
- jwl_isentrope: JWL 等熵膨胀线
"""
import math
import numpy as np
import pytest

from app.services.blasting.blast_physics import (
    jwl_pressure,
    sadosky_vibration,
    damage_zone_radii,
    wave_field_2d,
    jwl_isentrope,
    RockMedium,
    BlastSource,
)
from app.services.blasting.constants import (
    SADOSKY_K_DEFAULT,
    SADOSKY_ALPHA_DEFAULT,
    SADOSKY_R_MIN,
    SIGMA_CD_FACTOR,
    SIGMA_TD_FACTOR,
    DAMAGE_BETA,
)


# ============================================================
# JWL 状态方程
# ============================================================

class TestJWLPressure:

    def test_tiny_volume_clamped(self):
        """极小体积应被钳制（V>=0.01），无 NaN/Infinity"""
        p = jwl_pressure(0.001, "emulsion")
        assert not math.isnan(p)
        assert not math.isinf(p)
        assert isinstance(p, float)

    def test_tiny_volume_same_as_clamped_value(self):
        """V=0.001 与 V=0.01 返回相同值（内部钳制到 0.01）"""
        p1 = jwl_pressure(0.001, "emulsion")
        p2 = jwl_pressure(0.01, "emulsion")
        assert abs(p1 - p2) < 1e-3

    def test_initial_volume_positive(self):
        """V=1.0 返回 GPa 级正压力"""
        p = jwl_pressure(1.0, "emulsion")
        assert p > 1e9  # > 1 GPa

    def test_pressure_decreases_with_expansion(self):
        """膨胀（V 增大）压力下降"""
        p1 = jwl_pressure(1.0, "emulsion")
        p10 = jwl_pressure(10.0, "emulsion")
        p100 = jwl_pressure(100.0, "emulsion")
        assert p1 > p10 > p100

    def test_three_explosives_differ(self):
        """三种炸药返回不同压力"""
        p_emul = jwl_pressure(1.0, "emulsion")
        p_anfo = jwl_pressure(1.0, "anfo")
        p_dyna = jwl_pressure(1.0, "dynamite")
        assert len({p_emul, p_anfo, p_dyna}) == 3

    def test_unknown_explosive_falls_back_to_emulsion(self):
        """未知炸药类型回退到 emulsion（JWL_PARAMS.get 默认值）"""
        p_unknown = jwl_pressure(1.0, "nonexistent_explosive")
        p_emul = jwl_pressure(1.0, "emulsion")
        assert p_unknown == p_emul

    def test_default_explosive_is_emulsion(self):
        """默认炸药类型为 emulsion"""
        p_default = jwl_pressure(1.0)
        p_emul = jwl_pressure(1.0, "emulsion")
        assert p_default == p_emul


# ============================================================
# 萨道夫斯基振动
# ============================================================

class TestSadoskyVibration:

    def test_default_k_alpha(self, sample_rock):
        """默认 K=200, alpha=1.5 与历史值一致"""
        ppv = sadosky_vibration(100, 50, sample_rock)
        expected = SADOSKY_K_DEFAULT * (100 ** (1 / 3) / 50) ** SADOSKY_ALPHA_DEFAULT
        assert abs(ppv - expected) < 1e-6

    def test_r_min_clamp(self, sample_rock):
        """距离 < R_MIN 时钳制到 R_MIN=0.5"""
        ppv_below = sadosky_vibration(100, 0.1, sample_rock)
        ppv_at_min = sadosky_vibration(100, SADOSKY_R_MIN, sample_rock)
        assert abs(ppv_below - ppv_at_min) < 1e-6

    def test_ppv_decreases_with_distance(self, sample_rock):
        """PPV 随距离衰减"""
        ppv_10 = sadosky_vibration(100, 10, sample_rock)
        ppv_100 = sadosky_vibration(100, 100, sample_rock)
        assert ppv_10 > ppv_100

    def test_q_zero_returns_zero(self, sample_rock):
        """Q=0 → PPV=0"""
        ppv = sadosky_vibration(0, 50, sample_rock)
        assert ppv == 0.0

    def test_custom_k_alpha(self):
        """自定义 K=150, alpha=1.8"""
        rock = RockMedium(site_K=150, site_alpha=1.8)
        ppv = sadosky_vibration(100, 50, rock)
        expected = 150 * (100 ** (1 / 3) / 50) ** 1.8
        assert abs(ppv - expected) < 1e-6

    def test_ppv_positive_for_normal_input(self, sample_rock):
        """正常输入 PPV > 0"""
        ppv = sadosky_vibration(100, 50, sample_rock)
        assert ppv > 0

    def test_granite_rock_uses_custom_params(self, granite_rock):
        """granite_rock 夹具使用默认 K/alpha（未自定义）"""
        ppv = sadosky_vibration(100, 50, granite_rock)
        expected = SADOSKY_K_DEFAULT * (100 ** (1 / 3) / 50) ** SADOSKY_ALPHA_DEFAULT
        assert abs(ppv - expected) < 1e-6


# ============================================================
# 损伤区半径
# ============================================================

class TestDamageZoneRadii:

    @staticmethod
    def _typical_params():
        """100kg 乳化炸药 + 120MPa 花岗岩的典型参数

        对应路由 /damage-zones 中的计算：
          r_charge = (3*Q / (4*pi*density))^(1/3)
          p_det = density * VoD^2 / 4
        """
        charge_kg = 100
        explosive_density = 1200
        VoD = 4500
        r_charge = (3 * charge_kg / (4 * np.pi * explosive_density)) ** (1 / 3)
        p_det = explosive_density * VoD ** 2 / 4
        return r_charge, 120e6, 10e6, p_det

    def test_elastic_radius_is_none(self):
        """验证 Task 3 修复：elastic_radius 为 None"""
        r_charge, ucs, tensile, p_det = self._typical_params()
        zones = damage_zone_radii(r_charge, ucs, tensile, p_det)
        assert zones["elastic_radius"] is None

    def test_crushed_less_than_fractured(self):
        """粉碎区 < 裂隙区"""
        r_charge, ucs, tensile, p_det = self._typical_params()
        zones = damage_zone_radii(r_charge, ucs, tensile, p_det)
        assert zones["crushed_radius"] < zones["fractured_radius"]

    def test_typical_values_order_of_magnitude(self):
        """典型值数量级：粉碎区 ~1m, 裂隙区 ~数米"""
        r_charge, ucs, tensile, p_det = self._typical_params()
        zones = damage_zone_radii(r_charge, ucs, tensile, p_det)
        # 数量级检查（不依赖精确值）
        assert 0.1 < zones["crushed_radius"] < 10.0
        assert 0.5 < zones["fractured_radius"] < 50.0

    def test_return_keys(self):
        """返回 dict 包含三个键"""
        r_charge, ucs, tensile, p_det = self._typical_params()
        zones = damage_zone_radii(r_charge, ucs, tensile, p_det)
        assert set(zones.keys()) == {"crushed_radius", "fractured_radius", "elastic_radius"}

    def test_small_ucs_large_damage_zone(self):
        """较小 UCS → 损伤区大于典型值（弱岩体）

        UCS=20MPa < 典型 120MPa，sigma_cd=36MPa < sigma_td=15MPa*... 不，
        sigma_cd = 20e6*1.8 = 36e6, sigma_td = 10e6*1.5 = 15e6 → 比值 > 1，fractured > crushed
        """
        zones = damage_zone_radii(0.27, 20e6, 10e6, 6e9)
        assert zones["crushed_radius"] > 1.0  # 弱岩体粉碎区较大
        assert zones["fractured_radius"] > zones["crushed_radius"]

    def test_ucs_zero_raises_value_error(self):
        """UCS=0 应抛 ValueError（边界防御）

        sigma_cd = ucs * 1.8 = 0，p_det / 0 会触发 ZeroDivisionError，
        故入口处显式校验 rock_ucs > 0。
        """
        with pytest.raises(ValueError):
            damage_zone_radii(0.27, 0.0, 10e6, 6e9)

    def test_ucs_negative_raises_value_error(self):
        """UCS<0 应抛 ValueError（边界防御）"""
        with pytest.raises(ValueError):
            damage_zone_radii(0.27, -1e6, 10e6, 6e9)

    def test_charge_radius_zero_raises_value_error(self):
        """charge_radius=0 应抛 ValueError（边界防御）"""
        with pytest.raises(ValueError):
            damage_zone_radii(0.0, 120e6, 10e6, 6e9)

    def test_charge_radius_negative_raises_value_error(self):
        """charge_radius<0 应抛 ValueError（边界防御）"""
        with pytest.raises(ValueError):
            damage_zone_radii(-0.1, 120e6, 10e6, 6e9)

    def test_tensile_zero_raises_value_error(self):
        """rock_tensile=0 应抛 ValueError（边界防御，避免 sigma_cd/sigma_td 除零）"""
        with pytest.raises(ValueError):
            damage_zone_radii(0.27, 120e6, 0.0, 6e9)

    def test_p_detonation_zero_raises_value_error(self):
        """p_detonation=0 应抛 ValueError（边界防御，等价于炸药密度/爆速为 0）"""
        with pytest.raises(ValueError):
            damage_zone_radii(0.27, 120e6, 10e6, 0.0)

    def test_p_detonation_negative_raises_value_error(self):
        """p_detonation<0 应抛 ValueError（边界防御）"""
        with pytest.raises(ValueError):
            damage_zone_radii(0.27, 120e6, 10e6, -1e9)

    def test_fractured_proportional_to_crushed(self):
        """裂隙区 = 粉碎区 × (sigma_cd/sigma_td)^(1/beta)"""
        r_charge, ucs, tensile, p_det = self._typical_params()
        zones = damage_zone_radii(r_charge, ucs, tensile, p_det)
        sigma_cd = ucs * SIGMA_CD_FACTOR
        sigma_td = tensile * SIGMA_TD_FACTOR
        expected_ratio = (sigma_cd / sigma_td) ** (1 / DAMAGE_BETA)
        actual_ratio = zones["fractured_radius"] / zones["crushed_radius"]
        assert abs(actual_ratio - expected_ratio) < 1e-6


# ============================================================
# 二维 PPV 波场
# ============================================================

class TestWaveField2D:

    @staticmethod
    def _make_source_rock():
        source = BlastSource(charge_kg=100, explosive_type="emulsion")
        rock = RockMedium()
        return source, rock

    def test_causality_t_zero(self):
        """t=0 时波场全零（因果性：波尚未到达任何点）"""
        source, rock = self._make_source_rock()
        gx = np.linspace(-50, 50, 20)
        gy = np.linspace(-50, 50, 20)
        field = wave_field_2d(gx, gy, 0.0, source, rock)
        assert field.shape == (20, 20)
        assert np.all(field == 0.0)

    def test_no_singularity_near_origin(self):
        """近场无奇点（R 钳制到 0.1，无 inf/NaN）"""
        source, rock = self._make_source_rock()
        gx = np.array([0.0, 0.01, 0.1, 0.5])
        gy = np.array([0.0])
        field = wave_field_2d(gx, gy, 0.001, source, rock)
        assert np.all(np.isfinite(field))

    def test_shape(self):
        """返回 (ny, nx) 形状"""
        source, rock = self._make_source_rock()
        gx = np.linspace(-50, 50, 10)
        gy = np.linspace(-50, 50, 15)
        field = wave_field_2d(gx, gy, 0.01, source, rock)
        assert field.shape == (15, 10)

    def test_field_non_negative(self):
        """波场非负"""
        source, rock = self._make_source_rock()
        gx = np.linspace(-50, 50, 30)
        gy = np.linspace(-50, 50, 30)
        field = wave_field_2d(gx, gy, 0.01, source, rock)
        assert np.all(field >= 0)

    def test_causality_wave_not_arrived(self):
        """波未到达处 PPV=0（因果性掩码）"""
        source, rock = self._make_source_rock()
        # R=50m, 波速 4500m/s → 到达时间 ≈ 0.0111s
        # t=0.005s 时波尚未到达
        gx = np.array([50.0])
        gy = np.array([0.0])
        field = wave_field_2d(gx, gy, 0.005, source, rock)
        assert field[0, 0] == 0.0

    def test_ppv_decays_with_distance(self):
        """沿 x 轴多个距离点，峰值 PPV 随距离递减

        在波到达时刻（t_rel=0），Ricker 包络=1（峰值），
        此时 PPV = K*(Q^(1/3)/R)^alpha * exp(-attenuation*R)
        """
        source, rock = self._make_source_rock()
        distances = [10.0, 20.0, 40.0]
        peak_ppvs = []
        for d in distances:
            gx = np.array([d])
            gy = np.array([0.0])
            t_peak = d / rock.p_wave_speed  # 波刚到达，envelope=1
            field = wave_field_2d(gx, gy, t_peak, source, rock)
            peak_ppvs.append(field[0, 0])
        # 峰值随距离递减
        assert peak_ppvs[0] > peak_ppvs[1] > peak_ppvs[2]

    def test_custom_k_alpha_matches_sadosky(self):
        """Task 12：自定义 site_K/alpha 时，2D 波场在干净点与 sadosky_vibration 一致

        修复前 wave_field_2d 硬编码 K/alpha=DEFAULT，忽略 rock.site_K，
        导致 2D 波场与单点 sadosky_vibration（正确使用 rock.site_K）不一致。
        取 attenuation_p=0 消去空间衰减项（sadosky 无该项），R>=5 避开近场修正，
        t=t_arrival 使 Ricker 包络=1、因果性掩码=1，三者乘积恰等于 sadosky。
        """
        source = BlastSource(charge_kg=100, explosive_type="emulsion")
        rock = RockMedium(site_K=150, site_alpha=1.8, attenuation_p=0.0)
        R = 10.0  # >= 5m 避开近场修正；> SADOSKY_R_MIN(0.5)
        gx = np.array([R])
        gy = np.array([0.0])
        t_arrival = R / rock.p_wave_speed
        field = wave_field_2d(gx, gy, t_arrival, source, rock)
        expected = sadosky_vibration(source.charge_kg, R, rock)
        assert abs(field[0, 0] - expected) < 1e-6

    def test_custom_k_changes_field(self):
        """Task 12：自定义 site_K 应改变波场（修复前硬编码 K 导致自定义无效）

        site_K=150 与默认 200 不同，故两波场应不同；修复前两者都用 200 会相等。
        """
        source = BlastSource(charge_kg=100, explosive_type="emulsion")
        gx = np.array([10.0])
        gy = np.array([0.0])
        t = 10.0 / RockMedium().p_wave_speed  # 到达时刻（两岩体波速相同）
        f_default = wave_field_2d(gx, gy, t, source, RockMedium())  # site_K=200
        f_custom = wave_field_2d(gx, gy, t, source, RockMedium(site_K=150))
        assert abs(f_default[0, 0] - f_custom[0, 0]) > 1e-6


# ============================================================
# JWL 等熵膨胀线
# ============================================================

class TestJWLIsentrope:

    def test_v1_matches_jwl_pressure(self):
        """V=1 时 jwl_isentrope 与 jwl_pressure 结果一致"""
        p_arr = jwl_isentrope(np.array([1.0]), "emulsion")
        p_single = jwl_pressure(1.0, "emulsion")
        assert abs(p_arr[0] - p_single) < 1.0

    def test_pressure_decreases_with_volume(self):
        """等熵膨胀：V 增大 P 减小"""
        v = np.array([1.0, 5.0, 10.0, 50.0, 100.0])
        p = jwl_isentrope(v, "emulsion")
        for i in range(len(p) - 1):
            assert p[i] > p[i + 1]

    def test_three_explosives_differ(self):
        """三种炸药返回不同曲线"""
        v = np.array([1.0])
        p_emul = jwl_isentrope(v, "emulsion")[0]
        p_anfo = jwl_isentrope(v, "anfo")[0]
        p_dyna = jwl_isentrope(v, "dynamite")[0]
        assert len({p_emul, p_anfo, p_dyna}) == 3

    def test_returns_ndarray(self):
        """返回 numpy 数组，长度与输入一致"""
        v = np.linspace(0.1, 10, 50)
        p = jwl_isentrope(v, "emulsion")
        assert isinstance(p, np.ndarray)
        assert len(p) == 50

    def test_all_finite(self):
        """所有值有限（无 NaN/Infinity）"""
        v = np.logspace(-1, 2, 100)  # 0.1 ~ 100
        p = jwl_isentrope(v, "emulsion")
        assert np.all(np.isfinite(p))

    def test_default_explosive(self):
        """默认炸药类型为 emulsion"""
        v = np.array([1.0])
        p_default = jwl_isentrope(v)[0]
        p_emul = jwl_isentrope(v, "emulsion")[0]
        assert p_default == p_emul
