"""KCO 共享公式单元测试（pytest 风格）。

与前端 kcoFormulas.test.js 对齐：
- swebrec_cdf 与 shared-consistency-baseline.json 记录值在 1e-6 内一致
- solve_x80 与 shared-consistency-baseline.json 记录值在 1e-4 内一致

一致性契约（实时互算）：前后端测试共同读取仓库根目录
shared-consistency-baseline.json 作为基线。前端负责"计算值 == 基线"，
本文件负责"后端实现 == 基线"，避免共享 golden 常量下两端同步改坏而不被察觉。
"""
import json
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

# 前后端一致性基线（实时互算契约）：与前端 kcoFormulas.test.js 共用同一文件
_BASELINE_PATH = os.path.abspath(os.path.join(_ROOT, '..', 'shared-consistency-baseline.json'))
with open(_BASELINE_PATH, 'r', encoding='utf-8') as _bf:
    _BASELINE = json.load(_bf)

EXPECTED_CDF = _BASELINE['swebrecCdf']['x=0.5, x50=0.3, xmax=2.0, n=1.2, b=2.0']
EXPECTED_X80 = _BASELINE['solveX80']['x50=0.3, xmax=2.0, n=1.2, b=2.0']


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
    # 完整形式：B=1.5, d=0.09, W_abs=0, S=2.0, L=4.5, H=4.5
    # n = (2.2-14*0.09/1.5) * (1-0) * sqrt(1+(2/1.5-1)/2) * (4.5/4.5)
    #   = 1.36 * 1.0 * sqrt(1.1667) * 1.0 ≈ 1.36 * 1.0801 ≈ 1.469
    assert cunningham_n(1.5, 0.09, 0.0, 2.0, 4.5, 4.5) == pytest.approx(1.4689, abs=1e-4)
    # B<=0 返回 1.0
    assert cunningham_n(0.0, 0.09, 0.1, 2.0, 4.5, 4.5) == 1.0
    # clamp 到 [0.5, 2.5]
    v = cunningham_n(1.5, 0.0, 0.0, 2.0, 4.5, 4.5)
    assert 0.5 <= v <= 2.5
