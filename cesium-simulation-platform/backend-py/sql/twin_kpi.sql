-- KPI 字典与时序（方案 WP5 T5.2 / T5.7，同时支撑 R5 规则）
-- 说明：后端启动时惰性建表（app/services/twin/kpi.py），本脚本用于正式环境显式建表。

-- KPI 字典：12 项核心指标的定义（单位/工序/聚合方式/数据来源）
CREATE TABLE IF NOT EXISTS `twin_kpi_def` (
  `code` VARCHAR(64) NOT NULL COMMENT '指标编码',
  `name` VARCHAR(64) NOT NULL COMMENT '中文名',
  `unit` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '单位',
  `proc` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '所属工序',
  `agg` VARCHAR(8) NOT NULL DEFAULT 'avg' COMMENT '聚合：avg|sum|max',
  `is_cumulative` TINYINT NOT NULL DEFAULT 0 COMMENT '1=累计量（区间内取差分）',
  `source` VARCHAR(32) NOT NULL DEFAULT 'auto:scheduling' COMMENT '来源：auto:* | manual | external',
  `enabled` TINYINT NOT NULL DEFAULT 1,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='KPI 字典';

-- KPI 时序：逐点存储，按 code+ts 检索；高频指标由调用方节流
CREATE TABLE IF NOT EXISTS `twin_kpi_series` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `ts` DOUBLE NOT NULL COMMENT 'epoch 秒',
  `value` DOUBLE NOT NULL,
  `tags` JSON NULL COMMENT '维度（场景/设备/采场等）',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_code_ts` (`code`, `ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='KPI 时序';

-- 排查：最近 1 小时设备利用率
-- SELECT * FROM twin_kpi_series WHERE code='equip_utilization' AND ts > UNIX_TIMESTAMP()-3600 ORDER BY ts DESC LIMIT 20;
