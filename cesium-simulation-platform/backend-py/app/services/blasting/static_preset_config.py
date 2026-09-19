"""
静态预设/标定集配置加载（config/*.json 单文件真源）

此前硬编码在前端的三类"静态可配置数据"已后端化，统一收敛到 backend-py/config/
目录下的单文件 JSON，由本模块加载并提供进程内缓存（仿 literature_design_config.py
与 scheduling/scenario_config.py 的 CONFIG_DIR + 缓存模式）：

  - blasting_sadosky.json  萨道夫斯基标定集：文献实测预设 6 条（徐言2020/闫常陆2018）
                           + 平台默认 K/α（90/1.58，现场测振回归回退值）
                           → GET /api/blasting/sadosky-presets
  - kco_site_presets.json  KCO 场地预设：3 套典型工程场景（公路隧道/地铁隧道/矿山巷道）
                           的岩石因子 + 装药 + 孔网典型值
                           → GET /api/blasting/kco-site-presets
  - hoek_brown_mi.json     完整岩石 Hoek-Brown 常数 m_i 表（21 条岩性，Hoek & Brown
                           2018 Table 2）+ 硬岩典型 UCS 分档
                           → GET /api/blasting/hoek-brown-mi

缓存策略：每文件首次访问时读盘一次，进程内缓存；改 JSON 后重启后端生效。
"""
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# backend-py/config/ 目录（由本文件位置上溯 3 级：blasting -> services -> app -> backend-py）
CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"

# 文件名 -> 原始 JSON dict 的内存缓存（进程内避免重复读盘；改文件后重启生效）
_config_cache: dict[str, dict] = {}


def load_static_config(filename: str) -> dict:
    """加载 config/ 目录下的单文件 JSON（进程内缓存）；缺失/损坏返回空 dict。"""
    cached = _config_cache.get(filename)
    if cached is not None:
        return cached
    cfg: dict = {}
    path = CONFIG_DIR / filename
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if not isinstance(cfg, dict):
                logger.warning("[static_preset_config] %s 顶层不是对象，忽略", filename)
                cfg = {}
        except Exception as e:
            logger.warning("[static_preset_config] 加载 %s 失败: %s", filename, e)
            cfg = {}
    else:
        logger.warning("[static_preset_config] 配置文件不存在: %s", path)
    _config_cache[filename] = cfg
    return cfg


def get_sadosky_config() -> dict:
    """萨道夫斯基标定集完整配置：{"presets": [...], "default": {"k", "alpha", "source"}}。"""
    return load_static_config("blasting_sadosky.json")


def get_kco_site_presets() -> dict:
    """KCO 场地预设完整配置：{"presets": {<key>: {label, RMD, ..., b}}}。"""
    return load_static_config("kco_site_presets.json")


def get_hoek_brown_mi_config() -> dict:
    """Hoek-Brown m_i 岩性表配置：{"mi", "miGroupMeta", "typicalUCS", "defaultTypicalUCS", "fallback"}。"""
    return load_static_config("hoek_brown_mi.json")


def build_sadosky_payload() -> dict:
    """组装 /sadosky-presets 响应 data（仅下发 presets 与 default 两个业务键，
    剔除 _description 等纯文档字段）。"""
    cfg = get_sadosky_config()
    return {
        "presets": cfg.get("presets", []) or [],
        "default": cfg.get("default", {}) or {},
    }


def build_kco_site_presets_payload() -> dict:
    """组装 /kco-site-presets 响应 data（仅下发 presets 映射）。"""
    cfg = get_kco_site_presets()
    return {"presets": cfg.get("presets", {}) or {}}


def build_hoek_brown_mi_payload() -> dict:
    """组装 /hoek-brown-mi 响应 data（剔除顶层与嵌套的 _description 等纯文档字段）。"""

    def _strip_docs(value):
        if isinstance(value, dict):
            return {k: _strip_docs(v) for k, v in value.items() if not k.startswith("_")}
        if isinstance(value, list):
            return [_strip_docs(v) for v in value]
        return value

    return _strip_docs(get_hoek_brown_mi_config())


# 显式列出本模块对外可用的构建函数（便于路由层引用与冒烟检查）
__all__ = [
    "load_static_config",
    "get_sadosky_config",
    "get_kco_site_presets",
    "get_hoek_brown_mi_config",
    "build_sadosky_payload",
    "build_kco_site_presets_payload",
    "build_hoek_brown_mi_payload",
]
