"""时序化工况数据层（pytest，从 backend-py 根目录运行）。

锁定 timeseries 域行为：降采样/保留策略（retention.py 纯函数）、内存存储
读写与序列过滤、统一写入点 record_metric 失败静默、路由直调返回契约
（与 shared-consistency-baseline.json#timeseriesCmps 一致，前端
timeSeriesClient.js 消费同一枚举）。
"""

import time

import pytest

from app.routes.timeseries import timeseries_metrics, timeseries_query
from app.services.timeseries.retention import (
    BUCKET_SECONDS,
    MAX_POINTS_PER_QUERY,
    clip_by_retention,
    downsample,
    normalize_downsample,
)
from app.services.timeseries.ts_store import (
    MemoryTsStore,
    record_metric,
    reset_ts_store,
)

# ---------- retention 纯函数 ----------

def test_downsample_avg_buckets():
    points = [(0, 1.0), (30, 3.0), (60, 5.0), (119, 7.0), (120, 9.0)]
    out = downsample(points, 60, "avg")
    # 桶 [0,60): avg(1,3)=2；[60,120): avg(5,7)=6；[120,180): 9
    assert [(t, round(v, 6)) for t, v in out] == [(0, 2.0), (60, 6.0), (120, 9.0)]


def test_downsample_min_max_last():
    points = [(0, 4.0), (10, 2.0), (20, 8.0)]
    assert downsample(points, 60, "min") == [(0, 2.0)]
    assert downsample(points, 60, "max") == [(0, 8.0)]
    assert downsample(points, 60, "last") == [(0, 8.0)]


def test_downsample_raw_caps_points():
    points = [(float(i), float(i)) for i in range(MAX_POINTS_PER_QUERY + 500)]
    out = downsample(points, 0)
    assert len(out) == MAX_POINTS_PER_QUERY
    assert out[-1][0] == points[-1][0]  # 保留最新


def test_clip_by_retention():
    now = 1000.0
    points = [(float(t), 0.0) for t in range(0, 1000, 100)]
    kept = clip_by_retention(points, now, 350.0)
    assert kept[0][0] == 700.0  # >= now-350 的第一个点
    assert clip_by_retention(points, now, 0) == points


def test_normalize_downsample_and_buckets():
    assert normalize_downsample("1h") == "1h"
    assert normalize_downsample("bogus") == "raw"
    assert BUCKET_SECONDS == {"raw": 0, "1m": 60, "1h": 3600}


# ---------- MemoryTsStore ----------

def _store():
    return MemoryTsStore()


def test_memory_roundtrip_and_tag_filter():
    s = _store()
    now = time.time()
    for i in range(10):
        s.write("m.a", now - 100 + i, i, tags={"equipId": "E1"})
        s.write("m.a", now - 100 + i, i * 10, tags={"equipId": "E2"})
        s.write("m.b", now - 100 + i, i, tags={"equipId": "E1"})

    pts = s.query("m.a", tags={"equipId": "E2"})
    assert [p[1] for p in pts] == [i * 10 for i in range(10)]
    assert len(s.query("m.a")) == 20
    assert len(s.query("m.b")) == 10

    window = s.query("m.a", start=now - 95, end=now - 92)
    # 两个序列各有 i∈[5,8] 四个点落在窗口内
    assert len(window) == 8


def test_memory_metrics_summary():
    s = _store()
    now = time.time()
    s.write("x", now, 1.0, tags={"a": "1"})
    s.write("x", now, 2.0, tags={"a": "2"})
    s.write("y", now, 3.0)
    ms = {m["metric"]: m for m in s.metrics()}
    assert ms["x"]["seriesCount"] == 2
    assert ms["x"]["pointCount"] == 2
    assert ms["y"]["pointCount"] == 1


def test_memory_write_rejects_non_numeric():
    s = _store()
    now = time.time()
    assert s.write("bad", now, "oops") is False
    assert s.query("bad") == []


# ---------- 统一写入点与路由直调 ----------

@pytest.fixture()
def isolated_memory_store(monkeypatch):
    reset_ts_store()
    store = MemoryTsStore()
    monkeypatch.setattr("app.services.timeseries.ts_store._store", store)
    monkeypatch.setattr("app.services.timeseries.ts_store._store_tried", True)
    yield store
    reset_ts_store()


def test_record_metric_swallows_store_failure(isolated_memory_store, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("store down")
    monkeypatch.setattr(isolated_memory_store, "write", boom)
    assert record_metric("x", 1.0) is False


def test_query_route_contract(isolated_memory_store):
    now = time.time()
    isolated_memory_store.write("scheduling.muck_stock_t", now - 60, 10.0)
    isolated_memory_store.write("scheduling.muck_stock_t", now, 20.0)

    res = timeseries_query(
        metric="scheduling.muck_stock_t", start=None, end=None, tags=None, downsample="1m"
    )
    assert res["code"] == 0
    data = res["data"]
    assert data["metric"] == "scheduling.muck_stock_t"
    assert data["downsample"] == "1m"
    assert data["downsampleName"] == "1m"
    assert data["maxPoints"] == MAX_POINTS_PER_QUERY
    # 两点分属不同 1 分钟桶，各桶 avg 保留
    assert len(data["points"]) == 2
    assert data["points"][-1]["v"] == pytest.approx(20.0)


def test_metrics_route_contract(isolated_memory_store):
    isolated_memory_store.write("scheduling.fleet_loaded_count", time.time(), 3.0)
    res = timeseries_metrics()
    assert res["code"] == 0
    names = [m["metric"] for m in res["data"]["metrics"]]
    assert "scheduling.fleet_loaded_count" in names
