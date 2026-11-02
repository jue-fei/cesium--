"""数据源台账与接入接口（方案 WP1 T1.2–T1.7）

HTTP
    GET    /api/datasource                 台账列表 + 支持的接入类型
    POST   /api/datasource                 登记/更新数据源
    DELETE /api/datasource/{code}          删除数据源
    POST   /api/datasource/{code}/test     连通性检测（写回状态）
    POST   /api/datasource/{code}/pull     主动拉取（rest/db）
    POST   /api/datasource/{code}/upload   文件导入（原始 body + filename 参数）
    POST   /api/datasource/{code}/push     WebSocket 源推送入口
    GET    /api/datasource/{code}/batches  批次回溯

说明：文件上传不依赖 python-multipart（当前环境未安装），
以原始字节 + `filename` 查询参数承载；后续可平滑切换 multipart。
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, Query, Request

from app.security import require_token
from app.services.ingest import store
from app.services.ingest.adapters import ADAPTER_REGISTRY, WsAdapter
from app.services.ingest.base import VALID_KINDS
from app.services.ingest.file_adapter import FileAdapter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/datasource", redirect_slashes=False, tags=["数据接入"])


def _adapter_for(source: Dict[str, Any]):
    """按台账 kind 构造适配器；未知类型返回 None。"""
    kind = str(source.get("kind") or "").lower()
    if kind == "file":
        return FileAdapter(source)
    adapter_cls = ADAPTER_REGISTRY.get(kind)
    return adapter_cls(source) if adapter_cls else None


def _not_found(code: str) -> Dict[str, Any]:
    return {"code": 1, "message": f"数据源 {code} 不存在"}


@router.get("")
def list_sources():
    """台账列表：四类接入方式的登记与状态，是「集成方式≥4 种」的举证入口。"""
    return {
        "code": 0,
        "data": {"sources": store.list_sources(), "kinds": list(VALID_KINDS)},
    }


@router.post("", dependencies=[Depends(require_token)])
def upsert_source(body: dict = Body(..., description="数据源定义")):
    """登记或更新数据源（按 code 幂等）。"""
    code = str(body.get("code") or "").strip()
    name = str(body.get("name") or "").strip()
    kind = str(body.get("kind") or "").strip().lower()
    if not code or not name:
        return {"code": 1, "message": "code/name 必填"}
    if kind not in VALID_KINDS:
        return {"code": 1, "message": f"kind 需为 {'/'.join(VALID_KINDS)}"}

    schema = body.get("schema") if isinstance(body.get("schema"), dict) else {}
    ok = store.upsert_source(
        code=code,
        name=name,
        kind=kind,
        endpoint=str(body.get("endpoint") or ""),
        auth_ref=str(body.get("authRef") or body.get("auth_ref") or ""),
        schema=schema,
        owner=str(body.get("owner") or ""),
    )
    if not ok:
        return {"code": 1, "message": "台账不可写（数据库不可用）"}
    return {"code": 0, "data": {"source": store.get_source(code)}}


@router.delete("/{code}", dependencies=[Depends(require_token)])
def delete_source(code: str):
    ok = store.delete_source(code)
    return {"code": 0 if ok else 1, "message": "已删除" if ok else "不存在或删除失败"}


@router.post("/{code}/test", dependencies=[Depends(require_token)])
def test_source(code: str):
    """连通性检测：结果写回台账 status，供测评逐条举证。"""
    source = store.get_source(code)
    if not source:
        return _not_found(code)

    adapter = _adapter_for(source)
    if adapter is None:
        return {"code": 1, "message": f"未支持的 kind {source.get('kind')}"}

    result = adapter.test()
    store.mark_status(code, "connected" if result.get("ok") else "error")
    return {"code": 0, "data": result}


@router.post("/{code}/pull", dependencies=[Depends(require_token)])
def pull_source(code: str, limit: int = Query(100, ge=1, le=1000)):
    """主动拉取（REST / 数据库）。文件源请走 upload，WS 源请走 push。"""
    source = store.get_source(code)
    if not source:
        return _not_found(code)
    adapter = _adapter_for(source)
    if adapter is None:
        return {"code": 1, "message": f"未支持的 kind {source.get('kind')}"}

    result = adapter.pull(limit=limit)
    return {"code": 0 if result.ok else 1, "data": result.as_dict()}


@router.post("/{code}/upload", dependencies=[Depends(require_token)])
async def upload_file(
    code: str,
    request: Request,
    filename: str = Query(..., min_length=1, description="文件名（用于识别格式）"),
):
    """文件导入：原始字节作为 body，filename 决定 JSON/CSV 解析。"""
    source = store.get_source(code)
    if not source:
        return _not_found(code)
    if source.get("kind") != "file":
        return {"code": 1, "message": f"数据源 {code} 不是 file 类型"}

    raw = await request.body()
    result = FileAdapter(source).ingest_bytes(filename, raw)
    return {"code": 0 if result.ok else 1, "data": result.as_dict()}


@router.post("/{code}/push", dependencies=[Depends(require_token)])
def push_rows(code: str, body: dict = Body(..., description="一帧/一批 WS 消息")):
    """WebSocket 源推送入口：外部系统把消息推给平台，统一质检后登记批次。"""
    source = store.get_source(code)
    if not source:
        return _not_found(code)
    if source.get("kind") != "ws":
        return {"code": 1, "message": f"数据源 {code} 不是 ws 类型"}

    rows = body.get("rows") if isinstance(body.get("rows"), list) else [body]
    result = WsAdapter(source).push(rows, label=f"ws:push:{code}")
    return {"code": 0 if result.ok else 1, "data": result.as_dict()}


@router.get("/{code}/batches")
def list_batches(code: str, limit: int = Query(50, ge=1, le=200)):
    """批次回溯：每次导入的总行数/接收/拒收与状态。"""
    return {"code": 0, "data": {"batches": store.list_batches(code, limit)}}
