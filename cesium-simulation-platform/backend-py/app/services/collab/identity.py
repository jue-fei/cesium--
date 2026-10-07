"""
collab/identity.py —— 跨终端协作身份（3.2.1）

平台无登录体系：终端身份由**前端生成**并经请求头透传，后端只做解析/清洗，
缺省即匿名——**未携带请求头时行为与改造前完全一致**（向后兼容）。

请求头（契约见 shared-consistency-baseline.json#collabCmps.identityHeaders）：
    X-Client-Id：终端 id（前端 crypto.randomUUID 截短，localStorage 持久化）
    X-Operator：操作员显示名（前端本地填写，默认「操作员」）

审计消费：actor = '<operator>@<clientId 前 8 位>'（见 audit_log.append identity 参数），
记录同时落 clientId，供跨端时间线区分「本机 / 他端」。
"""
from urllib.parse import unquote

from fastapi import Header

# 请求头名（小写，真源；契约 collabCmps.identityHeaders 据此锁定）
HEADER_CLIENT_ID = "x-client-id"
HEADER_OPERATOR = "x-operator"

DEFAULT_OPERATOR = "操作员"
ANONYMOUS_CLIENT_ID = "anonymous"

# 清洗上限（防止超长/怪字符污染审计记录）
CLIENT_ID_MAX_LEN = 32
OPERATOR_MAX_LEN = 24
ACTOR_CLIENT_SHORT = 8  # actor 中回显的 clientId 前缀长度

# clientId 仅允许 URL 安全字符（前端 randomUUID 截短天然满足）
_CLIENT_ID_ALLOWED = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


def _sanitize(value: str, max_len: int, allowed: set[str] | None = None) -> str:
    """去空白 + 过滤非法字符 + 截断；空串返回空串（由调用方补缺省）。"""
    s = str(value or "").strip()
    if not s:
        return ""
    if allowed is not None:
        s = "".join(ch for ch in s if ch in allowed)
    else:
        s = "".join(ch for ch in s if ch.isprintable())
    return s[:max_len]


def parse_identity(client_id: str = "", operator: str = "") -> dict:
    """解析/清洗请求头 → {clientId, operator}；缺省补匿名值。

    操作员名可能含中文：前端已 percent-encode（HTTP 头部值必须是 ISO-8859-1），
    此处 unquote 还原；纯 ASCII 输入 unquote 为幂等无副作用。
    """
    cid = _sanitize(unquote(client_id), CLIENT_ID_MAX_LEN, _CLIENT_ID_ALLOWED) or ANONYMOUS_CLIENT_ID
    name = _sanitize(unquote(operator), OPERATOR_MAX_LEN) or DEFAULT_OPERATOR
    return {"clientId": cid, "operator": name}


def actor_of(identity: dict | None) -> str:
    """组装审计 actor：'<operator>@<clientId 前 8 位>'；无身份（None）回退默认操作员。"""
    if identity is None:
        return DEFAULT_OPERATOR
    cid = str(identity.get("clientId") or ANONYMOUS_CLIENT_ID)
    return f"{identity.get('operator') or DEFAULT_OPERATOR}@{cid[:ACTOR_CLIENT_SHORT]}"


def client_identity(
    x_client_id: str = Header(default="", alias="X-Client-Id"),
    x_operator: str = Header(default="", alias="X-Operator"),
) -> dict:
    """FastAPI 依赖：解析终端身份（写路由挂载，未带头等价匿名，向后兼容）。"""
    return parse_identity(x_client_id, x_operator)
