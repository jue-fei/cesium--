"""
将爆破事件 007（BLAST-2026-007）改为冯银巷道环间延时爆破文献化模型 —— 只更新该事件。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构，本脚本按该 legacy JSON 的
确切 key 结构写入文献参数（与 cesium1 前端 fengyinTunnelDesign.js 布孔一一对应）。

依据文献（冯银、陈辉《巷道爆破环间延时对岩石抛掷距离的影响》采矿技术 2024,24(1)）：
  - 工程：新疆备战铁矿巷道，断面尺寸 4.2m×4.0m。
  - 岩性：绿帘石化矽卡岩、磁铁矿化矽卡岩、晶屑凝灰岩；平均单轴抗压 65.94MPa、抗拉 8.73MPa。
  - 爆破：双楔形掏槽 + 光面爆破，共 50 孔；2号岩石乳化炸药，单次 66kg；
    数码电子雷管环间延时爆破。
  - 起爆分段（表2）：第一级掏槽 0ms / 第二级掏槽 100ms / 第一级辅助 200ms /
    第二级辅助 300ms / 帮眼 400ms / 底眼 500ms / 顶眼 600ms。
  - 环间延时对岩石抛掷：50/100/150/200/500ms → 抛掷距离 62/48/28/26/20m，
    爆堆高度 1.78/1.86/2.14/2.23/2.59m；50ms 对抛掷提升最显著。

运行: venv\\Scripts\\python.exe seed_fengyin_event.py
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

EVENT_ID = "BLAST-2026-007"

# ─── 冯银（备战铁矿）文献断面（马蹄形）────────
HW = 4.2         # 巷道断面宽 (m)
TOTAL_H = 4.0    # 巷道断面高 (m)
R = 2.1          # 拱部半径 (m) = 宽/2
WALL_H = 1.9     # 直墙高 (m) = 4.0 - 2.1
AREA = round(4.2 * 1.9 + 0.5 * math.pi * 2.1 ** 2, 2)  # ≈14.91 m²
HOLE_DEPTH = 3.0
HOLE_DIAMETER = 0.04
UTILIZATION = 0.9
ADVANCE = round(HOLE_DEPTH * UTILIZATION, 3)  # 2.7 m
TOTAL_CHARGE = 66.0

EXPLOSIVE_CN = "2号岩石乳化炸药"
ROCK_CN = "矽卡岩/晶屑凝灰岩"

# 环间延时间隔(ms)：文献真实 100ms（数码电子雷管）
SEG_INTERVAL_MS = 100

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔"}

Y_CUT = 1.6
WEDGE_INNER = [(0.35, 0.3, 18), (0.7, 0.65, 28)]
WEDGE_OUTER = [(1.1, 0.35, 20), (1.5, 0.8, 30)]
WEDGE_INNER_CHARGE = 0.9
WEDGE_OUTER_CHARGE = 1.5
AUX1_CHARGE = 1.5
AUX2_CHARGE = 1.33
WALL_CHARGE = 1.2
FLOOR_CHARGE = 1.5
TOP_CHARGE = 1.03


def _inside(x, y, margin=0.1):
    if y < 0:
        return False
    half = HW / 2 - margin
    if y <= WALL_H:
        return abs(x) <= half
    return x * x + (y - WALL_H) ** 2 <= (R - margin) ** 2


def _r1(v):
    return round(v * 10) / 10


def _fengyin_holes():
    """镜像 fengyinTunnelDesign.js 的布孔，产出 legacy 中文 key 的炮孔 dict 列表。"""
    holes = []
    depth = HOLE_DEPTH

    def add(cn, x, y, chg, chlen, incl, azi, delay, series, empty=False):
        holes.append({
            "序号": len(holes) + 1,
            "孔径_m": HOLE_DIAMETER,
            "孔深_m": depth,
            "X坐标_m": _r1(x),
            "Y坐标_m": _r1(y),
            "Z坐标_m": 0,
            "孔类型": _TYPE_CN[cn],
            "倾角_度": incl,
            "是否空孔": empty,
            "炸药类型": EXPLOSIVE_CN,
            "装药量_kg": round(chg, 3),
            "雷管段别": series,
            "方位角_度": round(azi, 1),
            "装药长度_m": round(chlen, 2),
            "延期时间_ms": int(delay),
        })

    # 0. 中心空孔（自由面，段 1，0ms）
    add("cut", 0, Y_CUT, 0, 0, 0, 0, 0, 1, empty=True)

    # 1. 第一级掏槽（双楔形内排，段 1，0ms）
    for dx, dy, inc in WEDGE_INNER:
        for side in (-1, 1):
            add("cut", side * dx, Y_CUT + dy, WEDGE_INNER_CHARGE, depth * 0.6, inc, -90, 0, 1)
            add("cut", side * dx, Y_CUT - dy, WEDGE_INNER_CHARGE, depth * 0.6, inc, 90, 0, 1)

    # 2. 第二级掏槽（双楔形外排，段 2，100ms）
    for dx, dy, inc in WEDGE_OUTER:
        for side in (-1, 1):
            add("cut", side * dx, Y_CUT + dy, WEDGE_OUTER_CHARGE, depth * 0.7, inc, -90, 100, 2)
            add("cut", side * dx, Y_CUT - dy, WEDGE_OUTER_CHARGE, depth * 0.7, inc, 90, 100, 2)

    # 3. 辅助眼（环，段 3@200ms / 段 4@300ms）
    for (r, n, chg, seg) in [(0.9, 8, AUX1_CHARGE, 3), (1.35, 10, AUX2_CHARGE, 4)]:
        for i in range(n):
            a = (i / n) * math.tau
            x = math.cos(a) * r
            y = Y_CUT + math.sin(a) * r
            if not _inside(x, y, 0.05):
                continue
            azi = math.degrees(math.atan2(math.cos(a) * r, math.sin(a) * r))
            add("auxiliary", x, y, chg, depth * 0.6, 4, azi, (seg - 1) * SEG_INTERVAL_MS, seg)

    # 4. 帮眼（两侧，段 5，400ms）
    wallX = HW / 2 - 0.25
    for side in (-1, 1):
        for wyR in (0.4, 0.8):
            add("perimeter", side * wallX, WALL_H * wyR, WALL_CHARGE, depth * 0.55,
                3, 90.0 if side > 0 else -90.0, 400, 5)

    # 5. 底眼（段 6，500ms）
    for fx in (-1.2, -0.6, 0.0, 0.6, 1.2):
        add("perimeter", fx, 0.4, FLOOR_CHARGE, depth * 0.7, 6, 0.0, 500, 6)

    # 6. 顶眼（拱顶，段 7，600ms）
    archR = R - 0.25
    for i in range(7):
        a = math.pi * (i / 6)
        x = math.cos(a) * archR
        y = WALL_H + math.sin(a) * archR
        azi = math.degrees(math.atan2(x, y - WALL_H))
        add("perimeter", x, y, TOP_CHARGE, depth * 0.5, 3, azi, 600, 7)

    return holes


def _build_json_columns(holes, total_charge):
    section = {
        "断面形状": "马蹄形", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 80, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3, "掘进断面积_m2": AREA,
    }
    charge = {
        "空孔数": 1, "掏槽模式": "双楔形掏槽", "起爆网络": "数码电子雷管(环间延时)", "堵塞长度_m": 1.0,
        "装药掏槽孔数": 16, "楔形掏槽角_度": 35, "段间延时间隔_ms": SEG_INTERVAL_MS,
        "周边线装药密度_kgm": 0.24, "底板线装药密度_kgm": 0.50,
        "掏槽线装药密度_kgm": 0.50, "辅助线装药密度_kgm": 0.50,
        "最小环间延时_ms": 100,
    }
    effect = {
        "半孔率": 0.78, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 80, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.05, "最小超挖_m": 0.03, "漏斗半径_m": 1.0, "漏斗深度_m": 2.4,
        "峰值应力_MPa": 34.0, "峰值振动_Kine": 6.8,
        "模拟总时长_s": 8, "中位块度_x50_m": 0.2, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 35, "最大块度_xmax_m": 0.7,
        "80通过块度_x80_m": 0.34, "平均抛掷距离_m": 30.0, "最大抛掷距离_m": 62.0,
        "漏斗中心偏移_m": 0.2, "Swebrec弯曲参数_b": 2.1, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 6.8, "Cunningham均匀指数_n": 0.85,
        "抛掷距离_50ms_m": 62, "抛掷距离_100ms_m": 48, "抛掷距离_150ms_m": 28,
        "抛掷距离_200ms_m": 26, "抛掷距离_500ms_m": 20,
        "爆堆高度_50ms_m": 1.78, "爆堆高度_500ms_m": 2.59,
    }
    rho = {
        "天气": "晴", "泊松比": 0.22, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 3200,
        "岩体类型": ROCK_CN, "P波波速_ms": 3530, "S波波速_ms": 2100, "内摩擦角_度": 38,
        "弹性模量_GPa": 38, "抗压强度_MPa": 65.94, "抗拉强度_MPa": 8.73, "温度_摄氏度": 12,
    }
    return {
        "炮孔设计": json.dumps(holes, ensure_ascii=False),
        "断面掘进": json.dumps(section, ensure_ascii=False),
        "装药起爆": json.dumps(charge, ensure_ascii=False),
        "爆破效果": json.dumps(effect, ensure_ascii=False),
        "环境岩体": json.dumps(rho, ensure_ascii=False),
        "_total_charge": total_charge,
    }


def main():
    holes = _fengyin_holes()
    d = _build_json_columns(holes, TOTAL_CHARGE)
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM `blasting_events` WHERE `event_id` = %s", (EVENT_ID,))
        cursor.execute(
            "INSERT INTO `blasting_events` ("
            "`event_id`,`名称`,`爆心经度`,`爆心纬度`,`爆心高程`,`总装药量_kg`,"
            "`炸药类型`,`岩体类型`,`起爆方式`,`爆破时间`,`状态`,`备注`,"
            "`炮孔设计`,`断面掘进`,`装药起爆`,`爆破效果`,`环境岩体`,"
            "`创建时间`,`更新时间`) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                EVENT_ID, "备战铁矿巷道双楔形掏槽环间延时爆破(文献)",
                87.17, 43.88, 0, TOTAL_CHARGE,
                EXPLOSIVE_CN, ROCK_CN, "数码电子雷管(环间延时)",
                datetime(2026, 7, 24, 9, 30), "已规划",
                f"冯银(2024)备战铁矿巷道爆破，断面4.2×4.0m，50孔、Q=66kg；"
                f"双楔形掏槽、环间延时100ms；延时50/100/150/200/500ms→抛掷62/48/"
                f"28/26/20m、堆高1.78~2.59m；50ms对抛掷提升最显著",
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 更新事件 {EVENT_ID}")
        print(f"      名称: 备战铁矿巷道双楔形掏槽环间延时爆破(文献)")
        print(f"      断面: 4.2×4.0m 马蹄形({AREA}m²) | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {TOTAL_CHARGE}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 双楔形 数码电子雷管 环间延时{SEG_INTERVAL_MS}ms")
        print(f"      文献抛掷: 50ms→62m | 100ms→48m | 150ms→28m | 500ms→20m")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()