"""3.2.1 跨终端协作身份——契约（shared-consistency-baseline.json#collabCmps）与行为测试。

契约双端锁定：本文件与前端 cesium1/src/features/shared/services/__tests__/
collabContract.test.js 共用 collabCmps 段，任一端请求头名/actor 格式/缺省值/清洗上限
不同步即失败。

覆盖：
  - 契约：identityHeaders / defaultOperator / anonymousClientId / 清洗上限 与 baseline 一致
  - parse_identity：缺省补匿名、字符清洗、截断、中文操作员名保留
  - actor_of：'<operator>@<clientId:8>' 组装、无身份回退默认操作员
  - 审计落库：append(identity=...) → actor 组装 + clientId 键；不带 identity 保持旧行为
  - 路由接线：11 个审计点所属路由均经 client_identity 依赖并透传 identity=identity
"""

import json
from pathlib import Path

from app.services.audit import audit_log
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
