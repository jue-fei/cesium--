"""文件适配器（方案 WP1 T1.4）

支持 JSON / CSV 两种格式，走统一质检流水线（批号、拒收明细、状态回写）。

上传协议（不依赖 python-multipart）：
    POST /api/datasource/{code}/upload?filename=xxx.json
    Content-Type: application/octet-stream（或 text/csv、application/json）
    Body: 文件原始字节
若后续安装 python-multipart，可平滑切换为 multipart/form-data。
"""
import csv
import io
import json
import logging
from typing import Any, Dict, List

from app.services.ingest import pipeline
from app.services.ingest.adapters import extract_rows
from app.services.ingest.base import FileAdapterBase, IngestResult

logger = logging.getLogger(__name__)

# 单批上限：50MB，超限直接拒绝，避免一次性吃满内存
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


class FileAdapter(FileAdapterBase):
    """JSON/CSV 文件导入。"""

    kind = "file"

    def ingest_bytes(self, filename: str, raw: bytes) -> IngestResult:
        if raw is None or len(raw) == 0:
            return IngestResult(ok=False, message="文件内容为空")
        if len(raw) > MAX_UPLOAD_BYTES:
            return IngestResult(ok=False, message=f"文件超过 {MAX_UPLOAD_BYTES // 1024 // 1024}MB")

        try:
            # utf-8-sig 兼容 Excel 导出的 BOM
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return IngestResult(ok=False, message="仅支持 UTF-8 编码文件")

        fmt = self.detect_format(filename, text)
        try:
            rows = self.parse(fmt, text)
        except Exception as exc:  # noqa: BLE001 - 解析失败需返回可读原因
            return IngestResult(ok=False, message=f"{fmt.upper()} 解析失败：{exc}")

        if not rows:
            return IngestResult(ok=False, message="未解析到任何数据行")

        result = pipeline.run_ingest(self.source, filename, rows)
        result.message = f"[{fmt.upper()}] {result.message}"
        return result

    def detect_format(self, filename: str, text: str) -> str:
        """优先用 schema.format，其次扩展名，最后看首个非空字符。"""
        declared = str(self.schema.get("format") or "").strip().lower()
        if declared in ("json", "csv"):
            return declared
        lower = (filename or "").lower()
        if lower.endswith(".json"):
            return "json"
        if lower.endswith(".csv"):
            return "csv"
        return "json" if text.lstrip()[:1] in ("[", "{") else "csv"

    def parse(self, fmt: str, text: str) -> List[Dict[str, Any]]:
        if fmt == "json":
            payload = json.loads(text)
            rows = extract_rows(payload)
            if rows:
                return rows
            # 单对象或 {key: {...}} 形式：包成一行
            return [payload] if isinstance(payload, dict) else []
        reader = csv.DictReader(io.StringIO(text))
        return [dict(row) for row in reader]
