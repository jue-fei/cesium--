"""最小鉴权模块（优化方案 B1）

接入方式：通过环境变量开关启用，默认关闭，兼容开发与现有测试。

  - 未配置 `BLASTING_API_TOKEN` 时，require_token 直接放行（无鉴权，行为与改造前一致）。
  - 配置 `BLASTING_API_TOKEN` 后，写接口（POST/PUT/DELETE）必须携带匹配的
    `x-api-token` Header，否则返回 401。

读接口按方案「读接口可先放行」保持开放；`optional_read` 提供"校验但可放行"的
可选读保护，供后续需要时按需挂载。
"""
import os

from fastapi import Header, HTTPException

# 鉴权 token 环境变量名
API_TOKEN_ENV = "BLASTING_API_TOKEN"

# 启动时的 token 快照（供日志 / 文档展示；依赖函数内部动态读取，便于测试隔离环境变量）
API_TOKEN = os.getenv(API_TOKEN_ENV, "").strip()


def _current_token() -> str:
    """运行时读取 token（每次调用读取，便于测试用 monkeypatch 隔离环境变量）"""
    return os.getenv(API_TOKEN_ENV, "").strip()


def require_token(x_api_token: str = Header(default="")) -> None:
    """写接口强制鉴权依赖。

    - 未启用（token 为空）：直接放行。
    - 已启用：Header `x-api-token` 必须与 API_TOKEN 一致，否则抛 401。
    """
    token = _current_token()
    if not token:
        return
    if not x_api_token or x_api_token != token:
        raise HTTPException(
            status_code=401,
            detail="缺少或无效的 x-api-token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def optional_read(x_api_token: str = Header(default="")) -> None:
    """只读接口可选鉴权依赖（当前读接口默认放行，不强制挂载）。

    - 未启用鉴权或请求未携带 Header：放行。
    - 携带了错误的 Header：仍返回 401（避免错误凭据被静默忽略）。
    """
    token = _current_token()
    if not token or not x_api_token:
        return
    if x_api_token != token:
        raise HTTPException(
            status_code=401,
            detail="无效的 x-api-token",
            headers={"WWW-Authenticate": "Bearer"},
        )
