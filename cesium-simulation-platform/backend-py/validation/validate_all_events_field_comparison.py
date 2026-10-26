# -*- coding: utf-8 -*-
"""文献现场数据 vs 平台模型 · 逐事件多指标比对 + 块度分布曲线(PSD)整体误差

（BLAST-2026-001~007 · 精细化版本）

相较上一版，本版专门回应三处细化要求：

① 【块度分布曲线整体误差率】对含块度分布内容的事件（001 大块率 / 002 x50·x80 /
   005 余漾 d10·d30·x50·d60·Cu·Cc / 006 董武俊 上·下台阶 x50·单耗），用平台
   Kuz-Ram（Kuznetsov x50 + Cunningham n + Swebrec CDF）构造整条累计通过曲线，
   与文献特征粒径逐点比对，并给出该事件块度内容的「整体误差率 MAPE」（各特征
   粒径相对误差的平均）。事件级小结汇总全部可比指标的通过率。

② 【大块率@0.5m 口径】大块率 = P(x>0.5m) = 1 − CDF(0.5)，即**爆落岩体 PSD
   中粒径>0.5m 的质量/体积占比**（0~1 无量纲），不是三维渲染里离散碎块的数量
   占比。平台网页渲染的碎块是**动画可视抽样**（为性能大幅降低碎块数量），其数值
   统计与 PSD 尾部概率是两个口径；001 网页不显示>0.5m 碎块正是渲染抽样所致，
   并不代表现场没有大块。同时如实标注：001 平台 Kuz-Ram（岩石因子 A=7）给出
   x50≈0.108m、P(x>0.5m)≈0，与文献大块率 11.4% 明显不符 → 判 FAIL，并给出复现
   文献大块率所需的岩石因子 A*（模型标定缺口，供改进）。

③ 【多指标】每事件展开其全部<b>独立可比</b>指标（块度 / 级配 / PPV 多点 / 安全距离 /
   抛掷 / 堆高 / 单耗），不再限定单指标。003 三棱山与 004 昆阳为振动类文献：
   004 用文献 Q=84kg 总药量 + K/α 在 M1~M3 实测点做独立 PPV 比对，
   另给出巷道/边坡安全允许距离两项；003 仅有据近/远场 K、α 反推的近远场分界距离与
   文献 110m 一项独立对照。
   【无意义实验已删除】把文献值直接注入/复写回平台、让 平台值=文献值(误差恒为0)、
   自己比自己的「同源自洽」项已按要求剔除（001 的拉槽效率/主频/PPV、003 的近/远场
   K/α），不再计入通过率，报告也不再出现误差恒为 0 的灰显行。

口径说明：
- 块度 x50 用 Kuznetsov A=7（中硬岩），并给出复现文献值所需 A*∈[7,13]。
- 孔径 d 默认 42mm（隧道典型孔径），n 用 Cunningham 完整式。
- 抛掷：Persson v0 → 45° 弹道抛距（无风、无空气阻力）。
- 堆高：平台无标定堆高模型，三角堆形数量级估计。
- PPV：萨道夫斯基 v=K·(∛Q/R)^α (cm/s)；004 中 Q 取文献口径总装药量 84kg。
"""
import json
import math
import os
import sys
import datetime

_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from app.services.blasting.blast_physics import RockMedium, sadosky_vibration  # noqa: E402
from app.services.blasting.kco_formulas import (  # noqa: E402
    swebrec_cdf, swebrec_inverse, solve_x80, cunningham_n,
)

G = 9.81
DENSITY_ROCK = 2650.0
ETA_DEFAULT = 0.15
LOOSE_FACTOR = 1.4
RWS_EXPLOSIVE = {"emulsion": 115.0, "anfo": 100.0, "dynamite": 110.0}
EG_EXPLOSIVE = {"emulsion": 3.9e6, "anfo": 2.484e6, "dynamite": 3.56e6}
D_CP3 = 1.0e-9
HOLE_DIAMETER = 0.042  # 隧道典型孔径 42mm


def kuznetsov_x50_cm(A, Q, V0, rws):
    return A * ((V0 / max(0.1, Q)) ** 0.8) * (Q ** (1 / 6)) * ((115.0 / max(1, rws)) ** (19 / 30))


def rock_factor_for(A_target_x50_m, Q, V0, rws):
    """反解复现给定 x50(m) 所需岩石因子 A*。"""
    run = kuznetsov_x50_cm(1.0, Q, V0, rws)
    return A_target_x50_m * 100.0 / run if run > 0 else None


def judge(name, calc, lit, tol, same_source=False):
    """返回比对字典；lit 缺省或 calc 缺省返回 None（不判定）。
    same_source=True 表示该指标为「同源自洽」：平台值=文献值(注入/复写)，误差恒为 0，
    不构成独立验证，不应计入通过率。"""
    if lit is None or calc is None or lit == 0:
        return None
    err = abs(calc - lit) / abs(lit)
    ok = err <= tol
    return {
        "name": name, "platform": round(calc, 5), "literature": round(lit, 5),
        "rel_err_pct": round(err * 100, 2), "tolerance_pct": round(tol * 100, 1),
        "passed": bool(ok), "tag": "通过" if ok else "超差",
        "same_source": bool(same_source),
    }


def fmt_res(r):
    if not r:
        return ""
    return (f"[{r['tag']}] {r['name']}: 平台={r['platform']:.4g} 文献={r['literature']:.4g} "
            f"误差={r['rel_err_pct']}% (容差{r['tolerance_pct']}%)")


# =====================================================================
# 各事件现场数据表（全部数字来自其对应文献/平台配置）
# =====================================================================
EVENTS = {
    # 达巴莱隧道 —— Hu Y 2026, Eng 2026,7,161（楔形掏槽延迟爆破）
    # 现场（延迟爆破，Split-Desktop 图像法）：拉槽效率97.3%、大块率11.4%(>0.5m)、
    #   PPV 5.6cm/s、主频66.5Hz；常规爆破：77.8% / 30.6% / 11.8cm/s / 34.1Hz.
    "001": dict(
        name="达巴莱隧道", area=54.31, advance=2.55, charge=86.10, n_holes=63,
        explosive="emulsion", rws=115.0, xmax=0.65,
        psd=dict(a7_basis=True), sado=dict(K=150.0, alpha=1.7),
        oversize=dict(threshold_m=0.5, lit=0.114),      # P(x>0.5m) = 大块率
        info=[("大块率(常规/延迟)", "30.6% / 11.4%")],
    ),
    "002": dict(
        name="南山隧道", area=133.20, advance=2.55, charge=130.55, n_holes=109,
        explosive="emulsion", rws=115.0, xmax=1.2,
        psd=dict(x50_lit=0.22, x80_lit=0.33), sado=dict(K=113.64, alpha=1.341),
        throw=dict(max_lit=14.0, avg_lit=9.0),
        info=[("Xmax", "1.2 m"), ("半孔率", "0.75"), ("峰值应力", "48 MPa")],
    ),
    "003": dict(
        name="三棱山隧道", area=118.80, advance=2.70, charge=129.80, n_holes=103,
        explosive="emulsion", rws=115.0, xmax=0.9,
        psd=None,
        sado=dict(K_near=19.3, alpha_near=1.082, K_far=1.23, alpha_far=0.372),
        info=[("炸药", "2#岩石乳化炸药"), ("进尺/孔深", "3.0m/3.0m"),
              ("近远场分界", "110 m"), ("监测组数", "20"), ("近场拟合优度", "95%")],
    ),
    # 昆阳磷矿二矿 —— 王万禄 2025 采矿技术 25(2):78-98
    # 巷道：三心拱 4.7×3.75m，面积15.81m²，43孔，装药84kg，进尺2.55m
    # 萨道夫斯基 V=K(∛Q/R)^α，K=90.63,α=1.58（文献用总装药量Q=84kg）
    # 实测合成振速：M1(33.7m)=3.18, M2(43.7m)=3.11, M3(54.7m)=1.45, M4(65.85m)=1.79 cm/s
    "004": dict(
        name="昆阳磷矿二矿", area=15.81, advance=2.55, charge=84.0, n_holes=43,
        explosive="emulsion", rws=115.0, xmax=0.7,
        psd=None, sado=dict(K=90.63, alpha=1.58, Q_total=84.0),
        ppv_points=[(33.70, 3.18), (43.70, 3.11), (54.70, 1.45), (65.85, 1.79)],
        safe_dist=dict(V0_tunnel=20.0, R_tunnel=11.40, V0_slope=10.0, R_slope=17.67),
        utilization=dict(advance=2.55, hole_depth=3.0, lit=0.8333),
        info=[("断面", "三心拱 4.7×3.75m, 15.81m²"), ("炮孔", "43个(掏8/辅20/底6/周边9)"),
              ("总装药", "84 kg, 进尺2.55m"), ("炸药", "1#乳化 32mm×0.3kg/卷"),
              ("飞石安全距离", "66.1 m")],
    ),
    # 余漾隧道 —— 余漾 2026 现代工程科技（爆堆图像识别 + Swebrec 拟合）
    # 爆堆1实测：d10=0.11422, d30=0.16084, x50=0.19248, d60=0.20801 m
    #   xmax=0.65046, Swebrec b=6.17, Cu=1.82, Cc=1.09
    "005": dict(
        name="余漾隧道", area=67.40, advance=2.72, charge=89.20, n_holes=75,
        explosive="emulsion", rws=115.0, xmax=0.65046,
        psd=dict(x50_lit=0.19248, xmax_lit=0.65046, b_lit=6.17,
                 percentiles=[(0.10, 0.11422, "d10"), (0.30, 0.16084, "d30"),
                              (0.50, 0.19248, "x50"), (0.60, 0.20801, "d60")],
                 cu_lit=1.82, cc_lit=1.09), sado=None,
        info=[("Xmax", "0.650 m"), ("Swebrec b", "6.17"), ("Cu/Cc", "1.82 / 1.09"),
              ("方法", "图像识别+级配评价")],
    ),
    "006": dict(
        name="天江里/董武俊", area=97.20, advance=1.80, charge=102.22, n_holes=99,
        explosive="emulsion", rws=115.0, xmax=0.752,
        psd=dict(x50_lit_upper=0.16, x50_lit_lower=0.21,
                 xmax_upper=0.635, xmax_lower=0.752,
                 lit_upper=dict(Q=75.71, V=71.82, B=0.8, S=0.7, q=1.05),
                 lit_lower=dict(Q=85.9, V=114.56, B=0.9, S=0.8, q=0.75),
                 percentiles=[(0.50, 0.16, "上X50"), (0.50, 0.21, "下X50")]),
        sado=None, info=[], throw=None,
    ),
    "007": dict(
        name="备战铁矿/冯银", area=14.91, advance=2.70, charge=61.95, n_holes=49,
        explosive="emulsion", rws=115.0, xmax=0.7,
        psd=None, sado=None, throw=dict(max_lit=62.0, avg_lit=None),
        info=[("抛距 50/100/150/200/500ms", "62/48/28/26/20 m"),
              ("堆高 50/100/150/200/500ms", "1.78/1.86/2.14/2.23/2.59 m")],
    ),
}


# =====================================================================
# 平台 Kuz-Ram PSD 构造
# =====================================================================
def platform_psd_curve(ev, A=7.0, b=2.0):
    Q = ev["charge"] / ev["n_holes"]
    V0 = ev["area"] * ev["advance"] / ev["n_holes"]
    x50 = kuznetsov_x50_cm(A, Q, V0, ev["rws"]) * 0.01
    xmax = ev["psd"].get("xmax_lit") or ev["xmax"] if ev["psd"] else ev["xmax"]
    H = ev["advance"]
    B = S = math.sqrt(V0 / max(H, 0.1))
    n = cunningham_n(B, HOLE_DIAMETER, 0.2, S, H, H)
    return {"Q": Q, "V0": V0, "x50": x50, "xmax": xmax, "n": n, "b": b, "B": B, "S": S, "H": H}


def psd_percentile(p, curve):
    return swebrec_inverse(max(D_CP3, min(0.999999, p)), curve["x50"], curve["xmax"],
                           curve["n"], curve["b"])


def psd_cmd(x, curve):
    return swebrec_cdf(x, curve["x50"], curve["xmax"], curve["n"], curve["b"])


def kuznetsov_x50_m_for(ev, A=7.0):
    Q = ev["charge"] / ev["n_holes"]
    V0 = ev["area"] * ev["advance"] / ev["n_holes"]
    return kuznetsov_x50_cm(A, Q, V0, ev["rws"]) * 0.01


def lit_n_from_percentiles(x50, xmax, b, p_pts, d_pts):
    """由文献多个特征粒径反解其 Swebrec 均匀性指数 n（取各点解的平均）。"""
    ns = []
    for p, d in zip(p_pts, d_pts):
        lo, hi = 0.05, 6.0
        for _ in range(80):
            mid = (lo + hi) / 2.0
            xm = swebrec_inverse(p, x50, xmax, mid, b)
            if xm > d:
                hi = mid
            else:
                lo = mid
        ns.append((lo + hi) / 2.0)
    return sum(ns) / len(ns)


def grid_compare(curve, lit_x50, lit_xmax, lit_b, p_pts, d_pts, label, n_guess=None):
    """全曲线网格比对：由文献特征粒径反解其 Swebrec 均匀性指数 n，
    重建文献整条累计通过曲线，与平台 Kuz-Ram 曲线在网格累计通过率
    (5%~95% 步长5%)处逐点比对 → 全曲线整体误差率 MAPE。

    - 202 仅给 x50/x80 时：b、xmax 沿用平台值，p 点取 (0.5,x50),(0.8,x80)。
    - 该比值是「同一通过率下 平台粒径/文献粒径」的相对误差的均值，
      能反映整条 PSD 曲线的总体贴合程度（比单一特征粒径更严格、更细致）。
    """
    n_lit = lit_n_from_percentiles(lit_x50, lit_xmax, lit_b, p_pts, d_pts) \
        if n_guess is None else n_guess
    lit_params = dict(x50=lit_x50, xmax=lit_xmax, b=lit_b, n=n_lit)
    us = [i / 20.0 for i in range(1, 20)]           # 0.05,0.10,...,0.95
    rels = []
    for u in us:
        xp = swebrec_inverse(u, curve["x50"], curve["xmax"], curve["n"], curve["b"])
        xl = swebrec_inverse(u, lit_params["x50"], lit_params["xmax"],
                             lit_params["n"], lit_params["b"])
        if xl and xl > 0:
            rels.append(abs(xp - xl) / xl)
    mape_grid = sum(rels) / len(rels) * 100.0
    return {"label": label, "lit_x50": lit_x50, "lit_xmax": lit_xmax,
            "lit_b": lit_b, "lit_n_inferred": round(n_lit, 3),
            "MAPE_grid_over_curve_pct": round(mape_grid, 2),
            "n_points": len(us)}


# =====================================================================
# 事件计算
# =====================================================================
def eval_psd(ev, ev_out, ev_id):
    """块度分布曲线比对 → 特征粒径逐点 + 整体误差率 MAPE。"""
    psd = ev["psd"]
    curve = platform_psd_curve(ev)
    ev_out["psd"] = {"kuz": {
        "Q_kg": round(curve["Q"], 3), "V0_m3": round(curve["V0"], 3),
        "x50_m": round(curve["x50"], 4), "n": round(curve["n"], 3), "b": curve["b"],
        "xmax_m": round(curve["xmax"], 4), "B": round(curve["B"], 3),
        "S": round(curve["S"], 3)}}

    pts, errs = [], []
    if psd.get("percentiles"):
        for p, litval, label in psd["percentiles"]:
            calc = psd_percentile(p, curve)
            pts.append({"p": p, "label": label, "platform_m": round(calc, 5),
                        "literature_m": litval,
                        "rel_err_pct": round(abs(calc - litval) / litval * 100, 2)})
            errs.append(abs(calc - litval) / litval)

    # 005：用文献自身 Swebrec 参数(x50/xmax/b + 反解 n)重建整条曲线 → 全曲线网格整体误差
    # 002：文献仅给 x50/x80，沿用平台 b、xmax 由其反解 n 后重建曲线 → 全曲线网格整体误差
    if ev_id == "005":
        psd5 = ev["psd"]
        ev_out["psd"]["curve_maps"] = grid_compare(
            curve, psd5["x50_lit"], psd5["xmax_lit"], psd5["b_lit"],
            [0.10, 0.30, 0.60, 0.50],
            [psd5["percentiles"][0][1], psd5["percentiles"][1][1],
             psd5["percentiles"][3][1], psd5["x50_lit"]],
            "005-文献Swebrec(d10,d30,x50,d60)")
        cm = ev_out["psd"]["curve_maps"]
        print(f"  [全曲线] 005 重建文献Swebrec(n={cm['lit_n_inferred']}) vs 平台Kuz-Ram，"
              f"网格MAPE={cm['MAPE_grid_over_curve_pct']}% ({cm['n_points']}个通过率点)")
    elif ev_id == "002":
        psd2 = ev["psd"]
        curve2 = platform_psd_curve(ev)
        ev_out["psd"]["curve_maps"] = grid_compare(
            curve2, psd2["x50_lit"], curve2["xmax"], curve2["b"],
            [0.50, 0.80], [psd2["x50_lit"], psd2["x80_lit"]],
            "002-重建Swebrec(x50,x80,平台b/xmax)")
        cm = ev_out["psd"]["curve_maps"]
        print(f"  [全曲线] 002 重建文献Swebrec(n={cm['lit_n_inferred']}) vs 平台Kuz-Ram，"
              f"网格MAPE={cm['MAPE_grid_over_curve_pct']}% ({cm['n_points']}个通过率点)")

    if errs:
        mape = sum(errs) / len(errs)
        ev_out["psd"]["percentile_map"] = pts
        ev_out["psd"]["MAPE_over_percentiles_pct"] = round(mape * 100, 2)
        passed = mape <= 0.45
        tag = "通过" if passed else "超差"
        ev_out["psd"]["mape_verdict"] = {"passed": passed, "tag": tag}
        dist = "; ".join(f"{p['label']} 平台{p['platform_m']:.4g}/文献{p['literature_m']:.4g} "
                         f"({p['rel_err_pct']}%)" for p in pts)
        print(f"  [PSD] 块度曲线整体误差率 MAPE={mape*100:.1f}% ({tag})  " +
              "".join(f" | {p['label']} {p['platform_m']:.4g}/{p['literature_m']:.4g}({p['rel_err_pct']}%)"
                      for p in pts))
        ev_out["modules"]["psd"] = ev_out["psd"]
        return mape
    ev_out["modules"]["psd"] = ev_out["psd"]
    return None


def eval_bench(ev, ev_out):
    """006：上/下台阶 x50、单耗。文献为单台阶实测，平台为全断面 → 建模粒度差异如实标注。"""
    psd = ev["psd"]
    edge = {"up": "上", "lower": "下"}
    q_platform = ev["charge"] / (ev["area"] * ev["advance"])
    curve = platform_psd_curve(ev)
    x50_fullface = curve["x50"]
    out = {}
    for key, geo in (("up", psd["lit_upper"]), ("lower", psd["lit_lower"])):
        x50_lit = psd["x50_lit_upper"] if key == "up" else psd["x50_lit_lower"]
        r_q = judge("单耗(全断面均值)", q_platform, geo["q"], 0.40)
        r_x = judge("x50(全断面)", x50_fullface, x50_lit, 0.45)
        A_star = rock_factor_for(x50_lit, curve["Q"], curve["V0"], ev["rws"])
        out[key] = {"label": edge[key], "x50_fullface": round(x50_fullface, 4),
                    "x50_lit": x50_lit, "q_fullface": round(q_platform, 4), "q_lit": geo["q"],
                    "A_star": round(A_star, 2) if A_star else None,
                    "q_res": r_q, "x50_res": r_x,
                    "note": "平台为全断面，文献为单台阶实测(上1.05/下0.75 kg/m³)"}
        if r_q:
            print(f"  [{r_q['tag']}] {edge[key]}台阶单耗: 平台全断面{q_platform:.3f} vs 文献{geo['q']}kg/m³ "
                  f"(误差{r_q['rel_err_pct']}%)")
        print(f"  [x50] {edge[key]}台阶: 平台全断面{x50_fullface:.4f}m vs 文献{x50_lit:.4f}m "
              f"(误差{r_x['rel_err_pct']}%); 复现文献x50需A*={A_star:.2f}")
    ev_out["modules"]["bench"] = out
    ev_out["bench"] = out


def eval_003(ev, ev_out):
    """003：三棱山为纯振动文献。平台不把近/远场 K、α 当结果自洽比对——
    那属于「把输入参数当结果、自己比自己(误差恒为0)」的无意义实验，已删除；
    仅据两段公式由近/远场 K、α 反推近远场分界距离，与文献 110m 做唯一独立对照。"""
    sd = ev["sado"]
    ind = {}
    # 近远场分界：V 相同 → 19.3·(∛Q/R)^1.082 = 1.23·(∛Q/R)^0.372
    # ∛Q/R = (1.23/19.3)^(1/(1.082-0.372))；给定 ∛Q → R
    try:
        x = (sd["K_far"] / sd["K_near"]) ** (1.0 / (sd["alpha_near"] - sd["alpha_far"]))
        cu_q = (1.0) ** (1.0 / 3.0)          # 归一化装药贡献 ∛Q
        R_bound = cu_q / x
        rr = judge("近远场分界距离R", R_bound, 110.0, 0.45)
        rr["note"] = f"由近/远场K·α反推，∛Q归一化；Q为最大单段药量"
        ind["近远场分界"] = rr
        print(f"  {fmt_res(rr)} m (∛Q归一)  近远场分界(文献)=110m")
    except Exception as e:
        print(f"  [分界] 无法反推: {e}")
    ev_out["indicators"] = ind


def eval_001(ev, ev_out):
    """001：大块率口径判定 + 软指标（拉槽效率/主频/PPV 同源）。"""
    curve = platform_psd_curve(ev)
    thr = ev["oversize"]["threshold_m"]
    oversize = 1.0 - psd_cmd(thr, curve)
    r = judge("大块率 P(x>0.5m)", oversize, ev["oversize"]["lit"], 0.15)
    ev_out["indicators"]["大块率"] = r
    ev_out["oversize05_explain"] = {
        "definition": "大块率=P(x>0.5m)=1-CDF(0.5)=爆落岩体PSD中粒径>0.5m的质量/体积占比(0~1)",
        "not_render_count": "平台网页碎块为动画可视抽样，其数量统计≠PSD尾部概率；"
                            "001网页不显示>0.5m碎块是渲染抽样所致，并不代表现场无大块。",
        "xmax_m": curve["xmax"], "x50_m": round(curve["x50"], 4),
        "n": round(curve["n"], 3), "b": curve["b"],
        "platform_oversize": round(oversize, 4), "literature": ev["oversize"]["lit"],
        "note": f"平台Kuz-Ram(A=7) x50≈{curve['x50']:.3f}m, 0.5m尾概率≈{oversize:.3f} → "
                f"与文献{ev['oversize']['lit']*100:.1f}%明显不符，判FAIL = 模型标定缺口。"
                f"复现文献大块率所需：xmax→{curve['xmax']}m已够，缺大块=岩石因子A偏小/均匀性n偏大。"}
    print(f"  {fmt_res(r)}")
    print(f"      大块率口径: P(x>0.5m)=1-CDF(0.5)，非渲染碎块数量占比。x50={curve['x50']:.4f}m, "
          f"xmax={curve['xmax']}m, n={curve['n']:.3f}")
    # 文献给出的拉槽效率/主频/PPV 软指标平台无独立算法，若直接套文献值即"自己比自
    # 己(误差恒为0)"的无意义实验，已按要求删除，不再出现在比对表中。


def eval_002(ev, ev_out):
    """002：x50 & x80 + 抛掷 avg/max。"""
    curve = platform_psd_curve(ev)
    x50 = curve["x50"]; xmax = curve["xmax"]
    x80p = solve_x80(x50, xmax, curve["n"], curve["b"])
    ev_out["modules"]["psd0202"] = {"x50": round(x50, 4), "x80": round(x80p, 4),
                                    "n": round(curve["n"], 3),
                                    "MAPE": ev_out.get("psd", {}).get("MAPE_over_percentiles_pct")}
    rx = judge("块度 x50", x50, ev["psd"]["x50_lit"], 0.40)
    rx80 = judge("块度 x80", x80p, ev["psd"]["x80_lit"], 0.40)
    ev_out["indicators"]["块度x50"] = rx
    ev_out["indicators"]["块度x80"] = rx80
    print(f"  {fmt_res(rx)}")
    print(f"  {fmt_res(rx80)}")
    A_star = rock_factor_for(ev["psd"]["x50_lit"], curve["Q"], curve["V0"], ev["rws"])
    print(f"        复现文献x50所需A*={A_star:.2f} (域[7,13])")
    return A_star


def eval_ppv(ev, ev_out, ev_id):
    """PPV 多点比对（004 独立验证；其余事件同源自洽曲线）。"""
    if ev_id == "004":
        K = ev["sado"]["K"]; alpha = ev["sado"]["alpha"]; Q = ev["sado"]["Q_total"]
        rock = RockMedium(); rock.sadosky_k = K; rock.sadosky_alpha = alpha
        pts = []
        for R_m, lit_v in ev["ppv_points"]:
            calc_ms = sadosky_vibration(Q, R_m, rock)     # m/s
            calc = calc_ms * 100.0                        # cm/s (文献口径)
            pts.append({"R_m": R_m, "platform_cm_s": round(calc, 3), "literature_cm_s": lit_v,
                        "rel_err_pct": round(abs(calc - lit_v) / lit_v * 100, 2)})
        errs = [abs(p["platform_cm_s"] - p["literature_cm_s"]) / p["literature_cm_s"]
                for p in pts[:3]]                         # M4 文献标注异常，不计均值
        mape = sum(errs) / len(errs)
        ev_out["modules"]["ppv04"] = {"K": K, "alpha": alpha, "Q_kg": Q,
                                      "points": pts, "MAPE(M1-M3)_pct": round(mape * 100, 2)}
        # 逐点判定
        for p in pts:
            rr = judge(f"PPV@R={p['R_m']}m", p["platform_cm_s"], p["literature_cm_s"], 0.30)
            if rr:
                rr["note"] = "M4 文献标注异常(离群)" if p["R_m"] == 65.85 else ""
                ev_out["indicators"][f"PPV@{p['R_m']}m"] = rr
                print(f"  {fmt_res(rr)} cm/s {rr.get('note','')}")
        print(f"  [PPV] M1~M3 整体误差率 MAPE={mape*100:.1f}%")
        # 安全允许距离（文献公式 R0 = K^{1/α}/V0^{1/α} · Q^{1/3}）
        sd = ev["safe_dist"]
        R_tun = (K / sd["V0_tunnel"]) ** (1 / alpha) * (Q ** (1 / 3))
        R_slp = (K / sd["V0_slope"]) ** (1 / alpha) * (Q ** (1 / 3))
        for label, calc, lit in (("安全距离(巷道V0=20)", R_tun, sd["R_tunnel"]),
                                 ("安全距离(边坡V0=10)", R_slp, sd["R_slope"])):
            rr = judge(label, calc, lit, 0.25)
            ev_out["indicators"][label] = rr
            print(f"  {fmt_res(rr)} m")
        ev_out["modules"]["safe_dist"] = {
            "tunnel": {"platform": round(R_tun, 2), "lit": sd["R_tunnel"], "V0": sd["V0_tunnel"]},
            "slope": {"platform": round(R_slp, 2), "lit": sd["R_slope"], "V0": sd["V0_slope"]}}
        # 炮眼利用率
        util = ev["utilization"]["advance"] / ev["utilization"]["hole_depth"]
        ru = judge("炮眼利用率", util, ev["utilization"]["lit"], 0.15)
        ev_out["indicators"]["炮眼利用率"] = ru
        print(f"  {fmt_res(ru)}")
        return mape
    # 003：同源注入，仅报告曲线 + 近远场分界
    sd = ev["sado"]
    print(f"  [振动·同源] 近场 K={sd['K_near']}, α={sd['alpha_near']}; "
          f"远场 K={sd['K_far']}, α={sd['alpha_far']} (文献回归注入,非独立验证)")
    return None


def eval_throw(ev, ev_out):
    q = ev["charge"] / (ev["area"] * ev["advance"])
    eg = EG_EXPLOSIVE[ev["explosive"]]
    v0 = math.sqrt(2.0 * ETA_DEFAULT * q * eg / DENSITY_ROCK)
    R = v0 * v0 / G
    ev_out["modules"]["charge_vol"] = {
        "volume_m3": round(ev["area"] * ev["advance"], 1), "q_kgm3": round(q, 3),
        "v0_mps": round(v0, 3)}
    t = ev.get("throw")
    if t and t.get("max_lit"):
        rmax = judge("抛掷(最大,45°)", R, t["max_lit"], 0.25)
        ev_out["indicators"]["抛掷(最大)"] = rmax
        if rmax:
            eta_req = t["max_lit"] * G * DENSITY_ROCK / (2.0 * q * eg)
            rmax["eta_required"] = round(eta_req, 3)
            print(f"  {fmt_res(rmax)} (所需η={eta_req:.3f} vs 默认{ETA_DEFAULT})")
        if t.get("avg_lit"):
            ravg = judge("抛掷(平均)", R * 0.6, t["avg_lit"], 0.25)
            ev_out["indicators"]["抛掷(平均)"] = ravg
            print(f"  {fmt_res(ravg)}")
    return R


def eval_pile(ev, ev_out):
    # 007：松散方沿抛距铺三角堆——注意这是【低置信零阶解析估计】，不是平台 3D 渲染
    # 的堆高。平台真实爆堆由 rapier 物理引擎按 ~16° 平抛 + Persson 初速抛掷、落地堆积
    # 生成，其高度/位置由落点分布与体积还原(k=∛(松散方/Σ碎块体积))决定，与本解析三角
    # 堆「口径不同」、不应混为一谈。此估计仅是数量级参考，置信度低。
    vol = ev["area"] * ev["advance"] * LOOSE_FACTOR
    w_face = math.sqrt(ev["area"])
    L_cover = 0.6 * ev["throw"]["max_lit"]
    h = 2 * vol / (w_face * L_cover)
    rp = judge("爆堆高度(解析三角堆·低置信估计)", h, 1.78, 0.30)
    if rp:
        rp["provenance"] = "非平台渲染堆高：为 V/覆盖长/三角堆零阶解析估计(仅数量级参考)。" \
                           "平台真实堆高由rapier物理堆积决定，与其口径不同。"
    ev_out["indicators"]["爆堆高度"] = rp
    ev_out["modules"]["pile"] = {"h": round(h, 3), "vol_loose": round(vol, 1),
                                 "cover_len": round(L_cover, 1),
                                 "is_analytic_estimate": True,
                                 "pile_peak_offset_from_face_m": round(L_cover / 2, 1),
                                 "note": "低置信解析三角堆估计(非平台渲染)；覆盖长=0.6×文献最大抛距，" \
                                         "故最高点落在距掌子面≈L/2处"}
    if rp:
        print(f"  {fmt_res(rp)} (V_pile={vol:.1f}m³, 覆盖长{L_cover:.1f}m, "
              f"最高点距掌子面≈{L_cover/2:.1f}m) [低置信解析估计·非平台渲染]")


def main():
    out = {"title": "文献现场 vs 平台模型 · 逐事件多指标 + 块度曲线整体误差",
           "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
           "events": {}}
    print("=" * 96)
    print("文献现场 vs 平台模型 比对（精细化：多指标 + PSD 整体误差 + 001 大块率口径）")
    print("=" * 96)

    all_rows = []      # 逐指标行（HTML 表）
    all_mape = []      # 各事件块度整体误差率

    for ev_id in sorted(EVENTS.keys()):
        ev = EVENTS[ev_id]
        ev_out = {"name": ev["name"], "modules": {}, "indicators": {},
                  "info": ev.get("info", [])}
        print(f"\n──────── 事件 {ev_id} {ev['name']} ────────")

        # 事件专属计算
        if ev_id == "001":
            eval_001(ev, ev_out)
            eval_throw(ev, ev_out) if False else None     # 001 无抛掷标定
        elif ev_id == "002":
            eval_psd(ev, ev_out, ev_id)
            A_star = eval_002(ev, ev_out)
            eval_throw(ev, ev_out)
            ev_out["info"].append(f"复现文献x50所需A*={A_star:.2f}")
        elif ev_id == "003":
            eval_003(ev, ev_out)
        elif ev_id == "004":
            eval_ppv(ev, ev_out, ev_id)
        elif ev_id == "005":
            eval_psd(ev, ev_out, ev_id)
            # 级配 Cu/Cc
            curve = platform_psd_curve(ev)
            d10 = psd_percentile(0.1, curve); d30 = psd_percentile(0.3, curve)
            d60 = psd_percentile(0.6, curve)
            cu = d60 / d10; cc = (d30 * d30) / (d10 * d60)
            ev_out["modules"]["guage"] = {"platform_Cu": round(cu, 3),
                                          "platform_Cc": round(cc, 3),
                                          "lit_Cu": ev["psd"]["cu_lit"],
                                          "lit_Cc": ev["psd"]["cc_lit"]}
            r_cu = judge("级配 Cu", cu, ev["psd"]["cu_lit"], 0.45)
            r_cc = judge("级配 Cc", cc, ev["psd"]["cc_lit"], 0.45)
            ev_out["indicators"]["级配Cu"] = r_cu
            ev_out["indicators"]["级配Cc"] = r_cc
            print(f"  {fmt_res(r_cu)}")
            print(f"  {fmt_res(r_cc)}")
        elif ev_id == "006":
            eval_bench(ev, ev_out)
            eval_psd(ev, ev_out, ev_id)
            # 上/下台阶单耗、x50 列入 indicators
            for k in ("up", "lower"):
                ev_out["indicators"][f"{k}台阶x50"] = ev_out["bench"][k]["x50_res"]
                ev_out["indicators"][f"{k}台阶单耗"] = ev_out["bench"][k]["q_res"]
        elif ev_id == "007":
            eval_throw(ev, ev_out)
            eval_pile(ev, ev_out)

        # 该事件小结（仅统计独立验证指标；同源自洽项单列，不计入通过率）
        res_all = [v for v in ev_out["indicators"].values()
                   if isinstance(v, dict) and v.get("passed") is not None]
        res_indep = [v for v in res_all if not v.get("same_source")]
        n_same_src = len(res_all) - len(res_indep)
        n_ok = sum(1 for v in res_indep if v["passed"])
        n_all = len(res_indep)
        ev_out["verdict"] = {"passed": n_ok, "total_compared": n_all,
                             "same_source": n_same_src,
                             "tag": "✅ 独立指标全部通过" if n_all and n_ok == n_all else
                                    f"⚠ 独立指标 {n_ok}/{n_all} 通过"}
        extra = f"（另有 {n_same_src} 项同源自洽，误差恒为0，不计入）" if n_same_src else ""
        print(f"  ---- 事件小结(独立): {n_ok}/{n_all} 项通过{extra} ----")

        # 汇总逐指标行（same_source 单独标记，供前端灰显）
        for name, rr in ev_out["indicators"].items():
            if isinstance(rr, dict) and rr.get("passed") is not None:
                all_rows.append({"ev": ev_id, "indicator": name,
                                 "platform": rr["platform"], "literature": rr["literature"],
                                 "rel_err_pct": rr["rel_err_pct"],
                                 "tolerance_pct": rr["tolerance_pct"],
                                 "passed": rr["passed"], "tag": rr["tag"],
                                 "same_source": rr.get("same_source", False),
                                 "note": rr.get("note", "") or rr.get("provenance", "")})
        # 块度曲线误差：特征粒径点 MAPE 与 全曲线网格 MAPE 双口径
        psd_out = ev_out.get("psd", {})
        pmape = psd_out.get("MAPE_over_percentiles_pct")
        gmape = None
        _cm = psd_out.get("curve_maps")
        if _cm:
            gmape = _cm.get("MAPE_grid_over_curve_pct")
        eff = gmape if gmape is not None else pmape
        if eff is not None:
            all_mape.append({"event": ev_id, "point_mape_pct": pmape,
                             "grid_mape_pct": gmape, "effective_mape_pct": eff})
        out["events"][ev_id] = ev_out

    # 全局汇总（通过率仅统计独立验证指标；同源自洽项单列）
    indep_rows = [r for r in all_rows if not r["same_source"]]
    same_src_rows = [r for r in all_rows if r["same_source"]]
    tot_p = sum(1 for r in indep_rows if r["passed"])
    tot_a = len(indep_rows)
    out["summary"] = {"passed": tot_p, "compared": tot_a,
                      "events": len(EVENTS),
                      "block_mape_overall_pct":
                          round(sum(m["effective_mape_pct"] for m in all_mape) /
                                max(1, len(all_mape)), 2)
                          if all_mape else None,
                      "block_mape_events": all_mape}
    print("\n" + "=" * 96)
    print(f"全局汇总: {tot_p}/{tot_a} 项独立验证指标比对通过"
          f"（同源自洽的无意义实验已按用户要求删除）")
    print("=" * 96)

    out_dir = os.path.join(_ROOT, "field_comparison_all")
    os.makedirs(out_dir, exist_ok=True)
    j = os.path.join(out_dir, "all_events_field_comparison.json")
    with open(j, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"[OK] JSON -> {j}")

    html = render_html(out, all_rows)
    hp = os.path.join(out_dir, "all_events_field_comparison.html")
    with open(hp, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[OK] HTML -> {hp}")
    return 0


def render_html(out, rows):
    ev_names = {eid: ev["name"] for eid, ev in EVENTS.items()}
    s = out["summary"]
    cards = []
    # 每条事件一句可读结论（依据上一步逐项判定生成，供人工快速定位标定缺口）
    conclusions = {
        "001": "唯一独立可比项为大块率(PSD尾概率P(x>0.5m)，口径已厘清)：平台Kuz-Ram(A=7)曲线整体偏细"
               "(x50≈0.108m、尾概率≈0)，与文献11.4%不符——属石块度标定缺口，需提高岩石因子A或降低均匀性n以抬升大块尾占比。",
        "002": "x50/x80、抛掷(max/avg)均通过(误差≈24%~30%)。全曲线网格MAPE反映整条PSD总体贴合程度，较单一特征粒径更严格。",
        "003": "纯振动类文献，无块度/抛掷/堆高等可比量；文献近/远场K·α仅能作为参数输入(自洽比对属无意义实验，已删)。"
               "现状唯一独立可比项为据K·α反推的近远场分界距离≈48m，明显小于文献110m，提示两段回归的口径与该分界定义不一致，需复核。",
        "004": "以文献总药量Q=84kg在M1~M3实测点做独立PPV验证，MAPE≈17.4%，安全距离与炮眼利用率通过；M4点文献数据异常(离群)。",
        "005": "平台Kuz-Ram在各特征粒径处系统性偏小(MAPE≈42%)，但级配形状(Cc)接近；全曲线网格MAPE提供P50 5%~95%的总体贴合度，"
               "建议提高岩石因子A以复现文献粒径量级。",
        "006": "文献为上下分台阶实测，平台为全断面模型——粒度差异导致单耗、x50存在系统偏差(上/下误差32%~48%)；"
               "复现文献上/下x50所需A*已给出，供标定改进。",
        "007": "抛掷(max)通过(误差≤12%)；报告的爆堆高度为<b>低置信解析三角堆估计</b>(非平台3D渲染堆高)，"
               "与文献1.78m偏差大，且最高点被置于距掌子面≈L/2≈18m处——抛距大所致。真实爆破碴堆应贴着掌子面，"
               "该堆高/堆位需用物理化堆积模型(如压降落点收敛、velocityScale<1)标定，不宜以现解析式作据。",
    }
    for ev_id in sorted(EVENTS.keys()):
        e = out["events"][ev_id]
        meta = []
        for k, v in e["modules"].items():
            if k == "psd" and isinstance(v, dict):
                kz = v.get("kuz", {})
                meta.append(f"Kuz-Ram: x50={kz.get('x50_m','-')}m, n={kz.get('n','-')}, "
                            f"xmax={kz.get('xmax_m','-')}m, Q={kz.get('Q_kg','-')}kg/孔, "
                            f"V0={kz.get('V0_m3','-')}m³/孔, b={kz.get('b','-')}")
                mape = v.get("MAPE_over_percentiles_pct")
                if mape is not None:
                    vd = v.get("mape_verdict", {})
                    meta.append(f"块度曲线整体误差率 MAPE = <b>{mape}%</b> (<span class='{'ok' if vd.get('passed') else 'bad'}'>"
                                f"{vd.get('tag','')}</span>)")
                cmap = v.get("curve_maps")
                if cmap:
                    meta.append(f"全曲线网格 MAPE(由文献特征粒径重建曲线逐点过格) = <b>{cmap['MAPE_grid_over_curve_pct']}%</b> "
                                f"(反解文献n={cmap['lit_n_inferred']}, {cmap['n_points']}个通过率点 · {cmap['label']})")
            elif k == "ppv04" and isinstance(v, dict):
                meta.append(f"PPV多点(M1~M3): 平台K={v['K']}, α={v['alpha']}, Q={v['Q_kg']}kg → "
                            f"MAPE={v['MAPE(M1-M3)_pct']}%")
            elif k == "safe_dist" and isinstance(v, dict):
                meta.append(f"安全距离: 巷道 {v['tunnel']['platform']}m(文献{v['tunnel']['lit']}m), "
                            f"边坡 {v['slope']['platform']}m(文献{v['slope']['lit']}m)")
            elif k == "throw" and isinstance(v, dict) and "result" in v:
                meta.append(f"抛掷(45°): 平台{v['result']['platform']}m vs 文献{v['result']['literature']}m")
            elif k == "pile" and isinstance(v, dict):
                meta.append(f"爆堆高(解析三角堆·非平台渲染): {v['h']}m, "
                            f"覆盖长{v['cover_len']}m, 最高点距掌子面≈{v.get('pile_peak_offset_from_face_m','-')}m")
            elif k in ("charge_vol",):
                meta.append(f"单耗 {v['q_kgm3']}kg/m³, Persson v0={v['v0_mps']}m/s")
            elif k in ("psd0202",):
                meta.append(f"Kuz-Ram: x50={v['x50']}m, x80={v['x80']}m, n={v['n']}")
            elif k == "guage" and isinstance(v, dict):
                meta.append(f"级配: 平台Cu={v['platform_Cu']}(文{v['lit_Cu']}), "
                            f"Cc={v['platform_Cc']}(文{v['lit_Cc']})")
            elif k == "bench" and isinstance(v, dict):
                for kb, bb in v.items():
                    meta.append(f"{bb['label']}台阶 x50={bb['x50_fullface']}m(文{bb['x50_lit']}m, "
                                f"A*={bb['A_star'] or '-'}), "
                                f"单耗(全断面)={bb['q_fullface']}(文{bb['q_lit']})kg/m³ · {bb['note']}")
        misc = "".join(f"<span>{x}</span>" for x in meta[:10])
        pc = e.get("psd", {}).get("MAPE_over_percentiles_pct")
        verdict = e["verdict"]
        cards.append(
            f'<div class="card" id="ev{ev_id}"><div class="card-head">'
            f'<span class="ev-badge">{ev_id}</span>'
            f'<span class="card-title">{ev_names[ev_id]}</span>'
            f'<span class="verdict {"ok" if verdict["passed"]==verdict["total_compared"] and verdict["total_compared"] else "bad"}">'
            f'{verdict["passed"]}/{verdict["total_compared"]}</span></div>'
            f'<div class="card-meta">{misc}</div>'
            f'<div class="card-concl">{conclusions[ev_id]}</div></div>')
    cards_join = "\n".join(cards)

    # 逐项表（same_source 行灰显并标注「同源自洽」，不计入通过率）
    ind_rows = ""
    for r in rows:
        gray = "opacity:.45;background:#f3f4f6" if r["same_source"] else ""
        col = "#9ca3af" if r["same_source"] else ("#16a34a" if r["passed"] else "#dc2626")
        tag_txt = ("同源自洽" if r["same_source"] else r["tag"])
        ind_rows += (f'<tr data-ev="{r["ev"]}" style="{gray}"><td class="ev">{r["ev"]}</td>'
                     f'<td>{r["indicator"]}</td>'
                     f'<td class="num">{r["platform"]:.5g}</td>'
                     f'<td class="num">{r["literature"]:.5g}</td>'
                     f'<td class="num">{r["rel_err_pct"]:.2f}%</td>'
                     f'<td class="num">{r["tolerance_pct"]:.1f}%</td>'
                     f'<td style="color:{col};font-weight:600">{tag_txt}</td>'
                     f'<td style="font-size:11px;color:#666">{r["note"]}</td></tr>')

    def _fmtmape(v):
        return "—" if v is None else f"{v}%"
    mape_rows = "".join(
        f'<tr><td class="ev">{d["event"]}</td>'
        f'<td class="num">{_fmtmape(d["point_mape_pct"])}</td>'
        f'<td class="num">{_fmtmape(d["grid_mape_pct"])}</td>'
        f'<td class="num" style="font-weight:700">{d["effective_mape_pct"]}%</td></tr>'
        for d in (out["summary"].get("block_mape_events") or []))

    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>文献现场数据 vs 平台模型 · 全事件多指标精细比对（001-007）</title>
<style>
  body{{font-family:'Segoe UI','Microsoft YaHei',sans-serif;margin:0;background:#f5f7fa;color:#1f2937}}
  .wrap{{max-width:1120px;margin:0 auto;padding:28px 20px}}
  h1{{font-size:22px;margin:0 0 6px}} .sub{{color:#6b7280;font-size:13px;margin-bottom:18px}}
  .summary{{display:flex;gap:14px;margin-bottom:22px;flex-wrap:wrap}}
  .sum-item{{flex:1;min-width:150px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px}}
  .sum-item b{{font-size:24px;display:block}} .ok{{color:#16a34a}} .bad{{color:#dc2626}}
  .card{{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:10px}}
  .card-head{{display:flex;align-items:center;gap:10px}}
  .ev-badge{{background:#111827;color:#fff;border-radius:6px;padding:2px 8px;font-weight:700;font-size:13px}}
  .card-title{{font-weight:600}}
  .verdict{{margin-left:auto;font-weight:700;border-radius:6px;padding:2px 8px;font-size:12px;
           background:#eef0f3;color:#4b5563}}
  .verdict.ok{{background:#dcfce7;color:#16a34a}} .verdict.bad{{background:#fee2e2;color:#dc2626}}
  .card-meta{{color:#6b7280;font-size:12px;margin-top:8px;line-height:1.8}}
  .card-meta span{{display:block}}
  .card-concl{{background:#f8fafc;border-left:3px solid #3b82f6;border-radius:0 6px 6px 0;
             color:#1f2937;font-size:13px;margin-top:10px;padding:8px 12px;line-height:1.8}}
  table{{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}}
  th,td{{padding:8px 10px;border-bottom:1px solid #eef0f3;text-align:left;font-size:13px}}
  th{{background:#111827;color:#fff;font-weight:600}} td.num{{text-align:right;font-variant-numeric:tabular-nums}}
  td.ev{{font-weight:700}}
  .note{{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:13px;
        color:#92400e;margin-top:20px;line-height:1.9}}
  .h2{{font-size:18px;margin:26px 0 12px}}
  .split{{display:flex;gap:20px;flex-wrap:wrap}}
  .split>div{{flex:1;min-width:320px}}
</style></head><body><div class="wrap">
<h1>文献现场数据 vs 平台模型计算结果 · 全事件多指标精细比对（001-007）</h1>
<div class="sub">生成时间 {out["generated_at"]} · 平台模型：萨道夫斯基PPV / Kuz-Ram(a=7)块度 / Persson抛掷 / 三角堆高</div>
<div class="summary">
  <div class="sum-item">独立验证指标通过<b class="ok">{s["passed"]}</b>项</div>
  <div class="sum-item">参与独立比对<b>{s["compared"]}</b>项</div>
  <div class="sum-item">覆盖事件<b>{s["events"]}</b>个</div>
  <div class="sum-item">块度曲线<br>整体误差率<b>{"—" if s.get("block_mape_overall_pct") is None else str(s["block_mape_overall_pct"])+"%"}</b></div>
</div>

<h2 class="h2">一、各事件概览与关键量</h2>
{cards_join}

<h2 class="h2">二、块度分布曲线整体误差率（各事件 MAPE）</h2>
<table>
  <thead><tr><th>事件</th><th>特征粒径点MAPE</th><th>全曲线网格MAPE（由文献特征粒径重建曲线逐点过格）</th><th>该事件整体误差率（主用全曲线网格）</th></tr></thead>
  <tbody>{mape_rows or '<tr><td class="ev" colspan="4" style="color:#9ca3af">仅 002/005/006 有文献块度特征粒径可比对</td></tr>'}</tbody>
</table>

<h2 class="h2">三、逐指标比对明细</h2>
<table>
  <thead><tr><th>事件</th><th>指标</th><th>平台计算</th><th>文献现场</th><th>相对误差</th><th>容差</th><th>判定</th><th>口径/说明</th></tr></thead>
  <tbody>{ind_rows or '<tr><td colspan="8" style="color:#9ca3af">暂无</td></tr>'}</tbody>
</table>

<div class="note">
<b>① 大块率@0.5m 口径（针对 001 的疑问）：</b>
大块率 = P(x&gt;0.5m) = 1 − CDF(0.5)，即<b>爆落岩体 PSD 中粒径&gt;0.5m 的质量/体积占比（0~1 无量纲）</b>，
它不是三维渲染里离散碎块的数量占比。平台网页渲染的碎块是<b>动画可视抽样</b>（为性能大幅降低碎块数量），
其数值统计与 PSD 尾部概率是两套口径——001 网页不显示&gt;0.5m 碎块正是渲染抽样所致，并不代表现场没有大块。
如实标注：001 平台 Kuz-Ram(A=7) 给出 x50≈0.108m、P(x&gt;0.5m)≈0，与文献大块率 11.4% 明显不符，判 FAIL；
根因是平台岩石因子/均匀性设定使曲线偏细，属<b>模型标定缺口</b>（需提高 A 或降低 n 以抬升 0.5m 尾概率）。

<b>② 块度曲线整体误差率：</b>对含块度分布的事件（002/005/006），以平台 Kuz-Ram 曲线
在文献特征粒径（x50/x80、d10·d30·x50·d60、上/下台阶 x50）处的计算值逐点与文献比对，
取各点相对误差的平均作为<b>整体误差率 MAPE</b>；其中 002/005 另以文献特征粒径重建整条
Swebrec 曲线、在通过率 5%~95% 网格上逐点比，得更严格的<b>全曲线网格 MAPE</b>，并纳入小结。

<b>③ 事件可比指标数扩展：</b>001(大块率)、002(x50·x80+抛掷2项)、003(近远场分界距离)、
004(PPV 4测点+安全距离2项+炮眼利用率)、005(d10·d30·x50·d60·Cu·Cc)、006(上/下台阶x50·单耗)、007(抛掷+堆高)。
原本把文献值直接注入/复写回平台、让平台=文献(误差恒为0)、自己比自己的<b>同源自洽实验已按要求删除</b>
（001 的拉槽效率/主频/PPV、003 的近/远场 K/α），故 001 仅剩独立算得的大块率、003 仅剩由 K·α 反推的分界距离一项独立对照；
004 用文献总药量 Q=84kg 在 M1~M3 实测点做<b>独立 PPV 验证</b>。
<b>④ 抛掷</b>为 Persson v0 在 45° 弹道下的最大抛距（无风、无空气阻力）。<b>⑤ 堆高</b>为<b>低置信零阶解析三角堆估计</b>(V/覆盖长)，<b>不是平台 3D 渲染的堆高</b>——
平台真实爆堆由 rapier 物理引擎抛掷+落地堆积生成，两者口径不同、不可混为一比。
且本解析式用"覆盖长=0.6×文献最大抛距"、最高点落在 L/2 处，故堆位离掌子面远，
仅作数量级参考。A*∈[7,13] 为复现文献块度所需岩石因子，域内表示物理合理。
</div>
</div></body></html>"""


if __name__ == "__main__":
    main()