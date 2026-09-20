"""generate_grade_synth.py —— 合成矿石品位块段数据生成器（固定 seed，可复现）

生成"仿真示例数据"性质的品位块段模型，供前端 geology-analysis 品位层渲染与
GradePanel 展示。平台暂无真实勘探品位数据，本脚本按矿体空间规律（沿走向/
厚度方向趋势 + 固定 seed 扰动）合成，界面显著标注"仿真示例数据"；将来接入
真实数据只需替换 config/ore_grade_synth.json（前端零发布）。

确定性契约：build_payload() 纯函数、固定 SEED、全部数值固定小数位四舍五入，
两次运行输出逐字节一致；backend-py/tests/test_grade_synth.py 校验
"config 中的 JSON == 本脚本输出"，防止手工改文件与脚本漂移。

空间坐标：直接输出经纬度（Cesium Cartesian3.fromDegrees(lon, lat, height)），
原点取矿山模型锚点 modelConfig.DEFAULT_POSITION（113.323, 23.106, -26），
块段东西/南北向偏移按米→度近似换算（0.01° 量级下误差可忽略）。

运行（backend-py 根目录）：python generate_grade_synth.py
"""
import json
import math
import random
from pathlib import Path

# ---------------------------------------------------------------- 常量 ----
SEED = 20260920

# 矿山模型锚点（与前端 modelConfig.DEFAULT_POSITION 严格一致）
ORIGIN_LON = 113.323
ORIGIN_LAT = 23.106
ORIGIN_HEIGHT = -26.0

# 米 → 度换算（原点纬度处）
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(ORIGIN_LAT))
M_PER_DEG_LAT = 110574.0

# 矿体几何：走向长 × 厚度宽，块段尺寸 30m
BLOCK_SIZE_M = 30.0
STRIKE_LENGTH_M = 420.0   # 沿走向
THICKNESS_M = 180.0       # 垂直走向厚度

# 中段（自上而下），高度为模型坐标 z（米）
LEVELS = [
    {"name": "一中段", "height": -60.0},
    {"name": "二中段", "height": -100.0},
    {"name": "三中段", "height": -140.0},
]

# 走向方位角（度，自北顺时针）：矿体沿 NE 40° 延伸
STRIKE_HEADING_DEG = 40.0

# 品位场（% Cu）：沿走向两端富集 + 垂厚方向中心富集 + 高斯扰动
GRADE_BASE = 0.45
GRADE_STRIKE_AMP = 0.30
GRADE_THICK_AMP = 0.20
GRADE_NOISE_STD = 0.12
GRADE_MIN, GRADE_MAX = 0.2, 1.4

# 图例分级阈值（% Cu），随 JSON 下发为前后端单源
GRADE_LEVELS = [0.4, 0.6, 0.8, 1.0, 1.2]

ORE_DENSITY_T_M3 = 2.7
ZONE_COUNT = 4  # 沿走向等分为 4 个采区
ZONE_NAMES = ["I号采区", "II号采区", "III号采区", "IV号采区"]

CONFIG_PATH = Path(__file__).resolve().parent / "config" / "ore_grade_synth.json"


def _local_to_lonlat(east_m, north_m):
    """局部米制偏移 → 经纬度偏移（原点纬度处近似）。"""
    return (
        round(ORIGIN_LON + east_m / M_PER_DEG_LON, 7),
        round(ORIGIN_LAT + north_m / M_PER_DEG_LAT, 7),
    )


def build_payload():
    """构建合成品位块段数据（纯函数，固定 seed，可复现）。"""
    rng = random.Random(SEED)
    heading = math.radians(STRIKE_HEADING_DEG)
    # 走向 / 垂厚方向单位向量（米，东、北分量）
    ux, uy = math.sin(heading), math.cos(heading)
    vx, vy = math.cos(heading), -math.sin(heading)

    n_strike = int(STRIKE_LENGTH_M / BLOCK_SIZE_M)   # 14
    n_thick = int(THICKNESS_M / BLOCK_SIZE_M)        # 6

    blocks = []
    for li, level in enumerate(LEVELS):
        for i in range(n_strike):
            for j in range(n_thick):
                # 块段中心（走向/垂厚局部坐标）
                s = (i + 0.5) * BLOCK_SIZE_M - STRIKE_LENGTH_M / 2
                t = (j + 0.5) * BLOCK_SIZE_M - THICKNESS_M / 2
                # 椭圆矿体边界外剔除（长半轴/短半轴 = 走向/垂厚一半）
                a = (s / (STRIKE_LENGTH_M / 2)) ** 2
                b = (t / (THICKNESS_M / 2)) ** 2
                if a + b > 1.0:
                    continue

                east = s * ux + t * vx
                north = s * uy + t * vy
                lon, lat = _local_to_lonlat(east, north)

                # 品位场：沿走向正弦富集 + 垂厚中心富集 + 扰动
                u = (i + 0.5) / n_strike
                w = (j + 0.5) / n_thick
                grade = (
                    GRADE_BASE
                    + GRADE_STRIKE_AMP * math.sin(math.pi * u)
                    + GRADE_THICK_AMP * (1.0 - abs(2.0 * w - 1.0))
                    + rng.gauss(0.0, GRADE_NOISE_STD)
                )
                grade = round(min(GRADE_MAX, max(GRADE_MIN, grade)), 3)

                zone_idx = min(ZONE_COUNT - 1, int(u * ZONE_COUNT))
                tonnage = round(
                    BLOCK_SIZE_M ** 3 * ORE_DENSITY_T_M3 * (0.92 + 0.08 * rng.random()), 1
                )

                blocks.append({
                    "id": f"B{li:02d}{i:02d}{j:02d}",
                    "zone": ZONE_NAMES[zone_idx],
                    "level": level["name"],
                    "levelIndex": li,
                    "lon": lon,
                    "lat": lat,
                    "height": level["height"],
                    "sizeM": [BLOCK_SIZE_M, BLOCK_SIZE_M, BLOCK_SIZE_M],
                    "gradePct": grade,
                    "tonnageT": tonnage,
                })

    return {
        "source": "synthetic",
        "meta": {
            "seed": SEED,
            "origin": {"lon": ORIGIN_LON, "lat": ORIGIN_LAT, "height": ORIGIN_HEIGHT},
            "strikeHeadingDeg": STRIKE_HEADING_DEG,
            "blockSizeM": BLOCK_SIZE_M,
            "levels": [lv["name"] for lv in LEVELS],
            "gradeUnit": "% Cu",
            "oreDensityTm3": ORE_DENSITY_T_M3,
            "note": "仿真示例数据：按矿体空间趋势与固定 seed 扰动合成，非真实勘探品位。",
        },
        "gradeLevels": GRADE_LEVELS,
        "zones": ZONE_NAMES,
        "blocks": blocks,
    }


def main():
    payload = build_payload()
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"written {CONFIG_PATH} blocks={len(payload['blocks'])}")


if __name__ == "__main__":
    main()
