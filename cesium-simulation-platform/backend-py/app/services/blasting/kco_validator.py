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

from app.services.blasting.kco_formulas import solve_x80, cunningham_n

logger = logging.getLogger(__name__)


@dataclass
class KCOInput:
    """KCO模型输入参数"""
    Q: float          # 单孔装药量(kg)
    A: float = 3.6    # 岩石因子
    RWS: float = 100  # 相对重量威力(ANFO=100)
    B: float = 1.5    # 抵抗线(m)
    S: float = 2.0    # 孔距(m)
    d: float = 0.04   # 孔径(m)
    H: float = 4.5    # 台阶高度(m)
    xmax: float = 2.0 # 最大块度(m)
    b: float = 2.0    # Swebrec弯曲参数
    W_abs: float = 0.2  # 钻孔偏差(标准差, m)，Cunningham 公式完整分支所需


@dataclass
class KCOOutput:
    """KCO模型输出"""
    x50: float        # 中位块度(m)
    n: float          # 均匀性指数
    x80: float        # 80%通过块度(m)
    uniformity: float # 均匀性(0-1)
    oversize_ratio: float  # 大块率(%)


def calculate_kco(params: KCOInput) -> KCOOutput:
    """计算KCO碎块分布参数

    公式委托 kco_formulas 共享模块（与前端 kcoFormulas.js 数值对齐），
    本函数仅负责 Kuznetsov x50 计算、业务编排与均匀性/大块率派生。
    """
    # Kuznetsov方程（业务层保留，前后端独立实现的工程公式）
    x50 = 0.01 * params.A * (params.Q ** (1/6)) * (115 / params.RWS) ** (19/30)

    # Cunningham均匀性指数（委托共享公式，消除双实现）
    n = cunningham_n(params.B, params.d, params.W_abs)

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

    # 大块率（超过xmax的比例）
    oversize_ratio = 0.0  # Swebrec分布在xmax处为1，故大块率为0

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
