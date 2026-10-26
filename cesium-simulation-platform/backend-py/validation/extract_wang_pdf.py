# -*- coding: utf-8 -*-
"""提取汪亚飞博士论文全文，定位现场实测爆破振动监测数据（振速/药量/爆心距散点）。"""
import re
import sys
from pypdf import PdfReader

PDF = r"C:\Users\allblack\Downloads\复杂环境下隧道钻爆施工降振试验研究及控制_汪亚飞.pdf"
OUT = r"c:\Users\allblack\Desktop\1\cesium-simulation-platform\backend-py\nanshan_validation_output\wang_fulltext.txt"

reader = PdfReader(PDF)
print(f"[pages] {len(reader.pages)}")
with open(OUT, "w", encoding="utf-8") as f:
    for i, page in enumerate(reader.pages):
        try:
            txt = page.extract_text() or ""
        except Exception as e:
            txt = ""
        f.write(f"\n===== PAGE {i + 1} =====\n")
        f.write(txt)

print(f"[OK] wrote {OUT}")