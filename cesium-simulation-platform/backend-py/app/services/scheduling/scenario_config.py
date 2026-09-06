"""
场景配置加载与解析（现场调度·井下 LHD 出矿）

现场调度板块的全部"可替换内容"——巷道节点/巷道段（物理通过性参数）、开采水平分层、
装载点（爆堆对象）、品位、设备库、初始封锁、以及前端可视化的 2D 布局 / 3D 分层——
统一收敛到一份 JSON 场景配置。

配置存放（数据库优先，磁盘文件兜底）：
  - 数据库：scheduling_scenario 表（见 sql/scheduling_scenario.sql），
    load_config() 优先从该表读取 enabled=1 的记录（seed_scheduling.py 负责导入/同步）；
  - 磁盘：backend-py/config/scenario_<名>.json，作为"原始种子/离线兜底"，
    数据库无记录时自动读取，并尽力回写数据库（自动入库）。

本模块职责：
  - load_config(name)：数据库优先、文件兜底，返回原始配置 dict；
  - list_scenarios()：列出可用场景（数据库记录，失败回退为扫描 config 目录文件）；
  - build_scenario(cfg)：把原始配置解析为仿真器可直接消费的规范化场景 dict
    （巷道段统一为 11 元组，设备保持 dict 由 simulator 构造 LhdSpec）。

新增"其他巷道 / 其他信息"的标准做法：
  1. 复制 config/scenario_ashale.json 为 config/scenario_<新名>.json；
  2. 在 JSON 中增删节点、巷道段、装载点、设备与布局坐标；
  3. 运行 python seed_scheduling.py 入库，或让后端自动回写；
  4. 前端请求 /api/scheduling/config?scenario=<新名>，后端 /api/scheduling/state?scenario=<新名>
     与 /ws/scheduling/stream?scenario=<新名> 即自动切换到该场景——
     渲染与 NSGA-III 算法均按配置自动配套，无需改动代码。
"""
import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from app.database import DB_CONFIG
    import pymysql
    from pymysql.cursors import DictCursor

    _DB_AVAILABLE = True
except Exception:  # 数据库依赖缺失时退化为纯文件模式
    DB_CONFIG = None
    pymysql = None
    DictCursor = None
    _DB_AVAILABLE = False

# backend-py/config/ 目录（由本文件位置上溯 3 级：scheduling -> services -> app -> backend-py）
CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"

DEFAULT_SCENARIO = "ashale"

# 场景名 -> 原始配置 dict 的内存缓存（进程内避免重复读库；改库/文件后重启生效）
_config_cache: dict[str, dict] = {}


def scenario_path(name: Optional[str] = None) -> Path:
    """返回 config/scenario_<name>.json 的路径。"""
    key = name or DEFAULT_SCENARIO
    return CONFIG_DIR / f"scenario_{key}.json"


# =====================================================================
# 数据库访问（scheduling_scenario 表）
# =====================================================================
def _db_conn():
    if not _DB_AVAILABLE:
        return None
    try:
        return pymysql.connect(**DB_CONFIG)
    except Exception as e:
        logger.warning("[scenario_config] 数据库连接失败，回退文件模式: %s", e)
        return None


def load_config_from_db(name: Optional[str] = None) -> Optional[dict]:
    """从 scheduling_scenario 表读取 enabled=1 的场景配置；无记录/失败返回 None。"""
    if not _DB_AVAILABLE:
        return None
    conn = _db_conn()
    if conn is None:
        return None
    key = name or DEFAULT_SCENARIO
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT config_json FROM scheduling_scenario WHERE name=%s AND enabled=1",
                (key,),
            )
            row = cur.fetchone()
            if row and row.get("config_json"):
                return json.loads(row["config_json"])
    except Exception as e:
        logger.warning("[scenario_config] 读取场景 %s 失败，回退文件模式: %s", key, e)
        return None
    finally:
        conn.close()
    return None


def upsert_config_to_db(cfg: dict, name: Optional[str] = None) -> bool:
    """把场景配置写入 scheduling_scenario 表（按 name 幂等 upsert）。失败返回 False。"""
    if not _DB_AVAILABLE:
        return False
    key = name or DEFAULT_SCENARIO
    conn = _db_conn()
    if conn is None:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO scheduling_scenario "
                "(name, scenario_id, engine, config_json, remark) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON DUPLICATE KEY UPDATE "
                "scenario_id=VALUES(scenario_id), engine=VALUES(engine), "
                "config_json=VALUES(config_json), updated_at=CURRENT_TIMESTAMP",
                (
                    key,
                    cfg.get("scenario", key),
                    cfg.get("engine", ""),
                    json.dumps(cfg, ensure_ascii=False),
                    "",
                ),
            )
        conn.commit()
        return True
    except Exception as e:
        logger.warning("[scenario_config] 写入场景 %s 失败: %s", key, e)
        return False
    finally:
        conn.close()


def list_scenarios() -> list[dict]:
    """列出可用场景：数据库记录优先，失败回退为扫描 config 目录下的文件。"""
    if _DB_AVAILABLE:
        conn = _db_conn()
        if conn is not None:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT name, scenario_id, engine, enabled, updated_at "
                        "FROM scheduling_scenario ORDER BY name"
                    )
                    rows = cur.fetchall()
                    if rows:
                        return [
                            {
                                "name": r["name"],
                                "scenarioId": r["scenario_id"],
                                "engine": r["engine"],
                                "enabled": bool(r["enabled"]),
                                "updatedAt": str(r["updated_at"] or ""),
                            }
                            for r in rows
                        ]
            except Exception as e:
                logger.warning("[scenario_config] 列出场景失败，回退文件扫描: %s", e)
            finally:
                conn.close()
    return [
        {
            "name": p.name[len("scenario_"):-len(".json")],
            "scenarioId": p.name[len("scenario_"):-len(".json")],
            "engine": "",
            "enabled": True,
            "updatedAt": "",
        }
        for p in sorted(CONFIG_DIR.glob("scenario_*.json"))
    ]


# =====================================================================
# 配置读取（数据库优先 + 文件兜底 + 自动入库）
# =====================================================================
def load_config(name: Optional[str] = None) -> dict:
    """读取场景配置原始内容。

    优先级：内存缓存 -> 数据库 scheduling_scenario -> 磁盘 JSON 文件。
    从文件兜底读取时会尽力回写数据库（自动入库）。均不存在则抛 FileNotFoundError。
    """
    key = name or DEFAULT_SCENARIO
    cached = _config_cache.get(key)
    if cached is not None:
        return cached

    cfg = load_config_from_db(key)
    if cfg is not None:
        _config_cache[key] = cfg
        return cfg

    path = scenario_path(key)
    if not path.exists():
        available = [s["name"] for s in list_scenarios()]
        raise FileNotFoundError(
            f"场景配置不存在（数据库无记录且无文件）: {key}；当前可用场景: {available or '无'}"
        )
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    _config_cache[key] = cfg
    # 尽力自动入库（数据库不可用时静默跳过）
    if _DB_AVAILABLE:
        upsert_config_to_db(cfg, key)
    return cfg


def parse_segments(cfg: dict) -> list:
    """把 JSON 巷道段解析为仿真器使用的 11 元组：
    (id, a, b, lenM, clearW, clearH, maxGradePct, minTurnR_m, smokeBad, rockburstTend, type)
    """
    out = []
    for s in cfg.get("segments", []):
        out.append((
            s["id"], s["a"], s["b"], s.get("lengthM", 0), s.get("clearWidthM", 0),
            s.get("clearHeightM", 0), s.get("maxGradePct", 0), s.get("minTurnRadiusM", 0),
            bool(s.get("smokeBad", False)), float(s.get("rockburstTend", 0.0)),
            s.get("type", ""),
        ))
    return out


def build_scenario(cfg: dict) -> dict:
    """把原始配置解析为仿真器可直接消费的规范化场景 dict。"""
    return {
        "scenario": cfg.get("scenario", "underground-LHD"),
        "engine": cfg.get("engine", "井下LHD巷道调度仿真"),
        "nodeDump": cfg.get("nodeDump", "S0"),
        "tunnelNodes": cfg.get("tunnelNodes", []),
        "segments": parse_segments(cfg),
        "levelsMeta": cfg.get("levelsMeta", []),
        "levelSegs": {int(k): list(v) for k, v in cfg.get("levelSegs", {}).items()},
        "levelDepthM": cfg.get("levelDepthM", [0]),
        "initialBlocks": cfg.get("initialBlocks", []),
        "muckPoints": cfg.get("muckPoints", []),
        "gradePct": cfg.get("gradePct", {}),
        "muckLevel": {k: int(v) for k, v in cfg.get("muckLevel", {}).items()},
        "equipment": cfg.get("equipment", {}),
        "indicatorSpecs": cfg.get("indicatorSpecs", {}),
    }


def load_scenario(name: Optional[str] = None) -> dict:
    """一步到位：按场景名加载原始配置并解析为仿真器可用的场景 dict。"""
    return build_scenario(load_config(name))
