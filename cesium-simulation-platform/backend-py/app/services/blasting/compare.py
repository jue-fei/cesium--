"""爆破模拟 vs 实测对比报告生成

对比 blasting_result 表中的模拟输出与实测数据，
生成差异分析报告用于爆破设计优化。
"""
from dataclasses import dataclass, field
from typing import List, Dict, Optional


@dataclass
class ComparisonItem:
    """单项对比"""
    metric: str        # 指标名
    simulated: float   # 模拟值
    measured: float    # 实测值
    error: float       # 绝对误差
    error_pct: float   # 相对误差(%)


def generate_report(simulated: Dict, measured: Dict) -> Dict:
    """生成对比报告
    
    Args:
        simulated: 模拟结果字典（blasting_result字段）
        measured: 实测结果字典（同结构）
    
    Returns:
        {
            'items': [ComparisonItem...],
            'overall_score': float,  # 0-100
            'summary': str
        }
    """
    metrics = [
        ('fragment_x50', '中位块度'),
        ('fragment_xmax', '最大块度'),
        ('throw_distance_max', '最大抛掷距离'),
        ('vibration_velocity_max', '最大振动速度'),
        ('crater_depth', '漏斗深度'),
        ('crater_radius', '漏斗半径'),
    ]
    
    items = []
    for key, label in metrics:
        sim = float(simulated.get(key, 0) or 0)
        meas = float(measured.get(key, 0) or 0)
        if meas == 0:
            error_pct = 0.0 if sim == 0 else 100.0
        else:
            error_pct = abs(sim - meas) / meas * 100
        items.append(ComparisonItem(
            metric=label,
            simulated=sim,
            measured=meas,
            error=abs(sim - meas),
            error_pct=error_pct
        ))
    
    # 总评分：误差越小分数越高
    avg_error = sum(i.error_pct for i in items) / max(1, len(items))
    overall_score = max(0, 100 - avg_error)
    
    if overall_score >= 80:
        summary = "模拟结果与实测高度吻合"
    elif overall_score >= 60:
        summary = "模拟结果与实测基本吻合，部分指标需校准"
    else:
        summary = "模拟结果与实测偏差较大，建议重新标定参数"
    
    return {
        'items': [{'metric': i.metric, 'simulated': i.simulated, 'measured': i.measured, 
                    'error': i.error, 'error_pct': round(i.error_pct, 2)} for i in items],
        'overall_score': round(overall_score, 1),
        'summary': summary
    }


def compare_multiple_events(results: List[Dict]) -> Dict:
    """多事件横向对比
    
    Args:
        results: 多个事件的 blasting_result 记录列表
    
    Returns:
        对比矩阵，用于柱状图展示
    """
    metrics = ['fragment_x50', 'throw_distance_max', 'vibration_peak']
    comparison = {}
    for m in metrics:
        comparison[m] = [
            {'event_id': r.get('event_id'), 'value': float(r.get(m, 0) or 0)}
            for r in results
        ]
    return comparison
