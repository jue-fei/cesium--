"""矿山巷道几何判定（方案 T2.5b）

用途：把"爆破危险区"落到具体巷道段，供 R3 联动封锁使用。

坐标口径（方案 §1.4）：
- 巷道 geometry 来自场景配置 `segments[].polyline3`，元素为 `[x, y, z]`，
  其中 y 为标高（mine 系竖向）；
- 危险区多边形为水平投影 `[[x, z], ...]`；深度用 `elevationRange=[lo, hi]` 约束。

判定策略（固定口径，避免三维求交的性能与歧义）：
1. 任一折线顶点落在多边形内且标高在区间内 → 相交；
2. 任一折线边与多边形边在 XZ 投影相交，且该边标高区间与深度区间有重叠 → 相交。

不追求精确体积相交：巷道是有宽度的实体，本判定按"中线穿过危险区"处理，
下游只用于封锁提示与路径代价抬升，不用于安全距离核算。
"""
from typing import Iterable, List, Optional, Sequence

Point3 = Sequence[float]
Polygon2 = Sequence[Sequence[float]]


def _point_in_polygon(x: float, z: float, polygon: Polygon2) -> bool:
    """射线法：判断点是否在多边形内（含边界的近似处理）。"""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, zi = float(polygon[i][0]), float(polygon[i][1])
        xj, zj = float(polygon[j][0]), float(polygon[j][1])
        # 点恰在顶点上
        if abs(x - xi) < 1e-9 and abs(z - zi) < 1e-9:
            return True
        if (zi > z) != (zj > z):
            cross_x = (xj - xi) * (z - zi) / (zj - zi) + xi
            if x < cross_x:
                inside = not inside
        j = i
    return inside


def _cross(a, b, c) -> float:
    return (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(p1, p2, q1, q2) -> bool:
    """两线段是否相交（XZ 平面）。"""
    d1 = _cross(q1, q2, p1)
    d2 = _cross(q1, q2, p2)
    d3 = _cross(p1, p2, q1)
    d4 = _cross(p1, p2, q2)
    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and (
        (d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)
    ):
        return True
    # 共线重合的边界情形：任一端点落在另一线段上
    return (
        _on_segment(p1, q1, q2)
        or _on_segment(p2, q1, q2)
        or _on_segment(q1, p1, p2)
        or _on_segment(q2, p1, p2)
    )


def _on_segment(p, a, b) -> bool:
    """点 p 是否落在线段 ab 上（容差 1e-9）。"""
    cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if abs(cross) > 1e-9:
        return False
    return (
        min(a[0], b[0]) - 1e-9 <= p[0] <= max(a[0], b[0]) + 1e-9
        and min(a[1], b[1]) - 1e-9 <= p[1] <= max(a[1], b[1]) + 1e-9
    )


def _elev_overlaps(y1: float, y2: float, elevation_range: Optional[Sequence[float]]) -> bool:
    if not elevation_range or len(elevation_range) != 2:
        return True
    lo, hi = float(elevation_range[0]), float(elevation_range[1])
    if lo > hi:
        lo, hi = hi, lo
    return not (max(y1, y2) < lo or min(y1, y2) > hi)


def polyline_hits_zone(
    polyline3: Iterable[Point3],
    polygon_xz: Polygon2,
    elevation_range: Optional[Sequence[float]] = None,
) -> bool:
    """巷道折线是否与危险区相交。"""
    if not polyline3 or len(polygon_xz) < 3:
        return False

    pts: List[tuple] = []
    for p in polyline3:
        if p is None or len(p) < 3:
            continue
        pts.append((float(p[0]), float(p[1]), float(p[2])))
    if not pts:
        return False

    # 1) 顶点落区
    for x, y, z in pts:
        if _elev_overlaps(y, y, elevation_range) and _point_in_polygon(x, z, polygon_xz):
            return True

    # 2) 边相交
    edges = [
        (polygon_xz[i], polygon_xz[(i + 1) % len(polygon_xz)]) for i in range(len(polygon_xz))
    ]
    for i in range(len(pts) - 1):
        x1, y1, z1 = pts[i]
        x2, y2, z2 = pts[i + 1]
        if not _elev_overlaps(y1, y2, elevation_range):
            continue
        a = (x1, z1)
        b = (x2, z2)
        for q1, q2 in edges:
            if _segments_cross(a, b, q1, q2):
                return True
    return False


def segments_in_zone(
    segment_geo: dict,
    polygon_xz: Polygon2,
    elevation_range: Optional[Sequence[float]] = None,
) -> List[str]:
    """返回与危险区相交的巷道段 id 列表（按 id 排序，便于测试断言）。"""
    if not segment_geo or not polygon_xz or len(polygon_xz) < 3:
        return []
    hits = [
        seg_id
        for seg_id, line in segment_geo.items()
        if polyline_hits_zone(line, polygon_xz, elevation_range)
    ]
    return sorted(hits)
