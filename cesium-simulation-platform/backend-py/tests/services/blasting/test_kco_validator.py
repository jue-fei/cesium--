"""KCO 生产路径（kco_validator.calculate_kco）与共享公式（kco_formulas）一致性测试

确保 /api/blasting/validate/kco 路由调用的 calculate_kco 与被前后端一致性测试
覆盖的 kco_formulas 数值一致，消除历史双实现分裂带来的"测试覆盖死路径"风险。
"""
import math
import pytest

from app.services.blasting.kco_validator import KCOInput, calculate_kco
from app.services.blasting import kco_formulas as kf


# 与 test_kco_formulas.py / kcoFormulas.test.js 共用的基准参数
BASE_PARAMS = dict(x50=0.3, xmax=2.0, n=1.2, b=2.0)
EXPECTED_CDF = 0.8066900763516753
EXPECTED_X80 = 0.4944131281749693


def test_calculate_kco_cunningham_n_matches_shared():
    """calculate_kco 内部 cunningham_n 应与 kco_formulas 完全一致"""
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2)
    out = calculate_kco(inp)
    expected_n = kf.cunningham_n(inp.B, inp.d, inp.W_abs)
    assert out.n == pytest.approx(expected_n, abs=1e-12)


def test_calculate_kco_x80_matches_shared_solve_x80():
    """calculate_kco 的 x80 应与 kco_formulas.solve_x80 数值一致"""
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, b=2.0)
    out = calculate_kco(inp)
    expected_x80 = kf.solve_x80(out.x50, inp.xmax, out.n, inp.b)
    assert out.x80 == pytest.approx(expected_x80, abs=1e-7)


def test_calculate_kco_x80_matches_frontend_baseline():
    """验证基准用例：x50=0.3, xmax=2.0, n=1.2, b=2.0 → x80≈0.4944"""
    # 构造使 x50=0.3 的输入：求解 Q 使 Kuznetsov 方程得到 x50≈0.3
    # x50 = 0.01 * 3.6 * Q^(1/6) * (115/100)^(19/30)
    # 0.3 = 0.01 * 3.6 * Q^(1/6) * 1.15^0.6333
    # Q^(1/6) = 0.3 / (0.036 * 1.15^0.6333)
    factor = 0.01 * 3.6 * (115 / 100) ** (19 / 30)
    Q = (0.3 / factor) ** 6
    inp = KCOInput(Q=Q, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, b=2.0)
    out = calculate_kco(inp)
    # x50 应接近 0.3（Kuznetsov 方程独立实现，允许 1e-6 误差）
    assert out.x50 == pytest.approx(0.3, abs=1e-6)
    # Cunningham n 应等于共享公式结果
    expected_n = kf.cunningham_n(1.5, 0.04, 0.2)
    assert out.n == pytest.approx(expected_n, abs=1e-12)
    # x80 应匹配前端基准值（1e-4 容差，与前后端一致性测试对齐）
    assert out.x80 == pytest.approx(EXPECTED_X80, abs=1e-4)


def test_calculate_kco_swebrec_cdf_at_x80():
    """x80 处的 Swebrec CDF 应等于 0.8（验证 x80 求根正确性）"""
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, b=2.0)
    out = calculate_kco(inp)
    cdf_at_x80 = kf.swebrec_cdf(out.x80, out.x50, inp.xmax, out.n, inp.b)
    assert cdf_at_x80 == pytest.approx(0.8, abs=1e-4)


def test_calculate_kco_n_clamp_low():
    """Cunningham n 下限 clamp [0.5, 2.5]：极端小孔径/大抵抗线"""
    inp = KCOInput(Q=50, B=10.0, d=0.001, W_abs=0.0)  # raw n ≈ 1.1
    out = calculate_kco(inp)
    assert out.n >= 0.5
    assert out.n <= 2.5


def test_calculate_kco_invalid_inputs():
    """异常输入：B<=0 应由 cunningham_n 返回 1.0 兜底，不抛异常"""
    inp = KCOInput(Q=50, B=0.0, d=0.04, W_abs=0.2)
    out = calculate_kco(inp)
    assert out.n == 1.0  # kco_formulas.cunningham_n 的 B<=0 兜底
