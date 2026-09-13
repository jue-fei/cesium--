"""
将爆破事件 005（BLAST-2026-005）改为余漾隧道爆堆块度文献化模型 —— 只更新该事件，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构，本脚本按该 legacy JSON 的
确切 key 结构写入文献参数（与 cesium1 前端 yuyangTunnelDesign.js 布孔一一对应，
保证多源应力波叠加数据源一致）。

依据文献（余漾等《隧道爆堆块度图像识别及块度分布快速评价研究》现代工程科技 2026,5(9)）：
  - 工程：某隧道钻爆法，掌子面单次爆破方量约 180m³。
  - 岩性：新近系泥岩夹砂岩、砾岩以及三叠系砂岩、板岩和砾岩为主；结构致密、节理裂隙中等。
  - 爆破参数：单孔装药量 1.3~2.0 kg/m（线装药密度），孔深 3.2~3.3m，孔径 32mm，
    孔距 600~1300mm。
  - 块度（Swebrec 拟合）：x50≈156~252mm、xmax≈0.65~1.37m、b≈5.58~8.17；
    级配不良（Cu=1.82~2.92 < 5，Cc=1.08~1.18 合格）。
  - 断面尺寸文献未给出，按"单次 180m³、进尺≈2.7m"推算断面积约 65~67m²：
    马蹄形 10.8m×7.4m（宽×高）。

运行: venv\\Scripts\\python.exe seed_yuyang_event.py
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

EVENT_ID = "BLAST-2026-005"

# ─── 余漾文献断面（马蹄形，按 180m³ 推算）──────────
HW = 10.8          # 掘进断面宽 (m)
TOTAL_H = 7.4      # 掘进断面高 (m)
R = 5.4            # 拱部半径 (m) = 宽/2
WALL_H = 2.0       # 直墙高 (m)
AREA = round(10.8 * 2.0 + 0.5 * math.pi * 5.4 ** 2, 2)  # ≈67.40 m²
HOLE_DEPTH = 3.2   # 孔深 3.2~3.3m（文献）
HOLE_DIAMETER = 0.032  # 孔径 32mm
UTILIZATION = 0.85
ADVANCE = round(HOLE_DEPTH * UTILIZATION, 3)  # 2.72 m

EXPLOSIVE_CN = "乳化炸药"
ROCK_CN = "泥岩夹砂岩"

# 段间延时间隔(ms)：压缩到 75ms 保证抛掷连续
SEG_INTERVAL_MS = 75

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔"}

Y_CUT = 2.4
WEDGE_ROWS = [(1.2, 0.7, 13), (1.8, 1.4, 25)]
WEDGE_CHARGE = 1.8
RELIEF_LAYERS = [(3.0, 18, 1.5, 3), (4.8, 26, 1.4, 5), (6.6, 34, 1.3, 7)]
PERIM_SPACING = 0.65


def _inside(x, y, margin=0.1):
    if y < 0:
        return False
    half = HW / 2 - margin
    if y <= WALL_H:
        return abs(x) <= half
    return x * x + (y - WALL_H) ** 2 <= (R - margin) ** 2


def _r1(v):
    return round(v * 10) / 10


def _yuyang_holes():
    """镜像 yuyangTunnelDesign.js 的布孔，产出 legacy 中文 key 的炮孔 dict 列表。"""
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

    # 0. 中心空孔（自由面，段 1）
    add("cut", 0, Y_CUT, 0, 0, 0, 0, 0, 1, empty=True)

    # 1. 楔形掏槽（上下两排 × 两侧 = 8 孔，段 1，掏槽孔内微差 0/1ms）
    for i, (dx, dy, inc) in enumerate(WEDGE_ROWS):
        for side in (-1, 1):
            add("cut", side * dx, Y_CUT + dy, WEDGE_CHARGE, depth * 0.65, inc, -90, i, 1)
            add("cut", side * dx, Y_CUT - dy, WEDGE_CHARGE, depth * 0.65, inc, 90, i, 1)

    # 2. 扩槽/崩落层（段 3/5/7）
    for ri, (r, n, chg, seg) in enumerate(RELIEF_LAYERS):
        for i in range(n):
            a = (i / n) * math.tau
            x = math.cos(a) * r
            y = Y_CUT + math.sin(a) * r
            if not _inside(x, y):
                continue
            azi = math.degrees(math.atan2(math.cos(a) * r, math.sin(a) * r))
            add("auxiliary", x, y, chg, depth * 0.6, 4, azi,
                (seg - 1) * SEG_INTERVAL_MS, seg)

    # 3. 周边光爆孔（拱顶 段9 + 边墙 段7 + 底排 段7）
    archR = R - 0.25
    archN = max(14, round(math.pi * archR / PERIM_SPACING))
    for i in range(archN):
        a = math.pi * (i / (archN - 1))
        x = math.cos(a) * archR
        y = WALL_H + math.sin(a) * archR
        azi = math.degrees(math.atan2(x, y - WALL_H))
        add("perimeter", x, y, 0.6, depth * 0.5, 3, azi, (9 - 1) * SEG_INTERVAL_MS, 9)
    wallX = HW / 2 - 0.35
    for side in (-1, 1):
        for wyR in (0.3, 0.6, 0.85):
            add("perimeter", side * wallX, WALL_H * wyR, 1.2, depth * 0.55,
                3, 90.0 if side > 0 else -90.0, (7 - 1) * SEG_INTERVAL_MS, 7)
    floorN = 11
    floorHalf = HW / 2 - 1.2
    for i in range(floorN):
        add("perimeter", ((2 * i) / (floorN - 1) - 1) * floorHalf, 0.5, 1.6,
            depth * 0.7, 6, 0.0, (7 - 1) * SEG_INTERVAL_MS, 7)

    return holes


def _build_json_columns(holes, total_charge):
    section = {
        "断面形状": "马蹄形", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 80, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3, "掘进断面积_m2": AREA,
        "单次爆破方量_m3": round(AREA * ADVANCE, 2),
    }
    charge = {
        "空孔数": 1, "掏槽模式": "楔形掏槽", "起爆网络": "数码电子雷管", "堵塞长度_m": 1.0,
        "装药掏槽孔数": 8, "楔形掏槽角_度": 30, "段间延时间隔_ms": SEG_INTERVAL_MS,
        "周边线装药密度_kgm": 0.30, "底板线装药密度_kgm": 0.42,
        "掏槽线装药密度_kgm": 0.29, "辅助线装药密度_kgm": 0.35,
    }
    effect = {
        "半孔率": 0.85, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 160, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.05, "最小超挖_m": 0.03, "漏斗半径_m": 1.0, "漏斗深度_m": 2.4,
        "峰值应力_MPa": 32.0, "峰值振动_Kine": 2.4,
        "模拟总时长_s": 8, "中位块度_x50_m": 0.19, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 30, "最大块度_xmax_m": 0.65,
        "80通过块度_x80_m": 0.32, "平均抛掷距离_m": 3.0, "最大抛掷距离_m": 5.0,
        "漏斗中心偏移_m": 0.2, "Swebrec弯曲参数_b": 6.17, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 2.4, "Cunningham均匀指数_n": 0.8,
        "不均匀系数_Cu": 1.82, "曲率系数_Cc": 1.09, "级配评价": "不良(均匀性偏小)",
        "Swebrec拟合R2": 0.85,
    }
    rho = {
        "天气": "晴", "泊松比": 0.27, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 2450,
        "岩体类型": ROCK_CN, "P波波速_ms": 3600, "S波波速_ms": 2100, "内摩擦角_度": 36,
        "弹性模量_GPa": 22, "抗压强度_MPa": 45, "抗拉强度_MPa": 4.5, "温度_摄氏度": 18,
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
    holes = _yuyang_holes()
    total_charge = round(sum(h["装药量_kg"] for h in holes), 2)
    d = _build_json_columns(holes, total_charge)
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
                EVENT_ID, "余漾隧道爆堆块度钻爆法全断面(文献)",
                121.61, 38.95, 0, d["_total_charge"],
                EXPLOSIVE_CN, ROCK_CN, "数码电子雷管",
                datetime(2026, 7, 24, 9, 0), "已规划",
                f"余漾(2026)某隧道钻爆法全断面，单次方量≈180m³，断面10.8×7.4m(估算)；"
                f"孔深3.2m、孔径32mm、单孔装药1.3-2.0kg/m；Swebrec块度x50≈0.19m、"
                f"xmax≈0.65m、b=6.17；级配不良(Cu=1.82、Cc=1.09)",
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 更新事件 {EVENT_ID}")
        print(f"      名称: 余漾隧道爆堆块度钻爆法全断面(文献)")
        print(f"      断面: 10.8×7.4m 马蹄形({AREA}m²) | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {d['_total_charge']}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 楔形8孔 数码电子雷管")
        print(f"      文献块度: x50≈0.19m xmax≈0.65m b=6.17 | 级配不良 Cu=1.82 Cc=1.09")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()