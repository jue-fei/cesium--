-- =====================================================================
-- 现场调度·场景配置表（scheduling_scenario）
-- ---------------------------------------------------------------------
-- 用途：把 config/scenario_<名>.json 的场景配置纳入数据库管理。
--   - 后端 load_config() 优先从本表读取（enabled=1），无记录时回退读取磁盘 JSON 文件
--   - seed_scheduling.py 把 config/ 目录下的 scenario_*.json 全量导入（幂等 upsert）
-- 表结构设计：
--   - name         场景名（对应文件 scenario_<name>.json，唯一键）
--   - scenario_id  配置内 "scenario" 字段（如 underground-LHD-ashale）
--   - config_json  完整场景配置 JSON（与磁盘文件内容一致）
--   - enabled      是否启用；enabled=0 的场景 load_config 不会命中
-- =====================================================================

CREATE TABLE IF NOT EXISTS `scheduling_scenario` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name`        VARCHAR(64)  NOT NULL COMMENT '场景名（对应 config/scenario_<name>.json，唯一）',
  `scenario_id` VARCHAR(128) NOT NULL COMMENT '配置内 scenario 字段（场景标识）',
  `engine`      VARCHAR(128) NOT NULL DEFAULT '' COMMENT '配置内 engine 字段（仿真引擎名）',
  `config_json` LONGTEXT     NOT NULL COMMENT '完整场景配置 JSON（与磁盘文件一致）',
  `enabled`     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否启用：0=禁用（load_config 不命中）',
  `remark`      VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注',
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_scenario_name` (`name`),
  KEY `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='现场调度·场景配置（巷道/装载点/设备/布局一体）';
