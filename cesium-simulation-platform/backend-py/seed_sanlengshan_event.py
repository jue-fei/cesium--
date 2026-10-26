"""
将爆破事件 003（BLAST-2026-003）改为三棱山隧道文献化模型 —— 只更新该事件，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构，本脚本按该 legacy JSON 的
确切 key 结构写入文献参数（与 cesium1 前端 sanlengshanTunnelDesign.js 布孔一一对应）。

依据文献（徐言. 基于萨道夫斯基公式分段修正的隧道爆破振动研究. 科学技术创新 2020(21):103-104）：
  - 三棱山隧道，京沈客专，辽宁阜新阜蒙县紫都台乡，全长 8888m，最大埋深 217.56m，
    双向高铁线路隧道，断面大、地层条件差。
  - 2 号岩石乳化炸药；常规布孔（掏槽/辅助/崩落/周边/底孔），掏槽位于掌子面中下、
    楔形掏槽；孔距 0.5~0.7m、孔深 3.0m；周边孔(MS11)与拱顶孔(MS13)间隔装药，
    其余不耦合装药、装药长度 2.5m；毫秒延时爆破。
  - 萨道夫斯基分段修正：近/远场分界 R=110m；近场 α=1.082、K=19.3（拟合95%），
    远场 α=0.372、K≈1.23（拟合81%）。本平台振动场默认采用近场 K=19.3、α=1.082。
  - 断面尺寸文献未给出，按"双向高铁线路隧道"量级估算：马蹄形 13.5m×10.25m（宽×高）。

运行: venv\\Scripts\\python.exe seed_sanlengshan_event.py
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

EVENT_ID = "BLAST-2026-003"

# ─── 三棱山隧道文献断面（马蹄形，估算，高铁双线量级）──────────
HW = 13.5           # 掘进断面宽 (m)
TOTAL_H = 10.25     # 掘进断面高 (m)
R = 6.75            # 拱部半径 (m) = 宽/2
WALL_H = 3.5        # 直墙高 (m)
AREA = round(13.5 * 3.5 + 0.5 * math.pi * 6.75 ** 2, 2)  # ≈118.80 m²
HOLE_DEPTH = 3.0    # 钻孔深度（文献 2.2）
HOLE_DIAMETER = 0.04
UTILIZATION = 0.9
ADVANCE = round(HOLE_DEPTH * UTILIZATION, 3)  # 2.7 m
TOTAL_CHARGE = 200.0

EXPLOSIVE_CN = "乳化炸药"
ROCK_CN = "灰岩"

# 段间延时间隔(ms)：压缩到 75ms 保证抛掷连续；文献真实为毫秒雷管（周边 MS11/拱顶 MS13）
SEG_INTERVAL_MS = 75

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔"}

Y_CUT = 2.6
WEDGE_ROWS = [(0.8, 0.7, 13), (1.4, 1.4, 25)]
WEDGE_CHARGE = 2.4
RELIEF_LAYERS = [(3.0, 16, 1.8, 3), (4.8, 22, 1.5, 5), (6.6, 30, 1.3, 7)]
PERIM_SPACING = 0.6


def _inside(x, y, margin=0.1):
    if y < 0:
        return False
    half = HW / 2 - margin
    if y <= WALL_H:
        return abs(x) <= half
    return x * x + (y - WALL_H) ** 2 <= (R - margin) ** 2


def _r1(v):
    return round(v * 10) / 10


def _sanlengshan_holes():
    """镜像 sanlengshanTunnelDesign.js 的布孔，产出 legacy 中文 key 的炮孔 dict 列表。"""
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
            add("cut", side * dx, Y_CUT + dy, WEDGE_CHARGE, depth * 0.7, inc, -90, i, 1)
            add("cut", side * dx, Y_CUT - dy, WEDGE_CHARGE, depth * 0.7, inc, 90, i, 1)

    # 2. 扩槽/崩落层（段 3/5/7）
    for ri, (r, n, chg, seg) in enumerate(RELIEF_LAYERS):
        for i in range(n):
            a = (i / n) * math.tau
            x = math.cos(a) * r
            y = Y_CUT + math.sin(a) * r
            if not _inside(x, y):
                continue
            azi = math.degrees(math.atan2(math.cos(a) * r, math.sin(a) * r))
            add("auxiliary", x, y, chg, depth * 0.65, 4, azi,
                (seg - 1) * SEG_INTERVAL_MS, seg)

    # 3. 周边光爆孔（拱顶段13 + 两侧拱段11 + 边墙11 + 底排9；间隔装药）
    archR = R - 0.25
    archN = max(16, round(math.pi * archR / PERIM_SPACING))
    for i in range(archN):
        a = math.pi * (i / (archN - 1))
        x = math.cos(a) * archR
        y = WALL_H + math.sin(a) * archR
        azi = math.degrees(math.atan2(x, y - WALL_H))
        seg = 13 if abs(a - math.pi / 2) < math.pi / 6 else 11
        add("perimeter", x, y, 0.5, depth * 0.6, 3, azi, (seg - 1) * SEG_INTERVAL_MS, seg)
    wallX = HW / 2 - 0.35
    for side in (-1, 1):
        for wyR in (0.3, 0.6, 0.85):
            add("perimeter", side * wallX, WALL_H * wyR, 1.2, depth * 0.6,
                3, 90.0 if side > 0 else -90.0, (11 - 1) * SEG_INTERVAL_MS, 11)
    floorN = 13
    floorHalf = HW / 2 - 1.2
    for i in range(floorN):
        add("perimeter", ((2 * i) / (floorN - 1) - 1) * floorHalf, 0.55, 1.8,
            depth * 0.7, 6, 0.0, (9 - 1) * SEG_INTERVAL_MS, 9)

    return holes


def _build_json_columns(holes):
    total_charge = round(sum(h["装药量_kg"] for h in holes), 2)
    section = {
        "断面形状": "马蹄形", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 80, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3, "掘进断面积_m2": AREA,
    }
    charge = {
        "空孔数": 1, "掏槽模式": "楔形掏槽", "起爆网络": "毫秒雷管(MS11/13)", "堵塞长度_m": 1.0,
        "装药掏槽孔数": 8, "楔形掏槽角_度": 30, "段间延时间隔_ms": SEG_INTERVAL_MS,
        "周边线装药密度_kgm": 0.18, "底板线装药密度_kgm": 0.38,
        "掏槽线装药密度_kgm": 0.29, "辅助线装药密度_kgm": 0.33,
    }
    effect = {
        "半孔率": 0.88, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 180, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.05, "最小超挖_m": 0.03, "漏斗半径_m": 1.0, "漏斗深度_m": 2.4,
        "峰值应力_MPa": 38.0, "峰值振动_Kine": 3.2,
        "模拟总时长_s": 8, "中位块度_x50_m": 0.13, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 30, "最大块度_xmax_m": 0.6,
        "80通过块度_x80_m": 0.22, "平均抛掷距离_m": 3.0, "最大抛掷距离_m": 5.0,
        "漏斗中心偏移_m": 0.2, "Swebrec弯曲参数_b": 2.3, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 3.2, "Cunningham均匀指数_n": 0.9,
        "近远场分界_m": 110, "近场拟合精度": 0.95, "远场拟合精度": 0.81,
        "萨道夫斯基_K": 19.3, "萨道夫斯基_α": 1.082,
    }
    rho = {
        "天气": "晴", "泊松比": 0.3, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 2600,
        "岩体类型": ROCK_CN, "P波波速_ms": 4000, "S波波速_ms": 2300, "内摩擦角_度": 36,
        "弹性模量_GPa": 42, "抗压强度_MPa": 85, "抗拉强度_MPa": 6.5, "温度_摄氏度": 15,
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
    holes = _sanlengshan_holes()
    d = _build_json_columns(holes)
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
                EVENT_ID, "三棱山隧道钻爆法掘进(文献)",
                121.75, 42.10, 0, d["_total_charge"],
                EXPLOSIVE_CN, ROCK_CN, "毫秒雷管(MS11周边/MS13拱顶)",
                datetime(2026, 7, 24, 8, 30), "已规划",
                f"三棱山高铁隧道钻爆掘进，拱形断面13.5×10.25m(估算)；"
                f"楔形掏槽、孔距0.5-0.7m、孔深3.0m；萨道夫斯基分段修正"
                f"近场K=19.3、α=1.082(R<110m)",
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 更新事件 {EVENT_ID}")
        print(f"      名称: 三棱山隧道钻爆法掘进(文献)")
        print(f"      断面: 13.5×10.25m 马蹄形({AREA}m²) | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {d['_total_charge']}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 楔形8孔 毫秒雷管 | K=19.3, α=1.082(近场R<110m)")
        print(f"      MS段别: 周边MS11 拱顶MS13 间隔装药")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()