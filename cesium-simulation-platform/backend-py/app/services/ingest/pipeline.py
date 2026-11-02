"""接入流水线（方案 WP1 T1.4 / T1.7）

所有适配器解析出的原始行统一走这里：质检 → 建批次 → 记拒收 → 更新台账状态。
这样「批次号可回溯」「拒收可举证」在四类接入方式上保持一致。
"""
import logging
from typing import Any, Dict, List

from app.services.ingest import store
from app.services.ingest.base import IngestResult
from app.services.ingest.quality import validate_rows

logger = logging.getLogger(__name__)

# 返回给前端的样本上限，避免把整批数据回显
SAMPLE_LIMIT = 5


def run_ingest(source: Dict[str, Any], filename: str, rows: List[Any]) -> IngestResult:
    """执行一批数据的质检与登记。数据库不可用时仍返回结果（批次仅内存可读）。"""
    code = str(source.get("code") or "")
    schema = source.get("schema") if isinstance(source.get("schema"), dict) else {}

    accepted, rejects = validate_rows(rows or [], schema)
    batch_no = store.new_batch_no(code)

    try:
        store.create_batch(
            source_code=code,
            filename=filename,
            rows_total=len(rows or []),
            rows_accepted=len(accepted),
            rows_rejected=len(rejects),
            batch_no=batch_no,
        )
        for reject in rejects:
            store.log_reject(batch_no, reject["rowNo"], reject["reason"], reject["payload"])
        store.mark_status(code, "connected", touch_sync=True)
    except Exception as exc:  # noqa: BLE001 - 台账写失败不得阻断接入结果
        logger.warning("接入批次登记失败（降级）：%s", exc)

    ok = len(rejects) == 0
    if len(accepted) == 0 and rejects:
        message = f"全部 {len(rejects)} 行未通过质检"
    elif rejects:
        message = f"接收 {len(accepted)} 行，拒收 {len(rejects)} 行"
    else:
        message = f"接收 {len(accepted)} 行"

    return IngestResult(
        ok=ok,
        rows_total=len(rows or []),
        rows_accepted=len(accepted),
        rows_rejected=len(rejects),
        batch_no=batch_no,
        message=message,
        sample=accepted[:SAMPLE_LIMIT],
    )
