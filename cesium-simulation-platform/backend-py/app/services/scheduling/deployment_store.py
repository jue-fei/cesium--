"""
拖拽式设备部署与出矿工序顺序持久化（3.2）

真源：config/deployments/<场景名>.json
  - deployments：设备 → 待命点 {node, level}（前端场景内拖拽设备到巷道节点后保存）；
  - processOrder：出矿工序优先级（采矿点 id 列表，靠前优先，作为贪心派单偏置）。

链路：前端 PUT /api/deployment 保存 → 立即应用到运行中的仿真器（空闲设备迁移
待命点，影响空载去程与贪心派单成本）→ 仿真器重建时按本文件覆盖设备初始位置。
文件缺失视为"未部署"（空 deployments / 空 processOrder），不影响既有行为。
"""
import json
import logging
import os
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# backend-py/config/deployments/ 目录（由本文件位置上溯 3 级：scheduling -> services -> app -> backend-py）
DEPLOYMENTS_DIR = Path(__file__).resolve().parents[3] / "config" / "deployments"


def deployment_path(scenario: str) -> Path:
    """返回 config/deployments/<场景名>.json 的路径。"""
    return DEPLOYMENTS_DIR / f"{scenario}.json"


def load_deployment(scenario: str) -> dict:
    """读取部署状态；文件不存在/损坏时返回空部署（不抛错，保证仿真器可构建）。

    3.2.3 增 ``rev``（乐观并发版本号，每次保存 +1）与 ``updatedBy``（最后修改者 actor）。
    旧文件无 rev → 视为 0（向后兼容）。
    """
    empty = {"deployments": {}, "processOrder": [], "rev": 0, "updatedAt": None, "updatedBy": ""}
    path = deployment_path(scenario)
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("[deployment] 读取 %s 失败，按未部署处理: %s", path.name, e)
        return empty
    if not isinstance(data, dict):
        return empty
    try:
        rev = int(data.get("rev") or 0)
    except (TypeError, ValueError):
        rev = 0
    return {
        "deployments": data.get("deployments") or {},
        "processOrder": list(data.get("processOrder") or []),
        "rev": rev,
        "updatedAt": data.get("updatedAt"),
        "updatedBy": str(data.get("updatedBy") or ""),
    }


def save_deployment(scenario: str, deployments: dict, process_order: list,
                    rev: int | None = None, updated_by: str = "") -> int:
    """原子写入部署状态（tmp + os.replace，避免半写文件被读到）。

    @param rev: 新的乐观并发版本号；None 时沿用既有 rev（兼容旧调用方，不自增）
    @param updated_by: 最后修改者 actor（协作身份，供冲突提示展示）
    @returns 落盘的 rev
    """
    if rev is None:
        rev = load_deployment(scenario).get("rev", 0)
    DEPLOYMENTS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "_说明": (
            "拖拽式设备部署与出矿工序顺序（3.2）真源文件，由前端 PUT /api/deployment 生成。"
            "deployments: 设备→待命点{node,level}；processOrder: 出矿工序优先级（靠前优先）；"
            "rev: 乐观并发版本号（每次保存 +1，用于多终端冲突仲裁）。"
        ),
        "rev": int(rev),
        "deployments": deployments,
        "processOrder": process_order,
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "updatedBy": updated_by,
    }
    path = deployment_path(scenario)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return int(rev)


def seg_on_level(sim, node: str, level: int):
    """节点在指定开采水平上相邻的某条巷道段 id（部署落位用）；无则 None。"""
    segs = getattr(sim, "level_seg_sets", {}).get(level)
    if not segs:
        return None
    for seg in sim.segments:
        if seg[0] in segs and (seg[1] == node or seg[2] == node):
            return seg[0]
    return None


def validate_deployment(sim, deployments: dict, process_order: list) -> list[str]:
    """校验部署与工序顺序的合法性，返回错误信息列表（空列表=通过）。

    校验口径：设备必须存在于装备库；节点必须存在于巷道网络；level 必须是
    该场景的合法开采水平且该节点在该水平上确有巷道（保证设备不悬空）；
    工序顺序必须是当前采矿点 id 的子集且无重复。
    """
    errors = []
    equip_ids = {eq.id for eq in sim.equip}
    for eid, d in (deployments or {}).items():
        if eid not in equip_ids:
            errors.append(f"设备 {eid} 不在装备库中")
            continue
        if not isinstance(d, dict):
            errors.append(f"设备 {eid} 部署格式非法（应为 {{node, level}}）")
            continue
        node, level = d.get("node"), d.get("level")
        if node not in sim.tunnel_nodes:
            errors.append(f"设备 {eid} 部署节点 {node} 不在巷道网络中")
            continue
        try:
            level = int(level)
        except (TypeError, ValueError):
            errors.append(f"设备 {eid} 部署水平 {level} 非法")
            continue
        if not (0 <= level < len(sim.levels_meta)):
            errors.append(f"设备 {eid} 部署水平 {level} 超出场景分层范围")
            continue
        if not sim._node_on_level(node, level):
            errors.append(f"节点 {node} 在水平 {level} 上没有巷道，无法部署")
    seen = set()
    for mid in process_order or []:
        if mid not in sim.muck:
            errors.append(f"工序顺序中的采矿点 {mid} 不存在")
        elif mid in seen:
            errors.append(f"工序顺序中的采矿点 {mid} 重复")
        seen.add(mid)
    return errors


def apply_deployment(sim, deployments: dict, only_idle: bool = True):
    """把部署应用到仿真器设备（待命点迁移），返回 (applied, skipped)。

    作业中设备不做瞬移（物理上铲运机不能在行驶途中换位），仅记录 skipped，
    其部署在下次仿真器重建时按真源文件生效。
    """
    applied, skipped = [], []
    eq_by_id = {eq.id: eq for eq in sim.equip}
    for eid, d in (deployments or {}).items():
        eq = eq_by_id.get(eid)
        if eq is None:
            continue
        if only_idle and eq.state != "idle":
            skipped.append({"equipId": eid, "reason": "作业中，下次仿真重置生效"})
            continue
        node, level = d.get("node"), int(d.get("level", 0))
        eq.node = node
        eq.level = level
        seg = seg_on_level(sim, node, level)
        if seg:
            eq.seg_id = seg
        eq.seg_progress = 0.0
        # 回到"新待命点空闲"基线：清空派单与路径执行状态（与全新 EquipmentState 一致）
        eq.assigned = {}
        eq.route_nodes = []
        eq.route_levels = []
        eq.route_i = 0
        eq.vertical_seg = ""
        eq.vertical_progress = 0.0
        eq.state = "idle"
        eq.load_mode = "empty"
        eq.payload_t = 0.0
        applied.append({"equipId": eid, "node": node, "level": level})
    return applied, skipped
