"""现场调度（地下巷道铲运机 LHD）HTTP 接口

时序化工况数据查询接口（历史 + 实时统一存储，写入点在各业务模块，
见 app/services/timeseries/ts_store.py 的 record_metric）。

契约：shared-consistency-baseline.json#timeseriesCmps。
"""
from typing import Optional

from fastapi import APIRouter, Query

from app.services.timeseries.retention import MAX_POINTS_PER_QUERY, normalize_downsample
from app.services.timeseries.ts_store import query_timeseries

router = APIRouter(prefix="/api/timeseries", redirect_slashes=False, tags=["时序工况数据"])


def _parse_tags(tags_param: Optional[str]):
    """"k1=v1,k2=v2" → {k1: v1, k2: v2}；空返回 None。"""
    if not tags_param:
        return None
    tags = {}
    for pair in tags_param.split(","):
        k, _, v = pair.partition("=")
        if k and v:
            tags[k.strip()] = v.strip()
    return tags or None


@router.get("/metrics")
def timeseries_metrics():
    """可查指标清单（metric / 序列数 / 点数 / 首末时间戳 / 距最新数据时长）。"""
    from app.services.timeseries.ts_store import get_ts_store

    return {"code": 0, "data": {"metrics": get_ts_store().metrics()}}


@router.get("")
@router.get("/")
def timeseries_query(
    metric: str = Query(..., description="指标名，如 scheduling.muck_stock_t"),
    start: Optional[float] = Query(None, description="起始 Unix 秒（缺省不限）"),
    end: Optional[float] = Query(None, description="截止 Unix 秒（缺省不限）"),
    downsample: str = Query("raw", description="raw | 1m | 1h（1m/1h 按 avg 聚合）"),
    tags: Optional[str] = Query(None, description='序列过滤，"k1=v1,k2=v2"'),
):
    """查询时序指标（时间升序，最多 MAX_POINTS_PER_QUERY 点）。"""
    points = query_timeseries(
        metric,
        start=start,
        end=end,
        tags=_parse_tags(tags),
        downsample_name=downsample,
    )
    return {
        "code": 0,
        "data": {
            **points,
            "maxPoints": MAX_POINTS_PER_QUERY,
            "downsampleName": normalize_downsample(downsample),
        },
    }
