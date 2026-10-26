"""路由级鉴权集成测试（httpx 直连 FastAPI ASGI 应用）

覆盖真实路由在 BLASTING_API_TOKEN 开关下的行为：
  - 未配置（默认关闭）：写接口直接放行，不被拦截。
  - 配置后：缺少/错误 x-api-token → 401；正确 token → 放行。
  - 读接口始终放行（即使开启鉴权）。

选用 /api/blasting/physics/vibration（写接口、无 DB 依赖）验证，
避免测试环境没有 MySQL 时因 get_db 连接失败导致误报。

说明：本环境为 httpx 0.28.x + starlette 0.35.x，starlette.TestClient 会向
httpx.Client 传 app= 参数（该参数在 httpx 0.28 已移除），且该版本
ASGITransport 仅支持异步（handle_async_request），故用 AsyncClient 直连，
经 asyncio.run 在同步测试中驱动。
"""
import asyncio
import os

import httpx
import pytest

from main import app  # noqa: E402  导入即注册全部路由

API_TOKEN_ENV = "BLASTING_API_TOKEN"


def _request(method: str, path: str, **kwargs):
    """直连 ASGI 应用发起请求（AsyncClient + asyncio.run）"""

    async def _do():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(_do())


# 合法的振动预测请求体（chargeKg / distance 为必填）
VALID_VIBRATION_BODY = {"chargeKg": 10, "distance": 15}


class TestWriteEndpointAuthIntegration:
    """写接口 POST /api/blasting/physics/vibration 鉴权行为"""

    def test_passes_when_auth_disabled(self, monkeypatch):
        """未配置 token（默认关闭）→ 写接口直接放行"""
        monkeypatch.delenv(API_TOKEN_ENV, raising=False)
        resp = _request("POST", "/api/blasting/physics/vibration", json=VALID_VIBRATION_BODY)
        assert resp.status_code == 200

    def test_401_when_header_missing(self, monkeypatch):
        """已启用鉴权但缺少 x-api-token → 401"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        resp = _request("POST", "/api/blasting/physics/vibration", json=VALID_VIBRATION_BODY)
        assert resp.status_code == 401

    def test_401_when_header_wrong(self, monkeypatch):
        """已启用鉴权且 token 错误 → 401"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        resp = _request(
            "POST", "/api/blasting/physics/vibration",
            json=VALID_VIBRATION_BODY,
            headers={"x-api-token": "wrong-token"},
        )
        assert resp.status_code == 401

    def test_passes_with_correct_token(self, monkeypatch):
        """已启用鉴权且 token 正确 → 放行"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        resp = _request(
            "POST", "/api/blasting/physics/vibration",
            json=VALID_VIBRATION_BODY,
            headers={"x-api-token": "secret-token"},
        )
        assert resp.status_code == 200


class TestReadEndpointStaysOpen:
    """读接口保持放行（即使开启鉴权）"""

    def test_health_open_with_auth_enabled(self, monkeypatch):
        """开启鉴权后健康检查仍可访问"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        resp = _request("GET", "/api/health")
        assert resp.status_code == 200

    def test_health_open_when_auth_disabled(self, monkeypatch):
        """未开启鉴权时健康检查可访问"""
        monkeypatch.delenv(API_TOKEN_ENV, raising=False)
        resp = _request("GET", "/api/health")
        assert resp.status_code == 200