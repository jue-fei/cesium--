"""工序推进 → 孪生事件的挂钩点（方案 WP2 T2.3 / R5）

为什么需要这一层：
- 调度仿真由 WebSocket 推送循环驱动（scheduling_ws），它本身不知道孪生总线的存在；
- 在推送循环里直接 import fusion 会让路由层耦合规则引擎；
- 因此用 hooks 做单向调用：工序推进 → 发轻量事件 → 规则引擎（含 R5）在后端统一求值。

约束：事件 payload 只放小字段（如 scenario），不得把完整快照塞进事件，
否则 1000 条环形缓冲会被放大到几十 MB。
"""
import logging

from app.services.fusion.bus import bus
from app.services.fusion.rules import engine

logger = logging.getLogger(__name__)


def on_scheduling_snapshot(scenario: str, step_seconds: float) -> None:
    """调度推进一帧后触发 `scheduling:tick`（高频事件，不落库）。"""
    try:
        event = bus.publish(
            "scheduling:tick",
            "haulage",
            {"scenario": scenario, "stepSeconds": step_seconds},
            source="simulator",
            persist=False,
        )
        engine.handle(event)
    except Exception as exc:  # noqa: BLE001 - 孪生联动失败不得影响调度推送
        logger.warning("调度 tick 事件发布失败：%s", exc)
