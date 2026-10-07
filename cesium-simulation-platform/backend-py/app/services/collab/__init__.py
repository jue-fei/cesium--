"""collab —— 跨终端协同

3.2.1 终端/操作员身份：前端生成并经请求头透传，后端解析清洗后供审计消费。
3.2.2 协作事件广播：写操作落审计后投递给 /ws/collab 订阅终端。
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
