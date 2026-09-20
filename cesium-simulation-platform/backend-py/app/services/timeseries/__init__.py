"""
timeseries 域 —— 时序化工况数据统一存储（历史 + 实时）

结构：
  ts_store.py   存储抽象（Memory / MySQL）+ 统一 write/query 入口
  retention.py  降采样与保留策略（纯函数 + 常量）
"""
