"""3.2.1/3.2.2 跨终端协同——契约（shared-consistency-baseline.json#collabCmps）与行为测试。

契约双端锁定：本文件与前端 cesium1/src/features/shared/services/__tests__/
collabContract.test.js 共用 collabCmps 段，任一端请求头名/actor 格式/缺省值/清洗上限/
广播通道/帧类型/事件键 不同步即失败。

覆盖：
  - 契约：identityHeaders / defaultOperator / anonymousClientId / 清洗上限 与 baseline 一致
  - 契约：wsUrl / clientFrames / serverFrames / eventKeys / heartbeatTimeoutMs 与 baseline 一致
  - parse_identity：缺省补匿名、字符清洗、截断、中文操作员名保留
  - actor_of：'<operator>@<clientId:8>' 组装、无身份回退默认操作员
  - 审计落库：append(identity=...) → actor 组装 + clientId 键；不带 identity 保持旧行为
  - 路由接线：11 个审计点所属路由均经 client_identity 依赖并透传 identity=identity
  - 协作广播：连接/断开/无订阅静默/投递 collab_event/死连接清理
  - 审计→广播：落盘成功触发广播（带 actor/clientId），落盘失败不广播
"""

import asyncio
import json
from pathlib import Path
from urllib.parse import quote

from app.routes.collab_ws import HEARTBEAT_TIMEOUT_S
from app.routes.collab_ws import router as collab_router
from app.services.audit import audit_log
from app.services.collab import broadcaster as bc
from app.services.collab.broadcaster import EVENT_FIELDS, CollabBroadcaster
from app.services.collab.identity import (
    ANONYMOUS_CLIENT_ID,
    CLIENT_ID_MAX_LEN,
    DEFAULT_OPERATOR,
    OPERATOR_MAX_LEN,
    actor_of,
    client_identity,
    parse_identity,
)
from app.services.collab.identity import HEADER_CLIENT_ID, HEADER_OPERATOR

REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE = json.loads(
    (REPO_ROOT / "shared-consistency-baseline.json").read_text(encoding="utf-8")
)["collabCmps"]


# ---------- 契约（collabCmps）----------

def test_identity_headers_match_baseline():
    assert HEADER_CLIENT_ID.lower() == BASELINE["identityHeaders"]["clientId"].lower()
    assert HEADER_OPERATOR.lower() == BASELINE["identityHeaders"]["operator"].lower()


def test_defaults_and_limits_match_baseline():
    assert DEFAULT_OPERATOR == BASELINE["defaultOperator"]
    assert ANONYMOUS_CLIENT_ID == BASELINE["anonymousClientId"]
    assert CLIENT_ID_MAX_LEN == BASELINE["clientIdMaxLen"]
    assert OPERATOR_MAX_LEN == BASELINE["operatorMaxLen"]


# ---------- parse_identity ----------

def test_parse_identity_defaults_to_anonymous():
    assert parse_identity() == {"clientId": ANONYMOUS_CLIENT_ID, "operator": DEFAULT_OPERATOR}
    assert parse_identity("", "   ") == {
        "clientId": ANONYMOUS_CLIENT_ID, "operator": DEFAULT_OPERATOR,
    }


def test_parse_identity_sanitizes_client_id():
    # 非法字符（空格/斜杠/中文）被过滤，仅保留 URL 安全字符
    ident = parse_identity("ab cd/ef我!", "张三")
    assert ident["clientId"] == "abcdef"
    assert ident["operator"] == "张三"


def test_parse_identity_truncates_to_limits():
    ident = parse_identity("x" * 100, "名" * 100)
    assert len(ident["clientId"]) == CLIENT_ID_MAX_LEN
    assert len(ident["operator"]) == OPERATOR_MAX_LEN


def test_client_identity_dependency_reads_headers():
    ident = client_identity(x_client_id="abc123", x_operator="李四")
    assert ident == {"clientId": "abc123", "operator": "李四"}


def test_parse_identity_decodes_percent_encoded_operator():
    """回归：HTTP 头部值须 ISO-8859-1，前端对中文操作员名 percent-encode，
    后端须 unquote 还原（否则 fetch 抛 non ISO-8859-1 code point）。"""
    ident = parse_identity("term-1", quote("张三"))
    assert ident == {"clientId": "term-1", "operator": "张三"}
    # 纯 ASCII 输入 unquote 幂等
    assert parse_identity("term-1", "Agent-1") == {"clientId": "term-1", "operator": "Agent-1"}


def test_client_identity_dependency_decodes_operator_header():
    ident = client_identity(x_client_id="term-1", x_operator=quote("李四"))
    assert ident == {"clientId": "term-1", "operator": "李四"}


# ---------- actor_of ----------

def test_actor_of_format():
    ident = {"clientId": "abcdef1234567890", "operator": "王五"}
    assert actor_of(ident) == "王五@abcdef12"  # clientId 取前 8 位


def test_actor_of_without_identity_falls_back():
    assert actor_of(None) == DEFAULT_OPERATOR
    assert actor_of({}) == f"{DEFAULT_OPERATOR}@{ANONYMOUS_CLIENT_ID[:8]}"


# ---------- 审计落库 ----------

def test_append_with_identity_records_actor_and_client_id(tmp_path, monkeypatch):
    log_file = tmp_path / "audit-log.jsonl"
    monkeypatch.setattr(audit_log, "AUDIT_DIR", tmp_path)
    monkeypatch.setattr(audit_log, "AUDIT_FILE", log_file)
    monkeypatch.setattr(audit_log, "_last_id", 0)

    audit_log.append(
        "deployment.save", "保存部署", scenario="ashale",
        identity={"clientId": "term-0001-abcd", "operator": "张三"},
    )
    rec = audit_log.query()["entries"][0]
    assert rec["actor"] == "张三@term-000"
    assert rec["clientId"] == "term-0001-abcd"
    assert set(rec) == set(json.loads(
        (REPO_ROOT / "shared-consistency-baseline.json").read_text(encoding="utf-8")
    )["auditCmps"]["entryKeys"])


def test_append_without_identity_keeps_legacy_behavior(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_log, "AUDIT_DIR", tmp_path)
    monkeypatch.setattr(audit_log, "AUDIT_FILE", tmp_path / "audit-log.jsonl")
    monkeypatch.setattr(audit_log, "_last_id", 0)

    audit_log.append("scheduling.reset", "重置")
    rec = audit_log.query()["entries"][0]
    assert rec["actor"] == "operator"   # 旧默认（向后兼容）
    assert rec["clientId"] == ""


# ---------- 路由接线（防枚举与实现脱节）----------

def test_audit_routes_inject_identity():
    """11 个审计点所属路由必须经 client_identity 依赖并透传 identity=identity。"""
    routes_dir = Path(__file__).resolve().parents[1] / "app" / "routes"
    expected = {"deployment.py": 1, "scheduling.py": 5, "blasting.py": 5}
    for fname, count in expected.items():
        src = (routes_dir / fname).read_text(encoding="utf-8")
        assert "client_identity" in src, f"{fname} 未接入 client_identity 依赖"
        assert src.count("identity=identity") == count, (
            f"{fname} 透传 identity 的审计点数量应为 {count}"
        )


# ---------- 3.2.2 协作广播：契约 ----------

def test_broadcast_contract_matches_baseline():
    assert BASELINE["wsUrl"] == "/ws/collab"
    assert set(BASELINE["eventKeys"]) == set(EVENT_FIELDS)
    assert HEARTBEAT_TIMEOUT_S * 1000 == BASELINE["heartbeatTimeoutMs"]
    # 端点注册在协作路由上
    assert any(r.path == "/ws/collab" for r in collab_router.routes)


def test_frame_types_planted_in_sources():
    """服务端帧类型须真实植入 broadcaster / collab_ws 源码（防枚举与实现脱节）。"""
    src_dir = Path(__file__).resolve().parents[1] / "app"
    combined = (
        (src_dir / "services" / "collab" / "broadcaster.py").read_text(encoding="utf-8")
        + (src_dir / "routes" / "collab_ws.py").read_text(encoding="utf-8")
    )
    for frame in BASELINE["serverFrames"] + BASELINE["clientFrames"]:
        assert f'"{frame}"' in combined, f"帧类型 {frame} 未在源码中植入"


# ---------- 3.2.2 协作广播：行为 ----------

class _FakeWs:
    """最小 WebSocket 替身：记录 send_text，可选择抛错模拟断连。"""

    def __init__(self, fail=False):
        self.sent: list[str] = []
        self.accepted = False
        self._fail = fail

    async def accept(self):
        self.accepted = True

    async def send_text(self, text):
        if self._fail:
            raise RuntimeError("connection closed")
        self.sent.append(text)


def test_broadcaster_connect_disconnect():
    async def run():
        b = CollabBroadcaster()
        ws = _FakeWs()
        await b.connect(ws, "ashale")
        assert ws.accepted is True
        assert b.subscriber_count("ashale") == 1
        assert b.subscriber_count() == 1
        b.disconnect(ws, "ashale")
        assert b.subscriber_count("ashale") == 0
        assert b.subscriber_count() == 0

    asyncio.run(run())


def test_publish_without_subscribers_is_noop():
    # 无订阅者 → 静默返回（不抛错，不缓存）
    CollabBroadcaster().publish("ashale", {"id": 1, "action": "deployment.save"})


def test_publish_delivers_collab_event():
    async def run():
        b = CollabBroadcaster()
        ws = _FakeWs()
        await b.connect(ws, "ashale")
        b.publish("ashale", {
            "id": 7, "ts": "2026-10-07T10:00:00", "actor": "张三@term-000",
            "clientId": "term-0001", "action": "deployment.save",
            "scenario": "ashale", "summary": "保存部署", "ok": True,
        })
        await asyncio.sleep(0.05)  # 让投递到主循环的广播协程执行
        return ws.sent

    sent = asyncio.run(run())
    assert sent, "订阅者应收到协作事件帧"
    frame = json.loads(sent[0])
    assert frame["type"] == "collab_event"
    assert set(frame["data"]) == set(EVENT_FIELDS)
    assert frame["data"]["action"] == "deployment.save"
    assert frame["data"]["clientId"] == "term-0001"


def test_dead_connection_cleaned_on_broadcast():
    async def run():
        b = CollabBroadcaster()
        await b.connect(_FakeWs(fail=True), "ashale")
        await b._broadcast("ashale", "{}")
        return b.subscriber_count("ashale")

    assert asyncio.run(run()) == 0


# ---------- 3.2.2 审计 → 广播 接线 ----------

def test_audit_append_broadcasts_record(monkeypatch, tmp_path):
    monkeypatch.setattr(audit_log, "AUDIT_DIR", tmp_path)
    monkeypatch.setattr(audit_log, "AUDIT_FILE", tmp_path / "audit-log.jsonl")
    monkeypatch.setattr(audit_log, "_last_id", 0)
    captured = []
    monkeypatch.setattr(bc, "publish", lambda scenario, record: captured.append(
        (scenario, dict(record))))

    audit_log.append("deployment.save", "保存部署", scenario="ashale",
                     identity={"clientId": "term-0001-abcd", "operator": "张三"})

    assert captured, "审计落盘成功应触发协作广播"
    scenario, rec = captured[0]
    assert scenario == "ashale"
    assert rec["action"] == "deployment.save"
    assert rec["actor"] == "张三@term-000"
    assert rec["clientId"] == "term-0001-abcd"


def test_broadcast_skipped_when_write_fails(monkeypatch, tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("not a dir", encoding="utf-8")
    monkeypatch.setattr(audit_log, "AUDIT_DIR", blocker / "audit")
    monkeypatch.setattr(audit_log, "AUDIT_FILE", blocker / "audit" / "audit-log.jsonl")
    captured = []
    monkeypatch.setattr(bc, "publish", lambda scenario, record: captured.append(scenario))

    audit_log.append("scheduling.reset", "重置", scenario="ashale")

    assert captured == [], "落盘失败不得广播"
