-- ============================================================
-- 爆破模拟数据库 Schema V2（文档化宽表设计）
--
-- 设计理念：
--   1. 一张主表承载全部爆破事件数据，事件数量无上限
--   2. 标量列用于 SQL 查询/筛选/排序/聚合
--   3. JSON 列按业务逻辑分组，模拟"独立参数文件"
--   4. 全部注释使用中文，便于领域工程师阅读
--
-- JSON 列分组说明：
--   炮孔设计 (holes_json)       → 对应"炮孔设计参数.json"
--   断面掘进 (tunnel_json)       → 对应"断面与掘进参数.json"
--   装药起爆 (charge_json)       → 对应"装药与起爆参数.json"
--   爆破效果 (result_json)       → 对应"爆破效果参数.json"
--   环境岩体 (environment_json)  → 对应"环境与岩体参数.json"
--
-- 与旧版 V1 的区别：
--   V1：5 张关系表（events / design / holes / result / rock_params）
--   V2：1 张主表 + JSON 聚合列，消灭 JOIN，前端直接消费
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ─── 清理旧表 ──────────────────────────────────────────────
-- DROP TABLE IF EXISTS `blasting_result`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_design_holes`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_design`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_events`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `rock_params`;  -- 已注释：避免数据丢失，如需清理请手动执行

-- 清理废弃的扁平表
-- DROP TABLE IF EXISTS `blasting_event_001`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_event_002`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_event_003`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_event_004`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_event_005`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_holes`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_frames`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_particles`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_vibration`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_stress`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_monitor_points`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_kco_params`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_blastface_design`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_blast_effect`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_rock_params`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_render_config`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_tunnel_sections`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_design_params`;  -- 已注释：避免数据丢失，如需清理请手动执行
-- DROP TABLE IF EXISTS `blasting_delay_series`;  -- 已注释：避免数据丢失，如需清理请手动执行

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 爆破事件主表（唯一业务表）
-- 每个爆破事件占一行，通过 event_id 唯一标识
-- ============================================================
CREATE TABLE IF NOT EXISTS `blasting_events` (
  `id` INT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
  `event_id` VARCHAR(32) NOT NULL COMMENT '事件编号（如 BLAST-2026-001）',

  -- ── 一级标量列：用于 SQL 查询、筛选、排序、聚合 ─────────
  `名称` VARCHAR(128) NOT NULL COMMENT '事件名称（如"北区露天台阶爆破"）',
  `爆心经度` DOUBLE NOT NULL COMMENT '爆心经度（WGS84）',
  `爆心纬度` DOUBLE NOT NULL COMMENT '爆心纬度（WGS84）',
  `爆心高程` DOUBLE NOT NULL DEFAULT 0 COMMENT '爆心高程（米）',
  `总装药量_kg` DOUBLE NOT NULL COMMENT '总装药量（千克）',
  `炸药类型` VARCHAR(32) NOT NULL DEFAULT '乳化炸药' COMMENT '炸药类型：乳化炸药 / 铵油炸药 / 硝化甘油',
  `岩体类型` VARCHAR(32) NOT NULL COMMENT '岩体类型（如 花岗岩 / 石灰岩 / 砂岩）',
  `起爆方式` VARCHAR(64) COMMENT '起爆方式：电雷管 / 导爆管 / 电子雷管',
  `爆破时间` DATETIME NOT NULL COMMENT '计划或实际爆破时间',
  `状态` VARCHAR(16) NOT NULL DEFAULT '已规划' COMMENT '事件状态：已规划 / 已执行 / 已取消',
  `备注` TEXT COMMENT '事件描述或备注信息',

  -- ── JSON 列：按业务分组，模拟"独立参数文件" ──────────────
  -- 每个 JSON 列对应一个逻辑参数组，整体读写，前端直接消费

  `炮孔设计` JSON COMMENT '炮孔设计参数（数组：序号,X/Y坐标_m,孔类型,孔径/孔深_m,倾角/方位角_度,装药量_kg,装药长度_m,炸药类型,雷管段别,延期时间_ms,是否空孔）',

  `断面掘进` JSON COMMENT '断面与掘进参数（断面形状,宽度/高度/半径_m,已开挖长度_m,掌子面厚度/距爆心_m,钻孔深度/直径_m,炮孔利用率,单循环进尺_m）',

  `装药起爆` JSON COMMENT '装药与起爆参数（掏槽模式,掏槽角_度,掏槽/空孔数,起爆网络,段间延时_ms,各孔线装药密度_kgm,堵塞长度_m）',

  `爆破效果` JSON COMMENT '爆破效果参数（随机种子,模拟时长/步长_s,碎片总数,x50/x80/xmax_m,b,n,漏斗深度/半径_m,抛掷距离/扩散角,超挖/半孔率,振动/应力/安全系数,视觉强度）',

  `环境岩体` JSON COMMENT '环境与岩体参数（岩体类型,密度/弹性模量/抗压抗拉强度,波速,泊松比,内摩擦角,粘聚力,节理间距,RQD,天气,温度,风速/风向）',

  -- ── 时间戳 ─────────────────────────────────────────────
  `创建时间` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
  `更新时间` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '记录最后更新时间',

  -- ── 索引 ───────────────────────────────────────────────
  UNIQUE KEY `uk_event_id` (`event_id`),
  KEY `idx_状态` (`状态`),
  KEY `idx_岩体类型` (`岩体类型`),
  KEY `idx_爆破时间` (`爆破时间`),
  KEY `idx_总装药量` (`总装药量_kg`)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='爆破事件主表（V2 宽表设计，JSON 聚合参数组）';


-- ============================================================
-- 岩体参数参考表（字典表，非必须）
--
-- 这是一张独立的参考表，用于快速查阅常见岩体的默认力学参数。
-- 创建事件时，可从该表读取默认值填入 environment_json。
-- 如果不需要独立维护岩体参数库，可以删除此表。
-- ============================================================
CREATE TABLE IF NOT EXISTS `岩体参数参考` (
  `岩体类型` VARCHAR(32) PRIMARY KEY COMMENT '岩体名称',
  `密度_kgm3` DOUBLE NOT NULL COMMENT '密度（千克/立方米）',
  `弹性模量_GPa` DOUBLE NOT NULL COMMENT '弹性模量（吉帕）',
  `抗压强度_MPa` DOUBLE NOT NULL COMMENT '单轴抗压强度（兆帕）',
  `抗拉强度_MPa` DOUBLE NOT NULL COMMENT '抗拉强度（兆帕）',
  `P波波速_ms` DOUBLE NOT NULL COMMENT '纵波波速（米/秒）',
  `S波波速_ms` DOUBLE NOT NULL COMMENT '横波波速（米/秒）',
  `泊松比` DOUBLE NOT NULL DEFAULT 0.25 COMMENT '泊松比',
  `内摩擦角_度` DOUBLE NOT NULL DEFAULT 35 COMMENT '内摩擦角（度）',
  `更新时间` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '记录更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='岩体力学参数参考表（字典）';

-- ─── 预填常见岩体参数 ──────────────────────────────────────
INSERT INTO `岩体参数参考` (`岩体类型`, `密度_kgm3`, `弹性模量_GPa`, `抗压强度_MPa`, `抗拉强度_MPa`, `P波波速_ms`, `S波波速_ms`, `泊松比`, `内摩擦角_度`) VALUES
  ('花岗岩',   2650, 50, 120, 8,  4500, 2600, 0.22, 40),
  ('石灰岩',   2400, 40, 80,  6,  3800, 2200, 0.25, 35),
  ('砂岩',     2300, 25, 60,  4,  3200, 1900, 0.22, 33),
  ('大理石',   2700, 55, 100, 7,  4300, 2500, 0.25, 38),
  ('玄武岩',   2850, 60, 150, 10, 5000, 2900, 0.23, 42),
  ('片岩',     2750, 35, 70,  5,  3500, 2100, 0.24, 30),
  ('安山岩',   2550, 45, 110, 8,  4200, 2450, 0.23, 38),
  ('闪长岩',   2780, 52, 130, 9,  4600, 2700, 0.24, 40),
  ('页岩',     2300, 20, 40,  3,  2800, 1600, 0.27, 28),
  ('石英岩',   2680, 55, 140, 10, 4800, 2800, 0.20, 42);

-- ============================================================
-- 设计对比总结
-- ============================================================
-- V1（旧）：
--   5 张表 → blasting_events + blasting_design + blasting_design_holes
--            + blasting_result + rock_params
--   前端需 4 次请求 + 手动拼接 data
--   新增参数字段需 ALTER TABLE
--
-- V2（新）：
--   1 张主表 + 1 张可选字典表
--   前端 1 次请求拿到完整事件数据
--   新增参数字段只需改 JSON 结构，无需 ALTER TABLE
--   标量列（状态/岩体/时间/药量）仍支持 SQL 查询与索引
--
-- JSON 列与"参数文件"的对应关系：
--   炮孔设计 JSON     ←→  炮孔设计参数.json（炮孔数组）
--   断面掘进 JSON     ←→  断面与掘进参数.json（隧道几何）
--   装药起爆 JSON     ←→  装药与起爆参数.json（爆破工艺）
--   爆破效果 JSON     ←→  爆破效果参数.json（模拟/实测结果）
--   环境岩体 JSON     ←→  环境与岩体参数.json（地质+气象）
-- ============================================================

-- ─── Schema 版本管理表 ─────────────────────────────────
-- 记录当前 schema 版本，migrate_blasting.py 检查此表决定是否执行迁移
CREATE TABLE IF NOT EXISTS schema_version (
    version INT PRIMARY KEY COMMENT 'schema 版本号',
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '应用时间',
    description VARCHAR(255) COMMENT '版本描述'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Schema 版本管理';

-- 当前版本：2
INSERT INTO schema_version (version, description) VALUES (2, 'V2 宽表设计：blasting_events 单表 5 JSON 列')
ON DUPLICATE KEY UPDATE applied_at = CURRENT_TIMESTAMP;
