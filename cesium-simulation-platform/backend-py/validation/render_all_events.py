# -*- coding: utf-8 -*-
"""由 all_events_field_comparison.json 渲染自包含 HTML 报告。"""
import json
import os
import html

_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SRC = os.path.join(_ROOT, "field_comparison_all", "all_events_field_comparison.json")
DST = os.path.join(_ROOT, "field_comparison_all", "all_events_field_comparison.html")

with open(SRC, "r", encoding="utf-8") as f:
    data = json.load(f)

events = data["events"]
order = ["001", "002", "003", "004", "005", "006", "007"]
NAMES = {k: v["name"] for k, v in events.items()}

def esc(s):
    return html.escape(str(s))

rows = []

def add_row(ev_id, indicator, plat, lit, unit, err, tol, passed, ref=""):
    tag = "通过" if passed else "超差"
    color = "#16a34a" if passed else "#dc2626"
    rows.append(
        f'''<tr data-ev="{ev_id}">
<td class="ev">{esc(ev_id)}</td>
<td>{esc(indicator)}</td>
<td class="num">{esc(plat)}</td>
<td class="num">{esc(lit)}</td>
<td class="num">{esc(unit)}</td>
<td class="num">{esc(err)}%</td>
<td class="num">{esc(tol)}%</td>
<td style="color:{color};font-weight:600">{tag}</td>
<td style="font-size:11px;color:#666">{esc(ref)}</td>
</tr>'''
    )

for ev_id in order:
    m = events[ev_id]["modules"]
    # x50
    x50 = m.get("x50", {})
    if "result" in x50 and isinstance(x50.get("result"), dict):
        r = x50["result"]
        add_row(ev_id, "块度 x50 (Kuz-Ram A=7)", r["platform"], r["literature"],
                r["unit"], r["rel_err_pct"], r["tolerance_pct"], r["passed"],
                f"{x50.get('x50_ref','')}；复现文献所需A*={x50.get('A_star','')}(域[7,13])")
    # throw max
    th = m.get("throw", {})
    if isinstance(th.get("result"), dict):
        r = th["result"]
        add_row(ev_id, "抛掷距离(最大, Persson v0→45°)", r["platform"], r["literature"],
                "m", r["rel_err_pct"], r["tolerance_pct"], r["passed"],
                f"复现文献所需η={th['eta_calibration'].get('required_eta_to_hit_lit','')}")
    if isinstance(th.get("avg_result"), dict):
        r = th["avg_result"]
        add_row(ev_id, "抛掷距离(平均)", r["platform"], r["literature"],
                "m", r["rel_err_pct"], r["tolerance_pct"], r["passed"])
    # pile
    pile = m.get("pile", {})
    if isinstance(pile.get("result"), dict):
        r = pile["result"]
        add_row(ev_id, "爆堆高度", r["platform"], r["literature"], "m",
                r["rel_err_pct"], r["tolerance_pct"], r["passed"],
                "平台无标定堆高模型，三角堆形数量级估计")
    # oversize
    o = m.get("oversize")
    if isinstance(o, dict):
        add_row(ev_id, "大块率@0.5m (KCO 默认孔网)", o["platform"], o["literature"],
                o["unit"], o["rel_err_pct"], o["tolerance_pct"], o["passed"],
                "未用达巴莱实际孔网，标准孔网近似")
    # specific_charge upper bench
    sc = m.get("specific_charge", {})
    if isinstance(sc.get("上台阶单耗(平台全断面均值)"), dict):
        r = sc["上台阶单耗(平台全断面均值)"]
        add_row(ev_id, "上台阶单耗(平台全断面均值)", r["platform"], r["literature"],
                "kg/m³", r["rel_err_pct"], r["tolerance_pct"], r["passed"],
                "设计为全断面99孔均值 vs 文献单台阶实测")

title = data["title"]
s = data["summary"]
vis = "\n".join(rows)

card_html = ""
for ev_id in order:
    m = events[ev_id]["modules"]
    x50 = m.get("x50", {})
    kr = m.get("kuz_ram_dims", {})
    qq = m.get("specific_charge", {})
    ppv = m.get("ppv_attenuation")
    x50_txt = ""
    if "A_star" in x50:
        x50_txt = f"Kuz-Ram 复现所需岩石因子 A*={x50['A_star']}（Cunningham 域[7,13]）"
    else:
        x50_txt = f"平台A=7 参考 x50={x50.get('x50_platform_A7_m','—')}m（{x50.get('x50_ref','无文献x50')}）"
    kr_txt = f"单孔 {kr.get('Q_per_hole_kg','—')}kg / 崩落体积 {kr.get('V0_per_hole_m3','—')}m³ / Q<sub>per-hole</sub>(单孔药量) "
    q_txt = f"单耗 {qq.get('q_kgm3','—')}kg/m³（V={qq.get('volume_m3','—')}m³），Persson v0={qq.get('v0_persson_mps','—')}m/s"
    ppv_txt = f"K={ppv['K']}，α={ppv['alpha']}（文献回归注入，平台同源曲线）" if ppv else "无振动场地回归"
    card_html += f'''
<div class="card" id="ev{ev_id}">
  <div class="card-head">
    <span class="ev-badge">{ev_id}</span>
    <span class="card-title">{esc(events[ev_id]['name'])}</span>
  </div>
  <div class="card-meta">
    <span>{x50_txt}</span>
    <span>{kr_txt}</span>
    <span>{q_txt}</span>
    <span>{ppv_txt}</span>
  </div>
</div>
'''

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>
  body{{font-family:'Segoe UI','Microsoft YaHei',sans-serif;margin:0;background:#f5f7fa;color:#1f2937}}
  .wrap{{max-width:1080px;margin:0 auto;padding:28px 20px}}
  h1{{font-size:22px;margin:0 0 6px}}
  .sub{{color:#6b7280;font-size:13px;margin-bottom:18px}}
  .summary{{display:flex;gap:16px;margin-bottom:22px}}
  .sum-item{{flex:1;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px}}
  .sum-item b{{font-size:26px;display:block}}
  .ok{{color:#16a34a}} .bad{{color:#dc2626}}
  .card{{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:12px}}
  .card-head{{display:flex;align-items:center;gap:10px}}
  .ev-badge{{background:#111827;color:#fff;border-radius:6px;padding:2px 8px;font-weight:700;font-size:13px}}
  .card-title{{font-weight:600}}
  .card-meta{{color:#6b7280;font-size:12px;margin-top:8px;line-height:1.7}}
  .card-meta span{{display:block}}
  table{{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}}
  th,td{{padding:9px 10px;border-bottom:1px solid #eef0f3;text-align:left;font-size:13px}}
  th{{background:#111827;color:#fff;font-weight:600}}
  td.num{{text-align:right;font-variant-numeric:tabular-nums}}
  td.ev{{font-weight:700}}
  .note{{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;font-size:12px;color:#92400e;margin-top:18px;line-height:1.7}}
</style></head><body>
<div class="wrap">
  <h1>{esc(title)}</h1>
  <div class="sub">生成时间 {esc(data['generated_at'])} · 模型：萨道夫斯基PPV / Kuz-Ram块度 / Persson抛掷 / 三角堆高 / KCO大块率</div>
  <div class="summary">
    <div class="sum-item">通过<b class="ok">{s['pass']}</b>项</div>
    <div class="sum-item">超差<b class="bad">{s['fail']}</b>项</div>
    <div class="sum-item">覆盖事件<b>{len(order)}</b>个</div>
  </div>
  {card_html}
  <h2 style="font-size:18px;margin:26px 0 12px">逐项比对明细</h2>
  <table>
    <thead><tr><th>事件</th><th>指标</th><th>平台计算</th><th>文献现场</th><th>单位</th><th>相对误差</th><th>容差</th><th>判定</th><th>口径说明</th></tr></thead>
    <tbody>{vis}</tbody>
  </table>
  <div class="note">
    <b>口径与边界说明：</b>① 块度 x50 使用 Kuz-Ram(Kuznetsov) 公式，岩石因子取中硬岩 A=7，另给出复现文献值所需的 A*；A*∈[7,13] 表示物理合理。
    ② 抛掷距离为 Persson v0 在 45° 弹道下的最大抛距（无风、无空气阻力），所需 η 接近默认 0.15 表示平台模型能良好复现文献抛距。
    ③ 爆堆高度平台无标定模块，按松散方沿抛距铺布的三角断面给出的数量级估计仅供参考。
    ④ 大块率使用 KCO 标准孔网（非达巴莱实际孔网），仅作量级参考。⑤ 003/004 为振动类文献，仅报告文献回归注入的 PPV 衰减曲线（同源自洽）。
  </div>
</div>
</body></html>"""

with open(DST, "w", encoding="utf-8") as f:
    f.write(html_doc)
print(f"[OK] HTML -> {DST}")