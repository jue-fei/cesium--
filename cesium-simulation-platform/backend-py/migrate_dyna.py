"""把 LS-DYNA 算例信息（工作区/webapp/data_v3/cases.json）同步进 MySQL。

用法（在 backend-py 目录下）：
    .venv\\Scripts\\python.exe migrate_dyna.py            # 全量同步（自动建表）
    .venv\\Scripts\\python.exe migrate_dyna.py tnt_1      # 只同步单个算例

入库两张表：
    dyna_cases        算例级元信息（label/type/nframes/字段/部件/色标量纲…）
    dyna_case_files   产物文件明细（mesh/frames/report 的实际大小、压缩前字节、压缩比、mtime）

容器目录可用环境变量 DYNA_DATA_DIR 指定（默认 <platform>/dyna/webapp/data_v3）。
剪切/迁移目录后，只需把它指到新的 data_v3 再跑一次即可刷新 storage_root 与文件尺寸。
"""

import json
import sys

import pymysql

from app.database import DB_CONFIG
from app.routes import dyna


def print_file_table(conn) -> None:
    """打印每个算例的产物文件体积（压缩前 → 压缩后），便于直观核对压缩是否生效。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT case_key, role, bytes, raw_bytes, ratio FROM dyna_case_files "
            "ORDER BY case_key, FIELD(role,'mesh','frames','report')")
        rows = cur.fetchall() or []
    if not rows:
        return
    print(f"\n{'算例':10} {'文件':8} {'落盘':>14} {'压缩前':>14} {'压缩比':>7}")
    for r in rows:
        raw = int(r["raw_bytes"] or 0)
        print(f"{r['case_key']:10} {r['role']:8} {int(r['bytes']):>14,} "
              f"{(f'{raw:,}' if raw else '-'):>14} "
              f"{(f'{float(r['ratio']):.2f}x' if raw else '-'):>7}")
    total = sum(int(r["bytes"]) for r in rows)
    frames_raw = sum(int(r["raw_bytes"] or 0) for r in rows)
    print(f"{'合计':10} {'':8} {total:>14,} {frames_raw:>14,} "
          f"{(f'{frames_raw / total:.2f}x' if total else '-'):>7}")


def main() -> int:
    only = sys.argv[1].strip() if len(sys.argv) > 1 else None
    conn = pymysql.connect(**DB_CONFIG)
    try:
        result = dyna.sync_from_disk(conn, only)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print_file_table(conn)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
