import json
from pathlib import Path

from fastapi import APIRouter, Depends
from pymysql import Connection
from app.database import get_db

router = APIRouter(prefix="/api/geology", redirect_slashes=False, tags=["地质分析"])

# 合成品位块段配置（真源：config/ore_grade_synth.json，由 generate_grade_synth.py
# 固定 seed 生成；test_grade_synth.py 校验文件与脚本输出一致）。进程内缓存。
_GRADE_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "ore_grade_synth.json"
_grade_config_cache = None


def _load_grade_config():
    global _grade_config_cache
    if _grade_config_cache is None:
        try:
            with open(_GRADE_CONFIG_PATH, "r", encoding="utf-8") as f:
                _grade_config_cache = json.load(f)
        except OSError:
            return None  # 配置缺失：返回 code=1 提示，而不是 500
    return _grade_config_cache


@router.get("/grade-blocks")
def get_grade_blocks():
    """矿石品位块段数据（图例分级阈值 gradeLevels / 采区 zones / 块段 blocks 随 JSON 下发）。

    当前数据为合成示例（data.source == 'synthetic'，前端界面显著标注"仿真示例数据"）；
    将来接入真实勘探品位只需替换 config/ore_grade_synth.json，前端零发布。
    """
    cfg = _load_grade_config()
    if cfg is None:
        return {"code": 1, "message": "品位块段配置缺失（config/ore_grade_synth.json），先运行 generate_grade_synth.py"}
    return {"code": 0, "data": cfg}


@router.get("/stats")
def get_geology_stats(db: Connection = Depends(get_db)):
    with db.cursor() as cursor:
        cursor.execute("SELECT stat_key, stat_value FROM geology_stats")
        rows = cursor.fetchall()
    stats = {}
    for row in rows:
        stats[row["stat_key"]] = row["stat_value"]
    return {"code": 0, "data": stats}



