"""KCO 碎块分布模型验证器单元测试

覆盖函数：
- _swebrec_cdf: Swebrec 累积分布函数
- _solve_x80: 80% 通过块度迭代求解
- calculate_kco: KCO 模型主计算
- batch_validate: 批量验证
"""
import numpy as np
import pytest

from app.services.blasting.kco_validator import (
    KCOInput,
    KCOOutput,
    calculate_kco,
    _swebrec_cdf,
    _solve_x80,
    batch_validate,
)
from app.services.blasting.constants import KCO_OVERSIZE_THRESHOLD


# ============================================================
# Swebrec 累积分布函数
# ============================================================

class TestSwebrecCdf:

    def test_x_zero_returns_zero(self):
        """x=0 → P=0"""
        assert _swebrec_cdf(0, 0.5, 2.0, 0.8, 2.0) == 0.0

    def test_x_negative_returns_zero(self):
        """x<0 → P=0"""
        assert _swebrec_cdf(-1.0, 0.5, 2.0, 0.8, 2.0) == 0.0

    def test_x_xmax_returns_one(self):
        """x=xmax → P=1"""
        assert _swebrec_cdf(2.0, 0.5, 2.0, 0.8, 2.0) == 1.0

    def test_x_above_xmax_returns_one(self):
        """x>xmax → P=1"""
        assert _swebrec_cdf(3.0, 0.5, 2.0, 0.8, 2.0) == 1.0

    def test_x_x50_returns_half(self):
        """x=x50 → P=0.5（中位块度定义）"""
        result = _swebrec_cdf(0.5, 0.5, 2.0, 0.8, 2.0)
        assert abs(result - 0.5) < 1e-6

    def test_monotonic_increasing(self):
        """单调递增：x 增大 P 增大"""
        x50, xmax, n, b = 0.5, 2.0, 0.8, 2.0
        xs = [0.1, 0.3, 0.5, 0.7, 1.0, 1.5, 1.9]
        prev = -1.0
        for x in xs:
            p = _swebrec_cdf(x, x50, xmax, n, b)
            assert p > prev
            prev = p

    def test_range_zero_to_one(self):
        """P(x) 始终在 [0, 1] 范围内"""
        for x in np.linspace(0.01, 1.99, 50):
            p = _swebrec_cdf(x, 0.5, 2.0, 0.8, 2.0)
            assert 0.0 <= p <= 1.0


# ============================================================
# 80% 通过块度求解
# ============================================================

class TestSolveX80:

    def test_normal_parameters_positive(self):
        """正常参数返回正值"""
        x80 = _solve_x80(0.5, 2.0, 0.8, 2.0)
        assert 0 < x80 < 2.0

    def test_x80_greater_than_x50(self):
        """x80 > x50（80% 通过块度 > 中位块度）"""
        x80 = _solve_x80(0.5, 2.0, 0.8, 2.0)
        assert x80 > 0.5

    def test_cdf_at_x80_is_080(self):
        """_swebrec_cdf(x80) ≈ 0.8"""
        x50, xmax, n, b = 0.5, 2.0, 0.8, 2.0
        x80 = _solve_x80(x50, xmax, n, b)
        p = _swebrec_cdf(x80, x50, xmax, n, b)
        assert abs(p - 0.8) < 1e-4

    def test_extreme_parameters_no_crash(self):
        """极端参数不抛异常（fallback 返回 x50*1.5）"""
        # 极端 n/b 组合可能导致 brentq 失败，但 fallback 应处理
        x80 = _solve_x80(0.01, 100.0, 2.5, 10.0)
        assert x80 > 0

    def test_fallback_when_brentq_fails(self):
        """brentq 失败时 fallback 返回 x50*1.5

        x50=0 时 _swebrec_cdf 触发 ZeroDivisionError（x/0），
        brentq 异常被 except 捕获，返回 fallback = 0*1.5 = 0
        """
        x80 = _solve_x80(0.0, 2.0, 0.8, 2.0)
        assert x80 == 0.0  # 0 * 1.5 = 0


# ============================================================
# KCO 主计算
# ============================================================

class TestCalculateKCO:

    def test_typical_values_n(self):
        """典型值：Q=320/A=3.6/RWS=100/B=1.5/d=0.04/W_abs=0.2 → n≈0.7916"""
        inp = KCOInput(Q=320, A=3.6, RWS=100, B=1.5, d=0.04, W_abs=0.2)
        out = calculate_kco(inp)
        assert abs(out.n - 0.7916) < 0.01

    def test_typical_values_x50(self):
        """典型值 x50 > 0"""
        inp = KCOInput(Q=320, A=3.6, RWS=100, B=1.5, d=0.04, W_abs=0.2)
        out = calculate_kco(inp)
        assert out.x50 > 0

    def test_n_clamp_lower_bound(self):
        """n clamp [0.5, 2.5]：极端 d/B 使 n<0.5 时钳制到 0.5

        n = (2.2 - 14*d/B) * (1 - W_abs/B) / 2
        d=0.3, B=1.0 → 14*0.3=4.2 > 2.2 → n 为负 → 钳制到 0.5
        """
        inp = KCOInput(Q=100, A=3.6, B=1.0, d=0.3, W_abs=0.0)
        out = calculate_kco(inp)
        assert out.n == 0.5

    def test_n_clamp_upper_bound(self):
        """n clamp [0.5, 2.5]：n 不会超过 2.5"""
        inp = KCOInput(Q=100, A=3.6, B=10.0, d=0.001, W_abs=0.0)
        out = calculate_kco(inp)
        assert 0.5 <= out.n <= 2.5

    def test_n_in_valid_range(self):
        """n 始终在 [0.5, 2.5]"""
        for d in [0.01, 0.04, 0.1, 0.2, 0.3]:
            for B in [0.5, 1.0, 2.0, 5.0]:
                inp = KCOInput(Q=100, A=3.6, B=B, d=d, W_abs=0.1)
                out = calculate_kco(inp)
                assert 0.5 <= out.n <= 2.5

    def test_q_zero_raises_value_error(self):
        """Q=0 应抛 ValueError（边界防御）

        x50 = 0.01 * A * 0^(1/6) * ... = 0，随后 _swebrec_cdf(0.8, 0, ...)
        中 x/0 会触发 ZeroDivisionError，故入口处显式校验 Q > 0。
        """
        inp = KCOInput(Q=0, A=3.6, B=1.5, d=0.04, W_abs=0.2)
        with pytest.raises(ValueError):
            calculate_kco(inp)

    def test_q_negative_raises_value_error(self):
        """Q<0 应抛 ValueError（边界防御）"""
        inp = KCOInput(Q=-10, A=3.6, B=1.5, d=0.04, W_abs=0.2)
        with pytest.raises(ValueError):
            calculate_kco(inp)

    def test_b_zero_raises_value_error(self):
        """B=0 应抛 ValueError（边界防御，避免 n 公式 14*d/B 除零）"""
        inp = KCOInput(Q=100, A=3.6, B=0.0, d=0.04, W_abs=0.2)
        with pytest.raises(ValueError):
            calculate_kco(inp)

    def test_d_zero_raises_value_error(self):
        """d=0 应抛 ValueError（边界防御）"""
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.0, W_abs=0.2)
        with pytest.raises(ValueError):
            calculate_kco(inp)

    def test_w_abs_negative_raises_value_error(self):
        """W_abs<0 应抛 ValueError（边界防御，钻孔偏差不可为负）"""
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=-0.1)
        with pytest.raises(ValueError):
            calculate_kco(inp)

    def test_w_abs_zero_ok(self):
        """W_abs=0 合法（钻孔偏差下限为 0），不抛异常"""
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=0.0)
        out = calculate_kco(inp)
        assert 0.5 <= out.n <= 2.5

    def test_oversize_threshold_equal_xmax(self):
        """oversize 阈值 = xmax → oversize_ratio=0"""
        # KCO_OVERSIZE_THRESHOLD = 0.8, xmax = 0.8 → 阈值 >= xmax → 无大块
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=0.8)
        out = calculate_kco(inp)
        assert out.oversize_ratio == 0.0

    def test_oversize_threshold_above_xmax(self):
        """xmax < 阈值 → oversize_ratio=0"""
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=0.5)
        out = calculate_kco(inp)
        assert out.oversize_ratio == 0.0

    def test_oversize_normal_positive(self):
        """xmax > 阈值 → oversize_ratio > 0"""
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0)
        out = calculate_kco(inp)
        assert out.oversize_ratio > 0

    def test_a_small_value(self):
        """A 边界：A=0.1（极小）不抛异常，x50 随 A 线性变化"""
        inp_small = KCOInput(Q=100, A=0.1, B=1.5, d=0.04, W_abs=0.2)
        out_small = calculate_kco(inp_small)
        inp_normal = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=0.2)
        out_normal = calculate_kco(inp_normal)
        assert out_small.x50 > 0
        # A 小 → x50 小（x50 = 0.01 * A * ...）
        assert out_small.x50 < out_normal.x50

    def test_a_large_value(self):
        """A 边界：A=22.0（schema 上限）不抛异常"""
        inp = KCOInput(Q=100, A=22.0, B=1.5, d=0.04, W_abs=0.2)
        out = calculate_kco(inp)
        assert out.x50 > 0

    def test_uniformity_range(self):
        """uniformity 在 [0, 1] 范围内"""
        inp = KCOInput(Q=100, A=3.6, B=1.5, d=0.04, W_abs=0.2)
        out = calculate_kco(inp)
        assert 0.0 <= out.uniformity <= 1.0

    def test_return_type(self):
        """返回 KCOOutput 类型"""
        inp = KCOInput(Q=100)
        out = calculate_kco(inp)
        assert isinstance(out, KCOOutput)

    def test_x50_formula(self):
        """x50 = 0.01 * A * Q^(1/6) * (115/RWS)^(19/30)"""
        inp = KCOInput(Q=320, A=3.6, RWS=100)
        out = calculate_kco(inp)
        expected = 0.01 * 3.6 * (320 ** (1 / 6)) * (115 / 100) ** (19 / 30)
        assert abs(out.x50 - expected) < 1e-10

    def test_default_parameters(self):
        """默认参数不抛异常"""
        inp = KCOInput(Q=100)
        out = calculate_kco(inp)
        assert out.x50 > 0
        assert 0.5 <= out.n <= 2.5


# ============================================================
# 批量验证
# ============================================================

class TestBatchValidate:

    def test_batch_returns_list(self):
        """批量验证返回列表"""
        inputs = [
            KCOInput(Q=100, A=3.6),
            KCOInput(Q=200, A=5.0),
            KCOInput(Q=300, A=7.0),
        ]
        outputs = batch_validate(inputs)
        assert len(outputs) == 3
        assert all(isinstance(o, KCOOutput) for o in outputs)

    def test_empty_batch(self):
        """空列表返回空列表"""
        outputs = batch_validate([])
        assert outputs == []

    def test_batch_consistency(self):
        """批量结果与单条一致"""
        inp = KCOInput(Q=150, A=4.0, B=2.0, d=0.05)
        single = calculate_kco(inp)
        batch = batch_validate([inp])
        assert abs(batch[0].x50 - single.x50) < 1e-10
        assert abs(batch[0].n - single.n) < 1e-10
