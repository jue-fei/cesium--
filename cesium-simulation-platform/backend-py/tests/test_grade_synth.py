"""合成品位块段数据契约（pytest，从 backend-py 根目录运行）。

锁定 config/ore_grade_synth.json 与 generate_grade_synth.build_payload() 输出
逐字节一致（固定 seed 确定性），防止"手工改文件与脚本漂移"；同时校验数据
结构完整性（source=synthetic 标注 / 分级阈值单调 / 品位范围 / 采区与中段）。
前端对应用例为 cesium1/src/features/geology-analysis/services/__tests__/
gradeScale.test.js（着色与分箱消费同一 gradeLevels）。
"""

import hashlib
import json
from pathlib import Path

from generate_grade_synth import CONFIG_PATH, GRADE_MAX, GRADE_MIN, build_payload

REQUIRED_BLOCK_KEYS = {
    "id", "zone", "level", "levelIndex", "lon", "lat", "height",
    "sizeM", "gradePct", "tonnageT",
}


def _sha(payload) -> str:
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def test_build_payload_deterministic():
    assert _sha(build_payload()) == _sha(build_payload())


def test_config_file_matches_generator():
    """磁盘 JSON == 脚本输出（单源校验，手工改文件会被此测试抓住）。"""
    on_disk = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    assert _sha(on_disk) == _sha(build_payload())


def test_payload_structure():
    data = build_payload()
    assert data["source"] == "synthetic"
    levels = data["gradeLevels"]
    assert len(levels) >= 3
    assert all(b > a for a, b in zip(levels, levels[1:]))
    assert len(data["zones"]) == 4
    assert len(data["blocks"]) > 100

    for b in data["blocks"]:
        assert REQUIRED_BLOCK_KEYS <= set(b)
        assert GRADE_MIN <= b["gradePct"] <= GRADE_MAX
        assert b["tonnageT"] > 0
        assert 0 <= b["levelIndex"] < len(data["meta"]["levels"])

    # 块段 id 唯一
    ids = [b["id"] for b in data["blocks"]]
    assert len(ids) == len(set(ids))
