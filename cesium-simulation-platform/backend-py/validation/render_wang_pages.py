# -*- coding: utf-8 -*-
"""渲染关键页为高清图片，供目视提取实测振速散点与回归图。"""
import fitz  # pymupdf

PDF = r"C:\Users\allblack\Downloads\复杂环境下隧道钻爆施工降振试验研究及控制_汪亚飞.pdf"
OUTDIR = r"c:\Users\allblack\Desktop\1\cesium-simulation-platform\backend-py\nanshan_validation_output\pages"
import os
os.makedirs(OUTDIR, exist_ok=True)

# (pdf_index, 说明)
idxs = [
    (45, "ch5_regression_toc_around"),
    (86, "regression_fig_headroom"),   # 图 掌子面前方地表振速回归直线图
    (87, "regression_after"),
]
# 数据表页
for i in range(48, 54):
    idxs.append((i, f"measured_table_p{i+1}"))
# 上台阶设计表页（图5-1/5-2 附近）再兜底渲染 84-92
for i in range(84, 93):
    idxs.append((i, f"reg_zone_p{i+1}"))

doc = fitz.open(PDF)
for idx, tag in idxs:
    if idx < 0 or idx >= doc.page_count:
        print(f"skip idx {idx} {tag}")
        continue
    page = doc[idx]
    pix = page.get_pixmap(matrix=fitz.Matrix(3, 3))  # 3x zoom
    path = os.path.join(OUTDIR, f"p{idx+1:03d}_{tag}.png")
    pix.save(path)
    print(f"[OK] {path}  {pix.width}x{pix.height}")
doc.close()