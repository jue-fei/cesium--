"""操作审计查询（3.3）HTTP 接口

GET /api/audit/logs?limit=&action=&scenario=&before_id=：审计时间线查询。
    倒序（最新在前），动作/场景过滤，before_id 分页（传当前最旧一条的 id）。
    只读端点，无写入（审计记录只由各业务写路由内部追加，不可外部篡改）。
GET /api/audit/actions：动作枚举（id/标签/域），前端不自持映射表，
    新增审计点零前端发布。

契约：{code: 0, data: {entries, hasMore}} / {code: 0, data: {actions}}；
键结构见 shared-consistency-baseline.json#auditCmps。
"""
from typing import Optional

from fastapi import APIRouter

from app.services.audit.audit_log import AUDIT_ACTIONS, query

router = APIRouter(prefix="/api/audit", redirect_slashes=False, tags=["操作审计"])


@router.get("/logs")
def audit_logs(
    limit: int = 50,
    action: Optional[str] = None,
    scenario: Optional[str] = None,
    before_id: Optional[int] = None,
):
    """审计时间线查询（倒序 + 过滤 + before_id 分页）。"""
    return {"code": 0, "data": query(limit=limit, action=action, scenario=scenario, before_id=before_id)}


@router.get("/actions")
def audit_actions():
    """动作枚举下发（前端过滤下拉与域徽标据此渲染）。"""
    actions = [
        {"id": aid, "label": meta["label"], "domain": meta["domain"]}
        for aid, meta in AUDIT_ACTIONS.items()
    ]
    return {"code": 0, "data": {"actions": actions}}
