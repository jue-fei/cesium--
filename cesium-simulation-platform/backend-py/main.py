import os
from datetime import datetime
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import orebodies, models, trucks, boreholes, monitoring, geology, truck_routes


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

# 注册路由
app.include_router(orebodies.router)
app.include_router(models.router)
app.include_router(trucks.router)
app.include_router(boreholes.router)
app.include_router(monitoring.router)
app.include_router(geology.router)
app.include_router(truck_routes.router)


@app.get("/api/health")
def health_check():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("API_PORT", 3003))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
