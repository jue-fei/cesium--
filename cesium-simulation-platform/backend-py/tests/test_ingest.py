"""数据接入台账与四类适配器回归测试（方案 WP1 T1.1–T1.7）

覆盖：
  - 四类数据源登记（rest/ws/file/db），台账可举证「集成方式≥4 种」
  - 文件导入（JSON/CSV+BOM）五类质量规则：必填/值域/去重/变化率/时区
  - WS 推送接收、DB 连通性与抽取
  - 批次回溯与拒收明细落库

依赖 MySQL：不可用时整模块跳过（与项目其它测试保持一致的可用性策略）。
"""
import asyncio
import json

import httpx
import pymysql
import pytest

from app.database import DB_CONFIG
from app.services.ingest import store
from main import app


def _db_available() -> bool:
    try:
        conn = pymysql.connect(**DB_CONFIG)
        conn.close()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="MySQL 不可用，跳过接入台账测试")

TEST_PREFIX = "test-"


def _request(method: str, path: str, **kwargs):
    async def _run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_run())


def _purge() -> None:
    """清理测试用数据，避免污染台账（只删 test- 前缀）。"""
    conn = pymysql.connect(**DB_CONFIG)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT batch_no FROM ingest_batch WHERE source_code LIKE %s",
                (TEST_PREFIX + "%",),
            )
            batches = [row["batch_no"] for row in cur.fetchall()]
            if batches:
                placeholders = ",".join(["%s"] * len(batches))
                cur.execute(
                    f"DELETE FROM ingest_reject_log WHERE batch_no IN ({placeholders})",
                    batches,
                )
            cur.execute("DELETE FROM ingest_batch WHERE source_code LIKE %s", (TEST_PREFIX + "%",))
            cur.execute("DELETE FROM data_source WHERE code LIKE %s", (TEST_PREFIX + "%",))
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(scope="module", autouse=True)
def _clean_tables():
    # 必须先建表，否则首次 _purge 会因表不存在而报错
    store.ensure_tables()
    _purge()
    yield
    _purge()


def _create(code: str, kind: str, endpoint: str = "", schema=None):
    return _request(
        "POST",
        "/api/datasource",
        json={
            "code": code,
            "name": code,
            "kind": kind,
            "endpoint": endpoint,
            "schema": schema or {},
        },
    ).json()


# ─── 台账（T1.6）────────────────────────────────────────────
def test_register_four_kinds_and_list():
    for kind in ("file", "rest", "db", "ws"):
        resp = _create(TEST_PREFIX + kind, kind, endpoint="table_x" if kind == "db" else "")
        assert resp["code"] == 0, resp

    data = _request("GET", "/api/datasource").json()["data"]
    codes = {s["code"] for s in data["sources"]}
    assert {
        TEST_PREFIX + "file",
        TEST_PREFIX + "rest",
        TEST_PREFIX + "db",
        TEST_PREFIX + "ws",
    } <= codes
    assert set(data["kinds"]) == {"rest", "ws", "file", "db"}


def test_invalid_kind_rejected():
    resp = _create(TEST_PREFIX + "bad", "ftp")
    assert resp["code"] == 1
    assert "kind" in resp["message"]


# ─── 文件导入 + 五类质量规则（T1.4 / T1.7）────────────────
def test_json_upload_applies_quality_rules():
    schema = {
        "format": "json",
        "mapping": {"pileId": "id", "gradePct": "grade"},
        "required": ["pileId"],
        "ranges": {"gradePct": [0, 5]},
        "uniqueKey": "pileId",
        "maxDelta": {"gradePct": 1.0},
    }
    _create(TEST_PREFIX + "file", "file", schema=schema)

    payload = {
        "rows": [
            {"id": "M1", "grade": 0.8},  # 通过
            {"id": "M1", "grade": 0.9},  # 重复键
            {"id": "M2", "grade": 9.9},  # 越界
            {"grade": 0.7},  # 缺必填
            {"id": "M3", "grade": 1.2},  # 与 M1 差 0.4 → 通过
            {"id": "M4", "grade": 3.5},  # 与 M3 差 2.3 → 变化率超限
        ]
    }
    resp = _request(
        "POST",
        f"/api/datasource/{TEST_PREFIX}file/upload",
        params={"filename": "piles.json"},
        content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    ).json()

    assert resp["code"] == 1  # 存在拒收 → ok=False
    data = resp["data"]
    assert data["rowsTotal"] == 6
    assert data["rowsAccepted"] == 2
    assert data["rowsRejected"] == 4
    assert data["batchNo"].startswith(TEST_PREFIX + "file-")

    batches = _request("GET", f"/api/datasource/{TEST_PREFIX}file/batches").json()["data"][
        "batches"
    ]
    assert batches
    assert batches[0]["batch_no"] == data["batchNo"]
    assert batches[0]["status"] == "partial"


def test_csv_upload_handles_bom_and_timezone():
    schema = {
        "format": "csv",
        "required": ["id"],
        "timeFields": ["ts"],
        "uniqueKey": "id",
    }
    _create(TEST_PREFIX + "file", "file", schema=schema)

    csv_text = "\ufeffid,ts\nM1,2026-10-28T10:00:00Z\nM2,2026-10-28T18:00:00+08:00\n"
    resp = _request(
        "POST",
        f"/api/datasource/{TEST_PREFIX}file/upload",
        params={"filename": "piles.csv"},
        content=csv_text.encode("utf-8"),
    ).json()

    data = resp["data"]
    assert data["rowsAccepted"] == 2
    assert data["rowsRejected"] == 0
    # 两条时间都应归一为 UTC+8 的 18:00
    assert all(sample["ts"].startswith("2026-10-28T18:00:00") for sample in data["sample"])


def test_upload_rejects_invalid_json():
    _create(TEST_PREFIX + "file", "file", schema={"format": "json"})
    resp = _request(
        "POST",
        f"/api/datasource/{TEST_PREFIX}file/upload",
        params={"filename": "broken.json"},
        content=b"{not-json",
    ).json()
    assert resp["code"] == 1
    assert "解析失败" in resp["data"]["message"]


# ─── WS 推送 / DB 抽取（T1.3 / T1.5）──────────────────────
def test_ws_push_receives_rows():
    _create(
        TEST_PREFIX + "ws",
        "ws",
        endpoint="/ws/scheduling/stream",
        schema={"required": ["equipmentId"], "uniqueKey": "equipmentId"},
    )
    resp = _request(
        "POST",
        f"/api/datasource/{TEST_PREFIX}ws/push",
        json={"rows": [{"equipmentId": "LHD-1", "loadT": 12}]},
    ).json()
    assert resp["code"] == 0
    assert resp["data"]["rowsAccepted"] == 1


def test_db_source_test_and_pull():
    _create(TEST_PREFIX + "db", "db", endpoint="borehole_config")

    tested = _request("POST", f"/api/datasource/{TEST_PREFIX}db/test").json()["data"]
    assert tested["ok"] is True

    pulled = _request(
        "POST", f"/api/datasource/{TEST_PREFIX}db/pull", params={"limit": 5}
    ).json()["data"]
    assert pulled["rowsTotal"] > 0
    assert pulled["rowsAccepted"] == pulled["rowsTotal"]


def test_db_source_rejects_illegal_identifier():
    _create(TEST_PREFIX + "db", "db", endpoint="borehole_config; DROP TABLE x")
    tested = _request("POST", f"/api/datasource/{TEST_PREFIX}db/test").json()["data"]
    assert tested["ok"] is False
    assert "非法" in tested["message"]


def test_rest_source_with_empty_endpoint_fails_fast():
    _create(TEST_PREFIX + "rest", "rest", endpoint="")
    tested = _request("POST", f"/api/datasource/{TEST_PREFIX}rest/test").json()["data"]
    assert tested["ok"] is False
    assert tested["message"] == "endpoint 为空"


# ─── 类型校验 ──────────────────────────────────────────────
def test_upload_on_non_file_source_rejected():
    _create(TEST_PREFIX + "ws", "ws", endpoint="/ws/x")
    resp = _request(
        "POST",
        f"/api/datasource/{TEST_PREFIX}ws/upload",
        params={"filename": "x.json"},
        content=b"[]",
    ).json()
    assert resp["code"] == 1
    assert "不是 file 类型" in resp["message"]
