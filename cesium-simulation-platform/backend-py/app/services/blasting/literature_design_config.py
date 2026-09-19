"""
文献化爆破设计静态配置加载（config/blasting_designs/*.json）

文献设计数据源已后端化：数据库中 001~007 号文献爆破事件的断面/布孔/孔深/进尺
与萨道夫斯基 K/α 预计算为静态 JSON，存放于 backend-py/config/blasting_designs/
（7 个 {key}.json + _manifest.json 校验清单，SHA256 与前端原 buildXxxTunnelDesign
输出一致）。此前该数据硬编码在前端 7 个 *TunnelDesign.js 构建器中，加载事件时
由前端"盖章"覆盖 dataset.design；现改为后端 /api/blasting/events/{event_id} 与
/events/{event_id}/design 组装 design 时注入 literature 子对象，前端只消费渲染。

本模块职责（仿照 app/services/scheduling/scenario_config.py 的 CONFIG_DIR/缓存模式）：
  - load_all_designs()：进程内缓存加载目录下全部 {key}.json（排除 _manifest.json）；
  - match_literature_event(event_id, event_name)：严格复刻前端 matchLiteratureEvent
    语义——按数组顺序首个命中：event_id 以 idSuffix 结尾，或事件名称包含任一
    nameKeywords；未命中返回 None；
  - get_literature_design(key)：按 key 返回整份 JSON dict；
  - build_literature_payload(event_id, event_name)：匹配并组装注入 design 的
    literature 子对象（剔除仅用于匹配的 idSuffix/nameKeywords）。
"""
import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# backend-py/config/blasting_designs/ 目录
# （由本文件位置上溯 3 级：blasting -> services -> app -> backend-py）
CONFIG_DIR = Path(__file__).resolve().parents[3] / "config" / "blasting_designs"

# 文献事件匹配顺序（与前端 LITERATURE_EVENTS 数组顺序一致，首个命中即返回，勿改）：
# 002 南山 → 004 昆阳 → 001 达巴莱 → 003 三棱山 → 005 余漾 → 006 董武俊 → 007 冯银
KEY_ORDER = [
    "nanshan",
    "kunyang",
    "dabalai",
    "sanlengshan",
    "yuyang",
    "dongwujun",
    "fengyin",
]

# key -> 原始 JSON dict 的内存缓存（进程内避免重复读盘；改文件后重启生效）
_designs_cache: Optional[dict] = None


def load_all_designs() -> dict:
    """加载目录下全部 {key}.json（排除 _manifest.json 等下划线开头文件），进程内缓存。"""
    global _designs_cache
    if _designs_cache is not None:
        return _designs_cache
    designs: dict = {}
    if CONFIG_DIR.is_dir():
        for path in sorted(CONFIG_DIR.glob("*.json")):
            if path.name.startswith("_"):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                designs[cfg.get("key") or path.stem] = cfg
            except Exception as e:
                logger.warning(
                    "[literature_design_config] 加载 %s 失败: %s", path.name, e
                )
    else:
        logger.warning("[literature_design_config] 配置目录不存在: %s", CONFIG_DIR)
    _designs_cache = designs
    return designs


def _ordered_keys() -> list:
    """按 KEY_ORDER 优先排序；目录中新增的未登记 key 排在其后（字母序兜底）。"""
    designs = load_all_designs()
    keys = [k for k in KEY_ORDER if k in designs]
    keys += sorted(k for k in designs if k not in KEY_ORDER)
    return keys


def match_literature_event(event_id, event_name) -> Optional[dict]:
    """匹配文献事件（严格复刻前端 matchLiteratureEvent 语义）。

    规则：event_id 以 idSuffix 结尾，或事件名称包含任一 nameKeywords；
    按 KEY_ORDER 数组顺序首个命中即返回；匹配不到返回 None
    （调用方保持数据库原始设计 / 回退默认 K/α）。
    """
    designs = load_all_designs()
    eid = str(event_id or "")
    name = str(event_name or "")
    for key in _ordered_keys():
        cfg = designs.get(key)
        if not isinstance(cfg, dict):
            continue
        id_suffix = cfg.get("idSuffix")
        id_hit = isinstance(id_suffix, str) and eid.endswith(id_suffix)
        kw_hit = any(
            str(kw) in name for kw in (cfg.get("nameKeywords") or [])
        )
        if id_hit or kw_hit:
            return cfg
    return None


def get_literature_design(key: str) -> Optional[dict]:
    """按 key 返回整份文献设计 JSON dict；不存在返回 None。"""
    return load_all_designs().get(key)


def build_literature_payload(event_id, event_name) -> Optional[dict]:
    """匹配并组装注入 design 的 literature 子对象。

    返回 {"key", "section", "holes", "holeDepth", "utilization", "sadosky"}（剔除
    仅用于匹配的 idSuffix/nameKeywords）；未命中返回 None（design 不加该键）。
    """
    cfg = match_literature_event(event_id, event_name)
    if not cfg:
        return None
    return {k: v for k, v in cfg.items() if k not in ("idSuffix", "nameKeywords")}
