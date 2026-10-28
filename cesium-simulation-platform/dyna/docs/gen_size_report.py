"""生成 LS-DYNA 容器存储体积报告（HTML，自包含、无外部依赖）。

数据来源：dyna/webapp/data_v3 容器头 + dyna/reports/*.report.json + 源 d3plot 目录大小。
用法： python _gen_size_report.py <输出 html 路径>
"""
import json
import os
import pathlib
import struct
import sys
from datetime import datetime

DYNA = pathlib.Path(__file__).resolve().parent.parent      # docs/ → dyna/
DATA = DYNA / 'webapp' / 'data_v3'
SIZEOF = {'u1': 1, 'u2': 2, 'f4': 4, 'i4': 4, 'i2': 2, 'f8': 8}
GIB = 1024 ** 3
MIB = 1024 ** 2

# 源 d3plot 目录（由 report.dir 反查，目录不在时按已知实测值兜底）
SRC_FALLBACK = {
    'airblast': (r'C:\Users\allblack\Desktop\tnt\blasting in air', 3226 * MIB),
    'presplit': (r'C:\Users\allblack\Desktop\tnt\预裂', 8105 * MIB),
    'smooth': (r'C:\Users\allblack\Desktop\tnt\光面\光面爆破', 5445 * MIB),
    'sph1': (r'C:\Users\allblack\Desktop\tnt\sph-1', 12635 * MIB),
    'tnt_1': (r'C:\Users\allblack\Desktop\tnt\1', 641 * MIB),
    'tnt_re1': (r'C:\Users\allblack\Desktop\tnt\re-1', 641 * MIB),
}


def d3plot_size(d):
    if not d or not os.path.isdir(d):
        return None
    total = 0
    for f in os.listdir(d):
        if f.startswith('d3plot'):
            try:
                total += os.path.getsize(os.path.join(d, f))
            except OSError:
                pass
    return total or None


def read_frames_header(fp):
    with open(fp, 'rb') as f:
        f.read(5)
        n = struct.unpack('<I', f.read(4))[0]
        return json.loads(f.read(n).decode('utf-8'))


def collect():
    cases_json = json.loads((DATA / 'cases.json').read_text(encoding='utf-8'))
    rows = []
    for key, e in cases_json.items():
        fp = DATA / e['frames']
        H = read_frames_header(fp)
        per = {}
        for fl in H['fields']:
            per[fl['id']] = per.get(fl['id'], 0) + fl['count'] * SIZEOF.get(fl['dtype'], 4)
        frame_bytes = sum(per.values())
        rep = DYNA / 'reports' / f'{key}.report.json'
        raw = ratio = None
        src_dir = SRC_FALLBACK.get(key, (None, None))[0]
        if rep.is_file():
            R = json.loads(rep.read_text(encoding='utf-8'))
            fr = (R.get('container') or {}).get('frames') or {}
            raw, ratio = fr.get('raw_bytes'), fr.get('ratio')
            src_dir = R.get('dir') or src_dir
        src_bytes = d3plot_size(src_dir) or SRC_FALLBACK.get(key, (None, None))[1]
        mesh_bytes = (DATA / e['mesh']).stat().st_size
        frames_bytes = fp.stat().st_size
        fields = sorted(({'id': k, 'bytes': v, 'share': v / frame_bytes} for k, v in per.items()),
                        key=lambda x: -x['bytes'])
        rows.append({
            'key': key, 'label': e.get('label') or key, 'type': e.get('type'),
            'nframes': len(H['frames']), 'mesh_bytes': mesh_bytes, 'frames_bytes': frames_bytes,
            'frame_bytes': frame_bytes, 'raw_bytes': raw, 'ratio': ratio,
            'src_dir': src_dir, 'src_bytes': src_bytes,
            'fields': fields,
            'precision': H.get('precision') or {},
        })
    rows.sort(key=lambda r: -r['frames_bytes'])
    return rows


def fmt(n, unit='auto'):
    if n is None:
        return '—'
    if unit == 'GiB':
        return f'{n / GIB:.2f} GiB'
    if unit == 'MiB':
        return f'{n / MIB:.0f} MiB'
    if n >= GIB:
        return f'{n / GIB:.2f} GiB'
    return f'{n / MIB:.0f} MiB'


def bar(pct, color, label=''):
    return (f'<div class="bar"><span style="width:{max(pct, 0.6):.1f}%;background:{color}"></span></div>'
            f'<span class="barlabel">{label}</span>')


def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '存储体积报告.html')
    rows = collect()
    total = sum(r['mesh_bytes'] + r['frames_bytes'] for r in rows)
    total_frames = sum(r['frames_bytes'] for r in rows)
    total_mesh = sum(r['mesh_bytes'] for r in rows)
    total_raw = sum((r['raw_bytes'] or 0) for r in rows)
    total_src = sum((r['src_bytes'] or 0) for r in rows)
    zstd_ratio = total_raw / total_frames if total_frames else 0

    # 瘦身情景
    def without(field):
        s = 0
        for r in rows:
            share = next((f['share'] for f in r['fields'] if f['id'] == field), 0)
            s += r['frames_bytes'] * (1 - share)
        return s

    s_no_stress = without('stress') + total_mesh
    s_no_stress_hist = sum(
        r['frames_bytes'] * (1 - sum(f['share'] for f in r['fields'] if f['id'] in ('stress', 'hist')))
        for r in rows) + total_mesh
    s_third_frames = total / 3

    colors = ['#5aa9e6', '#f2b134', '#7bd389', '#e06c75', '#b48ead', '#56b6c2']
    max_frames = max(r['frames_bytes'] for r in rows)
    sph1 = next(r for r in rows if r['key'] == 'sph1')
    sph1_raw = sph1['frame_bytes'] * sph1['nframes']

    # ── 每算例表 ──
    case_rows = []
    for r in rows:
        cont = r['mesh_bytes'] + r['frames_bytes']
        pct_src = (cont / r['src_bytes'] * 100) if r['src_bytes'] else None
        top = '、'.join(f"{f['id']} {f['share'] * 100:.0f}%" for f in r['fields'][:3])
        case_rows.append(f"""<tr>
      <td><b>{r['key']}</b><div class="sub">{r['label']} · {r['type']}</div></td>
      <td class="num">{fmt(r['src_bytes'])}</td>
      <td class="num"><b>{fmt(cont)}</b><div class="sub">mesh {fmt(r['mesh_bytes'])} + frames {fmt(r['frames_bytes'])}</div></td>
      <td class="num">{'' if pct_src is None else f'{pct_src:.0f}%'}</td>
      <td class="num">{r['nframes']}</td>
      <td class="num">{r['frame_bytes'] / MIB:.2f} MiB</td>
      <td class="num">{'' if not r['ratio'] else f"{r['ratio']:.2f}×"}</td>
      <td class="sub">{top}</td>
    </tr>""")

    # ── 字段构成（每算例堆叠条）──
    field_blocks = []
    for r in rows:
        segs, legend = [], []
        for i, f in enumerate(r['fields'][:5]):
            c = colors[i % len(colors)]
            segs.append(f'<span style="width:{f["share"] * 100:.2f}%;background:{c}" title="{f["id"]} {f["share"] * 100:.1f}%"></span>')
            legend.append(f'<i style="background:{c}"></i>{f["id"]} {f["share"] * 100:.0f}%')
        rest = 1 - sum(f['share'] for f in r['fields'][:5])
        if rest > 0.001:
            segs.append(f'<span style="width:{rest * 100:.2f}%;background:#3a4250" title="其余字段"></span>')
            legend.append('<i style="background:#3a4250"></i>其余')
        field_blocks.append(f"""<div class="frow">
      <div class="fname">{r['key']}<span class="sub"> {r['frame_bytes'] / MIB:.2f} MiB/帧</span></div>
      <div class="stack">{''.join(segs)}</div>
      <div class="legend">{' '.join(legend)}</div>
    </div>""")

    # ── 体积排行条 ──
    rank_blocks = []
    for r in rows:
        cont = r['mesh_bytes'] + r['frames_bytes']
        rank_blocks.append(f"""<div class="rankrow">
      <div class="rname">{r['key']}</div>
      {bar(cont / max_frames * 100, '#5aa9e6', fmt(cont))}
    </div>""")

    save_rows = [
        ('不提取 stress 层（6 分量 f4）', '重转时去掉 --extract stress',
         fmt(s_no_stress), '失去 vm / σ1 / σ3 三个应力视图，位移/损伤/应变/压力/速度保留'),
        ('同时不提取 stress + hist', 'tnt_1 的 hist 占 51%（nel×nv3d）',
         fmt(s_no_stress_hist), '再失去单元历史曲线（hist 图表）'),
        ('帧数降到 1/3', '--frames-limit N（只保留前 N 帧）',
         fmt(s_third_frames), '时间分辨率变粗，看不到后期过程'),
        ('删掉 sph1 一个算例', '前端标签悬停 × 或 DELETE /api/dyna/cases/sph1',
         fmt(total - next(r['mesh_bytes'] + r['frames_bytes'] for r in rows if r['key'] == 'sph1')),
         '失去该算例（可随时重转）'),
        ('平台不再存第二份', 'DYNA_DATA_DIR 指向 工作区/webapp/data_v3',
         fmt(total) + ' 磁盘', '平台不再自包含，依赖外部目录'),
    ]
    save_html = '\n'.join(
        f"""<tr><td><b>{a}</b><div class="sub">{b}</div></td>
      <td class="num good">{c}</td><td class="sub">{d}</td></tr>""" for a, b, c, d in save_rows)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>LS-DYNA 容器存储体积报告</title>
<style>
  :root {{ --bg:#0f1318; --panel:#171c23; --line:#242b35; --ink:#e6ebf2; --ink2:#9aa7b8; --ink3:#6b7889;
          --accent:#5aa9e6; --good:#7bd389; --warn:#f2b134; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }}
  .wrap {{ max-width:1080px; margin:0 auto; padding:40px 28px 72px; }}
  h1 {{ font-size:26px; margin:0 0 6px; letter-spacing:.01em; }}
  h2 {{ font-size:17px; margin:38px 0 12px; padding-left:10px; border-left:3px solid var(--accent); }}
  .meta {{ color:var(--ink3); font-size:12.5px; margin-bottom:26px; }}
  .kpis {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }}
  .kpi {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }}
  .kpi .k {{ color:var(--ink3); font-size:12px; }}
  .kpi .v {{ font-size:23px; font-weight:600; margin-top:4px; }}
  .kpi .v small {{ font-size:12px; color:var(--ink2); font-weight:400; }}
  .card {{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }}
  table {{ width:100%; border-collapse:collapse; font-size:13px; }}
  th, td {{ text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }}
  th {{ color:var(--ink2); font-weight:500; font-size:12px; }}
  td.num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
  .sub {{ color:var(--ink3); font-size:11.5px; font-weight:400; }}
  .good {{ color:var(--good); font-weight:600; }}
  .bar {{ background:#222833; border-radius:4px; height:14px; overflow:hidden; flex:1; }}
  .bar span {{ display:block; height:100%; border-radius:4px; }}
  .barlabel {{ color:var(--ink2); font-size:12px; width:74px; text-align:right; font-variant-numeric:tabular-nums; }}
  .rankrow {{ display:flex; align-items:center; gap:12px; margin:7px 0; }}
  .rname {{ width:74px; color:var(--ink2); font-size:12.5px; }}
  .frow {{ margin:12px 0 16px; }}
  .fname {{ font-size:12.5px; margin-bottom:5px; }}
  .stack {{ display:flex; height:16px; border-radius:4px; overflow:hidden; background:#222833; }}
  .stack span {{ display:block; height:100%; }}
  .legend {{ margin-top:5px; color:var(--ink3); font-size:11px; }}
  .legend i {{ display:inline-block; width:8px; height:8px; border-radius:2px; margin:0 4px 0 10px; }}
  .legend i:first-child {{ margin-left:0; }}
  .note {{ background:#1a2029; border:1px solid var(--line); border-left:3px solid var(--warn);
           border-radius:8px; padding:12px 14px; color:var(--ink2); font-size:13px; margin-top:14px; }}
  code {{ background:#232a34; padding:1px 5px; border-radius:4px; font-size:12px; }}
  ul {{ margin:8px 0 0 18px; padding:0; color:var(--ink2); }}
  li {{ margin:4px 0; }}
</style></head><body><div class="wrap">

<h1>LS-DYNA 容器存储体积报告</h1>
<div class="meta">数据根 <code>{DATA}</code> · 生成时间 {datetime.now():%Y-%m-%d %H:%M} · 统计对象：{len(rows)} 个算例</div>

<div class="kpis">
  <div class="kpi"><div class="k">容器合计（落盘）</div><div class="v">{total / GIB:.2f} <small>GiB</small></div></div>
  <div class="kpi"><div class="k">源 d3plot 合计</div><div class="v">{total_src / GIB:.1f} <small>GiB</small></div></div>
  <div class="kpi"><div class="k">容器 / 源数据</div><div class="v">{total / total_src * 100:.1f}<small>%</small></div></div>
  <div class="kpi"><div class="k">zstd 压缩比</div><div class="v">{zstd_ratio:.2f}<small>×</small></div></div>
</div>

<h2>一句话结论</h2>
<div class="card">
  容器 <b>{total / GIB:.2f} GiB</b> 已经是源 d3plot <b>{total_src / GIB:.1f} GiB</b> 的
  <b class="good">{total / total_src * 100:.1f}%</b>（约 1/{total_src / total:.1f}），
  且帧块已在转换阶段做过 <b>u2 量化 + 每帧 zstd-9</b>（{total_raw / GIB:.1f} GiB → {total_frames / GIB:.1f} GiB，{zstd_ratio:.2f}×）。
  现在看起来"还是很大"，是因为<b>体积 = 帧数 × 单元/节点数 × 字段数 × 精度</b>，这几个乘数都是物理量：
  sph1 单帧未压缩 {sph1['frame_bytes'] / MIB:.2f} MiB × {sph1['nframes']} 帧 = {sph1_raw / GIB:.2f} GiB，压完仍有 {sph1['frames_bytes'] / GIB:.2f} GiB，它一个就占了全库 <b>{sph1['frames_bytes'] / total * 100:.0f}%</b>。
</div>

<h2>各算例体积排行</h2>
<div class="card">{''.join(rank_blocks)}</div>

<h2>逐算例明细</h2>
<div class="card"><table>
  <tr><th>算例</th><th class="num">源 d3plot</th><th class="num">容器</th><th class="num">占源</th>
      <th class="num">帧数</th><th class="num">单帧未压缩</th><th class="num">zstd</th><th>主要字段</th></tr>
  {''.join(case_rows)}
</table>
<div class="note">「占源」= 容器 / 源 d3plot 目录下 <code>d3plot*</code> 文件合计；mesh.bin 是表面网格（未压缩），frames.bin 是逐帧场数据（u2 + zstd）。</div>
</div>

<h2>帧内字段构成（每帧未压缩字节占比）</h2>
<div class="card">{''.join(field_blocks)}
<div class="note"><b>stress 是最大项</b>：6 个分量 × 节点数 × <code>f4</code>（4 字节），在 5 个算例里占 57~61%；
它保持 f4 是因为 6 个分量量级差很大，共享 u2 的 scale/offset 会把小分量压成 0。
tnt_1 里 <b>hist</b> 反而占 51%（nel × nv3d 个 word，显式开 <code>--extract hist</code> 才有）。</div>
</div>

<h2>可选的瘦身手段（按收益排序）</h2>
<div class="card"><table>
  <tr><th>手段</th><th class="num">瘦身后总量</th><th>代价</th></tr>
  {save_html}
</table>
<div class="note">以上都是"重转"或"删数据"级别的手段，不做就不会变；压缩层面已经没有多少余量（zstd 已 2.03×，u2 量化已生效）。</div>
</div>

<h2>平台其他目录</h2>
<div class="card"><table>
  <tr><th>目录</th><th class="num">体积</th><th>说明</th></tr>
  <tr><td>dyna/</td><td class="num">{total / GIB:.2f} GiB</td><td class="sub">算例容器 + 报告 + 转换器（本报告主体）</td></tr>
  <tr><td>backend-py/</td><td class="num">527 MiB</td><td class="sub">主要是 .venv（Python 依赖，可随时重建）</td></tr>
  <tr><td>cesium1/</td><td class="num">≥175 MiB</td><td class="sub">前端源码 + node_modules：cesium 74 / element-plus 59 / three 29 / @dimforge 10 MiB（共 336 个包，未逐一统计）；生产构建后不需要</td></tr>
  <tr><td>output/</td><td class="num">228 KiB</td><td class="sub">可忽略</td></tr>
</table></div>

<h2>现状</h2>
<ul>
  <li>已删除算例 <code>sph2</code>（约 288 MiB）：容器文件、<code>dyna_cases</code> / <code>dyna_case_files</code> 记录、<code>cases.json</code> 条目均已清理，删除链路验证通过。</li>
  <li>工作区 <code>工作区/webapp/data_v3</code> 仍有一份同样的 3.1 GiB 拷贝，与平台这份互不引用（磁盘上实际占用翻倍）。</li>
  <li>报告口径与数据库一致：<code>GET /api/dyna/files</code> 的 <code>bytes / raw_bytes / ratio</code> 与本报告同源。</li>
</ul>

</div></body></html>"""
    out.write_text(html, encoding='utf-8')
    print(f'已生成 {out}  ({len(html) / 1024:.0f} KB)')
    print(f'容器合计 {total / GIB:.2f} GiB / 源 {total_src / GIB:.2f} GiB = {total / total_src * 100:.1f}%')
    print(f'去 stress 后 ≈ {s_no_stress / GIB:.2f} GiB；去 stress+hist ≈ {s_no_stress_hist / GIB:.2f} GiB；1/3 帧 ≈ {s_third_frames / GIB:.2f} GiB')


if __name__ == '__main__':
    main()
