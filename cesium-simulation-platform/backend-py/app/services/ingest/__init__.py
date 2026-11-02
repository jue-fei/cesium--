"""数据接入层（方案 WP1）

模块划分：
- base        适配器抽象与统一结果（IngestResult）
- store       台账/批次/拒收三张表的读写（惰性建表，DB 不可用降级）
- quality     五类质量规则（必填/时区/值域/去重/变化率）
- pipeline    质检 → 批次 → 拒收 → 状态回写的统一流水线
- adapters    REST / 数据库 / WebSocket 适配器
- file_adapter JSON / CSV 文件导入

分层约定：路由层只依赖 store 与适配器注册表，不直接操作 SQL。
"""
