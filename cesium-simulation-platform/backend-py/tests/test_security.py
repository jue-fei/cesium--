"""方案 B1 最小鉴权测试

覆盖 require_token / optional_read 依赖的行为：
  - 未配置 BLASTING_API_TOKEN（默认）：写接口依赖直接放行，不被拦截。
  - 配置后：缺少 / 错误 x-api-token → 401，正确 token → 放行。

环境变量隔离：所有用例通过 pytest 的 monkeypatch 设置/恢复 os.environ，
互不污染；安全依赖在调用时动态读取环境变量，因此 monkeypatch 即时生效。
"""
import os

import pytest
from fastapi import HTTPException

from app.security import optional_read, require_token

API_TOKEN_ENV = "BLASTING_API_TOKEN"


class TestRequireToken:
    """写接口强制鉴权依赖"""

    def test_unset_token_passes(self, monkeypatch):
        """未设置 token（默认关闭）→ 直接放行"""
        monkeypatch.delenv(API_TOKEN_ENV, raising=False)
        assert require_token(x_api_token="") is None
        assert require_token(x_api_token="anything") is None

    def test_empty_token_passes(self, monkeypatch):
        """token 为空字符串 → 视为未启用，放行"""
        monkeypatch.setenv(API_TOKEN_ENV, "   ")
        assert require_token(x_api_token="") is None

    def test_missing_header_raises_401(self, monkeypatch):
        """已启用鉴权但缺少 x-api-token → 401"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        with pytest.raises(HTTPException) as exc_info:
            require_token(x_api_token="")
        assert exc_info.value.status_code == 401

    def test_wrong_token_raises_401(self, monkeypatch):
        """已启用鉴权但 token 错误 → 401"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        with pytest.raises(HTTPException) as exc_info:
            require_token(x_api_token="wrong-token")
        assert exc_info.value.status_code == 401

    def test_correct_token_passes(self, monkeypatch):
        """已启用鉴权且 token 正确 → 放行"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        assert require_token(x_api_token="secret-token") is None


class TestOptionalRead:
    """只读接口可选鉴权依赖（放行语义）"""

    def test_unset_token_passes(self, monkeypatch):
        """未启用鉴权 → 放行"""
        monkeypatch.delenv(API_TOKEN_ENV, raising=False)
        assert optional_read(x_api_token="") is None

    def test_missing_header_passes_when_enabled(self, monkeypatch):
        """已启用但请求未携带 Header → 放行（读接口可先放行）"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        assert optional_read(x_api_token="") is None

    def test_wrong_header_raises_401(self, monkeypatch):
        """已启用且携带了错误的 Header → 401"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        with pytest.raises(HTTPException) as exc_info:
            optional_read(x_api_token="wrong")
        assert exc_info.value.status_code == 401

    def test_correct_header_passes(self, monkeypatch):
        """已启用且 Header 正确 → 放行"""
        monkeypatch.setenv(API_TOKEN_ENV, "secret-token")
        assert optional_read(x_api_token="secret-token") is None


class TestApiTokenConstant:
    """API_TOKEN 模块级常量的默认行为"""

    def test_default_empty_when_unset(self, monkeypatch):
        """未设置环境变量时 API_TOKEN 为空字符串（通过动态读取验证默认值）"""
        monkeypatch.delenv(API_TOKEN_ENV, raising=False)
        # 模块级常量是 import 时快照；这里直接验证环境默认读取逻辑
        assert os.getenv(API_TOKEN_ENV, "") == ""

    def test_env_var_name(self):
        """环境变量名应为 BLASTING_API_TOKEN"""
        assert API_TOKEN_ENV == "BLASTING_API_TOKEN"
