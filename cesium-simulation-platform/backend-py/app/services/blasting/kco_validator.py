"""KCO 碎块分布模型离线验证器

用于设计评审前批量模拟多组爆破参数，计算块度分布曲线。
KCO模型 = Kuznetsov方程（X50）+ Cunningham均匀性指数（n）+ Swebrec分布函数

公式：
- Kuznetsov: X50 = 0.01 * A * Q^(1/6) * (115/RWS)^(19/30)
  A: 岩石因子(0.8~22), Q: 单孔装药量(kg), RWS: 相对重量威力(ANFO=100)
- Cunningham均匀性指数: n = (2.2 - 14d/B)(1-W/B)(1+...)/2
  d: 孔径, B: 抵抗线
- Swebrec分布: P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
"""
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Optional

from .constants import KCO_OVERSIZE_THRESHOLD


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
    """计算KCO碎块分布参数"""
    # 参数边界校验，避免零值/负值导致除零或 Inf 传播
    if params.Q <= 0:
        raise ValueError("装药量 Q 必须大于 0")
    if params.B <= 0:
        raise ValueError("最小抵抗线 B 必须大于 0")
    if params.d <= 0:
        raise ValueError("孔径 d 必须大于 0")
    if params.W_abs < 0:
        raise ValueError("钻孔偏差 W_abs 不能为负")

    # Kuznetsov方程
    x50 = 0.01 * params.A * (params.Q ** (1/6)) * (115 / params.RWS) ** (19/30)

    # Cunningham均匀性指数（完整分支：含钻孔偏差 W_abs）
    n = (2.2 - 14 * params.d / params.B) * (1 - params.W_abs / params.B) / 2
    n = max(0.5, min(2.5, n))

    # 计算80%通过块度（迭代求解Swebrec分布）
    x80 = _solve_x80(x50, params.xmax, n, params.b)

    # 均匀性
    uniformity = 1.0 - abs(n - 1.5) / 1.5

    # 大块率：超过大块阈值(默认0.8m)的碎块比例
    # 修正：原实现固定为0（误以为 xmax 是大块阈值）；实际 xmax 是分布上限，
    # 大块率应为 1 - P(oversize_threshold)，P 为 Swebrec 累积分布函数
    oversize_threshold = KCO_OVERSIZE_THRESHOLD  # 大块阈值(m)，工程上常取 0.8m
    if oversize_threshold >= params.xmax:
        oversize_ratio = 0.0  # 阈值超过分布上限，无大块
    else:
        p_through = _swebrec_cdf(oversize_threshold, x50, params.xmax, n, params.b)
        oversize_ratio = max(0.0, (1.0 - p_through) * 100.0)  # 百分比

    return KCOOutput(x50=x50, n=n, x80=x80, uniformity=uniformity, oversize_ratio=oversize_ratio)


def _swebrec_cdf(x: float, x50: float, xmax: float, n: float, b: float) -> float:
    """Swebrec 分布累积函数 P(x)：尺寸 ≤ x 的碎块比例

    P(x) = 1 - exp(-ln2 * (x/x50)^n / ((xmax-x)/(xmax-x50))^b)
    """
    if x >= xmax:
        return 1.0
    if x <= 0:
        return 0.0
    return 1 - np.exp(-np.log(2) * (x / x50) ** n / ((xmax - x) / (xmax - x50)) ** b)


def _solve_x80(x50: float, xmax: float, n: float, b: float) -> float:
    """迭代求解80%通过块度"""
    from scipy.optimize import brentq

    try:
        return brentq(lambda x: _swebrec_cdf(x, x50, xmax, n, b) - 0.8, 0.001, xmax - 0.001)
    except Exception:
        return x50 * 1.5


def batch_validate(inputs: List[KCOInput]) -> List[KCOOutput]:
    """批量验证多组参数"""
    return [calculate_kco(inp) for inp in inputs]
