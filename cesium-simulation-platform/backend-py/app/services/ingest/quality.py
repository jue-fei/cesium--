"""接入数据质量规则（方案 WP1 T1.7）

五类规则，按顺序执行，任一不通过即拒收该行：
1. 必填      required        字段缺失或空串 → 拒收
2. 时区统一  timeFields      时间字段归一为 UTC+8（支持 ISO 带时区、epoch 秒/毫秒）
3. 值域      ranges          数值越界 → 拒收
4. 去重键    uniqueKey       同批次重复 → 只保留首条
5. 变化率    maxDelta        相邻两行跳变超过阈值 → 拒收（防传感器抖点/误填）

schema 示例（存于 data_source.schema_json）::

    {
      "mapping": {"pileId": "id", "gradePct": "grade", "ts": "time"},
      "required": ["pileId"],
      "ranges": {"gradePct": [0, 5]},
      "uniqueKey": "pileId",
      "maxDelta": {"gradePct": 1.0},
      "timeFields": ["ts"],
      "timezone": "UTC+8"
    }
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Tuple

# UTC+8（矿山统一展示时区，方案 §1.4）
TZ_UTC8 = timezone(timedelta(hours=8))


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def apply_mapping(row: Dict[str, Any], mapping: Dict[str, str]) -> Dict[str, Any]:
    """按 mapping（目标字段 → 源字段）重命名；未声明的字段原样保留。"""
    if not mapping:
        return dict(row)
    out = dict(row)
    for target, source_field in mapping.items():
        if source_field in row:
            out[target] = row[source_field]
    return out


def normalize_time(value: Any) -> Any:
    """把时间值归一为 UTC+8 的 ISO 字符串。

    - 数字：按 epoch 秒/毫秒识别
    - ISO 字符串：带时区则转换，无时区按 UTC+8 视为本地值
    - 其他：原样返回（交由必填/值域规则处理）
    """
    if _is_blank(value):
        return value
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 1e11:  # 毫秒
            seconds /= 1000.0
        return datetime.fromtimestamp(seconds, TZ_UTC8).isoformat(timespec="seconds")
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ_UTC8)
    return parsed.astimezone(TZ_UTC8).isoformat(timespec="seconds")


def validate_rows(
    rows: List[Dict[str, Any]], schema: Dict[str, Any]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """执行五类规则，返回 (accepted, rejects)。

    rejects 元素：{"rowNo": 序号(1-based), "reason": 文本, "payload": 原始行}
    """
    mapping = schema.get("mapping") or {}
    required = schema.get("required") or []
    ranges = schema.get("ranges") or {}
    unique_key = schema.get("uniqueKey") or ""
    max_delta = schema.get("maxDelta") or {}
    time_fields = schema.get("timeFields") or []

    accepted: List[Dict[str, Any]] = []
    rejects: List[Dict[str, Any]] = []
    seen_keys = set()
    last_values: Dict[str, float] = {}

    for index, raw in enumerate(rows, start=1):
        if not isinstance(raw, dict):
            rejects.append({"rowNo": index, "reason": "行不是对象", "payload": raw})
            continue

        row = apply_mapping(raw, mapping)

        # 1) 必填
        missing = [field for field in required if _is_blank(row.get(field))]
        if missing:
            rejects.append(
                {"rowNo": index, "reason": f"必填缺失：{', '.join(missing)}", "payload": raw}
            )
            continue

        # 2) 时区统一
        for field in time_fields:
            if field in row:
                row[field] = normalize_time(row[field])

        # 3) 值域
        out_of_range = []
        for field, bounds in ranges.items():
            value = row.get(field)
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                out_of_range.append(f"{field} 非数值")
                continue
            if not isinstance(bounds, (list, tuple)) or len(bounds) != 2:
                continue
            if not (float(bounds[0]) <= number <= float(bounds[1])):
                out_of_range.append(f"{field}={number} 超出 [{bounds[0]}, {bounds[1]}]")
        if out_of_range:
            rejects.append(
                {"rowNo": index, "reason": "值域越界：" + "；".join(out_of_range), "payload": raw}
            )
            continue

        # 4) 去重键
        if unique_key:
            key = row.get(unique_key)
            if key in seen_keys:
                rejects.append(
                    {"rowNo": index, "reason": f"重复键 {unique_key}={key}", "payload": raw}
                )
                continue
            seen_keys.add(key)

        # 5) 变化率（与同批次上一有效行比较）
        jumped = []
        for field, limit in max_delta.items():
            value = row.get(field)
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            previous = last_values.get(field)
            if previous is not None and abs(number - previous) > float(limit):
                jumped.append(f"{field} 跳变 {previous}→{number}（阈值 {limit}）")
            last_values[field] = number
        if jumped:
            rejects.append(
                {"rowNo": index, "reason": "变化率超限：" + "；".join(jumped), "payload": raw}
            )
            continue

        accepted.append(row)

    return accepted, rejects
