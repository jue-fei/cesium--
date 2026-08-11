import os
import logging
import time
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.routes import orebodies, models, trucks, boreholes, monitoring, geology, truck_routes, blasting, blasting_ws

# ─── 日志配置 ──────────────────────────────────────────
# 统一在应用入口配置 root logger，所有模块 getLogger(__name__) 自动继承
# 日志级别由 LOG_LEVEL 环境变量控制（默认 INFO），生产可设为 WARNING
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("app")


def _parse_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _get_cors_origins() -> list[str]:
    raw = os.getenv("CORS_ALLOW_ORIGINS", "").strip()
    if raw:
        origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    else:
        origins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3001",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ]
    return origins or ["http://localhost:3000"]


app = FastAPI(title="Cesium 仿真平台 API", version="1.0.0")

cors_origins = _get_cors_origins()
cors_allow_credentials = _parse_bool_env("CORS_ALLOW_CREDENTIALS", True)

# 浏览器不允许在携带凭证时搭配通配来源，这里自动收紧为无凭证模式。
if "*" in cors_origins and cors_allow_credentials:
    cors_allow_credentials = False

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── 请求/响应/错误日志中间件 ──────────────────────────
# 统一拦截所有 HTTP 请求，记录方法、路径、状态码、耗时；
# 5xx 错误额外记录异常堆栈，便于生产排查。
# WebSocket 握手也经过此处（upgrade 请求），但 ws 生命周期日志由 blasting_ws.py 内部记录。
@app.middleware("http")
async def logging_middleware(request: Request, call_next):
    # 跳过健康检查，避免高频探活刷屏
    if request.url.path == "/api/health":
        return await call_next(request)

    start = time.perf_counter()
    client = request.client.host if request.client else "-"
    method = request.method
    path = request.url.path

    try:
        response = await call_next(request)
    except Exception as exc:
        # 未被路由层捕获的异常（如中间件链断裂）
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.error(
            "%s %s %s 500 %.1fms | 未捕获异常: %s",
            client, method, path, elapsed_ms, exc,
            exc_info=True,
        )
        return JSONResponse(
            status_code=500,
            content={"code": 500, "detail": "内部服务器错误"},
        )

    elapsed_ms = (time.perf_counter() - start) * 1000
    status = response.status_code
    # 按状态码分级日志：2xx→INFO, 4xx→WARNING, 5xx→ERROR
    if status >= 500:
        logger.error("%s %s %s %d %.1fms", client, method, path, status, elapsed_ms)
    elif status >= 400:
        logger.warning("%s %s %s %d %.1fms", client, method, path, status, elapsed_ms)
    else:
        logger.info("%s %s %s %d %.1fms", client, method, path, status, elapsed_ms)
    return response

# 注册路由
app.include_router(orebodies.router)
app.include_router(models.router)
app.include_router(trucks.router)
app.include_router(boreholes.router)
app.include_router(monitoring.router)
app.include_router(geology.router)
app.include_router(truck_routes.router)
app.include_router(blasting.router)
app.include_router(blasting_ws.router)


@app.get("/api/health")
def health_check():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("API_PORT", 3003))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
