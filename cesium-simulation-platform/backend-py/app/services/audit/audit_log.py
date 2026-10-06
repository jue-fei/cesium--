"""
操作审计日志（3.3）

真源：config/audit/audit-log.jsonl（JSON Lines 追加写）
  - 每行一条记录：{id, ts, actor, action, scenario, summary, detail, ok}；
  - 只追加不可改（无更新/删除端点），容量超限时压缩保留最近一半；
  - id 为自增整数，进程重启后从文件末条继续。

审计点：各写路由成功路径显式调用 append()（routes/deployment.py /
routes/scheduling.py / routes/blasting.py），失败/校验不过不记录。
append 绝不向业务抛错（审计失败只 warning，不影响主流程）。

查询：GET /api/audit/logs（倒序、过滤、before_id 分页）；
     GET /api/audit/actions（动作枚举下发，前端不自持映射表 → 新增审计点零前端发布）。
"""
import json
import logging
import threading
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# backend-py/config/audit/ 目录（由本文件位置上溯 3 级：audit -> services -> app -> backend-py）
AUDIT_DIR = Path(__file__).resolve().parents[3] / "config" / "audit"
AUDIT_FILE = AUDIT_DIR / "audit-log.jsonl"

# 容量上限：超过后重写文件只保留最近一半（单机演示量级，避免无限增长）
MAX_ENTRIES = 2000
KEEP_ON_COMPACT = MAX_ENTRIES // 2

# 动作枚举（id → 展示标签 + 所属域）。前端经 /api/audit/actions 拉取，不在前端复制。
# 域目前：scheduling（现场调度）/ blasting（爆破模拟）。
AUDIT_ACTIONS: dict[str, dict] = {
    "deployment.save": {"label": "设备部署调整", "domain": "scheduling"},
    "muck_task.update": {"label": "任务参数修改", "domain": "scheduling"},
    "scheduling.solve": {"label": "多目标重求解", "domain": "scheduling"},
    "scheduling.reset": {"label": "仿真重置", "domain": "scheduling"},
    "scheduling.apply": {"label": "派单提交", "domain": "scheduling"},
    "scheduling.blastpile": {"label": "爆堆注入", "domain": "scheduling"},
    "blasting.event.create": {"label": "新建爆破事件", "domain": "blasting"},
    "blasting.event.update": {"label": "修改爆破事件", "domain": "blasting"},
    "blasting.event.delete": {"label": "删除爆破事件", "domain": "blasting"},
    "blasting.design.save": {"label": "保存爆破设计", "domain": "blasting"},
    "blasting.result.save": {"label": "录入爆破效果", "domain": "blasting"},
}

# 同步路由跑在 FastAPI threadpool，追加/压缩/查询均需互斥
_lock = threading.Lock()
_last_id = 0


def _read_all() -> list[dict]:
    """读取全部记录（跳过损坏行）；文件不存在返回空列表。"""
    if not AUDIT_FILE.exists():
        return []
    entries = []
    for line in AUDIT_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            if isinstance(rec, dict) and "id" in rec:
                entries.append(rec)
        except json.JSONDecodeError:
            logger.warning("[audit] 跳过损坏行：%s", line[:120])
    return entries


def _init_last_id(entries: list[dict]) -> None:
    """从已有记录初始化自增 id 水位（按文件末条）。"""
    global _last_id
    if entries:
        try:
            _last_id = max(_last_id, int(entries[-1]["id"]))
        except (TypeError, ValueError):
            pass


def append(
    action: str,
    summary: str,
    scenario: str | None = None,
    detail: dict | None = None,
    ok: bool = True,
    actor: str = "operator",
) -> None:
    """追加一条审计记录。失败只 warning，绝不阻断业务路由。

    - action：动作 id（须在 AUDIT_ACTIONS 内，未知 id 也写入但 logger 提示）；
    - summary：一句话人读摘要（时间线主文案）；
    - scenario：调度场景名（爆破事件域无场景概念，传 None）；
    - detail：结构化补充（展开详情用），只放可 JSON 化的小对象；
    - ok：业务结果成败标记（校验失败/部分拒绝仍记录时用 False）。
    """
    if action not in AUDIT_ACTIONS:
        logger.warning("[audit] 未登记的动作 id：%s（仍写入日志）", action)
    try:
        with _lock:
            entries = _read_all()
            _init_last_id(entries)
            global _last_id
            _last_id += 1
            rec = {
                "id": _last_id,
                "ts": datetime.now().isoformat(timespec="seconds"),
                "actor": actor,
                "action": action,
                "scenario": scenario,
                "summary": summary,
                "detail": detail or {},
                "ok": bool(ok),
            }
            entries.append(rec)
            AUDIT_DIR.mkdir(parents=True, exist_ok=True)
            if len(entries) > MAX_ENTRIES:
                entries = entries[-KEEP_ON_COMPACT:]
            tmp = AUDIT_FILE.with_suffix(".jsonl.tmp")
            tmp.write_text(
                "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries),
                encoding="utf-8",
            )
            tmp.replace(AUDIT_FILE)
    except OSError as e:
        logger.warning("[audit] 写入失败（不影响业务）：%s", e)


def query(
    limit: int = 50,
    action: str | None = None,
    scenario: str | None = None,
    before_id: int | None = None,
) -> dict:
    """查询审计记录：倒序（最新在前）、动作/场景过滤、before_id 分页。

    返回 {entries, hasMore}：entries 取 min(limit, 命中数) 条；
    hasMore 表示过滤后仍有更早记录（供前端"加载更多"）。
    """
    with _lock:
        entries = _read_all()
    _init_last_id(entries)

    # 时间正序存储 → 先过滤再倒序
    if action:
        entries = [e for e in entries if e.get("action") == action]
    if scenario:
        entries = [e for e in entries if e.get("scenario") == scenario]
    if before_id is not None:
        entries = [e for e in entries if e.get("id", 0) < before_id]
    entries.reverse()

    limit = max(1, min(limit, 200))
    has_more = len(entries) > limit
    return {"entries": entries[:limit], "hasMore": has_more}
