"""数据接入适配器框架（方案 WP1 T1.1）

四类适配器：`rest` / `ws` / `file` / `db`，对齐课题指标 1.1「多源多类型数据集成方式≥4 种」。

约定：
- 适配器只做「取数与规范化」，不做业务计算（方案 §四关键约束）；
- `test()` 必须轻量、无副作用，供台账页一键连通性检测；
- `pull()` 返回统一 `IngestResult`，失败不抛异常，转为 ok=False + message。
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

VALID_KINDS = ("rest", "ws", "file", "db")


@dataclass
class IngestResult:
    """统一接入结果：批次号 + 接收/拒收计数 + 样本。"""

    ok: bool
    rows_total: int = 0
    rows_accepted: int = 0
    rows_rejected: int = 0
    batch_no: str = ""
    message: str = ""
    sample: List[Dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "rowsTotal": self.rows_total,
            "rowsAccepted": self.rows_accepted,
            "rowsRejected": self.rows_rejected,
            "batchNo": self.batch_no,
            "message": self.message,
            "sample": self.sample,
        }


class DataSourceAdapter(ABC):
    """适配器基类。子类至少实现 `kind` 与 `test()`。"""

    kind: str = ""

    def __init__(self, source: Dict[str, Any]):
        self.source = source or {}

    @property
    def code(self) -> str:
        return str(self.source.get("code") or "")

    @property
    def endpoint(self) -> str:
        return str(self.source.get("endpoint") or "")

    @property
    def schema(self) -> Dict[str, Any]:
        schema = self.source.get("schema")
        return schema if isinstance(schema, dict) else {}

    @abstractmethod
    def test(self) -> Dict[str, Any]:
        """连通性检测，返回 {ok, message, latencyMs, detail?}。"""

    def pull(self, limit: int = 100) -> IngestResult:
        """主动拉取（file 类不支持主动拉取，返回明确提示）。"""
        return IngestResult(ok=False, message=f"{self.kind} 适配器不支持 pull")


class FileAdapterBase(DataSourceAdapter):
    """文件类适配器的公共能力：由路由把原始字节交给 `ingest_bytes`。"""

    kind = "file"

    def test(self) -> Dict[str, Any]:
        # 文件源没有远端地址，连通性等价于「台账可写 + 格式声明完整」
        return {
            "ok": True,
            "message": "文件源就绪（等待上传）",
            "latencyMs": 0,
            "detail": {"format": self.schema.get("format", "auto")},
        }

    @abstractmethod
    def ingest_bytes(self, filename: str, raw: bytes) -> IngestResult:
        """解析并质检一批文件内容。"""


def build_kind_index(adapters: List[type]) -> Dict[str, type]:
    """按 kind 建立注册表，供路由按台账记录分派。"""
    index: Dict[str, type] = {}
    for adapter in adapters:
        kind = getattr(adapter, "kind", "")
        if kind:
            index[kind] = adapter
    return index


def get_adapter_class(kind: str, registry: Dict[str, type]) -> Optional[type]:
    return registry.get((kind or "").strip().lower())
