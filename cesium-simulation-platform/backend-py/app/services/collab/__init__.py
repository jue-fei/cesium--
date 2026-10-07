"""collab —— 跨终端协同（3.2.1 起）

首期提供终端/操作员身份：前端生成并经请求头透传，后端解析清洗后供审计消费。
"""
from app.services.collab.identity import (
    HEADER_CLIENT_ID,
    HEADER_OPERATOR,
    actor_of,
    client_identity,
    parse_identity,
)

__all__ = [
    "HEADER_CLIENT_ID",
    "HEADER_OPERATOR",
    "actor_of",
    "client_identity",
    "parse_identity",
]
