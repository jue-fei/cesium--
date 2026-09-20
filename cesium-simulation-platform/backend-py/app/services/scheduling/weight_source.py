"""
weight_source.py —— 多目标权重方案外部源适配器（后端）

平台内置 NSGA-III（multi_objective.py）是唯一求解引擎；本模块只负责
"权重方案从哪来"：外部机器学习权重服务（训练与推理在外部完成，平台只
消费推荐结果）→ 未启用/超时/响应非法时降级为等权兜底（degraded=true）。

响应契约（GET /api/scheduling/weights/recommend 的 data 字段，两端契约
见 shared-consistency-baseline.json#weightTuningCmps）：
  { weights: {objectiveId: w}, source: 'ml-external' | 'fallback',
    modelVersion: str, degraded: bool, latencyMs: float }

服务地址等接入配置真源：config/ml_weight_endpoint.json（后端持有，
前端零发布）。
"""
import json
import time
import urllib.request
from pathlib import Path

from app.services.scheduling.multi_objective import OBJECTIVES, normalize_weights

# 目标 id 清单（单源：multi_objective.OBJECTIVES，随契约测试锁定）
OBJECTIVE_IDS = [o["id"] for o in OBJECTIVES]

CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "ml_weight_endpoint.json"
_config_cache = None


def load_weight_config():
    """读取外部权重服务配置（模块级缓存；DB 优先暂无需求，磁盘文件兜底即空）。"""
    global _config_cache
    if _config_cache is None:
        cfg = {}
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except OSError:
            pass  # 配置缺失时按"未启用"降级，不阻断接口
        _config_cache = {
            "enabled": bool(cfg.get("enabled", False)),
            "endpoint": str(cfg.get("endpoint", "")),
            "timeoutMs": int(cfg.get("timeoutMs", 2000)),
            "modelVersion": str(cfg.get("modelVersion", "")),
        }
    return _config_cache


def reset_weight_config_cache():
    """测试钩子：清空配置缓存。"""
    global _config_cache
    _config_cache = None


def _request_external(endpoint, timeout_s, scenario):
    """调用外部 ML 权重服务（POST {scenario, objectiveIds} → {weights, modelVersion?}）。"""
    payload = json.dumps({"scenario": scenario, "objectiveIds": OBJECTIVE_IDS}).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=payload, method="POST",
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    weights = body.get("weights") if isinstance(body, dict) else None
    if not isinstance(weights, dict):
        raise ValueError("外部权重响应缺少 weights 字段")
    return normalize_weights(weights), str(body.get("modelVersion", ""))


def get_weight_recommendation(scenario=""):
    """取推荐权重：外部 ML 服务优先，任何失败降级等权（degraded=true）。

    外部源任何异常（网络/超时/格式）都必须降级返回而非 500——权重推荐
    属增强能力，不可用时不允许阻断调度面板。
    """
    cfg = load_weight_config()
    t0 = time.perf_counter()
    if cfg["enabled"] and cfg["endpoint"]:
        try:
            weights, model_version = _request_external(
                cfg["endpoint"], cfg["timeoutMs"] / 1000.0, scenario)
            return {
                "weights": weights,
                "source": "ml-external",
                "modelVersion": model_version or cfg["modelVersion"],
                "degraded": False,
                "latencyMs": round((time.perf_counter() - t0) * 1000.0, 1),
            }
        except Exception:  # noqa: BLE001 —— 外部源失败必须降级，见 docstring
            pass
    eq = 1.0 / len(OBJECTIVE_IDS)
    return {
        "weights": {k: eq for k in OBJECTIVE_IDS},
        "source": "fallback",
        "modelVersion": cfg["modelVersion"],
        "degraded": True,
        "latencyMs": round((time.perf_counter() - t0) * 1000.0, 1),
    }
