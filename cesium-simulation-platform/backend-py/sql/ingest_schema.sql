-- 数据接入台账（方案 WP1 T1.6 / T1.7）
-- 说明：后端启动时会惰性 CREATE TABLE IF NOT EXISTS（见 app/services/ingest/store.py），
--       本脚本用于正式环境显式建表与版本管理，字段必须与 store.py 保持一致。

-- 数据源登记：rest / ws / file / db 四类，是「集成方式≥4 种」的举证台账
CREATE TABLE IF NOT EXISTS `data_source` (
  `code` VARCHAR(64) NOT NULL COMMENT '数据源编码（业务唯一）',
  `name` VARCHAR(128) NOT NULL COMMENT '数据源名称',
  `kind` VARCHAR(16) NOT NULL COMMENT '类型：rest|ws|file|db',
  `endpoint` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '地址/视图名/说明',
  `auth_ref` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '凭据引用（不存明文）',
  `schema_json` JSON NULL COMMENT '字段映射与质量规则',
  `status` VARCHAR(16) NOT NULL DEFAULT 'idle' COMMENT 'idle|connected|error',
  `last_sync_at` DATETIME NULL,
  `owner` VARCHAR(64) NOT NULL DEFAULT '',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据源台账';

-- 接入批次：每次导入/拉取/推送的计数与状态，支撑批次回溯
CREATE TABLE IF NOT EXISTS `ingest_batch` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_code` VARCHAR(64) NOT NULL,
  `batch_no` VARCHAR(64) NOT NULL,
  `filename` VARCHAR(255) NOT NULL DEFAULT '',
  `rows_total` INT NOT NULL DEFAULT 0,
  `rows_accepted` INT NOT NULL DEFAULT 0,
  `rows_rejected` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'ok' COMMENT 'ok|partial|failed',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_no` (`batch_no`),
  KEY `idx_source_created` (`source_code`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据接入批次';

-- 质检拒收明细：一行一条原因，供质量治理与测评举证
CREATE TABLE IF NOT EXISTS `ingest_reject_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_no` VARCHAR(64) NOT NULL,
  `row_no` INT NOT NULL DEFAULT 0,
  `reason` VARCHAR(255) NOT NULL DEFAULT '',
  `payload` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_batch` (`batch_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='接入质检拒收明细';

-- 常用排查：某数据源最近批次
-- SELECT * FROM ingest_batch WHERE source_code='blasting-rest' ORDER BY id DESC LIMIT 10;
-- 常用排查：某批次拒收原因分布
-- SELECT reason, COUNT(*) FROM ingest_reject_log WHERE batch_no='xxx' GROUP BY reason;
