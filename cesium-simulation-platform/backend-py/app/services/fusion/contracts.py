"""孪生融合事件契约（方案 WP0 T0.2 / WP2 T2.1）

前后端共用同一份结构定义；字段一旦变更，必须同步修改
`cesium1/src/services/fusion/twinClient.js` 顶部的事件说明。

事件类型命名约定 `<工序>:<对象>:<动作>`，例如：
    blasting:event:completed   爆破事件结束（携带爆堆信息）
    blasting:zone:changed      爆破危险区变化
    scheduling:tick            调度仿真推进（高频，默认不落库）
    optimization:adopted       多目标方案被采纳
    fusion:action              规则命中后由后端下发的动作指令
"""
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

# 工序标识：与任务书「地质 / 爆破 / 运搬 / 防控」四工序 + 优化与孪生自身对齐
PROC_GEOLOGY = "geology"
PROC_BLASTING = "blasting"
PROC_HAULAGE = "haulage"
PROC_SAFETY = "safety"
PROC_OPTIMIZATION = "optimization"
PROC_TWIN = "twin"

VALID_PROCS = (
    PROC_GEOLOGY,
    PROC_BLASTING,
    PROC_HAULAGE,
    PROC_SAFETY,
    PROC_OPTIMIZATION,
    PROC_TWIN,
)

# 单条事件载荷上限，防止误传大对象（如整个爆破数据集）拖垮总线
MAX_PAYLOAD_BYTES = 64 * 1024


class TwinEventIn(BaseModel):
    """事件上报体（POST /api/twin/events）。"""

    type: str = Field(
        ...,
        min_length=3,
        max_length=128,
        description="事件类型，形如 blasting:event:completed",
    )
    proc: str = Field(
        ...,
        min_length=2,
        max_length=32,
        description="工序：geology/blasting/haulage/safety/optimization/twin",
    )
    payload: Dict[str, Any] = Field(
        default_factory=dict, description="业务载荷，字段由各事件类型约定"
    )
    ts: Optional[float] = Field(
        None, description="事件时间（秒）。缺省取服务端时间"
    )
    source: str = Field(
        "api", max_length=32, description="来源标识：web/api/simulator/rule"
    )


def validate_proc(proc: str) -> str:
    """校验工序标识，非法值直接拒绝，避免脏事件污染规则匹配。"""
    if proc not in VALID_PROCS:
        raise ValueError(
            f"非法工序 {proc!r}，可选值：{', '.join(VALID_PROCS)}"
        )
    return proc


def validate_payload_size(payload: Dict[str, Any], limit: int = MAX_PAYLOAD_BYTES) -> None:
    """粗略估算载荷大小，超限抛出 ValueError。

    不追求精确字节数（序列化开销可忽略），只拦明显超标的误传。
    """
    if not payload:
        return
    text = str(payload)
    if len(text.encode("utf-8")) > limit:
        raise ValueError(f"payload 超过 {limit} 字节上限")


def build_event(
    event_type: str,
    proc: str,
    payload: Optional[Dict[str, Any]] = None,
    ts: Optional[float] = None,
    source: str = "api",
    seq: int = 0,
) -> Dict[str, Any]:
    """构造标准事件字典（与 TwinEventIn 字段一一对应）。"""
    return {
        "type": event_type,
        "proc": proc,
        "payload": payload or {},
        "ts": float(ts) if ts is not None else None,
        "source": source,
        "seq": int(seq),
    }
