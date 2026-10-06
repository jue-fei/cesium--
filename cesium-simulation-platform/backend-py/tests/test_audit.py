"""3.3 操作审计——契约（shared-consistency-baseline.json#auditCmps）与行为测试。

契约双端锁定：本文件与前端 auditContract.test.js 共用 auditCmps 段，
任一端动作枚举/记录键/API 路径不同步即失败。
"""
import json
from pathlib import Path

import pytest

from app.routes.audit import audit_actions, audit_logs
from app.services.audit import audit_log

BASELINE = json.loads(
    (Path(__file__).resolve().parents[2] / "shared-consistency-baseline.json").read_text(
        encoding="utf-8"
    )
)["auditCmps"]

# 独立小 app：路由注册与处理器签名检查不经过 main.py（不拉起数据库等重依赖）
from app.routes.audit import router as _router


@pytest.fixture()
def isolated_log(tmp_path, monkeypatch):
    """把审计文件指到临时目录并清零 id 水位，测试间互不串扰。"""
    log_file = tmp_path / "audit-log.jsonl"
    monkeypatch.setattr(audit_log, "AUDIT_DIR", tmp_path)
    monkeypatch.setattr(audit_log, "AUDIT_FILE", log_file)
    monkeypatch.setattr(audit_log, "_last_id", 0)
    return log_file


# ---------- 契约（auditCmps）----------


def test_baseline_audit_cmps_structure():
    assert BASELINE["api"]["logs"] == "GET /api/audit/logs"
    assert BASELINE["api"]["actions"] == "GET /api/audit/actions"
    assert set(BASELINE["actionIds"]) == set(audit_log.AUDIT_ACTIONS)
    assert set(BASELINE["domains"]) == {
        meta["domain"] for meta in audit_log.AUDIT_ACTIONS.values()
    }


def test_route_table_matches_baseline():
    table = {
        (m, r.path) for r in _router.routes if hasattr(r, "methods") for m in r.methods
    }
    assert ("GET", "/api/audit/logs") in table
    assert ("GET", "/api/audit/actions") in table
    # 审计只读：不得存在写入端点（记录仅由业务路由内部追加，外部不可篡改）
    write_methods = {"POST", "PUT", "DELETE", "PATCH"}
    assert not any(m in write_methods for m, _ in table)


def test_entry_and_action_keys_match_baseline():
    assert set(BASELINE["entryKeys"]) == {
        "id", "ts", "actor", "action", "scenario", "summary", "detail", "ok",
    }
    assert set(BASELINE["actionItemKeys"]) == {"id", "label", "domain"}


def test_audit_points_planted_in_route_sources():
    """11 个审计点必须真实植入对应路由源码（防止枚举与实现脱节）。"""
    src_dir = Path(__file__).resolve().parents[1] / "app" / "routes"
    files = {
        "deployment.save": "deployment.py",
        "muck_task.update": "scheduling.py",
        "scheduling.solve": "scheduling.py",
        "scheduling.reset": "scheduling.py",
        "scheduling.apply": "scheduling.py",
        "scheduling.blastpile": "scheduling.py",
        "blasting.event.create": "blasting.py",
        "blasting.event.update": "blasting.py",
        "blasting.event.delete": "blasting.py",
        "blasting.design.save": "blasting.py",
        "blasting.result.save": "blasting.py",
    }
    for action_id, fname in files.items():
        src = (src_dir / fname).read_text(encoding="utf-8")
        assert f'"{action_id}"' in src, f"{fname} 缺少审计点 {action_id}"


# ---------- 行为（append / query / HTTP）----------


def test_append_and_query_roundtrip(isolated_log):
    audit_log.append("scheduling.reset", "重置仿真器", scenario="large")
    audit_log.append("deployment.save", "保存部署", scenario="large",
                     detail={"deployments": {"LHD-01": {"node": "S0", "level": 4}}})
    audit_log.append("blasting.event.create", "新建事件", detail={"eventId": "E001"})

    result = audit_log.query()
    # 倒序：最新在前；记录键与 baseline 对齐
    assert [e["id"] for e in result["entries"]] == [3, 2, 1]
    assert set(result["entries"][0]) == set(BASELINE["entryKeys"])
    assert result["hasMore"] is False

    # 过滤：动作 + 场景
    only_deploy = audit_log.query(action="deployment.save", scenario="large")
    assert len(only_deploy["entries"]) == 1
    assert only_deploy["entries"][0]["detail"]["deployments"]["LHD-01"]["node"] == "S0"

    # before_id 分页：取 id < 3 → 剩 2 条；limit=1 → hasMore=True
    page = audit_log.query(before_id=3, limit=1)
    assert [e["id"] for e in page["entries"]] == [2]
    assert page["hasMore"] is True


def test_query_empty_file(isolated_log):
    assert isolated_log.exists() is False
    result = audit_log.query()
    assert result == {"entries": [], "hasMore": False}


def test_append_failure_never_raises(monkeypatch, tmp_path):
    """审计写入失败只 warning，绝不阻断业务路由。"""
    # 用一个文件占位目录 → mkdir 失败 → OSError 路径
    blocker = tmp_path / "blocker"
    blocker.write_text("not a dir", encoding="utf-8")
    monkeypatch.setattr(audit_log, "AUDIT_DIR", blocker / "audit")
    monkeypatch.setattr(audit_log, "AUDIT_FILE", blocker / "audit" / "audit-log.jsonl")
    monkeypatch.setattr(audit_log, "_last_id", 0)
    audit_log.append("scheduling.reset", "不应抛错")  # 不抛错即通过


def test_http_logs_and_actions_handlers(isolated_log):
    audit_log.append("deployment.save", "保存部署：1 台落位", scenario="large",
                     detail={"applied": ["LHD-01"], "skipped": []})
    audit_log.append("scheduling.apply", "提交派单：2 台", scenario="large")

    # 处理器直调（同步路由函数），响应结构与 baseline 键对齐
    logs = audit_logs()
    assert logs["code"] == 0
    assert set(logs["data"]) == set(BASELINE["logResponseDataKeys"])
    assert [e["id"] for e in logs["data"]["entries"]] == [2, 1]
    assert logs["data"]["hasMore"] is False

    # 过滤参数透传
    only_one = audit_logs(action="scheduling.apply")
    assert len(only_one["data"]["entries"]) == 1

    actions = audit_actions()
    assert actions["code"] == 0
    assert len(actions["data"]["actions"]) == len(BASELINE["actionIds"])
    assert all(set(a) == set(BASELINE["actionItemKeys"]) for a in actions["data"]["actions"])
