"""损伤 PPV 阈值前后端契约（pytest，从 backend-py 根目录运行）。

锁定 blast_physics.DAMAGE_THRESHOLDS_CMPS 与仓库根 shared-consistency-baseline.json
的 damageThresholdsCmps 一致；前端对应用例为 cesium1/src/features/blasting-simulation/
services/core/computation/__tests__/damageThresholdsContract.test.js。任一端改动
阈值而不同步基线/对端实现，对应测试即失败，避免"两端各持一份常量"静默漂移。

阈值分区（Persson 模型，cm/s）：
  elastic <20 / micro_crack 20-50 / crack_growth 50-100 / fracture 100-200 / throw >=200
"""

import json
from pathlib import Path

from app.services.blasting.blast_physics import DAMAGE_THRESHOLDS_CMPS

BASELINE_PATH = Path(__file__).resolve().parents[2] / "shared-consistency-baseline.json"
BASELINE = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def test_damage_thresholds_match_baseline():
    baseline = [float(v) for v in BASELINE["damageThresholdsCmps"]]
    actual = [float(v) for v in DAMAGE_THRESHOLDS_CMPS]
    assert actual == baseline


def test_damage_thresholds_monotonic_and_four_bands():
    assert len(DAMAGE_THRESHOLDS_CMPS) == 4
    assert all(
        b > a for a, b in zip(DAMAGE_THRESHOLDS_CMPS, DAMAGE_THRESHOLDS_CMPS[1:])
    )
