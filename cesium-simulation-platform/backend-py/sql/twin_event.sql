-- 孪生融合事件流水（方案 WP2 T2.2 / T2.0）
-- 说明：后端启动时会惰性 CREATE TABLE IF NOT EXISTS（见 app/services/fusion/store.py），
--       本脚本用于正式环境显式建表与版本管理，字段必须与 store.py 保持一致。
-- 关闭写入：环境变量 TWIN_EVENT_PERSIST=0

CREATE TABLE IF NOT EXISTS `twin_event_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `seq` BIGINT NOT NULL COMMENT '总线序号（进程内单调递增，重启归零）',
  `type` VARCHAR(128) NOT NULL COMMENT '事件类型，形如 blasting:event:completed',
  `proc` VARCHAR(32) NOT NULL COMMENT '工序：geology/blasting/haulage/safety/optimization/twin',
  `ts` DOUBLE NOT NULL COMMENT '事件时间（epoch 秒）',
  `source` VARCHAR(32) NOT NULL DEFAULT 'api' COMMENT '来源：web/api/simulator/rule',
  `payload` JSON NULL COMMENT '业务载荷',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_seq` (`seq`),
  KEY `idx_type_ts` (`type`, `ts`),
  KEY `idx_proc_ts` (`proc`, `ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='孪生融合事件流水';

-- 常用排查：查看最近 50 条规则命中事件
-- SELECT seq, type, proc, ts, source, JSON_EXTRACT(payload, '$') AS payload
-- FROM twin_event_log ORDER BY seq DESC LIMIT 50;
