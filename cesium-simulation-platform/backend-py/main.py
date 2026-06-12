import os
from datetime import datetime
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import orebodies, models, trucks, boreholes, monitoring, geology, truck_routes

app = FastAPI(title="Cesium 仿真平台 API", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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