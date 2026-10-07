"""3.2.4 现场调度 WS 多终端修复——单一推进循环 + 多订阅者广播。

回归重点：原实现每个连接各起一个推进循环共同推进**共享**仿真器，N 个终端在线时
仿真时间被 N 倍加速。本用例锁定"多订阅者只推进一次、且所有订阅者都收到同一帧"。
"""

import asyncio
import json

from app.routes.scheduling_ws import (
    DEFAULT_INTERVAL_S,
    MAX_INTERVAL_S,
    MIN_INTERVAL_S,
    SchedulingStreamManager,
    _channel_key,
    _clamp_interval,
)
from app.services.scheduling.scenario_config import DEFAULT_SCENARIO


class _FakeSim:
    """最小仿真器替身：统计 tick 次数，快照回传 tick 计数。"""

    dt = 5.0

    def __init__(self):
        self.ticks = 0

    def tick(self):
        self.ticks += 1

    def snapshot(self):
        return {"t": self.ticks}


class _FakeWs:
    def __init__(self, fail=False):
        self.sent: list[str] = []
        self.accepted = False
        self._fail = fail

    async def accept(self):
        self.accepted = True

    async def send_text(self, text):
        if self._fail:
            raise RuntimeError("connection closed")
        self.sent.append(text)


KEY = ("ashale", "main")


def test_channel_key_separates_scenario_and_channel():
    assert _channel_key("", "") == (DEFAULT_SCENARIO, "main")
    assert _channel_key("large", "b") == ("large", "b")
    # 不同场景/频道互不串扰
    assert _channel_key("ashale", "a") != _channel_key("large", "a")
    assert _channel_key("ashale", "a") != _channel_key("ashale", "b")


def test_clamp_interval():
    assert _clamp_interval(100) == MAX_INTERVAL_S
    assert _clamp_interval(0.1) == MIN_INTERVAL_S
    assert _clamp_interval(5) == 5.0
    assert _clamp_interval("3") == 3.0
    assert _clamp_interval("x") is None
    assert _clamp_interval(-1) is None


def test_multi_subscriber_advances_once_and_broadcasts_to_all():
    """核心回归：2 个订阅者 → 每次 tick_once 只推进一次共享仿真器，且两人都收到帧。"""

    async def run():
        m = SchedulingStreamManager()
        sim = _FakeSim()
        a, b = _FakeWs(), _FakeWs()
        await m.connect(a, KEY)
        await m.connect(b, KEY)
        for _ in range(3):
            await m.tick_once(KEY, sim)
        return sim.ticks, a.sent, b.sent

    ticks, a_sent, b_sent = asyncio.run(run())

    expected_per_tick = max(1, int(DEFAULT_INTERVAL_S) // _FakeSim.dt)
    assert ticks == 3 * expected_per_tick, "多订阅者不得重复推进（否则仿真时间成倍加速）"
    assert len(a_sent) == 3 and len(b_sent) == 3, "每个订阅者都应收到每次广播"
    assert json.loads(a_sent[0])["type"] == "snapshot"
    assert a_sent[0] == b_sent[0], "同一帧广播给全部订阅者"


def test_ensure_ticker_is_singleton():
    async def run():
        m = SchedulingStreamManager()
        sim = _FakeSim()
        await m.connect(_FakeWs(), KEY)
        m.ensure_ticker(KEY, lambda: sim)
        m.ensure_ticker(KEY, lambda: sim)
        m.ensure_ticker(KEY, lambda: sim)
        await asyncio.sleep(0)
        running = [t for t in m._tasks.values() if not t.done()]
        m.stop_ticker(KEY)
        return len(running)

    assert asyncio.run(run()) == 1, "同一 (场景,频道) 只允许一个推进循环"


def test_disconnect_all_stops_ticker():
    async def run():
        m = SchedulingStreamManager()
        sim = _FakeSim()
        ws = _FakeWs()
        await m.connect(ws, KEY)
        m.ensure_ticker(KEY, lambda: sim)
        await asyncio.sleep(0)
        assert m.has_subscribers(KEY) is True
        m.disconnect(ws, KEY)
        return m.has_subscribers(KEY), m.ticker_running(KEY)

    has_subs, running = asyncio.run(run())
    assert has_subs is False
    assert running is False, "无订阅者应停止推进（不空转）"


def test_set_interval_per_channel_and_keeps_on_invalid():
    m = SchedulingStreamManager()
    assert m.interval_of(KEY) == DEFAULT_INTERVAL_S
    assert m.set_interval(KEY, 5) == 5.0
    assert m.set_interval(KEY, 999) == MAX_INTERVAL_S
    assert m.set_interval(KEY, "bad") == MAX_INTERVAL_S  # 非法保持原值
    # 另一频道不受影响
    assert m.interval_of(("large", "main")) == DEFAULT_INTERVAL_S


def test_broadcast_cleans_dead_connections():
    async def run():
        m = SchedulingStreamManager()
        alive, dead = _FakeWs(), _FakeWs(fail=True)
        await m.connect(alive, KEY)
        await m.connect(dead, KEY)
        await m.broadcast(KEY, "x")
        return m.subscriber_count(KEY), len(alive.sent)

    count, alive_sent = asyncio.run(run())
    assert count == 1, "失效连接应被清理"
    assert alive_sent == 1
