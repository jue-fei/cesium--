"""爆破模拟 vs 实测对比报告生成

对比 blasting_result 表中的模拟输出与实测数据，
生成差异分析报告用于爆破设计优化。
"""
from typing import List, Dict, Optional


def compare_multiple_events(results: List[Dict]) -> Dict:
    """多事件横向对比

    Args:
        results: 多个事件的 blasting_result 记录列表

    Returns:
        对比矩阵，用于柱状图展示
    """
    metrics = ['fragment_x50', 'throw_distance_max', 'vibration_peak']
    comparison = {}
    # 空列表保护：避免调用方处理空 comparison 时出错
    if not results:
        for m in metrics:
            comparison[m] = []
        return comparison
    for m in metrics:
        comparison[m] = [
            # 过滤 event_id 为 None 的结果，避免前端渲染异常
            {'event_id': r.get('event_id'), 'value': float(r.get(m, 0) or 0)}
            for r in results
            if r.get('event_id') is not None
        ]
    return comparison
