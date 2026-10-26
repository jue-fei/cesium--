# -*- coding: utf-8 -*-
"""提取昆阳磷矿文献全文（006 新配置来源）。"""
from pypdf import PdfReader

PDF = r"c:\Users\allblack\.trae-cn\attachments\6a9a753600bf978d41a1d60a\a0075d21-f220-47a8-bcad-733ae6a9514f_57ff2aca-174f-464c-a439-6752263d8261_昆阳磷矿二矿巷道围岩爆破振动监测与分析_王万禄.pdf"
OUT = r"c:\Users\allblack\Desktop\1\cesium-simulation-platform\backend-py\nanshan_validation_output\kunyang_fulltext.txt"
r = PdfReader(PDF)
with open(OUT, "w", encoding="utf-8") as f:
    for i, pg in enumerate(r.pages):
        try:
            t = pg.extract_text() or ""
        except Exception:
            t = ""
        f.write(f"\n===== PAGE {i+1} =====\n")
        f.write(t)
print("pages", len(r.pages), "wrote", OUT)