# -*- coding: utf-8 -*-
"""提取 eng-07-00161-v2.pdf（Da Balai/006 事件来源文献）全文。"""
from pypdf import PdfReader

PDF = r"c:\Users\allblack\Desktop\1\振动文献\eng-07-00161-v2.pdf"
OUT = r"c:\Users\allblack\Desktop\1\cesium-simulation-platform\backend-py\nanshan_validation_output\eng_fulltext.txt"
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