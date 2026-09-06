"""
将南山隧道上台阶楔形掏槽微差爆破案例（汪亚飞《复杂环境下隧道钻爆施工降振试验
研究及控制》）直接写入 BLAST-2026-002 事件 —— 只增量 UPDATE，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构（炮孔设计/断面掘进/
装药起爆/爆破效果/环境岩体），后端 blasting.py 通过 `_use_legacy_blasting_schema`
自动识别并解析。本脚本按该 legacy JSON 的确切 key 结构写入文献参数。

案例要点（文献校准）：
  - 隧道：大连市南山公路隧道，双向六车道，开挖宽 15.56m、高 10.23m、面积 142.6m²
    → 马蹄形：直墙 2.45m + 半圆拱 r=7.78m（totalH=10.23m）
  - 掏槽：垂直向楔形掏槽（6 装药孔，单眼 2.4kg），微差控制爆破降振 + 光面爆破控轮廓
  - 装药（表3-1）：掏槽 2.4kg/孔，扩槽/崩落 0.9~1.95kg/孔，周边 0.4~1.2kg/孔，
    底板 1.95kg/孔；普通毫秒雷管逐段（1/3/5/7/11/13/15 段）微差延时
  - 回归公式（图5-1/5-2）：V = 113.64·(Q^(1/3)/R)^1.341 → K=113.64、α=1.341
炮孔几何与前端 nanshanTunnelDesign.js 一致，保证多源应力波叠加数据源一致。

运行: .venv\\Scripts\\python.exe seed_nanshan_event.py
"""
import os
import sys
import math
import json
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "cesium_platform"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}

EVENT_ID = "BLAST-2026-002"

# ─── 文献断面（与前端 nanshanTunnelDesign.js 一致）──────────────
SECTION = {
    "width": 15.56,
    "wallHeight": 2.45,
    "archRadius": 7.78,
    "totalHeight": 10.23,
    "shape": "horseshoe",
}
HOLE_DEPTH = 3.0
HALF_W = SECTION["width"] / 2 - 0.5
WEDGE_X = [1.1, 1.9, 2.7]
WEDGE_Y = SECTION["totalHeight"] * 0.5 - 0.3
WEDGE_INCLIN = [55, 62, 68]
AUX_RINGS = [  # [半径, 孔数, 单眼药量kg, 延时ms]（环底不得越过底板 y≈0）
    [2.6, 8, 1.8, 100],
    [3.8, 10, 1.5, 200],
    [5.0, 12, 1.3, 300],
]
PERIM_SPACING = 0.5


def _inside(x, y, margin=0.5):
    if y < 0:  # 不越过底板（掌子面底部 y=0）
        return False
    half_w = SECTION["width"] / 2 - margin
    Hw = SECTION["wallHeight"]
    R = SECTION["archRadius"] - margin
    if y <= Hw:
        return abs(x) <= half_w
    return x * x + (y - Hw) ** 2 <= R * R


def _round1(v):
    return round(v, 1)


def build_nanshan_holes():
    """镜像 nanshanTunnelDesign.js（对称楔形掏槽+扩槽崩落+周边光爆），
    产出 legacy 中文 key 的炮孔 dict 列表；越界孔一律丢弃。"""
    cy0 = SECTION["totalHeight"] * 0.5
    Hw = SECTION["wallHeight"]
    holes = []
    idx = 1

    def push(d):
        nonlocal idx
        # 超过断面 -> 丢弃，保证不越界/不穿底
        if not _inside(d["X坐标_m"], d["Y坐标_m"]):
            return
        d["序号"] = idx
        idx += 1
        holes.append(d)

    # 0) 中心空孔
    push({
        "孔径_m": 0.064, "孔深_m": HOLE_DEPTH,
        "X坐标_m": 0, "Y坐标_m": round(WEDGE_Y, 3), "孔类型": "掏槽孔",
        "倾角_度": 0, "是否空孔": True, "炸药类型": "乳化炸药",
        "装药量_kg": 0.0, "雷管段别": 1, "方位角_度": 0,
        "装药长度_m": 0, "延期时间_ms": 0,
    })

    # 1) 楔形掏槽孔 6 孔（左右对称）
    for i, off in enumerate(WEDGE_X):
        for side in (-1, 1):
            push({
                "孔径_m": 0.04, "孔深_m": HOLE_DEPTH,
                "X坐标_m": round(side * off, 3), "Y坐标_m": round(WEDGE_Y, 3),
                "孔类型": "掏槽孔", "倾角_度": WEDGE_INCLIN[i],
                "是否空孔": False, "炸药类型": "乳化炸药",
                "装药量_kg": 2.4, "雷管段别": 1,
                "方位角_度": 90 if side > 0 else -90,
                "装药长度_m": round(HOLE_DEPTH * 0.7, 2),
                "延期时间_ms": 0,
            })

    # 2) 环形扩槽/崩落孔
    for ri, (r, n, chg, delay) in enumerate(AUX_RINGS):
        for i in range(n):
            a = (i / n) * math.pi * 2
            push({
                "孔径_m": 0.04, "孔深_m": HOLE_DEPTH,
                "X坐标_m": round(math.cos(a) * r, 3),
                "Y坐标_m": round(cy0 + math.sin(a) * r, 3),
                "孔类型": "辅助孔", "倾角_度": 5, "是否空孔": False,
                "炸药类型": "乳化炸药", "装药量_kg": chg, "雷管段别": 3 + ri,
                "方位角_度": 0, "装药长度_m": round(HOLE_DEPTH * 0.65, 2),
                "延期时间_ms": delay,
            })

    # 3) 周边-拱部光爆点（贴合轮廓内侧，不经越界过滤，否则贴线会被误丢）
    r_arch = SECTION["archRadius"] - 0.2
    arch_n = max(10, round((math.pi * r_arch) / PERIM_SPACING))
    for i in range(arch_n):
        a = math.pi * (i / (arch_n - 1))
        x = math.cos(a) * r_arch
        y = Hw + math.sin(a) * r_arch
        azi = math.degrees(math.atan2(x, y - Hw)) if abs(y - Hw) > 0.01 else 0
        d = {
            "孔径_m": 0.04, "孔深_m": HOLE_DEPTH,
            "X坐标_m": round(x, 3), "Y坐标_m": round(y, 3),
            "孔类型": "周边孔", "倾角_度": 3, "是否空孔": False,
            "炸药类型": "乳化炸药", "装药量_kg": 0.4, "雷管段别": 15,
            "方位角_度": round(azi, 1),
            "装药长度_m": round(HOLE_DEPTH * 0.55, 2), "延期时间_ms": 650,
        }
        d["序号"] = idx; idx += 1; holes.append(d)

    # 4) 周边-边墙（两侧上下各一）
    wall_x = SECTION["width"] / 2 - 0.3
    for side in (-1, 1):
        for wy_ratio in (0.4, 0.75):
            d = {
                "孔径_m": 0.04, "孔深_m": HOLE_DEPTH,
                "X坐标_m": round(side * wall_x, 3), "Y坐标_m": round(Hw * wy_ratio, 3),
                "孔类型": "周边孔", "倾角_度": 3, "是否空孔": False,
                "炸药类型": "乳化炸药", "装药量_kg": 1.2, "雷管段别": 15,
                "方位角_度": 90 if side > 0 else -90,
                "装药长度_m": round(HOLE_DEPTH * 0.55, 2), "延期时间_ms": 600,
            }
            d["序号"] = idx; idx += 1; holes.append(d)

    # 5) 周边-底板 5 孔
    floor_n = 5
    for i in range(floor_n):
        d = {
            "孔径_m": 0.04, "孔深_m": HOLE_DEPTH,
            "X坐标_m": round(((2 * i) / (floor_n - 1) - 1) * (SECTION["width"] / 2 - 1.0), 3),
            "Y坐标_m": 0.5,
            "孔类型": "周边孔", "倾角_度": 6, "是否空孔": False,
            "炸药类型": "乳化炸药", "装药量_kg": 1.95, "雷管段别": 11,
            "方位角_度": 0, "装药长度_m": round(HOLE_DEPTH * 0.7, 2),
            "延期时间_ms": 500,
        }
        d["序号"] = idx; idx += 1; holes.append(d)

    return holes


def build_section_json():
    return {
        "断面形状": "马蹄形",
        "拱部半径_m": SECTION["archRadius"],
        "断面宽度_m": SECTION["width"],
        "直墙高度_m": SECTION["wallHeight"],
        "钻孔深度_m": HOLE_DEPTH,
        "钻孔直径_m": 0.04,
        "炮孔利用率": 0.85,
        "单循环进尺_m": round(HOLE_DEPTH * 0.85, 3),
        "已开挖长度_m": 80,
        "掌子面厚度_m": 2,
        "断面总高度_m": SECTION["totalHeight"],
        "掌子面距爆心_m": 3,
    }


def build_blast_json():
    return {
        "空孔数": 1,
        "掏槽模式": "楔形掏槽",
        "起爆网络": "导爆管",
        "堵塞长度_m": 0.6,
        "装药掏槽孔数": 6,
        "楔形掏槽角_度": 60,
        "段间延时间隔_ms": 100,
        "周边线装药密度_kgm": 0.3,
        "底板线装药密度_kgm": 0.8,
        "掏槽线装药密度_kgm": 1.0,
        "辅助线装药密度_kgm": 0.8,
    }


def build_effect_json():
    return {
        "半孔率": 0.75,
        "火球强度": 0.8,
        "火花强度": 0.6,
        "烟雾强度": 0.3,
        "碎片总数": 180,
        "粉尘强度": 0.2,
        "时间步长_s": 0.05,
        "最大超挖_m": 0.1,
        "最小超挖_m": 0.06,
        "漏斗半径_m": 4.0,
        "漏斗深度_m": 2.5,
        "峰值应力_MPa": 48,
        "峰值振动_Kine": round(4.8 * 1.414, 2),
        "模拟总时长_s": 12,
        "中位块度_x50_m": 0.22,
        "最小安全系数": 2.2,
        "模拟随机种子": 42,
        "抛掷扩散角_度": 45,
        "最大块度_xmax_m": 1.2,
        "80通过块度_x80_m": 0.33,
        "平均抛掷距离_m": 9,
        "最大抛掷距离_m": 14,
        "漏斗中心偏移_m": 0.38,
        "Swebrec弯曲参数_b": 2.2,
        "冲击波速度系数": 5.0,
        "最大质点振速_cms": 4.8,
        "Cunningham均匀指数_n": 1.1,
        # 萨道夫斯基回归公式参数（V = K·(Q^(1/3)/R)^α，图5-1/5-2 标定）
        "萨道夫斯基_K": 113.64,
        "萨道夫斯基衰减指数_alpha": 1.341,
        "萨道夫斯基公式": "V = 113.64·(Q^(1/3)/R)^1.341",
    }


def main():
    holes = build_nanshan_holes()
    total_charge = round(sum(h["装药量_kg"] for h in holes), 2)

    conn = pymysql.connect(**DB_CONFIG)
    cur = conn.cursor()
    try:
        cur.execute(
            """UPDATE `blasting_events` SET
                 `名称`=%s, `总装药量_kg`=%s, `炸药类型`=%s, `岩体类型`=%s,
                 `起爆方式`=%s, `爆破时间`=%s, `状态`=%s, `备注`=%s,
                 `炮孔设计`=%s, `断面掘进`=%s, `装药起爆`=%s, `爆破效果`=%s,
                 `更新时间`=%s
               WHERE `event_id`=%s""",
            (
                "南山隧道上台阶楔形掏槽微差爆破",
                total_charge,
                "乳化炸药",
                "石灰岩",
                "导爆管",
                datetime(2026, 7, 16, 14, 0),
                "已规划",
                "南山上台阶楔形掏槽，微差降振；V=113.64(Q^1/3/R)^1.341",
                json.dumps(holes, ensure_ascii=False),
                json.dumps(build_section_json(), ensure_ascii=False),
                json.dumps(build_blast_json(), ensure_ascii=False),
                json.dumps(build_effect_json(), ensure_ascii=False),
                datetime.now(),
                EVENT_ID,
            ),
        )
        conn.commit()
        print(f"[OK] BLAST-2026-002 已更新为南山隧道案例")
        print(f"  名称: 南山隧道上台阶楔形掏槽微差爆破")
        print(f"  断面: 15.56 x 10.23m 马蹄形 (直墙 2.45 + 拱 r 7.78)")
        print(f"  炮孔数: {len(holes)}, 总装药量: {total_charge}kg")
        print(f"  萨道夫斯基: K=113.64, alpha=1.341 -> V=113.64(Q^1/3/R)^1.341")
    except Exception as e:
        conn.rollback()
        print(f"[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()