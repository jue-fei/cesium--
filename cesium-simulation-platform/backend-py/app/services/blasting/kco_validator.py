"""KCO 碎块分布模型离线验证器

用于设计评审前批量模拟多组爆破参数，计算块度分布曲线。
KCO模型 = Kuznetsov方程（X50）+ Cunningham均匀性指数（n）+ Swebrec分布函数

公式：
- Kuznetsov: X50 = 0.01 * A * Q^(1/6) * (115/RWS)^(19/30)
  A: 岩石因子(0.8~22), Q: 单孔装药量(kg), RWS: 相对重量威力(ANFO=100)
- Cunningham均匀性指数: n = (2.2 - 14d/B)(1-W/B)/2
  d: 孔径, B: 抵抗线
- Swebrec分布: P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)

注：Cunningham n、Swebrec CDF 反解、x80 求根统一委托 kco_formulas 共享模块，
    消除历史双实现分裂，确保前后端公式与生产路径数值一致。
"""
import logging
import numpy as np
from dataclasses import dataclass
from typing import List, Dict

from app.services.blasting.kco_formulas import solve_x80, cunningham_n, swebrec_cdf

logger = logging.getLogger(__name__)


@dataclass
class KCOInput:
    """KCO模型输入参数"""
    Q: float          # 单孔装药量(kg)
    A: float = 3.6    # 岩石因子
    RWS: float = 100  # 相对重量威力(ANFO=100)
    B: float = 1.5    # 抵抗线(m)
    S: float = 2.0    # 孔距(m)
    d: float = 0.09   # 孔径(m)，与前端默认 90mm 一致
    H: float = 4.5    # 台阶高度(m)
    L: float = None   # 装药长度(m)，默认等于台阶高度 H（满装药）
    xmax: float = 2.0 # 最大块度(m)
    b: float = 2.0    # Swebrec弯曲参数
    W_abs: float = 0.2  # 钻孔偏差(标准差, m)，Cunningham 公式完整分支所需
    x_allow: float = None  # 允许最大块度(m)，None 时默认取 xmax → 大块率为 0


@dataclass
class KCOOutput:
    """KCO模型输出"""
    x50: float        # 中位块度(m)
    n: float          # 均匀性指数
    x80: float        # 80%通过块度(m)
    uniformity: float # 均匀性(0-1)
    oversize_ratio: float  # 大块率（0~1 比例，非百分比；大块质量/数量占比）


def calculate_kco(params: KCOInput) -> KCOOutput:
    """计算KCO碎块分布参数

    公式委托 kco_formulas 共享模块（与前端 kcoFormulas.js 数值对齐），
    本函数仅负责 Kuznetsov x50 计算、业务编排与均匀性/大块率派生。
    """
    # Kuznetsov方程（Cunningham 1983，与前端 kcoModelCore.js 对齐）：
    #   X50 [cm] = A * (V0/Q)^0.8 * Q^(1/6) * (115/RWS)^(19/30)
    # 其中 V0 = B * S * H（单孔崩落体积，m³），Q 为单孔装药量（kg）
    v0 = max(0.01, params.B * params.S * params.H)
    q = max(0.1, params.Q)
    x50_cm = (
        params.A
        * ((v0 / q) ** 0.8)
        * (q ** (1 / 6))
        * ((115 / max(1, params.RWS)) ** (19 / 30))
    )
    x50 = max(0.01, x50_cm * 0.01)  # cm → m

    # x50 >= xmax 守卫（与前端一致，防止 NaN 传播）
    if x50 >= params.xmax:
        fallback = min(x50_cm * 0.01, params.xmax * 0.8)
        logger.warning(
            "x50(%s) >= xmax(%s), auto-corrected to %s", x50, params.xmax, fallback
        )
        x50 = fallback

    # Cunningham均匀性指数（委托共享公式，消除双实现；完整形式含孔距项/装药项）
    charge_len = params.L if params.L is not None else params.H
    n = cunningham_n(params.B, params.d, params.W_abs, params.S, charge_len, params.H)

    # x80（委托共享公式，含 scipy 优先 + 纯 Python brentq 兜底）
    x80 = solve_x80(x50, params.xmax, n, params.b)
    if not np.isfinite(x80):
        # 求根失败时显式记录日志（不再静默吞异常），降级为经验值
        logger.warning(
            "solve_x80 returned NaN, falling back to empirical 1.5*x50: "
            "x50=%s xmax=%s n=%s b=%s", x50, params.xmax, n, params.b
        )
        x80 = x50 * 1.5

    # 均匀性
    uniformity = 1.0 - abs(n - 1.5) / 1.5

    # 大块率 = 超过允许最大块度 x_allow 的块度占比（截断分布尾部积分）
    # 数学定义：oversize_ratio = 1 - P(x_allow)，P 为 Swebrec CDF（0~1 比例）。
    # 单位约定：输出为 0~1 比例（非百分比），如需百分比乘以 100。
    # 语义边界（Swebrec 在 xmax 处 CDF 强制为 1）：
    #   - x_allow 未提供时默认取 xmax → 大块率恒为 0（历史行为，向后兼容）
    #   - x_allow >= xmax 时同样为 0（没有超过最大块度的可能）
    #   - 仅当 0 < x_allow < xmax 时按截断分布尾部积分计算真实大块率。
    # 注意：真实爆破中必有大块。此指标基于 Swebrec 分布的截断尾部估计，
    # 供"允许最大块度"工艺约束下的相对比较/形态复现使用，不作绝对预测。
    x_allow = params.x_allow if params.x_allow is not None else params.xmax
    if x_allow >= params.xmax:
        oversize_ratio = 0.0
    else:
        oversize_ratio = 1.0 - swebrec_cdf(x_allow, x50, params.xmax, n, params.b)
        if not np.isfinite(oversize_ratio):
            # CDF 数值退化（x50/xmax 异常）时降级为 0，避免 NaN 传播
            oversize_ratio = 0.0

    return KCOOutput(x50=x50, n=n, x80=x80, uniformity=uniformity, oversize_ratio=oversize_ratio)


def batch_validate(inputs: List[KCOInput]) -> List[KCOOutput]:
    """批量验证多组参数"""
    return [calculate_kco(inp) for inp in inputs]


def compare_with_design(results: List[KCOOutput], targets: List[Dict]) -> List[Dict]:
    """将计算结果与设计目标对比"""
    comparisons = []
    for res, target in zip(results, targets):
        comparisons.append({
            'x50_calculated': res.x50,
            'x50_target': target.get('expected_x50', 0.3),
            'x50_error': abs(res.x50 - target.get('expected_x50', 0.3)) / target.get('expected_x50', 0.3),
            'xmax_target': target.get('expected_xmax', 2.0),
            'uniformity': res.uniformity,
            'pass': res.x50 <= target.get('expected_x50', 0.3) * 1.2
        })
    return comparisons
