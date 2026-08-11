"""KCO 共享公式单元测试（pytest 风格）。

与前端 kcoFormulas.test.js 对齐：
- swebrec_cdf 与前端记录值在 1e-6 内一致
- solve_x80 与前端记录值在 1e-4 内一致
"""
import os
import sys

# 确保可从 backend-py 根目录导入 app 包（兼容 pytest / python -m pytest 调用）
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import math

import pytest

from app.services.blasting.kco_formulas import (
    swebrec_cdf,
    swebrec_inverse,
    solve_x80,
    cunningham_n,
)

# 前端 kcoFormulas.test.js 记录的基准值（前后端对齐对标）
EXPECTED_CDF = 0.8066900763516753   # swebrecCdf(0.5, 0.3, 2.0, 1.2, 2.0)
EXPECTED_X80 = 0.4944131281749693   # solveX80(0.3, 2.0, 1.2, 2.0)


def test_swebrec_cdf_matches_frontend_baseline():
    v = swebrec_cdf(0.5, 0.3, 2.0, 1.2, 2.0)
    assert 0.0 <= v <= 1.0
    assert v == pytest.approx(EXPECTED_CDF, abs=1e-6)


def test_swebrec_cdf_boundaries():
    assert swebrec_cdf(0, 0.3, 2.0, 1.2, 2.0) == 0.0
    assert swebrec_cdf(-1, 0.3, 2.0, 1.2, 2.0) == 0.0
    assert swebrec_cdf(2.0, 0.3, 2.0, 1.2, 2.0) == 1.0
    assert swebrec_cdf(2.5, 0.3, 2.0, 1.2, 2.0) == 1.0
    assert math.isnan(swebrec_cdf(0.5, 0.0, 2.0, 1.2, 2.0))
    assert math.isnan(swebrec_cdf(0.5, 2.0, 2.0, 1.2, 2.0))


def test_solve_x80_matches_frontend_baseline():
    x80 = solve_x80(0.3, 2.0, 1.2, 2.0)
    assert x80 == pytest.approx(EXPECTED_X80, abs=1e-4)


def test_swebrec_inverse_consistency():
    u = 0.35
    x = swebrec_inverse(u, 0.3, 2.0, 1.2, 2.0)
    assert swebrec_cdf(x, 0.3, 2.0, 1.2, 2.0) == pytest.approx(u, abs=1e-6)


def test_cunningham_n():
    # B=1.5, d=0.09, W_abs=0 → (2.2 - 14*0.09/1.5) / 2 = 0.68
    assert cunningham_n(1.5, 0.09, 0.0) == pytest.approx(0.68, abs=1e-9)
    # B<=0 返回 1.0
    assert cunningham_n(0.0, 0.09, 0.1) == 1.0
    # clamp 到 [0.5, 2.5]
    v = cunningham_n(1.5, 0.0, 0.0)
    assert 0.5 <= v <= 2.5
