# -*- coding: utf-8 -*-
"""高清渲染第86页（图5-1/图5-2 回归图），并放大裁剪图5-2 散点区域。"""
import pymupdf

PDF = r"C:\Users\allblack\Downloads\复杂环境下隧道钻爆施工降振试验研究及控制_汪亚飞.pdf"
OUTDIR = r"c:\Users\allblack\Desktop\1\cesium-simulation-platform\backend-py\nanshan_validation_output\pages"

doc = pymupdf.open(PDF)
page = doc[86]  # 0-based
# 整页 6x
pix = page.get_pixmap(matrix=pymupdf.Matrix(6, 6))
full = f"{OUTDIR}\\p087_regfig_6x.png"
pix.save(full)
print("[OK]", full, pix.width, pix.height)

# 图5-2 在页面中部靠下；用矩形裁剪（图5-2 区域）放大
# 先渲染整页到内存再裁剪会失真，直接用 clip 渲染该区域
rect = page.rect
# 图5-2 约占页面下方 45%~95% 高度区域；靠左 0-100% 宽
clip = pymupdf.Rect(0, rect.height * 0.45, rect.width, rect.height)
pix2 = page.get_pixmap(matrix=pymupdf.Matrix(8, 8), clip=clip)
fig52 = f"{OUTDIR}\\p087_fig52_scatter_8x.png"
pix2.save(fig52)
print("[OK]", fig52, pix2.width, pix2.height)
doc.close()