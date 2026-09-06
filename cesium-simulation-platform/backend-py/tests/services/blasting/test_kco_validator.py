"""KCO 生产路径（kco_validator.calculate_kco）与共享公式（kco_formulas）一致性测试

确保 /api/blasting/validate/kco 路由调用的 calculate_kco 与被前后端一致性测试
覆盖的 kco_formulas 数值一致，消除历史双实现分裂带来的"测试覆盖死路径"风险。

基准值读取自仓库根目录 shared-consistency-baseline.json（与前端共用契约，实时互算）。
"""
import json
import math
import os

import pytest

from app.services.blasting.kco_validator import KCOInput, calculate_kco
from app.services.blasting import kco_formulas as kf

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
_BASELINE_PATH = os.path.abspath(os.path.join(_ROOT, '..', 'shared-consistency-baseline.json'))
with open(_BASELINE_PATH, 'r', encoding='utf-8') as _bf:
    _BASELINE = json.load(_bf)

# 与 test_kco_formulas.py / kcoFormulas.test.js 共用的基准参数
BASE_PARAMS = dict(x50=0.3, xmax=2.0, n=1.2, b=2.0)
EXPECTED_CDF = _BASELINE['swebrecCdf']['x=0.5, x50=0.3, xmax=2.0, n=1.2, b=2.0']
EXPECTED_X80 = _BASELINE['solveX80']['x50=0.3, xmax=2.0, n=1.2, b=2.0']


def test_calculate_kco_cunningham_n_matches_shared():
    """calculate_kco 内部 cunningham_n 应与 kco_formulas 完全一致"""
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2)
    out = calculate_kco(inp)
    # 与 calculate_kco 内部调用一致：L 缺省时 charge_len = H
    charge_len = inp.L if inp.L is not None else inp.H
    expected_n = kf.cunningham_n(inp.B, inp.d, inp.W_abs, inp.S, charge_len, inp.H)
    assert out.n == pytest.approx(expected_n, abs=1e-12)


def test_calculate_kco_x80_matches_shared_solve_x80():
    """calculate_kco 的 x80 应与 kco_formulas.solve_x80 数值一致"""
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, b=2.0)
    out = calculate_kco(inp)
    expected_x80 = kf.solve_x80(out.x50, inp.xmax, out.n, inp.b)
    assert out.x80 == pytest.approx(expected_x80, abs=1e-7)


def test_calculate_kco_x80_matches_frontend_baseline():
    """验证基准用例：x50=0.3, xmax=2.0, n=1.2, b=2.0 → x80≈0.4944

    注意：前端基准值 EXPECTED_X80 是用 n=1.2 计算的，而实际 KCOInput 参数
    (B=1.5, d=0.04, W_abs=0.2) 产生 n≈0.7916。因此本测试分两步：
    1) 验证 calculate_kco 的 x80 与共享公式 solve_x80(同参数) 一致
    2) 单独验证基准参数 (x50=0.3, n=1.2) 下 solve_x80 匹配前端基准
    """
    # 构造使 x50=0.3 的输入：由 Kuznetsov 方程完整形式反解 Q
    #   x50 [m] = 0.01 · A · (115/RWS)^(19/30) · (V0/Q)^0.8 · Q^(1/6),  V0 = B·S·H
    # 即  x50 = F · Q^(-19/30)，其中 F = 0.01·A·(115/RWS)^(19/30)·V0^0.8
    # 因此  Q = (F / x50)^(30/19)
    A, RWS, B, S, H = 3.6, 100.0, 1.5, 2.0, 4.5
    v0 = B * S * H
    factor = 0.01 * A * (115 / RWS) ** (19 / 30) * (v0 ** 0.8)
    Q = (factor / 0.3) ** (30 / 19)
    inp = KCOInput(Q=Q, A=A, B=B, S=S, H=H, d=0.04, W_abs=0.2, xmax=2.0, b=2.0)
    out = calculate_kco(inp)
    # x50 应接近 0.3（Kuznetsov 方程独立实现，允许 1e-6 误差）
    assert out.x50 == pytest.approx(0.3, abs=1e-6)
    # Cunningham n 应等于共享公式结果（inp: B=1.5, d=0.04, W_abs=0.2, S=2.0, L=None→H=4.5）
    expected_n = kf.cunningham_n(1.5, 0.04, 0.2, 2.0, 4.5, 4.5)
    assert out.n == pytest.approx(expected_n, abs=1e-12)
    # x80 应与共享公式 solve_x80（同参数）一致，而非前端 n=1.2 基准值
    expected_x80 = kf.solve_x80(out.x50, inp.xmax, out.n, inp.b)
    assert out.x80 == pytest.approx(expected_x80, abs=1e-7)
    # 基准值 (n=1.2) 单独验证：solve_x80(0.3, 2.0, 1.2, 2.0) ≈ 0.4944
    assert kf.solve_x80(0.3, 2.0, 1.2, 2.0) == pytest.approx(EXPECTED_X80, abs=1e-4)


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


# ─── 大块率（截断分布尾部积分，oversize_ratio = 1 - P(x_allow)）───

def test_oversize_ratio_default_zero():
    """x_allow 缺省（None）时默认取 xmax，大块率应为 0（向后兼容历史行为）"""
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2)
    out = calculate_kco(inp)
    assert out.oversize_ratio == 0.0


def test_oversize_ratio_zero_when_x_allow_ge_xmax():
    """x_allow >= xmax 时大块率应为 0（Swebrec 在 xmax 处 CDF 强制为 1）"""
    inp_eq = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, x_allow=2.0)
    assert calculate_kco(inp_eq).oversize_ratio == 0.0
    inp_gt = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, x_allow=3.0)
    assert calculate_kco(inp_gt).oversize_ratio == 0.0


def test_oversize_ratio_matches_swebrec_tail():
    """大块率应与 kco_formulas.swebrec_cdf 截断尾部一致：1 - P(x_allow)

    x_allow 需选在 x50 附近量级（默认参数下 x50≈0.026m），
    若 x_allow 远大于 x50（如 0.5m），Swebrec CDF 数值下溢为 1，
    尾部积分退化为 0，无法验证公式一致性。
    """
    inp = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, x_allow=0.05)
    out = calculate_kco(inp)
    expected = 1.0 - kf.swebrec_cdf(0.05, out.x50, inp.xmax, out.n, inp.b)
    assert out.oversize_ratio == pytest.approx(expected, abs=1e-12)


def test_oversize_ratio_decreases_with_x_allow():
    """x_allow 越小大块率越高；x_allow < xmax 时严格为正且 < 1（单调递减）

    同样选取 x50 附近量级（默认参数下 x50≈0.026m），避免 CDF 下溢：
    x_allow=0.05 → 大块率≈0.12；x_allow=0.08 → 大块率≈0.008。
    """
    inp_small = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, x_allow=0.05)
    inp_mid = KCOInput(Q=50, A=3.6, B=1.5, d=0.04, W_abs=0.2, xmax=2.0, x_allow=0.08)
    out_small = calculate_kco(inp_small)
    out_mid = calculate_kco(inp_mid)
    assert 0.0 < out_mid.oversize_ratio < out_small.oversize_ratio < 1.0
