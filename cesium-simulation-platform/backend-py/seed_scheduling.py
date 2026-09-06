"""
现场调度·场景配置/采矿区任务 入库脚本

- 把 config/scenario_*.json 全量导入 scheduling_scenario 表
- 把采矿区任务默认值（自行编造，可手动改）导入 scheduling_muck_task 表

表结构见 sql/scheduling_scenario.sql 与 sql/scheduling_muck_task.sql。
导入均为幂等 upsert，重复执行安全。

运行: python seed_scheduling.py
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

load_dotenv()

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "cesium_platform"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}

BASE_DIR = Path(__file__).resolve().parent
SCENARIO_SCHEMA = BASE_DIR / "sql" / "scheduling_scenario.sql"
MUCK_SCHEMA = BASE_DIR / "sql" / "scheduling_muck_task.sql"
CONFIG_DIR = BASE_DIR / "config"

sys.path.insert(0, str(BASE_DIR))
from app.services.scheduling.muck_data import default_tasks_from_scenario


def _run_schema(cursor, path):
    with open(path, "r", encoding="utf-8") as f:
        for stmt in f.read().split(";"):
            if stmt.strip():
                cursor.execute(stmt)


def _ensure_scenario_column(cursor):
    """旧版 scheduling_muck_task 表无 scenario 列：补列并把旧行归属为默认场景。"""
    cursor.execute(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='scheduling_muck_task' "
        "AND COLUMN_NAME='scenario'"
    )
    row = cursor.fetchone()
    if row and row.get("n", 0):
        return
    cursor.execute(
        "ALTER TABLE `scheduling_muck_task` "
        "ADD COLUMN `scenario` VARCHAR(128) NOT NULL DEFAULT '' "
        "COMMENT '所属场景（config scenario 字段；多场景共用本表）' AFTER `task_id`"
    )
    # 旧行回填默认场景（ashale），避免被其它场景误读
    cursor.execute(
        "UPDATE `scheduling_muck_task` SET `scenario`='underground-LHD-ashale' "
        "WHERE `scenario`=''"
    )


def seed_muck_tasks(cursor):
    """从场景配置编造默认采矿区任务并入库（幂等 upsert）。"""
    # 用默认场景的 muckPoints 生成默认任务
    with open(CONFIG_DIR / f"scenario_{os.getenv('SCHEDULING_SCENARIO', 'ashale')}.json", "r", encoding="utf-8") as f:
        cfg = json.load(f)
    tasks = default_tasks_from_scenario(cfg)
    sid = cfg.get("scenario", "")
    sql = (
        "INSERT INTO scheduling_muck_task "
        "(task_id, scenario, zone, gantry, node, muck_level, required_work_t, remaining_work_t, "
        "grade_pct, blast_event_id, frag_x50_m, frag_x80_m, frag_xmax_m, frag_b, frag_n, "
        "size_hist_json, big_block_ratio, recognize_rate, shape, spread_r_m, height_m_m, "
        "blast_cycle, source, remark) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
        "ON DUPLICATE KEY UPDATE "
        "scenario=VALUES(scenario), zone=VALUES(zone), gantry=VALUES(gantry), "
        "node=VALUES(node), muck_level=VALUES(muck_level), "
        "required_work_t=VALUES(required_work_t), remaining_work_t=VALUES(remaining_work_t), "
        "grade_pct=VALUES(grade_pct), frag_x50_m=VALUES(frag_x50_m), frag_x80_m=VALUES(frag_x80_m), "
        "frag_xmax_m=VALUES(frag_xmax_m), frag_b=VALUES(frag_b), frag_n=VALUES(frag_n), "
        "size_hist_json=VALUES(size_hist_json), big_block_ratio=VALUES(big_block_ratio), "
        "recognize_rate=VALUES(recognize_rate), shape=VALUES(shape), spread_r_m=VALUES(spread_r_m), "
        "height_m_m=VALUES(height_m_m), blast_cycle=VALUES(blast_cycle), "
        "source=VALUES(source), updated_at=CURRENT_TIMESTAMP"
    )
    for t in tasks:
        cursor.execute(
            sql,
            (
                t["task_id"], sid, t["zone"], t["gantry"], t["node"], t["muck_level"],
                t["required_work_t"], t["remaining_work_t"], t["grade_pct"], t["blast_event_id"],
                t["frag_x50_m"], t["frag_x80_m"], t["frag_xmax_m"], t["frag_b"], t["frag_n"],
                json.dumps(t["size_hist"], ensure_ascii=False),
                t["big_block_ratio"], t["recognize_rate"], t["shape"], t["spread_r_m"],
                t["height_m_m"], t["blast_cycle"], t["source"], t["remark"],
            ),
        )
        print(f"  [scheduling_muck_task] {t['task_id']} ({t['zone']}) [{sid}] 工作量 {t['required_work_t']}t")


def main():
    conn = pymysql.connect(**DB_CONFIG)
    cursor = conn.cursor()
    try:
        print("[0/3] 执行建表 SQL（scheduling_scenario + scheduling_muck_task）...")
        _run_schema(cursor, SCENARIO_SCHEMA)
        _run_schema(cursor, MUCK_SCHEMA)
        _ensure_scenario_column(cursor)
        print("[OK] 表就绪")

        files = sorted(CONFIG_DIR.glob("scenario_*.json"))
        if not files:
            print(f"[WARN] {CONFIG_DIR} 下没有 scenario_*.json，跳过场景导入")
            return

        upsert_sql = (
            "INSERT INTO `scheduling_scenario` "
            "(`name`, `scenario_id`, `engine`, `config_json`, `remark`) "
            "VALUES (%s, %s, %s, %s, %s) "
            "ON DUPLICATE KEY UPDATE "
            "`scenario_id`=VALUES(`scenario_id`), `engine`=VALUES(`engine`), "
            "`config_json`=VALUES(`config_json`), `updated_at`=CURRENT_TIMESTAMP"
        )

        print(f"[1/3] 导入 {len(files)} 个场景配置 ...")
        for path in files:
            name = path.name[len("scenario_"):-len(".json")]
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            cursor.execute(
                upsert_sql,
                (
                    name,
                    cfg.get("scenario", name),
                    cfg.get("engine", ""),
                    json.dumps(cfg, ensure_ascii=False),
                    "",
                ),
            )
            print(f"  [scheduling_scenario] {name} -> {cfg.get('scenario', name)}")

        print("[2/3] 导入采矿区任务默认值 ...")
        seed_muck_tasks(cursor)

        conn.commit()
        print("[OK] 场景配置与采矿区任务已入库")
    except Exception as e:
        conn.rollback()
        print(f"[ERROR] 失败，已回滚: {e}")
        raise
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    main()
