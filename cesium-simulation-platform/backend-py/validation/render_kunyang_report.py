# -*- coding: utf-8 -*-
"""生成昆阳磷矿（006）平台 vs 文献现场实测比对报告（HTML，纯静态可离线打开）。

数据源：nanshan_validation_output/kunyang_field_comparison.json
（由 field_comparison_kunyang.py 生成，采用后端物理引擎 sadosky_vibration 注入 K=90.63/α=1.58）。
"""
import json
import os
import math

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "nanshan_validation_output")
with open(os.path.join(BASE, "kunyang_field_comparison.json"), "r", encoding="utf-8") as f:
    d = json.load(f)

K = d["model"]["K"]
ALPHA = d["model"]["alpha"]
Q = d["total_charge_kg"]
POINTS = d["points"]
M4 = d["independent_validation_M4"]
METS = d["metrics_all_4"]

# 平台衰减曲线采样（用于 SVG 曲线）
q13 = Q ** (1 / 3)
CURVE = []
for r in range(20, 71):
    pv = K * (q13 / r) ** ALPHA
    CURVE.append((r, pv))

# 测点标记
def _svg_curve(w=860, h=300, L=70, Rm=30, T=20, B=46):
    rmin, rmax = 20, 71
    vmax = 4.2
    X = lambda r: L + (r - rmin) / (rmax - rmin) * (w - L - Rm)
    Y = lambda v: T + (1 - math.log(v) / math.log(vmax)) * (h - T - B)
    parts = []
    # 网格（爆距）
    for r in range(20, 71, 5):
        x = X(r)
        parts.append(f'<line x1="{x}" x2="{x}" y1="{T}" y2="{h-B}" stroke="#e8edf4"/>')
        parts.append(f'<text x="{x}" y="{h-B+15}" font-size="10" fill="#8a97aa" text-anchor="middle">{r}</text>')
    # 水平网格（振速）
    for v in (0.5, 1, 2, 3, 4):
        y = Y(v)
        parts.append(f'<line x1="{L}" x2="{w-Rm}" y1="{y}" y2="{y}" stroke="#f0f3f8" stroke-dasharray="3 3"/>')
        parts.append(f'<text x="{L-8}" y="{y+4}" font-size="10" fill="#8a97aa" text-anchor="end">{v}</text>')
    # 平台衰减曲线
    pts = " ".join(f"{X(r):.1f},{Y(v):.1f}" for r, v in CURVE)
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#2f6fed" stroke-width="2.2"/>')
    # 测点 scatter（平台=菱形, 实测=圆）
    for p in POINTS:
        rx, vp, vm = p["R_m"], p["v_platform_cm_s"], p["v_measured_cm_s"]
        indep = not p["in_calibration_set"]
        x, yp, ym = X(rx), Y(vp), Y(vm)
        col = "#e0574f" if indep else "#1f9d6b"
        parts.append(
            f'<path d="M{x-7} {yp} L{x} {yp-7} L{x+7} {yp} L{x} {yp+7} Z" '
            f'fill="{col}" opacity="0.95"/><text x="{x+9}" y="{yp+4}" font-size="11" fill="{col}">平台{p["station"]}</text>'
        )
        parts.append(
            f'<circle cx="{x}" cy="{ym}" r="5" fill="none" stroke="#556677" stroke-width="2.2"/>'
            f'<text x="{x-9}" y="{ym-8}" font-size="11" fill="#556677" text-anchor="end">现场{p["station"]}</text>'
        )
    parts.append(
        f'<text x="{w-Rm-110}" y="{T-8}" font-size="11" fill="#6b7a92">合成振速 (cm/s)</text>'
    )
    return f'<svg class="chart" viewBox="0 0 {w} {h}">{"".join(parts)}</svg>'

def _row_html(p):
    tag = "独立验证" if not p["in_calibration_set"] else "拟合点"
    tagcls = "tag g" if p["in_calibration_set"] else "tag w"
    return (
        f"<tr><td>{p['station']}</td>"
        f"<td class='num'>{p['R_m']}</td>"
        f"<td class='num'>{p['scaled_distance_rho']}</td>"
        f"<td class='num' style='color:#556677;font-weight:600'>{p['v_measured_cm_s']}</td>"
        f"<td class='num' style='color:#2f6fed;font-weight:600'>{p['v_platform_cm_s']}</td>"
        f"<td class='num' style='color:#334;font-weight:600'>{p['relative_error_pct']:+.2f}%</td>"
        f"<td><span class='{tagcls}'>{tag}</span></td></tr>"
    )

def _metric(me, mae, rmse, mape):
    return f"""
    <table style="margin-top:12px">
      <thead><tr><th>总体误差指标（4点）</th><th class="num">数值</th><th>口径</th></tr></thead>
      <tbody>
        <tr><td>ME 平均误差</td><td class="num" style="font-weight:700">{me['ME_cm_s']:+.3f} cm/s</td><td>平台 − 实测 均值</td></tr>
        <tr><td>MAE 平均绝对误差</td><td class="num" style="font-weight:700">{mae['MAE_cm_s']:.3f} cm/s</td><td>绝对偏差平均</td></tr>
        <tr><td>RMSE 均方根误差</td><td class="num" style="font-weight:700">{rmse['RMSE_cm_s']:.3f} cm/s</td><td>大偏差加权</td></tr>
        <tr><td>MAPE 平均绝对百分误差</td><td class="num" style="font-weight:700">{mape['MAPE_pct']:.2f}%</td><td>相对误差平均</td></tr>
      </tbody>
    </table>"""

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>平台 vs 昆阳磷矿文献现场比对报告（BLAST-2026-006）</title>
<style>
  :root{{--ink:#1a2332;--muted:#5a6b85;--line:#e3e8f0;--bg:#f5f7fa;--accent:#2f6fed;--accsoft:#e8f0ff;
    --green:#1f9d6b;--red:#e0574f;--warnbg:#fff8e6}}
  *{{box-sizing:border-box}}
  body{{margin:0;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}}
  header{{background:linear-gradient(120deg,#14213d,#2f6fed);color:#fff;padding:30px 5vw 22px}}
  header h1{{margin:0 0 6px;font-size:23px}}
  header p{{margin:2px 0;color:#cfe0ff;font-size:13px}}
  .wrap{{max-width:1040px;margin:0 auto;padding:22px 5vw 60px}}
  .cards{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:20px 0 6px}}
  .kpi{{background:#fff;border:1px solid var(--line);border-radius:12px;padding:15px 18px}}
  .kpi .lab{{font-size:12px;color:var(--muted)}}
  .kpi .val{{font-size:21px;font-weight:700;margin-top:2px}}
  .kpi .sub{{font-size:12px;color:var(--muted);margin-top:2px}}
  .good .val{{color:var(--green)}} .accent .val{{color:var(--accent)}} .bad .val{{color:var(--red)}}
  .sec{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:16px 0}}
  .sec h2{{margin:0 0 4px;font-size:17px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}}
  .tag{{font-size:12px;font-weight:600;background:var(--accsoft);color:var(--accent);padding:2px 9px;border-radius:20px}}
  .tag.w{{background:#fdeeea;color:var(--red)}} .tag.g{{background:#e5f5ec;color:var(--green)}}
  .desc{{color:var(--muted);font-size:13px;margin:6px 0 12px}}
  table{{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}}
  th,td{{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left}}
  th{{background:#f7f9fc;color:var(--muted);font-weight:600}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums}}
  .warn{{background:var(--warnbg);border:1px solid #f2dfae;color:#7a5b10;border-radius:10px;padding:12px 14px;font-size:13px;margin-top:8px}}
  .chart{{width:100%;height:auto}}
  .tl{{font-size:12px;color:var(--muted);margin-top:6px}}
  @media(max-width:720px){{.cards{{grid-template-columns:1fr}}}}
</style>
</head>
<body>
<header>
  <h1>平台 vs 昆阳磷矿文献现场比对报告（BLAST-2026-006）</h1>
  <p>006 已由 Da Balai 楔形掏槽完全改为昆阳磷矿巷道模型 · 只用平台计算输出对比文献真实现场监测数据</p>
  <p>文献：王万禄等《昆阳磷矿二矿巷道围岩爆破振动监测与分析》采矿技术 2025, 25(2):78-88</p>
</header>
<div class="wrap">

  <div class="cards">
    <div class="kpi good"><div class="lab">K/α 拟合点残差（M1~M3）</div><div class="val">{max(abs(p['relative_error_pct']) for p in POINTS[:3]):.1f}%</div><div class="sub">最大 |Rel|，属文献回归残差</div></div>
    <div class="kpi accent"><div class="lab">MAPE（4点总体）</div><div class="val">{METS['MAPE_pct']:.1f}%</div><div class="sub">RMSE={METS['RMSE_cm_s']:.3f} cm/s</div></div>
    <div class="kpi bad"><div class="lab">独立外推 M4</div><div class="val">{M4['relative_error_pct']:+.1f}%</div><div class="sub">未参与标定的真实验证点</div></div>
  </div>

  <div class="sec">
    <h2><span class="tag">006 · 昆阳磷矿二矿（萨道夫斯基模型）</span>平台 vs 文献现场实测</h2>
    <p class="desc">文献：1890m 中段2#胶带巷道，43孔楔形掏槽光面爆破，Q=84kg，三心拱断面 4.7×3.75m。
      回归式 V = {K}·(Q^(1/3)/R)^({ALPHA})（据 M1~M3 三方向合成速度最小二乘，R² 拟合；M4 判为异常、剔除）。
      比对方法：平台后端物理引擎注入同一 K/α 后，对 4 个真实现场测点逐点回代。橙红色（M4）为<b>独立验证点</b>，不参与标定，用来检验模型外推精度。</p>
    <div>{_svg_curve()}</div>
    <p class="tl">图：蓝实线=平台（即文献标定 K/α）衰减曲线；▲=平台计算值；○=文献现场实测（表2）。M1~M3 为拟合点，其偏差即文献回归残差；M4 因文献判定异常未参与标定，其偏差是真正的独立外推检验。</p>
    <table>
      <thead><tr><th>监测点</th><th class="num">爆距 R(m)</th><th class="num">比例距离 ρ</th><th class="num">实测合成振速(cm/s)</th><th class="num">平台计算(cm/s)</th><th class="num">相对误差</th><th>角色</th></tr></thead>
      <tbody>{"".join(_row_html(p) for p in POINTS)}</tbody>
    </table>
    {_metric(METS, METS, METS, METS)}
    <div class="warn"><b>方法学说明（避免"同源自证"）</b>：K/α 由 M1~M3 现场数据拟合而来，平台把同一 K/α 回代这三个点，属"文献标定曲线复现现场散布"的拟合残差（作诊断，不作独立精度）；真正的独立验证是 M4 —— 它不参与标定、由公式外推得到，因此其误差 -30.09% 才是平台模型对现场异常点外的外推能力检验。结果显示：拟合点残差+13.4/−23.1/+15.7%，独立点 M4 −30.1%，4 点 MAPE 20.6%。这与文献自述"M4 表现些许异常"吻合 —— 该偏差主要来自 M4 与衰减规律的系统性偏离，而非平台实现错误。</div>
  </div>

</div>
</body>
</html>"""

out = os.path.join(BASE, "kunyang_validation_report.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(html)
print("[OK]", out)