import os
import json
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


def get_db():
    """获取数据库连接（生成器，用于 FastAPI Depends）"""
    conn = pymysql.connect(**DB_CONFIG)
    try:
        yield conn
    finally:
        conn.close()


def parse_json_field(row: dict, field: str):
    """解析 JSON 字符串字段"""
    value = row.get(field)
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def build_insert_sql(table: str, fields: list[str], allowed_fields: list[str]):
    """安全构建 INSERT SQL，仅允许白名单内的字段名"""
    safe_fields = [f for f in fields if f in allowed_fields]
    cols = ", ".join(safe_fields)
    placeholders = ", ".join(["%s"] * len(safe_fields))
    return f"INSERT INTO {table} ({cols}) VALUES ({placeholders})", safe_fields


def build_update_sql(table: str, updates: dict, allowed_fields: list[str], where_col: str = "id"):
    """安全构建 UPDATE SQL，仅允许白名单内的字段名，返回 (sql, values)"""
    safe = {k: v for k, v in updates.items() if k in allowed_fields}
    if not safe:
        return None, None
    set_clause = ", ".join([f"{k}=%s" for k in safe.keys()])
    values = list(safe.values())
    return f"UPDATE {table} SET {set_clause} WHERE {where_col}=%s", values