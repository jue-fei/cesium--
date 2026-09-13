"""
将爆破事件 006（BLAST-2026-006）完全改为昆阳磷矿文献化模型 —— 只更新该事件，不重建库。

写目标：线上 `blasting_events` 为旧中文列 + JSON 扁平结构（炮孔设计/断面掘进/装药起爆/
爆破效果/环境岩体），后端 blasting.py 通过 `_use_legacy_blasting_schema` 自动识别并解析。
本脚本按该 legacy JSON 的确切 key 结构写入文献参数。

依据文献（王万禄等《昆阳磷矿二矿巷道围岩爆破振动监测与分析》采矿技术 2025,25(2):78-88）：
  - 断面：1890m中段2#胶带巷道，三心拱形掘进断面 4.7m×3.75m，断面积 15.81m²；
    净宽 4.50m / 净高 3.50m；岩体为底板白云岩，f=4~10。
  - 布孔（监测段落，楔形掏槽）：掏槽眼 8 + 辅助眼 20 + 底眼 6 + 周边眼 9 = 43 孔；
    孔深 3.0m（YT28 凿岩机），总装药量 84kg（1# 岩石乳化炸药），爆破后进尺约 2.55m。
  - 起爆：数码电子雷管 8 段，段间隔毫秒延期（SEG_INTERVAL_MS=75ms，贴近真实电子雷管）；
    掏槽 1 段、辅助 2~6 段、底眼 7 段、周边 8 段。缩段间隔使各段抛掷在时间上交叠，
    避免原 500ms 因物理引擎"到点整批瞬动"造成的明显分段抛掷假象。
  - 萨道夫斯基回归：V = 90.63·(Q^(1/3)/R)^1.58（据 M1~M3 三方向合成速度最小二乘，M4 异常剔除）。

炮孔几何与前端 kunyangTunnelDesign.js 一致，保证多源应力波叠加数据源一致。

运行: .venv\\Scripts\\python.exe seed_kunyang_event.py
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

EVENT_ID = "BLAST-2026-004"

# ─── 昆阳磷矿文献断面（三心拱 → horseshoe 近似，与前端一致）────────
HW = 4.7          # 掘进断面宽 (m)
TOTAL_H = 3.75    # 掘进断面高 (m)
R = 2.35          # 拱部半径 (m) = 宽/2
WALL_H = 1.40     # 直墙高 (m)
AREA = 15.81      # 掘进断面积 (m²)
HOLE_DEPTH = 3.0
HOLE_DIAMETER = 0.04
UTILIZATION = 0.85
ADVANCE = round(HOLE_DEPTH * UTILIZATION, 3)  # 2.55 m
TOTAL_CHARGE = 84.0

EXPLOSIVE_CN = "乳化炸药"
ROCK_CN = "白云岩"

# 段间延时间隔(ms)：贴近数码电子雷管的毫秒延期。原 500ms×8 段把抛掷铺开至 3.5s，
# 且物理引擎按 delayTime 到点才整批瞬动，造成"抛一批→硬停→再抛一批"的分段假象。
# 压缩到真实毫秒级(75ms)后，前序碎块仍在飞散时后段即起爆，各段抛掷在时间上相交叠，
# 呈现与真实爆破一致的连续抛掷；同时保留 8 段的起爆先后顺序（掏槽→辅助→底眼→周边）。
SEG_INTERVAL_MS = 75

_TYPE_CN = {"cut": "掏槽孔", "auxiliary": "辅助孔", "perimeter": "周边孔"}


def _inside(x, y, margin=0.1):
    if y < 0:
        return False
    half = HW / 2 - margin
    if y <= WALL_H:
        return abs(x) <= half
    return x * x + (y - WALL_H) ** 2 <= (R - margin) ** 2


def _r1(v):
    return round(v * 10) / 10


def _kunyang_holes():
    """镜像 kunyangTunnelDesign.js 的布孔，产出 legacy 中文 key 的炮孔 dict 列表。"""
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

    # 1. 楔形掏槽眼 8（段 1 / 0ms）
    for i, wx in enumerate([0.4, 0.8, 1.2, 1.6]):
        for side in (-1, 1):
            add("cut", side * wx, 1.3, 2.4, depth * 0.7,
                [55, 60, 65, 70][i], 90.0 if side > 0 else -90.0, 0, 1)

    # 2. 辅助眼 20（两环，段 2~6，段间隔 SEG_INTERVAL_MS）
    for ri, (r, n, chg) in enumerate([(0.8, 8, 2.3), (1.3, 12, 1.9)]):
        for i in range(n):
            a = (i / n) * math.tau
            x = math.cos(a) * r
            y = 1.3 + math.sin(a) * r
            if not _inside(x, y):
                continue
            series = 2 + ((ri + i) % 5)
            azi = math.degrees(math.atan2(math.cos(a) * r, math.sin(a) * r))
            add("auxiliary", x, y, chg, depth * 0.65, 4, azi,
                (series - 1) * SEG_INTERVAL_MS, series)

    # 3. 周边光爆孔 9（拱部 5 + 帮眼 4，段 8）
    archR = R - 0.2
    for ang in (50, 70, 90, 110, 130):
        rad = math.radians(ang)
        x = math.cos(rad) * archR
        y = WALL_H + math.sin(rad) * archR
        if not _inside(x, y, 0.05):
            continue
        azi = math.degrees(math.atan2(x, y - WALL_H))
        add("perimeter", x, y, 1.0, depth * 0.55, 3, azi,
            (8 - 1) * SEG_INTERVAL_MS, 8)
    for side in (-1, 1):
        for wy in (0.6, 1.05):
            add("perimeter", side * (HW / 2 - 0.3), wy, 1.0, depth * 0.55,
                3, 90.0 if side > 0 else -90.0, (8 - 1) * SEG_INTERVAL_MS, 8)

    # 4. 底眼 6（段 7）
    for fx in (0.6, 1.2, 1.8):
        for side in (-1, 1):
            add("perimeter", side * fx, 0.4, 2.4, depth * 0.7, 6, 0.0,
                (7 - 1) * SEG_INTERVAL_MS, 7)

    return holes


def _build_json_columns(holes):
    total_charge = round(sum(h["装药量_kg"] for h in holes), 2)
    section = {
        "断面形状": "三心拱", "拱部半径_m": R, "断面宽度_m": HW, "直墙高度_m": WALL_H,
        "钻孔深度_m": HOLE_DEPTH, "钻孔直径_m": HOLE_DIAMETER, "炮孔利用率": UTILIZATION,
        "单循环进尺_m": ADVANCE, "已开挖长度_m": 80, "掌子面厚度_m": 2,
        "断面总高度_m": TOTAL_H, "掌子面距爆心_m": 3, "掘进断面积_m2": AREA,
    }
    charge = {
        "空孔数": 0, "掏槽模式": "楔形掏槽", "起爆网络": "数码电子雷管", "堵塞长度_m": 1.0,
        "装药掏槽孔数": 8, "楔形掏槽角_度": 62, "段间延时间隔_ms": SEG_INTERVAL_MS,
        "周边线装药密度_kgm": 0.30, "底板线装药密度_kgm": 0.42,
        "掏槽线装药密度_kgm": 0.29, "辅助线装药密度_kgm": 0.40,
    }
    effect = {
        "半孔率": 0.75, "火球强度": 0.6, "火花强度": 0.5, "烟雾强度": 0.25,
        "碎片总数": 120, "粉尘强度": 0.2, "时间步长_s": 0.05,
        "最大超挖_m": 0.05, "最小超挖_m": 0.03, "漏斗半径_m": 1.0, "漏斗深度_m": 2.4,
        "峰值应力_MPa": 30.0, "峰值振动_Kine": 1.79,
        "模拟总时长_s": 8, "中位块度_x50_m": 0.15, "最小安全系数": 0.6,
        "模拟随机种子": 42, "抛掷扩散角_度": 30, "最大块度_xmax_m": 0.7,
        "80通过块度_x80_m": 0.24, "平均抛掷距离_m": 3.0, "最大抛掷距离_m": 5.0,
        "漏斗中心偏移_m": 0.2, "Swebrec弯曲参数_b": 2.3, "冲击波速度系数": 4.0,
        "最大质点振速_cms": 1.79, "Cunningham均匀指数_n": 0.9,
        "萨道夫斯基_K": 90.63, "萨道夫斯基_α": 1.58,
    }
    rho = {
        "天气": "晴", "泊松比": 0.25, "风速_ms": 3, "风向_度": 45, "密度_kgm3": 2700,
        "岩体类型": ROCK_CN, "P波波速_ms": 4200, "S波波速_ms": 2450, "内摩擦角_度": 38,
        "弹性模量_GPa": 50, "抗压强度_MPa": 100, "抗拉强度_MPa": 8, "温度_摄氏度": 20,
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
    holes = _kunyang_holes()
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
                EVENT_ID, "昆阳磷矿二矿巷道楔形掏槽光面爆破",
                102.63, 24.70, 0, TOTAL_CHARGE,
                EXPLOSIVE_CN, ROCK_CN, "数码电子雷管",
                datetime(2026, 7, 24, 8, 30), "已规划",
                f"昆阳磷矿楔形掏槽43孔，断面4.7×3.75m，Q={TOTAL_CHARGE:.0f}kg；"
                f"V=90.63·(Q^1/3/R)^1.58",
                d["炮孔设计"], d["断面掘进"], d["装药起爆"], d["爆破效果"], d["环境岩体"],
                datetime.now(), datetime.now(),
            ),
        )
        conn.commit()
        print(f"[OK] 更新事件 {EVENT_ID}")
        print(f"      名称: 昆阳磷矿二矿巷道楔形掏槽光面爆破")
        print(f"      断面: 4.7×3.75m 三心拱({AREA}m²) | 孔深 {HOLE_DEPTH}m | 进尺 {ADVANCE}m")
        print(f"      总装药量: {TOTAL_CHARGE}kg | 炮孔数: {len(holes)}")
        print(f"      掏槽: 楔形8孔 数码8段({SEG_INTERVAL_MS}ms) | 萨道夫斯基 K=90.63, α=1.58")
        print(f"      布孔: 掏槽8 + 辅助{len([h for h in holes if h['孔类型']=='辅助孔'])}"
              f" + 周边{len([h for h in holes if h['孔类型']=='周边孔'])}")
    except Exception as e:
        conn.rollback()
        print(f"\n[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()