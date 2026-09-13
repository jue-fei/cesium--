"""
将爆破事件 001（BLAST-2026-001）改为达巴莱隧道文献化模型 —— 只更新该事件，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构（炮孔设计/断面掘进/装药起爆/
爆破效果/环境岩体），后端 blasting.py 通过 `_use_legacy_blasting_schema` 自动识别并解析。
本脚本按该 legacy JSON 的确切 key 结构写入文献参数（与 cesium1 前端
dabalaiTunnelDesign.js 布孔一一对应，保证多源应力波叠加数据源一致）。

依据文献（Hu Y, Yang R, Zuo J 等. Study on the Characteristics and Parameter
Optimization of Wedge Cut Delayed Blasting in a Tunnel. Eng 2026, 7, 161）：
  - 达巴莱隧道，浙江遂昌县新路湾镇，最大埋深约 25m，洞口 20m 处有桥梁施工；中等风化
    石灰岩、节理裂隙发育、岩体破碎。
  - 电子雷管精密延时楔形掏槽：掏槽孔分初始组/次生组，段间延时 4~8ms（现场取 Δt=4ms）。
  - 现场 10 常规+10 延时对比：平均拉槽效率 77.8%→97.3%（+19.5%），大块率 30.6%→11.4%
    （-19.2%），PPV 11.8→5.6 cm/s（-52.5%），主频 34.1→66.5Hz（+48.7%）。
  - 断面尺寸文献未给出，按浅埋小断面估算：马蹄形 9.0m×7.0m（宽×高），拱部半径 4.5m。
  - 萨道夫斯基 K/α 文献未回归，取中等风化石灰岩典型量级估算 K=150、α=1.7。

运行: venv\\Scripts\\python.exe seed_dabalai_event.py
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

EVENT_ID = "BLAST-2026-001"

# ─── 达巴莱隧道文献断面（马蹄形，估算）────────────────
HW = 9.0            # 掘进断面宽 (m)
TOTAL_H = 7.0       # 掘进断面高 (m)
R = 4.5             # 拱部半径 (m) = 宽/2
WALL_H = 2.5        # 直墙高 (m)
AREA = round(9.0 * 2.5 + 0.5 * math.pi * 4.5 ** 2, 2)  # ≈54.31 m²
HOLE_DEPTH = 3.0
HOLE_DIAMETER = 0.04
UTILIZATION = 0.85
ADVANCE = round(HOLE_DEPTH * UTILIZATION, 3)  # 2.55 m
TOTAL_CHARGE = 110.0

EXPLOSIVE_CN = "乳化炸药"
ROCK_CN = "石灰岩"

# 段间延时间隔(ms)：压缩到真实毫秒级保证抛掷连续；掏槽孔内初始/次生组微差 4ms（电子雷管）
SEG_INTERVAL_MS = 75

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔"}

# 掏槽核心线高度（掌子面中下）
Y_CUT = 1.8
# 楔形掏槽：每排为上下两孔对称斜孔向核心线汇拢，[孔口横向展布, 距核心线竖向Δy, 倾角°]
# 初始组=内排(delay 0)，次生组=外排(delay 4ms，电子雷管分段)；2 排×2 侧×上下=8 孔
WEDGE_ROWS = [
    (0.4, 0.5, 9),  # 内排（初始组）
    (1.2, 1.3, 25),  # 外排（次生组）
]
WEDGE_CHARGE = 2.4
RELIEF_LAYERS = [(2.4, 12, 1.8, 3), (3.6, 16, 1.5, 5)]
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


def _dabalai_holes():
    """镜像 dabalaiTunnelDesign.js 的布孔，产出 legacy 中文 key 的炮孔 dict 列表。"""
    holes = []
    depth = HOLE_DEPTH

    def add(cn, x, y, chg, chlen, incl, azi, delay, series):
        holes.append({
            "序号": len(holes) + 1,
            "孔径_m": HOLE_DIAMETER,
            "孔深_m": depth,
            "X坐标_m": _r1(x),
            "Y坐标_m": _r1(y),
            "Z坐标_m": 0,
            "孔类型": _TYPE_CN[cn],
            "倾角_度": incl,
            "是否空孔": False,
            "炸药类型": EXPLOSIVE_CN,
            "装药量_kg": round(chg, 3),
            "雷管段别": series,
            "方位角_度": round(azi, 1),
            "装药长度_m": round(chlen, 2),
            "延期时间_ms": int(delay),
        })

    # 1. 楔形掏槽（初始组 4 + 次生组 4 = 8，段 1，掏槽内微差 4ms）
    for idx, (dx, dy, inc) in enumerate(WEDGE_ROWS):
        delay = 0 if idx == 0 else 4  # 内排初始 0ms / 外排次生 4ms
        for side in (-1, 1):
            add("cut", side * dx, Y_CUT + dy, WEDGE_CHARGE, depth * 0.7,
                inc, -90, delay, 1)
            add("cut", side * dx, Y_CUT - dy, WEDGE_CHARGE, depth * 0.7,
                inc, 90, delay, 1)

    # 2. 扩槽/崩落层（段 3/5）
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

    # 3. 周边光爆孔（拱顶 段9 + 边墙 段7 + 底排 段7）
    archR = R - 0.25
    archN = max(10, round(math.pi * archR / PERIM_SPACING))
    for i in range(archN):
        a = math.pi * (i / (archN - 1))
        x = math.cos(a) * archR
        y = WALL_H + math.sin(a) * archR
        azi = math.degrees(math.atan2(x, y - WALL_H))
        add("perimeter", x, y, 0.6, depth * 0.6, 3, azi, (9 - 1) * SEG_INTERVAL_MS, 9)
    wallX = HW / 2 - 0.3
    for side in (-1, 1):
        for wyR in (0.35, 0.7):
            add("perimeter", side * wallX, WALL_H * wyR, 1.2, depth * 0.6,
                3, 90.0 if side > 0 else -90.0, (7 - 1) * SEG_INTERVAL_MS, 7)
    floorN = 9
    floorHalf = HW / 2 - 1.0
    for i in range(floorN):
        add("perimeter", ((2 * i) / (floorN - 1) - 1) * floorHalf, 0.5, 1.8,
            depth * 0.7, 6, 0.0, (7 - 1) * SEG_INTERVAL_MS, 7)

    return holes


def _build_json_columns(holes):
    total_charge = round(sum(h["装药量_kg"] for h in holes), 2)
    section = {
        "断面形状": "马蹄形", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 60, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3, "掘进断面积_m2": AREA,
    }
    charge = {
        "空孔数": 0, "掏槽模式": "楔形掏槽-精密延时", "起爆网络": "数码电子雷管(Δt=4ms)", "堵塞长度_m": 1.0,
        "装药掏槽孔数": 8, "楔形掏槽角_度": 25, "段间延时间隔_ms": SEG_INTERVAL_MS,
        "掏槽孔内微差_ms": 4, "周边线装药密度_kgm": 0.20, "底板线装药密度_kgm": 0.38,
        "掏槽线装药密度_kgm": 0.29, "辅助线装药密度_kgm": 0.35,
    }
    effect = {
        "半孔率": 0.85, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 140, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.05, "最小超挖_m": 0.03, "漏斗半径_m": 1.0, "漏斗深度_m": 2.4,
        "峰值应力_MPa": 35.0, "峰值振动_Kine": 5.6,
        "模拟总时长_s": 8, "中位块度_x50_m": 0.14, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 30, "最大块度_xmax_m": 0.65,
        "80通过块度_x80_m": 0.24, "平均抛掷距离_m": 3.0, "最大抛掷距离_m": 5.0,
        "漏斗中心偏移_m": 0.2, "Swebrec弯曲参数_b": 2.3, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 5.6, "Cunningham均匀指数_n": 0.9,
        "平均拉槽效率_pct": 97.3, "大块率_pct": 11.4, "主振频率_Hz": 66.5,
        "萨道夫斯基_K": 150.0, "萨道夫斯基_α": 1.7,
    }
    rho = {
        "天气": "晴", "泊松比": 0.28, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 2650,
        "岩体类型": ROCK_CN, "P波波速_ms": 4200, "S波波速_ms": 2400, "内摩擦角_度": 38,
        "弹性模量_GPa": 45, "抗压强度_MPa": 90, "抗拉强度_MPa": 7, "温度_摄氏度": 20,
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
        cursor.execute("DELETE FROM `blasting_events` WHERE `event_id` = %s", (EVENT_ID,))
        cursor.execute(
            "INSERT INTO `blasting_events` ("
            "`event_id`,`名称`,`爆心经度`,`爆心纬度`,`爆心高程`,`总装药量_kg`,"
            "`炸药类型`,`岩体类型`,`起爆方式`,`爆破时间`,`状态`,`备注`,"
            "`炮孔设计`,`断面掘进`,`装药起爆`,`爆破效果`,`环境岩体`,"
            "`创建时间`,`更新时间`) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                EVENT_ID, "达巴莱隧道楔形掏槽精密延时爆破(文献)",
                119.28, 28.51, 0, d["_total_charge"],
                EXPLOSIVE_CN, ROCK_CN, "数码电子雷管(Δt=4ms)",
                datetime(2026, 7, 24, 8, 30), "已规划",
                f"达巴莱隧道楔形掏槽电子雷管精密延时，断面9.0×7.0m(估算)；"
                f"拉槽效率97.3%、大块率11.4%、PPV=5.6cm/s、主频66.5Hz；"
                f"K=150、α=1.7(估算)",
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 更新事件 {EVENT_ID}")
        print(f"      名称: 达巴莱隧道楔形掏槽精密延时爆破(文献)")
        print(f"      断面: 9.0×7.0m 马蹄形({AREA}m²) | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {d['_total_charge']}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 楔形8孔(初始/次生 Δt=4ms) | 电子雷管 | K=150, α=1.7")
        print(f"      文献值: 拉槽效率97.3% 大块率11.4% PPV=5.6cm/s 主频66.5Hz")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()