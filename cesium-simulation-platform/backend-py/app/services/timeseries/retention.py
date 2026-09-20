"""
retention.py —— 时序数据降采样与保留策略（纯函数 + 单源常量）

三级保留口径（任务书"历史与实时工况数据"存储策略，契约见
shared-consistency-baseline.json#timeseriesCmps，前端 timeSeriesClient
消费同一套 downsample 枚举）：
  raw  原始点       保留 7 天
  1m   1 分钟聚合   保留 90 天
  1h   1 小时聚合   保留 2 年
"""
import math

# downsample 名称 → 桶宽（秒）；0 表示原始点
BUCKET_SECONDS = {"raw": 0, "1m": 60, "1h": 3600}

# 各粒度保留窗口（秒）
RETENTION_SECONDS = {
    "raw": 7 * 86400,
    "1m": 90 * 86400,
    "1h": 730 * 86400,
}

# 单次查询最大返回点数（防止一次性拉爆前端）
MAX_POINTS_PER_QUERY = 5000


def normalize_downsample(name):
    """校验/归一 downsample 名称，非法回退 'raw'。"""
    if not isinstance(name, str):
        return "raw"
    return name if name in BUCKET_SECONDS else "raw"


def downsample(points, bucket_s, agg="avg"):
    """按固定桶宽聚合时序点（纯函数）。

    @param points: [(ts, value)] 时间升序
    @param bucket_s: 桶宽秒数；<=0 原样返回（裁剪到 MAX_POINTS_PER_QUERY）
    @param agg: 'avg' | 'min' | 'max' | 'last'
    @returns [(ts, value)] ts 为桶起始时刻，保持时间升序
    """
    if not points:
        return []
    if bucket_s <= 0:
        return points[-MAX_POINTS_PER_QUERY:]

    buckets = {}
    for ts, value in points:
        key = math.floor(ts / bucket_s) * bucket_s
        buckets.setdefault(key, []).append(value)

    def _agg(vals):
        if agg == "min":
            return min(vals)
        if agg == "max":
            return max(vals)
        if agg == "last":
            return vals[-1]
        return sum(vals) / len(vals)

    out = [(k, _agg(v)) for k, v in buckets.items()]
    out.sort(key=lambda p: p[0])
    return out[-MAX_POINTS_PER_QUERY:]


def clip_by_retention(points, now_ts, window_s):
    """按保留窗口裁剪旧点（纯函数）。window_s <= 0 表示不裁剪。"""
    if not points or window_s <= 0:
        return points
    floor = now_ts - window_s
    # 时间升序，二分找第一个 >= floor 的位置
    lo, hi = 0, len(points)
    while lo < hi:
        mid = (lo + hi) // 2
        if points[mid][0] < floor:
            lo = mid + 1
        else:
            hi = mid
    return points[lo:]
