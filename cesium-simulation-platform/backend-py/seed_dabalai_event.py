"""
新增 Da Balai 隧道楔形掏槽微差爆破事件（BLAST-2026-006）——只增量插入，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构（炮孔设计/断面掘进/装药起爆/
爆破效果/环境岩体），后端 blasting.py 通过 `_use_legacy_blasting_schema` 自动识别并解析。
本脚本按该 legacy JSON 的确切 key 结构写入文献参数：

依据文献（Da Balai 隧道楔形掏槽微差爆破）：
  - 断面：4m 宽 × 6.4m 总高（直墙 4.4m + 半圆拱 r=2.0m）马蹄形
  - 掏槽：楔形 6 孔（孔口 ±0.55/0.95/1.35m、向核心收敛 30/36/42°）
  - 起爆：微差 0/2/4ms，初始减量装药（0.55/0.72/0.88kg）
  - 孔深 2.5m，总装药 ≈ 12.9kg
炮孔几何与前端 daBalaiDesign.js 一致，保证多源应力波叠加数据源一致。

运行: .venv\\Scripts\\python.exe seed_dabalai_event.py
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

# ─── Da Balai 文献断面 ─────────────────────────────────────
HW = 4.0    # 断面宽度 m
WALL_H = 4.4  # 直墙高度 m
R = 2.0    # 拱部半径 m
TOTAL_H = 6.4  # 断面总高 m
HOLE_DEPTH = 2.5
HOLE_DIAMETER = 0.04
UTILIZATION = 0.85
ADVANCE = round(HOLE_DEPTH * UTILIZATION, 3)  # 2.125 m
CY0 = TOTAL_H * 0.5  # 3.2

EXPLOSIVE_CN = "乳化炸药"
ROCK_CN = "石灰岩"

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔", "empty": "空孔"}


def _dabalai_holes():
    """镜像 daBalaiDesign.js 的楔形几何，产出 legacy 中文 key 的炮孔 dict 列表。"""
    holes = []
    depth = HOLE_DEPTH

    def add(cn, x, y, chg, chlen, incl, azi, delay, series, empty=False):
        holes.append({
            "序号": len(holes) + 1,
            "孔径_m": HOLE_DIAMETER if not empty else HOLE_DIAMETER * 1.6,
            "孔深_m": depth,
            "X坐标_m": round(x, 3),
            "Y坐标_m": round(y, 3),
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

    # 楔形掏槽：初始 + 辅助共 6 孔（每侧 3，微差 0/2/4ms，初始减量装药）
    for i, (wx, delay, chg, incl) in enumerate(
        zip([0.55, 0.95, 1.35], [0, 2, 4], [0.55, 0.72, 0.88], [30, 36, 42])
    ):
        for side in (-1, 1):
            add("cut", side * wx, CY0, chg, depth * 0.8,
                incl, 90.0 if side > 0 else -90.0, delay, i + 1)

    # 辅助孔（一环，围绕掏槽核心）
    for i in range(6):
        a = (i / 6) * math.tau
        x = math.cos(a) * 1.7
        y = CY0 + math.sin(a) * 1.7
        if abs(x) > HW / 2 - 0.3:
            continue
        azi = 0.0
        add("auxiliary", x, y, 0.9, depth * 0.7, 8, azi, 6 + i, 10 + i)

    # 周边孔-直墙两排
    halfW = HW / 2 - 0.2  # 1.8
    for side in (-1, 1):
        azi = 90.0 if side > 0 else -90.0
        add("perimeter", side * halfW, 0.5, 0.4, depth * 0.6, 3, azi, 12 + side, 30)
        add("perimeter", side * halfW, WALL_H - 0.4, 0.4, depth * 0.6, 3, azi, 14, 31)

    # 周边孔-拱部
    archN = 5
    for i in range(1, archN):
        a = math.pi - (i / archN) * math.pi
        x = math.cos(a) * R
        y = WALL_H + math.sin(a) * R
        azi = math.degrees(math.atan2(x, y - WALL_H)) if abs(y - WALL_H) > 0.01 else 0.0
        add("perimeter", x, y, 0.4, depth * 0.6, 3, azi, 10 + i, 32 + i)

    return holes


def _build_json_columns(holes):
    total_charge = round(sum(h["装药量_kg"] for h in holes), 2)
    section = {
        "断面形状": "马蹄形", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 80, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3,
    }
    charge = {
        "空孔数": 0, "掏槽模式": "楔形掏槽", "起爆网络": "导爆管", "堵塞长度_m": 0.6,
        "装药掏槽孔数": 6, "楔形掏槽角_度": 36, "段间延时间隔_ms": 2,
        "周边线装药密度_kgm": 0.27, "底板线装药密度_kgm": 0.5,
        "掏槽线装药密度_kgm": 0.36, "辅助线装药密度_kgm": 0.51,
    }
    effect = {
        "半孔率": 0.85, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 120, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.06, "最小超挖_m": 0.04, "漏斗半径_m": 0.8, "漏斗深度_m": 2.2,
        "峰值应力_MPa": 28.0, "峰值振动_Kine": round(2.8 * 1.414, 2),
        "模拟总时长_s": 8, "中位块度_x50_m": 0.18, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 35, "最大块度_xmax_m": 0.9,
        "80通过块度_x80_m": 0.27, "平均抛掷距离_m": 4.0, "最大抛掷距离_m": 6.5,
        "漏斗中心偏移_m": 0.32, "Swebrec弯曲参数_b": 2.5, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 2.8, "Cunningham均匀指数_n": 0.9,
    }
    rho = {
        "天气": "晴", "泊松比": 0.25, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 2450,
        "岩体类型": ROCK_CN, "P波波速_ms": 3900, "S波波速_ms": 2250, "内摩擦角_度": 35,
        "弹性模量_GPa": 42, "抗压强度_MPa": 85, "抗拉强度_MPa": 6, "温度_摄氏度": 20,
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
    holes = _dabalai_holes()
    d = _build_json_columns(holes)
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()
    try:
        # 幂等：若已存在同 event_id 则先删除（只删本事件，不影响他表）
        cursor.execute("DELETE FROM `blasting_events` WHERE `event_id` = %s", (EVENT_ID,))
        cursor.execute(
            "INSERT INTO `blasting_events` ("
            "`event_id`,`名称`,`爆心经度`,`爆心纬度`,`爆心高程`,`总装药量_kg`,"
            "`炸药类型`,`岩体类型`,`起爆方式`,`爆破时间`,`状态`,`备注`,"
            "`炮孔设计`,`断面掘进`,`装药起爆`,`爆破效果`,`环境岩体`,"
            "`创建时间`,`更新时间`) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                EVENT_ID, "Da Balai隧道楔形掏槽微差爆破",
                116.3922, 39.9022, 0, d["_total_charge"],
                EXPLOSIVE_CN, ROCK_CN, "导爆管",
                datetime(2026, 7, 24, 8, 30), "已规划",
                "Da Balai隧道楔形掏槽+微差0/2/4ms，断面4×6.4m，Q≈%.1fkg" % d["_total_charge"],
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 新增事件 {EVENT_ID}")
        print(f"      名称: Da Balai隧道楔形掏槽微差爆破")
        print(f"      断面: 4×6.4m 马蹄形 | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {d['_total_charge']}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 楔形6孔 微差0/2/4ms 初始减量装药")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()