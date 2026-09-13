"""
将爆破事件 006（BLAST-2026-006）改为董武俊台阶法隧道文献化模型 —— 只更新该事件，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构，本脚本按该 legacy JSON 的
确切 key 结构写入文献参数（与 cesium1 前端 dongwujunTunnelDesign.js 布孔一一对应）。

依据文献（董武俊《台阶法隧道岩体爆破特性研究及岩石碎片块度预测》爆破 2023,40(2)）：
  - 工程：天江里隧道，左右线分离的双向四车道高速公路隧道，主洞高 9.25m、宽 12.25m；
    台阶法：上台阶断面 35.91m²、下台阶断面 57.28m²。
  - 岩性：第三系泥质砂岩、砂岩、砾岩及第四系松散堆积层；Ⅲ级围岩为主、Ⅳ为辅。
  - 上台阶爆破（表1）：开槽孔(段1)4 + 扩槽孔(段5)4 + 辅助孔(段7)6 + 辅助孔(段8)6 +
    崩落孔(段9)17 + 轮廓孔(段10)25 + 底孔(段11)13 → 合计75孔、75.71kg。
  - 炸药：有水段乳化炸药(φ32mm×200mm 间隔/不耦合)，其余 2#岩石硝铵炸药。
  - 单耗：上台阶 1.05 kg/m³、下台阶 0.75 kg/m³（实测）。
  - 块度：上台阶 x50=0.16m、xmax 63.5cm、n=1.05、b=0.7；下台阶 x50=0.21m、xmax 75.2cm、
    n=0.95、b=0.8。

断面尺寸：按主洞设计高 9.25m、宽 12.25m 建立全断面马蹄形模型（上/下台阶合并呈现）。

运行: venv\\Scripts\\python.exe seed_dongwujun_event.py
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

EVENT_ID = "BLAST-2026-006"

# ─── 董武俊（天江里）文献断面（主洞马蹄形）────────
HW = 12.25        # 主洞开挖宽 (m)
TOTAL_H = 9.25     # 主洞设计高 (m)
R = 6.125          # 拱部半径 (m) = 宽/2
WALL_H = 3.125     # 直墙高 (m) = 9.25 - 6.125
AREA = round(12.25 * 3.125 + 0.5 * math.pi * 6.125 ** 2, 2)  # ≈97.20 m²
HOLE_DEPTH = 2.2   # 开槽孔孔深 2.2m，其余 2.0m
HOLE_DIAMETER = 0.042  # φ42mm（凿岩机钻孔）
UTILIZATION = 0.9
ADVANCE = round(2.0 * UTILIZATION, 3)  # 1.8 m（按常规循环进尺表达）

EXPLOSIVE_CN = "2#岩石硝铵炸药"
ROCK_CN = "泥质砂岩/砂岩/砾岩"

# 段间延时间隔(ms)：压缩到 75ms 保证抛掷连续
SEG_INTERVAL_MS = 75

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔"}

Y_CUT = 3.0
WEDGE_ROWS = [(1.4, 0.8, 13), (2.2, 1.6, 25)]
WEDGE_CHARGE = 1.54
# (r, n, chg, seg)
RELIEF_LAYERS = [
    (2.4, 8, 1.4, 5),
    (3.8, 14, 1.2, 7),
    (4.6, 16, 1.2, 8),
    (5.6, 20, 1.0, 9),
]
PERIM_SPACING = 0.7


def _inside(x, y, margin=0.1):
    if y < 0:
        return False
    half = HW / 2 - margin
    if y <= WALL_H:
        return abs(x) <= half
    return x * x + (y - WALL_H) ** 2 <= (R - margin) ** 2


def _r1(v):
    return round(v * 10) / 10


def _dongwujun_holes():
    """镜像 dongwujunTunnelDesign.js 的布孔，产出 legacy 中文 key 的炮孔 dict 列表。"""
    holes = []
    depth = HOLE_DEPTH

    def add(cn, x, y, chg, chlen, incl, azi, delay, series, empty=False, dep=None):
        holes.append({
            "序号": len(holes) + 1,
            "孔径_m": HOLE_DIAMETER,
            "孔深_m": dep or depth,
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

    # 1. 楔形掏槽（上下两排 × 两侧 = 8 孔，段 1）
    for i, (dx, dy, inc) in enumerate(WEDGE_ROWS):
        for side in (-1, 1):
            add("cut", side * dx, Y_CUT + dy, WEDGE_CHARGE, depth * 0.7, inc, -90, i, 1)
            add("cut", side * dx, Y_CUT - dy, WEDGE_CHARGE, depth * 0.7, inc, 90, i, 1)

    # 2. 扩槽/辅助/崩落层（段 5/7/8/9）
    for ri, (r, n, chg, seg) in enumerate(RELIEF_LAYERS):
        dep = depth if seg == 5 else 2.0
        for i in range(n):
            a = (i / n) * math.tau
            x = math.cos(a) * r
            y = Y_CUT + math.sin(a) * r
            if not _inside(x, y):
                continue
            azi = math.degrees(math.atan2(math.cos(a) * r, math.sin(a) * r))
            add("auxiliary", x, y, chg, 2.0 * 0.6, 4, azi,
                (seg - 1) * SEG_INTERVAL_MS, seg, dep=dep)

    # 3. 周边轮廓孔（拱顶 + 边墙，段 10）
    archR = R - 0.25
    archN = max(16, round(math.pi * archR / PERIM_SPACING))
    for i in range(archN):
        a = math.pi * (i / (archN - 1))
        x = math.cos(a) * archR
        y = WALL_H + math.sin(a) * archR
        azi = math.degrees(math.atan2(x, y - WALL_H))
        add("perimeter", x, y, 0.6, 2.0 * 0.5, 3, azi,
            (10 - 1) * SEG_INTERVAL_MS, 10, dep=2.0)
    wallX = HW / 2 - 0.35
    for side in (-1, 1):
        for wyR in (0.3, 0.6, 0.85):
            add("perimeter", side * wallX, WALL_H * wyR, 0.6, 2.0 * 0.5,
                3, 90.0 if side > 0 else -90.0, (10 - 1) * SEG_INTERVAL_MS, 10, dep=2.0)

    # 4. 底孔（段 11）
    floorN = 14
    floorHalf = HW / 2 - 1.2
    for i in range(floorN):
        add("perimeter", ((2 * i) / (floorN - 1) - 1) * floorHalf, 0.55, 1.35,
            2.0 * 0.7, 6, 0.0, (11 - 1) * SEG_INTERVAL_MS, 11, dep=2.0)

    return holes


def _build_json_columns(holes, total_charge):
    section = {
        "断面形状": "马蹄形", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 120, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3, "掘进断面积_m2": AREA,
        "上台阶面积_m2": 35.91, "下台阶面积_m2": 57.28,
    }
    charge = {
        "空孔数": 1, "掏槽模式": "楔形掏槽", "起爆网络": "毫秒雷管(MS系列)", "堵塞长度_m": 1.0,
        "装药掏槽孔数": 8, "楔形掏槽角_度": 30, "段间延时间隔_ms": SEG_INTERVAL_MS,
        "周边线装药密度_kgm": 0.30, "底板线装药密度_kgm": 0.34,
        "掏槽线装药密度_kgm": 0.70, "辅助线装药密度_kgm": 0.60,
        "上台阶炸药单耗_kgm3": 1.05, "下台阶炸药单耗_kgm3": 0.75,
    }
    effect = {
        "半孔率": 0.9, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 190, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.05, "最小超挖_m": 0.03, "漏斗半径_m": 1.0, "漏斗深度_m": 2.4,
        "峰值应力_MPa": 36.0, "峰值振动_Kine": 4.5,
        "模拟总时长_s": 8, "中位块度_x50_m": 0.19, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 30, "最大块度_xmax_m": 0.75,
        "80通过块度_x80_m": 0.34, "平均抛掷距离_m": 3.0, "最大抛掷距离_m": 5.0,
        "漏斗中心偏移_m": 0.2, "Swebrec弯曲参数_b": 0.75, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 4.5, "Cunningham均匀指数_n": 1.0,
        "上台阶x50_m": 0.16, "下台阶x50_m": 0.21,
        "实测最大块度_上cm": 63.5, "实测最大块度_下cm": 75.2,
        "Kuznetsov模型适用性": "适用(高估值12~16%)", "KCO模型最大块度预测": "准确",
    }
    rho = {
        "天气": "晴", "泊松比": 0.28, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 2400,
        "岩体类型": ROCK_CN, "P波波速_ms": 3500, "S波波速_ms": 2000, "内摩擦角_度": 38,
        "弹性模量_GPa": 18, "抗压强度_MPa": 38, "抗拉强度_MPa": 3.6, "温度_摄氏度": 18,
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
    holes = _dongwujun_holes()
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
                EVENT_ID, "天江里隧道台阶法全断面爆破块度预测(文献)",
                114.03, 30.87, 0, d["_total_charge"],
                "乳化/2#岩石硝铵炸药", ROCK_CN, "毫秒雷管(MS1-11)",
                datetime(2026, 7, 24, 9, 0), "已规划",
                f"董武俊(2023)天江里隧道台阶法爆破，主洞12.25×9.25m；"
                f"上台阶单耗1.05、下台阶0.75kg/m³；x50≈0.19m、xmax实测0.75m；"
                f"Kuznetsov/Kansake适用,KCO准确预测最大块度",
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 更新事件 {EVENT_ID}")
        print(f"      名称: 天江里隧道台阶法全断面爆破块度预测(文献)")
        print(f"      断面: 12.25×9.25m 马蹄形({AREA}m²) | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {d['_total_charge']}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 楔形8孔 毫秒雷管(段1/5/7/8/9/10/11)")
        print(f"      文献块度: x50≈0.19m xmax≈0.75m | 单耗 上1.05/下0.75 kg/m³")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()